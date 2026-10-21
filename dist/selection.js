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
export function parseSelectionFlag(goal, name) {
    const match = new RegExp(`--${name}\\s+("[^"]*"|'[^']*'|[^\\n]+)`, "i").exec(goal);
    if (!match)
        return undefined;
    // A display name can contain spaces ("--model Big Pickle"), so the value runs
    // to the end of the line rather than one token, stopping at a following
    // --flag. (2026-10-19: taking a single token made `Big Pickle` resolve as
    // `Big`, i.e. a real but wrong model.)
    const value = match[1].replace(/[ \t]+--[A-Za-z][\w-]*(?=[ \t]|$)[\s\S]*$/, "").trim();
    return value.replace(/^["']|["']$/g, "").trim() || undefined;
}
export function stripSelectionFlags(goal) {
    // Same line-scoped rule as parseSelectionFlag: strip the flag plus its whole
    // value, stopping at the next flag. A single-token strip left the tail of a
    // multi-word value behind ("--model Big Pickle" -> "Pickle" in the prompt).
    return goal
        .replace(/[ \t]*--(?:model|agent)[ \t]+("[^"]*"|'[^']*'|[^\n]*?)(?=[ \t]+--[A-Za-z][\w-]*(?=[ \t]|$)|[ \t]*$)/gim, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/[ \t]+$/gm, "")
        .trim();
}
/** Both flags of a goal text, if present. */
export function selectFromGoal(goal) {
    const model = parseSelectionFlag(goal, "model");
    const agent = parseSelectionFlag(goal, "agent");
    return {
        ...(model !== undefined ? { model } : {}),
        ...(agent !== undefined ? { agent } : {}),
    };
}
/**
 * Pick the selection to apply: goal beats argument beats prompt.
 *
 * The goal outranks the prompt because a model rewrite that dropped the flag
 * used to look exactly like "no flag" — and the handoff then silently ran on
 * the wrong model.
 */
export function pickSelection(goal, argument, prompt) {
    if (goal !== undefined && goal.length > 0)
        return { fragment: goal, origin: "goal" };
    if (argument !== undefined && argument.length > 0)
        return { fragment: argument, origin: "argument" };
    if (prompt !== undefined && prompt.length > 0)
        return { fragment: prompt, origin: "prompt" };
    return undefined;
}
/** The label the /handoff template renders the goal under. */
const GOAL_LABEL = /(^|\n)USER:[ \t]*/;
/**
 * Pull the goal back out of a rendered /handoff template message.
 *
 * The template renders the goal as "USER: <goal>" inside <user_input>; the
 * FIRST "USER:" in that block is the template's own label (a goal may itself
 * contain the word "USER:", so taking the last one would be wrong).
 */
export function extractGoal(rendered) {
    const block = /<user_input>([\s\S]*?)<\/user_input>/.exec(rendered);
    if (!block)
        return undefined;
    const inner = block[1] ?? "";
    const label = GOAL_LABEL.exec(inner);
    if (!label)
        return undefined;
    const goal = inner.slice(label.index + label[0].length);
    return goal.trim() || undefined;
}
/**
 * The text of a session message, whichever shape it arrived in.
 *
 * Mirrors normalizeParts() in tools.ts: `{content: [{type:"text"}]}`,
 * `{parts: [...]}`, `{content: "text"}` and the flat `{text: "text"}` shape
 * the live v2 session API returns.
 */
export function messageText(message) {
    if (typeof message === "string")
        return message.length > 0 ? message : undefined;
    if (message === null || typeof message !== "object")
        return undefined;
    const record = message;
    const raw = record["content"] ?? record["parts"];
    if (typeof raw === "string")
        return raw.length > 0 ? raw : undefined;
    if (Array.isArray(raw)) {
        const chunks = [];
        for (const part of raw) {
            if (typeof part === "string") {
                chunks.push(part);
                continue;
            }
            if (part === null || typeof part !== "object")
                continue;
            const value = part["text"];
            if (typeof value === "string")
                chunks.push(value);
        }
        return chunks.length > 0 ? chunks.join("\n") : undefined;
    }
    if (typeof record["text"] === "string" && record["text"].length > 0)
        return record["text"];
    return undefined;
}
/** The most recent /handoff goal found in a session transcript. */
export function findGoalInMessages(messages) {
    if (!Array.isArray(messages))
        return undefined;
    for (let index = messages.length - 1; index >= 0; index--) {
        const text = messageText(messages[index]);
        if (text === undefined)
            continue;
        const goal = extractGoal(text);
        if (goal !== undefined)
            return goal;
    }
    return undefined;
}
/**
 * Goals captured when /handoff ran, keyed by session id.
 *
 * The fast path for the common case (command and tool in the same process).
 * The transcript scan in findGoalInMessages() covers a restart in between.
 */
const goals = new Map();
const GOAL_CACHE_LIMIT = 32;
export function recordGoal(sessionID, goal) {
    goals.set(sessionID, goal);
    while (goals.size > GOAL_CACHE_LIMIT) {
        const oldest = goals.keys().next();
        if (oldest.done)
            break;
        goals.delete(oldest.value);
    }
}
export function cachedGoal(sessionID) {
    return goals.get(sessionID);
}
/** Drop one captured goal — the handoff it started has been posted. */
export function clearGoal(sessionID) {
    goals.delete(sessionID);
}
/** Drop the captured goals — a server restart does this implicitly. */
export function clearGoalCache() {
    goals.clear();
}
