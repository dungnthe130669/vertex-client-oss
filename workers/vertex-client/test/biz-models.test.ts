// Business edition models come from the team gateway's DB-driven catalog: kind / price / capabilities are READ from /v1/models; gen-cost tables are only a fallback.
import { describe, expect, test } from "bun:test";
import { GenEngine } from "../src/gen-engine";
import { buildRegistry } from "../src/providers/registry";
import { MODELS_META, metaOf, GEMINI_GATEWAY_MAX_TOKENS, DEFAULT_PROVIDER_MAX_TOKENS } from "../src/models-meta";
import { estimate, needsConfirm, GEN_CONFIRM_USD_DEFAULT } from "../src/gen-cost";
import { parseListedPrice, gatewayProvider } from "../src/providers/gateway";
import { classifyTeamModel, teamGatewayProvider } from "../src/providers/team-gateway";
import { clearEntitlementCache } from "../src/providers/team-gateway";

const OMNI_PRICE = { basis: "tokens", in_per_mtok: 1.5, out_text_per_mtok: 9, out_video_per_mtok: 17.5, video_tokens_per_second: { "360p": 1931, "720p": 5792 }, unit_estimate_usd: 0.1, verified: false };

describe("parseListedPrice", () => {
  test("keeps only finite non-negative numbers; missing fields are 'not stated', never 0", () => {
    expect(parseListedPrice(OMNI_PRICE as any)).toMatchObject({ outVideoPerMTok: 17.5, outTextPerMTok: 9, videoTokensPerSecond: { "360p": 1931, "720p": 5792 }, unitEstimateUsd: 0.1, verified: false });
    const bad = parseListedPrice({ unit_estimate_usd: -1, per_second: Infinity as any, out_video_per_mtok: "9" as any, video_tokens_per_second: { "360p": "x" } as any } as any)!;
    expect(bad.unitEstimateUsd).toBeUndefined(); expect(bad.perSecond).toBeUndefined(); expect(bad.outVideoPerMTok).toBeUndefined(); expect(bad.videoTokensPerSecond).toBeUndefined();
    expect(parseListedPrice(null)).toBeUndefined(); expect(parseListedPrice("x" as any)).toBeUndefined();
  });
});

describe("estimate: gateway catalog price first, tables are the fallback, no price anywhere = unknown", () => {
  test("image: unit_estimate from the gateway wins over the table for the same id; a model nobody priced is unknown and forces confirm", () => {
    const g = estimate("image", "gemini-3.1-flash-image", { n: 2 }, { unitEstimateUsd: 0.0672, verified: true });
    expect(g).toMatchObject({ usd: 0.1344, certainty: "list-price", price_verified: true });
    expect(estimate("image", "gemini-3.1-flash-image", { n: 2 }).usd).toBe(0.09); // table fallback (no gateway price)
    const u = estimate("image", "gemini-future-image", { n: 1 }, { verified: false });
    expect(u.certainty).toBe("unknown"); expect(needsConfirm(u)).toBe(true);
    expect(estimate("image", "gemini-future-image", { n: 1 }, undefined).certainty).toBe("unknown");
  });
  test("video: token price x seconds (+10% / + overhead) for a model the tables have never heard of; resolution without a token rate is unknown", () => {
    const p = parseListedPrice(OMNI_PRICE as any)!;
    const e = estimate("video", "gemini-omni-9", { seconds: 3, resolution: "360p" }, p);
    expect(e.certainty).toBe("list-price");
    expect(e.usd).toBeCloseTo(3 * (1931 * 17.5 * 1.1) / 1e6 + (1500 * 9) / 1e6, 5);
    expect(estimate("video", "gemini-omni-9", { seconds: 3, resolution: "4k" }, p).certainty).toBe("unknown");
    expect(estimate("video", "gemini-omni-9", { seconds: 2, resolution: "360p" }, p).basis).toBe("bad duration");
    expect(estimate("video", "veo-x", { seconds: 4, resolution: "720p" }, { perSecond: 0.1, verified: true })).toMatchObject({ usd: 0.4, price_verified: true });
    // a long clip at 720p crosses the $1 confirm line from the catalog price alone
    expect(needsConfirm(estimate("video", "gemini-omni-9", { seconds: 10, resolution: "720p" }, p), GEN_CONFIRM_USD_DEFAULT)).toBe(true);
  });
  test("a catalog row whose price states no usable rate is UNKNOWN even for an id the tables know (no silent table fallback); the tables serve only ids with NO catalog row", () => {
    const k = "gemini-omni-1.1-flash-preview";
    expect(estimate("video", k, { seconds: 3, resolution: "360p" }, { verified: false })).toMatchObject({ certainty: "unknown", usd: 0 });
    expect(estimate("video", k, { seconds: 3, resolution: "360p" }, null).certainty).toBe("unknown");
    expect(estimate("image", "gemini-3.1-flash-image", { n: 1 }, null).certainty).toBe("unknown");
    expect(estimate("image", "gemini-3.1-flash-image", { n: 1 }, { verified: false }).certainty).toBe("unknown");
    expect(needsConfirm(estimate("image", "gemini-3.1-flash-image", { n: 1 }, null))).toBe(true);
    expect(estimate("video", k, { seconds: 3, resolution: "360p" }, undefined)).toMatchObject({ certainty: "list-price" }); // legacy: no catalog row
    expect(estimate("image", "gemini-3.1-flash-image", { n: 1 }, undefined).usd).toBe(0.045);
  });
  test("zero / negative / non-finite / absurd catalog values are unknown unless free:true is stated", () => {
    for (const price of [{ unitEstimateUsd: 0 }, { unitEstimateUsd: -1 }, { unitEstimateUsd: NaN }, { unitEstimateUsd: Infinity }, { unitEstimateUsd: 1e308 }, { unitEstimateUsd: 5e6 }])
      expect(estimate("image", "gemini-3.1-flash-image", { n: 1 }, price as any).certainty, JSON.stringify(price)).toBe("unknown");
    expect(estimate("image", "x-image", { n: 1 }, { unitEstimateUsd: 0, free: true })).toMatchObject({ certainty: "list-price", usd: 0 });
    expect(estimate("video", "v", { seconds: 3, resolution: "360p" }, { perSecond: 0 }).certainty).toBe("unknown");
    expect(estimate("video", "v", { seconds: 3, resolution: "360p" }, { perSecond: 1e308 }).certainty).toBe("unknown");
    expect(estimate("video", "v", { seconds: 3, resolution: "360p" }, { outVideoPerMTok: 1e300, videoTokensPerSecond: { "360p": 1e300 } }).certainty).toBe("unknown");
    expect(estimate("video", "v", { seconds: 3, resolution: "360p" }, { perSecond: 0, free: true })).toMatchObject({ certainty: "list-price", usd: 0 });
    // parsing: zero never survives as a stated rate
    const p = parseListedPrice({ unit_estimate_usd: 0, per_second: 0, out_video_per_mtok: 0 } as any)!;
    expect(p.unitEstimateUsd).toBeUndefined(); expect(p.perSecond).toBeUndefined(); expect(p.outVideoPerMTok).toBeUndefined();
    expect(parseListedPrice({ unit_estimate_usd: 0, free: true } as any)!.unitEstimateUsd).toBe(0);
  });

});

describe("classifyTeamModel uses the catalog's kind and capabilities", () => {
  test("embedding never listed; chat marked messages_api:false is hidden; media kinds pass through; legacy gateways keep the id heuristic", () => {
    expect(classifyTeamModel({ id: "text-embedding-005", kind: "embedding" })).toBeNull();
    expect(classifyTeamModel({ id: "gemini-4-argon", kind: "chat", capabilities: { messages_api: false } })).toBeNull();
    expect(classifyTeamModel({ id: "claude-opus-4-7", kind: "chat", capabilities: { messages_api: true }, display_name: "Opus" })).toMatchObject({ kind: "chat", display_name: "Opus" });
    expect(classifyTeamModel({ id: "anything-new", kind: "video" })).toMatchObject({ kind: "video" });
    expect(classifyTeamModel({ id: "brand-new-image", kind: "image" })).toMatchObject({ kind: "image" });
    expect(classifyTeamModel({ id: "gemini-3-pro-image" })).toMatchObject({ kind: "image" }); // legacy
    expect(classifyTeamModel({ id: "gemini-2.5-pro" })).toBeNull(); // legacy gateway without capabilities
    expect(classifyTeamModel({ id: "claude-sonnet-5-5" })).toMatchObject({ kind: "chat" });
  });
});

describe("team provider reads the catalog and can call /v1/videos", () => {
  const calls: string[] = [];
  const CATALOG = [
    { id: "claude-sonnet-5-5", kind: "chat", display_name: "Sonnet", price: { in_per_mtok: 2, out_per_mtok: 10, verified: true }, capabilities: { tools: true, images_in: true, messages_api: true } },
    { id: "brand-new-claude", kind: "chat", display_name: "Brand New", price: { in_per_mtok: 3, out_per_mtok: 15, verified: false }, capabilities: { tools: true, images_in: false, thinking: true, messages_api: true } },
    { id: "gemini-4-argon", kind: "chat", capabilities: { messages_api: false } },
    { id: "text-embedding-005", kind: "embedding" },
    { id: "gemini-3-pro-image", kind: "image", display_name: "Pro image", price: { unit_estimate_usd: 0.1344, verified: false } },
    { id: "gemini-omni-1.1-flash-preview", kind: "video", display_name: "Omni", price: OMNI_PRICE, params: { allowed: ["duration_seconds", "resolution"], defaults: {}, values: {} } },
  ];
  let features = ["vclient_app", "chat", "image_gen", "video_gen"];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const u = new URL(String(input)); calls.push(`${init.method ?? "GET"} ${u.pathname}${u.search}`);
    if (u.pathname === "/v1/entitlements") return Response.json({ features });
    if (u.pathname === "/v1/models") { const k = u.searchParams.get("kind"); return Response.json({ data: CATALOG.filter((m) => !k || m.kind === k) }); }
    if (u.pathname === "/v1/videos") return Response.json({ id: "vid_1", model: "gemini-omni-1.1-flash-preview", created: 1, video: { mime_type: "video/mp4", data: "AAAAGGZ0eXBpc29tAAAAAGlzb21tcDQx", duration_seconds: 3, resolution: "360p", has_audio: true }, usage: { input_tokens: 1, output_tokens: 2 }, cost: { usd: 0.1, basis: "usage", price_verified: false } });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  const env = { TEAM_GATEWAY_URL: "https://gw.example", VCLIENT_TEAM_CALLER_KEY: "CALLER" };
  const mk = () => { clearEntitlementCache(); calls.length = 0; return teamGatewayProvider(env, "ann@example.com", fetchImpl); };

  test("chat list: catalog price + capabilities flow through; unusable entries (embedding, chat-completions-only) are dropped; ids are never hardcoded in the app", async () => {
    features = ["vclient_app", "chat", "image_gen", "video_gen"];
    const p = mk();
    const list = await p.listModels();
    expect(list.map((m) => m.id)).toEqual(["claude-sonnet-5-5", "brand-new-claude"]);
    const bn = list.find((m) => m.id === "brand-new-claude")!;
    expect(bn.pricePerMTok).toEqual({ input: 3, output: 15 });
    expect(bn.capabilities).toEqual({ text: true, vision: false, tools: true, "image-gen": false, "video-gen": false, reasoning: true });
  });
  test("image and video lists carry kind, price and params; every catalog image/video id shows up", async () => {
    const p = mk();
    const img = await p.listModels("image"), vid = await p.listModels("video");
    expect(img.map((m) => m.id)).toEqual(["gemini-3-pro-image"]);
    expect(img[0].price?.unitEstimateUsd).toBe(0.1344);
    expect(vid.map((m) => m.id)).toEqual(["gemini-omni-1.1-flash-preview"]);
    expect(vid[0].price?.outVideoPerMTok).toBe(17.5); expect(vid[0].params?.allowed).toContain("resolution");
    expect(calls).toContain("GET /v1/models?kind=video");
  });
  test("video() calls POST /v1/videos once, gated by video_gen", async () => {
    const p = mk();
    const r = await p.video!({ model: "gemini-omni-1.1-flash-preview", prompt: "a cat", duration_seconds: 3, resolution: "360p" } as any);
    expect(r.model).toBe("gemini-omni-1.1-flash-preview");
    expect(calls.filter((c) => c === "POST /v1/videos")).toHaveLength(1);
  });
  test("feature off => clear 'not enabled for your account' 403 for each media kind (never an empty list); default chat-only users keep chat", async () => {
    features = ["vclient_app", "chat"];
    const p = mk();
    expect((await p.listModels()).length).toBe(2);
    for (const kind of ["image", "video"] as const) {
      const e = await p.listModels(kind).then(() => null, (x) => x);
      expect(e?.status, kind).toBe(403); expect(e?.message, kind).toMatch(/not enabled for your account/);
    }
    await expect(p.video!({ model: "gemini-omni-1.1-flash-preview", prompt: "x" } as any)).rejects.toMatchObject({ status: 403 });
    expect(calls.some((c) => c.includes("/v1/videos"))).toBe(false);
    features = ["vclient_app", "chat", "image_gen", "video_gen"];
  });
});

describe("GenEngine.plan: a catalog row with no usable price forces confirm even for an id the tables know", () => {
  const engine = (models: any[] | Error) => new GenEngine({ host: { convId: "c", busy: () => false } as never,
    provider: { name: "s", listModels: async () => { if (models instanceof Error) throw models; return models; }, messages: async () => new Response(""), image: async () => { throw new Error("must not be called"); } },
    files: { get: async () => null, put: async () => {} } as never, index: {} as never });
  const IMG = { id: "gemini-3.1-flash-image", displayName: "x", kind: "image" };
  const plan = (e: any, c: object = {}) => e.plan({ kind: "image", prompt: "x", model: "gemini-3.1-flash-image", ...c });
  test("price null / unusable => confirm_required (table 0.045 would have passed unconfirmed)", async () => {
    for (const price of [null, {}, { unitEstimateUsd: 0, verified: true }]) {
      const r: any = await plan(engine([{ ...IMG, price }]));
      expect(r.ok, JSON.stringify(price)).toBe(false); expect(r.reject.code).toBe("confirm_required");
    }
    expect(((await plan(engine([{ ...IMG, price: null }]), { confirmed: true, est_usd: 0 })) as any).ok).toBe(true); // an explicit confirm is still honoured
  });
  test("a listing failure is unknown too; no price field at all (legacy, no catalog row) still uses the tables", async () => {
    expect(((await plan(engine(new Error("down")))) as any).reject.code).toBe("confirm_required");
    expect(((await plan(engine([IMG]))) as any).ok).toBe(true);
    expect(((await plan(engine([]))) as any).ok).toBe(true); // id not listed: no catalog row
  });
  test("a stated, usable price is used", async () => {
    const r: any = await plan(engine([{ ...IMG, price: { unitEstimateUsd: 0.6, verified: false } }]), { n: 2 });
    expect(r.ok).toBe(false); expect(r.reject.est_usd).toBeCloseTo(1.2, 5);
  });
});

describe("catalog model meta is keyed by (scope, id) and refreshed per listing", () => {
  const listing = (rows: any[]) => ({ name: "g", listModels: async () => rows, messages: async () => new Response("") }) as any;
  const gate = () => { let go!: () => void; const p = new Promise<void>((r) => (go = r)); return { p, go }; };
  const reg = (rows: any[], scope: any = "main", team?: any) => buildRegistry({ scope, gateway: listing(rows), ...(team ? { team } : {}), env: {} } as any);
  const TEAM_A = "g:abcdefghijklmnopqrstuvwx", TEAM_B = "g:bcdefghijklmnopqrstuvwxy";
  const teamReg = (rows: any[], scope: string) => buildRegistry({ scope, gateway: null, team: listing(rows), env: {} } as any);
  const row = (id: string, input: number, output: number) => ({ id, displayName: id, pricePerMTok: { input, output }, capabilities: { text: true, vision: false, tools: true, "image-gen": false, "video-gen": false, reasoning: false } });
  test("a changed catalog price replaces the earlier one on the next listing (same scope)", async () => {
    await reg([row("zz-catalog-1", 1, 5)]).models();
    expect(metaOf("main", "zz-catalog-1")!.price).toMatchObject({ input: 1, output: 5 });
    await reg([row("zz-catalog-1", 2, 9)]).models();
    expect(metaOf("main", "zz-catalog-1")!.price).toMatchObject({ input: 2, output: 9 });
  });
  test("imgpaste2: live-proven Claude ids get vision even when the catalog says images_in false; gemini/grok and unknown ids stay gated", async () => {
    const out = await reg([row("claude-opus-4-7", 1, 5), row("gemini-3.8-flash", 1, 5), row("grok-4.20-reasoning", 1, 5), row("claude-zz-new", 1, 5)]).models();
    const vis = (id: string) => (out as any[]).find((m) => m.id === id)?.capabilities?.vision;
    expect(vis("claude-opus-4-7")).toBe(true); expect(metaOf("main", "claude-opus-4-7")!.caps.images).toBe(true);
    expect(vis("gemini-3.8-flash")).toBe(true); expect(vis("grok-4.20-reasoning")).toBe(false); expect(vis("claude-zz-new")).toBe(false);
  });
  for (const id of ["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.7-flash"]) {
    test(`gemvis1: ${id} is live-proven for images (gemprobe1) so the listing marks vision true; other gemini ids and grok stay gated`, async () => {
      const out = await reg([row(id, 1, 5), row("gemini-3-pro", 1, 5), row("gemini-9-unprobed", 1, 5), row("gemini-3.7-flash-x", 1, 5), row("grok-4.20-reasoning", 1, 5)]).models();
      const vis = (m: string) => (out as any[]).find((x) => x.id === m)?.capabilities?.vision;
      expect(vis(id)).toBe(true); expect(metaOf("main", id)!.caps.images).toBe(true);
      expect(vis("gemini-3-pro")).toBe(false); expect(vis("gemini-9-unprobed")).toBe(false); expect(vis("gemini-3.7-flash-x")).toBe(false); expect(vis("grok-4.20-reasoning")).toBe(false);
    });
  }
  test("gemvis1: the per-image cap stays below the 8.8 MB PNG the gateway silently did not see", async () => {
    const { MAX_IMAGE_BYTES } = await import("../src/files");
    expect(MAX_IMAGE_BYTES).toBeLessThanOrEqual(5 * 1024 * 1024);
  });
  test("geminifix1: a gateway gemini-* model with no stated maxTokens gets 16000 (hidden thinking counts against maxOutputTokens; 4096 ended MAX_TOKENS with no text); a stated value wins; non-gemini keeps the default", async () => {
    await reg([row("gemini-zz-1", 1, 5), { ...row("gemini-zz-2", 1, 5), maxTokens: 8000 }, row("zz-other-1", 1, 5)]).models();
    expect(metaOf("main", "gemini-zz-1")!.maxTokens).toBe(GEMINI_GATEWAY_MAX_TOKENS);
    expect(GEMINI_GATEWAY_MAX_TOKENS).toBe(16000);
    expect(metaOf("main", "gemini-zz-2")!.maxTokens).toBe(8000);
    expect(metaOf("main", "zz-other-1")!.maxTokens).toBe(DEFAULT_PROVIDER_MAX_TOKENS);
  });
  test("a catalog that no longer prices / lists the model removes it (no stale price); a curated entry is never touched", async () => {
    await reg([row("zz-catalog-2", 1, 5)]).models();
    await reg([{ id: "zz-catalog-2", displayName: "zz" }]).models(); // listed, nothing stated
    expect(metaOf("main", "zz-catalog-2")).toBeUndefined();
    await reg([row("zz-catalog-3", 1, 5)]).models();
    await reg([]).models(); // gone from the catalog
    expect(metaOf("main", "zz-catalog-3")).toBeUndefined();
    const curated = MODELS_META["claude-sonnet-5-5"];
    await reg([row("claude-sonnet-5-5", 99, 99)]).models();
    await reg([{ id: "claude-sonnet-5-5", displayName: "s" }]).models();
    expect(MODELS_META["claude-sonnet-5-5"]).toBe(curated);
    expect(metaOf("main", "claude-sonnet-5-5")).toBe(curated);
  });
  test("two scopes, same id, different prices: each reads its own; one scope's listing never overwrites or deletes the other's", async () => {
    await teamReg([row("zz-catalog-4", 3, 7)], TEAM_A).models();
    await teamReg([row("zz-catalog-4", 4, 8)], TEAM_B).models();
    await reg([row("zz-catalog-4", 5, 9)], "main").models();
    expect(metaOf(TEAM_A, "zz-catalog-4")!.price).toMatchObject({ input: 3, output: 7 });
    expect(metaOf(TEAM_B, "zz-catalog-4")!.price).toMatchObject({ input: 4, output: 8 });
    expect(metaOf("main", "zz-catalog-4")!.price).toMatchObject({ input: 5, output: 9 });
    await reg([{ id: "zz-catalog-4", displayName: "zz" }], "main").models(); // main drops its price...
    expect(metaOf("main", "zz-catalog-4")).toBeUndefined();
    expect(metaOf(TEAM_A, "zz-catalog-4")!.price).toMatchObject({ input: 3, output: 7 }); // ...the teams keep theirs
    expect(metaOf(TEAM_B, "zz-catalog-4")!.price).toMatchObject({ input: 4, output: 8 });
    expect(metaOf(null, "zz-catalog-4")).toBeUndefined(); // no scope => curated only
    const listed = (await teamReg([row("zz-catalog-4", 6, 6)], TEAM_A).models()).find((m) => m.id === "zz-catalog-4")!;
    expect(listed.meta!.price).toMatchObject({ input: 6, output: 6 }); // the listing's own result is the scope's, not another's
    expect(metaOf(TEAM_B, "zz-catalog-4")!.price).toMatchObject({ input: 4, output: 8 });
  });
  test("a stale concurrent listing cannot restore old data", async () => {
    const g = gate();
    const slow = { name: "g", listModels: async () => { await g.p; return [row("zz-catalog-5", 1, 1)]; }, messages: async () => new Response("") } as any; // started first, finishes last (old price)
    const first = buildRegistry({ scope: "main", gateway: slow, env: {} } as any).models();
    await Promise.resolve();
    await reg([row("zz-catalog-5", 2, 2)], "main").models(); // newer listing completes first
    g.go();
    const staleResult = await first;
    expect(metaOf("main", "zz-catalog-5")!.price).toMatchObject({ input: 2, output: 2 });
    expect(staleResult.find((m) => m.id === "zz-catalog-5")!.meta!.price).toMatchObject({ input: 2, output: 2 });
  });
});
