import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { readMetadata, runIsRunning, stopRun } from "../shared.ts";

const session = process.env.REX_SESSION;
const root = resolve(import.meta.dirname, "..");
async function until(check: () => boolean, message: string) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail(message);
}

test("parent Pi: visible child tabs, /subagent focus, reload, suspend and resume", { skip: !session, timeout: 90000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-parent-test-"));
	t.diagnostic(`Evidence: ${dir}`);
	const rex = (args: string[]) => {
		const result = spawnSync("rex", args, { encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};
	const snapshot = (name: string) => {
		const state = JSON.parse(rex(["session", "inspect", session!, "--json"]));
		writeFileSync(join(dir, `${name}.json`), JSON.stringify(state, null, 2));
		return state;
	};
	const initial = snapshot("initial");
	let parentFile = join(dir, "parent.jsonl");
	const provider = join(root, "tests/fixtures/provider.ts");
	writeFileSync(join(dir, "pi-test.sh"), `#!/bin/sh\nexec pi --extension '${provider}' "$@"\n`, { mode: 0o700 });
	const openParent = (initialPrompt: string[]) => JSON.parse(rex([
		"window", "new", "-s", session!, "subagent-parent-test", "--focus=false", "--shell=none", "--json", "-c", dir,
		"--", "env", "-u", "PI_SUBAGENT_RUN_DIR", `PI_CODING_AGENT_DIR=${dir}`, `PATH=${process.env.PATH}`,
		"pi", "--no-extensions", "--extension", join(root, "index.ts"), "--extension", provider,
		"--provider", "subagent-test", "--model", "fixture", "--thinking", "off", "--no-skills", "--no-context-files", "--no-prompt-templates", "--session", parentFile, ...initialPrompt,
	])).block_ids[0] as string;
	let parent: string | undefined;
	let runDir: string | undefined;
	try {
		parent = openParent(["parent fixture"]);
		await until(() => existsSync(parentFile) && readFileSync(parentFile, "utf8").includes("fixture answer"), "Parent Pi did not start");
		const parentId = JSON.parse(readFileSync(parentFile, "utf8").split("\n")[0]).id;
		const cli = (args: string[]) => {
			const result = spawnSync(process.execPath, [join(root, "subagent.ts"), ...args], {
				cwd: dir, env: { ...process.env, PI_SUBAGENT_RUN_DIR: "", PI_CODING_AGENT_DIR: dir, PI_SESSION_ID: parentId, PI_PROVIDER: "subagent-test", PI_MODEL: "fixture", PI_REASONING_LEVEL: "off" }, encoding: "utf8", timeout: 15000,
			});
			writeFileSync(join(dir, `cli-${args[0]}.txt`), result.stdout + result.stderr);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout;
		};
		rex(["focus", "-s", session!, parent]);
		const parentWindow = JSON.parse(rex(["block", "inspect", "-s", session!, parent, "--json"])).block.window_id;
		const spawned = cli(["spawn", "--name", "parent test child", "--no-extensions", "--no-skills", "--no-context-files", "--prompt", "child fixture"]);
		const handle = spawned.match(/\(([a-f0-9]{6})\)/)![1];
		runDir = join(dir, "subagents", handle);
		await until(() => readMetadata(runDir!)?.hasStarted === true && readMetadata(runDir!)?.state === "idle", "Child Pi did not complete");
		assert.match(cli(["wait", handle, "--timeout", "5"]), /fixture answer/);
		cli(["send", handle, "--follow-up", "child follow-up"]);
		assert.match(cli(["wait", handle, "--timeout", "5"]), /fixture answer/);
		const oldBlock = readMetadata(runDir)!.rexBlock!;
		const processBefore = JSON.parse(rex(["block", "call", "-s", session!, "-b", oldBlock, "process"]));
		const inspect = () => JSON.parse(rex(["block", "inspect", "-s", session!, oldBlock, "--json"])).block;
		const child = inspect();
		const spawnedState = snapshot("spawned");
		assert.equal(child.placement, "placed", "Child must start in a visible tab");
		assert.notEqual(child.window_id, parentWindow, "Child must have its own tab");
		assert(spawnedState.windows.some((window: { window_id: string; label: string }) => window.window_id === child.window_id && window.label.includes("parent test child")));
		assert.equal(spawnedState.active_window_id, parentWindow, "Spawn must keep the parent tab active");
		await until(() => {
			const status = JSON.parse(rex(["block", "call", "-s", session!, "-b", parent!, "program_status"]));
			return status.records.some((record: { id?: string; state: string }) => record.id === `subagent/${handle}` && record.state === "done");
		}, "Child status was not mirrored into parent terminal");
		for (let attempt = 0; attempt < 2; attempt++) {
			rex(["focus", "-s", session!, parent]);
			rex(["send", "-s", session!, "-b", parent, "/subagent"]);
			rex(["send-key", "-s", session!, "-b", parent, "enter"]);
			await until(() => rex(["capture", "-s", session!, "-b", parent!, "--trim"]).includes("Switch to subagent"), "Subagent selector did not open");
			rex(["send-key", "-s", session!, "-b", parent, "enter"]);
			await until(() => JSON.parse(rex(["session", "inspect", session!, "--json"])).active_window_id === child.window_id, "Subagent tab did not receive focus");
			const focused = snapshot(`focused-${attempt}`);
			assert.equal(focused.windows.find((window: { window_id: string }) => window.window_id === child.window_id).focused_block_id, oldBlock);
			assert.equal(inspect().placement, "placed");
			assert.equal(inspect().window_id, child.window_id);
		}
		rex(["focus", "-s", session!, parent]);
		const processAfter = JSON.parse(rex(["block", "call", "-s", session!, "-b", oldBlock, "process"]));
		assert.equal(processAfter.child.pid, processBefore.child.pid);
		rex(["send", "-s", session!, "-b", parent, "/reload"]);
		rex(["send-key", "-s", session!, "-b", parent, "enter"]);
		await until(() => rex(["capture", "-s", session!, "-b", parent!, "--trim"]).includes("Reloaded"), "Parent did not reload");
		assert.equal(readMetadata(runDir)!.rexBlock, oldBlock);
		assert.equal(runIsRunning(readMetadata(runDir)!), true);
		rex(["send-key", "-s", session!, "-b", parent, "ctrl+d"]);
		await until(() => readMetadata(runDir!)?.suspended === true && runIsRunning(readMetadata(runDir!)!) === false, "Parent quit did not suspend child");
		// Pi can move a custom session file into its session directory on shutdown.
		if (!existsSync(parentFile)) {
			const files = readdirSync(join(dir, "sessions"), { recursive: true }) as string[];
			const saved = files.find(file => file.endsWith("parent.jsonl"));
			assert(saved, "Saved parent transcript was not found");
			parentFile = join(dir, "sessions", saved);
		}
		rex(["focus", "-s", session!, initial.active_window_id]);
		const beforeResume = snapshot("before-resume");
		parent = openParent([]);
		await until(() => readMetadata(runDir!)?.rexBlock !== oldBlock && readMetadata(runDir!)?.suspended === undefined && readMetadata(runDir!)?.state === "idle", "Parent resume did not relaunch child idle");
		const resumed = readMetadata(runDir)!;
		const resumedBlock = JSON.parse(rex(["block", "inspect", "-s", session!, resumed.rexBlock!, "--json"])).block;
		const resumedState = snapshot("resumed");
		assert.equal(resumedBlock.placement, "placed", "Resumed child must have a visible tab");
		assert.equal(resumedState.active_window_id, beforeResume.active_window_id, "Resume must keep the current tab active");
		assert(resumedState.windows.some((window: { window_id: string }) => window.window_id === resumedBlock.window_id));
		assert(readFileSync(resumed.sessionFile, "utf8").includes("child follow-up"));
		cli(["stop", handle]);
		assert.equal(existsSync(runDir), false);
		assert.equal(runIsRunning(resumed), false);
		assert(!snapshot("stopped").windows.some((window: { window_id: string }) => window.window_id === resumedBlock.window_id));
		writeFileSync(join(dir, "result.json"), JSON.stringify({ passed: true, checks: ["CLI spawn/send/wait/stop", "child starts in a named tab without stealing focus", "child status mirrored", "/subagent switches tabs repeatedly without hiding or changing PID", "reload preserves block", "quit suspends child", "resume preserves history in a visible tab", "stop removes the child tab"] }, null, 2));
	} finally {
		if (parent) {
			try { writeFileSync(join(dir, "terminal.txt"), rex(["capture", "-s", session!, "-b", parent, "--trim"])); } catch {}
			spawnSync("rex", ["block", "close", "-s", session!, parent]);
		}
		if (runDir && readMetadata(runDir)) stopRun(readMetadata(runDir)!);
		spawnSync("rex", ["focus", "-s", session!, initial.active_window_id]);
	}
});
