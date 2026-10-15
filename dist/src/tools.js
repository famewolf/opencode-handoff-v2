/**
 * Tool definitions for opencode-handoff-v2.
 *
 * V1 drove a TUI-only flow (session_new + appendPrompt + toast) via
 * ctx.client. V2 has no ctx.client and no programmatic TUI control, so
 * handoff_session instead creates the session and posts the prompt directly
 * via ctx.session — which works in TUI, CLI, and API alike. The "editable
 * draft" step is replaced by starting the turn immediately; the prompt text
 * itself tells the next session to confirm direction before acting.
 */
import * as fs from "node:fs/promises";
import { FINDINGS_ROOT, FINDINGS_INLINE_BYTES, HANDOFF_BUDGET_BYTES, buildFileSections, collectWorkingTree, parseFileReferences, resolveSessionFindings } from "./files.js";
const STRING_SCHEMA = { type: "string" };
const OPTIONAL_STRING_ARRAY_SCHEMA = {
    type: "array",
    items: { type: "string" },
};
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((entry) => typeof entry === "string");
}
/**
 * Format a conversation transcript for display. Reads V2 message shapes
 * defensively (role/content with info/parts fallbacks).
 */
function formatTranscript(messages, limit) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return "Session has no messages or does not exist.";
    }
    const lines = [];
    for (const message of messages) {
        if (message === null || typeof message !== "object")
            continue;
        const record = message;
        const role = record["role"] ?? record["info"]?.["role"];
        const parts = record["content"] ?? record["parts"];
        if (!Array.isArray(parts))
            continue;
        if (role === "user") {
            lines.push("## User");
            for (const part of parts) {
                if (part === null || typeof part !== "object")
                    continue;
                const p = part;
                if (p["type"] === "text" && typeof p["text"] === "string" && !p["ignored"])
                    lines.push(p["text"]);
                if (p["type"] === "file")
                    lines.push(`[Attached: ${p["filename"] ?? "file"}]`);
            }
            lines.push("");
        }
        if (role === "assistant") {
            lines.push("## Assistant");
            for (const part of parts) {
                if (part === null || typeof part !== "object")
                    continue;
                const p = part;
                if (p["type"] === "text" && typeof p["text"] === "string")
                    lines.push(p["text"]);
                if (p["type"] === "tool") {
                    const state = p["state"];
                    if (state?.["status"] === "completed")
                        lines.push(`[Tool: ${String(p["tool"])}] ${String(state["title"] ?? "")}`);
                }
            }
            lines.push("");
        }
    }
    const output = lines.join("\n").trim();
    if (messages.length >= limit) {
        return output + `\n\n(Showing ${messages.length} most recent messages. Use a higher 'limit' to see more.)`;
    }
    return output + `\n\n(End of session - ${messages.length} messages)`;
}
export const handoffSessionInputSchema = {
    type: "object",
    properties: {
        prompt: { ...STRING_SCHEMA, description: "The generated handoff prompt" },
        files: { ...OPTIONAL_STRING_ARRAY_SCHEMA, description: "Array of file paths to load into the new session's context" },
        mode: { ...STRING_SCHEMA, description: "quick: summary plus findings only, no file sections. full: everything (default)" },
        findings: { ...STRING_SCHEMA, description: "Explicit findings file ref, overriding the most-recently-mentioned one" },
    },
    required: ["prompt"],
};
export const readSessionInputSchema = {
    type: "object",
    properties: {
        sessionID: { ...STRING_SCHEMA, description: "The full session ID (e.g., ses_xxxxxxxxxxxxxxxx)" },
        limit: { type: "number", description: "Maximum number of messages to read (defaults to 100, max 500)" },
    },
    required: ["sessionID"],
};
/**
 * Create the handoff_session tool: builds the full prompt (session
 * reference + findings + file sections + model prompt), creates a new
 * session, and posts it there.
 */
export function makeHandoffSession(ctx) {
    return {
        name: "handoff_session",
        description: "Create a new session carrying the handoff prompt, findings, and file context",
        input: handoffSessionInputSchema,
        execute: async (input, context) => {
            const prompt = typeof input.prompt === "string" ? input.prompt : "";
            const files = asStringArray(input.files).map((file) => file.replace(/^@/, ""));
            const directory = ctx.location.directory;
            const quick = input.mode === "quick";
            const explicitFindings = typeof input.findings === "string" && input.findings.length > 0 ? input.findings : undefined;
            const sessionReference = `Continuing work from session ${context.sessionID}. When you lack specific information you can use read_session to get it. ` +
                `Confirm direction before acting on anything destructive.`;
            const refs = new Set(files);
            for (const ref of parseFileReferences(prompt))
                refs.add(ref);
            const fileSections = quick ? [] : await buildFileSections(directory, refs);
            const namedFiles = quick && refs.size > 0 ? [...refs].map((ref) => `- ${ref}`) : [];
            let findingsRef = explicitFindings;
            if (findingsRef === undefined) {
                findingsRef = await resolveSessionFindings((await ctx.session.context({ sessionID: context.sessionID })));
            }
            const findingsSections = [];
            const findingsNamedOnly = [];
            let findingsCount = 0;
            if (findingsRef !== undefined) {
                findingsCount = 1;
                try {
                    const stats = await fs.stat(findingsRef);
                    if (stats.size > FINDINGS_INLINE_BYTES) {
                        findingsNamedOnly.push(`- ${findingsRef} (too large to inline — read directly)`);
                    }
                    else {
                        const content = await fs.readFile(findingsRef, "utf-8");
                        findingsSections.push(`### ${findingsRef}\n\n\`\`\`\n${content}\n\`\`\``);
                    }
                }
                catch {
                    findingsNamedOnly.push(`- ${findingsRef} (listed in session but unreadable — read directly)`);
                }
            }
            const workingTree = quick ? undefined : await collectWorkingTree(directory);
            const blocks = [sessionReference];
            blocks.push(prompt);
            if (findingsSections.length > 0) {
                blocks.push(`## Session findings (${FINDINGS_ROOT})`, ...findingsSections);
            }
            if (findingsNamedOnly.length > 0) {
                blocks.push("## Large findings files (name only)", ...findingsNamedOnly);
            }
            if (workingTree !== undefined) {
                blocks.push(workingTree);
            }
            if (fileSections.length > 0) {
                blocks.push("## Referenced files", ...fileSections);
            }
            if (quick && namedFiles.length > 0) {
                blocks.push("## Named files (content omitted in quick mode — read directly)", ...namedFiles);
            }
            // Budget: summary and reference line are untouchable; trim the
            // largest droppable sections first (files, then findings), largest
            // section per pass, until under budget.
            const droppable = [fileSections, findingsSections];
            let fullPrompt = blocks.join("\n\n");
            while (Buffer.byteLength(fullPrompt, "utf8") > HANDOFF_BUDGET_BYTES) {
                let biggest;
                for (const group of droppable) {
                    if (group.length === 0)
                        continue;
                    if (biggest === undefined || group.join("\n").length > biggest.join("\n").length)
                        biggest = group;
                }
                if (biggest === undefined)
                    break;
                let longestIndex = 0;
                for (let index = 1; index < biggest.length; index++) {
                    if (biggest[index].length > biggest[longestIndex].length)
                        longestIndex = index;
                }
                biggest.splice(longestIndex, 1);
                fullPrompt = [
                    sessionReference,
                    prompt,
                    ...(findingsSections.length > 0 ? [`## Session findings (${FINDINGS_ROOT})`, ...findingsSections] : []),
                    ...(findingsNamedOnly.length > 0 ? ["## Large findings files (name only)", ...findingsNamedOnly] : []),
                    ...(workingTree !== undefined ? [workingTree] : []),
                    ...(fileSections.length > 0 ? ["## Referenced files", ...fileSections] : []),
                    ...(quick && namedFiles.length > 0 ? ["## Named files (content omitted in quick mode — read directly)", ...namedFiles] : []),
                ].join("\n\n");
            }
            const created = await ctx.session.create({});
            const sessionID = created.id;
            if (typeof sessionID !== "string" || sessionID.length === 0) {
                return { content: "Handoff failed: session.create returned no session id." };
            }
            await ctx.session.prompt({ sessionID, text: fullPrompt });
            return {
                content: `Handoff posted to new session ${sessionID} ` +
                    `(${files.length} file(s)` + (findingsCount > 0 ? `, session findings attached` : `, no findings listed in session`) + `). ` +
                    `Continue there; this session is unchanged.`,
            };
        },
    };
}
/**
 * Create the read_session tool: returns the transcript of a previous
 * session via ctx.session.context.
 */
export function makeReadSession(ctx) {
    return {
        name: "read_session",
        description: "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the handoff summary.",
        input: readSessionInputSchema,
        execute: async (input) => {
            if (typeof input.sessionID !== "string" || input.sessionID.length === 0) {
                return { content: "read_session requires a sessionID string." };
            }
            const limit = Math.min(typeof input.limit === "number" ? input.limit : 100, 500);
            try {
                const messages = (await ctx.session.context({ sessionID: input.sessionID }));
                return { content: formatTranscript(messages, limit) };
            }
            catch (error) {
                return {
                    content: `Could not read session ${input.sessionID}: ${error instanceof Error ? error.message : "Unknown error"}`,
                };
            }
        },
    };
}
