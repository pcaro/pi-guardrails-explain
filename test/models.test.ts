import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	candidateModels,
	configuredModelSpecs,
	resolveModel,
	type ModelRegistryLike,
	type SettingsSource,
} from "../src/models";

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

interface RegistryEntry {
	model: Model<Api>;
	/** Whether the provider has credentials configured. */
	auth: boolean;
}

function fakeRegistry(entries: RegistryEntry[]): ModelRegistryLike {
	const known = entries.map((entry) => entry.model);
	const isAuthed = (model: Model<Api>) =>
		entries.some((entry) => entry.model === model && entry.auth);
	return {
		getAvailable: () => known.filter(isAuthed),
		find: (provider, modelId) =>
			known.find((m) => m.provider === provider && m.id === modelId),
		hasConfiguredAuth: isAuthed,
	};
}

function settingsPi(settings: unknown): SettingsSource {
	return { getSettings: () => settings };
}

/** Label a resolved list as `provider/id` strings for readable assertions. */
const labels = (models: (Model<Api> | undefined)[]) =>
	models.map((m) => (m ? `${m.provider}/${m.id}` : "undefined"));

const deepseek = () => makeModel("opencode-go-console", "deepseek-v4.1-flash");
const haiku = () => makeModel("claude-bridge", "claude-haiku-5-5");
const foo = () => makeModel("openai", "foo");
const gemini = () => makeModel("google", "gemini-3-pro");

describe("configuredModelSpecs", () => {
	it("returns the models list in configured order, trimmed", () => {
		const pi = settingsPi({
			guardrailsExplain: { models: [" a/m ", "b/n", "  ", 42, null] },
		});
		expect(configuredModelSpecs(pi)).toEqual(["a/m", "b/n"]);
	});

	it("returns empty when the settings path is missing or malformed", () => {
		for (const settings of [
			undefined,
			{},
			{ guardrailsExplain: {} },
			{ guardrailsExplain: { models: "a/m" } },
			{ guardrailsExplain: null },
			"not an object",
		]) {
			expect(configuredModelSpecs(settingsPi(settings))).toEqual([]);
		}
	});
});

describe("resolveModel", () => {
	const registry = () =>
		fakeRegistry([
			{ model: deepseek(), auth: true },
			{ model: haiku(), auth: true },
			{ model: gemini(), auth: false },
		]);

	it("resolves provider/id against the auth-filtered available models", () => {
		expect(resolveModel(registry(), "claude-bridge/claude-haiku-5-5")).toEqual(
			haiku(),
		);
	});

	it("resolves a known but unavailable provider/id only with configured auth", () => {
		const onlyKnown = fakeRegistry([{ model: gemini(), auth: false }]);
		expect(resolveModel(onlyKnown, "google/gemini-3-pro")).toBeUndefined();

		const knownAndAuthed = fakeRegistry([{ model: gemini(), auth: true }]);
		expect(resolveModel(knownAndAuthed, "google/gemini-3-pro")).toEqual(
			gemini(),
		);
	});

	it("returns undefined for unknown provider/id specs", () => {
		expect(resolveModel(registry(), "openai/foo")).toBeUndefined();
	});

	it("resolves bare ids only among authenticated available models", () => {
		expect(resolveModel(registry(), "claude-haiku-5-5")).toEqual(haiku());

		const unauthenticatedBare = fakeRegistry([{ model: gemini(), auth: false }]);
		expect(resolveModel(unauthenticatedBare, "gemini-3-pro")).toBeUndefined();
	});
});

describe("candidateModels", () => {
	it("keeps the configured order of valid candidates", () => {
		const pi = settingsPi({
			guardrailsExplain: { models: ["claude-bridge/claude-haiku-5-5", "openai/foo"] },
		});
		const registry = fakeRegistry([
			{ model: foo(), auth: true },
			{ model: haiku(), auth: true },
		]);
		expect(labels(candidateModels(pi, registry))).toEqual([
			"claude-bridge/claude-haiku-5-5",
			"openai/foo",
		]);
	});

	it("skips stale specs and keeps later valid ones", () => {
		const pi = settingsPi({
			guardrailsExplain: {
				models: ["gone/deleted-model", "claude-bridge/claude-haiku-5-5"],
			},
		});
		const registry = fakeRegistry([{ model: haiku(), auth: true }]);
		expect(labels(candidateModels(pi, registry))).toEqual([
			"claude-bridge/claude-haiku-5-5",
		]);
	});

	it("skips unauthenticated provider/id specs", () => {
		const pi = settingsPi({
			guardrailsExplain: {
				models: ["opencode-go-console/deepseek-v4.1-flash", "claude-bridge/claude-haiku-5-5"],
			},
		});
		const registry = fakeRegistry([
			{ model: deepseek(), auth: false },
			{ model: haiku(), auth: true },
		]);
		expect(labels(candidateModels(pi, registry))).toEqual([
			"claude-bridge/claude-haiku-5-5",
		]);
	});

	it("resolves bare-id specs from the authenticated available models", () => {
		const pi = settingsPi({
			guardrailsExplain: { models: ["deepseek-v4.1-flash"] },
		});
		const registry = fakeRegistry([{ model: deepseek(), auth: true }]);
		expect(labels(candidateModels(pi, registry))).toEqual([
			"opencode-go-console/deepseek-v4.1-flash",
		]);
	});

	it("deduplicates by provider and id, keeping the first occurrence", () => {
		const pi = settingsPi({
			guardrailsExplain: {
				models: ["claude-bridge/claude-haiku-5-5", "claude-haiku-5-5", "openai/foo", "foo"],
			},
		});
		const registry = fakeRegistry([
			{ model: haiku(), auth: true },
			{ model: foo(), auth: true },
		]);
		expect(labels(candidateModels(pi, registry))).toEqual([
			"claude-bridge/claude-haiku-5-5",
			"openai/foo",
		]);
	});

	it("appends the active session model as the last fallback", () => {
		const pi = settingsPi({
			guardrailsExplain: { models: ["claude-bridge/claude-haiku-5-5"] },
		});
		const registry = fakeRegistry([{ model: haiku(), auth: true }]);
		expect(labels(candidateModels(pi, registry, foo()))).toEqual([
			"claude-bridge/claude-haiku-5-5",
			"openai/foo",
		]);
	});

	it("does not duplicate the active session model", () => {
		const pi = settingsPi({
			guardrailsExplain: { models: ["openai/foo"] },
		});
		const registry = fakeRegistry([{ model: foo(), auth: true }]);
		expect(labels(candidateModels(pi, registry, foo()))).toEqual(["openai/foo"]);
	});

	it("never appends arbitrary available models", () => {
		const pi = settingsPi({
			guardrailsExplain: { models: ["claude-bridge/claude-haiku-5-5"] },
		});
		const registry = fakeRegistry([
			{ model: haiku(), auth: true },
			{ model: gemini(), auth: true },
		]);
		expect(labels(candidateModels(pi, registry))).toEqual([
			"claude-bridge/claude-haiku-5-5",
		]);
	});

	it("falls back to the active session model alone when no specs resolve", () => {
		const pi = settingsPi({
			guardrailsExplain: { models: ["gone/deleted-model"] },
		});
		const registry = fakeRegistry([{ model: haiku(), auth: true }]);
		expect(labels(candidateModels(pi, registry, foo()))).toEqual(["openai/foo"]);
	});

	it("returns an empty list when there are no specs and no active model", () => {
		const pi = settingsPi({ guardrailsExplain: { models: [] } });
		const registry = fakeRegistry([
			{ model: haiku(), auth: true },
			{ model: foo(), auth: true },
		]);
		expect(candidateModels(pi, registry)).toEqual([]);
	});

	it("matches the plan example: only Claude authenticated, active openai/foo", () => {
		const pi = settingsPi({
			guardrailsExplain: {
				models: [
					"opencode-go-console/deepseek-v4.1-flash",
					"claude-bridge/claude-haiku-5-5",
				],
			},
		});
		const registry = fakeRegistry([
			{ model: deepseek(), auth: false },
			{ model: haiku(), auth: true },
		]);
		expect(labels(candidateModels(pi, registry, foo()))).toEqual([
			"claude-bridge/claude-haiku-5-5",
			"openai/foo",
		]);
	});
});
