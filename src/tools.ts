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

import * as fs from "node:fs/promises"
import type { Plugin } from "@opencode/plugin"
import { FINDINGS_ROOT, FINDINGS_INLINE_BYTES, HANDOFF_BUDGET_BYTES, buildFileSections, collectWorkingTree, parseFileReferences, resolveSessionFindings } from "./files.js"

type Context = Plugin.Context

const STRING_SCHEMA = { type: "string" } as const
const OPTIONAL_STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string" },
} as const

interface HandoffSessionInput {
  prompt?: unknown
  files?: unknown
  mode?: unknown
  findings?: unknown
}

interface ReadSessionInput {
  sessionID?: unknown
  limit?: unknown
  offset?: unknown
}

function asStringArray(value: unknown): Array<string> {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

/**
 * Model/agent selection for the new session, from the /handoff goal text.
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
function parseSelectionFlag(goal: string, name: "model" | "agent"): string | undefined {
  const match = new RegExp(`--${name}\\s+("[^"]*"|'[^']*'|[^\\n]+)`, "i").exec(goal)
  if (!match) return undefined
  // A display name can contain spaces ("--model Big Pickle"), so the value runs
  // to the end of the line rather than one token, stopping at a following
  // --flag. (2026-10-19: taking a single token made `Big Pickle` resolve as
  // `Big`, i.e. a real but wrong model.)
  const value = match[1]!.replace(/[ \t]+--[A-Za-z][\w-]*(?=[ \t]|$)[\s\S]*$/, "").trim()
  return value.replace(/^["']|["']$/g, "").trim() || undefined
}

function stripSelectionFlags(goal: string): string {
  // Same line-scoped rule as parseSelectionFlag: strip the flag plus its whole
  // value, stopping at the next flag. A single-token strip left the tail of a
  // multi-word value behind ("--model Big Pickle" -> "Pickle" in the prompt).
  return goal
    .replace(/[ \t]*--(?:model|agent)[ \t]+("[^"]*"|'[^']*'|[^\n]*?)(?=[ \t]+--[A-Za-z][\w-]*(?=[ \t]|$)|[ \t]*$)/gim, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .trim()
}

function versionTuple(text: string): Array<number> {
  const match = text.match(/\d+(?:\.\d+)*/)
  if (!match) return []
  return match[0]!.split(".").map((part) => Number.parseInt(part, 10))
}

function compareVersions(a: string, b: string): number {
  const va = versionTuple(a)
  const vb = versionTuple(b)
  for (let index = 0; index < Math.max(va.length, vb.length); index++) {
    const diff = (va[index] ?? 0) - (vb[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Ranked candidates for a case-insensitive fragment: exact > prefix > substring. */
function rankCandidates<T>(fragment: string, entries: Array<T>, namesOf: (entry: T) => Array<string>): Array<T> {
  const lowered = fragment.toLowerCase()
  const scored: Array<{ entry: T; score: number }> = []
  for (const entry of entries) {
    const names = namesOf(entry).map((name) => name.toLowerCase())
    if (names.some((name) => name === lowered)) scored.push({ entry, score: 0 })
    else if (names.some((name) => name.startsWith(lowered))) scored.push({ entry, score: 1 })
    else if (names.some((name) => name.includes(lowered))) scored.push({ entry, score: 2 })
  }
  scored.sort((a, b) => a.score - b.score)
  return scored.map((item) => item.entry)
}

/**
 * Read the entries out of an SDK list payload.
 *
 * The plugin client's list() methods answer with an ENVELOPE, not a bare
 * array: `ModelListOutput` / `AgentListOutput` = { location, data: [...] }
 * (verified against @opencode/client 2.0.29 — `session.get` is unwrapped, the
 * list calls are not). Feeding the envelope to the resolvers made
 * `Array.isArray(listed)` false at every call site, so the catalogue arrived
 * empty and each --model/--agent resolution silently kept the running model.
 * Accept both shapes: today's envelope, and a bare array if an adapter ever
 * unwraps it.
 */
function listEntries<T>(value: unknown): Array<T> {
  const data = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object"
      ? (value as { data?: unknown }).data
      : undefined
  if (!Array.isArray(data)) return []
  return data.filter((entry): entry is T => entry !== null && typeof entry === "object")
}

export function resolveModelFragment(
  fragment: string,
  models: Array<{ id?: unknown; name?: unknown; providerID?: unknown }>,
): { providerID: string; id: string } | undefined {
  const usable = models.filter(
    (entry): entry is { id: string; providerID: string; name?: unknown } =>
      typeof entry.id === "string" && typeof entry.providerID === "string",
  )
  // A provider-qualified fragment (`opencode/big-pickle`) — the form the model
  // picker and `opencode models` print — narrows the pool to that provider
  // first, so the qualifier is never compared against a bare id.
  const slash = fragment.indexOf("/")
  const providerHint = slash > 0 ? fragment.slice(0, slash).toLowerCase() : undefined
  const bare = providerHint === undefined ? fragment : fragment.slice(slash + 1)
  const pool = providerHint === undefined ? usable : usable.filter((entry) => entry.providerID.toLowerCase() === providerHint)
  if (pool.length === 0) return undefined
  const ranked = rankCandidates(bare, pool, (entry) => [entry.id, typeof entry.name === "string" ? entry.name : ""].filter(Boolean))
  if (ranked.length === 0) return undefined
  const best = ranked[0]!
  const tied = ranked.filter(
    (entry) => entry.id.toLowerCase() === best.id.toLowerCase() || entry.id.startsWith(best.id) || best.id.startsWith(entry.id),
  )
  let winner = best
  for (const entry of tied) {
    if (compareVersions(entry.id, winner.id) > 0) winner = entry
  }
  return { providerID: winner.providerID, id: winner.id }
}

export function resolveAgentFragment(
  fragment: string,
  agents: Array<{ name?: unknown }>,
): string | undefined {
  const usable = agents.filter((entry): entry is { name: string } => typeof entry.name === "string")
  const ranked = rankCandidates(fragment, usable, (entry) => [entry.name])
  return ranked[0]?.name
}

/**
 * Normalize a message body into the part array the renderer walks, or
 * undefined when there is nothing renderable.
 *
 * Three shapes occur in the wild (2026-10-18):
 *   - `{content: [{type:"text",…}]}` / `{parts: […]}` — structured
 *   - `{content: "text"}`                            — string body
 *   - `{text: "text"}`                               — flat; this is what the live
 *                                                      v2 session API actually returns
 * The previous strict `Array.isArray(parts) → continue` matched only the first,
 * so every real transcript rendered as a footer with no body at all.
 */
function normalizeParts(record: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const raw = record["content"] ?? record["parts"]
  if (typeof raw === "string") return raw.length > 0 ? [{ type: "text", text: raw }] : undefined
  if (Array.isArray(raw)) {
    const parts = raw.filter((part): part is Record<string, unknown> => part !== null && typeof part === "object")
    return parts.length > 0 ? parts : undefined
  }
  if (typeof record["text"] === "string" && record["text"].length > 0) {
    return [{ type: "text", text: record["text"] }]
  }
  return undefined
}

/**
 * Format a conversation transcript for display. Shape-tolerant (see
 * normalizeParts), applies `limit` for real, and reports what it could not
 * render instead of dropping messages silently.
 */
function formatTranscript(messages: ReadonlyArray<unknown> | undefined, limit: number, offset = 0): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "Session has no messages or does not exist."
  }

  // `offset` counts messages back from the NEWEST (0 = tail). Without it a
  // fresh session could only ever read the end of a long transcript, which is
  // backwards when the work happened early (2026-10-18).
  const total = messages.length
  const off = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  // An offset past the start clamps to the OLDEST `limit` messages rather than
  // silently returning nothing.
  const start = off >= total ? 0 : Math.max(0, total - off - limit)
  const end = off >= total ? Math.min(total, limit) : total - off
  const shown = messages.slice(start, end)

  const lines: Array<string> = []
  let unreadable = 0

  for (const message of shown) {
    if (message === null || typeof message !== "object") {
      unreadable++
      continue
    }
    const record = message as Record<string, unknown>
    const role = record["role"] ?? (record["info"] as Record<string, unknown> | undefined)?.["role"]
    const parts = normalizeParts(record)
    if (parts === undefined) {
      unreadable++
      continue
    }

    if (role === "user") {
      lines.push("## User")
      for (const part of parts) {
        if (part === null || typeof part !== "object") continue
        const p = part as Record<string, unknown>
        if (p["type"] === "text" && typeof p["text"] === "string" && !p["ignored"]) lines.push(p["text"])
        if (p["type"] === "file") lines.push(`[Attached: ${(p["filename"] as string | undefined) ?? "file"}]`)
      }
      lines.push("")
    }

    if (role === "assistant") {
      lines.push("## Assistant")
      for (const part of parts) {
        if (part === null || typeof part !== "object") continue
        const p = part as Record<string, unknown>
        if (p["type"] === "text" && typeof p["text"] === "string") lines.push(p["text"])
        if (p["type"] === "tool") {
          const state = p["state"] as Record<string, unknown> | undefined
          if (state?.["status"] === "completed") lines.push(`[Tool: ${String(p["tool"])}] ${String(state["title"] ?? "")}`)
        }
      }
      lines.push("")
    }
  }

  const output = lines.join("\n").trim()
  const notes: Array<string> = []
  if (unreadable > 0) {
    notes.push(`(${unreadable} message(s) could not be rendered — unrecognized shape.)`)
  }
  const footer =
    off > 0
      ? start > 0
        ? `(Showing ${shown.length} messages at offset ${off} of ${messages.length} — older messages remain. Lower 'offset' to page further back.)`
        : `(Showing ${shown.length} messages at offset ${off} — start of history (${messages.length} total).)`
      : shown.length < messages.length
        ? `(Showing ${shown.length} of ${messages.length} most recent messages. Use a higher 'limit' to see more.)`
        : `(End of session - ${messages.length} messages)`
  return [output, ...notes, footer].filter((part) => part.length > 0).join("\n\n")
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
} as const

export const readSessionInputSchema = {
  type: "object",
  properties: {
    sessionID: { ...STRING_SCHEMA, description: "The full session ID (e.g., ses_xxxxxxxxxxxxxxxx)" },
    limit: { type: "number", description: "Maximum number of messages to read (defaults to 100, max 500)" },
    offset: {
      type: "number",
      description:
        "Messages to skip back from the NEWEST before reading (0 = default, reads the tail). Raise it to page toward the START of a long session — e.g. offset:100 reads the 100-to-125-newest window. Clamps at the start of history rather than returning nothing.",
    },
  },
  required: ["sessionID"],
} as const

/**
 * Create the handoff_session tool: builds the full prompt (session
 * reference + findings + file sections + model prompt), creates a new
 * session, and posts it there.
 */
export function makeHandoffSession(ctx: Context) {
  return {
    name: "handoff_session",
    description: "Create a new session carrying the handoff prompt, findings, and file context",
    input: handoffSessionInputSchema,
    execute: async (input: HandoffSessionInput, context: { sessionID: string }) => {
      const prompt = typeof input.prompt === "string" ? input.prompt : ""
      const files = asStringArray(input.files).map((file) => file.replace(/^@/, ""))
      const directory = ctx.location.directory
      const quick = input.mode === "quick"
      const explicitFindings = typeof input.findings === "string" && input.findings.length > 0 ? input.findings : undefined

      // Model/agent for the new session: explicit --model/--agent flags win,
      // otherwise inherit the current session. Every step degrades to
      // omit-and-continue — a failed resolution must never fail the handoff.
      const modelFragment = parseSelectionFlag(prompt, "model")
      const agentFragment = parseSelectionFlag(prompt, "agent")
      let currentAgent: string | undefined
      let currentModel: { providerID: string; id: string } | undefined
      try {
        const info = (await ctx.session.get({ sessionID: context.sessionID })) as unknown as {
          agent?: unknown
          model?: { providerID?: unknown; id?: unknown }
        }
        if (typeof info?.agent === "string") currentAgent = info.agent
        if (typeof info?.model?.providerID === "string" && typeof info?.model?.id === "string") {
          currentModel = { providerID: info.model.providerID, id: info.model.id }
        }
      } catch {
        // Current pair unreadable — explicit flags can still resolve.
      }
      let model: { providerID: string; id: string } | undefined = currentModel
      let modelSource = currentModel ? "inherited" : "default"
      let agent: string | undefined = currentAgent
      let agentSource = currentAgent ? "inherited" : "default"
      if (modelFragment) {
        try {
          const listed = listEntries<{ id?: unknown; name?: unknown; providerID?: unknown }>(await ctx.model.list())
          const resolved = resolveModelFragment(modelFragment, listed)
          if (resolved) {
            model = resolved
            modelSource = `matched --model ${modelFragment}`
          } else {
            modelSource = `--model ${modelFragment} matched nothing, kept ${currentModel ? "current" : "default"}`
          }
        } catch {
          modelSource = `model list unreadable, kept ${currentModel ? "current" : "default"}`
        }
      }
      if (agentFragment) {
        try {
          const agentDomain = (ctx as unknown as { agent?: { list?: () => unknown } }).agent
          const listed = typeof agentDomain?.list === "function" ? await agentDomain.list() : undefined
          const resolved = resolveAgentFragment(agentFragment, listEntries<{ name?: unknown }>(listed))
          if (resolved) {
            agent = resolved
            agentSource = `matched --agent ${agentFragment}`
          } else {
            agentSource = `--agent ${agentFragment} matched nothing, kept ${currentAgent ? "current" : "default"}`
          }
        } catch {
          agentSource = `agent list unreadable, kept ${currentAgent ? "current" : "default"}`
        }
      }
      const postedGoal = stripSelectionFlags(prompt)

      const sessionReference =
        `Continuing work from session ${context.sessionID}. When you lack specific information you can use read_session to get it. ` +
        `Confirm direction before acting on anything destructive.`

      const refs = new Set<string>(files)
      for (const ref of parseFileReferences(postedGoal)) refs.add(ref)

      const fileSections = quick ? [] : await buildFileSections(directory, refs)
      const namedFiles = quick && refs.size > 0 ? [...refs].map((ref) => `- ${ref}`) : []

      let findingsRef = explicitFindings
      if (findingsRef === undefined) {
        findingsRef = await resolveSessionFindings(
          (await ctx.session.context({ sessionID: context.sessionID })) as ReadonlyArray<unknown> | undefined,
        )
      }
      const findingsSections: Array<string> = []
      const findingsNamedOnly: Array<string> = []
      let findingsCount = 0
      if (findingsRef !== undefined) {
        findingsCount = 1
        try {
          const stats = await fs.stat(findingsRef)
          if (stats.size > FINDINGS_INLINE_BYTES) {
            findingsNamedOnly.push(`- ${findingsRef} (too large to inline — read directly)`)
          } else {
            const content = await fs.readFile(findingsRef, "utf-8")
            findingsSections.push(`### ${findingsRef}\n\n\`\`\`\n${content}\n\`\`\``)
          }
        } catch {
          findingsNamedOnly.push(`- ${findingsRef} (listed in session but unreadable — read directly)`)
        }
      }

      const workingTree = quick ? undefined : await collectWorkingTree(directory)

      const blocks: Array<string> = [sessionReference]
      blocks.push(postedGoal)
      if (findingsSections.length > 0) {
        blocks.push(`## Session findings (${FINDINGS_ROOT})`, ...findingsSections)
      }
      if (findingsNamedOnly.length > 0) {
        blocks.push("## Large findings files (name only)", ...findingsNamedOnly)
      }
      if (workingTree !== undefined) {
        blocks.push(workingTree)
      }
      if (fileSections.length > 0) {
        blocks.push("## Referenced files", ...fileSections)
      }
      if (quick && namedFiles.length > 0) {
        blocks.push("## Named files (content omitted in quick mode — read directly)", ...namedFiles)
      }

      // Budget: summary and reference line are untouchable; trim the
      // largest droppable sections first (files, then findings), largest
      // section per pass, until under budget.
      const droppable: Array<Array<string>> = [fileSections, findingsSections]
      let fullPrompt = blocks.join("\n\n")
      while (Buffer.byteLength(fullPrompt, "utf8") > HANDOFF_BUDGET_BYTES) {
        let biggest: Array<string> | undefined
        for (const group of droppable) {
          if (group.length === 0) continue
          if (biggest === undefined || group.join("\n").length > biggest.join("\n").length) biggest = group
        }
        if (biggest === undefined) break
        let longestIndex = 0
        for (let index = 1; index < biggest.length; index++) {
          if (biggest[index]!.length > biggest[longestIndex]!.length) longestIndex = index
        }
        biggest.splice(longestIndex, 1)
        fullPrompt = [
          sessionReference,
          postedGoal,
          ...(findingsSections.length > 0 ? [`## Session findings (${FINDINGS_ROOT})`, ...findingsSections] : []),
          ...(findingsNamedOnly.length > 0 ? ["## Large findings files (name only)", ...findingsNamedOnly] : []),
          ...(workingTree !== undefined ? [workingTree] : []),
          ...(fileSections.length > 0 ? ["## Referenced files", ...fileSections] : []),
          ...(quick && namedFiles.length > 0 ? ["## Named files (content omitted in quick mode — read directly)", ...namedFiles] : []),
        ].join("\n\n")
      }

      const created = await ctx.session.create({
        ...(agent !== undefined ? { agent } : {}),
        ...(model !== undefined ? { model } : {}),
      } as never)
      const sessionID = (created as { id?: unknown }).id
      if (typeof sessionID !== "string" || sessionID.length === 0) {
        return { content: "Handoff failed: session.create returned no session id." }
      }
      // The create-time pair is honored by the current API, but adapters
      // may drop fields they do not know — verify and repair with the
      // dedicated switches (proven independent: neither resets the other).
      try {
        const fresh = (await ctx.session.get({ sessionID })) as unknown as {
          agent?: unknown
          model?: { providerID?: unknown; id?: unknown }
        }
        if (agent !== undefined && fresh?.agent !== agent) {
          await ctx.session.switchAgent({ sessionID, agent } as never)
        }
        if (
          model !== undefined &&
          (fresh?.model?.providerID !== model.providerID || fresh?.model?.id !== model.id)
        ) {
          await ctx.session.switchModel({ sessionID, model } as never)
        }
      } catch {
        // Verification is best-effort; the posted prompt is the handoff.
      }
      await ctx.session.prompt({ sessionID, text: fullPrompt } as never)

      const modelNote = model ? `${model.providerID}/${model.id} (${modelSource})` : "server default"
      const agentNote = agent ? `${agent} (${agentSource})` : "server default"
      return {
        content:
          `Handoff posted to new session ${sessionID} ` +
          `(${files.length} file(s)` + (findingsCount > 0 ? `, session findings attached` : `, no findings listed in session`) + `, ` +
          `model ${modelNote}, agent ${agentNote}). ` +
          `Continue there; this session is unchanged.`,
      }
    },
  }
}

/**
 * Create the read_session tool: returns the transcript of a previous
 * session via ctx.session.context.
 */
export function makeReadSession(ctx: Context) {
  return {
    name: "read_session",
    description:
      "Read the conversation transcript from a previous session. Use this when you need specific information from the source session that wasn't included in the handoff summary.",
    input: readSessionInputSchema,
    execute: async (input: ReadSessionInput) => {
      if (typeof input.sessionID !== "string" || input.sessionID.length === 0) {
        return { content: "read_session requires a sessionID string." }
      }
      const limit = Math.max(1, Math.min(typeof input.limit === "number" ? input.limit : 100, 500))
      const offset = typeof input.offset === "number" && Number.isFinite(input.offset) ? input.offset : 0

      try {
        const messages = (await ctx.session.context({ sessionID: input.sessionID })) as ReadonlyArray<unknown> | undefined
        return { content: formatTranscript(messages, limit, offset) }
      } catch (error) {
        return {
          content: `Could not read session ${input.sessionID}: ${error instanceof Error ? error.message : "Unknown error"}`,
        }
      }
    },
  }
}
