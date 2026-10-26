import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");

test("CLI help succeeds without Rex or model configuration and creates no runs", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-help-test-"));
	t.diagnostic(`Evidence: ${dir}`);
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_RUN_DIR: dir };
	for (const key of ["REX_SESSION", "REX_BLOCK", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
	const results = [];
	try {
		for (const command of [undefined, "spawn", "status", "rename", "send", "wait", "stop", "list"]) {
			for (const flag of ["--help", "-h"]) {
				const args = command ? [command, flag] : [flag];
				const result = spawnSync(process.execPath, [join(root, "subagent.ts"), ...args], { env, encoding: "utf8", timeout: 10000 });
				results.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr });
				assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
				assert.equal(result.stderr, "");
				assert.match(result.stdout, /^Usage:\n/);
				assert.match(result.stdout, /subagent spawn/);
				assert.match(result.stdout, /--thinking <level>/);
			}
		}
		for (const args of [[], ["unknown"], ["unknown", "--help"], ["spawn", "--prompt", "--help"]]) {
			const result = spawnSync(process.execPath, [join(root, "subagent.ts"), ...args], { env, encoding: "utf8", timeout: 10000 });
			results.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr });
			assert.equal(result.status, 1, args.join(" "));
			assert.equal(result.stdout, "");
			assert.notEqual(result.stderr, "");
		}
		assert.equal(existsSync(join(dir, "subagents")), false);
	} finally {
		writeFileSync(join(dir, "result.json"), JSON.stringify(results, null, 2));
	}
});
