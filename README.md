# opencode-handoff-v2

V2 port of `opencode-handoff` 0.5.0 (`/handoff` + `read_session`), plus
`/tmp/opencode` findings inclusion. Work copy — **not installed**
(no config entry; install only on explicit approval + restart).

Inspired by [opencode-handoff](https://github.com/joshuadavidthomas/opencode-handoff)
by Josh Thomas — thank you. This is a separate plugin, not a contribution
back upstream: the V2 API port and subsequent revamp share only the concept,
and nothing here is being pushed to the original repo.

## V1 → V2 changes

- Plugin shape: `{ config, tool, "chat.message", event }` → `{ id, setup }`
  with `ctx.command.transform` / `ctx.tool.transform` (default export).
- Deps: `@opencode-ai/plugin` + `@opencode-ai/sdk` + zod →
  `@opencode/plugin` peer with plain JSON-schema tool inputs.
- `ctx.client` does not exist in V2:
  - `read_session` reads via `ctx.session.context({ sessionID })`.
  - `handoff_session` uses `ctx.session.create` + `ctx.session.prompt`
    instead of the TUI-only `session_new`/`appendPrompt`/`toast` flow, so it
    works in TUI, CLI, and API. Trade-off: the new session starts working
    immediately instead of staging an editable draft (the prompt tells it to
    confirm direction before anything destructive).
- V1 `chat.message` text-sniffing file injection is gone — the tool resolves
  files itself. File content is inlined as markdown sections (no synthetic
  Read-tool parts).
- `session.deleted` bookkeeping dropped (nothing per-session to clean).

## Findings inclusion

- `/handoff` instructions require structured context: goal, decisions +
  explicit non-goals, per-file purposes (each file must map to the goal,
  must-have vs nice-to-have), verbatim decision-point excerpts, validation
  with results, and open threads.
- Findings: the single most recently mentioned transcript ref (override via
  the tool's `findings` parameter); none mentioned → none attached.
- Working tree (`git` branch/status/diff-stat) auto-collected; skipped
  outside checkouts.
- Total budget ~96 KB: summary untouchable, largest file/findings sections
  trim first.
- `--quick` in the goal → `mode: "quick"`: summary plus findings only,
  files named not inlined.
- `handoff_session` attaches the single most recently mentioned findings
  file from the session transcript (64 KB inline cap, larger name-only;
  none mentioned → none attached, never a batch).

## Model and agent selection

The goal text may carry `--model <fragment>` and/or `--agent <fragment>`
(case-insensitive, partial values ok). Resolution: exact id/name, then
prefix, then substring; model ties prefer the highest numeric version. No
flags means the new session inherits the current session's agent and model.
Flags are consumed, not posted. The result line reports both with source.

Examples:

```text
/handoff get PR37 green --model muse
/handoff finish the port --agent worker-coder --model small-model
/handoff --quick checkpoint before lunch
```

The generated prompt also carries the session-conduct rule: task-closing
replies end with the byte-exact line `TASK COMPLETE` alone on the last
line. Harmless where no stall watcher runs; critical where one does.

## Verify

- `tsc --noEmit`: clean. `tsc -p tsconfig.build.json`: emits `dist/`.
- `dist/index.js` loads in plain node (`id: handoff`, `setup: function`).
- Smoke-tested: ref parsing, most-recent session findings resolution
  (last-wins / none / missing), explicit override, quick mode (named-only),
  working-tree collection, budget trim (684 KB section dropped, findings
  kept), file sections.

## Install (needs approval + restart)

**Quick method:** download the `dist` bundle from the latest
[release](https://github.com/famewolf/opencode-handoff-v2/releases) into a
folder (e.g. `~/.config/opencode-v2/opencode/plugins/handoff/`), register it
(below), restart.

**Manual method:** clone the repo and point at the source (bun executes the
root `index.ts` directly — see loader note):

```sh
git clone https://github.com/famewolf/opencode-handoff-v2.git
```

Add `"file:///home/famewolf/opencode-handoff-v2"` to the `plugin`
array in `~/.config/opencode-v2/opencode/opencode.jsonc`, then restart
(config loads at startup). NOTE: the entry must sit outside
`<config>/plugins/` (auto-discovery would double-load it).

## Loader note (verified 2026-10-14)
`file://` directory entries resolve root `index.ts` (bun executes TS
directly — cf. boot log `entrypoint=.../todolist-fixed/index.ts`), NOT
`exports` → `dist`. A package without root `index.ts` is skipped with no
loading line and no error. `dist/` remains the build artifact.
