// Idempotent generation usage rows (migration 0011): the dispatch marker is cleared only after the insert succeeded, recovery is
// idempotent on the dispatch id. Real SQL (bun:sqlite + real migrations) behind the real d1Index.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { ChatEngine, type IndexSink } from "../src/turn-engine";
import { d1Index } from "../src/index-d1";
import type { ModelProvider, VideoResult } from "../src/providers/types";
import { STUB_MP4_B64 } from "../src/providers/stub-video";
import { STUB_PNG_B64 } from "../src/providers/stub-image";
import type { FileStore } from "../src/files";

const CONV = "conv-d";
const OMNI = "gemini-omni-1.1-flash-preview";
const IMG = "gemini-3.1-flash-image";
const MIGS = ["0001_init.sql", "0002_active_turns.sql", "0003_scope.sql", "0004_cloud.sql", "0005_cloud_notify.sql", "0009_usage_generation.sql", "0011_usage_dispatch.sql", "0012_scope_hardening.sql", "0018_projects.sql"];
const okVid = (): VideoResult => ({ model: OMNI, video: { mime_type: "video/mp4", data: STUB_MP4_B64, duration_seconds: 3, resolution: "360p", has_audio: true }, finish_reason: "completed", usage: { input_tokens: 9, output_tokens: 5800 }, cost: { usd: 0.106 } });
const tick = () => new Promise((r) => setTimeout(r, 5));

function world() {
  const d1db = new Database(":memory:"); for (const f of MIGS) d1db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  d1db.query(`INSERT INTO conversations (id, model, title) VALUES (?,?,?)`).run(CONV, "m", "t");
  const d1 = { prepare: (q: string) => { const st = (b: unknown[] = []): any => ({ bind: (...v: unknown[]) => st(v), run: async () => { d1db.query(q).run(...(b as any)); return {}; }, first: async () => (d1db.query(q).get(...(b as any)) as any) ?? null, all: async () => ({ results: d1db.query(q).all(...(b as any)) }) }); return st(); } } as unknown as D1Database;
  const real = d1Index(d1);
  const ctl = { fail: false, calls: 0 };
  const index: IndexSink = { ...real, recordUsage: async (u) => { ctl.calls++; if (ctl.fail) throw new Error("D1 down"); return real.recordUsage(u); } };
  const rows = () => d1db.query(`SELECT kind, units, cost_usd, est_usd, dispatch_id FROM usage`).all() as any[];
  const doDb = new Database(":memory:");
  const rig = (video: () => Promise<VideoResult> | VideoResult, idx: IndexSink = index) => {
    const provider: ModelProvider = { name: "stub", listModels: async () => [], messages: async () => Response.json({}),
      image: async () => ({ model: "x", images: [{ mime_type: "image/png", data: STUB_PNG_B64 }], text: null, finish_reason: "STOP", cost: { usd: 0.04 } }), video: async () => video() };
    const store = new Map<string, Uint8Array>();
    const files: FileStore = { size: async () => null, get: async (k) => store.get(k) ?? null, put: async (k, b) => { store.set(k, b); }, delete: async () => {} };
    const engine = new ChatEngine({ sql: { exec: (q, ...b) => { const st = doDb.query(q); const r = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => r as any[] }; } },
      provider, index: idx, files, sink: { broadcast: () => {} }, retryDelayMs: 1 });
    engine.setConvId(CONV);
    return engine;
  };
  return { ctl, index, rows, rig };
}
const KINDS = [
  { name: "video", cmd: { kind: "video", prompt: "a cat", model: OMNI }, est: 0.126 },
  { name: "image", cmd: { kind: "image", prompt: "a cube", model: IMG }, est: 0.045 },
];

for (const k of KINDS) describe(`usage dispatch idempotency (${k.name})`, () => {
  test("normal success path: exactly one row carrying the dispatch id, marker cleared", async () => {
    const w = world(); const e = w.rig(() => okVid());
    await e.generate(k.cmd); await tick();
    const rows = w.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: k.name });
    expect(rows[0].dispatch_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.meta("gen_dispatched")).toBeNull();
  });

  test("insert failure keeps the marker; a later init() inserts exactly once, then nothing more", async () => {
    const w = world(); w.ctl.fail = true;
    const e1 = w.rig(() => okVid());
    expect(await e1.generate(k.cmd)).toEqual({ ok: true }); await tick();
    expect(w.rows()).toHaveLength(0);
    const marker = JSON.parse(e1.meta("gen_dispatched")!);
    expect(marker).toMatchObject({ id: expect.any(String), kind: k.name, est_usd: k.est });
    // recovery itself fails first: marker still kept
    const e2 = w.rig(() => okVid());
    await e2.init();
    expect(w.rows()).toHaveLength(0);
    expect(e2.meta("gen_dispatched")).not.toBeNull();
    w.ctl.fail = false;
    await e2.init();
    expect(w.rows()).toHaveLength(1);
    expect(w.rows()[0]).toMatchObject({ kind: k.name, units: 0, cost_usd: null, est_usd: k.est, dispatch_id: marker.id });
    expect(e2.meta("gen_dispatched")).toBeNull();
    await e2.init();
    expect(w.rows()).toHaveLength(1);
  });

  test("eviction after a successful insert but before the marker clear: recovery inserts nothing new", async () => {
    const w = world();
    const frozen = w.rig(() => okVid(), { ...w.index, recordUsage: async (u) => { await w.index.recordUsage(u); throw new Error("evicted before clear"); } });
    await frozen.generate(k.cmd); await tick();
    expect(w.rows()).toHaveLength(1); // the insert landed
    expect(frozen.meta("gen_dispatched")).not.toBeNull(); // ... but the marker was never cleared
    const e2 = w.rig(() => okVid());
    await e2.init();
    expect(w.rows()).toHaveLength(1);
    expect(e2.meta("gen_dispatched")).toBeNull();
  });
});
