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
import { FINDINGS_ROOT } from "./files.js";
import { makeHandoffSession, makeReadSession } from "./tools.js";
const HANDOFF_COMMAND = `GOAL: You are creating a handoff message to continue work in a new session.

<context>
When an AI assistant starts a fresh session, it spends significant time exploring the codebase—grepping, reading files, searching—before it can begin actual work. This "file archaeology" is wasteful when the previous session already discovered what matters.

A good handoff frontloads everything the next session needs so it can start implementing immediately.
</context>

<instructions>
Analyze this conversation and extract what matters for continuing the work.

1. Identify all relevant files that should be loaded into the next session's context

   Every file must map to the stated goal — if you cannot say why the goal needs it, leave it out. A tight 3-file handoff beats a padded 15-file one. Split picks into tiers in your message: must-have (the goal fails without it) vs nice-to-have (useful background).

2. Draft the context and goal description

   Describe what we're working on and provide whatever context helps continue the work. Structure it with these sections (skip none — write "none" rather than omitting):

   - Goal: what the next session should accomplish.
   - Decisions and constraints: choices already made, user preferences, technical patterns. Anything deliberately left out of scope goes here so the next session does not "rediscover" it as a gap.
   - Files: for every file in the files array, one line — path plus why it matters. Keep bare paths in the files array itself (no annotations there; prose goes here).
   - Decision points: quote the 2-3 exchanges where direction was actually decided (corrections, approvals, "do X not Y") verbatim, so the next session sees the reasoning, not just its outcome.
   - Validation: exact checks and tests already run with their results, plus what was NOT checked.
   - Open threads: what is unverified, blocked, or awaiting someone else. The next session picks these up instead of re-deriving them.

   Preserve: decisions, constraints, user preferences, technical patterns.

   Exclude: conversation back-and-forth, dead ends, meta-commentary.

   Keep the whole message concise markdown the next session can act on immediately. The handoff assembly caps total size (roughly 96 KB, files trim first) — front-load accordingly.

3. Name the session findings file

   This box keeps per-task findings in ${FINDINGS_ROOT} (files matching *findings*.md). Mention the one findings file the next session needs as an @-ref (e.g. @${FINDINGS_ROOT}/todo_plugin_findings.md). The handoff tool attaches the most recently mentioned one — a single file, never a batch. To override recency, pass it explicitly via the tool's findings parameter. If none fits, say so explicitly and none is attached.

Mode: if the user's goal contains --quick, call handoff_session with mode "quick" (summary plus findings only, file contents omitted). Otherwise use the default full mode.

3. Name the session findings file

   This box keeps per-task findings in ${FINDINGS_ROOT} (files matching *findings*.md). Mention the one findings file the next session needs as an @-ref (e.g. @${FINDINGS_ROOT}/todo_plugin_findings.md). The handoff tool attaches the most recently mentioned one — a single file, never a batch. If none fits, say so explicitly and none is attached.

The user controls what context matters. If they mentioned something to preserve, include it—trust their judgment about their workflow.

4. Session conduct for the new session

   When the new session finishes a task-closing reply, it ends the reply
   with the byte-exact line TASK COMPLETE alone on the last line (nothing
   before it, nothing after it, no emoji). On this box a missing signal
   reads as a stall to the auto-resume watcher when installed — harmless
   instruction when it is not, critical when it is.
</instructions>

<user_input>
This is what the next session should focus on. Use it to shape your handoff's direction—don't investigate or search, just incorporate the intent into your context and goals.

If empty, capture a natural continuation of the current conversation's direction.

USER: $ARGUMENTS
</user_input>

---

After generating the handoff message, IMMEDIATELY call handoff_session with your prompt and files:
\`handoff_session(prompt="...", files=["src/foo.ts", "src/bar.ts", ...])\`
`;
function goalFromPrompt(prompt) {
    if (prompt === null || typeof prompt !== "object")
        return "";
    const text = prompt["text"];
    return typeof text === "string" ? text : "";
}
export const HandoffV2Plugin = {
    id: "handoff",
    async setup(ctx) {
        await ctx.command.transform((cmd) => {
            cmd.add({
                name: "handoff",
                description: "Create a focused handoff prompt for a new session (prompt + findings + files travel along)",
                execute: async ({ sessionID, prompt, delivery }) => {
                    const goal = goalFromPrompt(prompt).trim();
                    const text = HANDOFF_COMMAND.replace("USER: $ARGUMENTS", `USER: ${goal.length > 0 ? goal : "(no goal given — capture a natural continuation)"}`);
                    await ctx.session.prompt({ ...prompt, sessionID, text, delivery });
                },
            });
        });
        await ctx.tool.transform((editor) => {
            editor.add(makeHandoffSession(ctx));
            editor.add(makeReadSession(ctx));
        });
    },
};
export default HandoffV2Plugin;
