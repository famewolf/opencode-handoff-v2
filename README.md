# opencode-handoff-v2

Handoff plugin for opencode v2. `/handoff` carries your current session
forward into a fresh one; `read_session` reads the transcript of any
previous session.

Port of [opencode-handoff](https://github.com/joshuadavidthomas/opencode-handoff)
0.5.0 by Josh Thomas, with `/tmp/opencode` findings inclusion added on top.
This is a separate plugin, not a contribution upstream: the port shares the
concept only, and nothing here is pushed back to the original repo.

## /handoff

`/handoff <goal>` builds a handoff prompt and starts a new session with it.
The prompt carries: goal, decisions and explicit non-goals, one line per file
(why the goal needs it; must-have vs nice-to-have), verbatim decision points,
validation with results, and open threads.

Along with the summary, the new session receives:

- **Findings file.** The single `/tmp/opencode/*findings*.md` file mentioned
  most recently in the transcript, inlined up to 64 KB. Larger files attach
  by name only. Nothing mentioned means nothing attaches. Pass the tool's
  `findings` parameter to override recency.
- **Working tree.** Branch, status, and diff-stat of the session's git
  checkout, collected automatically. Skipped outside a checkout.
- **Referenced files.** Every `@path` in the prompt, inlined as a markdown
  section. Unreadable and binary files are dropped silently.

Total budget is 96 KB. The summary and the session-reference line are
untouchable; oversized file and findings sections trim largest-first.

`--quick` in the goal switches to quick mode: summary plus findings only,
files named but not inlined.

## Model and agent selection

The goal may carry `--model <fragment>` and/or `--agent <fragment>`
(case-insensitive, partial values ok). Resolution runs exact id or name, then
prefix, then substring; model ties prefer the highest numeric version. No
flags means the new session inherits the current session's pair. Flags are
consumed, not posted, and the result line reports both with their source.

```text
/handoff get PR37 green --model muse
/handoff finish the port --agent worker-coder --model small-model
/handoff --quick checkpoint before lunch
```

The generated prompt also carries a conduct rule: the task-closing reply ends
with the byte-exact line `TASK COMPLETE` alone on the last line. Harmless
where no stall watcher runs; critical where one does.

## read_session

`read_session` returns a previous session's transcript by id (default 100
messages, max 500). Use it for detail the handoff summary compressed away.

## Porting notes (v1 to v2)

- Plugin shape: `{ config, tool, "chat.message", event }` became
  `{ id, setup }` with `ctx.command.transform` / `ctx.tool.transform`.
- Dependencies: `@opencode-ai/plugin` + `@opencode-ai/sdk` + zod became
  `@opencode/plugin` (peer) with plain JSON-schema tool inputs.
- `ctx.client` does not exist in v2. `read_session` reads via
  `ctx.session.context`; `handoff_session` creates the session with
  `ctx.session.create` and posts with `ctx.session.prompt`, so handoffs work
  from the TUI, the CLI, and the API alike. Trade-off: the new session starts
  immediately instead of staging an editable draft, so the prompt tells it to
  confirm direction before anything destructive.
- The v1 `chat.message` text-sniffing file injection is gone; the tool
  resolves files itself and inlines content as markdown sections.

## Install

Requires opencode v2.0 or later (verified on v2.0.29).

**From the release bundle** (auto-discovered, no config entry):

```sh
mkdir -p <config>/plugins/handoff && cd <config>/plugins/handoff
for f in index.js plugin.js tools.js files.js vendor.js; do
  curl -sL -O https://github.com/famewolf/opencode-handoff-v2/releases/latest/download/$f
done
```

**From a clone** (config entry):

```sh
git clone https://github.com/famewolf/opencode-handoff-v2.git
```

Add `"file:///<path-to-clone>"` to the `plugin` array in your config
(opencode.jsonc), then restart: config loads at startup. Keep the clone
outside `<config>/plugins/`, where auto-discovery would load it twice.

Loader facts (verified 2026-10-14): a `file://` directory entry resolves the
root `index.ts`, which bun executes directly, and does not follow `exports`
to `dist/`. A package without a root `index.ts` is skipped silently: no
loading line, no error. `dist/` remains the build artifact.

## Update

Re-download the release bundle over the installed copy and restart the
server. Clone installs: `git pull` (no rebuild needed for use; `dist/` is
committed, rebuild only for development). There is no auto-update.

## Uninstall

Remove the plugin files (or the config entry), restart the server.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run build       # emits dist/
```

## License

[MIT](./LICENSE)
