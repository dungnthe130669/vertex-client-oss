// NIM catalog wiring (2026-10-26 live probe): verified vision/tools capabilities, and text-to-image through ai.api.nvidia.com/v1/genai.
import { describe, expect, test } from "bun:test";
import { nvidiaDefaultModels, parseConfig, PROVIDERS, type ProviderConfig } from "../src/providers/config";
import { openaiCompatProvider } from "../src/providers/openai-compat";
import { NVIDIA_IMAGE_MODELS, NVIDIA_TOOLS_VERIFIED, NVIDIA_VERIFIED, NVIDIA_VISION_VERIFIED } from "../src/providers/presets";

const row = (over: Record<string, unknown> = {}) => ({ id: "nvidia", kind: "openai-compat", base_url: "https://integrate.api.nvidia.com/v1", key_binding: "PROVIDER_KEY_NVIDIA", auth_header: "bearer", enabled: 1, models_json: "[]", ...over });
const KEY = "nvapi-secret-123";
const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ ...parseConfig(row())!, ...over });
const env = { PROVIDER_KEY_NVIDIA: KEY };
const ok = (artifacts: unknown) => async (_u: string, _i?: RequestInit) => new Response(JSON.stringify({ artifacts }), { status: 200 });

describe("verified capabilities", () => {
  test("every vision id is a verified chat id; the picker no longer says 'no images' for them, and still does for ultra", () => {
    for (const id of NVIDIA_VISION_VERIFIED) expect(NVIDIA_VERIFIED).toContain(id);
    for (const id of NVIDIA_TOOLS_VERIFIED) expect(NVIDIA_VERIFIED).toContain(id);
    const m = Object.fromEntries(nvidiaDefaultModels().map((x) => [x.id, x.capabilities]));
    expect(m["minimaxai/minimax-m3.1-flash"]).toMatchObject({ text: true, vision: true, tools: true });
    expect(m["z-ai/glm-5.3-flash"]).toMatchObject({ vision: true, tools: true });
    expect(m["nvidia/nemotron-3-ultra-550b-a55b"]).toMatchObject({ vision: false, tools: true });
    expect(m["nvidia/nemotron-3.5-bolt-e4b"]).toMatchObject({ vision: false, tools: true });
    expect(m["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"]).toMatchObject({ vision: true, tools: false }); // 503 on the tools probe: not verified
  });
  test("a stored text-only row at the preset origin is raised to the verified capabilities; an unverified id is left alone", () => {
    const stored = JSON.stringify([{ id: "minimaxai/minimax-m3.1-flash", capabilities: { text: true } }, { id: "google/gemma-4-31b-it", capabilities: { text: true } }]);
    const c = parseConfig(row({ models_json: stored }))!;
    expect(c.models[0]!.capabilities).toMatchObject({ vision: true, tools: true });
    expect(c.models[1]!.capabilities).toMatchObject({ vision: false, tools: false });
  });
  test("an edited origin gets nothing: text-only whatever the row says", () => {
    const stored = JSON.stringify([{ id: "minimaxai/minimax-m3.1-flash", capabilities: { text: true, vision: true, tools: true } }]);
    expect(parseConfig(row({ base_url: "https://evil.example/v1", models_json: stored }))!.models[0]!.capabilities).toMatchObject({ vision: false, tools: false });
  });
});

describe("NVIDIA text-to-image", () => {
  test("listed (kind image, no price) only at the preset origin of the nvidia provider", async () => {
    const p = openaiCompatProvider(cfg(), env);
    const img = await p.listModels("image");
    expect(img.map((m) => m.id)).toEqual(NVIDIA_IMAGE_MODELS.map((m) => m.id));
    expect(img.every((m) => m.kind === "image" && m.pricePerMTok === null && m.capabilities?.["image-gen"])).toBe(true);
    expect((await p.listModels()).some((m) => m.kind === "image")).toBe(false);
    expect(p.image).toBeDefined();
    const moved = openaiCompatProvider(cfg({ baseUrl: "https://evil.example/v1" }), env);
    expect(await moved.listModels("image")).toEqual([]); expect(moved.image).toBeUndefined();
    const other = openaiCompatProvider({ ...cfg(), id: "other", keyBinding: "X" }, { X: "k" });
    expect(await other.listModels("image")).toEqual([]); expect(other.image).toBeUndefined();
    expect(PROVIDERS.find((x) => x.id === "nvidia")).toBeUndefined(); // the preset is a row, not a built-in
  });
  test("request: genai URL, Bearer key only in the header, prompt/size/steps in the body; JPEG result, cost unknown (never 0)", async () => {
    let seen: { url: string; init: any } | undefined;
    const f = async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ artifacts: [{ base64: "/9j/AAAA", finishReason: "SUCCESS", seed: 1 }] }), { status: 200 }); };
    const r = await openaiCompatProvider(cfg(), env, f as any).image!({ model: "black-forest-labs/flux.2-klein-4b", prompt: "a red circle", aspect_ratio: "16:9" });
    expect(seen!.url).toBe("https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b");
    expect(seen!.init.headers.authorization).toBe(`Bearer ${KEY}`); expect(seen!.init.redirect).toBe("manual");
    expect(String(seen!.init.body)).not.toContain(KEY);
    expect(JSON.parse(seen!.init.body)).toEqual({ prompt: "a red circle", width: 1344, height: 768, seed: 0, steps: 4 });
    expect(r.images).toEqual([{ mime_type: "image/jpeg", data: "/9j/AAAA" }]); expect(r.finish_reason).toBe("STOP");
    expect(r.cost!.usd).toBeNull();
  });
  test("flux.1-dev uses 5 steps and an allowed size; an unknown aspect falls back to 1:1", async () => {
    let body: any;
    const f = async (_u: string, init: any) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ artifacts: [{ base64: "/9j/AAAA" }] }), { status: 200 }); };
    await openaiCompatProvider(cfg(), env, f as any).image!({ model: "black-forest-labs/flux.1-dev", prompt: "x", aspect_ratio: "7:5" });
    expect(body).toMatchObject({ width: 1024, height: 1024, steps: 5 });
  });
  test("no artifact: no image, reported finish reason, still no cost claim; unknown model 404 before any request", async () => {
    const p = openaiCompatProvider(cfg(), env, ok([{ finishReason: "CONTENT_FILTERED" }]) as any);
    const r = await p.image!({ model: "black-forest-labs/flux.1-dev", prompt: "x" });
    expect(r.images).toEqual([]); expect(r.finish_reason).toBe("CONTENT_FILTERED"); expect(r.cost!.usd).toBeNull();
    let called = false;
    const q = openaiCompatProvider(cfg(), env, (async () => { called = true; return new Response("{}"); }) as any);
    await expect(q.image!({ model: "black-forest-labs/nope", prompt: "x" })).rejects.toMatchObject({ status: 404 });
    expect(called).toBe(false);
  });
  test("upstream errors map to user-safe ProviderErrors (422 -> rejected, 503 -> retryable, 429 -> free-tier hint); a redirect is refused", async () => {
    const st = (s: number, h: Record<string, string> = {}) => openaiCompatProvider(cfg(), env, (async () => new Response(JSON.stringify({ detail: [{ msg: KEY }] }), { status: s, headers: h })) as any).image!({ model: "black-forest-labs/flux.1-dev", prompt: "x" });
    await expect(st(422)).rejects.toMatchObject({ status: 400 });
    await expect(st(503)).rejects.toMatchObject({ status: 503, info: { retryable: true } });
    await expect(st(429)).rejects.toMatchObject({ status: 429, message: expect.stringContaining("40 requests per minute") });
    await expect(st(302, { location: "https://evil.example" })).rejects.toMatchObject({ status: 502 });
    await expect(st(401)).rejects.toMatchObject({ status: 502 });
    try { await st(422); } catch (e) { expect(String((e as Error).message)).not.toContain(KEY); }
  });
  test("no key: 503 and no request", async () => {
    await expect(openaiCompatProvider(cfg(), {}, (async () => { throw new Error("must not be called"); }) as any).image!({ model: "black-forest-labs/flux.1-dev", prompt: "x" })).rejects.toMatchObject({ status: 503 });
  });
});

describe("origin canonical equality (capabilities + genai key)", () => {
  const stored = JSON.stringify([{ id: "minimaxai/minimax-m3.1-flash", capabilities: { text: true } }]);
  const caps = (base_url: string) => parseConfig(row({ base_url, models_json: stored }))?.models[0]?.capabilities;
  test("the exact preset URL (trailing slash, default port) is raised", () => {
    for (const u of ["https://integrate.api.nvidia.com/v1", "https://integrate.api.nvidia.com/v1/", "https://integrate.api.nvidia.com:443/v1"]) expect(caps(u)).toMatchObject({ tools: true, vision: true });
  });
  test.each([
    ["userinfo", "https://user:pw@integrate.api.nvidia.com/v1"],
    ["port", "https://integrate.api.nvidia.com:8443/v1"],
    ["subdomain", "https://evil.integrate.api.nvidia.com/v1"],
    ["look-alike", "https://integrate.api.nvidia.com.evil.example/v1"],
    ["trailing dot", "https://integrate.api.nvidia.com./v1"],
    ["path edit", "https://integrate.api.nvidia.com/v1/proxy"],
    ["path edit 2", "https://integrate.api.nvidia.com/v2"],
  ])("%s stays text-only and gets no image models / no image()", async (_n, u) => {
    const c = parseConfig(row({ base_url: u, models_json: stored }));
    if (!c) return; // rejected outright is also safe
    expect(c.models[0]!.capabilities).toMatchObject({ tools: false, vision: false });
    const p = openaiCompatProvider(c, env);
    expect(await p.listModels("image")).toEqual([]); expect(p.image).toBeUndefined();
  });
  test("a path edit passed directly to the provider (bypassing parse) still gets no image path", async () => {
    const p = openaiCompatProvider(cfg({ baseUrl: "https://integrate.api.nvidia.com/v1/proxy" }), env);
    expect(p.image).toBeUndefined();
  });
});

describe("nvidiaImage hardening", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
  const webp = btoa("RIFF\0\0\0\0WEBPVP8 ");
  const run = (artifacts: unknown) => openaiCompatProvider(cfg(), env, ok(artifacts) as any).image!({ model: "black-forest-labs/flux.1-dev", prompt: "x" });
  test("detected mime from magic bytes (png, webp, jpeg); never defaulted", async () => {
    expect((await run([{ base64: png, finishReason: "SUCCESS" }])).images[0]!.mime_type).toBe("image/png");
    expect((await run([{ base64: webp }])).images[0]!.mime_type).toBe("image/webp");
    expect((await run([{ base64: "/9j/AAAA" }])).images[0]!.mime_type).toBe("image/jpeg");
  });
  test("invalid base64, non-image bytes, oversize are rejected", async () => {
    await expect(run([{ base64: "not base64!!" }])).rejects.toMatchObject({ status: 502 });
    await expect(run([{ base64: "AAAA\nAAAA" }])).rejects.toMatchObject({ status: 502 });
    await expect(run([{ base64: btoa("<svg onload=alert(1)>") }])).rejects.toMatchObject({ status: 502 }); // magic bytes absent: no default to PNG
    const big = btoa("\xff\xd8\xff" + "a".repeat(9 * 1024 * 1024 + 10));
    await expect(run([{ base64: big }])).rejects.toMatchObject({ status: 502 });
  });
  test("a non-success finishReason yields no image even with data", async () => {
    const r = await run([{ base64: png, finishReason: "CONTENT_FILTERED" }]);
    expect(r.images).toEqual([]); expect(r.finish_reason).toBe("CONTENT_FILTERED");
  });
  test("allowlisted slug only: a tampered slug entry never reaches fetch", async () => {
    const m = NVIDIA_IMAGE_MODELS[0]!; const orig = m.slug; let called = false;
    m.slug = "../../evil";
    try { await expect(openaiCompatProvider(cfg(), env, (async () => { called = true; return new Response("{}"); }) as any).image!({ model: m.id, prompt: "x" })).rejects.toMatchObject({ status: 404 }); }
    finally { m.slug = orig; }
    expect(called).toBe(false);
  });
  test("price unknown, never free or zero, for every NVIDIA image model", async () => {
    for (const m of NVIDIA_IMAGE_MODELS) {
      const r = await openaiCompatProvider(cfg(), env, ok([{ base64: png }]) as any).image!({ model: m.id, prompt: "x" });
      expect(r.cost!.usd).toBeNull(); expect(r.cost!.basis).toBe("price not reported"); expect(JSON.stringify(r.cost).toLowerCase()).not.toContain("free");
    }
    for (const m of await openaiCompatProvider(cfg(), env).listModels("image")) expect(m.pricePerMTok).toBeNull();
  });
});
