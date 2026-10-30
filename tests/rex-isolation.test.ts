import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { writeMetadata, writeTerminal, updateRunState } from "../shared.ts";

const root = resolve(import.meta.dirname, "..");
for (const mode of ["unknown", "unreadable", "closed-during-query"]) {
 test(`Rex isolates a different terminal's process failure: ${mode}`, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-rex-isolation-"));
  t.diagnostic(`Evidence: ${dir}`);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const now = new Date().toISOString();
  for (const handle of ["abcdef", "fedcba"]) {
   const runDir = join(dir, "subagents", handle), sessionFile = join(runDir, "session.jsonl");
   writeMetadata({ version: 2, backend: "rex", handle, runDir, sessionFile, cwd: dir, provider: "fixture", model: "fixture", thinking: "off", createdAt: now, updatedAt: now });
   updateRunState(runDir, { state: "idle", hasStarted: true, childSessionId: handle, pid: handle === "abcdef" ? 123 : 456, outcome: "completed" });
   writeTerminal(runDir, { socketPath: "unix:///fixture#instance", rexSession: "session:test", phase: "ready", terminalId: `block:${handle}` });
   writeFileSync(sessionFile, JSON.stringify({ type: "message", id: "answer", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "fixture done" }], stopReason: "stop" } }) + "\n");
  }
  writeFileSync(join(bin, "rex"), `#!${process.execPath}
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(5),dir=${JSON.stringify(dir)},mode=${JSON.stringify(mode)};
appendFileSync(dir+'/commands.jsonl',JSON.stringify(args)+'\\n');
let result={};
if(args[0]==='whoami')result={endpoint:'unix:///fixture',instance_id:'instance',session_id:'session:test'};
if(args[0]==='block'&&args[1]==='ls')result={blocks:['abcdef','fedcba'].filter(id=>id!=='abcdef'||!existsSync(dir+'/closed')).map(id=>({block_id:'block:'+id,window_id:'window:'+id,creator_name:'com.superlogical.terminal'}))};
if(args[0]==='block'&&args[1]==='call'){
 if(args.includes('block:fedcba')){
  if(mode!=='unknown'){console.error(mode==='unreadable'?'process unavailable':'block not found');process.exit(mode==='unreadable'?1:3);}
  result={last_exit:null};
 }else result={child:{pid:123},foreground:{pid:123},last_exit:null};
}
if(args[0]==='block'&&args[1]==='close'){if(!args.includes('block:abcdef'))process.exit(99);writeFileSync(dir+'/closed','yes');}
console.log(JSON.stringify(result));
`, { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: "", REX_SESSION: "session:test", REX_BLOCK: "block:parent", PI_CODING_AGENT_DIR: dir, PI_SESSION_ID: "", PATH: `${bin}:${process.env.PATH}` };
  const reports: unknown[] = [];
  const cli = (args: string[], code = 0) => {
   const result = spawnSync(process.execPath, [join(root, "subagent.ts"), ...args], { env, encoding: "utf8", timeout: 10000 });
   reports.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr });
   writeFileSync(join(dir, "report.json"), JSON.stringify(reports, null, 2));
   assert.equal(result.status, code, result.stderr); return result;
  };
  assert.match(cli(["status", "abcdef"]).stdout, /abcdef: idle/);
  const listed = cli(["list"]).stdout;
  assert.match(listed, /abcdef\s+idle/);
  assert.match(listed, /fedcba\s+unavailable/);
  assert.match(cli(["wait", "abcdef", "--timeout", "1"]).stdout, /fixture done/);
  cli(["send", "abcdef", "follow-up"]);
  assert.ok(existsSync(join(dir, "subagents", "abcdef", "inbox")));
  assert.match(cli(["status", "fedcba"]).stdout, /unavailable/);
  cli(["stop", "fedcba"], 1);
  assert.equal(existsSync(join(dir, "closed")), false);
  cli(["stop", "abcdef"]);
  assert.equal(existsSync(join(dir, "subagents", "abcdef")), false);
  assert.ok(existsSync(join(dir, "subagents", "fedcba")));
  const commands = readFileSync(join(dir, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(commands.filter((args) => args[1] === "close"), [["block", "close", "-s", "session:test", "block:abcdef"]]);
 });
}
