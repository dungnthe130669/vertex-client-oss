import { describe, expect, test } from "bun:test";
import { estimate, fmtVideoEstimate, needsConfirm, confirmError, VIDEO_RATES } from "../src/gen-cost";
import { gatewayProvider, mediaError, imageError } from "../src/providers/gateway";
import { genKey, genVideoProblem, MAX_GEN_VIDEO_B64, MAX_GEN_VIDEO_BODY_BYTES, MAX_GEN_VIDEO_BYTES } from "../src/files";
import { parseRange, rangeResponse } from "../src/range";
import { notifyText } from "../src/push";
import { rollup, type Row } from "../src/usage";
import { applyServer, emptyChat, fromServer, genCostLabel, type Frame } from "../web/src/chat-state";
import { fmtElapsed, videoOptions, PREFERRED_SECONDS } from "../web/src/video-opts";
import { STUB_MP4_B64 } from "../src/providers/stub-video";

const OMNI = "gemini-omni-1.1-flash-preview";

describe("gen-cost: video", () => {
  test("Omni: per-second x seconds + per-request, by resolution; covers the measured smoke cost (3 s / 360p = $0.106)", () => {
    const e = estimate("video", OMNI, { seconds: 3, resolution: "360p" });
    expect(e).toEqual({ usd: 0.126, basis: "$0.037/s × 3 s (360p) + $0.015", certainty: "list-price", price_verified: false });
    expect(e.usd).toBeGreaterThanOrEqual(0.106);
    expect(estimate("video", OMNI, { seconds: 10 }).usd).toBe(0.385); // default resolution 360p
    expect(estimate("video", "omni-1.1-flash-preview", { seconds: 5, resolution: "720p" }).usd).toBe(0.575);
    expect(estimate("video", OMNI, { seconds: 10, resolution: "4k" }).usd).toBe(3.365);
    // the token list price (gateway MEDIA_RATES: $17.5/M x tokens/s) is never above the constant used here
    for (const [res, tps] of Object.entries({ "360p": 1931, "720p": 5792, "1080p": 8688, "4k": 17376 })) expect(VIDEO_RATES["omni-1.1-flash-preview"].perSecond[res]).toBeGreaterThan((tps * 17.5) / 1e6);
  });
  test("unknown model / resolution / duration => unknown => confirm forced", () => {
    for (const p of [[OMNI, { seconds: 2 }], [OMNI, { seconds: 11 }], [OMNI, { seconds: 4.5 }], [OMNI, { seconds: 5, resolution: "8k" }], ["veo-9", { seconds: 5 }]] as const) {
      const e = estimate("video", p[0], p[1]);
      expect(e.certainty).toBe("unknown");
      expect(needsConfirm(e)).toBe(true);
      expect(confirmError(e, {})).toContain("no known price");
    }
    expect(fmtVideoEstimate(estimate("video", "x", { seconds: 3 }), 3)).toBe("price unknown");
    expect(fmtVideoEstimate(estimate("video", OMNI, { seconds: 8 }), 8)).toBe("≈ $0.31 · 8 s video");
  });
  test("e2e stub pro video crosses $1 at 8 s, not at 5 s", () => {
    expect(needsConfirm(estimate("video", "e2e-stub-pro-video", { seconds: 5 }))).toBe(false);
    expect(estimate("video", "e2e-stub-pro-video", { seconds: 8 }).usd).toBe(1.2);
    expect(needsConfirm(estimate("video", "e2e-stub-pro-video", { seconds: 8 }))).toBe(true);
  });
  test("image estimates are unchanged by the video branch", () => {
    expect(estimate("image", "gemini-3.1-flash-image", { n: 2 }).usd).toBe(0.09);
  });
});

describe("files: video bounds", () => {
  test("20 MiB decoded, checked on the base64 length before decoding; mp4 key under gen/", () => {
    expect(MAX_GEN_VIDEO_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_GEN_VIDEO_BODY_BYTES).toBe(MAX_GEN_VIDEO_B64 + 65536);
    expect(genVideoProblem(STUB_MP4_B64)).toBeNull();
    expect(genVideoProblem("x".repeat(MAX_GEN_VIDEO_B64 + 4))).toBe("video too large");
    expect(genVideoProblem("abc")).toBe("malformed video data");
    expect(genKey("c1", "video/mp4")).toMatch(/^vertex-client\/c1\/gen\/[0-9a-f-]{36}\.mp4$/);
  });
});

type Call = { url: string; init: RequestInit };
const fetcher = (h: (c: Call) => Response | Promise<Response>) => { const calls: Call[] = []; return { calls, f: { fetch: async (url: string, init: RequestInit = {}) => { const c = { url, init }; calls.push(c); return h(c); } } as unknown as Fetcher }; };
const okBody = { id: "vid_1", model: OMNI, created: "x", video: { mime_type: "video/mp4", data: STUB_MP4_B64, duration_seconds: 3, resolution: "360p", has_audio: true }, text: null, finish_reason: "completed", usage: { input_tokens: 4, output_tokens: 5793 }, cost: { usd: 0.106, basis: "usage" } };
const err = (status: number, type: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ type: "error", error: { type, message: `gateway says ${type}`, ...extra } }), { status });

describe("gateway provider video()", () => {
  test("POSTs /v1/videos with the caller key and exactly the request fields; parses the 200", async () => {
    const t = fetcher(() => Response.json(okBody));
    const r = await gatewayProvider(t.f, "KEY").video!({ model: OMNI, prompt: "a cat", duration_seconds: 3, resolution: "360p", aspect_ratio: "16:9" });
    expect(t.calls[0].url).toBe("https://gateway.internal/v1/videos");
    expect((t.calls[0].init.headers as any)["x-api-key"]).toBe("KEY");
    expect(JSON.parse(String(t.calls[0].init.body))).toEqual({ model: OMNI, prompt: "a cat", duration_seconds: 3, resolution: "360p", aspect_ratio: "16:9" });
    expect(r).toEqual({ id: "vid_1", model: OMNI, video: { mime_type: "video/mp4", data: STUB_MP4_B64, duration_seconds: 3, resolution: "360p", has_audio: true }, finish_reason: "completed", usage: okBody.usage, cost: okBody.cost });
  });
  test("504 upstream_timeout => 'timed out ... 150 s ... not retried', exactly one call", async () => {
    const t = fetcher(() => err(504, "upstream_timeout"));
    const p = gatewayProvider(t.f, "k").video!({ model: OMNI, prompt: "p" });
    await expect(p).rejects.toMatchObject({ status: 504, info: { type: "upstream_timeout" } });
    await expect(p).rejects.toThrow(/150 s.*not retried/);
    expect(t.calls).toHaveLength(1);
  });
  test("error mapping: blocked 422, rate limit 429 with Retry-After, too large, 400 passes the scrubbed message", async () => {
    expect(mediaError(422, { error: { type: "generation_blocked", finish_reason: "SAFETY", cost: { usd: 0.01 } } }, null, "video")).toMatchObject({ status: 422, message: "The model declined to generate this video (SAFETY).", info: { type: "generation_blocked", costUsd: 0.01 } });
    expect(mediaError(429, {}, "12", "video").message).toBe("Video generation is rate limited. Try again in about 12s.");
    expect(mediaError(502, { error: { type: "result_too_large" } }, null, "video").message).toContain("shorter duration");
    expect(mediaError(400, { error: { type: "invalid_param", message: "duration_seconds must be an integer 3..10" } }, null, "video").message).toBe("The video request was rejected: duration_seconds must be an integer 3..10");
    expect(imageError(504, {}).message).toBe("Image generation timed out. It may still have been billed."); // image wording unchanged
  });
  test("network failure is a 502 (not retried); the caller's own abort propagates as-is", async () => {
    const t = fetcher(() => { throw new TypeError("network"); });
    await expect(gatewayProvider(t.f, "k").video!({ model: OMNI, prompt: "p" })).rejects.toMatchObject({ status: 502 });
    const ac = new AbortController(); ac.abort();
    const t2 = fetcher(() => { throw new DOMException("aborted", "AbortError"); });
    await expect(gatewayProvider(t2.f, "k").video!({ model: OMNI, prompt: "p" }, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  test("body cap: a Content-Length over the cap is refused unread; an oversized clip is refused; a 200 without video => video null", async () => {
    const big = fetcher(() => new Response("{}", { headers: { "content-length": String(MAX_GEN_VIDEO_BODY_BYTES + 1) } }));
    await expect(gatewayProvider(big.f, "k").video!({ model: OMNI, prompt: "p" })).rejects.toMatchObject({ status: 502, message: "The video service returned a response that is too large." });
    const huge = fetcher(() => Response.json({ ...okBody, video: { mime_type: "video/mp4", data: "A".repeat(MAX_GEN_VIDEO_B64 + 4) } }));
    await expect(gatewayProvider(huge.f, "k").video!({ model: OMNI, prompt: "p" })).rejects.toMatchObject({ status: 502 });
    const none = fetcher(() => Response.json({ ...okBody, video: null }));
    expect((await gatewayProvider(none.f, "k").video!({ model: OMNI, prompt: "p" })).video).toBeNull();
    const junk = fetcher(() => new Response("<html>"));
    await expect(gatewayProvider(junk.f, "k").video!({ model: OMNI, prompt: "p" })).rejects.toMatchObject({ status: 502 });
  });
  test("listModels('video') asks kind=video and keeps only video models (params included); chat list never carries them", async () => {
    const data = [{ id: OMNI, kind: "video", params: { allowed: ["duration_seconds"], defaults: { duration_seconds: 3 }, values: { duration_seconds: "3..10" } } },
      { id: "gemini-3.1-flash-image", kind: "image" }, { id: "claude-sonnet-5-5" }];
    const t = fetcher(() => Response.json({ data }));
    const v = await gatewayProvider(t.f, "k").listModels("video");
    expect(t.calls[0].url).toBe("https://gateway.internal/v1/models?kind=video");
    expect(v).toEqual([{ id: OMNI, displayName: OMNI, kind: "video", params: data[0].params }]);
    expect((await gatewayProvider(t.f, "k").listModels()).map((m) => m.id)).toEqual(["claude-sonnet-5-5"]);
  });
});

describe("range", () => {
  test("parseRange", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-1", 100)).toEqual({ offset: 0, length: 2 });
    expect(parseRange("bytes=10-", 100)).toEqual({ offset: 10, length: 90 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=-30", 100)).toEqual({ offset: 70, length: 30 });
    expect(parseRange("bytes=-300", 100)).toEqual({ offset: 0, length: 100 });
    for (const h of ["bytes=100-", "bytes=5-2", "bytes=-0", "bytes=-", "bytes=abc"]) expect(parseRange(h, 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull(); // multi-range: full body
    expect(parseRange("items=0-1", 100)).toBeNull();     // other unit: ignored
  });
  test("rangeResponse: 200 full, 206 slice with Content-Range, 416 with bytes */size", async () => {
    const data = new Uint8Array(100).map((_, i) => i);
    const get = async (r?: { offset: number; length: number }) => new Response(r ? data.slice(r.offset, r.offset + r.length) : data).body;
    const full = await rangeResponse(100, "video/mp4", null, get);
    expect([full.status, full.headers.get("content-length"), full.headers.get("accept-ranges"), full.headers.get("content-type")]).toEqual([200, "100", "bytes", "video/mp4"]);
    const part = await rangeResponse(100, "video/mp4", "bytes=0-1", get);
    expect([part.status, part.headers.get("content-length"), part.headers.get("content-range")]).toEqual([206, "2", "bytes 0-1/100"]);
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([0, 1]);
    const bad = await rangeResponse(100, "video/mp4", "bytes=200-", get);
    expect([bad.status, bad.headers.get("content-range")]).toEqual([416, "bytes */100"]);
  });
});

describe("push / usage / UI state", () => {
  test("push text: 'Video ready' for a finished video; chat wording unchanged", () => {
    expect(notifyText("done", "Cats", "", "video")).toEqual({ title: "Cats", body: "Video ready" });
    expect(notifyText("done", "Cats", "hi")).toEqual({ title: "Cats", body: "hi" });
  });
  test("usage rollup: kind video rows land in the Generation split with seconds as units", () => {
    const row = (o: Partial<Row>): Row => ({ mode: "chat", model: OMNI, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.106, n: 1, unrated: 0, ...o });
    const r = rollup([row({ kind: "video", units: 3 }), row({ kind: "video", units: 5, cost: null, unrated: 1 })]);
    expect(r.gen).toEqual([expect.objectContaining({ key: `video · ${OMNI}`, units: 8, calls: 2, costUsd: 0.106, unratedCalls: 1 })]);
    expect(r.byMode.map((g) => g.key)).toEqual(["gen"]);
  });
  test("chat-state: turn_start kind video => generating with kind + start ts; turn_end clears; reload seeds from state; hello sets skew", () => {
    let s = applyServer(emptyChat(), { t: "hello", seq: 0, minSeq: 0, running: false, now: Date.now() + 5000 } as Frame);
    expect(s.clockSkew).toBeGreaterThan(4000);
    s = applyServer(s, { t: "ev", seq: 1, ts: 12345, e: { type: "turn_start", turn: 1, model: OMNI, kind: "video" } });
    expect(s).toMatchObject({ running: true, generating: true, genKind: "video", genStartedAt: 12345 });
    expect(s.model).toBeNull(); // the chat model is not replaced by the video model
    s = applyServer(s, { t: "ev", seq: 2, ts: 12999, e: { type: "turn_end", status: "done", error: null } });
    expect(s).toMatchObject({ generating: false, genKind: null, genStartedAt: null });
    const r = fromServer({ seq: 3, running: true, inflight: { fromSeq: 2 }, model: null, title: "", error: null, costUsd: 0, tokens: 0, generating: true, genKind: "video", genStartedAt: 777, messages: [] });
    expect(r).toMatchObject({ generating: true, genKind: "video", genStartedAt: 777 });
    expect(genCostLabel({ type: "gen_video", cost_usd: null, est_usd: 0.126 })).not.toMatch(/\$/);
  });
  test("video-opts: controls from the gateway params; fallback when missing", () => {
    const omni = videoOptions({ allowed: ["duration_seconds", "resolution", "aspect_ratio"], defaults: { duration_seconds: 3, resolution: "360p" }, values: { duration_seconds: "3..10", resolution: ["360p", "720p", "1080p", "4k"], aspect_ratio: ["16:9", "9:16"] } });
    expect(omni).toEqual({ seconds: [3, 5, 8, 10], resolutions: ["360p", "720p", "1080p", "4k"], aspects: ["16:9", "9:16"], defSeconds: 3, defResolution: "360p" });
    expect(videoOptions(null)).toEqual({ seconds: PREFERRED_SECONDS, resolutions: ["360p"], aspects: ["16:9", "9:16"], defSeconds: 3, defResolution: "360p" });
    expect(videoOptions({ values: { duration_seconds: [4, 6, 8, 12] }, defaults: { duration_seconds: 6 } })).toMatchObject({ seconds: [4, 6, 8], defSeconds: 6 });
    expect(videoOptions({ values: { duration_seconds: "4..6" } }).seconds).toEqual([5]);
    expect(videoOptions({ allowed: ["duration_seconds"], values: { aspect_ratio: ["1:1"] } }).aspects).toEqual([]);
    expect([fmtElapsed(0), fmtElapsed(7400), fmtElapsed(102_000), fmtElapsed(-5)]).toEqual(["0:00", "0:07", "1:42", "0:00"]);
  });
});
