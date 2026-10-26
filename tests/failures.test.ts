import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { writeMetadata, type RunMetadata } from "../shared.ts";

const root = resolve(import.meta.dirname, "..");
function metadata(dir: string): RunMetadata {
	const now = new Date().toISOString();
	return { version: 1, handle: "abcdef", rexSession: "test-session", runDir: dir, sessionFile: join(dir, "session.jsonl"), cwd: dir, provider: "test", model: "test", thinking: "off", state: "idle", hasStarted: false, createdAt: now, updatedAt: now };
}

test("spawn requires a Rex terminal and creates no run outside Rex", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-context-test-"));
	t.diagnostic(`Evidence: ${dir}`);
	const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir };
	delete env.REX_SESSION;
	delete env.REX_BLOCK;
	delete env.PI_SUBAGENT_RUN_DIR;
	const result = spawnSync(process.execPath, [join(root, "subagent.ts"), "spawn", "--prompt", "test"], { env, encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /inside a Rex terminal/);
	assert.equal(existsSync(join(dir, "subagents")), false);
	writeFileSync(join(dir, "result.json"), JSON.stringify({ passed: true, stderr: result.stderr }, null, 2));
});

test("unreachable Rex preserves run files; missing block is exited", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-unavailable-test-"));
	t.diagnostic(`Evidence: ${dir}`);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "rex"), '#!/bin/sh\necho "Rex fixture unavailable" >&2\nexit "${REX_TEST_EXIT:-1}"\n', { mode: 0o700 });
	const run = { ...metadata(join(dir, "subagents", "abcdef")), rexSession: "test-session", rexBlock: "test-block" };
	writeMetadata(run);
	const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: dir };
	const source = `import assert from 'node:assert/strict'; import { readMetadata, runIsRunning, effectiveRunState } from ${JSON.stringify(join(root, "shared.ts"))}; const run=readMetadata(${JSON.stringify(run.runDir)}); assert.equal(runIsRunning(run),undefined); assert.equal(effectiveRunState(run),'unavailable');`;
	const check = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env, encoding: "utf8" });
	assert.equal(check.status, 0, check.stderr);
	const stop = spawnSync(process.execPath, [join(root, "subagent.ts"), "stop", "abcdef"], { env, encoding: "utf8" });
	assert.equal(stop.status, 1);
	assert.match(stop.stderr, /preserved/);
	assert(existsSync(join(run.runDir, "metadata.json")));
	const missingSource = source.replace("runIsRunning(run),undefined", "runIsRunning(run),false").replace("effectiveRunState(run),'unavailable'", "effectiveRunState(run),'exited'");
	const missing = spawnSync(process.execPath, ["--input-type=module", "-e", missingSource], { env: { ...env, REX_TEST_EXIT: "3" }, encoding: "utf8" });
	assert.equal(missing.status, 0, missing.stderr);
	writeFileSync(join(dir, "result.json"), JSON.stringify({ passed: true, checks: ["unavailable differs from exited", "stop preserves metadata", "not-found is exited"] }, null, 2));
});
