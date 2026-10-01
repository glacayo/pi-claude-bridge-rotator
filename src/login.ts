// OAuth login driver for `/claude-accounts login`.
//
// Spawns `claude auth login --claudeai` under a profile's `CLAUDE_CONFIG_DIR`,
// captures the authorize URL the CLI prints, and exposes a handle the command
// uses to forward the pasted code on the child's stdin. The CLI opens the
// browser itself, so the complete OAuth flow runs without a terminal handover.
//
// Fully injectable: tests supply a fake `spawnImpl`, so no real child process
// is ever spawned. Node builtins only; no pi or bridge runtime dependency.

import { spawn } from "node:child_process";

export const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const URL_PATTERN = /https:\/\/\S+/;
const OAUTH_MARKER = "oauth/authorize";

/** Minimal structural view of a read stream we listen to for `data`. */
export interface LoginStream {
	on(event: "data", listener: (chunk: unknown) => void): void;
}

/** Minimal structural view of the child's stdin. */
export interface LoginStdin {
	write(chunk: string): void;
}

/** Minimal structural view of a spawned login child, satisfied by node's
 *  `ChildProcessWithoutNullStreams` at runtime. */
export interface SpawnedLoginProcess {
	stdout: LoginStream | null;
	stderr: LoginStream | null;
	stdin: LoginStdin | null;
	on(event: string, listener: (...args: unknown[]) => void): void;
	kill(signal?: string): boolean;
}

export interface SpawnLoginOptions {
	env: NodeJS.ProcessEnv;
	stdio: readonly ["pipe", "pipe", "pipe"];
}

export type SpawnImpl = (
	command: string,
	args: readonly string[],
	options: SpawnLoginOptions,
) => SpawnedLoginProcess;

// SAFETY: node's `spawn` returns a richer `ChildProcess` whose `kill`/stream
// signatures are narrower than this deliberately minimal structural view; at
// runtime the returned object always satisfies it.
const defaultSpawn = spawn as unknown as SpawnImpl;

export interface StartClaudeLoginOptions {
	/** Absolute `CLAUDE_CONFIG_DIR` for the account being authenticated. */
	configDir: string;
	env?: NodeJS.ProcessEnv | undefined;
	spawnImpl?: SpawnImpl | undefined;
	/** Whole-lifetime bound; default 10 minutes. */
	timeoutMs?: number | undefined;
	/** Receives every line except the captured authorize URL. */
	onOutput?: ((line: string) => void) | undefined;
}

export interface ClaudeLoginHandle {
	url: string;
	submitCode(code: string): Promise<{ ok: boolean; output: string }>;
	cancel(): void;
}

/** Spawn `claude auth login --claudeai` and resolve once the OAuth authorize
 *  URL is printed. Rejects with a friendly error on spawn failure or timeout. */
export function startClaudeLogin(options: StartClaudeLoginOptions): Promise<ClaudeLoginHandle> {
	const spawnImpl = options.spawnImpl ?? defaultSpawn;
	const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
	const onOutput = options.onOutput ?? ((): void => {});
	const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), CLAUDE_CONFIG_DIR: options.configDir };

	return new Promise<ClaudeLoginHandle>((resolve, reject) => {
		let child: SpawnedLoginProcess;
		try {
			child = spawnImpl("claude", ["auth", "login", "--claudeai"], {
				env,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			reject(friendlySpawnError(error));
			return;
		}

		const outputLines: string[] = [];
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let url: string | undefined;
		let settled = false;
		let timedOut = false;
		let exitCode: number | undefined;

		let resolveExit!: (code: number) => void;
		const exitPromise = new Promise<number>((res) => {
			resolveExit = res;
		});

		const tail = (): string => outputLines.slice(-12).join("\n");

		const timer = setTimeout(() => {
			timedOut = true;
			if (!settled) {
				settled = true;
				reject(new Error(`claude auth login timed out after ${Math.round(timeoutMs / 1000)}s.`));
			}
			child.kill();
		}, timeoutMs);
		timer.unref();

		const makeHandle = (): ClaudeLoginHandle => ({
			url: url ?? "",
			async submitCode(code: string): Promise<{ ok: boolean; output: string }> {
				if (timedOut) return { ok: false, output: tail() };
				if (child.stdin === null) return { ok: false, output: "claude auth login is not accepting input." };
				try {
					child.stdin.write(`${code}\n`);
				} catch (error) {
					return { ok: false, output: describeError(error) };
				}
				const code_ = await exitPromise;
				return { ok: code_ === 0, output: tail() };
			},
			cancel(): void {
				clearTimeout(timer);
				child.kill();
			},
		});

		const record = (line: string): void => {
			outputLines.push(line);
			onOutput(line);
		};

		const handleLine = (rawLine: string): void => {
			const line = rawLine.replace(/\r$/, "");
			const match = URL_PATTERN.exec(line);
			if (match !== null && match[0].includes(OAUTH_MARKER)) {
				if (url === undefined) url = match[0];
				if (!settled) {
					settled = true;
					resolve(makeHandle());
				}
				return;
			}
			if (line.length > 0) record(line);
		};

		const drain = (which: "stdout" | "stderr", chunk: unknown): void => {
			const buffer = (which === "stdout" ? stdoutBuffer : stderrBuffer) + chunkToString(chunk);
			const lines = buffer.split("\n");
			const rest = lines.pop() ?? "";
			if (which === "stdout") stdoutBuffer = rest;
			else stderrBuffer = rest;
			for (const line of lines) handleLine(line);
		};

		const onExit = (code: unknown): void => {
			if (exitCode !== undefined) return;
			exitCode = typeof code === "number" ? code : -1;
			clearTimeout(timer);
			resolveExit(exitCode);
			if (!settled) {
				settled = true;
				reject(new Error(`claude auth login exited before printing a sign-in URL (exit code ${exitCode}).`));
			}
		};

		child.stdout?.on("data", (chunk) => drain("stdout", chunk));
		child.stderr?.on("data", (chunk) => drain("stderr", chunk));
		child.on("error", (error: unknown) => {
			const friendly = friendlySpawnError(error);
			record(friendly.message);
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(friendly);
			}
			child.kill();
		});
		child.on("exit", onExit);
		child.on("close", onExit);
	});
}

function chunkToString(chunk: unknown): string {
	if (typeof chunk === "string") return chunk;
	if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
	return String(chunk);
}

function friendlySpawnError(error: unknown): Error {
	const code = (error as { code?: unknown } | null | undefined)?.code;
	const message = describeError(error);
	if (code === "ENOENT" || /\bENOENT\b/.test(message)) {
		return new Error(`claude CLI not found on PATH; install Claude Code and retry (${message}).`);
	}
	return new Error(`could not start "claude auth login": ${message}`);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
