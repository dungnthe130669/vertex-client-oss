import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, toApiContent, type IndexSink, type ServerEvent, type TurnEndInfo } from "../src/turn-engine";
import { ProviderError, type ModelProvider, type VideoRequest, type VideoResult } from "../src/providers/types";
import { STUB_MP4_B64, stubVideo } from "../src/providers/stub-video";
import { STUB_PNG_B64 } from "../src/providers/stub-image";
import { MAX_GEN_VIDEO_B64, type FileStore } from "../src/files";

const CONV = "conv-v";
const OMNI = "gemini-omni-1.1-flash-preview";
const okVid = (o: Partial<VideoResult> = {}): VideoResult => ({ model: OMNI, video: { mime_type: "video/mp4", data: STUB_MP4_B64, duration_seconds: 3, resolution: "360p", has_audio: true },
  finish_reason: "completed", usage: { input_tokens: 9, output_tokens: 5800 }, cost: { usd: 0.106 }, ...o });

function rig(video: (req: VideoRequest, signal: AbortSignal | undefined, n: number) => Promise<VideoResult> | VideoResult, opts: { put?: FileStore["put"]; db?: Database; noVideo?: boolean } = {}) {
  const db = opts.db ?? new Database(":memory:");
  const calls: VideoRequest[] = [];
  const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async () => Response.json({ content: [{ type: "text", text: "T" }], usage: {} }),
    image: async () => ({ model: "x", images: [{ mime_type: "image/png", data: STUB_PNG_B64 }], text: null, finish_reason: "STOP", cost: { usd: 0.04 } }),
    ...(opts.noVideo ? {} : { video: async (req: VideoRequest, signal?: AbortSignal) => { calls.push(req); return video(req, signal, calls.length); } }) };
  const store = new Map<string, { bytes: Uint8Array; mime: string; conv: string }>();
  const deleted: string[] = [];
  const files: FileStore = { size: async () => null,
    get: async (k) => store.get(k)?.bytes ?? null,
    put: opts.put ?? (async (k, bytes, mime, conv) => { store.set(k, { bytes, mime, conv }); }),
    delete: async (ks) => { for (const k of ks) { deleted.push(k); store.delete(k); } },
  };
  const events: ServerEvent[] = [];
  const idx = { usage: [] as any[], convs: [] as any[] };
  const ended: TurnEndInfo[] = [];
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async (c) => { idx.convs.push(c); }, recordUsage: async (u) => { idx.usage.push(u); } };
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, files, sink: { broadcast: (_s, _t, e) => events.push(e) }, retryDelayMs: 1, onTurnEnd: (n) => { ended.push(n); },
  });
  engine.setConvId(CONV);
  return { engine, calls, store, deleted, events, idx, db, ended };
}
const cmd = (o: Record<string, unknown> = {}) => ({ kind: "video", prompt: "a cat walking", model: OMNI, ...o });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("video: happy path", () => {
  test("one call (no n / images), mp4 in R2 under gen/, gen_video block by ref, one usage row kind=video units=seconds, push 'video'", async () => {
    const r = rig(() => okVid());
    r.engine.setMeta("model", "claude-sonnet-5-5");
    expect(await r.engine.generate(cmd({ duration_seconds: 3, resolution: "360p", aspect_ratio: "16:9" }))).toEqual({ ok: true });
    await tick();
    expect(r.calls).toEqual([{ model: OMNI, prompt: "a cat walking", duration_seconds: 3, resolution: "360p", aspect_ratio: "16:9" }]);
    const [key, obj] = [...r.store][0];
    expect(key).toMatch(new RegExp(`^vertex-client/${CONV}/gen/[0-9a-f-]{36}\\.mp4$`));
    expect(obj.mime).toBe("video/mp4");
    expect(new TextDecoder().decode(obj.bytes.slice(4, 8))).toBe("ftyp");
    const [u, a] = r.engine.messages();
    expect(u.content).toEqual([{ type: "text", text: "a cat walking" }]);
    expect(a.content).toEqual([{ type: "gen_video", ref: key, mime: "video/mp4", seconds: 3, resolution: "360p", aspect_ratio: "16:9", has_audio: true, size: obj.bytes.length,
      prompt: "a cat walking", model: OMNI, cost_usd: 0.106, est_usd: 0.126 }]);
    expect(a).toMatchObject({ costUsd: 0.106, stopReason: "gen_video", status: "complete" });
    expect(JSON.stringify(r.engine.messages())).not.toContain(STUB_MP4_B64.slice(0, 40));
    expect(r.idx.usage).toEqual([{ conversationId: CONV, model: OMNI, usage: { input_tokens: 9, output_tokens: 5800 }, costUsd: 0.106, kind: "video", estUsd: 0.126, units: 3, dispatchId: expect.any(String) }]);
    expect(r.events.find((e) => e.type === "turn_start")).toMatchObject({ kind: "video", model: OMNI });
    expect(r.engine.meta("model")).toBe("claude-sonnet-5-5"); // the chat model is untouched
    expect(r.engine.meta("gen_dispatched")).toBeNull();
    expect(r.ended).toEqual([{ conversationId: CONV, status: "done", title: "a cat walking", preview: "", media: "video" }]);
  });
  test("defaults: 3 s / 360p; the gateway's reported duration wins for units", async () => {
    const r = rig(() => okVid({ video: { mime_type: "video/mp4", data: STUB_MP4_B64, duration_seconds: 5 } }));
    await r.engine.generate(cmd({ duration_seconds: 5 }));
    expect(r.calls[0]).toEqual({ model: OMNI, prompt: "a cat walking", duration_seconds: 5, resolution: "360p" });
    expect(r.idx.usage[0]).toMatchObject({ units: 5 });
  });
  test("while the call runs: state says generating video with a start time, and the dispatched marker is persisted", async () => {
    let release!: (v: VideoResult) => void;
    const r = rig(() => new Promise<VideoResult>((res) => { release = res; }));
    const p = r.engine.generate(cmd());
    await tick();
    const st = r.engine.state() as any;
    expect(st).toMatchObject({ running: true, generating: true, genKind: "video" });
    expect(typeof st.genStartedAt).toBe("number");
    expect(JSON.parse(r.engine.meta("gen_dispatched")!)).toEqual({ id: expect.any(String), kind: "video", model: OMNI, est_usd: 0.126 });
    release(okVid()); await p;
    expect(r.engine.meta("gen_dispatched")).toBeNull();
    expect((r.engine.state() as any).genKind).toBeUndefined();
  });
  test("a follow-up chat turn sees a one-line note, not the block", () => {
    expect(toApiContent([{ type: "gen_video", ref: "r", seconds: 5, prompt: "p" }])).toEqual([{ type: "text", text: "[A 5 s video was generated from this prompt: p]" }]);
  });
});

describe("video: validation + confirm (server side)", () => {
  test("rejects reference images, bad duration, bad resolution, missing provider", async () => {
    const r = rig(() => okVid());
    const ref = { ref: `vertex-client/${CONV}/a.png`, name: "a.png", mime: "image/png", size: 1 };
    for (const [c, why] of [[{ files: [ref] }, "no reference images"], [{ duration_seconds: 2 }, "duration"], [{ duration_seconds: 11 }, "duration"], [{ duration_seconds: 3.5 }, "duration"],
      [{ duration_seconds: "5" }, "duration"], [{ resolution: "huge" }, "resolution"], [{ aspect_ratio: "wide" }, "aspect"]] as const) {
      const p = await r.engine.genPlan(cmd(c));
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reject.error).toContain(why);
    }
    const none = rig(() => okVid(), { noVideo: true });
    const p = await none.engine.genPlan(cmd());
    expect(p.ok ? null : p.reject).toMatchObject({ code: "unavailable" });
    expect(r.calls).toHaveLength(0);
  });
  test("> $1 (10 s at 4k ≈ $3.37) needs confirmed + est_usd >= server estimate; unknown model forces confirm", async () => {
    const r = rig(() => okVid());
    const big = cmd({ duration_seconds: 10, resolution: "4k" });
    let p = await r.engine.genPlan(big);
    expect(p.ok ? null : p.reject).toMatchObject({ code: "confirm_required", est_usd: 3.365 });
    p = await r.engine.genPlan({ ...big, confirmed: true, est_usd: 1 });
    expect(p.ok ? null : p.reject.error).toContain("does not cover");
    p = await r.engine.genPlan({ ...big, confirmed: true, est_usd: 3.365 });
    expect(p.ok).toBe(true);
    expect((await r.engine.genPlan(cmd({ duration_seconds: 10 }))).ok).toBe(true); // 10 s 360p ≈ $0.385: one tap
    p = await r.engine.genPlan(cmd({ model: "gemini-omni-9" }));
    expect(p.ok ? null : p.reject).toMatchObject({ code: "confirm_required" });
    expect(r.calls).toHaveLength(0);
    expect(r.engine.messages()).toEqual([]);
  });
});

describe("video: every exit path records exactly one usage row, nothing retried", () => {
  test("504 upstream_timeout: error card (not retryable, billing uncertain), NULL cost + estimate, exactly one call", async () => {
    const r = rig(() => { throw new ProviderError("Video generation timed out (the service gives up after 150 s). It may still have been billed, so it was not retried.", 504, { type: "upstream_timeout" }); });
    await r.engine.generate(cmd());
    expect(r.calls).toHaveLength(1);
    const end = r.events.find((e) => e.type === "turn_end")!;
    expect(end.status).toBe("error");
    expect(end.error).toMatchObject({ type: "upstream_timeout", status: 504, retryable: false });
    expect(end.error.message).toContain("150 s");
    expect(end.error.message).toContain("Billing uncertain (estimated $0.13)");
    expect(r.idx.usage).toEqual([{ conversationId: CONV, model: OMNI, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: null, kind: "video", estUsd: 0.126, units: 0, dispatchId: expect.any(String) }]);
    expect(r.engine.messages().map((m) => m.role)).toEqual(["user"]);
    expect(r.engine.meta("gen_dispatched")).toBeNull();
    expect(r.store.size).toBe(0);
  });
  test("safety refusal (generation_blocked) is a normal assistant message with the reported cost", async () => {
    const r = rig(() => { throw new ProviderError("The model declined to generate this video (SAFETY).", 422, { type: "generation_blocked", costUsd: 0.004 }); });
    await r.engine.generate(cmd());
    const a = r.engine.messages()[1];
    expect(a.content).toEqual([{ type: "text", text: "The model declined to generate this video (SAFETY)." }]);
    expect(a).toMatchObject({ costUsd: 0.004, stopReason: "gen_filtered", status: "complete" });
    expect(r.events.find((e) => e.type === "turn_end")).toMatchObject({ status: "done", error: null });
    expect(r.idx.usage).toEqual([expect.objectContaining({ costUsd: 0.004, units: 0, kind: "video" })]);
  });
  test("200 without a clip: message + 'billing uncertain' when no cost was reported", async () => {
    const r = rig(() => okVid({ video: null, cost: undefined, finish_reason: "blocked" }));
    await r.engine.generate(cmd());
    expect(r.engine.messages()[1].content[0].text).toBe("No video was generated (blocked). Try rephrasing the prompt. Billing uncertain (estimated $0.13).");
    expect(r.idx.usage).toEqual([expect.objectContaining({ costUsd: null, units: 0 })]);
  });
  test("stop mid-call: fetch aborted, 'may still be billed' message, interrupted, one row with the estimate", async () => {
    const r = rig((_q, signal) => new Promise<VideoResult>((_res, rej) => signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const p = r.engine.generate(cmd());
    await tick();
    r.engine.stop();
    await p;
    const a = r.engine.messages()[1];
    expect(a.status).toBe("interrupted");
    expect(a.content[0].text).toBe("Stopped. The video request was already sent and may still be billed (estimated $0.13).");
    expect(r.events.find((e) => e.type === "turn_end")).toMatchObject({ status: "interrupted" });
    expect(r.idx.usage).toEqual([expect.objectContaining({ costUsd: null, estUsd: 0.126, units: 0 })]);
    expect(r.ended).toEqual([]); // no "Video ready" push
  });
  test("R2 write fails after a paid result: error, the gateway's cost is kept, nothing left in R2", async () => {
    const r = rig(() => okVid(), { put: async () => { throw new Error("r2 down"); } });
    await r.engine.generate(cmd());
    const end = r.events.find((e) => e.type === "turn_end")!;
    expect(end).toMatchObject({ status: "error" });
    expect(end.error.message).not.toContain("Billing uncertain"); // the cost is known
    expect(r.idx.usage).toEqual([expect.objectContaining({ costUsd: 0.106, units: 0 })]);
  });
  test("oversized / malformed clip from the provider: refused before decoding, one row, error", async () => {
    for (const data of ["x".repeat(MAX_GEN_VIDEO_B64 + 4), "abc"]) {
      const r = rig(() => okVid({ video: { mime_type: "video/mp4", data } }));
      await r.engine.generate(cmd());
      expect(r.events.find((e) => e.type === "turn_end")).toMatchObject({ status: "error" });
      expect(r.store.size).toBe(0);
      expect(r.idx.usage).toHaveLength(1);
    }
  });
  test("a non-mp4 mime is treated as 'no video' (never written)", async () => {
    const r = rig(() => okVid({ video: { mime_type: "text/html", data: STUB_MP4_B64 } }));
    await r.engine.generate(cmd());
    expect(r.store.size).toBe(0);
    expect(r.engine.messages()[1].content[0].text).toContain("No video was generated");
  });
});

describe("DO eviction mid-call (dispatched marker)", () => {
  test("init() after an eviction records the lost row (NULL cost + estimate) once and closes the turn non-retryable", async () => {
    const db = new Database(":memory:");
    const r1 = rig(() => new Promise<VideoResult>(() => {}), { db }); // never settles: the "instance" dies mid-call
    void r1.engine.generate(cmd());
    await tick();
    expect(r1.engine.meta("gen_dispatched")).not.toBeNull();
    expect(r1.idx.usage).toEqual([]);
    const r2 = rig(() => okVid(), { db }); // new instance on the same storage
    await r2.engine.init();
    expect(r2.idx.usage).toEqual([{ conversationId: CONV, model: OMNI, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: null, kind: "video", estUsd: 0.126, units: 0, dispatchId: expect.any(String) }]);
    const end = r2.events.find((e) => e.type === "turn_end")!;
    expect(end.status).toBe("error");
    expect(end.error).toMatchObject({ type: "interrupted", retryable: false });
    expect(end.error.message).toContain("while the video was generating");
    expect(end.error.message).toContain("billing uncertain (estimated $0.13)");
    expect(r2.engine.meta("gen_dispatched")).toBeNull();
    expect(r2.engine.running).toBe(false);
    const r3 = rig(() => okVid(), { db }); await r3.engine.init();
    expect(r3.idx.usage).toEqual([]); // at most one recovered row
  });
  test("the image path sets and clears the same marker", async () => {
    const r = rig(() => okVid());
    await r.engine.generate({ kind: "image", prompt: "a cube", model: "gemini-3.1-flash-image" });
    expect(r.engine.meta("gen_dispatched")).toBeNull();
    expect(r.idx.usage).toEqual([expect.objectContaining({ kind: "image", units: 1 })]);
  });
});

describe("stub provider", () => {
  test("fixture is a real small MP4; blocked / timeout / unknown model map to gateway-shaped errors", async () => {
    const bytes = Uint8Array.from(atob(STUB_MP4_B64), (c) => c.charCodeAt(0));
    expect(bytes.length).toBeLessThanOrEqual(100 * 1024);
    expect(new TextDecoder().decode(bytes.slice(4, 8))).toBe("ftyp");
    expect(new TextDecoder().decode(bytes)).toContain("moov");
    const ok = await stubVideo({ model: "e2e-stub-video", prompt: "x", duration_seconds: 5 });
    expect(ok).toMatchObject({ video: { mime_type: "video/mp4", duration_seconds: 5 }, cost: { usd: 0.175 } });
    await expect(stubVideo({ model: "e2e-stub-video", prompt: "a blocked thing" })).rejects.toMatchObject({ status: 422, info: { type: "generation_blocked" } });
    await expect(stubVideo({ model: "e2e-stub-video", prompt: "timeout please" })).rejects.toMatchObject({ status: 504, info: { type: "upstream_timeout" } });
    await expect(stubVideo({ model: "gemini-omni-1.1-flash-preview", prompt: "x" })).rejects.toMatchObject({ status: 404 });
    const ac = new AbortController();
    const slow = stubVideo({ model: "e2e-stub-video", prompt: "slow one" }, ac.signal);
    ac.abort();
    await expect(slow).rejects.toMatchObject({ name: "AbortError" });
  });
});
