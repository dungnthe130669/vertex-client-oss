import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { approvalEvent, bearerOf, cleanName, codeHash, mintToken, newPairCode, normalizeCode, parseAppFrame, sanitiseRoots, parseDeviceFrame, parseFrame, parseToken, sameOrigin, timingEqual, tokenHash } from "../src/device-core";
import { vclEnabled } from "../src/devices";
import type { Scope } from "../src/scope";

function d1(rows: Record<string, string> = {}) {
  const db = new Database(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  for (const [k, v] of Object.entries(rows)) db.query(`INSERT INTO settings (name, value) VALUES (?, ?)`).run(k, v);
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null } as any);
  return { prepare: (q: string) => stmt(q) } as unknown as D1Database;
}

describe("migration 0038", () => {
  test("applies on top of the whole set, idempotently, and creates the three tables", () => {
    const db = new Database(":memory:");
    const files = readdirSync(new URL("../migrations/", import.meta.url)).sort();
    expect(files.some((f) => f.startsWith("0038_"))).toBe(true);
    for (const f of files) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    db.exec(readFileSync(new URL("../migrations/0038_devices.sql", import.meta.url), "utf8")); // re-run: CREATE IF NOT EXISTS
    const t = (db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'device%'`).all() as { name: string }[]).map((x) => x.name).sort();
    expect(t).toEqual(["device_pair_fails", "device_pairings", "devices"]);
  });
});

describe("vclEnabled (the flag)", () => {
  test("default OFF; only the exact row '1' enables; main and e2e only, Business space only; guests only with their own row, Open never; D1 error / missing DB = off", async () => {
    expect(await vclEnabled(d1(), "main")).toBe(false);
    expect(await vclEnabled(d1({ "vcl:main": "0" }), "main")).toBe(false);
    expect(await vclEnabled(d1({ "vcl:main": "true" }), "main")).toBe(false);
    expect(await vclEnabled(d1({ "vcl:main": "1" }), "main")).toBe(true);
    expect(await vclEnabled(d1({ "vcl:main": "1" }), "e2e")).toBe(false);          // e2e has its own row
    expect(await vclEnabled(d1({ "vcl:e2e": "1" }), "e2e")).toBe(true);
    expect(await vclEnabled(d1({ "vcl:main": "1" }), "main~open" as Scope)).toBe(false);
    const g = "g:abcdef0123456789abcdef09" as Scope;
    expect(await vclEnabled(d1({ "vcl:main": "1" }), g)).toBe(false); // team stays off without its OWN row (main's row never applies)
    expect(await vclEnabled(d1({ [`vcl:${g}`]: "1" }), g)).toBe(true); // wscaps1 C2: a team base may be switched on explicitly (capped at one device in devices.ts)
    expect(await vclEnabled(undefined, "main")).toBe(false);
    expect(await vclEnabled({ prepare: () => { throw new Error("boom"); } } as unknown as D1Database, "main")).toBe(false);
  });
});

describe("codes and tokens", () => {
  test("pairing codes: 8 symbols from the unambiguous alphabet, normalised, junk refused, hash is stable and not the code", async () => {
    for (let i = 0; i < 200; i++) expect(newPairCode()).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(new Set(Array.from({ length: 200 }, newPairCode)).size).toBe(200);
    expect(normalizeCode("abcd-efgh")).toBe("ABCDEFGH"); expect(normalizeCode(" ab cd ef gh ")).toBe("ABCDEFGH");
    for (const bad of ["ABCDEFG", "ABCDEFGHJ", "ABCDEFG0", "ABCDEFGI", "ABCDEFGO", "ABCDEFG1", 12345678, null, undefined, {}]) expect(normalizeCode(bad)).toBeNull();
    expect(await codeHash("ABCDEFGH")).toBe(await codeHash("ABCDEFGH")); expect(await codeHash("ABCDEFGH")).not.toContain("ABCDEFGH");
  });
  test("token: parses back to its device id, differs per mint, hash is hex and differs from the token; malformed values are refused", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const a = mintToken(id), b = mintToken(id);
    expect(a).not.toBe(b); expect(parseToken(a)).toEqual({ deviceId: id });
    expect(await tokenHash(a)).toMatch(/^[0-9a-f]{64}$/); expect(await tokenHash(a)).not.toBe(await tokenHash(b));
    for (const bad of ["", "vcl_", `vcl_${id}`, `vcl_${id}.short`, `xcl_${id}.${"a".repeat(43)}`, `vcl_${id.toUpperCase()}.${"a".repeat(43)}`, "a".repeat(500), null, 5]) expect(parseToken(bad)).toBeNull();
    expect(bearerOf("Bearer abc")).toBe("abc"); expect(bearerOf("bearer abc")).toBeNull(); expect(bearerOf("Bearer a b")).toBeNull(); expect(bearerOf(null)).toBeNull();
    expect(timingEqual("abc", "abc")).toBe(true); expect(timingEqual("abc", "abd")).toBe(false); expect(timingEqual("abc", "ab")).toBe(false);
  });
  test("device names are trimmed, stripped of control chars and bounded", () => {
    expect(cleanName("  my\u0000 laptop\n ")).toBe("my laptop"); expect(cleanName("")).toBeNull(); expect(cleanName("x".repeat(61))).toBeNull(); expect(cleanName(5)).toBeNull();
  });
});

describe("frames", () => {
  test("parseFrame refuses non-JSON, non-objects, a missing t, and oversized frames", () => {
    expect(parseFrame("{nope")).toBeNull(); expect(parseFrame("[]")).toBeNull(); expect(parseFrame('{"x":1}')).toBeNull();
    expect(parseFrame('{"t":"ev"}')).toEqual({ t: "ev" }); expect(parseFrame("x".repeat(300_000))).toBeNull(); expect(parseFrame(new ArrayBuffer(300_000))).toBeNull();
  });
  test("hello info.roots: sanitised; absent stays absent (old vcl); unknown info fields dropped", () => {
    expect((parseDeviceFrame({ t: "hello", lastCseq: 0, info: { name: "n", extra: 1 } }) as any).info).toEqual({ name: "n", version: undefined, self: {} });
    expect((parseDeviceFrame({ t: "hello", lastCseq: 0, info: { roots: [{ label: "a", path: "/a" }, { label: "b", path: "/b\u0001" }] } }) as any).info.roots).toEqual([{ label: "a", path: "/a" }]);
    expect(sanitiseRoots(undefined)).toBeUndefined(); expect(sanitiseRoots({})).toBeUndefined(); expect(sanitiseRoots([])).toEqual([]);
    expect(sanitiseRoots(Array.from({ length: 50 }, (_, i) => ({ label: "x", path: `/p${i}` })))).toHaveLength(20);
    expect(sanitiseRoots([{ label: "", path: "/only" }])).toEqual([{ label: "(folder)", path: "/only" }]);
    expect(sanitiseRoots([{ label: "P\u200blan\u202e", path: "/a/Plan\u200b2026" }, { label: "x", path: "/a/b\nc" }, { label: "x", path: "/a/b\u0000c" }, { label: "x", path: "/a/Plan\u200b2026" }])).toEqual([{ label: "Plan", path: "/a/Plan\u200b2026" }]); // path byte-for-byte or dropped; label cleaned; deduped
    expect(sanitiseRoots([{ label: "x", path: "/" + "a".repeat(299) }])).toHaveLength(1); expect(sanitiseRoots([{ label: "x", path: "/" + "a".repeat(300) }])).toEqual([]);
  });
  test("device frames: strict shapes (dseq starts at 1, integers only, event needs a bounded type)", () => {
    expect(parseDeviceFrame({ t: "hello", lastCseq: 0 })).toMatchObject({ t: "hello", lastCseq: 0 });
    for (const bad of [{ t: "hello" }, { t: "hello", lastCseq: -1 }, { t: "hello", lastCseq: 1.5 }, { t: "ev", dseq: 0, e: { type: "x" } }, { t: "ev", dseq: 1, e: {} }, { t: "ev", dseq: 1, e: { type: "" } }, { t: "ev", dseq: "1", e: { type: "x" } }, { t: "ev", dseq: 1, e: { type: "x".repeat(41) } }, { t: "cack", cseq: "2" }, { t: "other" }]) expect(parseDeviceFrame(bad as any)).toBeNull();
    expect(parseDeviceFrame({ t: "ev", dseq: 7, e: { type: "text", a: 1 } })).toEqual({ t: "ev", dseq: 7, e: { type: "text", a: 1 } });
  });
  test("app frames: only start/say/stop commands with bounded text, approval_res needs rid + boolean, nothing else gets through", () => {
    expect(parseAppFrame({ t: "cmd", cid: "c1", kind: "stop" })).toMatchObject({ kind: "stop" });
    expect(parseAppFrame({ t: "cmd", cid: "c1", kind: "start", prompt: "go", dir: "/x" })).toMatchObject({ body: { prompt: "go", dir: "/x" } });
    for (const bad of [{ t: "cmd", cid: "c1", kind: "kill" }, { t: "cmd", cid: "c1", kind: "say", text: "" }, { t: "cmd", cid: "c1", kind: "say", text: "x".repeat(40000) }, { t: "cmd", cid: "bad id", kind: "stop" }, { t: "cmd", kind: "stop" },
      { t: "approval_res", rid: "r1" }, { t: "approval_res", rid: "r1", allow: "yes" }, { t: "approval_res", rid: "../x", allow: true }, { t: "bogus" }]) expect(parseAppFrame(bad as any)).toBeNull();
    expect(parseAppFrame({ t: "approval_res", rid: "r-1", allow: false })).toEqual({ t: "approval_res", rid: "r-1", allow: false });
  });
  test("approval events: hub sets expiry (daemon cannot), ttl capped, preview bounded, junk refused", () => {
    expect(approvalEvent({ rid: "r1", tool: "Bash", preview: "ls", expires_at: 9e12 }, 1000)).toEqual({ rid: "r1", tool: "Bash", preview: "ls", expires_at: 1300, ttl_s: 300 });
    expect(approvalEvent({ rid: "r1", tool: "Bash", ttl_s: 99999 }, 1000)!.ttl_s).toBe(600);
    expect(approvalEvent({ rid: "r1", tool: "Bash", ttl_s: 30 }, 1000)!.expires_at).toBe(1030);
    expect(approvalEvent({ rid: "r1", tool: "Bash", preview: "x".repeat(9000) }, 0)!.preview.length).toBe(4000);
    expect(approvalEvent({ rid: "", tool: "Bash" }, 0)).toBeNull(); expect(approvalEvent({ rid: "r1", tool: "" }, 0)).toBeNull(); expect(approvalEvent({ rid: "r1" }, 0)).toBeNull();
  });
  test("sameOrigin: equal origin only; missing Origin is refused", () => {
    const r = (o?: string) => new Request("https://app.test/api/devices/x/session", { headers: o ? { origin: o } : {} });
    expect(sameOrigin(r("https://app.test"))).toBe(true); expect(sameOrigin(r("https://evil.test"))).toBe(false); expect(sameOrigin(r("http://app.test"))).toBe(false); expect(sameOrigin(r())).toBe(false);
  });
});

describe("migration 0041 device identity (devv2s2)", () => {
  test("additive only: nullable ADD COLUMNs on devices/device_pairings, nothing dropped, updated or backfilled; applies on top of 0038", async () => {
    const { readFileSync } = await import("node:fs"); const { Database } = await import("bun:sqlite");
    const sql = readFileSync(new URL("../migrations/0041_device_identity.sql", import.meta.url), "utf8"), code = sql.replace(/^--.*$/gm, "");
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|NOT NULL|DEFAULT)\b/i);
    expect([...code.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual(["devices.install_id", "devices.last_online_at", "device_pairings.install_id"]);
    const db = new Database(":memory:"); db.exec(readFileSync(new URL("../migrations/0038_devices.sql", import.meta.url), "utf8"));
    db.exec(`INSERT INTO devices (id,scope,user,name,token_hash,created_at,last_seen) VALUES ('a','main','u','n','h',1,1)`);
    db.exec(sql);
    expect(db.query(`SELECT install_id, last_online_at FROM devices`).get()).toEqual({ install_id: null, last_online_at: null });
  });
});
