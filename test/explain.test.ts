import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { explainCommand, type ExplainModelRegistry } from "../src/explain";

function makeModel(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.invalid",
		input: ["text"],
		cost: { currency: "USD", input: 0, output: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 4_096,
	} as unknown as Model<Api>;
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

interface StreamCall {
	model: Model<Api>;
	context: Context;
	options: {
		signal: AbortSignal;
		cacheRetention: string;
		sessionId: string;
		maxTokens: number;
		reasoning: string;
	};
}

type CompleteResult =
	| { throwWith: unknown }
	| { respond: AssistantMessage };

/** Registry stub that scripts one `CompleteResult` per candidate, in order. */
function fakeRegistry(results: CompleteResult[]) {
	const calls: StreamCall[] = [];
	const registry: ExplainModelRegistry = {
		streamSimple: (model, context, options) => {
			calls.push({ model, context, options });
			const result = results[calls.length - 1];
			return {
				result: async () => {
					if (!result) {
						throw new Error("unexpected extra streamSimple() call");
					}
					if ("throwWith" in result) {
						throw result.throwWith ?? new Error("request failed");
					}
					return result.respond;
				},
			};
		},
	};
	return { registry, calls };
}

const m1 = makeModel("a", "one");
const m2 = makeModel("b", "two");
const m3 = makeModel("c", "three");

const COMMAND = "git push --force";
const REASON = "Git force push";

describe("explainCommand", () => {
	it("extracts a concise explanation from a valid response", async () => {
		const { registry, calls } = fakeRegistry([
			{ respond: assistantMessage("  Fuerza el envío de commits al remoto.  ") },
		]);

		const result = await explainCommand(
			COMMAND,
			REASON,
			[m1],
			registry,
			new AbortController().signal,
		);

		expect(result).toBe("Fuerza el envío de commits al remoto.");
		expect(calls).toHaveLength(1);
	});

	it("caps the request at 128 output tokens and disables reasoning", async () => {
		const { registry, calls } = fakeRegistry([
			{ respond: assistantMessage("Explanation.") },
		]);

		await explainCommand(COMMAND, REASON, [m1], registry, new AbortController().signal);

		expect(calls[0]!.options.maxTokens).toBe(128);
		expect(calls[0]!.options.reasoning).toBe("off");
	});

	it("instructs the model in English to reply in the requested language", async () => {
		const { registry, calls } = fakeRegistry([
			{ respond: assistantMessage("Explanation.") },
			{ respond: assistantMessage("Explicación.") },
		]);

		await explainCommand(COMMAND, REASON, [m1], registry, new AbortController().signal);
		await explainCommand(COMMAND, REASON, [m1], registry, new AbortController().signal, "Spanish");

		expect(calls[0]!.context.systemPrompt).toContain(
			"Reply with a single plain-text line in English",
		);
		expect(calls[1]!.context.systemPrompt).toContain(
			"Reply with a single plain-text line in Spanish",
		);
	});

	it("collapses a multiline response to a single line", async () => {
		const { registry } = fakeRegistry([
			{ respond: assistantMessage("Fuerza el envío\nde commits\n\n  al remoto.") },
		]);

		const result = await explainCommand(
			COMMAND,
			REASON,
			[m1],
			registry,
			new AbortController().signal,
		);

		expect(result).toBe("Fuerza el envío de commits al remoto.");
	});

	it("sends only the command and flagged reason — no session history", async () => {
		const { registry, calls } = fakeRegistry([
			{ respond: assistantMessage("Explicación.") },
		]);

		await explainCommand(COMMAND, REASON, [m1], registry, new AbortController().signal);

		const { context } = calls[0]!;
		expect(context.systemPrompt).toBeTruthy();
		expect(context.messages).toHaveLength(1);
		const message = context.messages[0]!;
		expect(message.role).toBe("user");
		const text = (message.content as { type: string; text: string }[])
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain(COMMAND);
		expect(text).toContain(REASON);
		expect(context.messages.every((m) => m.role === "user")).toBe(true);
	});

	it("advances through candidates in order on throw, error stop reason, and empty output", async () => {
		const { registry, calls } = fakeRegistry([
			{ throwWith: new Error("network down") },
			{ respond: assistantMessage("boom", "error") },
			{ respond: assistantMessage("") },
			{ respond: assistantMessage("   \n  ") },
			{ respond: assistantMessage("Borra el historial remoto del repositorio.") },
		]);

		const result = await explainCommand(
			COMMAND,
			REASON,
			[m1, m2, m3, m1, m2],
			registry,
			new AbortController().signal,
		);

		expect(result).toBe("Borra el historial remoto del repositorio.");
		expect(calls.map((call) => call.model)).toEqual([m1, m2, m3, m1, m2]);
		expect(calls.every((call) => call.options.cacheRetention === "none")).toBe(true);
		expect(new Set(calls.map((call) => call.options.sessionId)).size).toBe(5);
	});

	it("passes the caller's signal to each request", async () => {
		const controller = new AbortController();
		const { registry, calls } = fakeRegistry([
			{ respond: assistantMessage("Explicación.") },
		]);

		await explainCommand(COMMAND, REASON, [m1], registry, controller.signal);

		expect(calls[0]!.options.signal).toBe(controller.signal);
	});

	it("returns undefined after every candidate fails", async () => {
		const { registry, calls } = fakeRegistry([
			{ throwWith: new Error("one") },
			{ respond: assistantMessage("", "error") },
			{ respond: assistantMessage("") },
		]);

		const result = await explainCommand(
			COMMAND,
			REASON,
			[m1, m2, m3],
			registry,
			new AbortController().signal,
		);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(3);
	});

	it("returns undefined without any request when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { registry, calls } = fakeRegistry([]);

		const result = await explainCommand(COMMAND, REASON, [m1], registry, controller.signal);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("stops the candidate loop when a request observes the shared abort", async () => {
		const { registry, calls } = fakeRegistry([
			{ respond: assistantMessage("too late", "aborted") },
		]);

		const result = await explainCommand(
			COMMAND,
			REASON,
			[m1, m2],
			registry,
			new AbortController().signal,
		);

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("stops after a throw when the shared signal was aborted mid-flight", async () => {
		const controller = new AbortController();
		// The deadline fires while the first request is in flight; the registry
		// surfaces it as a throw on that request only.
		const calls: StreamCall[] = [];
		const registry: ExplainModelRegistry = {
			streamSimple: (model, context, options) => {
				calls.push({ model, context, options });
				return {
					result: async () => {
						await new Promise((resolve) =>
							options.signal.addEventListener("abort", resolve),
						);
						throw new Error("request aborted");
					},
				};
			},
		};

		const pending = explainCommand(COMMAND, REASON, [m1, m2], registry, controller.signal);
		controller.abort();
		const result = await pending;

		expect(result).toBeUndefined();
		expect(calls).toHaveLength(1);
	});

	it("bounds overlong output", async () => {
		const long = "Descarga y ejecuta código desde un servidor remoto y lo guarda en el directorio home del usuario, sobrescribiendo archivos existentes sin pedir confirmación previa al usuario.";
		const { registry } = fakeRegistry([{ respond: assistantMessage(long.repeat(3)) }]);

		const result = await explainCommand(COMMAND, REASON, [m1], registry, new AbortController().signal);

		expect(result).toBeDefined();
		expect(result!.length).toBeLessThanOrEqual(240);
		expect(result!.endsWith(" ")).toBe(false);
	});
});
