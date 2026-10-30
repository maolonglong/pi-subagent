import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { delay, focusRun, herdr, readMetadata, type RunMetadata } from "../shared.ts";

const root = resolve(import.meta.dirname, "..");
const exec = promisify(execFile);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const enabled = process.env.HERDR_ENV === "1";
async function until(check: () => boolean | Promise<boolean>, label: string) {
 const deadline = Date.now() + 25000;
 while (Date.now() < deadline) { if (await check()) return; await delay(100); }
 assert.fail(label);
}

async function harness(t: TestContext) {
 const dir = mkdtempSync(join(tmpdir(), "pi-subagent-herdr-e2e-"));
 t.diagnostic(`Evidence: ${dir}`);
 const commands: unknown[] = [], checks: string[] = [], owned = new Set<string>();
 const save = () => writeFileSync(join(dir, "report.json"), JSON.stringify({ checks, commands }, null, 2));
 const api = async (args: string[]): Promise<any> => {
  try {
   const result = args[1] === "read" ? (await exec("herdr", args, { encoding: "utf8", timeout: 10000 })).stdout : await herdr<any>(args);
   commands.push({ args, result }); save(); return result;
  }
  catch (error) { commands.push({ args, error: String(error) }); save(); throw error; }
 };
 const tabs = async () => (await api(["tab", "list"])).tabs;
 const original = (await tabs()).find((tab) => tab.focused).tab_id;
 const bin = join(dir, "bin"); mkdirSync(bin);
 const realPi = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" });
 assert.equal(realPi.status, 0, realPi.stderr);
 writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec ${quote(realPi.stdout.trim())} --extension ${quote(join(root, "tests", "fixtures", "provider.ts"))} "$@"\n`, { mode: 0o700 });
 const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_RUN_DIR: "", PI_SESSION_ID: "", PI_PROVIDER: "subagent-test", PI_MODEL: "fixture", PI_REASONING_LEVEL: "off", PI_OFFLINE: "1" };
 let parentId = "";
 const runs = () => existsSync(join(dir, "subagents")) ? readdirSync(join(dir, "subagents")).map((name) => readMetadata(join(dir, "subagents", name))).filter((run): run is RunMetadata => !!run) : [];
 const remember = async () => {
  const panes = (await api(["pane", "list"])).panes;
  for (const run of runs()) {
   const pane = panes.find((pane) => pane.terminal_id === run.terminal?.terminalId);
   if (pane) owned.add(pane.tab_id);
  }
 };
 const cli = async (args: string[], success = true) => {
  let result: { code: number; stdout: string; stderr: string };
  try { const r = await exec(process.execPath, [join(root, "subagent.ts"), ...args], { env: { ...env, PI_SESSION_ID: parentId }, cwd: root, encoding: "utf8", timeout: 45000 }); result = { code: 0, ...r }; }
  catch (error) { const e = error as Error & { code: number; stdout: string; stderr: string }; result = { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }; }
  commands.push({ cli: args, ...result }); save();
  await remember();
  if (success) assert.equal(result.code, 0, result.stderr);
  return result;
 };
 const check = (name: string) => { checks.push(name); save(); };
 const run = (handle: string) => { const value = readMetadata(join(dir, "subagents", handle)); assert.ok(value); return value; };
 const pane = async (metadata: RunMetadata) => {
  const value = (await api(["pane", "list"])).panes.find((pane) => pane.terminal_id === metadata.terminal?.terminalId);
  assert.ok(value); return value;
 };
 const events = () => existsSync(join(dir, "events.jsonl")) ? readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
 const spawn = async (name: string, prompt: string, extra: string[] = []) => {
  const result = await cli(["spawn", "--name", name, "--no-extensions", "--no-skills", "--no-context-files", "--prompt", prompt, ...extra]);
  const match = result.stdout.match(/\(([a-f0-9]{6})\)/); assert.ok(match);
  return match[1];
 };
 const parentName = `e2e-parent-${randomUUID().slice(0, 8)}`;
 const openParent = async (sessionFile: string, suffix = "") => {
  const name = parentName + suffix;
  const created = await api(["tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID!, "--cwd", root, "--label", name, "--no-focus", "--env", `PATH=${env.PATH}`, "--env", `PI_CODING_AGENT_DIR=${dir}`, "--env", "PI_SUBAGENT_RUN_DIR=", "--env", "PI_OFFLINE=1"]);
  owned.add(created.tab.tab_id);
  await api(["agent", "start", name, "--kind", "pi", "--pane", created.root_pane.pane_id, "--timeout", "20000", "--", "--no-extensions", "--extension", join(root, "index.ts"), "--extension", join(process.env.HOME!, ".pi", "agent", "extensions", "herdr-agent-state.ts"), "--provider", "subagent-test", "--model", "fixture", "--thinking", "off", "--no-skills", "--no-context-files", "--no-prompt-templates", "--session", sessionFile]);
  return { tab: created.tab.tab_id as string, pane: created.root_pane.pane_id as string };
 };
 t.after(async () => {
  await remember();
  for (const tab of owned) if ((await tabs()).some((current) => current.tab_id === tab)) await api(["tab", "close", tab]);
  if ((await tabs()).some((tab) => tab.tab_id === original)) await api(["tab", "focus", original]);
  save();
 });
 return { dir, api, tabs, cli, check, run, pane, events, spawn, openParent, original, setParentId: (id: string) => { parentId = id; } };
}

test("real Herdr/Pi: long startup, selector, queue, reload, quit and resume", { skip: !enabled, timeout: 150000 }, async (t) => {
 const h = await harness(t);
 let parentFile = join(h.dir, "parent.jsonl");
 let parent = await h.openParent(parentFile);
 await h.api(["agent", "prompt", parent.pane, "parent hello", "--wait", "--timeout", "10000"]);
 parentFile = (await h.api(["agent", "get", parent.pane])).agent.agent_session.value;
 h.setParentId(JSON.parse(readFileSync(parentFile, "utf8").split("\n")[0]).id);
 const attachment = join(h.dir, "a 'quoted' file.md"); writeFileSync(attachment, "ATTACHMENT_SENTINEL");
 const task = `hold task long\n中文 \"quotes\" $HOME $(touch ${h.dir}/injected) \`uname\` ; &`;
 const started = Date.now();
 const handle = await h.spawn("long child", task, ["--file", attachment]);
 assert.ok(Date.now() - started < 15000, "startup waited for task completion");
 await until(() => h.run(handle).state === "busy", "long task did not start");
 let run = h.run(handle), child = await h.pane(run);
 assert.equal((await h.tabs()).find((tab) => tab.focused).tab_id, h.original);
 assert.notEqual(child.tab_id, parent.tab);
 assert.equal((await h.tabs()).find((tab) => tab.tab_id === child.tab_id).pane_count, 1);
 const transcript = readFileSync(run.sessionFile, "utf8");
 assert.ok(transcript.includes("ATTACHMENT_SENTINEL") && transcript.includes("hold task long"));
 assert.equal(existsSync(join(h.dir, "injected")), false);
 h.check("long initial task launches independently of completion; task and quoted attachment are safe; parent focus stays unchanged");
 await h.api(["agent", "send-keys", child.pane_id, "esc"]);
 await until(() => h.run(handle).outcome === "aborted", "cancel did not settle");
 assert.equal((await h.cli(["wait", handle, "--timeout", "5"], false)).code, 1);
 await h.cli(["send", handle, "hello after cancel"]);
 assert.match((await h.cli(["wait", handle, "--timeout", "10"])).stdout, /hello after cancel/);
 await h.cli(["rename", handle, "renamed child"]);
 assert.equal(h.run(handle).name, "renamed child");
 assert.match((await h.tabs()).find((tab) => tab.tab_id === child.tab_id).label, /renamed child/);
 h.check("cancel, subsequent inbox delivery and durable rename work");
 const pid = h.run(handle).pid;
 for (let attempt = 0; attempt < 2; attempt++) {
  await h.api(["tab", "focus", parent.tab]);
  await h.api(["agent", "send-keys", parent.pane, "ctrl+u"]);
  await h.api(["agent", "prompt", parent.pane, "/subagent"]);
  await until(async () => (await h.api(["agent", "read", parent.pane, "--source", "visible", "--lines", "30"])).includes("Switch to subagent"), "selector missing");
  await h.api(["agent", "send-keys", parent.pane, "enter"]);
  await until(async () => (await h.tabs()).find((tab) => tab.focused).tab_id === child.tab_id, "selector did not focus child tab");
  assert.equal(h.run(handle).pid, pid);
 }
 await h.api(["tab", "focus", h.original]);
 const from = h.events().length;
 await h.api(["agent", "prompt", parent.pane, "/reload"]);
 await until(() => h.events().slice(from).some((event) => event.event === "session_start" && event.reason === "reload"), "parent reload missing");
 assert.equal(h.run(handle).pid, pid);
 h.check("actual selector reuses child tab and process; parent reload preserves the child");
 const queueFrom = h.events().length;
 await h.cli(["send", handle, "hold task"]);
 await until(() => h.events().slice(queueFrom).some((event) => event.pid === pid && event.event === "hold_started"), "hold task missing");
 await h.cli(["send", handle, "--follow-up", "queued follow-up"]);
 await h.cli(["send", handle, "priority steer"]);
 await h.cli(["wait", handle, "--timeout", "15"]);
 const calls = h.events().slice(queueFrom).filter((event) => event.pid === pid && event.event === "model_call");
 const steer = calls.findIndex((event) => event.text.includes("priority steer"));
 assert.ok(steer >= 0 && calls.findIndex((event) => event.text.includes("queued follow-up")) > steer, JSON.stringify(calls));
 await h.cli(["send", handle, "fixture failure"]);
 assert.equal((await h.cli(["wait", handle, "--timeout", "10"], false)).code, 1);
 await h.cli(["send", handle, "recover after error"]);
 assert.match((await h.cli(["wait", handle, "--timeout", "10"])).stdout, /recover after error/);
 h.check("busy steer precedes follow-up; model error makes wait fail; a subsequent task clears the old outcome");
 const before = readFileSync(h.run(handle).sessionFile, "utf8"), oldTerminal = h.run(handle).terminal!.terminalId;
 await h.api(["agent", "send-keys", parent.pane, "ctrl+d"]);
 await until(() => h.run(handle).terminal?.suspended === true && h.run(handle).terminal?.phase === "closed", "parent quit did not suspend child");
 assert.ok(existsSync(h.run(handle).sessionFile));
 if (!existsSync(parentFile)) {
  const saved = (readdirSync(join(h.dir, "sessions"), { recursive: true }) as string[]).find((file) => file.endsWith("parent.jsonl"));
  assert.ok(saved); parentFile = join(h.dir, "sessions", saved);
 }
 await h.api(["pane", "close", parent.pane]);
 parent = await h.openParent(parentFile);
 await until(() => h.run(handle).terminal?.phase === "ready" && h.run(handle).terminal?.suspended === false && h.run(handle).state === "idle", "child did not resume idle");
 run = h.run(handle); child = await h.pane(run);
 assert.notEqual(run.terminal!.terminalId, oldTerminal);
 assert.ok(readFileSync(run.sessionFile, "utf8").startsWith(before));
 await h.cli(["send", handle, "after resume"]);
 assert.match((await h.cli(["wait", handle, "--timeout", "10"])).stdout, /after resume/);
 await h.api(["agent", "prompt", parent.pane, "/new"]);
 await until(() => h.run(handle).terminal?.phase === "closed" && h.run(handle).terminal?.suspended === true, "session switch did not suspend child");
 h.check("quit/resume preserves history in a new child tab; /new suspends previous-session children");
});

test("real Pi dialogs report blocked and recover, including nested, editor and thrown custom", { skip: !enabled, timeout: 90000 }, async (t) => {
 const h = await harness(t), handle = await h.spawn("dialog child", "hello");
 await h.cli(["wait", handle, "--timeout", "10"]);
 const child = await h.pane(h.run(handle));
 for (const kind of ["confirm", "select", "input", "custom", "nested", "throw", "editor"]) {
  const from = h.events().length;
  await h.api(["agent", "prompt", child.pane_id, `/fixture-dialog ${kind}`]);
  if (kind !== "throw") {
   await until(async () => (await h.api(["agent", "get", child.pane_id])).agent.agent_status === "blocked" && h.run(handle).state === "blocked", `${kind}: blocked missing`);
   const screen = await h.api(["agent", "read", child.pane_id, "--source", "visible", "--lines", "30"]);
   writeFileSync(join(h.dir, `${kind}-screen.txt`), screen);
  }
  if (kind === "nested") {
   await until(() => h.events().slice(from).some((event) => event.event === "nested_finished"), "inner dialog did not finish");
   assert.equal((await h.api(["agent", "get", child.pane_id])).agent.agent_status, "blocked");
  }
  if (kind === "editor") await h.api(["agent", "send-keys", child.pane_id, "esc"]);
  await until(async () => h.events().slice(from).some((event) => event.event === "ui_prompt_end") && ["idle", "done"].includes((await h.api(["agent", "get", child.pane_id])).agent.agent_status) && h.run(handle).state === "idle", `${kind}: did not recover`);
  assert.equal(h.events().slice(from).filter((event) => event.event === "ui_prompt_start").length, 1);
  assert.equal(h.events().slice(from).filter((event) => event.event === "ui_prompt_end").length, 1);
  h.check(`${kind}: blocked lifecycle and recovery`);
 }
});

test("real Herdr terminal ownership survives moves, splits and reuse", { skip: !enabled, timeout: 90000 }, async (t) => {
 const h = await harness(t);
 const first = await h.spawn("split child", "hello");
 await h.cli(["wait", first, "--timeout", "10"]);
 const firstPane = await h.pane(h.run(first));
 const extra = (await h.api(["pane", "split", firstPane.pane_id, "--direction", "right", "--cwd", root, "--focus"])).pane;
 assert.equal((await h.api(["pane", "list"])).panes.find((pane) => pane.focused).pane_id, extra.pane_id);
 await h.api(["tab", "focus", h.original]);
 await focusRun(h.run(first));
 assert.equal((await h.api(["pane", "list"])).panes.find((pane) => pane.focused).pane_id, firstPane.pane_id);
 h.check("switching to a split tab focuses the child pane rather than the previous pane");
 await h.api(["tab", "focus", h.original]);
 await h.cli(["stop", first]);
 assert.equal((await h.api(["pane", "get", extra.pane_id])).pane.tab_id, firstPane.tab_id);
 h.check("stop preserves a second pane added to a child tab");
 const handle = await h.spawn("reuse child", "hello");
 await h.cli(["wait", handle, "--timeout", "10"]);
 const initial = await h.pane(h.run(handle));
 await h.api(["pane", "move", initial.pane_id, "--new-tab", "--workspace", process.env.HERDR_WORKSPACE_ID!, "--label", "moved child", "--no-focus"]);
 const child = await h.pane(h.run(handle));
 assert.notEqual(child.tab_id, initial.tab_id);
 await h.cli(["rename", handle, "moved rename"]);
 assert.match((await h.tabs()).find((tab) => tab.tab_id === child.tab_id).label, /moved rename/);
 h.check("management follows terminal identity after a move to another tab");
 await h.api(["agent", "send-keys", child.pane_id, "ctrl+z"]);
 await until(async () => { const info = (await h.api(["pane", "process-info", "--pane", child.pane_id])).process_info; return info.foreground_process_group_id === info.shell_pid && info.foreground_processes.every((process) => process.pid === info.shell_pid); }, "Pi did not suspend to shell");
 await h.api(["pane", "run", child.pane_id, "sleep 15"]);
 await until(async () => { const info = (await h.api(["pane", "process-info", "--pane", child.pane_id])).process_info; return info.foreground_processes.some((process) => process.argv0 === "sleep"); }, "foreground command did not start");
 assert.equal((await h.cli(["stop", handle], false)).code, 1);
 await h.api(["pane", "send-keys", child.pane_id, "ctrl+c"]);
 await until(async () => { const info = (await h.api(["pane", "process-info", "--pane", child.pane_id])).process_info; return info.foreground_process_group_id === info.shell_pid && info.foreground_processes.every((process) => process.pid === info.shell_pid); }, "shell did not return");
 await h.api(["pane", "run", child.pane_id, "fg"]);
 await until(async () => (await h.api(["pane", "process-info", "--pane", child.pane_id])).process_info.foreground_processes.some((process) => process.pid === h.run(handle).pid), "Pi did not return to foreground");
 h.check("retained Pi identity after Ctrl+Z cannot authorize closing an unrelated foreground command");
 await h.api(["agent", "send-keys", child.pane_id, "ctrl+d"]);
 await until(async () => !(await h.api(["pane", "get", child.pane_id])).pane.agent, "Pi did not exit");
 assert.match((await h.cli(["status", handle])).stdout, /exited/);
 await h.api(["pane", "run", child.pane_id, "sleep 15"]);
 await until(async () => { const info = (await h.api(["pane", "process-info", "--pane", child.pane_id])).process_info; return info.foreground_processes.some((process) => process.argv0 === "sleep"); }, "sleep did not start");
 assert.equal((await h.cli(["stop", handle], false)).code, 1);
 assert.ok(existsSync(h.run(handle).runDir));
 await h.api(["pane", "send-keys", child.pane_id, "ctrl+c"]);
 await until(async () => { const info = (await h.api(["pane", "process-info", "--pane", child.pane_id])).process_info; return info.foreground_process_group_id === info.shell_pid && info.foreground_processes.every((process) => process.pid === info.shell_pid); }, "shell did not return");
 await h.api(["agent", "start", `reuse-${randomUUID().slice(0, 8)}`, "--kind", "pi", "--pane", child.pane_id, "--timeout", "20000", "--", "--no-extensions", "--extension", join(process.env.HOME!, ".pi", "agent", "extensions", "herdr-agent-state.ts"), "--provider", "subagent-test", "--model", "fixture", "--thinking", "off", "--no-skills", "--no-context-files", "--session", join(h.dir, "different.jsonl")]);
 await h.api(["agent", "prompt", child.pane_id, "different session hello", "--wait", "--timeout", "10000"]);
 assert.equal((await h.cli(["stop", handle], false)).code, 1);
 h.check("stop rejects both a different foreground command and a different Pi session in the old terminal");
});

test("abrupt parent exit reuses its surviving child without duplicating history", { skip: !enabled, timeout: 60000 }, async (t) => {
 const h = await harness(t);
 let parentFile = join(h.dir, "parent.jsonl");
 let parent = await h.openParent(parentFile);
 await h.api(["agent", "prompt", parent.pane, "parent hello", "--wait", "--timeout", "10000"]);
 parentFile = (await h.api(["agent", "get", parent.pane])).agent.agent_session.value;
 h.setParentId(JSON.parse(readFileSync(parentFile, "utf8").split("\n")[0]).id);
 const handle = await h.spawn("surviving child", "before parent crash");
 await h.cli(["wait", handle, "--timeout", "10"]);
 const identity = h.run(handle).terminal!.terminalId;
 const transcript = readFileSync(h.run(handle).sessionFile, "utf8");
 await h.api(["pane", "close", parent.pane]);
 assert.ok(await h.pane(h.run(handle)));
 parent = await h.openParent(parentFile);
 assert.equal(h.run(handle).terminal!.terminalId, identity);
 const matching = (await h.api(["pane", "list"])).panes.filter((pane) => pane.terminal_id === identity);
 assert.equal(matching.length, 1);
 assert.ok(readFileSync(h.run(handle).sessionFile, "utf8").startsWith(transcript));
 await h.cli(["send", handle, "after parent crash"]);
 assert.match((await h.cli(["wait", handle, "--timeout", "10"])).stdout, /after parent crash/);
 await h.cli(["stop", handle]);
 assert.equal(existsSync(join(h.dir, "subagents", handle)), false);
 h.check("parent resume reuses live child and history; explicit stop confirms closure before deleting files");
});

test("default extension discovery and explicit launch paths load one control bridge", { skip: !enabled, timeout: 45000 }, async (t) => {
 const h = await harness(t);
 const extensions = join(h.dir, "extensions"); mkdirSync(extensions);
 symlinkSync(root, join(extensions, "subagent"), "dir");
 symlinkSync(join(process.env.HOME!, ".pi", "agent", "extensions", "herdr-agent-state.ts"), join(extensions, "herdr-agent-state.ts"));
 const spawned = await h.cli(["spawn", "--name", "default discovery", "--no-skills", "--no-context-files", "--prompt", "initial default task"]);
 const match = spawned.stdout.match(/\(([a-f0-9]{6})\)/); assert.ok(match);
 const handle = match[1];
 await h.cli(["wait", handle, "--timeout", "10"]);
 const child = await h.pane(h.run(handle)), pid = h.run(handle).pid;
 await h.cli(["send", handle, "unique default inbox task"]);
 assert.match((await h.cli(["wait", handle, "--timeout", "10"])).stdout, /unique default inbox task/);
 assert.equal(h.events().filter((event) => event.pid === pid && event.event === "model_call" && event.text.includes("unique default inbox task")).length, 1);
 const from = h.events().length;
 await h.api(["agent", "prompt", child.pane_id, "/fixture-dialog confirm"]);
 await until(async () => (await h.api(["agent", "get", child.pane_id])).agent.agent_status === "blocked", "default dialog did not block");
 await until(() => h.events().slice(from).some((event) => event.event === "ui_prompt_end"), "default dialog did not finish");
 const forwarded = h.events().slice(from).filter((event) => event.pid === pid && event.event === "forwarded_blocked");
 assert.equal(forwarded.filter((event) => event.active).length, 1);
 assert.equal(forwarded.filter((event) => !event.active).length, 1);
 h.check("normal discovery loads one bridge; inbox is delivered once and dialogs emit one blocked pair");
});

test("real close succeeds with a lost reply, and parent resume still restarts the child", { skip: !enabled, timeout: 90000 }, async (t) => {
 const h = await harness(t);
 const actualHerdr = process.env.HERDR_BIN_PATH || spawnSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).stdout.trim();
 const marker = join(h.dir, "lost-close-reply");
 writeFileSync(join(h.dir, "bin", "herdr"), `#!${process.execPath}
import {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),result=spawnSync(${JSON.stringify(actualHerdr)},args,{encoding:'utf8'});
if(result.status===0&&args[0]==='pane'&&args[1]==='close'&&!existsSync(${JSON.stringify(marker)})){
 writeFileSync(${JSON.stringify(marker)},'applied');console.error('synthetic lost reply after real close');process.exit(1);
}
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);
`, { mode: 0o700 });
 let parentFile = join(h.dir, "parent.jsonl");
 let parent = await h.openParent(parentFile);
 await h.api(["agent", "prompt", parent.pane, "parent hello", "--wait", "--timeout", "10000"]);
 parentFile = (await h.api(["agent", "get", parent.pane])).agent.agent_session.value;
 h.setParentId(JSON.parse(readFileSync(parentFile, "utf8").split("\n")[0]).id);
 const handle = await h.spawn("lost reply child", "before lost close reply");
 await h.cli(["wait", handle, "--timeout", "10"]);
 const before = readFileSync(h.run(handle).sessionFile, "utf8"), oldTerminal = h.run(handle).terminal!.terminalId;
 await h.api(["agent", "send-keys", parent.pane, "ctrl+d"]);
 await until(async () => existsSync(marker) && !(await h.api(["pane", "get", parent.pane])).pane.agent, "parent did not finish the failed close");
 assert.equal(h.run(handle).terminal!.suspended, true);
 assert.equal(h.run(handle).terminal!.phase, "ready", "lost reply must leave closure unconfirmed");
 assert.ok(!(await h.api(["pane", "list"])).panes.some((pane) => pane.terminal_id === oldTerminal));
 assert.ok(!readdirSync(h.run(handle).runDir).some((file) => file.startsWith("lifecycle-") && file.endsWith(".lock")));
 if (!existsSync(parentFile)) {
  const saved = (readdirSync(join(h.dir, "sessions"), { recursive: true }) as string[]).find((file) => file.endsWith("parent.jsonl"));
  assert.ok(saved); parentFile = join(h.dir, "sessions", saved);
 }
 await h.api(["pane", "close", parent.pane]);
 parent = await h.openParent(parentFile);
 await until(() => h.run(handle).terminal?.phase === "ready" && h.run(handle).terminal?.suspended === false && h.run(handle).state === "idle", "child was skipped after lost reply");
 assert.notEqual(h.run(handle).terminal!.terminalId, oldTerminal);
 assert.ok(readFileSync(h.run(handle).sessionFile, "utf8").startsWith(before));
 await h.cli(["send", handle, "after lost reply recovery"]);
 assert.match((await h.cli(["wait", handle, "--timeout", "10"])).stdout, /after lost reply recovery/);
 h.check("durable suspension intent survives a lost real-close response and restores history");
});

test("two real parent instances restoring one session create one child", { skip: !enabled, timeout: 90000 }, async (t) => {
 const h = await harness(t);
 let parentFile = join(h.dir, "parent.jsonl");
 const parent = await h.openParent(parentFile);
 await h.api(["agent", "prompt", parent.pane, "parent hello", "--wait", "--timeout", "10000"]);
 parentFile = (await h.api(["agent", "get", parent.pane])).agent.agent_session.value;
 h.setParentId(JSON.parse(readFileSync(parentFile, "utf8").split("\n")[0]).id);
 const handle = await h.spawn("concurrent restore child", "before concurrent restore");
 await h.cli(["wait", handle, "--timeout", "10"]);
 const before = readFileSync(h.run(handle).sessionFile, "utf8");
 await h.api(["agent", "send-keys", parent.pane, "ctrl+d"]);
 await until(() => h.run(handle).terminal?.phase === "closed" && h.run(handle).terminal?.suspended === true, "child did not suspend");
 if (!existsSync(parentFile)) {
  const saved = (readdirSync(join(h.dir, "sessions"), { recursive: true }) as string[]).find((file) => file.endsWith("parent.jsonl"));
  assert.ok(saved); parentFile = join(h.dir, "sessions", saved);
 }
 await h.api(["pane", "close", parent.pane]);
 await Promise.all([h.openParent(parentFile, "-one"), h.openParent(parentFile, "-two")]);
 await until(() => h.run(handle).terminal?.phase === "ready" && h.run(handle).terminal?.suspended === false && h.run(handle).state === "idle", "concurrent child did not resume");
 const matching = (await h.api(["pane", "list"])).panes.filter((pane) => pane.agent_session?.value === h.run(handle).sessionFile);
 assert.equal(matching.length, 1);
 assert.ok(readFileSync(h.run(handle).sessionFile, "utf8").startsWith(before));
 assert.ok(!readdirSync(h.run(handle).runDir).some((file) => file.startsWith("lifecycle-") && file.endsWith(".lock")));
 await h.cli(["stop", handle]);
 h.check("concurrent real parent restore creates one managed child and releases lifecycle ownership");
});
