// Deterministic offline provider: answers "echo: <last user text>" as a real Anthropic-style SSE stream. For tests and for proving the
// framework end to end without any credential. Registered as `stub`, disabled unless a config turns it on.
import type { ModelProvider, ProviderModel } from "./types";

export const sse = (events: unknown[]): Response =>
  new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const ev of events) c.enqueue(e.encode(`event: ${(ev as any).type}\ndata: ${JSON.stringify(ev)}\n\n`)); c.close(); } }),
    { status: 200, headers: { "content-type": "text/event-stream" } });

export function textEvents(model: string, text: string, usage: { input_tokens: number; output_tokens: number }): unknown[] {
  return [
    { type: "message_start", message: { id: "msg_stub", model, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ];
}

export function stubProvider(models: ProviderModel[], id = "stub"): ModelProvider {
  return {
    name: id, id,
    async listModels(kind) { return !kind || kind === "chat" ? models : []; },
    async messages(body: any) {
      const last = [...(body?.messages ?? [])].reverse().find((m: any) => m.role === "user");
      const t = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      return sse(textEvents(String(body?.model ?? "echo"), `echo: ${t}`, { input_tokens: Math.ceil(t.length / 4), output_tokens: Math.ceil(t.length / 4) + 2 }));
    },
  };
}
