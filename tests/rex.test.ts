import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { delay, detectBackend, readMetadata, stopRun, writeTerminal, type RunMetadata } from "../shared.ts";
import { rex } from "../rex.ts";

const root = resolve(import.meta.dirname, "..");
const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test("real Rex/Pi: launch, focus, messages, rename, suspension, recovery and safe stop", { skip: detectBackend() !== "rex", timeout: 90000 }, async (t) => {
 const dir = mkdtempSync(join(tmpdir(), "pi-subagent-rex-e2e-"));
 t.diagnostic(`Evidence: ${dir}`);
 const commands: unknown[] = [], checks: string[] = [];
 const save = () => writeFileSync(join(dir, "report.json"), JSON.stringify({ commands, checks }, null, 2));
 const bin = join(dir, "bin"); mkdirSync(bin);
 const pi = (await exec("sh", ["-c", "command -v pi"])).stdout.trim();
 writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${quote(pi)} --extension ${quote(join(root, "tests/fixtures/provider.ts"))} "$@"\n`, { mode: 0o700 });
 const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_RUN_DIR: "", PI_SESSION_ID: "rex-e2e-parent", PI_PROVIDER: "subagent-test", PI_MODEL: "fixture", PI_REASONING_LEVEL: "off", PI_OFFLINE: "1" };
 const session = process.env.REX_SESSION!;
 const original = await rex<{ active_window_id: string }>(["session", "inspect", session, "--json"]);
 const runs = () => existsSync(join(dir, "subagents")) ? readdirSync(join(dir, "subagents")).map((handle) => readMetadata(join(dir, "subagents", handle))).filter((run): run is RunMetadata => !!run) : [];
 const cli = async (args: string[], success = true) => {
  try {
   const result = await exec(process.execPath, [join(root, "subagent.ts"), ...args], { env, cwd: root, encoding: "utf8", timeout: 40000 });
   commands.push({ args, code: 0, ...result }); save(); return result;
  } catch (error) {
   const e = error as Error & { stdout: string; stderr: string };
   commands.push({ args, error: e.message, stdout: e.stdout, stderr: e.stderr }); save();
   if (success) throw error;
   return { stdout: e.stdout, stderr: e.stderr };
  }
 };
 const check = (name: string) => { checks.push(name); save(); };
 const until = async (check: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  assert.fail(label);
 };
 const events = () => existsSync(join(dir, "events.jsonl")) ? readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
 const parents: string[] = [];
 let parentFile = join(dir, "parent.jsonl");
 const openParent = async (initial = false) => {
  const created = await rex<{ block_ids: string[] }>(["window", "new", "-s", session, "Rex test parent", "--focus=false", "--shell=none", "--json", "--", "env", `PATH=${env.PATH}`, `PI_CODING_AGENT_DIR=${dir}`, "PI_SUBAGENT_RUN_DIR=", "PI_OFFLINE=1", "pi", "--session", parentFile, "--provider", "subagent-test", "--model", "fixture", "--thinking", "off", "--no-extensions", "--extension", join(root, "index.ts"), "--no-skills", "--no-context-files", ...(initial ? ["parent hello"] : [])]);
  parents.push(created.block_ids[0]); return created.block_ids[0];
 };
 const input = async (block: string, text: string) => {
  await rex(["send", "-s", session, "-b", block, text]);
  await rex(["send-key", "-s", session, "-b", block, "enter"]);
 };
 t.after(async () => {
  for (const run of runs()) {
   try { await stopRun(run); } catch (error) { commands.push({ cleanup: run.handle, error: String(error) }); }
  }
  for (const block of parents) {
   const { blocks } = await rex<{ blocks: { block_id: string }[] }>(["block", "ls", "-s", session, "--json"]);
   if (blocks.some((value) => value.block_id === block)) await rex(["block", "close", "-s", session, block]);
  }
  await rex(["focus", "-s", session, original.active_window_id]); save();
 });
 let parent = await openParent(true);
 await until(() => events().some((event) => event.event === "agent_settled"), "parent did not settle");
 env.PI_SESSION_ID = events().find((event) => event.event === "session_start").sessionId;
 if (!existsSync(parentFile)) {
  const saved = (readdirSync(join(dir, "sessions"), { recursive: true }) as string[]).find((path) => path.endsWith("parent.jsonl"));
  assert.ok(saved); parentFile = join(dir, "sessions", saved);
 }
 await cli(["spawn", "--name", "Rex child", "--no-extensions", "--no-skills", "--no-context-files", "--prompt", "hold task\nquotes ' $HOME $(false) 中文"]);
 let run = runs()[0]; assert.ok(run);
 const current = () => readMetadata(run.runDir)!;
 assert.equal(run.backend, "rex");
 assert.equal(run.terminal?.phase, "ready");
 assert.equal((await rex<{ active_window_id: string }>(["session", "inspect", session, "--json"])).active_window_id, original.active_window_id);
 check("Rex selected and startup preserved focus");
 await cli(["send", run.handle, "steering sentinel"]);
 await cli(["send", run.handle, "--follow-up", "follow-up sentinel"]);
 await cli(["wait", run.handle, "--timeout", "20"]);
 const transcript = readFileSync(current().sessionFile, "utf8");
 assert.match(transcript, /steering sentinel/); assert.match(transcript, /follow-up sentinel/);
 check("steering and queued follow-up reached durable transcript");
 const programState = async () => {
  const result = await rex<{ records: { state: string; app?: string }[] }>(["block", "call", "-s", session, "-b", current().terminal!.terminalId!, "program_status"]);
  writeFileSync(join(dir, "program-status.json"), JSON.stringify(result, null, 2));
  return result.records.find((record) => record.app === "pi")?.state;
 };
 await until(async () => await programState() === "done", "Rex completion status missing");
 await input(current().terminal!.terminalId!, "/fixture-dialog confirm");
 await until(async () => current().state === "blocked" && await programState() === "blocked", "Rex dialog status missing");
 await until(async () => current().state === "idle" && await programState() === "done", "Rex dialog status did not recover");
 check("Rex native status shows completion, blocked dialogs and recovery");
 await cli(["rename", run.handle, "renamed child"]);
 const { focusRun } = await import("../shared.ts");
 let clientFocusDenied = false;
 try { await focusRun(current()); }
 catch (error) {
  assert.match(String(error), /Remote Control/);
  clientFocusDenied = true;
  check("Rex app rejects tab switching while Remote Control is disabled");
 }
 const windows = await rex<{ windows: { window_id: string; label: string }[]; active_window_id: string }>(["session", "inspect", session, "--json"]);
 assert.equal(windows.windows.find((window) => window.window_id === windows.active_window_id)?.label, `subagent renamed child (${run.handle})`);
 check("rename persists and the server focuses the existing tab");
 await rex(["focus", "-s", session, parent]);
 await input(parent, "/subagent");
 await until(async () => (await exec("rex", ["capture", "-s", session, "-b", parent, "--trim"], { encoding: "utf8" })).stdout.includes("Switch to subagent"), "selector did not open");
 await rex(["send-key", "-s", session, "-b", parent, "enter"]);
 if (clientFocusDenied) {
  await until(async () => (await exec("rex", ["capture", "-s", session, "-b", parent, "--trim"], { encoding: "utf8" })).stdout.includes("Remote Control"), "selector did not show the client rejection");
  check("actual /subagent selector shows the Remote Control rejection");
 } else {
  await until(async () => (await rex<{ active_window_id: string }>(["session", "inspect", session, "--json"])).active_window_id === windows.active_window_id, "selector did not focus child");
  check("actual /subagent selector completes the app action");
 }
 const reloadFrom = events().length, beforeReloadPid = current().pid;
 await input(parent, "/reload");
 await until(() => events().slice(reloadFrom).some((event) => event.event === "session_start" && event.reason === "reload"), "reload did not finish");
 assert.equal(current().pid, beforeReloadPid);
 check("parent reload preserves the child process");
 await rex(["focus", "-s", session, original.active_window_id]);
 const terminal = current().terminal!;
 writeTerminal(run.runDir, { ...terminal, socketPath: "different-server" });
 const unavailable = await cli(["stop", run.handle], false);
 assert.match(unavailable.stderr, /endpoint/); assert.ok(existsSync(run.runDir));
 writeTerminal(run.runDir, { ...terminal, terminalId: undefined, phase: "uncertain" });
 const uncertain = await cli(["stop", run.handle], false);
 assert.match(uncertain.stderr, /uncertain/); assert.ok(existsSync(run.runDir));
 writeTerminal(run.runDir, terminal);
 const statePath = join(run.runDir, "state.json"), state = readFileSync(statePath, "utf8");
 writeFileSync(statePath, JSON.stringify({ ...JSON.parse(state), pid: 1 }));
 assert.match((await cli(["stop", run.handle], false)).stderr, /ownership/);
 writeFileSync(statePath, state);
 check("wrong endpoint, unknown identity and wrong PID preserve the child and run data");
 const pid = current().pid, sessionFile = current().sessionFile;
 await rex(["send-key", "-s", session, "-b", parent, "ctrl+d"]);
 await until(() => current().terminal?.suspended === true && current().terminal?.phase === "closed", "parent quit did not suspend child");
 if (!existsSync(parentFile)) {
  const saved = (readdirSync(join(dir, "sessions"), { recursive: true }) as string[]).find((path) => path.endsWith("parent.jsonl"));
  assert.ok(saved); parentFile = join(dir, "sessions", saved);
 }
 parent = await openParent();
 await until(() => current().terminal?.phase === "ready" && current().terminal?.suspended === false, "parent resume did not restore child");
 run = current();
 assert.notEqual(run.pid, pid); assert.equal(run.sessionFile, sessionFile); assert.equal(run.terminal?.suspended, false);
 check("suspension and recovery retain history and start a new process");
 await cli(["send", run.handle, "fixture failure"]);
 assert.match((await cli(["wait", run.handle, "--timeout", "10"], false)).stderr, /fixture failure/);
 await cli(["send", run.handle, "recovered sentinel"]);
 assert.match((await cli(["wait", run.handle, "--timeout", "10"])).stdout, /recovered sentinel/);
 check("error outcome is reported and a subsequent task can recover");
 await cli(["stop", run.handle]);
 assert.equal(existsSync(run.runDir), false);
 check("confirmed stop removes only the managed run");
});
