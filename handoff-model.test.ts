import { describe, expect, test } from "bun:test"

// Regression: --model / --agent never matched anything, so every handoff
// silently kept the running model. Root cause: ctx.model.list() and
// ctx.agent.list() return an ENVELOPE, not an array, but the call site did
// `Array.isArray(listed) ? listed : []`, so the catalogue was always empty.
//
// Production symptom (session ses_eaf2fe1f6ffemxjM5OL3kybdTx, seq=345):
//   "model opencode/beam-free (--model pickle matched nothing, kept current)"
// even though "pickle" is a substring of opencode/big-pickle.
//
// SDK shape (@opencode/client .../generated/types.d.ts):
//   ModelListOutput = { location: LocationPublicRef; data: Array<ModelInfo> }
//   AgentListOutput = { location: LocationPublicRef; data: Array<AgentInfo> }
//
// Targets src by default; run against the built artifact with
// HANDOFF_TARGET=./dist/tools.js (the runtime loads src/index.ts -> src/*.ts,
// so both must agree).

const target = process.env.HANDOFF_TARGET ?? "./src/tools"
const { makeHandoffSession } = await import(target)

/** Mirrors the live catalogue: providerID + bare id + human name. */
const CATALOG = [
	{ providerID: "llama-server", id: "big-model", name: "Big Model" },
	{ providerID: "llama-server", id: "big-model-edl3", name: "Big Model EXL3" },
	{ providerID: "llama-server", id: "small-model", name: "Small Model" },
	{ providerID: "opencode", id: "big-pickle", name: "Big Pickle" },
	{ providerID: "opencode", id: "beam-free", name: "Beam Free" },
]

const LOCATION = { directory: "/tmp" }

/** A ctx that answers list() with the real envelope shape. */
function ctxWithEnvelopes(created: Array<Record<string, unknown>>) {
	return {
		location: LOCATION,
		model: { list: async () => ({ location: LOCATION, data: CATALOG }) },
		agent: { list: async () => ({ location: LOCATION, data: [{ name: "build" }, { name: "worker" }] }) },
		session: {
			get: async () => ({ agent: "build", model: { providerID: "opencode", id: "beam-free" } }),
			context: async () => [],
			create: async (args: Record<string, unknown>) => {
				created.push(args)
				return { id: "ses_new" }
			},
			prompt: async () => undefined,
			switchModel: async () => undefined,
			switchAgent: async () => undefined,
		},
	}
}

async function run(prompt: string) {
	const created: Array<Record<string, unknown>> = []
	const tool = makeHandoffSession(ctxWithEnvelopes(created) as never)
	await tool.execute({ prompt, mode: "quick" } as never, { sessionID: "ses_src" })
	return created[0]
}

describe("handoff --model resolution against the real catalogue shape", () => {
	test("substring fragment resolves instead of keeping the running model", async () => {
		const args = await run("continue the port --model pickle")
		expect(args?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
	})

	test("display name containing a space resolves", async () => {
		const args = await run('continue the port --model "Big Pickle"')
		expect(args?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
	})

	test("provider-qualified fragment resolves", async () => {
		const args = await run("continue the port --model opencode/big-pickle")
		expect(args?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
	})

	test("--agent resolves against its envelope too", async () => {
		const args = await run("continue the port --agent worker")
		expect(args?.agent).toBe("worker")
	})

	test("no flag still inherits the running model", async () => {
		const args = await run("continue the port")
		expect(args?.model).toEqual({ providerID: "opencode", id: "beam-free" })
	})
})

/** Like run(), but also captures the text handed to session.prompt(). */
async function runFull(prompt: string) {
	const created: Array<Record<string, unknown>> = []
	const prompts: Array<Record<string, unknown>> = []
	const base = ctxWithEnvelopes(created) as Record<string, unknown>
	const session = base.session as Record<string, unknown>
	session.prompt = async (args: Record<string, unknown>) => {
		prompts.push(args)
		return undefined
	}
	const tool = makeHandoffSession(base as never)
	await tool.execute({ prompt, mode: "quick" } as never, { sessionID: "ses_src" })
	return { created: created[0], text: String(prompts.at(-1)?.text ?? "") }
}

// --model / --agent values can contain spaces and the generated handoff prompt
// puts them last on a line ("... --model Big Pickle"). The flag regex used to
// take ONE token, so `Big Pickle` became `Big` -- which then resolved to a real
// but wrong model (llama-server/big-model) or nothing at all. Take the rest of
// the line instead, and stop at a following --flag.
describe("multi-word --model values", () => {
	test("unquoted two-word display name resolves to the right model", async () => {
		const args = await run("continue the port --model Big Pickle")
		expect(args?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
	})

	test("a following --agent does not swallow the model value", async () => {
		const args = await run("continue the port --model Big Pickle --agent worker")
		expect(args?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
		expect(args?.agent).toBe("worker")
	})

	test("multi-word value still discriminates (trailing EDIT: EXL3)", async () => {
		const args = await run("continue the port --model Big Model EXL3")
		expect(args?.model).toEqual({ providerID: "llama-server", id: "big-model-edl3" })
	})

	test("the flag and its whole value are stripped from the new session prompt", async () => {
		const { text } = await runFull("continue the port --model Big Pickle")
		expect(text).toContain("continue the port")
		expect(text).not.toContain("--model")
		expect(text).not.toContain("Pickle")
	})

	test("a newline terminates the value", async () => {
		const { created, text } = await runFull("continue the port\n--model pickle\nkeep going")
		expect(created?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
		expect(text).toContain("keep going")
		expect(text).not.toContain("--model")
	})
})
