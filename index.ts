/**
 * Pi extension adapter for Guardrails' decision delegation.
 *
 * Registers a delegate on Guardrails' public event-bus channels that explains
 * flagged Bash commands instead of deciding them:
 *
 *   - `guardrails:delegate:request` — Guardrails asks delegates to register.
 *   - `guardrails:delegate:register` — a delegate object is announced.
 *
 * Load-order dance: Guardrails builds its roster by emitting one request and
 * listening for registrations, but extension load order is not guaranteed. The
 * delegate therefore announces itself once immediately (covers Guardrails
 * loading first) and replays the announcement on every later request (covers
 * this extension loading first). The replay subscription is dropped on
 * `session_shutdown`, matching Guardrails' own roster teardown.
 *
 * Guardrails' `DelegationContext` carries no `model`, and there is no
 * `tool_call` handler to fall back on: later handlers run after Guardrails'
 * and would only see the call after the decision is made. The active model is
 * therefore tracked in extension state from `session_start` (`ctx.model`) and
 * `model_select` (`event.model`) and passed to candidate resolution.
 *
 * The delegate abstains on everything that is not a Bash command flagged by
 * Guardrails' permission gate. For flagged Bash commands it answers `ask`,
 * with the model's one-line Spanish explanation as the reason, or a generic
 * fallback when no candidate produced an explanation. It never returns allow
 * or block — the decision stays with the human.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { explainCommand, type ExplainModelRegistry } from "./src/explain";
import { candidateModels, type ModelRegistryLike } from "./src/models";

/** Guardrails asks delegates to (re)register on this channel. */
const DELEGATE_REQUEST_EVENT = "guardrails:delegate:request";
/** Delegates announce themselves on this channel. */
const DELEGATE_REGISTER_EVENT = "guardrails:delegate:register";

/** Stable roster id; Guardrails keys delegates by it across reloads. */
const DELEGATE_ID = "explain-bash";
/** Short roster name: Guardrails shows it in the `[guardrails]` entry. */
const DELEGATE_NAME = "explain";

/** Generic reason used when no candidate model produced an explanation. */
export const NO_EXPLANATION_REASON =
	"No se generó una explicación del comando; revísalo antes de aprobarlo.";

/** Structural contract of Guardrails' delegate answer (`DelegateAnswer`). */
interface DelegateAnswer {
	verdict: "allow" | "block" | "ask";
	reason: string;
}

/** Structural contract of Guardrails' `GuardrailsDelegate` (>= 0.23.0). */
interface GuardrailsDelegate {
	id: string;
	name: string;
	decide(
		request: DelegationRequest,
		context: DelegationContext,
	): Promise<DelegateAnswer | undefined> | DelegateAnswer | undefined;
}

/** Payload Guardrails emits on `guardrails:delegate:register`. */
interface DelegateRegisterPayload {
	delegate: GuardrailsDelegate;
}

/** Payload Guardrails emits on `guardrails:delegate:request`. */
interface DelegateRequestPayload {
	source?: unknown;
	timestamp?: unknown;
}

/** Fields of Guardrails' `DelegationRequest` that the delegate reads. */
interface DelegationRequest {
	readonly feature: unknown;
	readonly toolName: unknown;
	readonly action: unknown;
	readonly reason: unknown;
}

/** Fields of Guardrails' `DelegationContext` that the delegate reads. */
interface DelegationContext {
	readonly modelRegistry: unknown;
	readonly signal: unknown;
}

/** Guardrails' shell-command action: `{ kind: "command", command: string }`. */
interface CommandAction {
	kind: "command";
	command: string;
}

/** The request the delegate explains: a Bash command flagged by the gate. */
interface BashPermissionGateRequest extends DelegationRequest {
	feature: "permissionGate";
	toolName: "bash";
	action: CommandAction;
	reason: string;
}

/** Registry surface the delegate needs, as required by both src modules. */
type DelegateModelRegistry = ExplainModelRegistry & ModelRegistryLike;

/** The delegation context once its parts are verified at runtime. */
interface DelegationContextWithDeps {
	modelRegistry: DelegateModelRegistry;
	signal: AbortSignal;
}

/** Runtime check that the action is Guardrails' shell-command shape. */
function isCommandAction(action: unknown): action is CommandAction {
	if (typeof action !== "object" || action === null) {
		return false;
	}
	const candidate = action as Record<string, unknown>;
	return candidate.kind === "command" && typeof candidate.command === "string";
}

/** Runtime check that the request is a Bash command flagged by the gate. */
function isBashPermissionGateRequest(
	request: DelegationRequest,
): request is DelegationRequest & BashPermissionGateRequest {
	return (
		request.feature === "permissionGate" &&
		request.toolName === "bash" &&
		typeof request.reason === "string" &&
		isCommandAction(request.action)
	);
}

/** Runtime check that the context carries a usable registry and signal. */
function isDelegationContext(
	context: DelegationContext,
): context is DelegationContext & DelegationContextWithDeps {
	const registry = context.modelRegistry as Record<string, unknown> | undefined;
	const signal = context.signal as AbortSignal | undefined;
	return (
		typeof registry?.complete === "function" &&
		typeof registry?.getAvailable === "function" &&
		typeof registry?.find === "function" &&
		typeof registry?.hasConfiguredAuth === "function" &&
		typeof signal?.aborted === "boolean" &&
		typeof signal?.addEventListener === "function"
	);
}

/** Runtime check that a bus payload is Guardrails' delegate request. */
function isDelegateRequestPayload(data: unknown): data is DelegateRequestPayload {
	if (typeof data !== "object" || data === null) {
		return false;
	}
	const payload = data as DelegateRequestPayload;
	return (
		payload.source === "guardrails" && typeof payload.timestamp === "string"
	);
}

export default function (pi: ExtensionAPI): void {
	/** Active session model, tracked because the delegation context has none. */
	let activeModel: Model<Api> | undefined;

	const delegate: GuardrailsDelegate = {
		id: DELEGATE_ID,
		name: DELEGATE_NAME,
		decide: async (request, context) => {
			if (
				!isBashPermissionGateRequest(request) ||
				!isDelegationContext(context)
			) {
				return undefined;
			}

			const candidates = candidateModels(
				pi,
				context.modelRegistry,
				activeModel,
			);
			const explanation = await explainCommand(
				request.action.command,
				request.reason,
				candidates,
				context.modelRegistry,
				context.signal,
			);

			return {
				verdict: "ask",
				reason: explanation ?? NO_EXPLANATION_REASON,
			};
		},
	};

	// Load-order dance: announce immediately (Guardrails loaded first) and
	// replay on every later request (this extension loaded first).
	const stopReplay = pi.events.on(DELEGATE_REQUEST_EVENT, (data) => {
		if (!isDelegateRequestPayload(data)) {
			return;
		}
		pi.events.emit(DELEGATE_REGISTER_EVENT, {
			delegate,
		} satisfies DelegateRegisterPayload);
	});
	pi.events.emit(DELEGATE_REGISTER_EVENT, {
		delegate,
	} satisfies DelegateRegisterPayload);

	pi.on("session_shutdown", stopReplay);
	pi.on("session_start", (_event, ctx) => {
		activeModel = ctx.model;
	});
	pi.on("model_select", (event) => {
		activeModel = event.model;
	});
}
