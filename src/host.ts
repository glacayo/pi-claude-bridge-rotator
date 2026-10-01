// Reciprocal account-host contract mirror.
//
// `@vanillagreen/pi-claude-bridge` publishes a `ClaudeBridgeAccountHostV1`
// service on `globalThis` at ITS load (primary instance only, and never when a
// config disables the bridge). The rotator consumes it for
// `/claude-accounts probe`; it never imports the bridge at runtime, so the
// contract is mirrored locally exactly like the router contract.
//
// Contract authority (read-only reference, never imported at runtime):
//   @vanillagreen/pi-claude-bridge/src/account-host.ts

import type { ClaudeAccountRoute } from "./router.js";

/** The symbol the bridge publishes its account-host service under. */
export const CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL = Symbol.for("kendex.pi.claude-bridge.account-host.v1");

/** A mutable symbol-indexed view over a global object. */
export type GlobalTarget = Record<PropertyKey, unknown>;

// SAFETY: `globalThis` is an ordinary object and Symbol-keyed reads/writes are
// valid at runtime; TypeScript's built-in `globalThis` type simply does not
// model the symbol index signature these process-global contracts rely on.
export const DEFAULT_GLOBAL_TARGET: GlobalTarget = globalThis as unknown as GlobalTarget;

/** Shape mirrored from the bridge. `deadlineMs` is honored by the bridge's
 *  implementation (it bounds a cold child spawn); the public bridge type omits
 *  it, but passing it is a no-op for conforming hosts. */
export interface ClaudeBridgeAccountHostV1 {
	version: 1;
	probeProfile(input: {
		profile: ClaudeAccountRoute;
		cwd: string;
		signal?: AbortSignal;
		deadlineMs?: number;
	}): Promise<{
		identity?: {
			email?: string;
			organization?: string;
			subscriptionType?: string;
			authMethod?: string;
		};
		usage?: unknown;
	}>;
}

/** Read the bridge's account-host service off a global target. Returns
 *  `undefined` when the bridge is absent, disabled, or published an
 *  incompatible version. Fresh read on every call: extension load order
 *  decides visibility at load time, so callers check on `session_start`. */
export function resolveBridgeAccountHost(
	globalTarget: GlobalTarget = DEFAULT_GLOBAL_TARGET,
): ClaudeBridgeAccountHostV1 | undefined {
	const candidate = globalTarget[CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL];
	// SAFETY: the slot is untyped until the `version === 1` discriminant below
	// validates it against the mirrored contract; an absent/incompatible value
	// simply returns `undefined`.
	return (candidate as ClaudeBridgeAccountHostV1 | undefined)?.version === 1
		? (candidate as ClaudeBridgeAccountHostV1)
		: undefined;
}
