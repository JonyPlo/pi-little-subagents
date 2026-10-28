# pi-little-subagents

Lean, read-only subagents for the [Pi coding agent](https://pi.dev), built for small local models with small context windows.

When you run a local model on a single GPU, the context window is your scarcest resource. Every token costs prefill time, decode speed and answer quality, and with a 32k–128k window there is not much room to waste. Exploring a codebase or reading web pages can burn tens of thousands of tokens that the main session then drags along for the rest of the conversation.

This extension adds **one tool, `subagent`**, that hands that kind of work to an isolated child Pi session. The child reads, searches and reasons in its own context and returns a short report. **Only the report enters your main session.**

> **A real measurement from my own setup** (a single run, so treat it as an example, not a benchmark): my Pi runs with a local Qwen3.8-27B and a 180k window, with all my extensions loaded (about 15k tokens of prefill in total). I asked the agent to map the backend of a ~1,000-line Express project. With this extension, the `scout` subagent did the exploration and my main session stayed at about 15k tokens, barely moving. Without it, the main model explored the project itself and the session grew to about 30–35k. On a 180k window that is a nice saving; on a 64k window, the same difference is the gap between using a quarter and using half of your context. I have not measured this on windows that small yet.

## Design goals

- **Tiny footprint.** One tool, four short rules, four one-line agent descriptions. The extension adds roughly **1k tokens of prefill** (an approximate figure, not an exact measurement; check it on your own setup).
- **Works out of the box.** The rules for *when* to delegate travel inside the tool (description and prompt guidelines). You do not need to edit `AGENTS.md` or `APPEND_SYSTEM.md`.
- **Local first.** Children use the same model as your main agent by default, and run one at a time.
- **Honest reports.** If a child answers without using a single tool, the report is flagged as possibly made up.
- **Fail-soft.** If a model you picked for a subagent fails, the run is retried once with your main model.

## Requirements and compatibility

| | |
|---|---|
| Pi | Developed and tested with **Pi 1.3.0** (`@earendil-works/pi-coding-agent`). Other versions are untested. |
| Node.js | `>= 22.19.0` (Pi's own requirement) |
| OS | **Tested on Windows only.** Linux and macOS are untested; the process-killing code path on those systems has never been exercised. |
| Models | Tested with a local Qwen3.8-27B as the main model and subagent model, and with Gemini Flash-Lite (Google login) as an optional per-agent override. |
| Context window | Measured on a 180k window. The design targets smaller windows (roughly 32k–128k), but that has **not been tested** yet. |
| `researcher` agent | Needs the [`pi-web-access`](https://pi.dev/packages) package installed. If it is missing, that agent simply does not appear. |

If you try it on another OS, Pi version, model or context size, please open an issue with what happened.

## Install

```bash
pi install npm:pi-little-subagents
```

Try it without installing:

```bash
pi -e npm:pi-little-subagents
```

From a local clone:

```bash
pi install ./path/to/pi-little-subagents
```

Restart Pi (or run `/reload`). Ask the agent *"which agents does the subagent tool have?"* to check that it loaded.

## Usage

Just talk to Pi normally:

> explore how the backend of this project is structured

The tool's description and rules tell the model to delegate exploration, web research and reviews instead of doing them itself. You can also ask for it explicitly: *"use the scout subagent to find where authentication is handled"*.

Whether the model delegates on its own depends on the model. The rules push it, but they cannot force it.

## Bundled agents

| Agent | Purpose |
|---|---|
| `scout` | Explores the repo and returns file paths and line numbers |
| `researcher` | Searches the web and reads docs; returns a summary with source URLs. Requires `pi-web-access` |
| `reviewer` | Independent review of code or a diff, with a clean context |
| `oracle` | Second opinion for hard bugs or architecture decisions |

By default **every agent uses the same model as your main agent.** The only agent with web access is `researcher`; the main agent does not need web tools at all.

## Use a different model for a subagent

Why you might want this: a stronger or faster model for review, or a cloud model so the subagent does not compete with your local server.

1. Find the model id: `pi --list-models`
2. Create the folder `~/.pi/agent/subagents/` (on Windows: `C:\Users\<you>\.pi\agent\subagents\`). If you use `PI_CODING_AGENT_DIR`, it is `$PI_CODING_AGENT_DIR/subagents/`.
3. Copy the agent file you want to change from this package's `agents/` folder into it, **keeping the same file name**, and add `model` (and optionally `thinking`) to the header:

```markdown
---
description: Read-only repo exploration; returns file paths and line numbers
model: google/gemini-3.5-flash-lite
thinking: low
---
You are a read-only code scout. ...
```

4. Run `/reload`. The footer of every report shows which model actually ran.

A file in `subagents/` **overrides** the bundled agent with the same name. A new file name creates a new agent.

### Fallback

If an agent has its own `model` and that run fails (provider error, quota, malformed tool call, timeout), the task is retried **once with your main agent's model**, with a timeout of at least 600 s. The report tells you what failed. Set `fallback: false` in the header to disable it.

### Watch out for free-tier limits

Every tool call a subagent makes is a request, and every request resends the subagent's whole context. A single exploration of a ~1,000-line file can exceed the per-minute request or token limits of a free cloud plan (the provider answers HTTP 429). The fallback covers it, but you lose time. For heavy exploration, the main model or a paid tier works better.

## Write your own agent

Any `.md` file in `~/.pi/agent/subagents/` becomes an agent. The header configures it; the body is its system prompt.

```markdown
---
description: Reviews UI code against the design skill
model: google/gemini-3.5-flash-lite
thinking: medium
skills: impeccable
timeout: 300
---
You are a UI reviewer. Read the files named in the task and report problems as `path:line — problem — fix`.
```

| Header field | Meaning |
|---|---|
| `description` | What the main model reads to decide when to use the agent |
| `model` | `provider/id`. Empty = the main agent's model |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `extensions` | Extensions loaded in the child, separated by `;`. `npm:<package>` is looked up under `<pi agent dir>/npm/node_modules` (and the project's `.pi/npm/node_modules`); an absolute path also works. If one is missing, the agent is hidden |
| `skills` | Skills loaded in the child, separated by `;`. A bare name is looked up under `<pi agent dir>/skills`; an absolute path also works. If one is missing, the agent still runs and the report carries a warning |
| `evidence` | `true` (default): warn when the report was produced without any tool call |
| `fallback` | `true` (default): retry with the main model if the agent's own model fails |
| `timeout` | Seconds before the child is killed. Default 600 |

Children start with **no extensions, no skills, no AGENTS.md and no MCP**, except what the header declares. That keeps their prefill small. It also means extensions you rely on in the main session (a bash timeout, for example) are not active in the child unless you list them under `extensions`.

## What a report looks like

- Reports are capped at **8,000 characters** (~2–3k tokens). If a child writes more, the full text is saved to a file in your temp folder (`pi-subagent/`) and the report ends with its path, so nothing is lost. The main model is told to read it only if something is missing. Keep this in mind on very small windows: a full-size report is a noticeable share of a 32k context.
- The footer shows the agent, the model that ran and the number of tool calls: `[scout · provider/model · 15 tool calls]`.
- While a child runs, the tool card shows a live `N tool calls…` counter.
- If the child made **zero** tool calls, the report starts with a warning.

## How it works

The child is a headless Pi process, started with the same Node binary and the same Pi CLI script as the running session:

```
pi -p --mode json --no-session --no-extensions --no-skills --no-context-files --no-mcp \
   --no-prompt-templates --no-themes --tools +grep,+find,+ls,-edit,-write \
   [--model <id>[:thinking]] [-e <extension>]... [--skill <skill>]... \
   --append-system-prompt <agent prompt> -- <task>
```

The extension reads Pi's JSON event stream, keeps the last assistant message as the report and counts tool calls. Children run through a queue, one at a time. On timeout or abort the whole process tree is killed (`taskkill /T /F` on Windows).

## Limitations

- **"Read-only" is enforced by the prompt, not by a sandbox.** The child cannot call `edit` or `write`, but it still has `bash`.
- **One subagent at a time.** With a single local model server there is nothing to gain from running children in parallel.
- **Reports can be wrong.** Scouts occasionally shift a line number or invent a detail. The rules tell the main model to re-read exact lines before editing; do the same when it matters.
- **Delegation is up to the model.** Small models sometimes explore on their own anyway.
- Subagents cannot launch further subagents.
- Tested on Windows and Pi 1.3.0 only, and only on a 180k context window (see above).

## Troubleshooting

| Symptom | What to do |
|---|---|
| `Could not find the Pi CLI` | Set the environment variable `PI_SUBAGENT_CLI` to the path of Pi's `cli.js` |
| `researcher` is not listed | Install `pi-web-access`, then `/reload` |
| The `subagent` tool appears twice | You also have a manual copy in `~/.pi/agent/extensions/`; remove it |
| `skill not found` warning | The skill named in the agent header is not installed; install it or edit the header |
| Gemini returns `MALFORMED_FUNCTION_CALL` | Seen once during development with a different `--tools` form. The fallback retries with your main model |
| A subagent always times out | Raise `timeout` in its header; local models can be slow on big explorations |

## Development

```bash
git clone https://github.com/JonyPlo/pi-little-subagents.git
cd pi-little-subagents
pi -e .                 # run Pi with the local extension
npm pack --dry-run      # check what would be published
```

## License

MIT