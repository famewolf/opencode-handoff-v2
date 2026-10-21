/**
 * Model/agent selection for a handoff.
 *
 * The flags used to travel from the /handoff command to the handoff_session
 * tool ONLY inside the model-authored prompt. A rewrite that dropped them was
 * indistinguishable from "no flag", so the new session silently inherited the
 * running model instead of the requested one (session
 * ses_ea3aaf791ffeQnLj7FZ1bbJzHk, 2026-10-21: the goal said
 * "--model pickle", the model's prompt said nothing, and the handoff would
 * have run on the current model with no warning).
 *
 * Three channels now carry the selection, in this precedence:
 *
 *   GOAL      the user's own words, captured when the command ran. No LLM
 *             sits between the user and the flag, so it cannot be dropped.
 *   ARGUMENT  an explicit model/agent argument on the tool call.
 *   PROMPT    the model-authored handoff message — a fallback for direct
 *             tool calls, and the weakest signal.
 *
 * The GOAL survives a process restart between the command and the tool call:
 * the rendered /handoff template still sits in the session transcript, and the
 * goal can be recovered from it.
 */
export interface SelectionFlags {
    model?: string;
    agent?: string;
}
/** Where a selection came from — reported in the handoff result. */
export type SelectionOrigin = "goal" | "argument" | "prompt";
export interface Selection {
    fragment: string;
    origin: SelectionOrigin;
}
/**
 * Parse `--model <fragment>` / `--agent <fragment>` out of a goal text.
 *
 * Flags (case-insensitive, partial values ok): `--model <fragment>`,
 * `--agent <fragment>`. Resolution, in order: exact id/name match, then
 * prefix, then substring; model ties break toward the highest numeric
 * version (1.10 beats 1.9); a final tie — or anything unreadable — falls
 * back to inheriting the current session and says so. No flag means
 * inherit. Verified against the live API 2026-10-15: session.create takes
 * {agent?, model?}, session.get returns {agent?, model?}, model.switch and
 * agent.switch are independent (neither resets the other), both 204.
 * 2026-10-19: the catalogue arrives via listEntries — the SDK's list calls
 * return { location, data }, not the bare array this comment once assumed.
 */
export declare function parseSelectionFlag(goal: string, name: "model" | "agent"): string | undefined;
export declare function stripSelectionFlags(goal: string): string;
/** Both flags of a goal text, if present. */
export declare function selectFromGoal(goal: string): SelectionFlags;
/**
 * Pick the selection to apply: goal beats argument beats prompt.
 *
 * The goal outranks the prompt because a model rewrite that dropped the flag
 * used to look exactly like "no flag" — and the handoff then silently ran on
 * the wrong model.
 */
export declare function pickSelection(goal: string | undefined, argument: string | undefined, prompt: string | undefined): Selection | undefined;
/**
 * Pull the goal back out of a rendered /handoff template message.
 *
 * The template renders the goal as "USER: <goal>" inside <user_input>; the
 * FIRST "USER:" in that block is the template's own label (a goal may itself
 * contain the word "USER:", so taking the last one would be wrong).
 */
export declare function extractGoal(rendered: string): string | undefined;
/**
 * The text of a session message, whichever shape it arrived in.
 *
 * Mirrors normalizeParts() in tools.ts: `{content: [{type:"text"}]}`,
 * `{parts: [...]}`, `{content: "text"}` and the flat `{text: "text"}` shape
 * the live v2 session API returns.
 */
export declare function messageText(message: unknown): string | undefined;
/** The most recent /handoff goal found in a session transcript. */
export declare function findGoalInMessages(messages: ReadonlyArray<unknown> | undefined): string | undefined;
export declare function recordGoal(sessionID: string, goal: string): void;
export declare function cachedGoal(sessionID: string): string | undefined;
/** Drop one captured goal — the handoff it started has been posted. */
export declare function clearGoal(sessionID: string): void;
/** Drop the captured goals — a server restart does this implicitly. */
export declare function clearGoalCache(): void;
