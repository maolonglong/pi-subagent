import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readMetadata, writeMetadata, writeTerminal, updateRunState } from "../shared.ts";

const root = resolve(import.meta.dirname, "..");
for (const mode of ["unavailable", "changed-instance", "unknown-process", "lost-create", "lost-close"]) {
 test(`Rex preserves run data on uncertain backend operations: ${mode}`, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-rex-failure-"));
  t.diagnostic(`Evidence: ${dir}`);
  const bin = join(dir, "bin"), runDir = join(dir, "subagents", "abcdef"); mkdirSync(bin);
  const now = new Date().toISOString();
  writeMetadata({ version: 2, backend: "rex", handle: "abcdef", runDir, sessionFile: join(runDir, "session.jsonl"), cwd: dir, provider: "fixture", model: "fixture", thinking: "off", createdAt: now, updatedAt: now });
  writeFileSync(join(runDir, "session.jsonl"), "");
  updateRunState(runDir, { state: "idle", hasStarted: true, childSessionId: "fixture", pid: 123 });
  writeTerminal(runDir, { socketPath: "unix:///fixture#instance", rexSession: "session:test", phase: "ready", terminalId: "block:child" });
  writeFileSync(join(bin, "rex"), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2).slice(3),mode=${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(join(dir, "commands.jsonl"))},JSON.stringify(args)+'\\n');
if(mode==='unavailable'){console.error('fixture disconnected');process.exit(1);}
let result;
if(args[0]==='whoami') result={endpoint:'unix:///fixture',instance_id:mode==='changed-instance'?'new-instance':'instance',session_id:'session:test'};
if(args[0]==='block'&&args[1]==='ls') result={blocks:mode==='changed-instance'?[]:[{block_id:'block:child',window_id:'window:child',creator_name:'com.superlogical.terminal'}]};
if(args[0]==='block'&&args[1]==='call') result=mode==='unknown-process'?{last_exit:null}:{child:{pid:123},foreground:{pid:123},last_exit:null};
if(args[0]==='window'||args[1]==='close'){console.error('fixture lost reply');process.exit(1);}
console.log(JSON.stringify(result));
`, { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: "", REX_SESSION: "session:test", REX_BLOCK: "block:parent", PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_RUN_DIR: "", PI_PROVIDER: "fixture", PI_MODEL: "fixture", PATH: `${bin}:${process.env.PATH}` };
  const args = mode === "lost-create" ? [join(root, "subagent.ts"), "spawn", "--prompt", "fixture"] : mode === "lost-close" ? ["--input-type=module", "-e", `import {readMetadata,stopRun} from ${JSON.stringify(join(root, "shared.ts"))}; await stopRun(readMetadata(${JSON.stringify(runDir)}),true);`] : [join(root, "subagent.ts"), "stop", "abcdef"];
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 10000 });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.equal(result.status, 1, result.stderr);
  assert.ok(existsSync(runDir));
  if (mode === "lost-close") assert.equal(readMetadata(runDir)?.terminal?.suspended, true);
  if (mode === "lost-create") {
   const { stdout } = spawnSync(process.execPath, ["--input-type=module", "-e", `import {listRuns} from ${JSON.stringify(join(root, "shared.ts"))};console.log(JSON.stringify(listRuns()));`], { env, encoding: "utf8" });
   const failed = JSON.parse(stdout).find((run) => run.handle !== "abcdef");
   assert.equal(failed.terminal.phase, "uncertain"); assert.equal(failed.terminal.terminalId, undefined);
  }
  const commands = readFileSync(join(dir, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(commands.some((args) => args[1] === "close"), mode === "lost-close");
 });
}
