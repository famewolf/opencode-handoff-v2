import { describe, expect, test } from "bun:test"

// Targets the source by default. Set HANDOFF_TARGET=./dist/tools.js to run the
// identical suite against the artifact the runtime actually loads — a src-only
// fix is worthless here because opencode.jsonc resolves the package to
// dist/index.js.
const target = process.env.HANDOFF_TARGET ?? "./src/tools"
const { makeReadSession } = await import(target)

// Diagnostics for `read_session` returning only a footer with no body.
//
// Production symptom (2026-10-18): read_session on ses_eb0e6fb (83 messages,
// verified to contain substantial text) returned
//   "\n(Showing 83 most recent messages. Use a higher 'limit' to see more.)"
// and nothing above it. ses_eb02e2c8 (7 messages) likewise.
//
// formatTranscript reads `record["content"] ?? record["parts"]` and does
// `if (!Array.isArray(parts)) continue` — so any message whose body is not an
// array of parts is dropped silently, and the footer is still printed.
//
// These tests pin which shapes survive. Shapes marked EXPECT-FAIL are the bug.

/** Build a read_session tool backed by a ctx that returns `messages`. */
function toolFor(messages: unknown[]) {
	const ctx = {
		session: {
			context: async () => messages,
		},
	}
	return makeReadSession(ctx as never)
}

async function render(messages: unknown[], opts?: number | { limit?: number; offset?: number }) {
	const tool = toolFor(messages)
	// A bare number is limit (older call sites); an object passes any input shape.
	const extra = typeof opts === "number" ? { limit: opts } : (opts ?? {})
	const res = (await tool.execute({ sessionID: "ses_test", ...extra }, { sessionID: "ses_test" })) as {
		content: string
	}
	return res.content
}

/** Count rendered message blocks ("## User" / "## Assistant" headers). */
const blocks = (out: string) => (out.match(/^## (User|Assistant)$/gm) ?? []).length

// ---------------------------------------------------------------------------
// Shapes the formatter claims to support. These are the controls.
// ---------------------------------------------------------------------------

describe("read_session — supported shapes (controls)", () => {
	test("content: array of text parts renders", async () => {
		const out = await render([
			{ role: "user", content: [{ type: "text", text: "hello from the user" }] },
		])
		expect(out).toContain("hello from the user")
	})

	test("info.role + parts array renders", async () => {
		const out = await render([
			{ info: { role: "assistant" }, parts: [{ type: "text", text: "reply text" }] },
		])
		expect(out).toContain("reply text")
	})

	test("completed tool parts render as a marker", async () => {
		const out = await render([
			{
				role: "assistant",
				content: [
					{ type: "tool", tool: "read", state: { status: "completed", title: "read tools.ts" } },
				],
			},
		])
		expect(out).toContain("[Tool: read] read tools.ts")
	})
})

// ---------------------------------------------------------------------------
// Shapes actually observed in production. EXPECT-FAIL — these are the defect.
// ---------------------------------------------------------------------------

describe("read_session — real observed shape (EXPECT FAIL)", () => {
	// Exact shape returned by the v2 session-messages API on 2026-10-18 for
	// ses_eb02e2c8 and ses_eb0e6fb: flat `text` string, no content/parts array.
	test("flat {role, text} renders its text", async () => {
		const out = await render([
			{ id: "msg_1", role: "user", createdAt: 1, completedAt: null, model: null, text: "run the job" },
			{ id: "msg_2", role: "assistant", createdAt: 2, completedAt: 3, model: "llama-server/coder", text: "I'll read the prompt file first." },
		])
		expect(blocks(out)).toBe(2)
		expect(out).toContain("run the job")
		expect(out).toContain("I'll read the prompt file first.")
	})

	test("content as a plain string renders", async () => {
		const out = await render([{ role: "user", content: "string body, not an array" }])
		expect(out).toContain("string body, not an array")
	})

	test("a flat assistant message renders alongside a structured one", async () => {
		const out = await render([
			{ role: "user", content: [{ type: "text", text: "rendered" }] },
			{ role: "assistant", text: "flat shape" },
		])
		expect(blocks(out)).toBe(2)
		expect(out).toContain("flat shape")
	})

	test("a message with no recognizable body is reported, not silently dropped", async () => {
		const out = await render([
			{ role: "user", content: [{ type: "text", text: "rendered" }] },
			{ role: "assistant", parts: [] },
		])
		expect(out).toContain("rendered")
		// The caller must be able to tell the transcript is incomplete.
		expect(out).toMatch(/could not be rendered/)
	})
})

// ---------------------------------------------------------------------------
// limit is supposed to bound what lands in the new session's context.
// ---------------------------------------------------------------------------

describe("read_session — limit paging", () => {
	test("limit: 2 renders only the 2 most recent messages", async () => {
		const messages = Array.from({ length: 6 }, (_, i) => ({
			role: "user",
			content: [{ type: "text", text: `message ${i}` }],
		}))
		const out = await render(messages, 2)
		expect(blocks(out)).toBe(2)
		expect(out).toContain("message 5")
		expect(out).not.toContain("message 0")
	})

	test("footer counts what was shown, not what was fetched", async () => {
		const messages = Array.from({ length: 6 }, (_, i) => ({
			role: "user",
			content: [{ type: "text", text: `message ${i}` }],
		}))
		const out = await render(messages, 2)
		// Today the footer prints `messages.length` (6) while rendering all 6,
		// which is why a limit:12 read of an 83-message session claimed to be
		// showing "83 most recent messages".
		expect(out).not.toContain("Showing 6 most recent messages")
	})
})

// Offset paging (2026-10-18): `limit` bounds the tail, but a fresh session
// cannot reach the START of a long transcript — which is exactly what the
// handoff plan needs when the work happened early in a long session.
// `offset` counts messages back from the newest; 0 = newest.
describe("read_session — offset paging (EXPECT FAIL)", () => {
	const six = () =>
		Array.from({ length: 6 }, (_, i) => ({
			role: "user",
			content: [{ type: "text", text: `message ${i}` }],
		}))

	test("offset: 4 reaches the oldest messages", async () => {
		const out = await render(six(), { limit: 2, offset: 4 })
		expect(out).toContain("message 0")
		expect(out).toContain("message 1")
		expect(out).not.toContain("message 5")
	})

	test("offset: 0 is identical to no offset", async () => {
		const withOffset = await render(six(), { limit: 2, offset: 0 })
		const without = await render(six(), { limit: 2 })
		expect(withOffset).toBe(without)
	})

	test("offset past the start clamps instead of returning nothing", async () => {
		const out = await render(six(), { limit: 2, offset: 999 })
		expect(blocks(out)).toBe(2)
		expect(out).toContain("message 0")
		expect(out).not.toContain("undefined")
	})

	test("the footer says the slice is offset, so paging is discoverable", async () => {
		const out = await render(six(), { limit: 2, offset: 2 })
		expect(out).toMatch(/offset 2/)
	})
})