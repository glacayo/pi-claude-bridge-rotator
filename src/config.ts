// Rotator configuration loading.
//
// The rotator reads a single JSON file from the Pi agent directory:
//
//   ${PI_CODING_AGENT_DIR || ~/.pi/agent}/claude-bridge-rotator.json
//
// Shape: { "policy": "balanced", "profiles": [{ "id", "label", "configDir" }] }
//
// Every path is injectable so tests never read or write the real agent dir.
// `configDir` is tilde-expanded to an absolute path here: the bridge hands the
// value straight to the child as `CLAUDE_CONFIG_DIR` and never expands `~`.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const ROTATOR_CONFIG_FILENAME = "claude-bridge-rotator.json";

/** v1 ships exactly one policy. Multi-policy runtime switching is a documented
 *  non-goal, so an unknown value is rejected instead of silently ignored. */
export const SUPPORTED_POLICIES = ["balanced"] as const;
export type RotatorPolicy = (typeof SUPPORTED_POLICIES)[number];
export const DEFAULT_POLICY: RotatorPolicy = "balanced";

export interface RotatorProfileConfig {
	id: string;
	label: string;
	/** Absolute Claude config dir (`CLAUDE_CONFIG_DIR`). */
	configDir: string;
}

export interface RotatorConfig {
	policy: RotatorPolicy;
	profiles: RotatorProfileConfig[];
	/** Absolute path the config was loaded from (used in status output). */
	path: string;
}

/** Config is operator-authored input: every failure must name the file and the
 *  offending field so a bad edit is fixable without reading this module. */
export class RotatorConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RotatorConfigError";
	}
}

export interface ConfigLoadOptions {
	/** Explicit config file path; wins over `env`. */
	configPath?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
}

/** `${PI_CODING_AGENT_DIR}` when set and non-empty, else `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
	return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".pi", "agent");
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(piAgentDir(env), ROTATOR_CONFIG_FILENAME);
}

/** Expand a leading `~` to `home` and force an absolute result. A literal `~`
 *  left in `configDir` would make the child create a directory named "~". */
export function expandHomePath(input: string, home: string = homedir()): string {
	const trimmed = input.trim();
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(home, trimmed.slice(2));
	return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function requireNonEmptyString(value: unknown, field: string, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new RotatorConfigError(`Rotator config at ${path}: "${field}" must be a non-empty string.`);
	}
	return value.trim();
}

function optionalNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function loadConfig(options: ConfigLoadOptions = {}): RotatorConfig {
	const env = options.env ?? process.env;
	const path = resolve(options.configPath ?? defaultConfigPath(env));

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new RotatorConfigError(
			`Cannot read rotator config at ${path} (${describeError(error)}). `
				+ 'Create it with a "profiles" array, e.g. { "profiles": [{ "id": "a", "label": "A", "configDir": "~/.claude-a" }] }.',
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new RotatorConfigError(`Rotator config at ${path} is not valid JSON: ${describeError(error)}`);
	}
	if (!isRecord(parsed)) {
		throw new RotatorConfigError(`Rotator config at ${path} must be a JSON object.`);
	}

	const policy = parsePolicy(parsed.policy, path);
	const profilesRaw = parsed.profiles;
	if (!Array.isArray(profilesRaw) || profilesRaw.length === 0) {
		throw new RotatorConfigError(`Rotator config at ${path} must define a non-empty "profiles" array.`);
	}

	const profiles: RotatorProfileConfig[] = [];
	const seenIds = new Map<string, number>();
	profilesRaw.forEach((entry, index) => {
		if (!isRecord(entry)) {
			throw new RotatorConfigError(`Rotator config at ${path}: profiles[${index}] must be an object.`);
		}
		const id = requireNonEmptyString(entry.id, `profiles[${index}].id`, path);
		const configDir = expandHomePath(requireNonEmptyString(entry.configDir, `profiles[${index}].configDir`, path));
		const duplicateAt = seenIds.get(id);
		if (duplicateAt !== undefined) {
			throw new RotatorConfigError(
				`Rotator config at ${path}: duplicate profile id "${id}" at profiles[${duplicateAt}] and profiles[${index}]; `
					+ "profile ids must be unique because they are the stable rotation keys.",
			);
		}
		seenIds.set(id, index);
		profiles.push({ id, label: optionalNonEmptyString(entry.label) ?? id, configDir });
	});

	return { policy, profiles, path };
}

function parsePolicy(value: unknown, path: string): RotatorPolicy {
	if (value === undefined || value === null) return DEFAULT_POLICY;
	if (typeof value === "string") {
		const candidate = value.trim() as RotatorPolicy;
		if ((SUPPORTED_POLICIES as readonly string[]).includes(candidate)) return candidate;
	}
	throw new RotatorConfigError(
		`Rotator config at ${path}: unsupported policy ${JSON.stringify(value)}; `
			+ `v1 supports: ${SUPPORTED_POLICIES.join(", ")}.`,
	);
}
