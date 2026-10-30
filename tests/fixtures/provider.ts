// Local deterministic model for real Pi/Herdr tests; no provider network requests.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
 const log = (event: string, data: object = {}) => appendFileSync(join(process.env.PI_CODING_AGENT_DIR!, "events.jsonl"), JSON.stringify({ at: Date.now(), pid: process.pid, event, ...data }) + "\n");
 pi.events.on("herdr:blocked", (data) => { log("forwarded_blocked", { active: data.active }); });
 const logEvent = (event: { type: string }, ctx: ExtensionContext) => { log(event.type, { ...event, idle: ctx.isIdle(), sessionId: ctx.sessionManager.getSessionId() }); };
 pi.on("session_start", logEvent);
 pi.on("session_shutdown", logEvent);
 pi.on("agent_start", logEvent);
 pi.on("agent_settled", logEvent);
 pi.on("ui_prompt_start", logEvent);
 pi.on("ui_prompt_end", logEvent);
 pi.registerCommand("fixture-list-sessions", {
  description: "Test-only native session discovery",
  async handler(_args, ctx) { log("session_listing", { paths: (await SessionManager.list(ctx.cwd)).map((session) => session.path) }); },
 });
 pi.registerCommand("fixture-dialog", {
  description: "Test-only expiring dialog",
  async handler(kind, ctx) {
   const options = { timeout: 2000 };
   if (kind === "confirm") await ctx.ui.confirm("Fixture confirm", "Synthetic test", options);
   if (kind === "select") await ctx.ui.select("Fixture select", ["one", "two"], options);
   if (kind === "input") await ctx.ui.input("Fixture input", "test", options);
   if (kind === "editor") await ctx.ui.editor("Fixture editor", "test");
   if (["custom", "nested", "throw"].includes(kind)) await ctx.ui.custom((_tui, _theme, _keys, done) => {
    if (kind === "throw") throw new Error("fixture custom failure");
    if (kind === "nested") setTimeout(async () => {
     await ctx.ui.input("Fixture nested input", "test", { timeout: 500 });
     log("nested_finished");
    }, 200);
    const timer = setTimeout(() => done(undefined), 2500);
    return { render: () => ["Fixture custom"], invalidate() {}, handleInput() {}, dispose() { clearTimeout(timer); } };
   });
  },
 });
 pi.registerTool({
  name: "fixture_hold", label: "Hold", description: "Wait during a fixture task", parameters: Type.Object({ ms: Type.Number() }),
  async execute(_id, args, signal) {
   log("hold_started");
   await new Promise<void>((done, reject) => {
    const timer = setTimeout(done, Number(args.ms));
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("fixture cancelled")); }, { once: true });
   });
   return { content: [{ type: "text", text: "hold complete" }], details: undefined };
  },
 });
 pi.registerProvider("subagent-test", {
  api: "subagent-test", baseUrl: "https://fixture.invalid", apiKey: "fixture",
  models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
  streamSimple(model, context) {
   const stream = createAssistantMessageEventStream();
   queueMicrotask(() => {
    const last = context.messages.at(-1);
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
    log("model_call", { role: last?.role, text });
    const hold = last?.role === "user" && text.includes("hold task");
    const message = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [] as (TextContent | ToolCall)[], stopReason: hold ? "toolUse" as const : "stop" as const, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    if (last?.role === "user" && text.includes("fixture failure")) {
     stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: "fixture failure" } }); stream.end(); return;
    }
    stream.push({ type: "start", partial: message });
    if (hold) {
     const toolCall: ToolCall = { type: "toolCall", id: `hold-${Date.now()}`, name: "fixture_hold", arguments: { ms: text.includes("long") ? 30000 : 3500 } };
     message.content.push(toolCall);
     stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
     stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
    } else {
     const answer = "fixture answer " + (last?.role === "user" ? text : "after tool");
     message.content.push({ type: "text", text: answer });
     stream.push({ type: "text_start", contentIndex: 0, partial: message });
     stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial: message });
     stream.push({ type: "text_end", contentIndex: 0, content: answer, partial: message });
    }
    stream.push({ type: "done", reason: message.stopReason, message }); stream.end();
   });
   return stream;
  },
 });
}
