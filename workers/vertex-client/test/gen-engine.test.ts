import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, toApiContent, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { ProviderError, type ImageRequest, type ImageResult, type ModelProvider } from "../src/providers/types";
import { stubImage, STUB_PNG_B64 } from "../src/providers/stub-image";
import type { FileStore } from "../src/files";

const CONV = "conv-1";
const okImg = (o: Partial<ImageResult> = {}): ImageResult => ({ model: "gemini-3.1-flash-image", images: [{ mime_type: "image/png", data: STUB_PNG_B64 }], text: null, finish_reason: "STOP", usage: { input_tokens: 7, output_tokens: 1120 }, cost: { usd: 0.0423 }, ...o });

function rig(image: (req: ImageRequest, signal: AbortSignal | undefined, n: number) => Promise<ImageResult> | ImageResult, opts: { files?: boolean; confirmUsd?: number } = {}) {
  const db = new Database(":memory:");
  const calls: ImageRequest[] = [];
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async () => Response.json({ content: [{ type: "text", text: "T" }], usage: {} }), image: async (req, signal) => { calls.push(req); return image(req, signal, calls.length); } };
  const store = new Map<string, { bytes: Uint8Array; mime: string; conv: string }>();
  const files: FileStore = { size: async () => null,
    get: async (k) => store.get(k)?.bytes ?? null,
    put: async (k, bytes, mime, conv) => { store.set(k, { bytes, mime, conv }); },
    delete: async (ks) => { for (const k of ks) store.delete(k); },
  };
  const events: ServerEvent[] = [];
  const idx = { msgs: [] as any[], convs: [] as any[], usage: [] as any[] };
  const index: IndexSink = { indexMessage: async (m) => { idx.msgs.push(m); }, updateConversation: async (c) => { idx.convs.push(c); }, recordUsage: async (u) => { idx.usage.push(u); } };
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, files: opts.files === false ? null : files, genConfirmUsd: opts.confirmUsd === undefined ? undefined : () => opts.confirmUsd!,
    sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1,
  });
  engine.setConvId(CONV);
  return { engine, calls, store, events, idx, db };
}
const cmd = (o: Record<string, unknown> = {}) => ({ kind: "image", prompt: "a red cube", model: "gemini-3.1-flash-image", ...o });
const tick = () => new Promise((r) => setTimeout(r, 5));
const types = (r: ReturnType<typeof rig>) => r.events.map((e) => e.type);

describe("generate: happy path", () => {
  test("writes the image to R2 under gen/, saves a gen_image block (refs only), records one usage row", async () => {
    const r = rig(() => okImg());
    expect(await r.engine.generate(cmd())).toEqual({ ok: true });
    await tick();
    expect(r.store.size).toBe(1);
    const [key, obj] = [...r.store][0];
    expect(key).toMatch(new RegExp(`^vertex-client/${CONV}/gen/[0-9a-f-]{36}\\.png$`));
    expect(obj.mime).toBe("image/png"); expect(obj.conv).toBe(CONV);
    expect([...obj.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const ms = r.engine.messages();
    expect(ms.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(ms[0].content).toEqual([{ type: "text", text: "a red cube" }]);
    expect(ms[1].content).toHaveLength(1);
    expect(ms[1].content[0]).toMatchObject({ type: "gen_image", ref: key, mime: "image/png", prompt: "a red cube", model: "gemini-3.1-flash-image", cost_usd: 0.0423, est_usd: 0.045 });
    expect(JSON.stringify(ms)).not.toContain(STUB_PNG_B64); // no base64 in the DO
    expect(ms[1]).toMatchObject({ costUsd: 0.0423, usage: null, status: "complete", stopReason: "gen_image" });
    expect(r.idx.usage).toEqual([{ conversationId: CONV, model: "gemini-3.1-flash-image", usage: { input_tokens: 7, output_tokens: 1120 }, costUsd: 0.0423, kind: "image", estUsd: 0.045, units: 1, dispatchId: expect.any(String) }]);
    expect(types(r)).toEqual(["user_message", "turn_start", "assistant_saved", "turn_end", "title"]);
    expect(r.events[1]).toMatchObject({ type: "turn_start", kind: "image" });
    expect(r.events[3]).toMatchObject({ status: "done", costUsd: 0.0423 });
    expect(r.engine.running).toBe(false);
    expect(r.engine.state()).toMatchObject({ costUsd: 0.0423, title: "a red cube", generating: false });
    expect(r.idx.convs.at(-1)).toMatchObject({ id: CONV, costUsd: 0.0423 });
  });
  test("does not touch the chat model, sends no `n`, and reference images go in images[] (base64) read from R2", async () => {
    const r = rig(() => okImg());
    r.engine.setMeta("model", "claude-haiku-5-5");
    const refKey = `vertex-client/${CONV}/ref-1.png`;
    r.store.set(refKey, { bytes: new Uint8Array([1, 2, 3]), mime: "image/png", conv: CONV });
    await r.engine.generate(cmd({ aspect_ratio: "16:9", files: [{ ref: refKey, name: "ref.png", mime: "image/png", size: 3 }] }));
    expect(r.engine.meta("model")).toBe("claude-haiku-5-5");
    expect(r.calls).toEqual([{ model: "gemini-3.1-flash-image", prompt: "a red cube", aspect_ratio: "16:9", images: [{ mime_type: "image/png", data: "AQID" }] }]);
    expect(r.engine.messages()[0].content[0]).toMatchObject({ type: "file_ref", ref: refKey }); // the reference shows as an attachment chip
    expect(r.idx.convs.at(-1)!.model).toBe("claude-haiku-5-5");
  });
  test("n images = n parallel single-image calls; cost and units add up", async () => {
    const r = rig(() => okImg());
    await r.engine.generate(cmd({ n: 3 }));
    expect(r.calls).toHaveLength(3); expect(r.calls.every((c) => !("n" in c))).toBe(true);
    expect(r.store.size).toBe(3);
    const a = r.engine.messages()[1];
    expect(a.content.filter((b) => b.type === "gen_image")).toHaveLength(3);
    expect(a.costUsd).toBeCloseTo(0.0423 * 3, 6);
    expect(r.idx.usage[0]).toMatchObject({ units: 3, estUsd: 0.135, usage: { input_tokens: 21, output_tokens: 3360 } });
  });
  test("a call that returns 2 images (model quirk) keeps both, splitting that call's cost", async () => {
    const two = okImg({ images: [{ mime_type: "image/png", data: STUB_PNG_B64 }, { mime_type: "image/jpeg", data: STUB_PNG_B64 }] });
    const r = rig(() => two);
    await r.engine.generate(cmd());
    const imgs = r.engine.messages()[1].content.filter((b) => b.type === "gen_image");
    expect(imgs.map((b) => b.mime)).toEqual(["image/png", "image/jpeg"]);
    expect(imgs[0].cost_usd).toBeCloseTo(0.02115, 6);
    expect([...r.store.keys()].map((k) => k.split(".").pop())).toEqual(["png", "jpg"]);
  });
  test("model text next to an image is kept as a text block", async () => {
    const r = rig(() => okImg({ text: "Here you go." }));
    await r.engine.generate(cmd());
    expect(r.engine.messages()[1].content.map((b) => b.type)).toEqual(["gen_image", "text"]);
  });
  test("a later Claude turn only sees a one-line note for the image, never the block", () => {
    const out = toApiContent([{ type: "gen_image", ref: "vertex-client/c/gen/x.png", mime: "image/png", prompt: "a red cube", model: "m" }]);
    expect(out).toEqual([{ type: "text", text: "[An image was generated from this prompt: a red cube]" }]);
  });
});

describe("generate: filtered / empty / text-only results are messages, not errors", () => {
  test("200 with no images and finish_reason SAFETY", async () => {
    const r = rig(() => okImg({ images: [], finish_reason: "SAFETY", cost: { usd: 0.002 } }));
    await r.engine.generate(cmd());
    const a = r.engine.messages()[1];
    expect(a.content).toHaveLength(1);
    expect(a.content[0].type).toBe("text"); expect(a.content[0].text).toContain("SAFETY");
    expect(a.stopReason).toBe("gen_filtered"); expect(a.costUsd).toBe(0.002);
    expect(r.store.size).toBe(0);
    expect(r.events.at(-2)).toMatchObject({ type: "turn_end", status: "done", error: null });
    expect(r.idx.usage[0]).toMatchObject({ kind: "image", units: 0, costUsd: 0.002 });
  });
  test("422 generation_blocked from the gateway is the same: a normal assistant text message", async () => {
    const r = rig(() => { throw new ProviderError("The model declined to generate this image (IMAGE_RECITATION). Try rephrasing or being more specific.", 422, { type: "generation_blocked", costUsd: 0.001 }); });
    await r.engine.generate(cmd());
    const a = r.engine.messages()[1];
    expect(a.content[0].text).toContain("declined");
    expect(r.events.at(-2)).toMatchObject({ type: "turn_end", status: "done", error: null });
    expect(a.costUsd).toBe(0.001);
  });
  test("empty_result is soft too, but unknown cost is not invented (billing stays null)", async () => {
    const r = rig(() => { throw new ProviderError("The model returned no image.", 502, { type: "empty_result" }); });
    await r.engine.generate(cmd());
    expect(r.engine.messages()[1].costUsd).toBeNull();
    expect(r.idx.usage[0]).toMatchObject({ costUsd: null, estUsd: 0.045 });
  });
  test("gateway error {usage 0/0, cost null} stays UNKNOWN (est kept, may-have-charged text); explicit cost.usd 0 is known zero", async () => {
    const { mediaError } = await import("../src/providers/gateway");
    const run = async (error: any) => { const r = rig(() => { throw mediaError(422, { type: "error", error }, null, "image"); }); await r.engine.generate(cmd()); return r; };
    const a = await run({ type: "generation_blocked", usage: { input_tokens: 0, output_tokens: 0 }, cost: null });
    expect(a.engine.messages()[1].costUsd).toBeNull(); expect(a.engine.messages()[1].content[0].text).toMatch(/may still have charged/);
    expect(a.idx.usage[0]).toMatchObject({ costUsd: null, estUsd: 0.045 });
    const b = await run({ type: "generation_blocked", usage: { input_tokens: 0, output_tokens: 0 }, cost: { usd: 0 } });
    expect(b.engine.messages()[1].costUsd).toBe(0); expect(b.engine.messages()[1].content[0].text).not.toMatch(/may still have charged/);
    expect(b.idx.usage[0]).toMatchObject({ costUsd: 0 });
  });
  test("text-only response (finish STOP, no image)", async () => {
    const r = rig(() => okImg({ images: [], text: "I can only describe it: a cube." }));
    await r.engine.generate(cmd());
    const c = r.engine.messages()[1].content;
    expect(c.map((b) => b.type)).toEqual(["text", "text"]);
    expect(c[0].text).toContain("cube");
    expect(c[1].text).toContain("No image was generated");
  });
});

describe("generate: failures keep the estimate and say billing is uncertain", () => {
  test("every call fails => error card (not retryable: Retry would re-run CLAUDE on the prompt), no assistant message, usage row with est", async () => {
    const r = rig(() => { throw new ProviderError("Image generation timed out. It may still have been billed.", 504, { type: "upstream_timeout" }); });
    await r.engine.generate(cmd({ n: 2 }));
    const end = r.events.find((e) => e.type === "turn_end")!;
    expect(end.status).toBe("error");
    expect(end.error).toMatchObject({ type: "upstream_timeout", retryable: false });
    expect(end.error.message).toContain("Billing uncertain (estimated $0.090)");
    expect(r.engine.messages().map((m) => m.role)).toEqual(["user"]);
    expect(r.idx.usage).toEqual([{ conversationId: CONV, model: "gemini-3.1-flash-image", usage: { input_tokens: 0, output_tokens: 0 }, costUsd: null, kind: "image", estUsd: 0.09, units: 0, dispatchId: expect.any(String) }]);
    expect(r.engine.running).toBe(false);
  });
  test("partial: 2 of 3 succeed => images saved + a note, cost = the known part", async () => {
    const r = rig((_q, _s, n) => { if (n === 2) throw new ProviderError("The image service failed (502).", 502); return okImg(); });
    await r.engine.generate(cmd({ n: 3 }));
    const a = r.engine.messages()[1];
    expect(a.content.filter((b) => b.type === "gen_image")).toHaveLength(2);
    expect(a.content.at(-1)!.text).toMatch(/1 of 3 requests failed.*Billing uncertain/);
    expect(a.costUsd).toBeCloseTo(0.0846, 6);
  });
  test("a 200 without a cost figure: image kept, cost null, estimate shown as the fallback", async () => {
    const r = rig(() => okImg({ cost: undefined }));
    await r.engine.generate(cmd());
    expect(r.engine.messages()[1].content[0]).toMatchObject({ type: "gen_image", cost_usd: null, est_usd: 0.045 });
    expect(r.idx.usage[0].costUsd).toBeNull();
  });
  test("R2 write failure after a successful call: earlier objects removed, error reported, nothing dangling", async () => {
    const r = rig(() => okImg());
    let n = 0; const put = r.store.set.bind(r.store);
    (r.engine as any).gen.d.files.put = async (k: string, b: Uint8Array, m: string, c: string) => { if (++n === 2) throw new Error("r2 down"); put(k, { bytes: b, mime: m, conv: c }); };
    await r.engine.generate(cmd({ n: 2 }));
    expect(r.store.size).toBe(0);
    expect(r.events.find((e) => e.type === "turn_end")!.status).toBe("error");
    expect(r.engine.messages().map((m) => m.role)).toEqual(["user"]);
  });
  test("missing reference image => error before any provider call (no spend)", async () => {
    const r = rig(() => okImg());
    await r.engine.generate(cmd({ files: [{ ref: `vertex-client/${CONV}/gone.png`, name: "x.png", mime: "image/png", size: 1 }] }));
    expect(r.calls).toHaveLength(0); expect(r.idx.usage).toHaveLength(0);
    expect(r.events.find((e) => e.type === "turn_end")!.status).toBe("error");
  });
});

describe("generate: abort", () => {
  test("stop() while the provider call is in flight => interrupted, no images, usage row keeps the estimate", async () => {
    const r = rig((_q, signal) => new Promise((_res, rej) => signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const p = r.engine.generate(cmd());
    await tick();
    expect(r.engine.running).toBe(true);
    expect(r.engine.state().generating).toBe(true);
    r.engine.stop();
    expect(await p).toEqual({ ok: true });
    expect(r.events.find((e) => e.type === "turn_end")!.status).toBe("interrupted");
    expect(r.engine.messages().map((m) => m.role)).toEqual(["user"]);
    expect(r.store.size).toBe(0);
    expect(r.idx.usage[0]).toMatchObject({ costUsd: null, estUsd: 0.045, units: 0 });
    expect(r.engine.running).toBe(false);
  });
  test("an image that already arrived when stop() lands is kept, flagged Stopped, status interrupted", async () => {
    let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
    const r = rig(async (_q, _s, n) => { if (n === 2) { await gate; throw new DOMException("aborted", "AbortError"); } return okImg(); });
    const p = r.engine.generate(cmd({ n: 2 }));
    await tick(); r.engine.stop(); release(); await p;
    const a = r.engine.messages()[1];
    expect(a.status).toBe("interrupted");
    expect(a.content.some((b) => b.type === "gen_image")).toBe(true);
    expect(a.content.at(-1)!.text).toContain("Stopped");
  });
});

describe("generate: server-side validation and the confirm gate", () => {
  const pro = (o: Record<string, unknown> = {}) => cmd({ model: "e2e-stub-pro-image", ...o });
  test("estimate > $1 without confirmed:true is REJECTED with a typed error: no message, no provider call, no usage row", async () => {
    const r = rig((q) => stubImage(q));
    const plan = await r.engine.genPlan(pro({ n: 3 }));
    expect(plan).toMatchObject({ ok: false, reject: { code: "confirm_required", est_usd: 1.2 } });
    const run = await r.engine.generate(pro({ n: 3 }));
    expect(run.ok).toBe(false); expect((run as any).error).toContain("confirmation required");
    expect(r.calls).toHaveLength(0); expect(r.idx.usage).toHaveLength(0); expect(r.engine.messages()).toHaveLength(0); expect(r.events).toHaveLength(0);
    expect(r.engine.running).toBe(false);
  });
  test("confirmed but est_usd below the server estimate is also rejected (a client cannot understate it)", async () => {
    const r = rig((q) => stubImage(q));
    const x = await r.engine.generate(pro({ n: 3, confirmed: true, est_usd: 0.1 }));
    expect(x.ok).toBe(false); expect((x as any).error).toContain("does not cover");
    expect(r.calls).toHaveLength(0);
  });
  test("confirmed with est_usd >= estimate runs", async () => {
    const r = rig((q) => stubImage(q));
    expect(await r.engine.generate(pro({ n: 3, confirmed: true, est_usd: 1.2 }))).toEqual({ ok: true });
    expect(r.calls).toHaveLength(3); expect(r.store.size).toBe(3);
    expect(r.engine.messages()[1].costUsd).toBeCloseTo(1.2, 6);
  });
  test("under the line needs no confirmation (1 stub pro image = $0.40)", async () => {
    const r = rig((q) => stubImage(q));
    expect(await r.engine.generate(pro({ n: 1 }))).toEqual({ ok: true });
  });
  test("unknown model forces confirm", async () => {
    const r = rig(() => okImg());
    const plan = await r.engine.genPlan(cmd({ model: "gemini-9-mystery" }));
    expect(plan).toMatchObject({ ok: false, reject: { code: "confirm_required" } });
    expect(((await r.engine.genPlan(cmd({ model: "gemini-9-mystery", confirmed: true, est_usd: 0 }))) as any).ok).toBe(true);
  });
  test("the threshold comes from settings: raised to $5 the same 3-pro request passes unconfirmed", async () => {
    const r = rig((q) => stubImage(q), { confirmUsd: 5 });
    expect(((await r.engine.genPlan(pro({ n: 3 }))) as any).ok).toBe(true);
    const low = rig((q) => stubImage(q), { confirmUsd: 0.1 });
    expect(((await low.engine.genPlan(pro({ n: 1 }))) as any).ok).toBe(false);
  });
  test.each([
    ["video kind", { kind: "video" }], ["empty prompt", { prompt: "   " }], ["prompt too long", { prompt: "x".repeat(4001) }], ["non-string prompt", { prompt: 5 }],
    ["bad model id", { model: "../etc" }], ["missing model", { model: undefined }], ["bad aspect", { aspect_ratio: "wide" }],
    ["too many refs", { files: Array.from({ length: 5 }, (_, i) => ({ ref: `vertex-client/${CONV}/${i}.png`, mime: "image/png" })) }],
    ["foreign ref", { files: [{ ref: "vertex-client/other-conv/a.png", name: "a.png", mime: "image/png" }] }],
    ["traversal ref", { files: [{ ref: `vertex-client/${CONV}/../x.png`, name: "a.png", mime: "image/png" }] }],
    ["pdf as reference", { files: [{ ref: `vertex-client/${CONV}/a.pdf`, name: "a.pdf", mime: "application/pdf" }] }],
  ])("rejects %s before anything happens", async (_n, patch) => {
    const r = rig(() => okImg());
    const x = await r.engine.genPlan(cmd(patch as any));
    expect(x.ok).toBe(false);
    expect(r.calls).toHaveLength(0); expect(r.events).toHaveLength(0);
  });
  test("busy while another turn is running or armed; and unavailable without R2 / without provider.image", async () => {
    const r = rig(() => okImg());
    r.engine.setMeta("pending", "{}");
    expect(await r.engine.genPlan(cmd())).toMatchObject({ ok: false, reject: { code: "busy" } });
    expect(await rig(() => okImg(), { files: false }).engine.genPlan(cmd())).toMatchObject({ ok: false, reject: { code: "unavailable" } });
  });
});

describe("stub provider", () => {
  test("deterministic, free, valid PNG; 'blocked' prompt simulates a filter; unknown model returns nothing", () => {
    const a = stubImage({ model: "e2e-stub-image", prompt: "x" }), b = stubImage({ model: "e2e-stub-image", prompt: "x" });
    expect(a).toEqual(b);
    const png = Uint8Array.from(atob(a.images[0].data), (c) => c.charCodeAt(0));
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(new DataView(png.buffer).getUint32(16)).toBe(2); expect(new DataView(png.buffer).getUint32(20)).toBe(2);
    expect(stubImage({ model: "e2e-stub-image", prompt: "a blocked thing" })).toMatchObject({ images: [], finish_reason: "SAFETY" });
    expect(stubImage({ model: "gemini-3-pro-image", prompt: "x" }).images).toEqual([]);
  });
});
