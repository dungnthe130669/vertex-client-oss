import { describe, expect, test } from "bun:test";
import { gatewayProvider, imageError } from "../src/providers/gateway";
import { ProviderError } from "../src/providers/types";

type Call = { url: string; init: RequestInit };
const fetcher = (h: (c: Call) => Response | Promise<Response>) => { const calls: Call[] = []; return { calls, f: { fetch: async (url: string, init: RequestInit = {}) => { const c = { url, init }; calls.push(c); return h(c); } } as unknown as Fetcher }; };
const ok = { id: "img_1", model: "gemini-3.1-flash-image", images: [{ mime_type: "image/png", data: "QUJD" }], text: null, finish_reason: "STOP", usage: { input_tokens: 5, output_tokens: 1120 }, cost: { usd: 0.0423, basis: "usage", estimate_usd: 0.05, price_verified: false } };
const err = (status: number, type: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify({ type: "error", error: { type, message: `gateway says ${type}`, request_id: "r1", ...extra } }), { status, headers });

describe("gateway provider image()", () => {
  test("POSTs /v1/images with the caller key and the spec body, returns the parsed 200", async () => {
    const t = fetcher(() => Response.json(ok));
    const r = await gatewayProvider(t.f, "KEY").image!({ model: "gemini-3.1-flash-image", prompt: "a red cube", aspect_ratio: "16:9", images: [{ mime_type: "image/png", data: "AAAA" }] });
    expect(t.calls[0].url).toBe("https://gateway.internal/v1/images");
    expect(t.calls[0].init.method).toBe("POST");
    expect((t.calls[0].init.headers as any)["x-api-key"]).toBe("KEY");
    expect(JSON.parse(String(t.calls[0].init.body))).toEqual({ model: "gemini-3.1-flash-image", prompt: "a red cube", aspect_ratio: "16:9", images: [{ mime_type: "image/png", data: "AAAA" }] });
    expect(r.images).toEqual([{ mime_type: "image/png", data: "QUJD" }]);
    expect(r.cost?.usd).toBe(0.0423); expect(r.finish_reason).toBe("STOP"); expect(r.text).toBeNull();
  });
  test("legacy first-gateway shape data[{b64_json,mime_type}] + Gemini usageMetadata is accepted (gemini-2.5-flash-image)", async () => {
    const t = fetcher(() => Response.json({ created: 1, model: "gemini-2.5-flash-image", data: [{ b64_json: "QUJD", mime_type: "image/png" }], text: "Here is your dog.", usage: { promptTokenCount: 7, candidatesTokenCount: 1298, totalTokenCount: 1305 } }));
    const r = await gatewayProvider(t.f, "k").image!({ model: "gemini-2.5-flash-image", prompt: "dog" });
    expect(r.images).toEqual([{ mime_type: "image/png", data: "QUJD" }]);
    expect(r.usage).toEqual({ input_tokens: 7, output_tokens: 1298 }); expect(r.text).toBe("Here is your dog.");
  });
  test("200 text-only (no images/data arrays) stays an unreadable-response 502", async () => {
    const t = fetcher(() => Response.json({ text: "no picture" }));
    await expect(gatewayProvider(t.f, "k").image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 502 });
  });
  test("truncated JSON body is a 502, not a crash", async () => {
    const t = fetcher(() => new Response('{"images":[{"mime_type":"image/png","da'));
    await expect(gatewayProvider(t.f, "k").image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 502 });
  });
  test("blocked 422 with cost.usd 0 carries costUsd 0 in info", async () => {
    const t = fetcher(() => new Response(JSON.stringify({ type: "error", error: { type: "generation_blocked", message: "x", finish_reason: "IMAGE_SAFETY", retryable: true, cost: { usd: 0, basis: "no_image" } } }), { status: 422 }));
    await expect(gatewayProvider(t.f, "k").image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 422, info: { costUsd: 0 } });
  });
  test("no key => 503 before any call", async () => {
    const t = fetcher(() => Response.json(ok));
    await expect(gatewayProvider(t.f, "").image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 503 });
    expect(t.calls.length).toBe(0);
  });
  test("an unreadable 200 is a 502, not a crash", async () => {
    const t = fetcher(() => new Response("<html>"));
    await expect(gatewayProvider(t.f, "k").image!({ model: "m", prompt: "p" })).rejects.toMatchObject({ status: 502 });
  });
  test("a 200 whose images lack data yields an empty images list (engine treats it as filtered)", async () => {
    const t = fetcher(() => Response.json({ ...ok, images: [{ mime_type: "image/png" }, null] }));
    expect((await gatewayProvider(t.f, "k").image!({ model: "m", prompt: "p" })).images).toEqual([]);
  });
  test("a transport failure becomes a user-safe ProviderError; the caller's own abort is rethrown untouched", async () => {
    const boom = fetcher(() => { throw new Error("tcp reset to 10.0.0.1"); });
    const e = await gatewayProvider(boom.f, "k").image!({ model: "m", prompt: "p" }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError); expect(e.message).not.toContain("10.0.0.1");
    const ac = new AbortController(); ac.abort();
    const ab = fetcher(() => { throw new DOMException("aborted", "AbortError"); });
    const e2 = await gatewayProvider(ab.f, "k").image!({ model: "m", prompt: "p" }, ac.signal).catch((x) => x);
    expect(e2).not.toBeInstanceOf(ProviderError);
  });
  test.each([
    [422, "generation_blocked", { finish_reason: "IMAGE_RECITATION", retryable: true }, {}, 422, /declined to generate.*IMAGE_RECITATION.*rephrasing/],
    [422, "generation_blocked", { block_reason: "PROHIBITED_CONTENT" }, {}, 422, /declined to generate/],
    [502, "empty_result", { retryable: true }, {}, 502, /returned no image/],
    [429, "rate_limit_error", {}, { "retry-after": "12" }, 429, /rate limited.*12s/],
    [429, "rate_limit_error", {}, {}, 429, /30s/],
    [504, "upstream_timeout", {}, {}, 504, /may still have been billed/],
    [401, "authentication_error", {}, {}, 502, /rejected this app's credentials/],
    [404, "unknown_model", {}, {}, 404, /not available/],
    [413, "request_too_large", {}, {}, 413, /too large/],
    [400, "invalid_param", {}, {}, 400, /rejected: gateway says invalid_param/],
    [400, "unsupported_param", {}, {}, 400, /rejected/],
    [502, "api_error", { detail: "model_unavailable" }, {}, 502, /failed \(502\)/],
    [503, "api_error", {}, {}, 502, /failed \(503\)/],
  ] as const)("error envelope %d %s", async (status, type, extra, headers, expected, msg) => {
    const t = fetcher(() => err(status, type, extra as any, headers as any));
    const e = (await gatewayProvider(t.f, "k").image!({ model: "m", prompt: "p" }).catch((x) => x)) as ProviderError;
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.status).toBe(expected); expect(e.message).toMatch(msg);
    expect(e.info.requestId).toBe("r1");
  });
  test("gateway cost on a failure is preserved; non-JSON error body is still a clean error", () => {
    expect(imageError(422, { error: { type: "generation_blocked", cost: { usd: 0.003 } } }).info.costUsd).toBe(0.003);
    expect(imageError(500, "garbage").message).toMatch(/failed \(500\)/);
    expect(imageError(502, { error: { type: "api_error", message: "x".repeat(900) } }).message.length).toBeLessThan(80);
  });
});

describe("gateway provider listModels(kind)", () => {
  const list = [{ id: "claude-sonnet-5-5", display_name: "Sonnet" }, { id: "gemini-3.1-flash-image", display_name: "NB2", kind: "image", price: { unit_estimate_usd: 0.067, verified: false }, params: { allowed: ["aspect_ratio"] } }];
  test("kind=image asks ?kind=image and returns only image models with price/params", async () => {
    const t = fetcher(() => Response.json({ data: list }));
    const ms = await gatewayProvider(t.f, "k").listModels("image");
    expect(t.calls[0].url).toBe("https://gateway.internal/v1/models?kind=image");
    expect(ms).toEqual([{ id: "gemini-3.1-flash-image", displayName: "NB2", kind: "image", price: { unitEstimateUsd: 0.067, verified: false }, params: { allowed: ["aspect_ratio"] } }]);
  });
  test("default (chat) request is byte-identical to before and never lists an image model", async () => {
    const t = fetcher(() => Response.json({ data: list }));
    const ms = await gatewayProvider(t.f, "k").listModels();
    expect(t.calls[0].url).toBe("https://gateway.internal/v1/models");
    expect(ms.map((m) => m.id)).toEqual(["claude-sonnet-5-5"]);
  });
});
