import { describe, expect, test } from "bun:test"

// The /handoff command renders the user's GOAL into a template and asks the
// MODEL to write the handoff message. The --model/--agent flags used to
// travel only inside that model-authored prompt, so a rewrite that dropped
// them silently downgraded the handoff to "inherit the current model" --
// with no error, because "no flag" and "flag dropped" are the same thing.
//
// Production symptom (session ses_ea3aaf791ffeQnLj7FZ1bbJzHk, seq=9707):
//   goal   : "Fix the Tapo config file so camera display. ... --model pickle"
//   prompt : the model's handoff message -- no "--model", no "pickle"
//   result : the new session would have run on the CURRENT model, silently.
//
// The flags must be captured from the goal (the user's own words) with no LLM
// in the loop, and applied to the new session from there.
//
// Targets src by default; run against the built artifact with
// HANDOFF_TARGET=./dist/tools.js (the runtime loads src/index.ts -> src/*.ts,
// so both must agree).

const base = process.env.HANDOFF_TARGET ?? "./src/tools"
const { makeHandoffSession } = await import(base)
const { HandoffV2Plugin } = await import(base.replace(/tools$/, "plugin"))
const { clearGoalCache } = await import(base.replace(/tools$/, "selection"))

/** Mirrors the live catalogue: providerID + bare id + human name. */
const CATALOG = [
	{ providerID: "llama-server", id: "big-model", name: "Big Model" },
	{ providerID: "llama-server", id: "big-model-edl3", name: "Big Model EXL3" },
	{ providerID: "llama-server", id: "small-model", name: "Small Model" },
	{ providerID: "opencode", id: "big-pickle", name: "Big Pickle" },
	{ providerID: "opencode", id: "beam-free", name: "Beam Free" },
]

const LOCATION = { directory: "/tmp" }

type Created = Record<string, unknown>
type Command = { name: string; execute: (args: unknown) => Promise<unknown> }

/** Both message shapes the runtime may hand back for a session message. */
function message(shape: "v2" | "v1", text: string) {
	return shape === "v2" ? { role: "user", content: [{ type: "text", text }] } : { role: "user", parts: [{ type: "text", text }] }
}

function makeHarness(options: { shape?: "v2" | "v1" } = {}) {
	const shape = options.shape ?? "v2"
	const created: Created[] = []
	const prompts: Array<Record<string, unknown>> = []
	const contextMessages: Array<Record<string, unknown>> = []
	const commands: Command[] = []
	const tools: Array<{ name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }> = []

	const ctx = {
		location: LOCATION,
		command: {
			transform: async (fn: (cmd: { add: (c: Command) => void }) => void) => {
				fn({ add: (c: Command) => commands.push(c) })
			},
		},
		tool: {
			transform: async (fn: (editor: { add: (t: (typeof tools)[number]) => void }) => void) => {
				fn({ add: (t: (typeof tools)[number]) => tools.push(t) })
			},
		},
		model: { list: async () => ({ location: LOCATION, data: CATALOG }) },
		agent: {
			list: async () => ({
				location: LOCATION,
				// Live shape: the server keys agents by id and carries a display
				// name beside it ("build" -> "Build"). A session created with
				// the display name raises AgentNotFoundError, so the id is what
				// the tool must send.
				data: [
					{ id: "build", name: "Build" },
					{ id: "worker", name: "worker" },
				],
			}),
		},
		session: {
			get: async () => ({ agent: "build", model: { providerID: "opencode", id: "beam-free" } }),
			context: async () => contextMessages,
			create: async (args: Created) => {
				created.push(args)
				return { id: "ses_new" }
			},
			prompt: async (args: Record<string, unknown>) => {
				prompts.push(args)
				// The command re-prompts the SAME session, so the rendered
				// template lands there as a user message.
				contextMessages.push(message(shape, String(args.text)))
				return undefined
			},
			switchModel: async () => undefined,
			switchAgent: async () => undefined,
		},
	}

	return { ctx, created, prompts, commands, tools, contextMessages }
}

/**
 * The full /handoff flow, minus the LLM: the command runs with the user's
 * goal, then the tool is called with a model-authored prompt.
 */
async function runHandoff(options: {
	goal: string
	prompt: string
	shape?: "v2" | "v1"
	toolInput?: Record<string, unknown>
	sessionID?: string
	between?: () => void
}) {
	const harness = makeHarness({ shape: options.shape })
	const plugin = HandoffV2Plugin as unknown as { setup: (ctx: unknown) => Promise<void> }
	await plugin.setup(harness.ctx)
	const command = harness.commands.find((c) => c.name === "handoff")
	if (!command) throw new Error("handoff command not registered")
	await command.execute({ sessionID: options.sessionID ?? "ses_flow", prompt: { text: options.goal }, delivery: "default" })
	options.between?.()
	const tool = harness.tools.find((t) => t.name === "handoff_session")
	if (!tool) throw new Error("handoff_session tool not registered")
	const result = await tool.execute(
		{ prompt: options.prompt, mode: "quick", ...(options.toolInput ?? {}) },
		{ sessionID: options.sessionID ?? "ses_flow" },
	)
	return { created: harness.created[0], text: String(harness.prompts.at(-1)?.text ?? ""), result }
}

describe("--model/--agent survive the model's rewrite of the handoff prompt", () => {
	test("the goal's --model is applied even when the prompt omits it", async () => {
		const { created } = await runHandoff({
			goal: "Fix the Tapo config file so camera display. --model pickle",
			prompt: "Fix Tapo camera display in Home Assistant - camera entities not showing images.",
		})
		expect(created?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
	})

	test("the goal's --agent is applied even when the prompt omits it", async () => {
		const { created } = await runHandoff({
			goal: "continue the port --agent worker",
			prompt: "continue the port",
		})
		expect(created?.agent).toBe("worker")
	})

	test("a multi-word --model in the goal still resolves exactly", async () => {
		const { created } = await runHandoff({
			goal: "continue the port --model Big Model EXL3",
			prompt: "continue the port",
		})
		expect(created?.model).toEqual({ providerID: "llama-server", id: "big-model-edl3" })
	})

	test("the goal's flags win over a model-authored flag in the prompt", async () => {
		const { created } = await runHandoff({
			goal: "continue the port --model pickle",
			prompt: "continue the port --model beam",
		})
		expect(created?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
	})

	test("the goal's flags are found in a v1-shaped session message too", async () => {
		const { created } = await runHandoff({
			goal: "continue the port --model pickle",
			prompt: "continue the port",
			shape: "v1",
			between: () => clearGoalCache(),
		})
		expect(created?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
	})

	test("the goal's --model survives a restart between the command and the tool", async () => {
		const { created } = await runHandoff({
			goal: "continue the port --model pickle",
			prompt: "continue the port",
			sessionID: "ses_restart",
			between: () => clearGoalCache(),
		})
		expect(created?.model).toEqual({ providerID: "opencode", id: "big-pickle" })
	})

	test("without any flag the new session still inherits the running model", async () => {
		const { created } = await runHandoff({ goal: "continue the port", prompt: "continue the port" })
		expect(created?.model).toEqual({ providerID: "opencode", id: "beam-free" })
		expect(created?.agent).toBe("build")
	})

	test("an agent display name resolves to the agent's id", async () => {
		const { created } = await runHandoff({
			goal: "continue the port --agent Build",
			prompt: "continue the port",
		})
		expect(created?.agent).toBe("build")
	})

	test("an agent id resolves to itself, not to a display name", async () => {
		const { created } = await runHandoff({
			goal: "continue the port --agent build",
			prompt: "continue the port",
		})
		expect(created?.agent).toBe("build")
	})

	test("an agent the catalogue does not know keeps the running agent", async () => {
		const { created } = await runHandoff({
			goal: "continue the port --agent nope-xyz",
			prompt: "continue the port",
		})
		expect(created?.agent).toBe("build")
	})

	test("the result says where the model came from", async () => {
		const { result } = await runHandoff({
			goal: "continue the port --model pickle",
			prompt: "continue the port",
		})
		const content = String((result as { content?: unknown })?.content ?? "")
		expect(content).toContain("big-pickle")
		expect(content).toContain("pickle")
	})
})

describe("explicit tool arguments", () => {
	test("an explicit model argument is honoured when the goal carries no flag", async () => {
		const { created } = await runHandoff({
			goal: "continue the port",
			prompt: "continue the port",
			toolInput: { model: "llama-server/small-model" },
		})
		expect(created?.model).toEqual({ providerID: "llama-server", id: "small-model" })
	})

	test("the tool schema accepts model and agent", async () => {
		const harness = makeHarness()
		const tool = makeHandoffSession(harness.ctx as never)
		const properties = (tool.input as { properties?: Record<string, unknown> }).properties ?? {}
		expect(Object.keys(properties)).toContain("model")
		expect(Object.keys(properties)).toContain("agent")
	})
})

describe("the /handoff template", () => {
	async function template(): Promise<string> {
		const harness = makeHarness()
		const plugin = HandoffV2Plugin as unknown as { setup: (ctx: unknown) => Promise<void> }
		await plugin.setup(harness.ctx)
		const command = harness.commands.find((c) => c.name === "handoff")
		if (!command) throw new Error("handoff command not registered")
		await command.execute({ sessionID: "ses_tpl", prompt: { text: "some goal" }, delivery: "default" })
		return String(harness.prompts.at(-1)?.text ?? "")
	}

	test("tells the model to call the tool through Code Mode, not directly", async () => {
		const text = await template()
		expect(text).toContain("tools.handoff_session")
		expect(text).toContain("execute")
	})

	test("does not instruct a direct top-level handoff_session(...) call", async () => {
		const text = await template()
		expect(text).not.toMatch(/^`handoff_session\(/m)
	})

	test("states that the tool reads the flags from the goal itself", async () => {
		const text = await template()
		expect(text).toMatch(/goal/i)
		expect(text).toMatch(/--model/)
	})

	test("has no duplicated instructions section", async () => {
		const text = await template()
		const occurrences = text.split("Name the session findings file").length - 1
		expect(occurrences).toBe(1)
	})
})
