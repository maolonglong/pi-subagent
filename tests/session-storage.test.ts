import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { writeMetadata, writeTerminal } from "../shared.ts";

const root = resolve(import.meta.dirname, "..");
function fixture(t: TestContext) {
 const dir = mkdtempSync(join(tmpdir(), "pi-subagent-sessions-"));
 const bin = join(dir, "bin"); mkdirSync(bin); mkdirSync(join(dir, "project"));
 const cwd = realpathSync(join(dir, "project"));
 t.diagnostic(`Evidence: ${dir}`);
 writeFileSync(join(bin, "rex"), `#!${process.execPath}
import {existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(5),dir=${JSON.stringify(dir)};
let result={};
if(args[0]==='whoami')result={endpoint:'unix:///fixture',instance_id:'instance',session_id:'session:test'};
if(args[0]==='window'&&args[1]==='new'){
 const runDir=args.find(a=>a.startsWith('PI_SUBAGENT_RUN_DIR=')).slice('PI_SUBAGENT_RUN_DIR='.length);
 const file=args[args.indexOf('--session')+1];
 if(!readFileSync(file,'utf8').trim())writeFileSync(file,JSON.stringify({type:'session',version:3,id:'fixture-child',timestamp:'2026-10-30T00:00:00.000Z',cwd:${JSON.stringify(cwd)}})+'\\n');
 appendFileSync(file,JSON.stringify({type:'message',id:'answer',parentId:null,message:{role:'assistant',content:[{type:'text',text:'fixture done'}],stopReason:'stop'}})+'\\n');
 writeFileSync(runDir+'/state.json',JSON.stringify({state:'idle',hasStarted:true,pid:123,childSessionId:JSON.parse(readFileSync(file,'utf8').split('\\n')[0]).id}));
 writeFileSync(dir+'/live.json',JSON.stringify({runDir,file}));result={block_ids:['block:child']};
}
if(args[0]==='block'&&args[1]==='ls')result={blocks:existsSync(dir+'/live.json')&&!existsSync(dir+'/closed')?[{block_id:'block:child',window_id:'window:child',creator_name:'com.superlogical.terminal'}]:[]};
if(args[0]==='block'&&args[1]==='call')result={child:{pid:123},foreground:{pid:123},last_exit:null};
if(args[0]==='block'&&args[1]==='close')writeFileSync(dir+'/closed','yes');
console.log(JSON.stringify(result));
`, { mode: 0o700 });
 const env = { ...process.env, HERDR_ENV: "", REX_SESSION: "session:test", REX_BLOCK: "block:parent", PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_RUN_DIR: "", PI_SESSION_ID: "", PI_PROVIDER: "fixture", PI_MODEL: "fixture", PATH: `${bin}:${process.env.PATH}` };
 const reports: unknown[] = [];
 const cli = (args: string[], code = 0) => {
  const result = spawnSync(process.execPath, [join(root, "subagent.ts"), ...args], { env, cwd, encoding: "utf8", timeout: 10000 });
  reports.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr });
  writeFileSync(join(dir, "report.json"), JSON.stringify(reports, null, 2));
  assert.equal(result.status, code, result.stderr); return result;
 };
 const nativeDir = join(dir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
 return { dir, cwd, cli, nativeDir };
}
function legacy(f: ReturnType<typeof fixture>) {
 const runDir = join(f.dir, "subagents", "abcdef"), now = "2026-10-30T00:00:00.000Z";
 writeMetadata({ version: 2, backend: "rex", handle: "abcdef", runDir, sessionFile: join(runDir, "session.jsonl"), cwd: f.cwd, provider: "fixture", model: "fixture", thinking: "off", createdAt: now, updatedAt: now });
 writeTerminal(runDir, { socketPath: "unix:///fixture#instance", rexSession: "session:test", phase: "closed" });
 const contents = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: now, cwd: f.cwd }) + "\n" + JSON.stringify({ type: "message", id: "answer", parentId: null, message: { role: "assistant", content: [{ type: "text", text: "legacy answer" }], stopReason: "stop" } }) + "\n";
 const original = contents("legacy-session"), fork = contents("legacy-fork");
 writeFileSync(join(runDir, "session.jsonl"), original);
 writeFileSync(join(runDir, "fork.jsonl"), fork);
 const archived = join(f.nativeDir, "2026-10-30T00-00-00-000Z_legacy-session.jsonl");
 const archivedFork = join(f.nativeDir, "2026-10-30T00-00-00-000Z_legacy-fork.jsonl");
 return { runDir, original, fork, archived, archivedFork };
}

test("new runs persist native Pi sessions after stop and use unique files", (t) => {
 const f = fixture(t);
 const paths = new Set<string>();
 const alias = join(f.dir, "project-link"); symlinkSync(f.cwd, alias, "dir");
 for (let i = 0; i < 2; i++) {
  rmSync(join(f.dir, "closed"), { force: true });
  f.cli(["spawn", ...(i === 1 ? ["--cwd", alias] : []), "--prompt", "hello"]);
  const handles = readdirSync(join(f.dir, "subagents")); assert.equal(handles.length, 1);
  const runDir = join(f.dir, "subagents", handles[0]);
  const run = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8"));
  assert.equal(resolve(run.sessionFile, ".."), f.nativeDir);
  assert.equal(existsSync(join(runDir, "session.jsonl")), false);
  const bytes = readFileSync(run.sessionFile, "utf8"), header = JSON.parse(bytes.split("\n")[0]);
  assert.equal(header.type, "session"); assert.equal(header.cwd, f.cwd); assert.equal(header.version, 3);
  assert.equal(statSync(run.sessionFile).mode & 0o777, 0o600);
  assert.ok(run.sessionFile.endsWith(`_${header.id}.jsonl`));
  assert.equal(paths.has(run.sessionFile), false); paths.add(run.sessionFile);
  assert.match(f.cli(["wait", handles[0], "--timeout", "1"]).stdout, /fixture done/);
  f.cli(["stop", handles[0]]);
  assert.equal(existsSync(runDir), false);
  assert.equal(readFileSync(run.sessionFile, "utf8"), bytes);
 }
 assert.equal(readdirSync(f.nativeDir).filter((file) => file.endsWith(".jsonl")).length, 2);
});

test("stop archives every legacy run session without changing IDs or bytes", (t) => {
 const f = fixture(t), old = legacy(f);
 mkdirSync(f.nativeDir, { recursive: true });
 writeFileSync(old.archivedFork, old.fork);
 f.cli(["stop", "abcdef"]);
 assert.equal(existsSync(old.runDir), false);
 assert.equal(readFileSync(old.archived, "utf8"), old.original);
 assert.equal(readFileSync(old.archivedFork, "utf8"), old.fork);
 assert.equal(statSync(old.archived).mode & 0o777, 0o600);
 assert.equal(statSync(old.archivedFork).mode & 0o777, 0o600);
 assert.equal(readdirSync(f.nativeDir).length, 2);
});

for (const failure of ["storage", "conflict", "invalid-session"]) {
 test(`legacy archival failure preserves data and can be retried: ${failure}`, (t) => {
  const f = fixture(t), old = legacy(f);
  if (failure === "storage") writeFileSync(join(f.dir, "sessions"), "blocked storage");
  if (failure === "conflict") { mkdirSync(f.nativeDir, { recursive: true }); writeFileSync(old.archived, "existing different data"); }
  if (failure === "invalid-session") writeFileSync(join(old.runDir, "session.jsonl"), "invalid session data");
  f.cli(["stop", "abcdef"], 1);
  assert.ok(existsSync(old.runDir));
  assert.equal(readFileSync(join(old.runDir, "fork.jsonl"), "utf8"), old.fork);
  assert.equal(readFileSync(join(old.runDir, "session.jsonl"), "utf8"), failure === "invalid-session" ? "invalid session data" : old.original);
  if (failure === "storage") rmSync(join(f.dir, "sessions"));
  if (failure === "conflict") { assert.equal(readFileSync(old.archived, "utf8"), "existing different data"); rmSync(old.archived); }
  if (failure === "invalid-session") writeFileSync(join(old.runDir, "session.jsonl"), old.original);
  f.cli(["stop", "abcdef"]);
  assert.equal(existsSync(old.runDir), false);
  assert.equal(readFileSync(old.archived, "utf8"), old.original);
  assert.equal(readFileSync(old.archivedFork, "utf8"), old.fork);
 });
}
