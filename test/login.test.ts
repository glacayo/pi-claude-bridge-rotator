// OAuth login driver tests. A fake `spawnImpl` returns an EventEmitter-based
// child, so no real `claude` process is ever spawned.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { startClaudeLogin } from "../src/login.js";
import type { SpawnImpl, SpawnLoginOptions, SpawnedLoginProcess } from "../src/login.js";

class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly written: string[] = [];
	killed = false;
	readonly stdin = {
		write: (chunk: string): boolean => {
			this.written.push(chunk);
			return true;
		},
	};

	kill(): boolean {
		this.killed = true;
		this.emit("exit", 1);
		return true;
	}
}

interface SpawnCapture {
	child: FakeChild;
	command: string;
	args: readonly string[];
	options: SpawnLoginOptions | undefined;
}

function captureSpawn(): { spawnImpl: SpawnImpl; captured: SpawnCapture } {
	const captured: SpawnCapture = { child: new FakeChild(), command: "", args: [], options: undefined };
	const spawnImpl: SpawnImpl = (command, args, options) => {
		captured.command = command;
		captured.args = args;
		captured.options = options;
		return captured.child as unknown as SpawnedLoginProcess;
	};
	return { spawnImpl, captured };
}

function output(child: FakeChild, line: string): void {
	child.stdout.emit("data", Buffer.from(line));
}

describe("startClaudeLogin", () => {
	it("spawns `claude auth login --claudeai` with CLAUDE_CONFIG_DIR set", async () => {
		const { spawnImpl, captured } = captureSpawn();
		const relayed: string[] = [];
		const promise = startClaudeLogin({
			configDir: "/abs/acc",
			spawnImpl,
			onOutput: (line) => relayed.push(line),
		});
		output(captured.child, "Opening browser to sign in…\n");
		output(captured.child, "https://claude.ai/oauth/authorize?code=xyz\n");
		const handle = await promise;

		expect(captured.command).toBe("claude");
		expect(captured.args).toEqual(["auth", "login", "--claudeai"]);
		expect(captured.options?.env.CLAUDE_CONFIG_DIR).toBe("/abs/acc");
		expect(handle.url).toBe("https://claude.ai/oauth/authorize?code=xyz");
		expect(relayed).toEqual(["Opening browser to sign in…"]);
	});

	it("ignores URLs without the oauth/authorize marker and relays them", async () => {
		const { spawnImpl, captured } = captureSpawn();
		const relayed: string[] = [];
		const promise = startClaudeLogin({ configDir: "/abs/acc", spawnImpl, onOutput: (l) => relayed.push(l) });
		output(captured.child, "See https://example.com/help for details\n");
		output(captured.child, "https://claude.ai/oauth/authorize?ok=1\n");
		const handle = await promise;

		expect(handle.url).toBe("https://claude.ai/oauth/authorize?ok=1");
		expect(relayed).toEqual(["See https://example.com/help for details"]);
	});

	it("captures the first authorize URL only", async () => {
		const { spawnImpl, captured } = captureSpawn();
		const promise = startClaudeLogin({ configDir: "/abs/acc", spawnImpl });
		output(captured.child, "https://claude.ai/oauth/authorize?first=1\n");
		output(captured.child, "https://claude.ai/oauth/authorize?second=2\n");
		const handle = await promise;
		expect(handle.url).toBe("https://claude.ai/oauth/authorize?first=1");
	});

	it("submits the code on stdin and reports success on exit 0", async () => {
		const { spawnImpl, captured } = captureSpawn();
		const promise = startClaudeLogin({ configDir: "/abs/acc", spawnImpl });
		output(captured.child, "https://claude.ai/oauth/authorize?x=1\n");
		const handle = await promise;

		const submit = handle.submitCode("123456");
		expect(captured.child.written).toEqual(["123456\n"]);
		output(captured.child, "Login successful\n");
		captured.child.emit("exit", 0);
		const result = await submit;

		expect(result.ok).toBe(true);
		expect(result.output).toContain("Login successful");
	});

	it("reports failure when the child exits non-zero", async () => {
		const { spawnImpl, captured } = captureSpawn();
		const promise = startClaudeLogin({ configDir: "/abs/acc", spawnImpl });
		output(captured.child, "https://claude.ai/oauth/authorize?x=1\n");
		output(captured.child, "invalid code\n");
		const handle = await promise;

		const submit = handle.submitCode("bad");
		captured.child.emit("exit", 1);
		const result = await submit;

		expect(result.ok).toBe(false);
		expect(result.output).toContain("invalid code");
	});

	it("cancels by killing the child", async () => {
		const { spawnImpl, captured } = captureSpawn();
		const promise = startClaudeLogin({ configDir: "/abs/acc", spawnImpl });
		output(captured.child, "https://claude.ai/oauth/authorize?x=1\n");
		const handle = await promise;

		handle.cancel();

		expect(captured.child.killed).toBe(true);
	});

	it("surfaces an ENOENT error event as a friendly rejection", async () => {
		const { spawnImpl, captured } = captureSpawn();
		const promise = startClaudeLogin({ configDir: "/abs/acc", spawnImpl });
		const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
		captured.child.emit("error", error);

		await expect(promise).rejects.toThrow(/claude CLI not found on PATH/);
	});

	it("surfaces a synchronous spawn throw as a friendly rejection", async () => {
		const spawnImpl: SpawnImpl = () => {
			throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
		};
		await expect(startClaudeLogin({ configDir: "/abs/acc", spawnImpl })).rejects.toThrow(
			/claude CLI not found on PATH/,
		);
	});

	it("rejects on the whole-lifetime timeout and kills the child", async () => {
		const { spawnImpl, captured } = captureSpawn();
		const promise = startClaudeLogin({ configDir: "/abs/acc", spawnImpl, timeoutMs: 5 });

		await expect(promise).rejects.toThrow(/timed out/);
		expect(captured.child.killed).toBe(true);
	});
});
