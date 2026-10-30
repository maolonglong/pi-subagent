import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	detectBackend, delay, getAgentDir, readMetadata, resolveRunPane, runIsRunning, runTabName,
	updateRunState, writeTerminal, type TerminalPane, type RunMetadata, type TerminalRecord,
} from "./shared.ts";

const exec = promisify(execFile);
const extension = fileURLToPath(new URL("index.ts", import.meta.url));

export async function rex<T = unknown>(args: string[]): Promise<T> {
	if (detectBackend() !== "rex") throw new Error("Open this run inside Rex; run data was preserved");
	try {
		const { stdout } = await exec("rex", ["--autostart=false", "--timeout", "3s", ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
		return (stdout.trim() ? JSON.parse(stdout) : undefined) as T;
	} catch (error) {
		const failure = error as Error & { stderr?: string };
		throw new Error(failure.stderr?.trim() || failure.message);
	}
}

async function context() {
	const value = await rex<{ endpoint: string; instance_id: string; session_id?: string }>(["whoami", "--json"]);
	if (!value.endpoint || !value.instance_id || !value.session_id || value.session_id !== process.env.REX_SESSION) throw new Error("Rex caller session is unavailable; run data was preserved");
	return { session: value.session_id, endpoint: `${value.endpoint}#${value.instance_id}` };
}

export async function listRexPanes(): Promise<TerminalPane[] & { rexEndpoint: string }> {
	const current = await context();
	const { blocks } = await rex<{ blocks: { block_id: string; window_id: string; creator_name: string }[] }>(["block", "ls", "-s", current.session, "--json"]);
	const panes = await Promise.all(blocks.filter((block) => block.creator_name === "com.superlogical.terminal").map(async (block): Promise<TerminalPane> => {
		const info = await rex<{ child?: { pid: number }; foreground?: { pid: number }; last_exit?: { exit_code: number } | null }>(["block", "call", "-s", current.session, "-b", block.block_id, "process"]);
		if (!info.child && !info.last_exit) throw new Error("Rex process state is uncertain; run data was preserved");
		return { pane_id: block.block_id, terminal_id: block.block_id, tab_id: block.window_id, rexPid: info.foreground?.pid, rexAlive: !!info.child };
	}));
	return Object.assign(panes, { rexEndpoint: current.endpoint });
}

export async function focusRexRun(run: RunMetadata): Promise<void> {
	if (!await runIsRunning(run)) throw new Error("The subagent session is no longer in its terminal");
	const pane = resolveRunPane(run, await listRexPanes());
	if (!pane) throw new Error("The subagent terminal closed before switching tabs");
	await rex(["focus", "-s", run.terminal!.rexSession!, pane.pane_id]);
	await rex(["do", "session.select", `session_id=${run.terminal!.rexSession}`, `window_id=${pane.tab_id}`]);
}

export async function renameRexRun(run: RunMetadata): Promise<void> {
	if (!await runIsRunning(run)) return;
	const pane = resolveRunPane(run, await listRexPanes());
	if (pane) await rex(["window", "rename", "-s", run.terminal!.rexSession!, pane.tab_id, runTabName(run)]);
}

export async function stopRexRun(run: RunMetadata, suspend: boolean): Promise<void> {
	const pane = resolveRunPane(run, await listRexPanes());
	const running = pane ? await runIsRunning(run) : false;
	if (pane) {
		if (suspend && running && !writeTerminal(run.runDir, { ...run.terminal!, suspended: true })) throw new Error("Run was removed before suspension");
		await rex(["block", "close", "-s", run.terminal!.rexSession!, pane.pane_id]);
		const deadline = Date.now() + 3000;
		while ((await listRexPanes()).some((candidate) => candidate.terminal_id === pane.terminal_id)) {
			if (Date.now() >= deadline) throw new Error("Rex terminal close was not confirmed; run data was preserved");
			await delay(100);
		}
	}
	writeTerminal(run.runDir, { ...run.terminal!, phase: "closed", error: undefined, suspended: suspend ? running || run.terminal?.suspended : false });
}

export async function launchRexRun(run: RunMetadata, initialArgs: string[]): Promise<void> {
	const current = await context();
	if (run.terminal) {
		if (resolveRunPane(run, await listRexPanes())) throw new Error("A terminal already exists for this run; inspect it before retrying");
		if (run.terminal.phase !== "closed" && !run.terminal.suspended) throw new Error("Previous launch is uncertain; run data was preserved");
	}
	if (!existsSync(run.sessionFile)) throw new Error("Subagent transcript is missing; run data was preserved");
	const args = initialArgs.map((argument, index) => {
		if (!/[\r\n]/.test(argument)) return argument;
		const path = join(run.runDir, `initial-${index}.txt`);
		writeFileSync(path, argument, { mode: 0o600 });
		return `@${path}`;
	});
	let terminal: TerminalRecord = { socketPath: current.endpoint, rexSession: current.session, phase: "creating", suspended: run.terminal?.suspended };
	if (!writeTerminal(run.runDir, terminal)) throw new Error("Run was removed before launch");
	updateRunState(run.runDir, { state: "starting", pid: undefined, childSessionId: undefined, outcome: undefined, error: undefined });
	try {
		const created = await rex<{ block_ids: string[] }>([
			"window", "new", "-s", current.session, runTabName(run), "-c", run.cwd, "--shell=none", "--focus=false", "--json", "--",
			"env", `PI_SUBAGENT_RUN_DIR=${run.runDir}`, `PI_CODING_AGENT_DIR=${getAgentDir()}`, `PATH=${process.env.PATH ?? ""}`,
			"pi", "--session", run.sessionFile, "--provider", run.provider, "--model", run.model, "--thinking", run.thinking,
			...(run.launchArgs ?? []), "--extension", extension, ...args,
		]);
		if (!created.block_ids?.[0]) throw new Error("Rex did not return a terminal identity");
		terminal = { ...terminal, terminalId: created.block_ids[0], paneId: created.block_ids[0] };
		if (!writeTerminal(run.runDir, terminal)) throw new Error("Run disappeared after creating its Rex terminal; inspect Rex");
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			const latest = readMetadata(run.runDir);
			if (!latest) throw new Error("Run was removed during launch");
			if (latest.pid && latest.childSessionId && await runIsRunning(latest)) {
				if (!writeTerminal(run.runDir, { ...terminal, phase: "ready", suspended: false })) throw new Error("Run was removed before startup confirmation");
				return;
			}
			await delay(100);
		}
		throw new Error("Pi did not publish the expected session within 30s; inspect its tab before retrying");
	} catch (error) {
		writeTerminal(run.runDir, { ...terminal, phase: "uncertain", error: String(error) });
		throw new Error(`Could not start ${run.handle}: ${error}`);
	}
}
