/**
 * opencode-handoff-v2 — V2 port of opencode-handoff.
 *
 * V1 → V2 changes:
 * - `{ config, tool, "chat.message", event }` return shape becomes
 *   `define({ id, setup })` with `ctx.command.transform` / `ctx.tool.transform`.
 * - `@opencode-ai/plugin` + `@opencode-ai/sdk` + zod become `@opencode/plugin`
 *   (peer) with plain JSON-schema tool inputs.
 * - `ctx.client` does not exist in V2. `read_session` uses
 *   `ctx.session.context`; `handoff_session` uses `ctx.session.create` +
 *   `ctx.session.prompt` instead of the TUI-only session_new/appendPrompt
 *   flow — so handoffs work in TUI, CLI, and API alike.
 * - The V1 "chat.message" text-sniffing file injection is gone: the tool
 *   resolves files itself, so no fragile output scanning is needed.
 * - `/tmp/opencode` findings files are auto-attached by handoff_session
 *   (bounded, newest-first) and requested in the /handoff instructions.
 */
import type { Plugin } from "@opencode/plugin";
export declare const HandoffV2Plugin: Plugin.Plugin;
export default HandoffV2Plugin;
