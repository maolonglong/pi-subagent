import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import * as shared from "../shared.ts";

const root = resolve(import.meta.dirname, "..");
function backendFixture(t: TestContext, mode: string) {
 const dir = mkdtempSync(join(tmpdir(), "pi-subagent-backend-"));
 const bin = join(dir, "bin"), runDir = join(dir, "subagents", "abcdef");
 mkdirSync(bin);
 mkdirSync(join(dir, "extensions"));
 writeFileSync(join(dir, "extensions", "herdr-agent-state.ts"), '// HERDR_INTEGRATION_ID=pi\n// "herdr:blocked"\n');
 const now = new Date().toISOString();
 shared.writeMetadata({ version: 2, backend: "herdr", handle: "abcdef", runDir, sessionFile: join(runDir, "session.jsonl"), cwd: dir, provider: "fixture", model: "fixture", thinking: "off", createdAt: now, updatedAt: now });
 shared.updateRunState(runDir, { state: "idle", hasStarted: true, pid: 123 });
 writeFileSync(join(runDir, "session.jsonl"), "");
 shared.writeTerminal(runDir, { socketPath: "/tmp/fixture.sock", phase: mode === "unknown" ? "uncertain" : "ready", terminalId: mode === "unknown" ? undefined : "term_fixture", paneId: "w1:p1" });
 writeFileSync(join(bin, "herdr"), `#!${process.execPath}
import {appendFileSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
const args=process.argv.slice(2),dir=process.env.PI_CODING_AGENT_DIR,mode=process.env.FIXTURE_MODE;
appendFileSync(dir+'/commands.jsonl',JSON.stringify(args)+'\\n');
if(mode==='unavailable'){console.error('fixture unavailable');process.exit(1);}
if(mode==='hold'){writeFileSync(dir+'/blocked-worker.pid',String(process.pid));await new Promise(done=>setTimeout(done,10000));}
if((mode==='lost'||mode==='close-lost')&&args[0]==='tab'&&args[1]==='create'){writeFileSync(dir+'/created','yes');console.error('fixture lost creation reply');process.exit(1);}
if(mode==='concurrent'){
 if(args[0]==='tab'&&args[1]==='create'){
  appendFileSync(dir+'/creations.jsonl',String(process.pid)+'\\n');
  const created={pane_id:'w1:p'+process.pid,tab_id:'w1:t'+process.pid,terminal_id:'term_'+process.pid,agent:'pi',agent_session:{kind:'path',value:dir+'/subagents/abcdef/session.jsonl'}};
  writeFileSync(dir+'/fixture-pane.json',JSON.stringify(created));console.log(JSON.stringify({result:{root_pane:created}}));process.exit(0);
 }
 if(args[0]==='pane'&&args[1]==='list'){
  await new Promise(done=>setTimeout(done,150));
  const panes=existsSync(dir+'/fixture-pane.json')?[JSON.parse(readFileSync(dir+'/fixture-pane.json','utf8'))]:[];
  console.log(JSON.stringify({result:{panes}}));process.exit(0);
 }
 if(args[0]==='pane'&&args[1]==='run')writeFileSync(dir+'/subagents/abcdef/state.json',JSON.stringify({state:'idle',hasStarted:true,pid:123,childSessionId:'fixture-child'}));
 console.log('{}');process.exit(0);
}
const pane={pane_id:'w1:p1',tab_id:'w1:t9',terminal_id:'term_fixture',agent:mode==='shell'||mode==='shell-busy'||mode==='ordinary'?undefined:'pi',agent_session:{kind:'path',value:mode==='occupied'?dir+'/other.jsonl':dir+'/subagents/abcdef/session.jsonl'}};
let result={};
if(args[0]==='pane'&&args[1]==='list')result={panes:mode==='missing'||existsSync(dir+'/closed')?[]:[pane]};
if(args[1]==='process-info')result={process_info:{shell_pid:777,foreground_process_group_id:mode==='shell'||mode==='shell-busy'?777:123,foreground_processes:[{pid:mode==='shell'?777:mode==='ordinary'||mode==='suspended'||mode==='shell-busy'?999:123}]}};
if(args[1]==='close'){
 writeFileSync(dir+'/closed','yes');
 if(mode==='close-lost'){console.error('fixture lost close reply');process.exit(1);}
}
console.log(JSON.stringify({result}));
`, { mode: 0o700 });
 const env = { ...process.env, HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/fixture.sock", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1", PI_SUBAGENT_RUN_DIR: "", PI_CODING_AGENT_DIR: dir, PI_PROVIDER: "fixture", PI_MODEL: "fixture", PATH: `${bin}:${process.env.PATH}`, FIXTURE_MODE: mode };
 t.diagnostic(`Evidence: ${dir}`);
 const cli = (args: string[]) => spawnSync(process.execPath, [join(root, "subagent.ts"), ...args], { env, encoding: "utf8", timeout: 10000 });
 return { dir, runDir, cli, env };
}

for (const mode of ["unavailable", "occupied", "ordinary", "suspended", "shell-busy", "unknown", "missing", "shell", "owned"]) {
 test(`stop preserves data unless terminal ownership and closure are confirmed: ${mode}`, (t) => {
  const fixture = backendFixture(t, mode);
  const result = fixture.cli(["stop", "abcdef"]);
  const succeeds = ["missing", "shell", "owned"].includes(mode);
  writeFileSync(join(fixture.dir, "result.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.equal(result.status, succeeds ? 0 : 1, result.stderr);
  assert.equal(existsSync(fixture.runDir), !succeeds);
  assert.equal(existsSync(join(fixture.dir, "closed")), mode === "shell" || mode === "owned");
 });
}

test("creation failure with an unknown terminal identity preserves the failed record", (t) => {
 const fixture = backendFixture(t, "lost");
 const result = fixture.cli(["spawn", "--prompt", "a multiline\ntask"]);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /lost creation reply/);
 assert.ok(existsSync(join(fixture.dir, "created")));
 const records = spawnSync(process.execPath, ["--input-type=module", "-e", `import {listRuns} from ${JSON.stringify(join(root, "shared.ts"))}; console.log(JSON.stringify(listRuns()));`], { env: { ...process.env, PI_CODING_AGENT_DIR: fixture.dir }, encoding: "utf8" });
 assert.equal(records.status, 0, records.stderr);
 const entries = JSON.parse(records.stdout);
 const failed = entries.find((run) => run.handle !== "abcdef");
 assert.ok(failed);
 assert.equal(failed.terminal.phase, "uncertain");
 assert.equal(failed.terminal.terminalId, undefined);
 assert.equal(fixture.cli(["stop", failed.handle]).status, 1);
 assert.ok(existsSync(failed.runDir));
});

test("wait does not return the previous error while a new inbox message is pending", (t) => {
 const fixture = backendFixture(t, "owned");
 shared.updateRunState(fixture.runDir, { state: "idle", outcome: "error", error: "previous failure" });
 mkdirSync(join(fixture.runDir, "inbox"));
 writeFileSync(join(fixture.runDir, "inbox", "next.json"), JSON.stringify({ message: "new work", delivery: "auto" }));
 const result = fixture.cli(["wait", "abcdef", "--timeout", "1"]);
 assert.equal(result.status, 1);
 assert.match(result.stderr, /Timed out/);
 assert.doesNotMatch(result.stderr, /previous failure/);
});

test("a busy run does not inherit its previous idle error outcome", (t) => {
 const fixture = backendFixture(t, "owned");
 shared.updateRunState(fixture.runDir, { state: "busy", outcome: "error" });
 const previous = process.env.HERDR_SOCKET_PATH;
 process.env.HERDR_SOCKET_PATH = "/tmp/fixture.sock";
 try {
  const run = shared.readMetadata(fixture.runDir)!;
  assert.equal(shared.effectiveRunState(run, [{ pane_id: "w1:p1", tab_id: "w1:t1", terminal_id: "term_fixture", agent: "pi", agent_session: { kind: "path", value: run.sessionFile } }]), "busy");
 } finally {
  if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
  else process.env.HERDR_SOCKET_PATH = previous;
 }
});

test("suspend intent survives a lost close reply and permits a verified restart", (t) => {
 const fixture = backendFixture(t, "close-lost");
 const modulePath = JSON.stringify(join(root, "shared.ts"));
 const runPath = JSON.stringify(fixture.runDir);
 const pause = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readMetadata,stopRun} from ${modulePath}; await stopRun(readMetadata(${runPath}),true);`], { env: fixture.env, encoding: "utf8", timeout: 10000 });
 assert.equal(pause.status, 1);
 assert.match(pause.stderr, /lost close reply/);
 assert.ok(existsSync(join(fixture.dir, "closed")));
 assert.equal(shared.readMetadata(fixture.runDir)!.terminal!.suspended, true);
 const resume = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readMetadata,launchRun} from ${modulePath}; await launchRun(readMetadata(${runPath}));`], { env: fixture.env, encoding: "utf8", timeout: 10000 });
 assert.equal(resume.status, 1);
 assert.match(resume.stderr, /lost creation reply/);
 assert.ok(existsSync(join(fixture.dir, "created")), "verified absent terminal should reach a new creation attempt");
 writeFileSync(join(fixture.dir, "result.json"), JSON.stringify({ pause: pause.stderr, resume: resume.stderr }, null, 2));
});

test("concurrent restores of the same run create only one terminal", (t) => {
 const fixture = backendFixture(t, "concurrent");
 shared.writeTerminal(fixture.runDir, { socketPath: "/tmp/fixture.sock", phase: "closed", suspended: true, terminalId: "previous-terminal" });
 const source = `import {readMetadata,launchRun} from ${JSON.stringify(join(root, "shared.ts"))}; const run=readMetadata(${JSON.stringify(fixture.runDir)}); const results=await Promise.allSettled([launchRun(run),launchRun(run)]); console.log(JSON.stringify(results.map(r=>({status:r.status,error:r.status==='rejected'?String(r.reason):undefined}))));`;
 const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { env: fixture.env, encoding: "utf8", timeout: 10000 });
 assert.equal(result.status, 0, result.stderr);
 const created = readFileSync(join(fixture.dir, "creations.jsonl"), "utf8").trim().split("\n");
 writeFileSync(join(fixture.dir, "result.json"), result.stdout);
 assert.equal(created.length, 1, result.stdout);
 assert.equal(JSON.parse(result.stdout).filter((entry) => entry.status === "fulfilled").length, 1);
});

test("a dead controller ticket is reclaimed without blocking explicit stop", async (t) => {
 const fixture = backendFixture(t, "owned");
 const source = `import {readMetadata,stopRun} from ${JSON.stringify(join(root, "shared.ts"))}; await stopRun(readMetadata(${JSON.stringify(fixture.runDir)}),true);`;
 const controller = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...fixture.env, FIXTURE_MODE: "hold" }, stdio: "ignore" });
 const exited = new Promise<void>((done) => controller.once("exit", () => done()));
 const marker = join(fixture.dir, "blocked-worker.pid");
 try {
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) await shared.delay(20);
  assert.ok(existsSync(marker), "controller must enter a lifecycle operation");
  assert.ok(readdirSync(fixture.runDir).some((file) => file === "lifecycle.lock" || file.startsWith("lifecycle-") && file.endsWith(".lock")));
  controller.kill("SIGKILL"); await exited;
  const result = fixture.cli(["stop", "abcdef"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.runDir), false);
 } finally {
  if (!controller.killed) controller.kill("SIGKILL");
  if (existsSync(marker)) {
   try { process.kill(Number(readFileSync(marker, "utf8")), "SIGTERM"); }
   catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
 }
});
