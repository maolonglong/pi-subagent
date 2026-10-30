import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { writeMetadata, updateRunState, writeTerminal } from "../shared.ts";

const root = resolve(import.meta.dirname, "..");
for (const denied of [false, true]) {
 test(`Rex tab switching targets the app and reports client rejection: denied=${denied}`, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-rex-focus-"));
  t.diagnostic(`Evidence: ${dir}`);
  const bin = join(dir, "bin"), runDir = join(dir, "subagents", "abcdef"); mkdirSync(bin);
  const now = new Date().toISOString();
  writeMetadata({ version: 2, backend: "rex", handle: "abcdef", runDir, sessionFile: join(runDir, "session.jsonl"), cwd: dir, provider: "fixture", model: "fixture", thinking: "off", createdAt: now, updatedAt: now });
  updateRunState(runDir, { state: "idle", hasStarted: true, childSessionId: "fixture", pid: 123 });
  writeTerminal(runDir, { socketPath: "unix:///fixture#instance", rexSession: "session:test", phase: "ready", terminalId: "block:child" });
  writeFileSync(join(bin, "rex"), `#!${process.execPath}
import {appendFileSync} from 'node:fs';
const args=process.argv.slice(5);
appendFileSync(${JSON.stringify(join(dir, "commands.jsonl"))},JSON.stringify(args)+'\\n');
let result={};
if(args[0]==='whoami')result={endpoint:'unix:///fixture',instance_id:'instance',session_id:'session:test'};
if(args[0]==='block'&&args[1]==='ls')result={blocks:[{block_id:'block:child',window_id:'window:moved-child',creator_name:'com.superlogical.terminal'}]};
if(args[0]==='block'&&args[1]==='call')result={child:{pid:123},foreground:{pid:123},last_exit:null};
if(args[0]==='do'&&${JSON.stringify(denied)}){console.error('Rex.app is not accepting actions. Turn on Remote Control in its Settings under Rex Server.');process.exit(1);}
console.log(JSON.stringify(result));
`, { mode: 0o700 });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readMetadata,focusRun} from ${JSON.stringify(join(root, "shared.ts"))};await focusRun(readMetadata(${JSON.stringify(runDir)}));`], {
   env: { ...process.env, HERDR_ENV: "", REX_SESSION: "session:test", REX_BLOCK: "block:parent", PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 10000,
  });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
  const commands = readFileSync(join(dir, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(commands.find((args) => args[0] === "do"), ["do", "session.select", "session_id=session:test", "window_id=window:moved-child"]);
  assert.equal(result.status, denied ? 1 : 0, result.stderr);
  if (denied) assert.match(result.stderr, /Remote Control/);
 });
}
