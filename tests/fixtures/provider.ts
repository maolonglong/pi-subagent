// Deterministic test provider: exercises real Pi lifecycle events without network requests.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("subagent-test", {
		api: "subagent-test",
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
		streamSimple(model, context) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = {
					role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
					timestamp: Date.now(), content: [] as { type: "text"; text: string }[], stopReason: "stop" as const,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				};
				if (JSON.stringify(context.messages.at(-1)).includes("fixture failure")) {
					stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: "fixture failure" } });
					stream.end();
					return;
				}
				stream.push({ type: "start", partial: message });
				message.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				message.content[0].text = "fixture answer";
				stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture answer", partial: message });
				stream.push({ type: "text_end", contentIndex: 0, content: "fixture answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			});
			return stream;
		},
	});
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType === "user" && event.prompt.includes("ask permission")) {
			await ctx.ui.confirm("Fixture permission", "Continue the test?");
		}
	});
}
