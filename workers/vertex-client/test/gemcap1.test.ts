// gemcap1: the gateway catalog's capabilities.images_in decides image support for bare gateway ids; the old verified list is a fallback only.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, __resetSharedMeta, __sharedMetaSize, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { gatewayProvider } from "../src/providers/gateway";
import { buildRegistry } from "../src/providers/registry";
import { GATEWAY_VISION_VERIFIED } from "../src/models-meta";
import { imageCapFor, imageTooLargeMessage } from "../src/files";

const sse = () => {
  const evs: ServerEvent[] = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
};
const MB = 1024 * 1024;
const img = (size: number) => ({ ref: "vertex-client/conv-1/a.png", name: "a.png", mime: "image/png", size });
const __resetSharedMetaOnce = (keep?: boolean) => { if (!keep) __resetSharedMeta(); };
type Row = { id: string; images_in?: boolean };
function rig(catalog: Row[] | "fail" | "hang", o: { scope?: string; clock?: { t: number }; keep?: boolean; lateScope?: "resolver" | "inLoad" } = {}) {
  __resetSharedMetaOnce(o.keep);
  const cat = { v: catalog };
  const db = new Database(":memory:"); const bodies: any[] = []; let fetches = 0;
  const fetcher = { fetch: async () => { fetches++; if (cat.v === "fail") return new Response("boom", { status: 500 }); if (cat.v === "hang") return new Promise<Response>(() => {});
    return Response.json({ data: (cat.v as Row[]).map((c) => ({ id: c.id, display_name: c.id, ...(c.images_in === undefined ? { capabilities: { tools: true } } : { capabilities: { images_in: c.images_in, tools: true } }) })) }); } };
  const sc = o.scope ?? (Array.isArray(catalog) ? "main" : "e2e"); // gateway scopes only; failures use e2e, which no test ever lists into, so no stale metas
  const reg = buildRegistry({ scope: sc as any, gateway: gatewayProvider(fetcher as any, "k"), env: {} });
  let cur: string | null = o.lateScope ? null : sc;
  const provider = { name: "stub", listModels: async () => [], messages: async (b: any) => { if (b.stream === false) return Response.json({ content: [{ type: "text", text: "T" }], usage: { input_tokens: 1, output_tokens: 1 } }); bodies.push(b); return sse(); } } as any;
  const index: IndexSink = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
  const engine = new ChatEngine({
    sql: { exec: (q: string, ...b: unknown[]) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: () => {} }, retryDelayMs: 1, preflightMs: 80, ...(o.clock ? { now: () => o.clock!.t } : {}),
    files: { get: async () => new Uint8Array(1), size: async () => 1 }, metaScope: () => cur,
    ...(o.lateScope === "resolver" ? { resolveMetaScope: async () => (cur = sc) } : {}),
    loadMetas: async () => { if (o.lateScope === "inLoad") cur = sc; await reg.models(); },
  } as any);
  engine.setConvId("conv-1");
  return { engine, bodies, fetches: () => fetches, cat };
}

describe("gemcap1 catalog images_in is the source of truth for bare ids", () => {
  test("images_in true for a Gemini id NOT in the fallback list -> allowed", async () => {
    expect(GATEWAY_VISION_VERIFIED.has("gemini-9-new")).toBe(false);
    const r = rig([{ id: "gemini-9-new", images_in: true }]);
    expect((await r.engine.send("look", "gemini-9-new", [img(1)])).ok).toBe(true);
    await Bun.sleep(30); expect(r.bodies[0].messages[0].content[0]).toMatchObject({ type: "image" });
    expect(r.fetches()).toBe(1);
  });
  test("images_in false for an id in the fallback list -> refused up front", async () => {
    expect(GATEWAY_VISION_VERIFIED.has("gemini-3.8-flash")).toBe(true);
    const r = rig([{ id: "gemini-3.8-flash", images_in: false }]);
    const x = await r.engine.send("look", "gemini-3.8-flash", [img(1)]);
    expect(x.ok).toBe(false); expect(r.bodies.length).toBe(0);
  });
  test("field absent -> fallback list decides (verified allowed, unlisted refused)", async () => {
    const r = rig([{ id: "gemini-3.7-flash" }, { id: "gemini-9-absent" }]); // distinct ids per test: main-scope metas are module-global and ensureMeta skips a known id
    expect((await r.engine.send("look", "gemini-3.7-flash", [img(1)])).ok).toBe(true);
    await Bun.sleep(30);
    const r2 = rig([{ id: "gemini-3.7-flash" }, { id: "gemini-9-absent" }]);
    expect((await r2.engine.send("look", "gemini-9-absent", [img(1)])).ok).toBe(false);
  });
});

describe("gemcap1 4 MB cap covers bare grok chat ids, Claude unchanged", () => {
  test("predicate", () => {
    expect(imageCapFor("grok-4.20-reasoning")).toBe(4 * MB);
    expect(imageCapFor("claude-sonnet-5-5")).toBe(5 * MB);
    expect(imageCapFor("claude-opus-5")).toBe(5 * MB);
    expect(imageCapFor("nvidia:grok-x")).toBe(5 * MB);
    expect(imageTooLargeMessage("grok-4.20-reasoning")).toContain("max 4 MB");
  });
  test("grok 4.5 MB refused with the clear message, claude 4.5 MB fine", async () => {
    const size = Math.round(4.5 * MB);
    const r = rig([{ id: "grok-4.20-reasoning", images_in: true }, { id: "claude-sonnet-5-5", images_in: true }]);
    const x = await r.engine.send("look", "grok-4.20-reasoning", [img(size)]);
    expect(x).toEqual({ ok: false, error: "image too large for this model (max 4 MB after resizing)" });
    expect(r.bodies.length).toBe(0);
    expect((await r.engine.send("look", "claude-sonnet-5-5", [img(size)])).ok).toBe(true);
  });
});

describe("gemcap1 catalog failure never blocks a send", () => {
  test("catalog 500 -> fallback list, verified id proceeds", async () => {
    const r = rig("fail");
    expect((await r.engine.send("look", "gemini-3.8-flash", [img(1)])).ok).toBe(true);
    expect(r.fetches()).toBe(1);
  });
  test("catalog hangs -> bounded wait, fallback list, verified id proceeds; unverified id gets the clean retry message", async () => {
    const r = rig("hang");
    const t0 = Date.now();
    expect((await r.engine.send("look", "gemini-3.8-flash", [img(1)])).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    const r2 = rig("hang");
    expect(await r2.engine.send("look", "gemini-9-new", [img(1)])).toEqual({ ok: false, error: "Could not load the model capabilities. Try again." });
  });
  test("text-only send with a failing catalog is unaffected", async () => {
    const r = rig("fail");
    expect((await r.engine.send("hello", "claude-sonnet-5-5")).ok).toBe(true);
  });
});

describe("gemcap2 review blockers", () => {
  test("1 cached images_in=false is refreshed after the freshness interval (false -> true allows the next image send)", async () => {
    const clock = { t: 1_000_000 };
    const r = rig([{ id: "gemini-fresh-1", images_in: false }], { clock });
    expect((await r.engine.send("look", "gemini-fresh-1", [img(1)])).ok).toBe(false);
    r.cat.v = [{ id: "gemini-fresh-1", images_in: true }];
    clock.t += 120_000;
    expect((await r.engine.send("look", "gemini-fresh-1", [img(1)])).ok).toBe(true);
  });
  test("2 cold engine + failing catalog + verified id: the image block reaches the provider", async () => {
    const r = rig("fail");
    expect((await r.engine.send("look", "gemini-3.8-flash", [img(1)])).ok).toBe(true);
    await Bun.sleep(30);
    expect(r.bodies[0].messages[0].content.some((b: any) => b.type === "image")).toBe(true);
  });
  test("3 hanging catalog: exactly one fetch per send and one preflight wait", async () => {
    const r = rig("hang");
    const t0 = Date.now();
    await r.engine.send("look", "gemini-9-hang", [img(1)]);
    expect(r.fetches()).toBe(1);
    expect(Date.now() - t0).toBeLessThan(150);
  });
});

describe("gemcap3 shared per-scope catalog refresh", () => {
  const engines = (cat: Row[] | "fail" | "hang", scopes: string[]) => {
    const rs = scopes.map((sc, i) => rig(cat, { scope: sc, keep: i > 0 }));
    return { rs, total: () => rs.reduce((a, r) => a + r.fetches(), 0) };
  };
  test("two concurrent image sends in the same scope -> exactly 1 GET", async () => {
    const e = engines([{ id: "gemini-shared-1", images_in: true }], ["main", "main"]);
    const [a, b] = await Promise.all(e.rs.map((r) => r.engine.send("look", "gemini-shared-1", [img(1)])));
    expect(a.ok && b.ok).toBe(true); expect(e.total()).toBe(1);
  });
  test("main vs e2e scope are independent (one GET each)", async () => {
    const e = engines([{ id: "gemini-shared-2", images_in: true }], ["main", "e2e"]);
    await Promise.all(e.rs.map((r) => r.engine.send("look", "gemini-shared-2", [img(1)])));
    expect(e.rs[0].fetches()).toBe(1); expect(e.rs[1].fetches()).toBe(1);
  });
  test("a failure in one engine suppresses the other's fetch (negative cache shared)", async () => {
    const e = engines("fail", ["e2e", "e2e"]);
    await e.rs[0].engine.send("look", "gemini-3.8-flash", [img(1)]);
    await e.rs[1].engine.send("look", "gemini-3.8-flash", [img(1)]);
    expect(e.total()).toBe(1);
  });
  test("fresh load by one engine suppresses the other's refresh", async () => {
    const clock = { t: 5_000_000 };
    const e = [rig([{ id: "gemini-shared-3", images_in: true }], { scope: "main", clock }), rig([{ id: "gemini-shared-3", images_in: true }], { scope: "main", clock, keep: true })];
    await e[0].engine.send("look", "gemini-shared-3", [img(1)]);
    clock.t += 30_000;
    await e[1].engine.send("look", "gemini-shared-3", [img(1)]);
    expect(e[0].fetches() + e[1].fetches()).toBe(1);
  });
  test("hang: two concurrent sends -> 1 fetch, one wait", async () => {
    const e = engines("hang", ["e2e", "e2e"]);
    const t0 = Date.now();
    await Promise.all(e.rs.map((r) => r.engine.send("look", "gemini-9-hang2", [img(1)])));
    expect(e.total()).toBe(1); expect(Date.now() - t0).toBeLessThan(150);
  });
});

describe("gemcap3 curated Claude precedence (PO decision)", () => {
  test("catalog images_in:false never overrides a curated Claude id: image admitted and sent", async () => {
    const r = rig([{ id: "claude-sonnet-5-5", images_in: false }]);
    expect((await r.engine.send("look", "claude-sonnet-5-5", [img(1)])).ok).toBe(true);
    await Bun.sleep(30);
    expect(r.bodies[0].messages[0].content.some((b: any) => b.type === "image")).toBe(true);
  });
});

describe("gemcap4 late-resolving scope + bounded sharedMeta", () => {
  test("two initially-null engines (resolver) resolving to the same scope -> 1 GET", async () => {
    const a = rig([{ id: "gemini-late-1", images_in: true }], { scope: "main", lateScope: "resolver" });
    const b = rig([{ id: "gemini-late-1", images_in: true }], { scope: "main", lateScope: "resolver", keep: true });
    const [x, y] = await Promise.all([a, b].map((r) => r.engine.send("look", "gemini-late-1", [img(1)])));
    expect(x.ok && y.ok).toBe(true); expect(a.fetches() + b.fetches()).toBe(1);
  });
  test("hang + scope resolved only inside loadMetas: one send = one fetch (timeout stays negatively cached into runTurn)", async () => {
    const r = rig("hang", { scope: "e2e", lateScope: "inLoad" });
    expect((await r.engine.send("look", "gemini-3.8-flash", [img(1)])).ok).toBe(true);
    await Bun.sleep(150);
    expect(r.fetches()).toBe(1);
  });
  test("resolver path: hang -> one fetch for the whole send", async () => {
    const r = rig("hang", { scope: "e2e", lateScope: "resolver" });
    expect((await r.engine.send("look", "gemini-3.8-flash", [img(1)])).ok).toBe(true);
    await Bun.sleep(150);
    expect(r.fetches()).toBe(1);
  });
  test(">256 scopes -> sharedMeta size bounded", async () => {
    __resetSharedMeta();
    for (let i = 0; i < 300; i++) { const r = rig([{ id: "gemini-prune", images_in: true }], { scope: `tenant-${i}`, keep: true }); await r.engine.send("x", "gemini-prune", [img(1)]).catch(() => {}); }
    expect(__sharedMetaSize()).toBeLessThanOrEqual(256);
  });
});
