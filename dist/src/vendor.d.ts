/**
 * Code extracted from OpenCode for compatibility.
 *
 * Source: https://github.com/sst/opencode
 * File: packages/opencode/src/tool/read.ts
 *
 * These functions and constants are copied to ensure our synthetic file parts
 * match OpenCode's Read tool output exactly.
 */
/**
 * Constants from OpenCode's ReadTool
 */
export declare const DEFAULT_READ_LIMIT = 2000;
export declare const MAX_LINE_LENGTH = 2000;
/**
 * Check if a file is binary (copied from OpenCode's ReadTool)
 */
export declare function isBinaryFile(filepath: string): Promise<boolean>;
/**
 * Format file content matching OpenCode's Read tool output format.
 *
 * @param _filepath - Absolute path to the file (unused in output, kept for signature compatibility)
 * @param content - File content as string
 * @returns Formatted output with line numbers in <file> tags
 */
export declare function formatFileContent(_filepath: string, content: string): string;
