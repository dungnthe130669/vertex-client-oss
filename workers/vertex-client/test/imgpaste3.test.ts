// imgpaste3: four review findings on the image pre-flight (cold meta, override model, stale pre-stop, image-mode references).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { MODELS_META, applyCatalogListing, beginCatalogListing, metaFromProviderModel } from "../src/models-meta";
import type { ModelProvider } from "../src/providers/types";
import { imageCapFor, imageTooLargeMessage, isGatewayGeminiId } from "../src/files";
import { refusalFor } from "../web/src/upload";

const sse = () => {
  const evs: ServerEvent[] = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const PNG = { ref: "vertex-client/conv-1/a.png", name: "a.png", mime: "image/png", size: 1 };
let scopeN = 0;
function rig(o: { loadVision?: string; candidates?: string[]; fileBytes?: number | ((ref: string) => number); sizeReject?: (ref: string) => boolean; declared?: (ref: string) => number } = {}) {
  const db = new Database(":memory:"); const bodies: any[] = []; const events: ServerEvent[] = [];
  const scope = `imgp3-${++scopeN}`; let loads = 0; const reads: string[] = [];
  const byteLen = (ref: string) => (typeof o.fileBytes === "function" ? o.fileBytes(ref) : o.fileBytes ?? 1);
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async (b: any) => { if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }); bodies.push(b); return sse(); } };
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1,
    files: { get: async (ref: string) => { reads.push(ref); return new Uint8Array(byteLen(ref)); }, size: async (ref: string) => { if (o.sizeReject?.(ref)) throw new Error("head failed"); return byteLen(ref); } }, metaScope: () => scope,
    ...(o.loadVision ? { loadMetas: async () => { loads++; const t = beginCatalogListing(scope); applyCatalogListing(scope, t, new Map([[o.loadVision!, metaFromProviderModel("V", { text: true, vision: true, tools: false, "image-gen": false, "video-gen": false, reasoning: false }, null)]])); } } : {}),
    ...(o.candidates ? { autoCandidates: async () => o.candidates!.map((id) => ({ id, meta: MODELS_META[id] ?? null })), autoDefaultPlausible: () => true } : {}),
  });
  engine.setConvId("conv-1");
  return { engine, bodies, events, reads, loads: () => loads };
}

describe("imgpaste3 #1 cold instance: catalog meta loads before the image guard", () => {
  test("first image send to a catalog-declared vision model succeeds with no earlier text turn", async () => {
    const r = rig({ loadVision: "zz-vision-cold" });
    expect((await r.engine.send("look", "zz-vision-cold", [PNG])).ok).toBe(true);
    expect(r.loads()).toBe(1);
    expect(r.bodies[0].messages[0].content[0]).toMatchObject({ type: "image" });
  });
  test("a catalog model that really lacks vision is still refused (after the load)", async () => {
    const r = rig({ loadVision: "zz-vision-other" });
    const x = await r.engine.send("look", "zz-text-only", [PNG]);
    expect(x.ok).toBe(false); expect(r.bodies.length).toBe(0);
  });
});

describe("imgpaste3 #3 override: the guard checks the model that receives the request", () => {
  test("conversation on Gemini + valid Sonnet override accepts the image; the conversation model is unchanged", async () => {
    const r = rig({ candidates: ["claude-sonnet-5-5", "gemini-3-pro"] });
    r.engine.setMeta("model", "gemini-3-pro");
    expect((await r.engine.send("look", undefined, [PNG], null, { model: "claude-sonnet-5-5" })).ok).toBe(true);
    await Bun.sleep(30);
    expect(r.bodies[0]).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(r.engine.meta("model")).toBe("gemini-3-pro");
  });
  test("Claude conversation + Gemini override refuses the image", async () => {
    const r = rig({ candidates: ["claude-sonnet-5-5", "gemini-3-pro"] });
    r.engine.setMeta("model", "claude-sonnet-5-5");
    const x = await r.engine.send("look", undefined, [PNG], null, { model: "gemini-3-pro" });
    expect(x.ok).toBe(false); expect(r.bodies.length).toBe(0);
  });
});

describe("imgpaste3 #4 a refused send does not leak Stop into the next turn", () => {
  test("Stop + refused image send, then a text send runs normally", async () => {
    const r = rig();
    r.engine.setMeta("model", "gemini-3-pro");
    r.engine.setMeta("pending", "1"); r.engine.stop(); // stop arrives while the send is queued
    expect((await r.engine.send("look", undefined, [PNG])).ok).toBe(false);
    r.engine.setMeta("pending", null);
    expect((await r.engine.send("hello", "claude-sonnet-5-5")).ok).toBe(true);
    await Bun.sleep(30);
    expect(r.bodies.length).toBe(1);
    expect(r.engine.messages().at(-1)!.status).not.toBe("interrupted");
  });
  test("same for a failed override check", async () => {
    const r = rig({ candidates: ["claude-sonnet-5-5"] });
    r.engine.setMeta("pending", "1"); r.engine.stop();
    expect((await r.engine.send("x", undefined, [], null, { model: "claude-zz-missing" })).ok).toBe(false);
    r.engine.setMeta("pending", null);
    expect((await r.engine.send("hello", "claude-sonnet-5-5")).ok).toBe(true);
    await Bun.sleep(30);
    expect(r.bodies.length).toBe(1);
  });
});

describe("imgpaste3 #2 image mode references are not gated by the chat model", () => {
  test("Gemini for chat + Image mode: PNG accepted; chat mode refuses; non-image files pass", () => {
    const png = { type: "image/png", name: "ref.png" };
    expect(refusalFor("image", false, png, "gemini-3-pro")).toBeNull();
    expect(refusalFor("chat", false, png, "gemini-3-pro")).toContain("Gemini");
    expect(refusalFor("chat", true, png, "claude-sonnet-5-5")).toBeNull();
  });
});

describe("gemvis1: live-proven Gemini ids send images (vision meta as the registry now marks it); an unproven one is still refused", () => {
  for (const id of ["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash"]) {
    test(`${id}: image reaches the provider`, async () => {
      const r = rig({ loadVision: id });
      expect((await r.engine.send("look", id, [PNG])).ok).toBe(true);
      await Bun.sleep(30);
      expect(r.bodies[0]).toMatchObject({ model: id });
      expect(JSON.stringify(r.bodies[0].messages)).toContain('"type":"image"');
    });
  }
  test("gemini-3-pro (not proven) is refused with the clean message and nothing is sent", async () => {
    const r = rig({ loadVision: "zz-other" });
    const x = await r.engine.send("look", "gemini-3-pro", [PNG]);
    expect(x).toEqual({ ok: false, error: "Gemini via the company gateway cannot read images yet; use a Claude model." }); expect(r.bodies.length).toBe(0);
  });
});

describe("gemvis2: Gemini image cap is 4 MB, Claude keeps 5 MB", () => {
  const BIG = { ...PNG, size: 4 * 1024 * 1024 + 1 }, OK = { ...PNG, size: 4 * 1024 * 1024 };
  test("caps", () => { expect(imageCapFor("gemini-2.5-pro")).toBe(4 * 1024 * 1024); expect(imageCapFor("claude-sonnet-5-5")).toBe(5 * 1024 * 1024); });
  test("server refuses a >4 MB image for gemini with a clear message, nothing sent; exactly 4 MB passes", async () => {
    const r = rig({ loadVision: "gemini-3.7-flash" });
    expect(await r.engine.send("look", "gemini-3.7-flash", [BIG])).toEqual({ ok: false, error: "image too large for this model (max 4 MB after resizing)" });
    expect(r.bodies.length).toBe(0);
    expect((await r.engine.send("look", "gemini-3.7-flash", [OK])).ok).toBe(true);
  });
  test("the same 4.5 MB image is fine for Claude", async () => {
    const r = rig();
    expect((await r.engine.send("look", "claude-sonnet-5-5", [{ ...PNG, size: 4.5 * 1024 * 1024 }])).ok).toBe(true);
  });
  test("upload checkUpload message is unchanged for the generic 5 MB limit; the client-side error uses the model cap", () => {
    expect(imageTooLargeMessage("gemini-3.5-flash")).toBe("image too large for this model (max 4 MB after resizing)");
    expect(imageTooLargeMessage("claude-opus-5")).toBe("image too large for this model (max 5 MB after resizing)");
  });
});

describe("gemvis3 review blockers", () => {
  test("cap predicate: prefixed/custom-provider ids keep 5 MB, bare verified gemini ids 4 MB, non-chat gemini ids 5 MB", () => {
    for (const id of ["gemini-proxy:gpt-4o", "aistudio:gemini-2.5-pro", "gemini-x:gemini-3.7-flash"]) expect(imageCapFor(id)).toBe(5 * 1024 * 1024);
    for (const id of ["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-3.7-flash"]) expect(imageCapFor(id)).toBe(4 * 1024 * 1024);
    for (const id of ["gemini-3.1-flash-image", "gemini-omni-1.1-flash-preview", "gemini-2.5-flash-preview-tts"]) { expect(isGatewayGeminiId(id)).toBe(false); expect(imageCapFor(id)).toBe(5 * 1024 * 1024); }
  });
  test("an earlier 4.5 MB image + switch to a Gemini id: visible error, no assistant row, no body sent; back to Claude works", async () => {
    const r = rig({ loadVision: "gemini-3.7-flash", fileBytes: 4.5 * 1024 * 1024 });
    expect((await r.engine.send("look", "claude-sonnet-5-5", [{ ...PNG, size: 4.5 * 1024 * 1024 }])).ok).toBe(true);
    await Bun.sleep(50);
    expect(r.bodies.length).toBe(1);
    const assistants = () => r.engine.messages().filter((m) => m.role === "assistant").length;
    const a0 = assistants();
    r.events.length = 0;
    expect((await r.engine.send("double-check it", "gemini-3.7-flash")).ok).toBe(true);
    await Bun.sleep(80);
    expect(r.bodies.length).toBe(1); // nothing reached the provider
    const err = r.events.find((e: any) => e.type === "error") as any;
    expect(err?.error?.message).toContain("earlier image");
    expect(err.error.message).toContain("4 MB");
    expect(assistants()).toBe(a0);
    expect(r.engine.meta("running")).not.toBe("1");
    expect((await r.engine.send("ok, Claude then", "claude-sonnet-5-5")).ok).toBe(true);
    await Bun.sleep(80);
    expect(r.bodies.length).toBe(2);
    expect(JSON.stringify(r.bodies[1].messages)).toContain('"type":"image"');
    expect(assistants()).toBe(a0 + 1);
  });
  test("gemvis4: an earlier over-cap image still fails closed when later images exhaust the attachment budget (reverse expansion)", async () => {
    const MB = 1024 * 1024;
    const r = rig({ loadVision: "gemini-3.7-flash", fileBytes: (ref) => (ref.endsWith("a.png") ? 4.5 : 4) * MB });
    expect((await r.engine.send("big", "claude-sonnet-5-5", [{ ...PNG, size: 4.5 * MB }])).ok).toBe(true);
    await Bun.sleep(50);
    r.engine.setMeta("model", "claude-sonnet-5-5");
    for (let i = 0; i < 5; i++) { expect((await r.engine.send("more " + i, "claude-sonnet-5-5", [{ ...PNG, ref: `vertex-client/conv-1/b${i}.png`, size: 4 * MB }])).ok).toBe(true); await Bun.sleep(50); }
    const n = r.bodies.length; r.events.length = 0;
    expect((await r.engine.send("check", "gemini-3.7-flash")).ok).toBe(true);
    await Bun.sleep(100);
    expect(r.bodies.length).toBe(n); // no Gemini request
    const err = r.events.find((e: any) => e.type === "error") as any;
    expect(err?.error?.message).toContain("earlier image");
  }, 30_000);
  test("gemvis4 negative: several images all under 4 MB still go to Gemini unchanged", async () => {
    const MB = 1024 * 1024;
    const r = rig({ loadVision: "gemini-3.7-flash", fileBytes: 3 * MB });
    for (let i = 0; i < 3; i++) { expect((await r.engine.send("p" + i, "gemini-3.7-flash", [{ ...PNG, ref: `vertex-client/conv-1/c${i}.png`, size: 3 * MB }])).ok).toBe(true); await Bun.sleep(50); }
    expect(r.bodies.length).toBe(3);
    expect(JSON.stringify(r.bodies[2].messages).match(/"type":"image"/g)?.length).toBe(3);
  }, 30_000);

  test("gemvis5: a 6 MiB earlier image (e.g. generated) followed by a Claude turn still works (cap is Gemini-only)", async () => {
    const MB = 1024 * 1024;
    const r = rig({ fileBytes: 6 * MB });
    expect((await r.engine.send("a", "claude-sonnet-5-5", [{ ...PNG, size: 4 * MB }])).ok).toBe(true);
    await Bun.sleep(50); r.events.length = 0;
    expect((await r.engine.send("b", "claude-sonnet-5-5")).ok).toBe(true);
    await Bun.sleep(80);
    expect(r.events.find((e: any) => e.type === "error")).toBeUndefined();
    expect(r.bodies.length).toBe(2);
    expect(JSON.stringify(r.bodies[1].messages)).toContain('"type":"image"');
  }, 30_000);
  const manyImages = async (r: ReturnType<typeof rig>, model: string, n: number, size: number) => {
    // seed history directly: n user messages each holding one image ref (no per-send cost)
    for (let i = 0; i < n; i++) (r.engine as any).sql.exec("INSERT INTO messages (role, content, created_at) VALUES ('user', ?, ?)", JSON.stringify([{ type: "file_ref", ref: `vertex-client/conv-1/h${i}.png`, name: `h${i}.png`, mime: "image/png", size }]), new Date().toISOString());
  };
  test("gemvis5: 128 historical 1 MiB images + exhausted budget -> reads stay bounded (<= 24) for Claude and for Gemini", async () => {
    const MB = 1024 * 1024;
    for (const model of ["claude-sonnet-5-5", "gemini-3.7-flash"]) {
      const r = rig({ loadVision: "gemini-3.7-flash", fileBytes: MB });
      await manyImages(r, model, 128, MB);
      r.reads.length = 0;
      await (r.engine as any).ensureMeta(model); r.reads.length = 0;
      await (r.engine as any).requestHistory(model);
      expect(r.reads.length, model).toBeGreaterThan(0); expect(r.reads.length, model).toBeLessThanOrEqual(24);
    }
  }, 30_000);
  test("gemvis5: Gemini with an over-cap image beyond the budget -> HistoryImageTooBig with zero body reads for it", async () => {
    const MB = 1024 * 1024;
    const r = rig({ loadVision: "gemini-3.7-flash", fileBytes: (ref) => (ref.endsWith("h0.png") ? 4.5 : 1) * MB });
    await manyImages(r, "gemini-3.7-flash", 128, MB); // h0 is the oldest: reverse expansion reaches it after the budget is gone
    await (r.engine as any).ensureMeta("gemini-3.7-flash"); r.reads.length = 0;
    await expect((r.engine as any).requestHistory("gemini-3.7-flash")).rejects.toThrow(/earlier image/);
    expect(r.reads.some((x) => x.endsWith("h0.png"))).toBe(false);
    expect(r.reads.length).toBeLessThanOrEqual(24);
  }, 30_000);

  test("gemvis6: a rejected size() on an over-cap older Gemini image is a visible error (not a silent budget omission), no model request", async () => {
    const MB = 1024 * 1024;
    const r = rig({ loadVision: "gemini-3.7-flash", fileBytes: (ref) => (ref.endsWith("h0.png") ? 4.5 : 1) * MB, sizeReject: (ref) => ref.endsWith("h0.png") });
    await manyImages(r, "gemini-3.7-flash", 30, MB);
    await (r.engine as any).ensureMeta("gemini-3.7-flash");
    await expect((r.engine as any).requestHistory("gemini-3.7-flash")).rejects.toThrow();
    // end to end: the turn ends in a visible error and nothing is sent
    r.events.length = 0; const n = r.bodies.length;
    expect((await r.engine.send("check", "gemini-3.7-flash")).ok).toBe(true);
    await Bun.sleep(150);
    expect(r.bodies.length).toBe(n);
    expect(r.events.some((e: any) => e.type === "error")).toBe(true);
  }, 30_000);
  test("gemvis6: a genuinely missing object (size null) is still just a note", async () => {
    const MB = 1024 * 1024;
    const r = rig({ loadVision: "gemini-3.7-flash", fileBytes: MB });
    (r.engine as any).files.size = async () => null; (r.engine as any).files.get = async () => null;
    await manyImages(r, "gemini-3.7-flash", 2, MB);
    await (r.engine as any).ensureMeta("gemini-3.7-flash");
    const h = await (r.engine as any).requestHistory("gemini-3.7-flash");
    expect(JSON.stringify(h)).toContain("file no longer available");
  });
  test("gemvis6: Claude parity - declared size 1 but 4 MiB actual with 3 MiB budget left is still included (as on master)", async () => {
    const MB = 1024 * 1024;
    const r = rig({ fileBytes: (ref) => (ref.endsWith("h0.png") ? 4 : 1) * MB });
    for (let i = 0; i < 22; i++) (r.engine as any).sql.exec("INSERT INTO messages (role, content, created_at) VALUES ('user', ?, ?)", JSON.stringify([{ type: "file_ref", ref: `vertex-client/conv-1/h${i}.png`, name: `h${i}.png`, mime: "image/png", size: i === 0 ? 1 : MB }]), new Date().toISOString());
    await (r.engine as any).ensureMeta("claude-sonnet-5-5");
    const h = await (r.engine as any).requestHistory("claude-sonnet-5-5");
    expect(JSON.stringify(h).match(/"type":"image"/g)?.length).toBe(22);
  }, 30_000);
});
