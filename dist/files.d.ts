/**
 * File reference parsing and findings inclusion for handoff sessions (V2).
 *
 * V1 built synthetic Read-tool parts; V2 inlines file content as markdown
 * sections in the handoff prompt text instead (no synthetic-part dependency).
 */
/**
 * File reference regex matching OpenCode's internal pattern.
 * Matches @file references like @src/plugin.ts
 */
export declare const FILE_REGEX: RegExp;
/** Scratch dir where session findings files live (symlink to workspace). */
export declare const FINDINGS_ROOT = "/tmp/opencode";
/** Max findings files auto-attached to a handoff. */
export declare const MAX_FINDINGS_FILES = 10;
/** Findings files larger than this are listed by name only, not inlined. */
export declare const FINDINGS_INLINE_BYTES: number;
/** Total handoff prompt budget in bytes; sections trim largest-first past it. */
export declare const HANDOFF_BUDGET_BYTES: number;
/**
 * Collect working-tree state for implementation sessions: branch, short
 * status, and diff stat. Returns undefined outside a git checkout or on any
 * failure — never throws.
 */
export declare function collectWorkingTree(directory: string): Promise<string | undefined>;
/**
 * Parse @file references from text.
 */
export declare function parseFileReferences(text: string): Set<string>;
/**
 * Render one file as a markdown section. Returns undefined when the file
 * cannot be read or is binary.
 */
export declare function renderFileSection(directory: string, ref: string): Promise<string | undefined>;
/**
 * Build markdown sections for a set of file refs, resolved against directory.
 * Unreadable and binary files are skipped silently.
 */
export declare function buildFileSections(directory: string, refs: Set<string>): Promise<string[]>;
/** Matches findings file refs in session text: /tmp/opencode/...findings....md */
export declare const SESSION_FINDINGS_REGEX: RegExp;
/**
 * Resolve THE findings file for a handoff: the most recently mentioned
 * /tmp/opencode findings ref in the session transcript (last occurrence in
 * message order wins). Returns undefined when the session lists none — the
 * caller attaches nothing rather than guessing.
 */
export declare function resolveSessionFindings(messages: ReadonlyArray<unknown> | undefined): Promise<string | undefined>;
export interface FindingsHit {
    /** Workspace-absolute path, usable as an @file ref. */
    ref: string;
    /** True when the content was inlined; false means name-only (too large). */
    inlined: boolean;
    section?: string;
}
/**
 * List session findings files under FINDINGS_ROOT (top level only,
 * `*findings*.md`). Bounded by MAX_FINDINGS_FILES, sorted by mtime (newest
 * first). Files over FINDINGS_INLINE_BYTES are returned name-only.
 */
export declare function listFindingsFiles(): Promise<FindingsHit[]>;
