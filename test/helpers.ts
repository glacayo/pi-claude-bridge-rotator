// Shared test helpers. Temp dirs live under the OS temp root and are removed by
// `cleanupTempDirs`, registered as an `afterEach` hook in each test file, so no
// test ever touches the real `~/.pi/agent` directory.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RotatorProfileConfig } from "../src/config.js";

const createdDirs: string[] = [];

export function makeTempDir(prefix = "rotator-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	createdDirs.push(dir);
	return dir;
}

export function cleanupTempDirs(): void {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
}

export function profile(id: string, overrides: Partial<RotatorProfileConfig> = {}): RotatorProfileConfig {
	return { id, label: id.toUpperCase(), configDir: `/tmp/rotator-accounts/${id}`, ...overrides };
}
