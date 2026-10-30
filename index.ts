import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	detectBackend, effectiveRunState, focusRun, inboxDir, listPanes, listRuns, readLatestAssistant, readMetadata,
	resumeRun, runDisplayName, stopRun, updateRunState, type InboxMessage,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env.PI_SUBAGENT_RUN_DIR;
	let promptActive = false;
	if (!runDir) pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));

	// Pi emits one outermost prompt pair; Herdr's existing integration owns the state counter.
	pi.on("ui_prompt_start", (event) => {
		promptActive = true;
		if (process.env.HERDR_ENV === "1") pi.events.emit("herdr:blocked", { active: true, label: event.title });
		if (runDir) updateRunState(runDir, { state: "blocked" });
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		promptActive = false;
		if (process.env.HERDR_ENV === "1") pi.events.emit("herdr:blocked", { active: false });
		if (runDir) updateRunState(runDir, { state: ctx.isIdle() ? "idle" : "busy" });
	});

	pi.registerCommand("subagent", {
		description: "Switch to a subagent's tab",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/subagent requires interactive mode", "error");
				return;
			}
			const panes = await listPanes().catch(() => undefined);
			const runs = listRuns(ctx.sessionManager.getSessionId()).filter((run) => effectiveRunState(run, panes) !== "exited");
			if (runs.length === 0) {
				ctx.ui.notify("No active subagents spawned by this session", "info");
				return;
			}
			const items: SelectItem[] = runs.map((run) => ({
				value: run.handle,
				label: `${runDisplayName(run)}  ${effectiveRunState(run, panes)}  ${run.provider}/${run.model}  ${run.thinking}`,
			}));
			const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
				const list = new SelectList(items, Math.min(items.length, 10), {
					selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
				});
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Switch to subagent")), 1, 0));
				container.addChild(list);
				container.addChild(new Text(theme.fg("dim", `${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`), 1, 0));
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				return {
					render: (width) => container.render(width), invalidate: () => container.invalidate(),
					handleInput: (data) => { list.handleInput(data); customTui.requestRender(); },
				};
			});
			const run = runs.find((candidate) => candidate.handle === selected);
			if (!run) return;
			try { await focusRun(run); }
			catch (error) { ctx.ui.notify(String(error), "error"); }
		},
	});

	if (!runDir) {
		let widgetTimer: ReturnType<typeof setInterval> | undefined;
		let widgetContext: ExtensionContext | undefined;
		let refreshing = false;
		const refreshWidget = async (): Promise<void> => {
			if (!widgetContext || refreshing) return;
			const ctx = widgetContext;
			refreshing = true;
			try {
				const runs = listRuns(ctx.sessionManager.getSessionId());
				const panes = runs.length ? await listPanes().catch(() => undefined) : [];
				if (widgetContext !== ctx) return;
				const active = runs.map((run) => ({ run, state: effectiveRunState(run, panes) })).filter(({ state }) => state !== "exited");
				if (!active.length) { ctx.ui.setWidget("subagents", undefined); return; }
				const visible = active.slice(0, 5).map(({ run, state }) => {
					const color = state === "busy" || state === "blocked" ? "warning" : state === "idle" ? "success" : state === "error" ? "error" : "muted";
					return ctx.ui.theme.fg(color, `${run.name ?? run.handle}:${state}`);
				});
				if (active.length > visible.length) visible.push(ctx.ui.theme.fg("muted", `+${active.length - visible.length}`));
				ctx.ui.setWidget("subagents", [ctx.ui.theme.fg("dim", "subagents: ") + visible.join(ctx.ui.theme.fg("dim", " | "))], { placement: "belowEditor" });
			} finally { refreshing = false; }
		};

		pi.on("session_start", async (_event, ctx) => {
			if (!detectBackend()) return;
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				if (!run.terminal?.suspended) continue;
				try {
					await resumeRun(run);
				} catch (error) {
					if (ctx.hasUI) ctx.ui.notify(`Could not resume ${runDisplayName(run)}: ${error}`, "error");
				}
			}
			if (ctx.mode !== "tui") return;
			widgetContext = ctx;
			void refreshWidget();
			widgetTimer = setInterval(() => void refreshWidget(), 1000);
			widgetTimer.unref();
		});
		pi.on("session_shutdown", async (event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			ctx.ui.setWidget("subagents", undefined);
			if (event.reason === "reload" || !detectBackend()) return;
			for (const run of listRuns(ctx.sessionManager.getSessionId())) {
				try { await stopRun(run, true); }
				catch (error) { if (ctx.hasUI) ctx.ui.notify(`Could not suspend ${runDisplayName(run)}: ${error}`, "error"); }
			}
		});
		return;
	}

	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let sessionName: string | undefined;
	const syncSessionName = (): void => {
		const run = readMetadata(runDir);
		if (!run) return;
		const next = `subagent ${run.name ?? run.handle}`;
		if (next !== sessionName) { pi.setSessionName(next); sessionName = next; }
	};
	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		syncSessionName();
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir).filter((entry) => entry.endsWith(".json")).sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch (error) {
					unlinkSync(path);
					updateRunState(runDir, { state: "error", error: String(error) });
					continue;
				}
				try {
					updateRunState(runDir, { state: promptActive ? "blocked" : "busy", error: undefined });
					if (currentContext.isIdle()) pi.sendUserMessage(payload.message);
					else pi.sendUserMessage(payload.message, { deliverAs: payload.delivery === "followUp" ? "followUp" : "steer" });
					unlinkSync(path);
				} catch (error) {
					updateRunState(runDir, { state: promptActive ? "blocked" : currentContext.isIdle() ? "idle" : "busy", error: String(error) });
					return;
				}
			}
		} finally { processing = false; }
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		const run = readMetadata(runDir);
		if (!run) return;
		updateRunState(runDir, { childSessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? run.sessionFile, pid: process.pid, state: ctx.isIdle() ? "idle" : "busy", error: undefined });
		syncSessionName();
		timer = setInterval(() => void processInbox(), 250);
		timer.unref();
		void processInbox();
	});
	pi.on("agent_start", (_event, ctx) => {
		currentContext = ctx;
		updateRunState(runDir, { state: "busy", hasStarted: true, outcome: undefined, error: undefined });
	});
	pi.on("agent_settled", (event, ctx) => {
		currentContext = ctx;
		if (!ctx.isIdle()) return;
		const latest = readLatestAssistant(readMetadata(runDir)?.sessionFile ?? "");
		const outcome = event.aborted ? "aborted" : latest?.stopReason === "error" ? "error" : "completed";
		updateRunState(runDir, { state: "idle", outcome, error: outcome === "error" ? latest?.errorMessage : undefined });
	});
	pi.on("session_shutdown", (event, ctx) => {
		currentContext = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (event.reason === "quit") updateRunState(runDir, { state: "exited", pid: undefined, sessionFile: ctx.sessionManager.getSessionFile() });
	});
}
