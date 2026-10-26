import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { focusRun, launchRun, readMetadata, runIsRunning, stopRun, writeMetadata, type RunMetadata } from "../shared.ts";

const root = resolve(import.meta.dirname, "..");
const session = process.env.REX_SESSION;
async function until(check: () => boolean, message: string) {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.fail(message);
}

test("real Pi in Rex: visible permission tab, inbox response, transcript resume", { skip: !session, timeout: 90000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-subagent-pi-test-"));
	t.diagnostic(`Evidence: ${dir}`);
	const runDir = join(dir, "run");
	mkdirSync(join(runDir, "inbox"), { recursive: true });
	const now = new Date().toISOString();
	let run: RunMetadata = {
		version: 1, handle: "abcdef", name: "Pi integration test", rexSession: session!,
		runDir, sessionFile: join(runDir, "session.jsonl"), cwd: dir,
		provider: "subagent-test", model: "fixture", thinking: "off", state: "starting", hasStarted: false,
		createdAt: now, updatedAt: now,
		launchArgs: ["--no-extensions", "--extension", join(root, "index.ts"), "--extension", join(root, "tests/fixtures/provider.ts"), "--no-skills", "--no-context-files", "--no-prompt-templates"],
	};
	writeMetadata(run);
	const rex = (args: string[]) => {
		const result = spawnSync("rex", args, { encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};
	const initial = JSON.parse(rex(["session", "inspect", session!, "--json"]));
	try {
		launchRun(run, ["ask permission"]);
		run = readMetadata(runDir)!;
		await until(() => readMetadata(runDir)?.state === "blocked", "Real Pi did not reach permission prompt");
		const blocked = JSON.parse(rex(["block", "call", "-s", session!, "-b", run.rexBlock!, "program_status"]));
		writeFileSync(join(dir, "blocked.json"), JSON.stringify(blocked, null, 2));
		assert(blocked.records.some((r: { state: string; kind: string }) => r.state === "blocked" && r.kind === "permission"));
		const block = JSON.parse(rex(["block", "inspect", "-s", session!, run.rexBlock!, "--json"])).block;
		assert.equal(block.placement, "placed", "Permission prompt must be in a visible tab");
		focusRun(run, session!);
		const focused = JSON.parse(rex(["session", "inspect", session!, "--json"]));
		assert.equal(focused.active_window_id, block.window_id);
		assert.equal(focused.windows.find((window: { window_id: string }) => window.window_id === block.window_id).focused_block_id, run.rexBlock);
		writeFileSync(join(dir, "permission-tab.json"), JSON.stringify(focused, null, 2));
		rex(["send-key", "-s", session!, "-b", run.rexBlock!, "enter"]);
		await until(() => readMetadata(runDir)?.state === "idle" && readFileSync(run.sessionFile, "utf8").includes("fixture answer"), "Real Pi did not complete fixture response");
		const done = JSON.parse(rex(["block", "call", "-s", session!, "-b", run.rexBlock!, "program_status"]));
		assert(done.records.some((r: { state: string }) => r.state === "done"));
		const transcript = readFileSync(run.sessionFile, "utf8");
		writeMetadata({ ...readMetadata(runDir)!, suspended: true });
		stopRun(run);
		assert.equal(runIsRunning(run), false);
		launchRun(readMetadata(runDir)!);
		run = readMetadata(runDir)!;
		await until(() => readMetadata(runDir)?.suspended === undefined && readMetadata(runDir)?.state === "idle", "Real Pi did not resume idle");
		assert(readFileSync(run.sessionFile, "utf8").startsWith(transcript));
		writeFileSync(join(runDir, "inbox", "followup.json"), JSON.stringify({ message: "follow-up after resume", delivery: "followUp" }));
		await until(() => readFileSync(run.sessionFile, "utf8").split("fixture answer").length >= 3 && readMetadata(runDir)?.state === "idle", "Real Pi did not process inbox after resume");
		writeFileSync(join(runDir, "inbox", "failure.json"), JSON.stringify({ message: "fixture failure", delivery: "auto" }));
		await until(() => readMetadata(runDir)?.outcome === "error", "Real Pi did not record failure outcome");
		const failed = JSON.parse(rex(["block", "call", "-s", session!, "-b", run.rexBlock!, "program_status"]));
		assert(failed.records.some((r: { state: string }) => r.state === "error"));
		writeFileSync(join(dir, "result.json"), JSON.stringify({ passed: true, checks: ["real extension loaded", "permission prompt in a visible tab", "switch to permission tab", "blocked permission", "done status", "history preserved", "inbox after resume", "error status"] }, null, 2));
	} finally {
		if (run.rexBlock) {
			writeFileSync(join(dir, "terminal.txt"), rex(["capture", "-s", session!, "-b", run.rexBlock, "--trim"]));
			stopRun(run);
		}
		rex(["focus", "-s", session!, initial.active_window_id]);
	}
});
