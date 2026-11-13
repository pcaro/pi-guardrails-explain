/**
 * Ordered model candidate and setting resolution for the Guardrails command explainer.
 *
 * Preferences live in Pi settings under the extension's own key:
 *
 *   "guardrailsExplain": {
 *     "models": ["provider/id", "bare-model-id"],
 *     "language": "English"
 *   }
 *
 * Specs are tried in configured order; stale or unauthenticated entries are
 * skipped silently, and the active session model is the last resort so a
 * stale list is a preference and never a hard requirement.
 *
 * Guardrails' delegation context has no `model`, so the active model is an
 * explicit input here; the extension tracks it from `session_start` and
 * `model_select` and passes it in.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/** Default language requested in the explanation prompt. */
export const DEFAULT_LANGUAGE = "English";

/** Minimal settings access this module needs from the Pi extension API. */
export interface SettingsSource {
	/**
	 * Pi returns deep-merged JSON with no schema validation, so unknown keys
	 * arrive intact but untyped — hence the `unknown` return.
	 */
	getSettings(): unknown;
}

/** Structural subset of Pi's `ModelRegistry` used for candidate resolution. */
export interface ModelRegistryLike {
	/** Auth-filtered models: only providers with configured credentials. */
	getAvailable(): Model<Api>[];
	/** Every known model, authenticated or not. */
	find(provider: string, modelId: string): Model<Api> | undefined;
	/** Whether the provider of this model has credentials configured. */
	hasConfiguredAuth(model: Model<Api>): boolean;
}

function guardrailsExplainSection(
	pi: SettingsSource,
): Record<string, unknown> | undefined {
	const settings = pi.getSettings() as unknown;
	if (typeof settings !== "object" || settings === null) {
		return undefined;
	}
	const section = (settings as Record<string, unknown>).guardrailsExplain;
	if (typeof section !== "object" || section === null) {
		return undefined;
	}
	return section as Record<string, unknown>;
}

/** Ordered, trimmed, non-empty specs from settings: `guardrailsExplain.models`. */
export function configuredModelSpecs(pi: SettingsSource): string[] {
	const specs = guardrailsExplainSection(pi)?.models;
	if (!Array.isArray(specs)) {
		return [];
	}
	return specs
		.filter((spec): spec is string => typeof spec === "string")
		.map((spec) => spec.trim())
		.filter((spec) => spec.length > 0);
}

/** Normalized response language from `guardrailsExplain.language`, or `"English"`. */
export function configuredLanguage(pi: SettingsSource): string {
	const language = guardrailsExplainSection(pi)?.language;
	if (typeof language !== "string") {
		return DEFAULT_LANGUAGE;
	}
	const normalized = language.replace(/\s+/g, " ").trim();
	return normalized.length > 0 ? normalized : DEFAULT_LANGUAGE;
}

/**
 * Resolve `provider/id`, or a bare id, to a model with credentials configured.
 * `getAvailable()` is auth-filtered; `find()` is not, so it is only trusted
 * when the provider itself is authenticated.
 */
export function resolveModel(
	modelRegistry: ModelRegistryLike,
	spec: string,
): Model<Api> | undefined {
	const available = modelRegistry.getAvailable();

	const slash = spec.indexOf("/");
	if (slash > 0) {
		const provider = spec.slice(0, slash);
		const id = spec.slice(slash + 1);
		const known = modelRegistry.find(provider, id);
		return (
			available.find((m) => m.provider === provider && m.id === id) ??
			(known && modelRegistry.hasConfiguredAuth(known) ? known : undefined)
		);
	}

	return (
		available.find((m) => `${m.provider}/${m.id}` === spec) ??
		available.find((m) => m.id === spec)
	);
}

/** Candidate models: configured specs first, then the active session model. */
export function candidateModels(
	pi: SettingsSource,
	modelRegistry: ModelRegistryLike,
	activeModel?: Model<Api>,
): Model<Api>[] {
	const models: Model<Api>[] = [];
	const push = (model: Model<Api> | undefined) => {
		if (
			model &&
			!models.some((m) => m.provider === model.provider && m.id === model.id)
		) {
			models.push(model);
		}
	};

	for (const spec of configuredModelSpecs(pi)) {
		push(resolveModel(modelRegistry, spec));
	}
	push(activeModel);

	return models;
}
