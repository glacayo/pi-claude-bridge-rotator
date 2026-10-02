// `/claude-accounts` command implementation.
//
// All output goes through `ctx.ui.notify` (one consolidated notification per
// action). The handler is built by a factory with every side effect injected:
// the router/config holder, the global target that carries the bridge
// account-host symbol, the clock, and the filesystem `mkdir`. Unit tests
// therefore exercise the real command logic with no pi runtime.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_POLICY,
	resolveConfigPath,
	rotatorProfilesBaseDir,
	saveConfig,
	slugifyProfileId,
	uniqueProfileId,
} from "./config.js";
import type { RotatorConfig, RotatorProfileConfig } from "./config.js";
import { startClaudeLogin } from "./login.js";
import type { ClaudeLoginHandle } from "./login.js";
import type { RouterPublisher } from "./index.js";
import type { ClaudeAccountIdentity } from "./router.js";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL, type ClaudeAccountRouter } from "./router.js";
import type { ClaudeBridgeAccountHostV1, GlobalTarget } from "./host.js";
import { DEFAULT_GLOBAL_TARGET, resolveBridgeAccountHost } from "./host.js";
import type { ProfileUsageError, ProfileUsageRecord, RotatorStateStore } from "./state.js";
import { fetchPlanUsage } from "./usage.js";
import type { UsageFetchResult, UsageWindow, UsageWindowName } from "./usage.js";
import { claimUsageFetch, completeUsageFetch } from "./usage-lease.js";
import type { UsageFetchClaim } from "./usage-lease.js";
import type { UsagePoller } from "./poller.js";

export type NotifyLevel = "info" | "warning" | "error";

/** Options accepted by pi's dialog APIs; mirrored so the real context satisfies
 *  this interface structurally without importing its runtime types. */
export interface RotatorDialogOptions {
	signal?: AbortSignal | undefined;
	timeout?: number | undefined;
}

/** Minimal UI surface the command needs; satisfied by pi's `ExtensionUIContext`.
 *  The dialog methods are optional so JSON/print modes (no UI) still satisfy it
 *  and fall back to the guidance flow. */
export interface RotatorUIContext {
	notify(message: string, level?: NotifyLevel): void;
	select?(title: string, options: string[], opts?: RotatorDialogOptions): Promise<string | undefined>;
	confirm?(title: string, message: string, opts?: RotatorDialogOptions): Promise<boolean>;
	input?(title: string, placeholder?: string, opts?: RotatorDialogOptions): Promise<string | undefined>;
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
	/** Owner-capable publisher stored by the first activation; the refresh hook
	 *  republishes through it so a wizard write is live without `/reload`. */
	publisher?: RouterPublisher | undefined;
	/** Reload the config from disk and republish; set by the extension shell. */
	refresh?: (() => void) | undefined;
	/** The single process-wide usage poller, registered by the extension shell on
	 *  `session_start`. Lives in shared state so `/reload` cannot create a
	 *  second one; the shell reads the CURRENT router through its `getTargets`. */
	poller?: UsagePoller | undefined;
	/** In-memory-only timestamps of the last ineffective status probe per profile.
	 *  Never persisted: it exists to stop a persistently broken token from
	 *  spawning a CLI probe on every `status` inside the backoff window. */
	statusProbeAtMs?: Record<string, number> | undefined;
}

/** Injected login driver: spawns `claude auth login` for one profile and
 *  returns the handle used to submit the pasted code. */
export type StartLogin = (options: {
	configDir: string;
	onOutput?: ((line: string) => void) | undefined;
}) => Promise<ClaudeLoginHandle>;

/** Injected plan-usage fetcher. The command only ever needs a config dir and an
 *  optional abort signal; the default closes over the injected clock so token
 *  expiry stays deterministic in tests. */
export type FetchUsage = (options: {
	configDir: string;
	signal?: AbortSignal | undefined;
}) => Promise<UsageFetchResult>;

export interface RotatorCommandOptions {
	state: RotatorCommandState;
	globalTarget?: GlobalTarget | undefined;
	now?: (() => number) | undefined;
	mkdirRecursive?: ((path: string) => void) | undefined;
	resolveHost?: ((globalTarget: GlobalTarget) => ClaudeBridgeAccountHostV1 | undefined) | undefined;
	/** Explicit config path for wizard writes/refreshes; wins over `env`. */
	configPath?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	/** Defaults to the real `claude auth login` driver; tests inject a fake. */
	startLogin?: StartLogin | undefined;
	/** Copies the existing config aside before a wizard overwrite; tests inject. */
	backupConfigFile?: ((path: string) => void) | undefined;
	/** Defaults to the real `fetchPlanUsage`; tests inject a fake. */
	fetchUsage?: FetchUsage | undefined;
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
	const startLogin = options.startLogin ?? startClaudeLogin;
	const backupConfigFile = options.backupConfigFile ?? ((path: string) => copyFileSync(path, `${path}.bak`));
	const fetchUsage: FetchUsage = options.fetchUsage
		?? ((usageOptions) => fetchPlanUsage({ configDir: usageOptions.configDir, now, signal: usageOptions.signal }));

	return async (args, ctx) => {
		const parsed = parseArgs(args);
		switch (parsed.subcommand) {
			case "":
			case "status":
				await runStatus(options.state, ctx, { globalTarget, now, resolveHost, fetchUsage });
				return;
			case "login":
				await runLogin(options.state, ctx, parsed.argument, {
					mkdirRecursive,
					globalTarget,
					resolveHost,
					startLogin,
					backupConfigFile,
					configPath: options.configPath,
					env: options.env,
				});
				return;
			case "reset":
				runReset(options.state, ctx, parsed.argument);
				return;
			case "probe":
				await runProbe(options.state, ctx, parsed.argument, { globalTarget, resolveHost, now, fetchUsage });
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
	fetchUsage: FetchUsage;
}

/** Deadline passed to the bridge's `probeProfile` when status uses a probe to
 *  give the official CLI a chance to refresh an expired access token. */
const PROBE_REFRESH_DEADLINE_MS = 15000;

/** A status probe that does not fix the token is not retried for this long, so
 *  a persistently unauthorized account cannot spawn a CLI child on every
 *  `status` invocation. In-memory and per process (shared command state). */
export const STATUS_PROBE_BACKOFF_MS = 10 * 60_000;

async function runStatus(state: RotatorCommandState, ctx: RotatorCommandContext, deps: StatusDeps): Promise<void> {
	const config = state.config;
	const router = state.router;
	const published = deps.globalTarget[CLAUDE_ACCOUNT_ROUTER_SYMBOL] !== undefined;
	const host = deps.resolveHost(deps.globalTarget);
	const hostPresent = host !== undefined;

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

	// Claim the cross-process fetch lease for every profile up front. A profile
	// with a fresh shared snapshot, a 429 backoff, or a lease held by another
	// process is not fetched; only the claimed ones are. Every profile is still
	// polled in parallel, so status stays one round trip slow, not one per
	// account. The default fetcher never throws. When a token is expired or
	// unauthorized and the bridge host is present, give the official CLI exactly
	// ONE chance to refresh it (a probe under that config dir), then re-fetch
	// once. The rotator itself never touches credentials.
	const cwd = ctx.cwd !== undefined && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
	const claims = new Map<string, UsageFetchClaim>();
	for (const profile of config.profiles) {
		claims.set(profile.id, claimUsageFetch(store, profile.id, nowMs));
	}
	const results = await Promise.all(config.profiles.map(async (profile): Promise<UsageFetchResult | undefined> => {
		if (claims.get(profile.id)?.fetch !== true) return undefined;
		const first = await deps.fetchUsage({ configDir: profile.configDir });
		const needsRefresh = !first.ok && (first.reason === "token-expired" || first.reason === "unauthorized");
		if (!needsRefresh || host === undefined) return first;
		// A probe that just ran and did not fix the token is skipped until the
		// backoff elapses; the plain fetch above still ran, so status stays fresh.
		if (isStatusProbeBackedOff(state, profile.id, nowMs)) return first;
		await probeProfileQuietly(host, profile, cwd);
		const second = await deps.fetchUsage({ configDir: profile.configDir });
		if (!second.ok && (second.reason === "token-expired" || second.reason === "unauthorized")) {
			recordIneffectiveStatusProbe(state, profile.id, nowMs);
		}
		return second;
	}));
	config.profiles.forEach((profile, index) => {
		const result = results[index];
		if (result === undefined) return;
		router.recordPlanUsage(profile.id, result);
		completeUsageFetch(store, profile.id, result, deps.now());
	});

	for (const profile of config.profiles) {
		const isCurrent = current?.profileId === profile.id;
		lines.push("");
		lines.push(`• ${profile.label} (${profile.id})${isCurrent ? "  ← current route" : ""}`);
		lines.push(`  configDir: ${profile.configDir}`);
		lines.push(`  cooldown: ${cooldownLabel(store, profile.id, nowMs)}`);
		const usageRecord = router.planUsage(profile.id);
		const { usageLine, lastKnownLine } = statusUsageLines(usageRecord, profile.id, claims.get(profile.id), nowMs);
		if (usageLine !== undefined) lines.push(`  ${usageLine}`);
		if (lastKnownLine !== undefined) lines.push(`  ${lastKnownLine}`);
		if (store.state.invalid.includes(profile.id)) {
			lines.push(`  invalid: needs relogin — run /claude-accounts login ${profile.id}`);
		}
		const identity = store.state.identity[profile.id];
		if (identity !== undefined) lines.push(`  identity: ${formatIdentity(identity)}`);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

/** One bounded probe whose only purpose is to let the official CLI refresh the
 *  access token under that config dir. Any failure is swallowed: the following
 *  re-fetch decides the reported reason. */
async function probeProfileQuietly(
	host: ClaudeBridgeAccountHostV1,
	profile: RotatorProfileConfig,
	cwd: string,
): Promise<void> {
	try {
		await host.probeProfile({
			profile: { profileId: profile.id, label: profile.label, configDir: profile.configDir },
			cwd,
			deadlineMs: PROBE_REFRESH_DEADLINE_MS,
		});
	} catch {
		// Never throws: a probe failure must not change the reported reason.
	}
}

function isStatusProbeBackedOff(state: RotatorCommandState, profileId: string, nowMs: number): boolean {
	const lastProbeMs = state.statusProbeAtMs?.[profileId];
	return lastProbeMs !== undefined && nowMs - lastProbeMs < STATUS_PROBE_BACKOFF_MS;
}

function recordIneffectiveStatusProbe(state: RotatorCommandState, profileId: string, nowMs: number): void {
	const existing = state.statusProbeAtMs;
	if (existing === undefined) state.statusProbeAtMs = { [profileId]: nowMs };
	else existing[profileId] = nowMs;
}

interface LoginDeps {
	mkdirRecursive: (path: string) => void;
	globalTarget: GlobalTarget;
	resolveHost: (globalTarget: GlobalTarget) => ClaudeBridgeAccountHostV1 | undefined;
	startLogin: StartLogin;
	backupConfigFile: (path: string) => void;
	configPath?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
}

/** Non-optional dialog functions, narrowed after feature detection. */
interface DialogFns {
	select: (title: string, options: string[], opts?: RotatorDialogOptions) => Promise<string | undefined>;
	confirm: (title: string, message: string, opts?: RotatorDialogOptions) => Promise<boolean>;
	input: (title: string, placeholder?: string, opts?: RotatorDialogOptions) => Promise<string | undefined>;
}

const ADD_ACCOUNT_OPTION = "Add a new account…";

/** `/claude-accounts login`: interactive wizard when pi exposes dialogs, else
 *  the guidance flow that prints the exact `claude auth login` command. */
async function runLogin(
	state: RotatorCommandState,
	ctx: RotatorCommandContext,
	argument: string,
	deps: LoginDeps,
): Promise<void> {
	const { select, confirm, input } = ctx.ui;
	if (typeof select !== "function" || typeof confirm !== "function" || typeof input !== "function") {
		runLoginGuidance(state, ctx, argument, deps);
		return;
	}
	const dialogs: DialogFns = { select, confirm, input };

	const profiles = state.config?.profiles ?? [];

	if (argument.length > 0) {
		const match = findProfile(profiles, argument);
		if (match !== undefined) {
			await runProfileLogin(state, ctx, match, profiles, false, deps, dialogs);
			return;
		}
		const create = await dialogs.confirm(
			"Create new account?",
			`No profile matches "${argument}" — add it to the rotator?`,
		);
		if (create !== true) {
			ctx.ui.notify(`pi-claude-bridge-rotator: no account added for "${argument}".`, "info");
			return;
		}
		const created = buildWizardProfile(argument, profiles, deps.env);
		await runProfileLogin(state, ctx, created, [...profiles, created], true, deps, dialogs);
		return;
	}

	if (profiles.length > 0) {
		const options = [...profiles.map((profile) => profile.label), ADD_ACCOUNT_OPTION];
		const choice = await dialogs.select("Log in to which account?", options);
		if (choice === undefined) {
			ctx.ui.notify("pi-claude-bridge-rotator: login cancelled.", "info");
			return;
		}
		const index = options.indexOf(choice);
		const match = index >= 0 && index < profiles.length ? profiles[index] : undefined;
		if (match !== undefined && choice !== ADD_ACCOUNT_OPTION) {
			await runProfileLogin(state, ctx, match, profiles, false, deps, dialogs);
			return;
		}
		// Choosing the add option (or an unknown value) falls through to the loop.
	}

	await runAddFlow(state, ctx, deps, dialogs);
}

/** Build the login command guidance for the no-dialog fallback. */
function runLoginGuidance(
	state: RotatorCommandState,
	ctx: RotatorCommandContext,
	argument: string,
	deps: LoginDeps,
): void {
	const config = requireConfig(state, ctx);
	if (config === undefined) return;
	const targets = argument.length > 0 ? selectProfiles(config, argument, ctx) : [...config.profiles];
	if (targets === undefined) return;

	const lines: string[] = [`Prepared ${targets.length} login command(s) for the rotator profiles:`];
	for (const profile of targets) {
		try {
			deps.mkdirRecursive(profile.configDir);
			lines.push(`CLAUDE_CONFIG_DIR=${profile.configDir} claude auth login --claudeai`);
		} catch (error) {
			lines.push(`# could not create ${profile.configDir}: ${describeError(error)}`);
		}
	}
	lines.push("Run each command in another terminal, then /claude-accounts probe to refresh identity.");
	ctx.ui.notify(lines.join("\n"), "info");
}

/** Add-account loop: label → create → log in → optionally repeat. */
async function runAddFlow(
	state: RotatorCommandState,
	ctx: RotatorCommandContext,
	deps: LoginDeps,
	dialogs: DialogFns,
): Promise<void> {
	let profiles = [...(state.config?.profiles ?? [])];
	for (;;) {
		const label = await dialogs.input("Account label", "e.g. Personal");
		if (label === undefined) {
			ctx.ui.notify("pi-claude-bridge-rotator: login cancelled.", "info");
			return;
		}
		const created = buildWizardProfile(label, profiles, deps.env);
		profiles = [...profiles, created];
		await runProfileLogin(state, ctx, created, profiles, true, deps, dialogs);
		const again = await dialogs.confirm("Add another account?", "Set up another Claude account now?");
		if (again !== true) return;
	}
}

/** Authenticate one profile: create its config dir, persist a new profile,
 *  drive the OAuth child, and record the identity when the bridge can probe. */
async function runProfileLogin(
	state: RotatorCommandState,
	ctx: RotatorCommandContext,
	profile: RotatorProfileConfig,
	profiles: readonly RotatorProfileConfig[],
	isNew: boolean,
	deps: LoginDeps,
	dialogs: DialogFns,
): Promise<void> {
	try {
		deps.mkdirRecursive(profile.configDir);
	} catch (error) {
		ctx.ui.notify(
			`pi-claude-bridge-rotator: could not create ${profile.configDir}: ${describeError(error)}`,
			"error",
		);
		return;
	}

	if (isNew) {
		const policy = state.config?.policy ?? DEFAULT_POLICY;
		const configPath = resolveConfigPath({ configPath: deps.configPath, env: deps.env });
		// The config could not be loaded but the file exists: it is about to be
		// replaced by the wizard's write. Preserve the original bytes first so a
		// typo-broken hand edit is recoverable. A failed backup must never block
		// the recovery write, so it degrades to a warning.
		if (state.config === undefined && existsSync(configPath)) {
			try {
				deps.backupConfigFile(configPath);
			} catch (error) {
				ctx.ui.notify(
					`pi-claude-bridge-rotator: could not back up the existing config at ${configPath} `
						+ `(${describeError(error)}); continuing.`,
					"warning",
				);
			}
		}
		try {
			saveConfig({ policy, profiles }, { configPath: deps.configPath, env: deps.env });
		} catch (error) {
			ctx.ui.notify(`pi-claude-bridge-rotator: could not write the config: ${describeError(error)}`, "error");
			return;
		}
		state.refresh?.();
	}

	let handle: ClaudeLoginHandle;
	try {
		handle = await deps.startLogin({ configDir: profile.configDir });
	} catch (error) {
		ctx.ui.notify(`pi-claude-bridge-rotator: could not start claude auth login: ${describeError(error)}`, "error");
		return;
	}

	ctx.ui.notify(`Opening browser to sign in…\n${handle.url}`, "info");

	const code = await dialogs.input("Paste the login code", "code shown in the browser after authorizing");
	if (code === undefined) {
		handle.cancel();
		ctx.ui.notify("pi-claude-bridge-rotator: login cancelled.", "info");
		return;
	}

	const result = await handle.submitCode(code);
	if (!result.ok) {
		ctx.ui.notify(
			`pi-claude-bridge-rotator: login for ${profile.label} (${profile.id}) failed.\n${result.output}`,
			"error",
		);
		return;
	}

	const identity = await probeIdentity(state, ctx, profile, deps);
	const shown = identity !== undefined ? formatIdentity(identity) : undefined;
	const suffix = shown !== undefined && shown !== "unknown" ? ` — ${shown}` : "";
	ctx.ui.notify(`pi-claude-bridge-rotator: logged in ${profile.label} (${profile.id})${suffix}.`, "info");
}

/** Probe the freshly authenticated profile through the bridge host. A probe
 *  failure (or a missing host) must never turn a successful login into an
 *  error message, so every failure degrades to `undefined`. */
async function probeIdentity(
	state: RotatorCommandState,
	ctx: RotatorCommandContext,
	profile: RotatorProfileConfig,
	deps: LoginDeps,
): Promise<ClaudeAccountIdentity | undefined> {
	const host = deps.resolveHost(deps.globalTarget);
	if (host === undefined) return undefined;
	const cwd = ctx.cwd !== undefined && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
	try {
		const result = await host.probeProfile({
			profile: { profileId: profile.id, label: profile.label, configDir: profile.configDir },
			cwd,
			deadlineMs: PROBE_REFRESH_DEADLINE_MS,
		});
		const identity = result.identity;
		if (identity === undefined || !hasIdentity(identity)) return undefined;
		const record = toIdentity(identity);
		state.router?.recordIdentity(profile.id, record);
		return record;
	} catch {
		return undefined;
	}
}

/** Derive a wizard profile: slugged unique id, the trimmed label, and an
 *  absolute config dir under `~/.claude-rotator/<id>`. */
function buildWizardProfile(
	label: string,
	existing: readonly RotatorProfileConfig[],
	env: NodeJS.ProcessEnv | undefined,
): RotatorProfileConfig {
	const trimmed = label.trim();
	const id = uniqueProfileId(existing.map((profile) => profile.id), slugifyProfileId(trimmed));
	return {
		id,
		label: trimmed.length > 0 ? trimmed : id,
		configDir: join(rotatorProfilesBaseDir(env), id),
	};
}

/** Exact/first, then case-insensitive match on id or label. */
function findProfile(
	profiles: readonly RotatorProfileConfig[],
	argument: string,
): RotatorProfileConfig | undefined {
	const needle = argument.toLowerCase();
	return profiles.find((profile) => profile.id === argument)
		?? profiles.find((profile) => profile.label === argument)
		?? profiles.find((profile) => profile.id.toLowerCase() === needle)
		?? profiles.find((profile) => profile.label.toLowerCase() === needle);
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
	now: () => number;
	fetchUsage: FetchUsage;
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
	const nowMs = deps.now();
	const lines: string[] = [`Probing ${targets.length} profile(s)…`];

	for (const profile of targets) {
		let identityText: string;
		try {
			const result = await host.probeProfile({
				profile: { profileId: profile.id, label: profile.label, configDir: profile.configDir },
				cwd,
				deadlineMs: PROBE_REFRESH_DEADLINE_MS,
			});
			const identity = result.identity;
			if (identity === undefined || !hasIdentity(identity)) {
				// An empty result is a normal deadline/empty-probe outcome, not an error.
				identityText = "no identity reported";
			} else {
				router?.recordIdentity(profile.id, toIdentity(identity));
				identityText = formatIdentity(identity);
			}
		} catch (error) {
			// One profile failing must not abort the others.
			identityText = `probe failed — ${describeError(error)}`;
		}
		// The probe has just run the official CLI under this config dir, so a fresh
		// usage poll (same seam status uses) can see a refreshed access token.
		const usageResult = await deps.fetchUsage({ configDir: profile.configDir });
		router?.recordPlanUsage(profile.id, usageResult);
		const usageLine = formatUsageLine(router?.planUsage(profile.id), profile.id, nowMs);
		const usageSuffix = usageLine !== undefined ? ` · ${usageLine}` : "";
		lines.push(`• ${profile.label} (${profile.id}): ${identityText}${usageSuffix}`);
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
	const match = findProfile(config.profiles, argument);
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

/** Human duration: minutes below an hour, hours below a day, days above it.
 *  Output for the minute/hour ranges must stay stable; existing callers and
 *  tests depend on `5m`, `2h`, and `2h10m`. */
function formatDuration(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
	const days = Math.floor(hours / 24);
	const restHours = hours % 24;
	return restHours === 0 ? `${days}d` : `${days}d${restHours}h`;
}

function formatIdentity(identity: {
	email?: string | undefined;
	organization?: string | undefined;
	subscriptionType?: string | undefined;
}): string {
	const parts: string[] = [];
	if (identity.email !== undefined) parts.push(identity.email);
	if (identity.organization !== undefined) parts.push(identity.organization);
	if (identity.subscriptionType !== undefined) parts.push(identity.subscriptionType);
	return parts.length > 0 ? parts.join(" · ") : "unknown";
}

// --- Plan-usage rendering ---------------------------------------------------

const USAGE_WINDOW_LABELS: Record<UsageWindowName, string> = {
	five_hour: "5h",
	seven_day: "weekly",
	seven_day_opus: "opus",
	seven_day_sonnet: "sonnet",
};

/** Render one usage window. `withResets` is false for the `last known …` line,
 *  which shows values only. A 5-hour window that has not started has no reset
 *  time, so it is labeled explicitly. */
function formatUsageWindow(
	name: UsageWindowName,
	window: UsageWindow,
	nowMs: number,
	withResets: boolean,
): string {
	const label = USAGE_WINDOW_LABELS[name];
	const percent = window.utilization === null ? "n/a" : `${window.utilization}%`;
	if (!withResets) return `${label} ${percent}`;
	if (name === "five_hour" && window.resetsAtMs === null) return `${label} ${percent} (window not started)`;
	if (window.resetsAtMs === null) return `${label} ${percent}`;
	return `${label} ${percent} (resets in ${formatDuration(window.resetsAtMs - nowMs)})`;
}

/** Ordered `5h · weekly · opus · sonnet` summary. Opus/sonnet appear only when
 *  their window is present AND carries a utilization number. */
function formatUsageWindows(
	windows: Partial<Record<UsageWindowName, UsageWindow>>,
	nowMs: number,
	withResets: boolean,
): string {
	const parts: string[] = [];
	for (const name of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const) {
		const window = windows[name];
		if (window === undefined) continue;
		if ((name === "seven_day_opus" || name === "seven_day_sonnet") && window.utilization === null) continue;
		parts.push(formatUsageWindow(name, window, nowMs, withResets));
	}
	return parts.join(" · ") || "no usage windows reported";
}

/** First plan-usage line for a profile: the success summary or the failure
 *  reason. `undefined` when nothing was recorded. */
function formatUsageLine(
	record: ProfileUsageRecord | undefined,
	profileId: string,
	nowMs: number,
): string | undefined {
	if (record === undefined) return undefined;
	if (record.lastError !== undefined) return `usage: unavailable — ${usageFailureText(record.lastError, profileId)}`;
	if (record.snapshot === undefined) return undefined;
	return `usage: ${formatUsageWindows(record.snapshot.windows, nowMs, true)}`;
}

/** Usage line built straight from an existing snapshot, ignoring any `lastError`
 *  recorded after it. Used when status reuses a fresh shared snapshot or when
 *  another process holds the fetch lease. */
function formatSnapshotLine(record: ProfileUsageRecord | undefined, nowMs: number): string | undefined {
	if (record?.snapshot === undefined) return undefined;
	return `usage: ${formatUsageWindows(record.snapshot.windows, nowMs, true)}`;
}

/** Rate-limit line shown while a 429 backoff is active. */
function formatRateLimitedLine(retryAtMs: number | undefined, nowMs: number): string {
	if (retryAtMs === undefined || retryAtMs <= nowMs) {
		return "usage: unavailable — usage endpoint rate limited";
	}
	return `usage: unavailable — usage endpoint rate limited, retrying in ${formatDuration(retryAtMs - nowMs)}`;
}

/** `last known …` line built from any snapshot, even when the record carries no
 *  `lastError`. */
function formatLastKnownSnapshotLine(record: ProfileUsageRecord | undefined, nowMs: number): string | undefined {
	if (record?.snapshot === undefined) return undefined;
	const age = formatDuration(Math.max(0, nowMs - record.snapshot.fetchedAtMs));
	return `  last known ${age} ago: ${formatUsageWindows(record.snapshot.windows, nowMs, false)}`;
}

interface UsageStatusLines {
	usageLine?: string | undefined;
	lastKnownLine?: string | undefined;
}

/** Pick the usage and last-known lines for one profile from its stored record
 *  and the shared-fetch claim that produced (or skipped) this status fetch. */
function statusUsageLines(
	record: ProfileUsageRecord | undefined,
	profileId: string,
	claim: UsageFetchClaim | undefined,
	nowMs: number,
): UsageStatusLines {
	if (claim !== undefined && claim.fetch === false) {
		if (claim.reason === "backoff") {
			return {
				usageLine: formatRateLimitedLine(claim.retryAtMs, nowMs),
				lastKnownLine: formatLastKnownSnapshotLine(record, nowMs),
			};
		}
		// Fresh or lease-held: another process just fetched or is fetching, so render
		// the last known snapshot instead of a stale error.
		const snapshotLine = formatSnapshotLine(record, nowMs);
		if (snapshotLine !== undefined) return { usageLine: snapshotLine };
	}
	return {
		usageLine: formatUsageLine(record, profileId, nowMs),
		lastKnownLine: formatLastKnownLine(record, nowMs),
	};
}

/** Continuation line shown when a refresh failed but a snapshot exists. */
function formatLastKnownLine(record: ProfileUsageRecord | undefined, nowMs: number): string | undefined {
	if (record?.lastError === undefined) return undefined;
	return formatLastKnownSnapshotLine(record, nowMs);
}

function usageFailureText(error: ProfileUsageError, profileId: string): string {
	switch (error.reason) {
		case "no-credentials":
			return `no credentials — run /claude-accounts login ${profileId}`;
		case "token-expired":
			return `access token expired — use this account once, or run /claude-accounts probe ${profileId}`;
		case "unauthorized":
			return `unauthorized — run /claude-accounts login ${profileId} if this persists`;
		case "http-error":
			return `usage endpoint returned HTTP ${error.httpStatus ?? "?"}`;
		case "network":
			return "network error";
		case "timeout":
			return "timed out after 5s";
		case "malformed":
			return "unexpected usage response";
	}
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
