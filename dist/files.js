/**
 * File reference parsing and findings inclusion for handoff sessions (V2).
 *
 * V1 built synthetic Read-tool parts; V2 inlines file content as markdown
 * sections in the handoff prompt text instead (no synthetic-part dependency).
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { isBinaryFile } from "./vendor.js";
/**
 * File reference regex matching OpenCode's internal pattern.
 * Matches @file references like @src/plugin.ts
 */
export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g;
/** Scratch dir where session findings files live (symlink to workspace). */
export const FINDINGS_ROOT = "/tmp/opencode";
/** Max findings files auto-attached to a handoff. */
export const MAX_FINDINGS_FILES = 10;
/** Findings files larger than this are listed by name only, not inlined. */
export const FINDINGS_INLINE_BYTES = 64 * 1024;
/** Total handoff prompt budget in bytes; sections trim largest-first past it. */
export const HANDOFF_BUDGET_BYTES = 96 * 1024;
function runGit(args, cwd, timeoutMs = 10000) {
    return new Promise((resolve) => {
        execFile("git", args, { cwd, timeout: timeoutMs }, (error, stdout) => {
            if (error) {
                resolve(undefined);
                return;
            }
            const text = String(stdout).trim();
            resolve(text.length > 0 ? text : undefined);
        });
    });
}
/**
 * Collect working-tree state for implementation sessions: branch, short
 * status, and diff stat. Returns undefined outside a git checkout or on any
 * failure — never throws.
 */
export async function collectWorkingTree(directory) {
    const [branch, status, stat] = await Promise.all([
        runGit(["rev-parse", "--abbrev-ref", "HEAD"], directory),
        runGit(["status", "--short"], directory),
        runGit(["diff", "--stat"], directory),
    ]);
    if (branch === undefined && status === undefined && stat === undefined)
        return undefined;
    const lines = ["## Working tree"];
    if (branch !== undefined)
        lines.push(`Branch: ${branch}`);
    if (status !== undefined)
        lines.push(`Status:\n\`\`\`\n${status}\n\`\`\``);
    else
        lines.push("Status: clean");
    if (stat !== undefined)
        lines.push(`Diff stat:\n\`\`\`\n${stat}\n\`\`\``);
    return lines.join("\n\n");
}
/**
 * Parse @file references from text.
 */
export function parseFileReferences(text) {
    const fileRefs = new Set();
    for (const match of text.matchAll(FILE_REGEX)) {
        if (match[1]) {
            fileRefs.add(match[1]);
        }
    }
    return fileRefs;
}
/**
 * Render one file as a markdown section. Returns undefined when the file
 * cannot be read or is binary.
 */
export async function renderFileSection(directory, ref) {
    const filepath = path.resolve(directory, ref);
    try {
        const stats = await fs.stat(filepath);
        if (!stats.isFile())
            return undefined;
        if (await isBinaryFile(filepath))
            return undefined;
        const content = await fs.readFile(filepath, "utf-8");
        return `### ${ref}\n\n\`\`\`\n${content}\n\`\`\``;
    }
    catch {
        return undefined;
    }
}
/**
 * Build markdown sections for a set of file refs, resolved against directory.
 * Unreadable and binary files are skipped silently.
 */
export async function buildFileSections(directory, refs) {
    const sections = [];
    for (const ref of refs) {
        const section = await renderFileSection(directory, ref);
        if (section !== undefined)
            sections.push(section);
    }
    return sections;
}
/** Matches findings file refs in session text: /tmp/opencode/...findings....md */
export const SESSION_FINDINGS_REGEX = /\/tmp\/opencode\/[^\s`,]*findings[^\s`,]*\.md/g;
/**
 * Resolve THE findings file for a handoff: the most recently mentioned
 * /tmp/opencode findings ref in the session transcript (last occurrence in
 * message order wins). Returns undefined when the session lists none — the
 * caller attaches nothing rather than guessing.
 */
export async function resolveSessionFindings(messages) {
    if (!Array.isArray(messages))
        return undefined;
    let last;
    for (const message of messages) {
        if (message === null || typeof message !== "object")
            continue;
        const record = message;
        const parts = record["content"] ?? record["parts"];
        const texts = [];
        if (typeof record["text"] === "string")
            texts.push(record["text"]);
        if (Array.isArray(parts)) {
            for (const part of parts) {
                if (part !== null && typeof part === "object") {
                    const text = part["text"];
                    if (typeof text === "string")
                        texts.push(text);
                }
            }
        }
        for (const text of texts) {
            for (const match of text.matchAll(SESSION_FINDINGS_REGEX)) {
                last = match[0];
            }
        }
    }
    if (last === undefined)
        return undefined;
    try {
        const stats = await fs.stat(last);
        if (!stats.isFile())
            return undefined;
    }
    catch {
        return undefined;
    }
    return last;
}
/**
 * List session findings files under FINDINGS_ROOT (top level only,
 * `*findings*.md`). Bounded by MAX_FINDINGS_FILES, sorted by mtime (newest
 * first). Files over FINDINGS_INLINE_BYTES are returned name-only.
 */
export async function listFindingsFiles() {
    let entries;
    try {
        entries = await fs.readdir(FINDINGS_ROOT);
    }
    catch {
        return [];
    }
    const candidates = entries.filter((name) => name.includes("findings") && name.endsWith(".md"));
    const withTime = await Promise.all(candidates.map(async (name) => {
        try {
            const stats = await fs.stat(path.join(FINDINGS_ROOT, name));
            return { name, mtime: stats.mtimeMs, size: stats.size };
        }
        catch {
            return undefined;
        }
    }));
    const sorted = withTime
        .filter((entry) => entry !== undefined)
        .sort((left, right) => right.mtime - left.mtime)
        .slice(0, MAX_FINDINGS_FILES);
    const hits = [];
    for (const { name, size } of sorted) {
        const ref = path.join(FINDINGS_ROOT, name);
        if (size > FINDINGS_INLINE_BYTES) {
            hits.push({ ref, inlined: false });
            continue;
        }
        try {
            const content = await fs.readFile(ref, "utf-8");
            hits.push({ ref, inlined: true, section: `### ${ref}\n\n\`\`\`\n${content}\n\`\`\`` });
        }
        catch {
            hits.push({ ref, inlined: false });
        }
    }
    return hits;
}
