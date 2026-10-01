import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { cleanupTempDirs, makeTempDir } from "./helpers.js";
import {
	DEFAULT_POLICY,
	expandHomePath,
	loadConfig,
	piAgentDir,
	RotatorConfigError,
	ROTATOR_CONFIG_FILENAME,
} from "../src/config.js";

afterEach(cleanupTempDirs);

function writeConfig(dir: string, value: unknown): string {
	const configPath = join(dir, ROTATOR_CONFIG_FILENAME);
	writeFileSync(configPath, typeof value === "string" ? value : JSON.stringify(value, null, 2));
	return configPath;
}

describe("loadConfig", () => {
	it("loads profiles, policy, and the config path", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, {
			policy: "balanced",
			profiles: [
				{ id: "primary", label: "Primary", configDir: "/tmp/accounts/primary" },
				{ id: "secondary", label: "Secondary", configDir: "/tmp/accounts/secondary" },
			],
		});

		const config = loadConfig({ configPath });

		expect(config.policy).toBe("balanced");
		expect(config.path).toBe(configPath);
		expect(config.profiles.map((entry) => entry.id)).toEqual(["primary", "secondary"]);
		expect(config.profiles[0]?.label).toBe("Primary");
		expect(config.profiles[0]?.configDir).toBe("/tmp/accounts/primary");
	});

	it("defaults an absent policy to balanced", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, { profiles: [{ id: "a", configDir: "/tmp/accounts/a" }] });

		const config = loadConfig({ configPath });

		expect(config.policy).toBe(DEFAULT_POLICY);
	});

	it("falls back to the profile id when no label is given", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, { profiles: [{ id: "work", configDir: "/tmp/accounts/work" }] });

		expect(loadConfig({ configPath }).profiles[0]?.label).toBe("work");
	});

	it("rejects an unknown policy and names the file", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, {
			policy: "sticky",
			profiles: [{ id: "a", configDir: "/tmp/accounts/a" }],
		});

		expect(() => loadConfig({ configPath })).toThrow(RotatorConfigError);
		expect(() => loadConfig({ configPath })).toThrow(configPath);
		expect(() => loadConfig({ configPath })).toThrow(/unsupported policy/);
	});

	it("names the path when the config file is missing", () => {
		const dir = makeTempDir();
		const configPath = join(dir, ROTATOR_CONFIG_FILENAME);

		expect(() => loadConfig({ configPath })).toThrow(RotatorConfigError);
		expect(() => loadConfig({ configPath })).toThrow(configPath);
	});

	it("names the path when the config file is not valid JSON", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, "{ profiles: [ }");

		expect(() => loadConfig({ configPath })).toThrow(RotatorConfigError);
		expect(() => loadConfig({ configPath })).toThrow(configPath);
		expect(() => loadConfig({ configPath })).toThrow(/not valid JSON/);
	});

	it("rejects a missing profiles array and names the path", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, { policy: "balanced" });

		expect(() => loadConfig({ configPath })).toThrow(RotatorConfigError);
		expect(() => loadConfig({ configPath })).toThrow(configPath);
		expect(() => loadConfig({ configPath })).toThrow(/non-empty "profiles" array/);
	});

	it("rejects an empty profiles array and names the path", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, { profiles: [] });

		expect(() => loadConfig({ configPath })).toThrow(RotatorConfigError);
		expect(() => loadConfig({ configPath })).toThrow(configPath);
	});

	it("rejects duplicate profile ids and names them", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, {
			profiles: [
				{ id: "dup", configDir: "/tmp/accounts/one" },
				{ id: "dup", configDir: "/tmp/accounts/two" },
			],
		});

		expect(() => loadConfig({ configPath })).toThrow(RotatorConfigError);
		expect(() => loadConfig({ configPath })).toThrow(/duplicate profile id "dup"/);
	});

	it("rejects a profile without an id or configDir", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, { profiles: [{ id: "a" }] });

		expect(() => loadConfig({ configPath })).toThrow(/profiles\[0\]\.configDir/);
	});

	it("expands a leading ~ in configDir to an absolute path", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, {
			profiles: [{ id: "a", configDir: "~/claude-profiles/a" }],
		});

		const configDir = loadConfig({ configPath }).profiles[0]?.configDir;

		expect(configDir).toBe(join(homedir(), "claude-profiles/a"));
		expect(isAbsolute(configDir ?? "")).toBe(true);
		expect(configDir).not.toContain("~");
	});

	it("resolves a relative configDir to an absolute path", () => {
		const dir = makeTempDir();
		const configPath = writeConfig(dir, { profiles: [{ id: "a", configDir: "relative/accounts/a" }] });

		const configDir = loadConfig({ configPath }).profiles[0]?.configDir;

		expect(isAbsolute(configDir ?? "")).toBe(true);
		expect(configDir?.endsWith(join("relative", "accounts", "a"))).toBe(true);
	});

	it("loads from PI_CODING_AGENT_DIR when no path is given", () => {
		const dir = makeTempDir();
		writeConfig(dir, { profiles: [{ id: "a", configDir: "/tmp/accounts/a" }] });

		const config = loadConfig({ env: { PI_CODING_AGENT_DIR: dir } });

		expect(config.path).toBe(join(dir, ROTATOR_CONFIG_FILENAME));
		expect(config.profiles).toHaveLength(1);
	});

	it("prefers an explicit configPath over PI_CODING_AGENT_DIR", () => {
		const envDir = makeTempDir();
		const explicitDir = makeTempDir();
		writeConfig(envDir, { profiles: [{ id: "env", configDir: "/tmp/accounts/env" }] });
		const configPath = writeConfig(explicitDir, { profiles: [{ id: "explicit", configDir: "/tmp/accounts/explicit" }] });

		const config = loadConfig({ configPath, env: { PI_CODING_AGENT_DIR: envDir } });

		expect(config.profiles.map((entry) => entry.id)).toEqual(["explicit"]);
	});
});

describe("path helpers", () => {
	it("resolves the agent dir from the environment, else the home default", () => {
		expect(piAgentDir({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" })).toBe("/tmp/agent-dir");
		expect(piAgentDir({ PI_CODING_AGENT_DIR: "   " })).toBe(join(homedir(), ".pi", "agent"));
		expect(piAgentDir({})).toBe(join(homedir(), ".pi", "agent"));
	});

	it("expands only a leading tilde segment", () => {
		expect(expandHomePath("~", "/home/tester")).toBe("/home/tester");
		expect(expandHomePath("~/claude-a", "/home/tester")).toBe("/home/tester/claude-a");
		expect(expandHomePath("/already/absolute", "/home/tester")).toBe("/already/absolute");
		expect(expandHomePath("/tmp/~not-home", "/home/tester")).toBe("/tmp/~not-home");
	});
});
