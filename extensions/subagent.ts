import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal read-only subagents for Pi. One tool: `subagent({ agent, task })`.
// Self-contained: the delegation rules live in the tool itself (description +
// promptGuidelines), so installing it is enough — no AGENTS.md / APPEND_SYSTEM needed.
//
// Agents are .md files (frontmatter + system prompt). Bundled ones live in ./agents
// and inherit the parent's model. Users override or add agents by dropping files with
// the same name in <pi agent dir>/subagents/ (e.g. to pick another model per agent).

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const HERE = dirname(fileURLToPath(import.meta.url));
// Package layout: <root>/extensions/subagent.ts and <root>/agents/*.md (an agents/ folder next to this file also works).
const BUNDLED_DIR = [join(HERE, "..", "agents"), join(HERE, "agents")].find((d) => existsSync(d)) ?? join(HERE, "..", "agents");
const USER_DIR = join(AGENT_DIR, "subagents");
const DEFAULT_MAX_REPORT_CHARS = 24000; // ~6-7k tokens: still far below reading the files; longer reports are saved to a file
const DEFAULT_TIMEOUT_S = 600; // local models are slow; override per agent with `timeout:`

interface Agent {
  name: string;
  description: string;
  model?: string; // "provider/id"; omitted = same model as the parent
  thinking?: string;
  extensions: string[]; // absolute path, or "npm:<package>" installed under <agent dir>/npm
  skills: string[]; // absolute path, or a skill name under <agent dir>/skills
  evidence: boolean; // warn when the report made zero tool calls
  fallback: boolean; // on failure, retry once with the parent's model
  timeout: number; // seconds
  maxChars: number; // largest report returned to the main session
  prompt: string;
}

function list(v?: string): string[] {
  return (v ?? "").split(";").map((s) => s.trim()).filter(Boolean);
}

function parseAgent(file: string, name: string): Agent | null {
  const raw = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":"); // first colon only, so "C:\..." paths survive
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    name,
    description: fm.description || name,
    model: fm.model || undefined,
    thinking: fm.thinking || undefined,
    extensions: list(fm.extensions),
    skills: list(fm.skills),
    evidence: fm.evidence !== "false",
    fallback: fm.fallback !== "false", // on by default; only matters when the agent sets its own model
    timeout: Number(fm.timeout) > 0 ? Number(fm.timeout) : DEFAULT_TIMEOUT_S,
    maxChars: Number(fm.max_chars) > 0 ? Number(fm.max_chars) : DEFAULT_MAX_REPORT_CHARS,
    prompt: m[2].trim(),
  };
}

function loadAgents(): Map<string, Agent> {
  const out = new Map<string, Agent>();
  for (const dir of [BUNDLED_DIR, USER_DIR]) {
    // user files come last, so they override bundled agents of the same name
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3).toLowerCase();
      try {
        const a = parseAgent(join(dir, f), name);
        if (!a) continue;
        // A required extension that is not installed hides the agent entirely, so the
        // model never sees (or relies on) a capability that cannot work. /reload retries.
        if (a.extensions.some((e) => !resolveExtension(e))) {
          out.delete(name);
          continue;
        }
        out.set(name, a);
      } catch {
        /* skip unreadable agent file */
      }
    }
  }
  return out;
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function resolveExtension(e: string): string | null {
  if (!e.startsWith("npm:")) return isFile(e) ? e : null;
  const pkgName = e.slice(4);
  const roots = [join(AGENT_DIR, "npm", "node_modules"), join(process.cwd(), ".pi", "npm", "node_modules")];
  for (const root of roots) {
    const dir = join(root, pkgName);
    if (!existsSync(dir)) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const rel = pkg?.pi?.extensions?.[0];
      if (typeof rel === "string" && isFile(join(dir, rel))) return join(dir, rel);
    } catch {
      /* fall through to the usual entry points */
    }
    for (const c of ["dist/index.js", "index.js"]) if (isFile(join(dir, c))) return join(dir, c);
  }
  return null;
}

function resolveSkill(s: string): string | null {
  const p = isAbsolute(s) ? s : join(AGENT_DIR, "skills", s);
  return existsSync(p) ? p : null;
}

interface RunResult {
  exitCode: number;
  text: string;
  toolCalls: number;
  stderr: string;
  error?: string;
  timedOut: boolean;
  warnings: string[];
}

function killTree(pid: number | undefined, proc: { kill: (s?: any) => boolean }) {
  try {
    if (process.platform === "win32" && pid) {
      // Node's kill() leaves grandchildren (e.g. a hung bash) alive on Windows.
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* gone */ }
      }, 4000);
    }
  } catch {
    /* already gone */
  }
}

function runChild(agent: Agent, task: string, cwd: string, model: string | undefined, signal?: AbortSignal, onProgress?: (toolCalls: number) => void): Promise<RunResult> {
  const res: RunResult = { exitCode: -1, text: "", toolCalls: 0, stderr: "", timedOut: false, warnings: [] };
  // Same Node + same Pi CLI script as the running parent (avoids the pi.ps1 / pi.cmd shims).
  const script = process.env.PI_SUBAGENT_CLI || process.argv[1];
  if (!script || !existsSync(script)) {
    res.exitCode = 1;
    res.error = `Could not find the Pi CLI (${script}). Set PI_SUBAGENT_CLI to the path of its cli.js.`;
    return Promise.resolve(res);
  }

  const args = [
    script, "-p", "--mode", "json", "--no-session",
    "--no-extensions", "--no-skills", "--no-context-files", "--no-mcp",
    "--no-prompt-templates", "--no-themes",
    // Read-only by denylist: this form worked with Gemini; the plain allowlist did not.
    "--tools", "+grep,+find,+ls,-edit,-write",
  ];
  if (model) args.push("--model", agent.thinking ? `${model}:${agent.thinking}` : model);
  else if (agent.thinking) args.push("--thinking", agent.thinking);
  for (const e of agent.extensions) {
    const p = resolveExtension(e);
    if (p) args.push("-e", p);
    else res.warnings.push(`extension not found: ${e}`);
  }
  for (const s of agent.skills) {
    const p = resolveSkill(s);
    if (p) args.push("--skill", p);
    else res.warnings.push(`skill not found: ${s}`);
  }
  if (agent.prompt) args.push("--append-system-prompt", agent.prompt);
  args.push("--", task);

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(process.execPath, args, {
        cwd, shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PI_OFFLINE: "1" },
      });
    } catch (e) {
      res.exitCode = 1;
      res.error = String((e as Error)?.message ?? e);
      resolve(res);
      return;
    }

    let buf = "";
    let rawOut = "";
    let parsed = false;
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let ev: any;
      try { ev = JSON.parse(line); } catch { rawOut += line + "\n"; return; }
      parsed = true;
      const msg = ev?.message;
      if (ev?.type === "message_end" && msg?.role === "assistant" && Array.isArray(msg.content)) {
        for (const p of msg.content) if (p?.type === "toolCall") res.toolCalls++;
        onProgress?.(res.toolCalls);
        // Keep only the LAST assistant message's text (the final report).
        res.text = msg.content
          .filter((p: any) => p?.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text).join("\n").trim();
        if (msg.errorMessage) res.error = msg.errorMessage;
        else if (msg.stopReason === "error") res.error = res.error || "the provider returned an error";
      }
    };

    proc.stdout!.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const l of lines) onLine(l);
    });
    proc.stderr!.on("data", (d) => { res.stderr += d.toString(); });

    const timer = setTimeout(() => {
      res.timedOut = true;
      res.error = `timed out after ${agent.timeout}s`;
      killTree(proc.pid, proc);
    }, agent.timeout * 1000);
    const onAbort = () => killTree(proc.pid, proc);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("error", (e) => {
      clearTimeout(timer);
      res.exitCode = 1;
      res.error = String(e?.message ?? e);
      resolve(res);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (buf.trim()) onLine(buf);
      if (!parsed && rawOut.trim() && !res.text) res.text = rawOut.trim();
      res.exitCode = code ?? 0;
      if (res.exitCode !== 0 && !res.error) {
        res.error = res.stderr.split(/\r?\n/).filter(Boolean).slice(-1)[0] || `exited with code ${res.exitCode}`;
      }
      resolve(res);
    });
  });
}

// One child at a time: a single local server slot gains nothing from parallel children.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function finalizeReport(text: string, agent: Agent): string {
  const max = agent.maxChars;
  if (text.length <= max) return text;
  // Cut at a line boundary when one is close to the limit, so the report does not stop mid-sentence.
  let cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  if (nl > max * 0.7) cut = cut.slice(0, nl);
  const lines = text.split("\n").length;
  let tail = `\n\n… (report truncated: showing ${cut.length} of ${text.length} characters)`;
  try {
    const dir = join(tmpdir(), "pi-subagent");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}-${agent.name}.md`).replace(/\\/g, "/");
    writeFileSync(file, text, "utf8");
    tail =
      `\n\n… (report truncated: showing ${cut.length} of ${text.length} characters. The FULL report is saved at ${file} ` +
      `(${lines} lines, some very long). If something is missing, \`read\` that file whole, without an offset; ` +
      `do not launch another subagent for the same thing)`;
  } catch {
    /* keep the plain notice */
  }
  return cut.trimEnd() + tail;
}

function parentModel(ctx: any): string | undefined {
  const m = ctx?.model;
  if (!m || typeof m.id !== "string") return undefined;
  return m.provider ? `${m.provider}/${m.id}` : m.id;
}

export default function (pi: ExtensionAPI) {
  const agents = loadAgents();
  if (agents.size === 0) return; // nothing to register

  const catalog = [...agents.values()].map((a) => `${a.name}: ${a.description}`).join(" | ");

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate to a read-only subagent with its own context; only a short report comes back. " +
      "Use it INSTEAD of reading files yourself whenever the goal is to understand or map a module, flow or project, " +
      "for any web search, and for an independent review. " +
      `Agents — ${catalog}`,
    // Rules that travel with the extension (added to the system prompt by Pi).
    promptSnippet: "subagent — delegate exploration, web research or review to a read-only subagent; only a short report returns",
    promptGuidelines: [
      "Use `subagent` whenever the goal is to explore, map, understand or summarize a module, flow or whole project; for web research; and for independent review or a second opinion. Do this INSTEAD of reading those files yourself, even if you already know which files they are.",
      "Read directly only for small, specific lookups: a few short files (about 300 lines in total) or the function you are about to edit.",
      "Run one subagent at a time and wait for its report. Give it a self-contained task: it knows nothing about this conversation. Ask one focused question per call, not an exhaustive map: it is faster and the report stays short.",
      "Base your plan on the report instead of repeating the exploration. Reports can contain mistakes: re-read the exact lines with `read` before editing.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: `One of: ${[...agents.keys()].join(", ")}` }),
      task: Type.String({ description: "Self-contained task: the subagent knows nothing about this conversation" }),
    }),

    async execute(_id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      const fail = (text: string) => ({ content: [{ type: "text", text }], details: {}, isError: true });
      const agent = agents.get(String(params.agent ?? "").toLowerCase());
      if (!agent) return fail(`Unknown agent. Available: ${[...agents.keys()].join(", ")}`);
      const task = String(params.task ?? "").trim();
      if (!task) return fail("Missing `task`.");

      const progress = (n: number) =>
        onUpdate?.({ content: [{ type: "text", text: `${agent.name}: ${n} tool calls…` }], details: {} });
      onUpdate?.({ content: [{ type: "text", text: `${agent.name}: working…` }], details: {} });

      const parent = parentModel(ctx);
      const cwd = ctx?.cwd || process.cwd();
      let usedModel = agent.model ?? parent;
      let r = await serial(() => runChild(agent, task, cwd, usedModel, signal, progress));
      let note = "";

      const failed = (x: RunResult) => x.exitCode !== 0 || !!x.error || !x.text;
      if (failed(r) && agent.fallback && agent.model && parent && parent !== agent.model && !signal?.aborted) {
        const why = (r.error || "no response").replace(/\s+/g, " ").slice(0, 160);
        usedModel = parent;
        r = await serial(() => runChild({ ...agent, timeout: Math.max(agent.timeout, 600) }, task, cwd, parent, signal, progress));
        note = `[${agent.name}: ${agent.model} failed (${why}); retried with ${parent}]\n`;
      }
      if (r.warnings.length) note += `[warning: ${r.warnings.join("; ")}]\n`;
      if (failed(r)) return fail(`${note}${agent.name} failed: ${r.error || "no response"}`);

      let body = finalizeReport(r.text, agent);
      if (agent.evidence && r.toolCalls === 0) {
        body = "WARNING: this subagent answered WITHOUT using any tool; it may have made things up. Verify before relying on it.\n\n" + body;
      }
      return {
        content: [{ type: "text", text: `${note}${body}\n\n[${agent.name} · ${usedModel ?? "the main agent's model"} · ${r.toolCalls} tool calls]` }],
        details: { agent: agent.name, toolCalls: r.toolCalls },
      };
    },
  });
}
