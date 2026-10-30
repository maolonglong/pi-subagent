import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { listRexPanes, launchRexRun, stopRexRun, focusRexRun, renameRexRun } from "./rex.ts";

export type Backend = "herdr" | "rex";

export function detectBackend(env: NodeJS.ProcessEnv = process.env): Backend | undefined {
	if (env.HERDR_ENV === "1" && env.HERDR_SOCKET_PATH && env.HERDR_WORKSPACE_ID && env.HERDR_PANE_ID) return "herdr";
	if (env.REX_SESSION && env.REX_BLOCK) return "rex";
	return undefined;
}

export function requireBackend(): Backend {
	const backend = detectBackend();
	if (!backend) throw new Error("Run this command inside a Herdr-managed pane or Rex terminal");
	return backend;
}

export type RunState = "starting" | "busy" | "blocked" | "idle" | "exited" | "error";

export interface RunConfig {
	version: 2;
	backend: Backend;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	launchArgs?: string[];
	createdAt: string;
	updatedAt: string;
}

export interface RunStatus {
	state: RunState;
	hasStarted: boolean;
	childSessionId?: string;
	sessionFile?: string;
	pid?: number;
	outcome?: "completed" | "aborted" | "error";
	error?: string;
}

export interface TerminalRecord {
	socketPath: string;
	rexSession?: string;
	phase: "creating" | "ready" | "closed" | "uncertain";
	terminalId?: string;
	paneId?: string;
	suspended?: boolean;
	error?: string;
}

export type RunMetadata = Omit<RunConfig, "sessionFile"> & RunStatus & {
	sessionFile: string;
	terminal?: TerminalRecord;
};

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

export interface TerminalPane {
	rexPid?: number;
	rexAlive?: boolean;
	pane_id: string;
	tab_id: string;
	terminal_id: string;
	agent?: string;
	agent_status?: string;
	agent_session?: { kind: string; value: string };
}

export type PaneSnapshot = TerminalPane[] & { rexEndpoint?: string };

interface ProcessInfo {
	shell_pid: number;
	foreground_process_group_id: number;
	foreground_processes: { pid: number }[];
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}
interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}
interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

const execFileAsync = promisify(execFile);
const extensionPath = fileURLToPath(new URL("index.ts", import.meta.url));
const states = new Set<RunState>(["starting", "busy", "blocked", "idle", "exited", "error"]);
export const delay = (milliseconds: number): Promise<void> => new Promise((done) => setTimeout(done, milliseconds));

export function getAgentDir(): string {
	return resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}
export function getRunsDir(): string { return join(getAgentDir(), "subagents"); }
export function metadataPath(runDir: string): string { return join(runDir, "metadata.json"); }
export function inboxDir(runDir: string): string { return join(runDir, "inbox"); }

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch { return undefined; }
}

/** Updates never recreate a run directory removed by stop. */
function writeJson(path: string, value: unknown): boolean {
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(dirname(path))) return false;
		throw error;
	} finally { rmSync(temporary, { force: true }); }
}

export function isValidRunName(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 64 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
export function runDisplayName(run: RunConfig): string {
	return run.name ? `${run.name} (${run.handle})` : run.handle;
}
export function runTabName(run: RunConfig): string { return `subagent ${runDisplayName(run)}`; }

function readConfig(runDir: string): RunConfig | undefined {
	const value = readJson(metadataPath(runDir));
	if (!value || value.version !== 2 || (value.backend !== "herdr" && value.backend !== "rex") ||
		typeof value.handle !== "string" || !/^[a-f0-9]{6}$/.test(value.handle) ||
		(value.name !== undefined && !isValidRunName(value.name)) ||
		typeof value.runDir !== "string" || resolve(value.runDir) !== resolve(runDir) ||
		![value.sessionFile, value.cwd].every((item) => typeof item === "string" && isAbsolute(item)) ||
		![value.provider, value.model, value.thinking, value.createdAt, value.updatedAt].every((item) => typeof item === "string") ||
		(value.launchArgs !== undefined && (!Array.isArray(value.launchArgs) || !value.launchArgs.every((item) => typeof item === "string")))) return undefined;
	return value as unknown as RunConfig;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	const config = readConfig(runDir);
	if (!config) return undefined;
	const status = readJson(join(runDir, "state.json"));
	const terminal = readJson(join(runDir, "terminal.json"));
	const validStatus = status && states.has(status.state as RunState) && typeof status.hasStarted === "boolean";
	return {
		...config,
		state: validStatus ? status.state as RunState : "starting",
		hasStarted: validStatus ? status.hasStarted as boolean : false,
		childSessionId: typeof status?.childSessionId === "string" ? status.childSessionId : undefined,
		sessionFile: typeof status?.sessionFile === "string" && isAbsolute(status.sessionFile) ? status.sessionFile : config.sessionFile,
		pid: typeof status?.pid === "number" && Number.isSafeInteger(status.pid) && status.pid > 0 ? status.pid : undefined,
		outcome: status?.outcome === "completed" || status?.outcome === "aborted" || status?.outcome === "error" ? status.outcome : undefined,
		error: typeof status?.error === "string" ? status.error : undefined,
		terminal: terminal && typeof terminal.socketPath === "string" && ["creating", "ready", "closed", "uncertain"].includes(terminal.phase as string) &&
			(terminal.rexSession === undefined || typeof terminal.rexSession === "string") &&
			(terminal.terminalId === undefined || typeof terminal.terminalId === "string") && (terminal.paneId === undefined || typeof terminal.paneId === "string")
			? terminal as unknown as TerminalRecord : undefined,
	};
}

/** Config belongs to the CLI; child status and parent control have separate writers. */
export function writeMetadata(config: RunConfig): void {
	mkdirSync(config.runDir, { recursive: true, mode: 0o700 });
	writeJson(metadataPath(config.runDir), config);
	if (!existsSync(join(config.runDir, "state.json"))) writeJson(join(config.runDir, "state.json"), { state: "starting", hasStarted: false });
}
export function updateMetadata(runDir: string, patch: Pick<RunConfig, "name">): RunMetadata | undefined {
	const config = readConfig(runDir);
	if (!config) return undefined;
	writeJson(metadataPath(runDir), { ...config, name: patch.name, updatedAt: new Date().toISOString() });
	return readMetadata(runDir);
}
export function updateRunState(runDir: string, patch: Partial<RunStatus>): void {
	if (!readConfig(runDir)) return;
	const state: Record<string, unknown> = readJson(join(runDir, "state.json")) ?? { state: "starting", hasStarted: false };
	// Copy only child-owned fields, even when a caller holds an old merged snapshot.
	for (const key of ["state", "hasStarted", "childSessionId", "sessionFile", "pid", "outcome", "error"] as const) {
		if (Object.hasOwn(patch, key)) state[key] = patch[key];
	}
	writeJson(join(runDir, "state.json"), state);
}
export function writeTerminal(runDir: string, terminal: TerminalRecord): boolean {
	return !!readConfig(runDir) && writeJson(join(runDir, "terminal.json"), terminal);
}
export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function requireHerdr(): void {
	if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_SOCKET_PATH || !process.env.HERDR_WORKSPACE_ID || !process.env.HERDR_PANE_ID) {
		throw new Error("Run this command inside a Herdr-managed pane (HERDR_ENV=1 and caller context are required)");
	}
}
export function findHerdrIntegration(): string {
	for (const path of new Set([join(getAgentDir(), "extensions", "herdr-agent-state.ts"), join(homedir(), ".pi", "agent", "extensions", "herdr-agent-state.ts")])) {
		if (!existsSync(path)) continue;
		const source = readFileSync(path, "utf8");
		if (source.includes("HERDR_INTEGRATION_ID=pi") && source.includes('"herdr:blocked"')) return path;
	}
	throw new Error("Herdr Pi integration is missing or incompatible; run herdr integration install pi");
}

export async function herdr<T = unknown>(args: string[]): Promise<T> {
	requireHerdr();
	try {
		const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
		if (!stdout.trim()) return undefined as T;
		const value = JSON.parse(stdout);
		return (value.result ?? value) as T;
	} catch (error) {
		const failure = error as Error & { stderr?: string };
		throw new Error(failure.stderr?.trim() || failure.message);
	}
}
export async function listPanes(backend: Backend = requireBackend()): Promise<PaneSnapshot> {
	if (backend === "rex") return listRexPanes();
	return (await herdr<{ panes: TerminalPane[] }>(["pane", "list"])).panes;
}

function canonical(path: string): string {
	try { return realpathSync(path); } catch { return resolve(path); }
}
function ownsAgent(run: RunMetadata, pane: TerminalPane): boolean {
	if (run.backend === "rex") return !!run.pid && !!run.childSessionId && pane.rexPid === run.pid;
	return pane.agent === "pi" && pane.agent_session?.kind === "path" && canonical(pane.agent_session.value) === canonical(run.sessionFile);
}
export function resolveRunPane(run: RunMetadata, panes: PaneSnapshot): TerminalPane | undefined {
	if (run.backend === "rex") {
		if (!run.terminal?.rexSession || run.terminal.rexSession !== process.env.REX_SESSION || detectBackend() !== "rex" ||
			panes.rexEndpoint !== run.terminal.socketPath) throw new Error("Rex endpoint is unavailable or different; run data was preserved");
	} else if (!run.terminal || run.terminal.socketPath !== process.env.HERDR_SOCKET_PATH || panes.rexEndpoint) throw new Error("Herdr endpoint is unavailable or different; run data was preserved");
	if (!run.terminal.terminalId) {
		if (run.terminal.phase === "closed") return undefined;
		throw new Error(`Terminal identity is uncertain for ${run.handle}; inspect ${run.backend} before retrying; run data was preserved`);
	}
	return panes.find((pane) => pane.terminal_id === run.terminal!.terminalId);
}
export function effectiveRunState(run: RunMetadata, panes: PaneSnapshot | undefined): RunState | "unavailable" {
	if (!panes) return "unavailable";
	try {
		const pane = resolveRunPane(run, panes);
		if (!pane) return "exited";
		if (run.backend === "rex" && !ownsAgent(run, pane)) return pane.rexAlive ? "unavailable" : "exited";
		if (!ownsAgent(run, pane)) return pane.agent || run.terminal?.phase !== "ready" ? "unavailable" : "exited";
		if (run.state === "idle" && run.outcome === "error") return "error";
		return run.state;
	} catch { return "unavailable"; }
}
export async function runIsRunning(run: RunMetadata): Promise<boolean> {
	const pane = resolveRunPane(run, await listPanes(run.backend));
	if (!pane) return false;
	if (run.backend === "rex") {
		if (ownsAgent(run, pane)) return true;
		if (pane.rexAlive) throw new Error("Rex terminal ownership cannot be confirmed; run data was preserved");
		return false;
	}
	if (!ownsAgent(run, pane)) {
		if (pane.agent) throw new Error("Terminal belongs to another session; run data was preserved");
		return false;
	}
	const { process_info: info } = await herdr<{ process_info: ProcessInfo }>(["pane", "process-info", "--pane", pane.pane_id]);
	if (!run.pid || !info.foreground_processes.some((process) => process.pid === run.pid)) throw new Error("Subagent is not in the foreground; run data was preserved");
	return true;
}
export async function focusRun(run: RunMetadata): Promise<void> {
	if (run.backend === "rex") return focusRexRun(run);
	const pane = resolveRunPane(run, await listPanes("herdr"));
	if (!pane || !ownsAgent(run, pane)) throw new Error("The subagent session is no longer in its terminal");
	await herdr(["tab", "focus", pane.tab_id]);
}
export async function renameRunTab(run: RunMetadata): Promise<void> {
	if (run.backend === "rex") return renameRexRun(run);
	const pane = resolveRunPane(run, await listPanes("herdr"));
	if (pane) {
		if (!ownsAgent(run, pane)) throw new Error("Terminal belongs to another session; rename was not applied");
		await herdr(["tab", "rename", pane.tab_id, runTabName(run)]);
	}
}

/** Bakery tickets serialize local controllers; dead owners have unique files that can be safely reclaimed. */
async function withRunLifecycle<T>(runDir: string, operation: (current: RunMetadata) => Promise<T>): Promise<T> {
	const name = `lifecycle-${randomUUID()}.lock`;
	const path = join(runDir, name);
	const claim = { pid: process.pid, ticket: 0, startedAt: new Date().toISOString() };
	if (!writeJson(path, claim)) throw new Error("Run was removed before the lifecycle operation");
	const claims = (): { name: string; ticket: number }[] => {
		const active: { name: string; ticket: number }[] = [];
		for (const file of readdirSync(runDir).filter((file) => file.startsWith("lifecycle-") && file.endsWith(".lock"))) {
			const ownerPath = join(runDir, file);
			const owner = readJson(ownerPath);
			if (!owner && !existsSync(ownerPath)) continue;
			if (!owner || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || !Number.isSafeInteger(owner.ticket) || (owner.ticket as number) < 0) {
				throw new Error(`Invalid lifecycle owner at ${ownerPath}; run data was preserved`);
			}
			try { process.kill(owner.pid as number, 0); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") { rmSync(ownerPath, { force: true }); continue; }
				if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
			}
			active.push({ name: file, ticket: owner.ticket as number });
		}
		return active;
	};
	try {
		claim.ticket = Math.max(0, ...claims().map((owner) => owner.ticket)) + 1;
		if (!Number.isSafeInteger(claim.ticket) || !writeJson(path, claim)) throw new Error("Lifecycle ownership could not be recorded");
		const deadline = Date.now() + 5000;
		while (true) {
			const active = claims();
			if (!active.some((owner) => owner.name === name)) throw new Error("Lifecycle ownership was removed");
			if (active.some((owner) => owner.name !== name && owner.ticket === 0)) {
				if (Date.now() >= deadline) throw new Error("Another controller is choosing lifecycle ownership; retry after it finishes");
				await delay(20);
				continue;
			}
			if (active.some((owner) => owner.name !== name && (owner.ticket < claim.ticket || owner.ticket === claim.ticket && owner.name < name))) {
				throw new Error("A lifecycle operation already owns this run; retry after it finishes");
			}
			const current = readMetadata(runDir);
			if (!current) throw new Error("Run was removed before the lifecycle operation");
			return await operation(current);
		}
	} finally { rmSync(path, { force: true }); }
}

export async function stopRun(run: RunMetadata, suspend = false): Promise<void> {
	await withRunLifecycle(run.runDir, (current) => stopRunUnlocked(current, suspend));
}

/** Close only an identified child or its idle shell; never close the whole tab. */
async function stopRunUnlocked(run: RunMetadata, suspend: boolean): Promise<void> {
	if (run.backend === "rex") return stopRexRun(run, suspend);
	const pane = resolveRunPane(run, await listPanes("herdr"));
	let running = false;
	if (pane) {
		if (pane.agent && !ownsAgent(run, pane)) throw new Error("Refusing to close another agent session; run data was preserved");
		const { process_info: info } = await herdr<{ process_info: ProcessInfo }>(["pane", "process-info", "--pane", pane.pane_id]);
		const shellIdle = info.foreground_process_group_id === info.shell_pid && info.foreground_processes.every((process) => process.pid === info.shell_pid);
		running = ownsAgent(run, pane);
		if (!shellIdle && (!running || !run.pid || !info.foreground_processes.some((process) => process.pid === run.pid))) {
			throw new Error("Refusing to close a reused terminal; run data was preserved");
		}
		if (suspend && running && !writeTerminal(run.runDir, { ...run.terminal!, suspended: true })) throw new Error("Run was removed before suspension");
		await herdr(["pane", "close", pane.pane_id]);
		const deadline = Date.now() + 3000;
		while ((await listPanes("herdr")).some((candidate) => candidate.terminal_id === pane.terminal_id)) {
			if (Date.now() >= deadline) throw new Error("Terminal close was not confirmed; run data was preserved");
			await delay(100);
		}
	}
	writeTerminal(run.runDir, { ...run.terminal!, phase: "closed", error: undefined, suspended: suspend ? running || run.terminal?.suspended : false });
}

export async function resumeRun(run: RunMetadata): Promise<void> {
	await withRunLifecycle(run.runDir, async (current) => {
		if (!current.terminal?.suspended) return;
		if (await runIsRunning(current)) writeTerminal(current.runDir, { ...current.terminal, phase: "ready", suspended: false, error: undefined });
		else await launchRunUnlocked(current, []);
	});
}

export async function launchRun(run: RunMetadata, initialArgs: string[] = []): Promise<void> {
	await withRunLifecycle(run.runDir, (current) => launchRunUnlocked(current, initialArgs));
}

/** Initial task text is a file argument so multiline prompts never enter shell command text. */
async function launchRunUnlocked(run: RunMetadata, initialArgs: string[]): Promise<void> {
	if (run.backend === "rex") return launchRexRun(run, initialArgs);
	requireHerdr();
	const integration = findHerdrIntegration();
	if (run.terminal) {
		const pane = resolveRunPane(run, await listPanes("herdr"));
		if (pane) throw new Error("A terminal already exists for this run; inspect it before retrying");
		if (run.terminal.phase !== "closed" && !run.terminal.suspended) throw new Error("Previous launch is uncertain; run data was preserved");
	}
	if (!existsSync(run.sessionFile)) throw new Error("Subagent transcript is missing; run data was preserved");
	const args = initialArgs.map((argument, index) => {
		if (!/[\r\n]/.test(argument)) return argument;
		const path = join(run.runDir, `initial-${index}.txt`);
		writeFileSync(path, argument, { mode: 0o600 });
		return `@${path}`;
	});
	let terminal: TerminalRecord = { socketPath: process.env.HERDR_SOCKET_PATH!, phase: "creating", suspended: run.terminal?.suspended };
	if (!writeTerminal(run.runDir, terminal)) throw new Error("Run was removed before launch");
	updateRunState(run.runDir, { state: "starting", pid: undefined, childSessionId: undefined, outcome: undefined, error: undefined });
	try {
		const created = await herdr<{ root_pane: TerminalPane }>([
			"tab", "create", "--workspace", process.env.HERDR_WORKSPACE_ID!, "--cwd", run.cwd, "--label", runTabName(run), "--no-focus",
			"--env", `PI_SUBAGENT_RUN_DIR=${run.runDir}`, "--env", `PI_CODING_AGENT_DIR=${getAgentDir()}`, "--env", `PATH=${process.env.PATH ?? ""}`,
		]);
		terminal = { ...terminal, terminalId: created.root_pane.terminal_id, paneId: created.root_pane.pane_id };
		if (!writeTerminal(run.runDir, terminal)) throw new Error(`Run disappeared after creating ${created.root_pane.pane_id}; inspect Herdr`);
		const command = [
			"pi", "--session", run.sessionFile, "--provider", run.provider, "--model", run.model, "--thinking", run.thinking,
			...(run.launchArgs ?? []), "--extension", extensionPath, "--extension", integration, ...args,
		].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
		await herdr(["pane", "run", created.root_pane.pane_id, command]);
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			const current = readMetadata(run.runDir);
			if (!current) throw new Error("Run was removed during launch");
			const pane = resolveRunPane(current, await listPanes("herdr"));
			if (!pane) throw new Error("Child terminal closed during launch");
			if (current.pid && current.childSessionId && ownsAgent(current, pane)) {
				await herdr(["agent", "rename", pane.pane_id, `pi-subagent-${run.handle}`]);
				if (!writeTerminal(run.runDir, { ...terminal, phase: "ready", suspended: false })) throw new Error("Run was removed before startup confirmation");
				return;
			}
			await delay(100);
		}
		throw new Error("Pi did not publish the expected session within 30s; inspect its tab before retrying");
	} catch (error) {
		writeTerminal(run.runDir, { ...terminal, phase: "uncertain", error: String(error) });
		throw new Error(`Could not start ${runDisplayName(run)}: ${error}`);
	}
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	if (!existsSync(getRunsDir())) return [];
	return readdirSync(getRunsDir(), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => readMetadata(join(getRunsDir(), entry.name)))
		.filter((run): run is RunMetadata => !!run && (!parentSessionId || run.parentSessionId === parentSessionId))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return typeof entry.type === "string" && typeof entry.id === "string" && (entry.parentId === null || typeof entry.parentId === "string");
}
function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}
function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	return entry.type === "message" && typeof entry.message === "object" && entry.message !== null && (entry.message as Record<string, unknown>).role === "assistant";
}
export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try { content = readFileSync(sessionFile, "utf8"); } catch { return undefined; }
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch { /* The final JSONL record may still be incomplete. */ }
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}
export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	return message.content.filter((item): item is { type: "text"; text: string } =>
		typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string")
		.map((item) => item.text).join("\n").trim() || message.errorMessage || "(no response text)";
}
