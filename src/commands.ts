// `/claude-accounts` command implementation.
//
// All output goes through `ctx.ui.notify` (one consolidated notification per
// action). The handler is built by a factory with every side effect injected:
// the router/config holder, the global target that carries the bridge
// account-host symbol, the clock, and the filesystem `mkdir`. Unit tests
// therefore exercise the real command logic with no pi runtime.

import { mkdirSync } from "node:fs";
import type { RotatorConfig, RotatorProfileConfig } from "./config.js";
import type { ClaudeAccountIdentity } from "./router.js";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL, type ClaudeAccountRouter } from "./router.js";
import type { ClaudeBridgeAccountHostV1, GlobalTarget } from "./host.js";
import { DEFAULT_GLOBAL_TARGET, resolveBridgeAccountHost } from "./host.js";
import type { ProfileIdentity, RotatorStateStore } from "./state.js";

export type NotifyLevel = "info" | "warning" | "error";

/** Minimal UI surface the command needs; satisfied by pi's `ExtensionUIContext`. */
export interface RotatorUIContext {
	notify(message: string, level?: NotifyLevel): void;
}

/** Minimal command context; satisfied by pi's `ExtensionCommandContext`. */
export interface RotatorCommandContext {
	ui: RotatorUIContext;
	model?: { id: string } | undefined;
	sessionManager?: { getSessionId?: () => string } | undefined;
	cwd?: string | undefined;
}

/** Mutable holder shared between the extension shell and the command handler:
 *  the shell registers the command first, then fills in the loaded config and
 *  router (or the load error). The handler reads it at invocation time so a
 *  config fixed after load is picked up on the next `/reload`. */
export interface RotatorCommandState {
	router?: ClaudeAccountRouter | undefined;
	config?: RotatorConfig | undefined;
	configError?: string | undefined;
}

export interface RotatorCommandOptions {
	state: RotatorCommandState;
	globalTarget?: GlobalTarget | undefined;
	now?: (() => number) | undefined;
	mkdirRecursive?: ((path: string) => void) | undefined;
	resolveHost?: ((globalTarget: GlobalTarget) => ClaudeBridgeAccountHostV1 | undefined) | undefined;
}

export type RotatorCommandHandler = (args: string, ctx: RotatorCommandContext) => Promise<void>;

const SUBCOMMANDS = ["status", "login", "reset", "probe"] as const;

/** Build the `/claude-accounts` handler. The returned function is registered
 *  verbatim with pi; keeping it a factory lets tests drive it directly. */
export function createRotatorCommandHandler(options: RotatorCommandOptions): RotatorCommandHandler {
	const globalTarget = options.globalTarget ?? DEFAULT_GLOBAL_TARGET;
	const now = options.now ?? (() => Date.now());
	const mkdirRecursive = options.mkdirRecursive ?? ((path: string) => mkdirSync(path, { recursive: true, mode: 0o700 }));
	const resolveHost = options.resolveHost ?? resolveBridgeAccountHost;

	return async (args, ctx) => {
		const parsed = parseArgs(args);
		switch (parsed.subcommand) {
			case "":
			case "status":
				runStatus(options.state, ctx, { globalTarget, now, resolveHost });
				return;
			case "login":
				runLogin(options.state, ctx, parsed.argument, { mkdirRecursive });
				return;
			case "reset":
				runReset(options.state, ctx, parsed.argument);
				return;
			case "probe":
				await runProbe(options.state, ctx, parsed.argument, { globalTarget, resolveHost });
				return;
			default:
				ctx.ui.notify(
					`pi-claude-bridge-rotator: unknown subcommand "${parsed.subcommand}". `
						+ `Use one of: ${SUBCOMMANDS.join(", ")}.`,
					"warning",
				);
		}
	};
}

interface StatusDeps {
	globalTarget: GlobalTarget;
	now: () => number;
	resolveHost: (globalTarget: GlobalTarget) => ClaudeBridgeAccountHostV1 | undefined;
}

function runStatus(state: RotatorCommandState, ctx: RotatorCommandContext, deps: StatusDeps): void {
	const config = state.config;
	const router = state.router;
	const published = deps.globalTarget[CLAUDE_ACCOUNT_ROUTER_SYMBOL] !== undefined;
	const hostPresent = deps.resolveHost(deps.globalTarget) !== undefined;

	const lines: string[] = [];
	lines.push(`pi-claude-bridge-rotator — policy: ${config?.policy ?? "unavailable"}`);
	lines.push(`router published: ${published ? "yes" : "no"} · bridge account host: ${hostPresent ? "yes" : "no"}`);

	if (config === undefined || router === undefined) {
		const reason = state.configError ?? "rotator is not loaded (no profiles configured).";
		lines.push("");
		lines.push(`config error: ${reason}`);
		ctx.ui.notify(lines.join("\n"), state.configError === undefined ? "warning" : "error");
		return;
	}

	const current = router.current(ctx.model?.id ?? "", ctx.sessionManager?.getSessionId?.());
	const store = router.stateStore;
	const nowMs = deps.now();

	for (const profile of config.profiles) {
		const isCurrent = current?.profileId === profile.id;
		lines.push("");
		lines.push(`• ${profile.label} (${profile.id})${isCurrent ? "  ← current route" : ""}`);
		lines.push(`  configDir: ${profile.configDir}`);
		lines.push(`  cooldown: ${cooldownLabel(store, profile.id, nowMs)}`);
		if (store.state.invalid.includes(profile.id)) {
			lines.push(`  invalid: needs relogin — run /claude-accounts login ${profile.id}`);
		}
		const identity = store.state.identity[profile.id];
		if (identity !== undefined) lines.push(`  identity: ${formatIdentity(identity)}`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

interface LoginDeps {
	mkdirRecursive: (path: string) => void;
}

function runLogin(
	state: RotatorCommandState,
	ctx: RotatorCommandContext,
	argument: string,
	deps: LoginDeps,
): void {
	const config = requireConfig(state, ctx);
	if (config === undefined) return;
	const targets = selectProfiles(config, argument, ctx);
	if (targets === undefined) return;

	const lines: string[] = [`Prepared ${targets.length} login command(s) for the rotator profiles:`];
	for (const profile of targets) {
		try {
			deps.mkdirRecursive(profile.configDir);
			lines.push(`CLAUDE_CONFIG_DIR=${profile.configDir} claude login`);
		} catch (error) {
			lines.push(`# could not create ${profile.configDir}: ${describeError(error)}`);
		}
	}
	lines.push("Run each command in another terminal, then /claude-accounts probe to refresh identity.");
	ctx.ui.notify(lines.join("\n"), "info");
}

function runReset(state: RotatorCommandState, ctx: RotatorCommandContext, argument: string): void {
	const config = requireConfig(state, ctx);
	if (config === undefined) return;
	const router = state.router;
	if (router === undefined) {
		ctx.ui.notify("pi-claude-bridge-rotator: router is not loaded; nothing to reset.", "warning");
		return;
	}
	const targets = selectProfiles(config, argument, ctx);
	if (targets === undefined) return;

	const clearedCooldowns: string[] = [];
	const clearedInvalid: string[] = [];
	const targetIds = new Set(targets.map((profile) => profile.id));
	router.stateStore.update((data) => {
		for (const profileId of [...data.invalid]) {
			if (!targetIds.has(profileId)) continue;
			// Session affinity and the identity cache are deliberately untouched:
			// a reset only re-opens eligibility for selection.
			data.invalid = data.invalid.filter((id) => id !== profileId);
			clearedInvalid.push(profileId);
		}
		for (const profileId of Object.keys(data.cooldowns)) {
			if (!targetIds.has(profileId)) continue;
			delete data.cooldowns[profileId];
			clearedCooldowns.push(profileId);
		}
	});

	const lines: string[] = [];
	lines.push(clearedCooldowns.length > 0 ? `Cleared cooldowns: ${clearedCooldowns.join(", ")}` : "No active cooldowns to clear.");
	lines.push(clearedInvalid.length > 0 ? `Cleared invalid flags: ${clearedInvalid.join(", ")}` : "No invalid profiles to clear.");
	ctx.ui.notify(lines.join("\n"), "info");
}

interface ProbeDeps {
	globalTarget: GlobalTarget;
	resolveHost: (globalTarget: GlobalTarget) => ClaudeBridgeAccountHostV1 | undefined;
}

async function runProbe(
	state: RotatorCommandState,
	ctx: RotatorCommandContext,
	argument: string,
	deps: ProbeDeps,
): Promise<void> {
	const host = deps.resolveHost(deps.globalTarget);
	if (host === undefined) {
		ctx.ui.notify(
			"pi-claude-bridge-rotator: no account host found. Install and enable "
				+ "@vanillagreen/pi-claude-bridge, then run /reload, so /claude-accounts probe can read account identity.",
			"warning",
		);
		return;
	}
	const config = requireConfig(state, ctx);
	if (config === undefined) return;
	const targets = selectProfiles(config, argument, ctx);
	if (targets === undefined) return;

	const cwd = ctx.cwd !== undefined && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
	const router = state.router;
	const lines: string[] = [`Probing ${targets.length} profile(s)…`];

	for (const profile of targets) {
		try {
			const result = await host.probeProfile({
				profile: { profileId: profile.id, label: profile.label, configDir: profile.configDir },
				cwd,
			});
			const identity = result.identity;
			if (identity === undefined || !hasIdentity(identity)) {
				// An empty result is a normal deadline/empty-probe outcome, not an error.
				lines.push(`• ${profile.label} (${profile.id}): no identity reported`);
				continue;
			}
			router?.recordIdentity(profile.id, toIdentity(identity));
			lines.push(`• ${profile.label} (${profile.id}): ${formatIdentity(identity)}${formatUsage(result.usage)}`);
		} catch (error) {
			// One profile failing must not abort the others.
			lines.push(`• ${profile.label} (${profile.id}): probe failed — ${describeError(error)}`);
		}
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

interface ParsedArgs {
	subcommand: string;
	argument: string;
}

function parseArgs(raw: string): ParsedArgs {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { subcommand: "", argument: "" };
	const separator = trimmed.search(/\s/);
	if (separator === -1) return { subcommand: trimmed, argument: "" };
	return { subcommand: trimmed.slice(0, separator), argument: trimmed.slice(separator).trim() };
}

function requireConfig(state: RotatorCommandState, ctx: RotatorCommandContext): RotatorConfig | undefined {
	if (state.config !== undefined) return state.config;
	ctx.ui.notify(`pi-claude-bridge-rotator: ${state.configError ?? "rotator configuration is not loaded."}`, "error");
	return undefined;
}

/** Resolve the target profiles: all of them when no argument is given, else the
 *  single profile whose id or label matches (exact first, then case-insensitive). */
function selectProfiles(
	config: RotatorConfig,
	argument: string,
	ctx: RotatorCommandContext,
): RotatorProfileConfig[] | undefined {
	if (argument.length === 0) return [...config.profiles];
	const needle = argument.toLowerCase();
	const match = config.profiles.find((profile) => profile.id === argument)
		?? config.profiles.find((profile) => profile.label === argument)
		?? config.profiles.find((profile) => profile.id.toLowerCase() === needle)
		?? config.profiles.find((profile) => profile.label.toLowerCase() === needle);
	if (match === undefined) {
		const available = config.profiles.map((profile) => `${profile.label} (${profile.id})`).join(", ");
		ctx.ui.notify(
			`pi-claude-bridge-rotator: unknown profile "${argument}". Available profiles: ${available}.`,
			"warning",
		);
		return undefined;
	}
	return [match];
}

function cooldownLabel(store: RotatorStateStore, profileId: string, nowMs: number): string {
	const cooldown = store.state.cooldowns[profileId];
	if (cooldown === undefined || cooldown.untilMs <= nowMs) return "ok";
	return `remaining ${formatDuration(cooldown.untilMs - nowMs)} (${cooldown.rateLimitType})`;
}

function formatDuration(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
}

function formatIdentity(identity: ProfileIdentity): string {
	const parts: string[] = [];
	if (identity.email !== undefined) parts.push(identity.email);
	if (identity.organization !== undefined) parts.push(identity.organization);
	if (identity.subscriptionType !== undefined) parts.push(identity.subscriptionType);
	return parts.length > 0 ? parts.join(" · ") : "unknown";
}

function formatUsage(usage: unknown): string {
	if (usage === undefined || usage === null) return "";
	let text: string;
	try {
		text = JSON.stringify(usage) ?? String(usage);
	} catch {
		text = String(usage);
	}
	return ` · usage: ${text.length > 240 ? `${text.slice(0, 237)}…` : text}`;
}

type ProbeIdentity = NonNullable<
	Awaited<ReturnType<ClaudeBridgeAccountHostV1["probeProfile"]>>["identity"]
>;

function hasIdentity(identity: ProbeIdentity): boolean {
	return identity.email !== undefined
		|| identity.organization !== undefined
		|| identity.subscriptionType !== undefined
		|| identity.authMethod !== undefined;
}

/** Build a `ClaudeAccountIdentity` without leaking explicit `undefined` fields
 *  into the router (the contract's optional fields are not `| undefined`). */
function toIdentity(identity: ProbeIdentity): ClaudeAccountIdentity {
	const result: ClaudeAccountIdentity = {};
	if (identity.email !== undefined) result.email = identity.email;
	if (identity.organization !== undefined) result.organization = identity.organization;
	if (identity.subscriptionType !== undefined) result.subscriptionType = identity.subscriptionType;
	if (identity.authMethod !== undefined) result.authMethod = identity.authMethod;
	return result;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
