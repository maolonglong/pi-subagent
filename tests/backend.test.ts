import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as shared from "../shared.ts";

const root = resolve(import.meta.dirname, "..");

test("spawn requires a managed Herdr pane before creating a terminal or run", (t) => {
 const dir = mkdtempSync(join(tmpdir(), "pi-subagent-boundary-"));
 const bin = join(dir, "bin");
 mkdirSync(bin);
 const invoked = join(dir, "backend-invoked");
 writeFileSync(join(bin, "herdr"), `#!${process.execPath}
import {writeFileSync} from "node:fs";
writeFileSync(${JSON.stringify(invoked)}, "called");
console.error("unexpected Herdr invocation");
process.exit(99);
`, { mode: 0o700 });
 const result = spawnSync(process.execPath, [join(root, "subagent.ts"), "spawn", "--prompt", "fixture"], {
  env: { ...process.env, HERDR_ENV: "", PI_SUBAGENT_RUN_DIR: "", PI_CODING_AGENT_DIR: dir, PI_PROVIDER: "fixture", PI_MODEL: "fixture", PATH: `${bin}:${process.env.PATH}` },
  encoding: "utf8", timeout: 10000,
 });
 writeFileSync(join(dir, "result.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
 t.diagnostic(`Evidence: ${dir}`);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /Herdr/);
 assert.equal(existsSync(join(dir, "subagents")), false);
 assert.equal(existsSync(invoked), false);
});

test("child status stays separate from config and terminal control", (t) => {
 const dir = mkdtempSync(join(tmpdir(), "pi-subagent-storage-"));
 t.diagnostic(`Evidence: ${dir}`);
 const now = new Date().toISOString();
 const run: shared.RunConfig = { version: 2, backend: "herdr", handle: "abcdef", name: "before", runDir: dir, sessionFile: join(dir, "session.jsonl"), cwd: dir, provider: "fixture", model: "fixture", thinking: "off", createdAt: now, updatedAt: now };
 shared.writeMetadata(run);
 assert.equal(shared.readMetadata(dir)?.backend, "herdr");
 shared.updateRunState(dir, { state: "busy", hasStarted: true, pid: 123 });
 const staleChildState = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
 shared.updateMetadata(dir, { name: "after" });
 shared.writeTerminal(dir, { socketPath: "/tmp/fixture.sock", phase: "closed", suspended: true });
 shared.updateRunState(dir, { ...staleChildState, state: "idle" });
 const result = shared.readMetadata(dir);
 assert.equal(result.name, "after");
 assert.equal(result.terminal.suspended, true);
 assert.equal(result.state, "idle");
 assert.equal(JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8")).state, undefined);
 writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2));
});
