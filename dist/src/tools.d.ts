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
}
export declare const handoffSessionInputSchema: {
    readonly type: "object";
    readonly properties: {
        readonly prompt: {
            readonly type: "string";
            readonly description: "The generated handoff prompt";
        };
        readonly files: {
            readonly type: "array";
            readonly items: {
                readonly type: "string";
            };
            readonly description: "Array of file paths to load into the new session's context";
        };
        readonly mode: {
            readonly type: "string";
            readonly description: "quick: summary plus findings only, no file sections. full: everything (default)";
        };
        readonly findings: {
            readonly type: "string";
            readonly description: "Explicit findings file ref, overriding the most-recently-mentioned one";
        };
    };
    readonly required: readonly ["prompt"];
};
export declare const readSessionInputSchema: {
    readonly type: "object";
    readonly properties: {
        readonly sessionID: {
            readonly type: "string";
            readonly description: "The full session ID (e.g., ses_xxxxxxxxxxxxxxxx)";
        };
        readonly limit: {
            readonly type: "number";
            readonly description: "Maximum number of messages to read (defaults to 100, max 500)";
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
                readonly type: "string";
                readonly description: "The generated handoff prompt";
            };
            readonly files: {
                readonly type: "array";
                readonly items: {
                    readonly type: "string";
                };
                readonly description: "Array of file paths to load into the new session's context";
            };
            readonly mode: {
                readonly type: "string";
                readonly description: "quick: summary plus findings only, no file sections. full: everything (default)";
            };
            readonly findings: {
                readonly type: "string";
                readonly description: "Explicit findings file ref, overriding the most-recently-mentioned one";
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
                readonly type: "string";
                readonly description: "The full session ID (e.g., ses_xxxxxxxxxxxxxxxx)";
            };
            readonly limit: {
                readonly type: "number";
                readonly description: "Maximum number of messages to read (defaults to 100, max 500)";
            };
        };
        readonly required: readonly ["sessionID"];
    };
    execute: (input: ReadSessionInput) => Promise<{
        content: string;
    }>;
};
export {};
