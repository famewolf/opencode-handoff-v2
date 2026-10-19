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
import type { Plugin } from "@opencode/plugin";
type Context = Plugin.Context;
interface HandoffSessionInput {
    prompt?: unknown;
    files?: unknown;
    mode?: unknown;
    findings?: unknown;
}
interface ReadSessionInput {
    sessionID?: unknown;
    limit?: unknown;
    offset?: unknown;
}
export declare function resolveModelFragment(fragment: string, models: Array<{
    id?: unknown;
    name?: unknown;
    providerID?: unknown;
}>): {
    providerID: string;
    id: string;
} | undefined;
export declare function resolveAgentFragment(fragment: string, agents: Array<{
    name?: unknown;
}>): string | undefined;
export declare const handoffSessionInputSchema: {
    readonly type: "object";
    readonly properties: {
        readonly prompt: {
            readonly description: "The generated handoff prompt";
            readonly type: "string";
        };
        readonly files: {
            readonly description: "Array of file paths to load into the new session's context";
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
        };
        readonly mode: {
            readonly description: "quick: summary plus findings only, no file sections. full: everything (default)";
            readonly type: "string";
        };
        readonly findings: {
            readonly description: "Explicit findings file ref, overriding the most-recently-mentioned one";
            readonly type: "string";
        };
    };
    readonly required: readonly ["prompt"];
};
export declare const readSessionInputSchema: {
    readonly type: "object";
    readonly properties: {
        readonly sessionID: {
            readonly description: "The full session ID (e.g., ses_xxxxxxxxxxxxxxxx)";
            readonly type: "string";
        };
        readonly limit: {
            readonly type: "number";
            readonly description: "Maximum number of messages to read (defaults to 100, max 500)";
        };
        readonly offset: {
            readonly type: "number";
            readonly description: "Messages to skip back from the NEWEST before reading (0 = default, reads the tail). Raise it to page toward the START of a long session — e.g. offset:100 reads the 100-to-125-newest window. Clamps at the start of history rather than returning nothing.";
        };
    };
    readonly required: readonly ["sessionID"];
};
/**
 * Create the handoff_session tool: builds the full prompt (session
 * reference + findings + file sections + model prompt), creates a new
 * session, and posts it there.
 */
export declare function makeHandoffSession(ctx: Context): {
    name: string;
    description: string;
    input: {
        readonly type: "object";
        readonly properties: {
            readonly prompt: {
                readonly description: "The generated handoff prompt";
                readonly type: "string";
            };
            readonly files: {
                readonly description: "Array of file paths to load into the new session's context";
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
            };
            readonly mode: {
                readonly description: "quick: summary plus findings only, no file sections. full: everything (default)";
                readonly type: "string";
            };
            readonly findings: {
                readonly description: "Explicit findings file ref, overriding the most-recently-mentioned one";
                readonly type: "string";
            };
        };
        readonly required: readonly ["prompt"];
    };
    execute: (input: HandoffSessionInput, context: {
        sessionID: string;
    }) => Promise<{
        content: string;
    }>;
};
/**
 * Create the read_session tool: returns the transcript of a previous
 * session via ctx.session.context.
 */
export declare function makeReadSession(ctx: Context): {
    name: string;
    description: string;
    input: {
        readonly type: "object";
        readonly properties: {
            readonly sessionID: {
                readonly description: "The full session ID (e.g., ses_xxxxxxxxxxxxxxxx)";
                readonly type: "string";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum number of messages to read (defaults to 100, max 500)";
            };
            readonly offset: {
                readonly type: "number";
                readonly description: "Messages to skip back from the NEWEST before reading (0 = default, reads the tail). Raise it to page toward the START of a long session — e.g. offset:100 reads the 100-to-125-newest window. Clamps at the start of history rather than returning nothing.";
            };
        };
        readonly required: readonly ["sessionID"];
    };
    execute: (input: ReadSessionInput) => Promise<{
        content: string;
    }>;
};
export {};
