import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import explainExtension, { NO_EXPLANATION_REASON } from "../index";

const REQUEST_EVENT = "guardrails:delegate:request";
const REGISTER_EVENT = "guardrails:delegate:register";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface DelegateAnswer {
	verdict: string;
	reason: string;
}

interface Delegate {
	id: string;
	name: string;
	decide(request: unknown, context: unknown): Promise<DelegateAnswer | undefined>;
}

/** Minimal synchronous event bus matching Pi's shared `EventBus`. */
function createBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel: string, handler: (data: unknown) => void): () => void {
			let set = listeners.get(channel);
			if (!set) {
				set = new Set();
				listeners.set(channel, set);
			}
			set.add(handler);
			return () => {
				set!.delete(handler);
			};
		},
		emit(channel: string, data: unknown): void {
			for (const handler of [...(listeners.get(channel) ?? [])]) {
				handler(data);
			}
		},
	};
}

type Bus = ReturnType<typeof createBus>;

/**
 * Load the extension against a minimal ExtensionAPI stub. A recorder is
 * subscribed to `guardrails:delegate:register` *before* the extension loads,
 * mirroring Guardrails' roster, so the immediate announcement is captured.
 */
function loadPi(settings: unknown = {}) {
	const events = createBus();
	const handlers = new Map<string, Handler[]>();
	const registrations: unknown[] = [];
	events.on(REGISTER_EVENT, (data) => registrations.push(data));

	const pi = {
		events,
		getSettings: () => settings,
		on(event: string, handler: Handler) {
			let list = handlers.get(event);
			if (!list) {
				list = [];
				handlers.set(event, list);
			}
			list.push(handler);
			return () => {
				const current = handlers.get(event) ?? [];
				const index = current.indexOf(handler);
				if (index >= 0) {
					current.splice(index, 1);
				}
			};
		},
	};
	explainExtension(pi as unknown as ExtensionAPI);

	return {
		events,
		registrations,
		handlers,
		fire(event: string, payload: unknown = {}, ctx: unknown = {}): void {
			for (const handler of [...(handlers.get(event) ?? [])]) {
				handler(payload, ctx);
			}
		},
		registeredDelegate(): Delegate {
			expect(registrations.length).toBeGreaterThan(0);
			return (registrations[0] as { delegate: Delegate }).delegate;
		},
	};
}

function delegateRequestPayload() {
	return {
		source: "guardrails",
		timestamp: new Date().toISOString(),
	};
}

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

function assistantMessage(text: string): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

interface CompleteCall {
	model: Model<Api>;
	context: Context;
	options: { signal: AbortSignal; cacheRetention: string; sessionId: string; maxTokens: number };
}

type CompleteResult = { throwWith: unknown } | { text: string };

/**
 * Registry stub satisfying both candidate resolution and request execution:
 * `getAvailable`/`find`/`hasConfiguredAuth` for `candidateModels`, and
 * `complete` scripted with one `CompleteResult` per call, in order.
 */
function fakeRegistry(models: Model<Api>[], results: CompleteResult[]) {
	const calls: CompleteCall[] = [];
	let next = 0;
	const registry = {
		getAvailable: () => models,
		find: (provider: string, id: string) =>
			models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (model: Model<Api>) => models.includes(model),
		complete: async (model: Model<Api>, context: Context, options: CompleteCall["options"]) => {
			calls.push({ model, context, options });
			const result = results[next++];
			if (!result) {
				throw new Error("unexpected extra complete() call");
			}
			if ("throwWith" in result) {
				throw result.throwWith;
			}
			return assistantMessage(result.text);
		},
	};
	return { registry, calls };
}

function delegationContext(registry: unknown, signal = new AbortController().signal) {
	return { modelRegistry: registry, signal };
}

/** Guardrails' permission-gate request for a flagged Bash command. */
function bashRequest(overrides: Record<string, unknown> = {}) {
	return {
		feature: "permissionGate",
		toolName: "bash",
		action: { kind: "command", command: "git push --force" },
		reason: "Git force push",
		input: { command: "git push --force" },
		...overrides,
	};
}

const m1 = makeModel("a", "one");
const m2 = makeModel("b", "two");

describe("delegate registration", () => {
	it("announces the delegate immediately when Guardrails loaded first", () => {
		const ext = loadPi();

		expect(ext.registrations).toHaveLength(1);
		const delegate = ext.registeredDelegate();
		expect(delegate.id).toBe("explain-bash");
		expect(delegate.name).toBe("explain");
		expect(typeof delegate.decide).toBe("function");
	});

	it("replays registration when Guardrails requests delegates later", () => {
		const ext = loadPi();
		expect(ext.registrations).toHaveLength(1);

		ext.events.emit(REQUEST_EVENT, delegateRequestPayload());
		expect(ext.registrations).toHaveLength(2);

		ext.events.emit(REQUEST_EVENT, delegateRequestPayload());
		expect(ext.registrations).toHaveLength(3);

		const announced = ext.registrations[1] as { delegate: Delegate };
		expect(announced.delegate.id).toBe("explain-bash");
	});

	it("ignores delegate requests that are not Guardrails' payload", () => {
		const ext = loadPi();

		ext.events.emit(REQUEST_EVENT, null);
		ext.events.emit(REQUEST_EVENT, "garbage");
		ext.events.emit(REQUEST_EVENT, { source: "someone-else", timestamp: "nope" });
		ext.events.emit(REQUEST_EVENT, { source: "guardrails" });

		expect(ext.registrations).toHaveLength(1);
	});

	it("drops the replay subscription on session_shutdown", () => {
		const ext = loadPi();
		expect(ext.registrations).toHaveLength(1);

		ext.fire("session_shutdown", { type: "session_shutdown", reason: "reload" });
		ext.events.emit(REQUEST_EVENT, delegateRequestPayload());

		expect(ext.registrations).toHaveLength(1);
	});
});

describe("active model tracking", () => {
	it("captures the session_start model and uses it as fallback candidate", async () => {
		const ext = loadPi();
		const delegate = ext.registeredDelegate();
		const { registry, calls } = fakeRegistry([m1], [{ text: "Explicación." }]);

		ext.fire("session_start", { type: "session_start", reason: "startup" }, { model: m1 });

		const answer = await delegate.decide(bashRequest(), delegationContext(registry));
		expect(answer?.verdict).toBe("ask");
		expect(calls.map((call) => call.model)).toEqual([m1]);
	});

	it("captures model changes from model_select", async () => {
		const ext = loadPi();
		const delegate = ext.registeredDelegate();
		const { registry, calls } = fakeRegistry([m2], [{ text: "Explicación." }]);

		ext.fire("session_start", { type: "session_start", reason: "startup" }, { model: m1 });
		ext.fire("model_select", { type: "model_select", model: m2 });

		await delegate.decide(bashRequest(), delegationContext(registry));
		expect(calls.map((call) => call.model)).toEqual([m2]);
	});

	it("keeps configured specs ahead of the tracked active model", async () => {
		const ext = loadPi({ guardrailsExplain: { models: ["a/one"] } });
		const delegate = ext.registeredDelegate();
		const { registry, calls } = fakeRegistry([m1, m2], [{ text: "Explicación." }]);

		ext.fire("session_start", { type: "session_start", reason: "startup" }, { model: m2 });

		await delegate.decide(bashRequest(), delegationContext(registry));
		// explainCommand stops at the first successful candidate.
		expect(calls.map((call) => call.model)).toEqual([m1]);
	});
});

describe("request filtering", () => {
	it.each([
		["a non-permission-gate feature", { feature: "pathAccess" }],
		["a non-bash tool", { toolName: "powershell" }],
		["a file action", { action: { kind: "file", path: "/etc/passwd" } }],
		["a command action without a command", { action: { kind: "command" } }],
	])("abstains on %s without model calls", async (_label, overrides) => {
		const ext = loadPi();
		const delegate = ext.registeredDelegate();
		const { registry, calls } = fakeRegistry([m1], [{ text: "Explicación." }]);

		ext.fire("session_start", { type: "session_start", reason: "startup" }, { model: m1 });

		const answer = await delegate.decide(
			bashRequest(overrides as Record<string, unknown>),
			delegationContext(registry),
		);

		expect(answer).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("abstains when the delegation context is incomplete", async () => {
		const ext = loadPi();
		const delegate = ext.registeredDelegate();
		const { registry, calls } = fakeRegistry([m1], []);

		const answer = await delegate.decide(bashRequest(), { modelRegistry: registry });

		expect(answer).toBeUndefined();
		expect(calls).toHaveLength(0);
	});
});

describe("decision", () => {
	it("answers ask with the explanation as the reason on success", async () => {
		const ext = loadPi({ guardrailsExplain: { models: ["a/one"] } });
		const delegate = ext.registeredDelegate();
		const { registry, calls } = fakeRegistry(
			[m1],
			[{ text: "Fuerza el envío de commits al remoto." }],
		);
		const context = delegationContext(registry);

		const answer = await delegate.decide(bashRequest(), context);

		expect(answer).toEqual({
			verdict: "ask",
			reason: "Fuerza el envío de commits al remoto.",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.options.signal).toBe(context.signal);

		const text = (calls[0]!.context.messages[0]!.content as { type: string; text: string }[])
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		expect(text).toContain("git push --force");
		expect(text).toContain("Git force push");
	});

	it("answers ask with the generic fallback reason when no model explains", async () => {
		const ext = loadPi({ guardrailsExplain: { models: ["a/one"] } });
		const delegate = ext.registeredDelegate();
		const { registry, calls } = fakeRegistry([m1], [{ throwWith: new Error("provider down") }]);

		const answer = await delegate.decide(bashRequest(), delegationContext(registry));

		expect(answer).toEqual({ verdict: "ask", reason: NO_EXPLANATION_REASON });
		expect(calls).toHaveLength(1);
	});

	it("never returns allow or block", async () => {
		const scenarios = [
			{ label: "successful explanation", results: [{ text: "Explicación." }] as CompleteResult[] },
			{ label: "failing model", results: [{ throwWith: new Error("down") }] as CompleteResult[] },
			{ label: "aborted deadline", results: [] as CompleteResult[], abort: true },
		];

		for (const scenario of scenarios) {
			const ext = loadPi();
			const delegate = ext.registeredDelegate();
			const { registry } = fakeRegistry([m1], scenario.results);
			const controller = new AbortController();
			if (scenario.abort) {
				controller.abort();
			}

			const answer = await delegate.decide(
				bashRequest(),
				delegationContext(registry, controller.signal),
			);

			expect(answer?.verdict, scenario.label).toBe("ask");
		}
	});
});
