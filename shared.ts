import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "blocked" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	rexSession: string;
	rexBlock?: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	outcome?: "completed" | "aborted" | "error";
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
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

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		// Launch identity has one writer; child status updates cannot overwrite it.
		const terminalPath = join(runDir, "terminal.json");
		if (existsSync(terminalPath)) {
			const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
			metadata.rexSession = terminal.rexSession;
			metadata.rexBlock = terminal.rexBlock;
		}
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" || !/^[a-z0-9]+$/.test(metadata.handle) ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.rexSession !== "string" ||
			(metadata.rexBlock !== undefined && typeof metadata.rexBlock !== "string") ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

class RexError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null) {
		super(message);
		this.status = status;
	}
}

function rexCommand<T>(args: string[]): T {
	const result = spawnSync("rex", ["--autostart=false", "--timeout", "3s", ...args], {
		encoding: "utf8",
		timeout: 5000,
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new RexError(result.error?.message || result.stderr.trim() || "Rex command failed", result.status);
	}
	return (result.stdout.trim() ? JSON.parse(result.stdout) : undefined) as T;
}

function rexApi<T>(session: string, method: string, args: Record<string, unknown>): T {
	return rexCommand<T>(["api", "call", "-s", session, method, JSON.stringify(args)]);
}

function resolveRunBlock(metadata: RunMetadata): string | undefined {
	if (metadata.rexBlock) return metadata.rexBlock;
	const { blocks } = rexCommand<{ blocks: { block_id: string; label: string }[] }>([
		"block", "ls", "-s", metadata.rexSession, "--json",
	]);
	const matches = blocks.filter((block) => block.label === `subagent ${metadata.handle}`);
	if (matches.length > 1) throw new Error(`Multiple Rex blocks match ${metadata.handle}; run data was preserved`);
	return matches[0]?.block_id;
}

/** Undefined means the backend could not be reached, not that the child exited. */
export function runIsRunning(metadata: RunMetadata): boolean | undefined {
	try {
		const blockId = resolveRunBlock(metadata);
		if (!blockId) return false;
		const process = rexCommand<{ child?: unknown }>([
			"block", "call", "-s", metadata.rexSession, "-b", blockId, "process",
		]);
		return Boolean(process.child);
	} catch (error) {
		return error instanceof RexError && error.status === 3 ? false : undefined;
	}
}

export function stopRun(metadata: RunMetadata): boolean {
	let blockId: string | undefined;
	try {
		blockId = resolveRunBlock(metadata);
	} catch (error) {
		throw new Error(`Cannot identify Rex block for ${metadata.handle}; run data was preserved: ${error}`);
	}
	if (!blockId) return false;
	const running = runIsRunning({ ...metadata, rexBlock: blockId });
	if (running === undefined) throw new Error(`Cannot reach Rex for ${metadata.handle}; run data was preserved`);
	try {
		rexCommand(["block", "close", "-s", metadata.rexSession, blockId]);
	} catch (error) {
		if (!(error instanceof RexError && error.status === 3)) throw error;
	}
	return running;
}

export function focusRun(metadata: RunMetadata, session: string): void {
	if (!metadata.rexBlock) throw new Error("Rex block ID is unavailable for this subagent");
	if (metadata.rexSession !== session) throw new Error("This subagent belongs to another Rex session");
	rexCommand(["focus", "-s", session, metadata.rexBlock]);
}

export function runProgramState(metadata: RunMetadata): "idle" | "working" | "blocked" | "done" | "error" | "clear" {
	if (metadata.state === "exited") return "clear";
	if (metadata.state === "busy" || metadata.state === "starting") return "working";
	if (metadata.state !== "idle") return metadata.state;
	if (metadata.outcome === "error") return "error";
	if (metadata.outcome === "aborted" || !metadata.hasStarted) return "idle";
	return "done";
}

export function reportProgramStatus(state: "idle" | "working" | "blocked" | "done" | "error" | "clear", title: string, id?: string, kind?: "question" | "permission"): void {
	if (!process.env.REX_SESSION || !process.stdout.isTTY) return;
	const label = Buffer.from(title.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 48)).toString("base64");
	process.stdout.write(`\x1b]7501;state=${state}:app=pi-subagent:title=${label}${id ? `:id=${id}` : ""}${kind ? `:kind=${kind}` : ""}\x1b\\`);
}

/** Start the child Pi process. Initial arguments are only passed on first spawn. */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): void {
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	const command = [
		"env",
		`PI_SUBAGENT_RUN_DIR=${metadata.runDir}`,
		...(process.env.PI_CODING_AGENT_DIR ? [`PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR}`] : []),
		launcher,
		"--session", metadata.sessionFile,
		"--provider", metadata.provider,
		"--model", metadata.model,
		"--thinking", metadata.thinking,
		...(metadata.launchArgs ?? []),
		...initialArgs,
	];
	const session = process.env.REX_SESSION || metadata.rexSession;
	const created = rexApi<{ block_ids: string[] }>(session, "session.new_window", {
		window_label: `subagent ${metadata.name ?? metadata.handle}`,
		focus: false,
		layout: {
			block: {
				flavor: "com.superlogical.terminal.shell",
				label: `subagent ${metadata.handle}`,
				options: {
					shell: "none",
					login: false,
					command,
					cwd: metadata.cwd,
					path_prepend: (process.env.PATH ?? "").split(":"),
					size: { columns: 120, rows: 40 },
					exit: { on_completion: false },
				},
			},
		},
	});
	const blockId = created.block_ids?.[0];
	if (!blockId) throw new Error("Rex did not return a block ID");
	if (!existsSync(metadataPath(metadata.runDir))) {
		rexCommand(["block", "close", "-s", session, blockId]);
		throw new Error("Subagent metadata disappeared during launch");
	}
	const target = join(metadata.runDir, "terminal.json");
	const temporary = `${target}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ rexSession: session, rexBlock: blockId })}\n`, { mode: 0o600 });
	renameSync(temporary, target);
}

export function effectiveRunState(metadata: RunMetadata): RunState | "unavailable" {
	if (metadata.state === "starting" || metadata.state === "busy" || metadata.state === "blocked" || metadata.state === "idle") {
		const running = runIsRunning(metadata);
		if (running === undefined) return "unavailable";
		if (!running) return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
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
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
