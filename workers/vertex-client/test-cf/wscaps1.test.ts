import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../server/worker";
import { makeSession } from "../src/auth";
import { clearEntitlementCache } from "../src/providers/team-gateway";

// wscaps1 in workerd (real D1 + DeviceHub): team users (g:*) may link ONE device only when `vcl:<base>`='1'; isolation between scopes; the vcl bridge never uses GATEWAY_KEY for a g:* device.
const e = env as any;
const ORIGIN = "https://app.test", GWKEY = "GW-KEY-SECRET-FAKE", CALLER = "CALLER-KEY-FAKE";
const UA = "aaaaaaaaaaaaaaaaaaaaaaaa", UB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const GA = `g:${UA}`, GB = `g:${UB}`;
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
const settle = async () => { while (pending.length) await pending.shift(); await new Promise((r) => setTimeout(r, 20)); while (pending.length) await pending.shift(); };

let gwSeen: string[] = [], teamSeen: Array<{ path: string; auth: string | null; actAs: string | null; apiKey: string | null }> = [];
let features: string[] = ["vclient_app", "chat"];
const gwBinding = { fetch: async (url: string) => { gwSeen.push(url); return new Response("x", { status: 500 }); } };
const call = (req: Request, over: Record<string, unknown> = {}) => worker.fetch(req, { ...e, GATEWAY: gwBinding, GATEWAY_KEY: GWKEY, ...over }, ctx);
const setFlag = (name: string, v: string) => e.DB.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(name, v).run();
const teamUser = (uid: string, email: string, status = "active") => e.DB.prepare(`INSERT OR REPLACE INTO team_users (uid, gateway_uid, email, status, created_at, last_login_at) VALUES (?,?,?,?,1,1)`).bind(uid, "gw-" + uid, email, status).run();
const teamCookie = async (uid: string, email: string) => { const s = await makeSession(e, email, "team", 3600, uid); return { cookie: s.cookie.split(";")[0], csrf: s.session.csrf }; };
const mainCookie = async () => { const s = await makeSession(e, "example-user", "github"); return { cookie: s.cookie.split(";")[0], csrf: s.session.csrf }; };
type Me = { cookie: string; csrf: string };
const api = (me: Me, method: string, path: string, body?: unknown) => call(new Request(ORIGIN + path, { method, headers: { cookie: me.cookie, origin: ORIGIN, "x-csrf-token": me.csrf, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }));
const mkCode = async (me: Me, body?: unknown) => api(me, "POST", "/api/devices/pair", body);
const redeem = (code: string, ip = "203.0.113." + Math.floor(Math.random() * 250)) => call(new Request(ORIGIN + "/device/pair", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ code, name: "box" }) }));
async function link(me: Me) { const p = await mkCode(me); expect(p.status).toBe(201); const r = await redeem(((await p.json()) as any).code); expect(r.status).toBe(201); return (await r.json()) as { deviceId: string; token: string }; }
const llm = (token: string, over: Record<string, unknown> = {}) => call(new Request(ORIGIN + "/bridge/llm/v1/messages", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] }) }), over);
const sseBody = `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;

beforeAll(() => { e.TEAM_GATEWAY_URL = "https://tg.test"; e.VCLIENT_TEAM_CALLER_KEY = CALLER; });
afterAll(() => { delete e.TEAM_GATEWAY_URL; delete e.VCLIENT_TEAM_CALLER_KEY; });
beforeEach(async () => {
  gwSeen = []; teamSeen = []; features = ["vclient_app", "chat"]; clearEntitlementCache();
  for (const t of ["devices", "device_pairings", "device_pair_fails", "settings", "cloud_costs", "team_users"]) await e.DB.prepare(`DELETE FROM ${t}`).run();
  await teamUser(UA, "ann@example.com"); await teamUser(UB, "bob@example.com");
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const u = new URL(String(input)), h = new Headers(init.headers);
    teamSeen.push({ path: u.pathname, auth: h.get("authorization"), actAs: h.get("x-act-as"), apiKey: h.get("x-api-key") });
    if (u.pathname === "/v1/entitlements") return Response.json({ features });
    if (u.pathname === "/v1/messages") return new Response(sseBody, { headers: { "content-type": "text/event-stream" } });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("C2: team devices, default OFF, max one", () => {
  it("flag absent: every devices route is a plain 404 for a team user (nothing changed)", async () => {
    const a = await teamCookie(UA, "ann@example.com");
    expect((await mkCode(a)).status).toBe(404); expect((await api(a, "GET", "/api/devices")).status).toBe(404);
  });
  it("flag on for A only: A can link, B and main still 404", async () => {
    await setFlag(`vcl:${GA}`, "1");
    const a = await teamCookie(UA, "ann@example.com"), b = await teamCookie(UB, "bob@example.com");
    expect((await mkCode(b)).status).toBe(404); expect((await api(b, "GET", "/api/devices")).status).toBe(404);
    expect((await api(await mainCookie(), "GET", "/api/devices")).status).toBe(404); // main has no vcl:main row either
    expect((await mkCode(a)).status).toBe(201);
  });
  it("a second device is refused with 409 device_limit at code creation and at redemption; revoking frees the slot", async () => {
    await setFlag(`vcl:${GA}`, "1");
    const a = await teamCookie(UA, "ann@example.com");
    const spare = await mkCode(a); const spareCode = ((await spare.json()) as any).code; // minted while the slot was still free
    const d1 = await link(a);
    const second = await mkCode(a);
    expect(second.status).toBe(409); const j = (await second.json()) as any; expect(j.error).toBe("device_limit"); expect(j.message).toMatch(/only one device/i);
    const red = await redeem(spareCode); expect(red.status).toBe(409); expect(((await red.json()) as any).error).toBe("device_limit");
    expect((await e.DB.prepare(`SELECT COUNT(*) n FROM devices WHERE scope=? AND revoked_at IS NULL`).bind(GA).first()).n).toBe(1);
    expect((await api(a, "DELETE", `/api/devices/${d1.deviceId}`)).status).toBe(200);
    const again = await redeem(spareCode); expect(again.status).toBe(201); // the refused redemption gave the code back
  });
  it("two racing redemptions cannot both take the single slot", async () => {
    await setFlag(`vcl:${GA}`, "1");
    const a = await teamCookie(UA, "ann@example.com");
    const codes: string[] = [];
    for (let i = 0; i < 2; i++) { const p = await mkCode(a); expect(p.status).toBe(201); codes.push(((await p.json()) as any).code); }
    const rs = await Promise.all(codes.map((c, i) => redeem(c, "198.51.100." + (i + 1))));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await e.DB.prepare(`SELECT COUNT(*) n FROM devices WHERE scope=? AND revoked_at IS NULL`).bind(GA).first()).n).toBe(1);
  });
  it("main keeps its own limit (10), unaffected by team scopes; Open space never links", async () => {
    await setFlag("vcl:main", "1"); await setFlag(`vcl:${GA}`, "1");
    const m = await mainCookie(), a = await teamCookie(UA, "ann@example.com");
    await link(a);
    await link(m); await link(m); // main can have several while a team account is full
    expect((await e.DB.prepare(`SELECT COUNT(*) n FROM devices WHERE scope='main' AND revoked_at IS NULL`).first()).n).toBe(2);
    const open = await call(new Request(ORIGIN + "/api/devices", { headers: { cookie: a.cookie, "x-vc-space": "open" } }));
    expect(open.status).toBe(404);
  });
  it("isolation: a g:A device is invisible to and undrivable by g:B and main; the hub is pinned to its owner", async () => {
    await setFlag(`vcl:${GA}`, "1"); await setFlag(`vcl:${GB}`, "1"); await setFlag("vcl:main", "1");
    const a = await teamCookie(UA, "ann@example.com"), b = await teamCookie(UB, "bob@example.com"), m = await mainCookie();
    const da = await link(a);
    for (const who of [b, m]) {
      expect(((await (await api(who, "GET", "/api/devices")).json()) as any).devices).toEqual([]);
      expect((await api(who, "DELETE", `/api/devices/${da.deviceId}`)).status).toBe(404);
      const ws = await call(new Request(`${ORIGIN}/api/devices/${da.deviceId}/session`, { headers: { cookie: who.cookie, upgrade: "websocket", origin: ORIGIN } }));
      expect(ws.status).toBe(404);
    }
    expect(((await (await api(a, "GET", "/api/devices")).json()) as any).devices.map((d: any) => d.id)).toEqual([da.deviceId]);
    // B's own link is independent of A's slot
    const db_ = await link(b); expect(db_.deviceId).not.toBe(da.deviceId);
  });
});

describe("C4: a g:* device never reaches GATEWAY_KEY", () => {
  it("goes through the team gateway as the owner (act-as + caller key, no x-api-key), GATEWAY binding untouched, cost on the g scope", async () => {
    await setFlag(`vcl:${GA}`, "1");
    const d = await link(await teamCookie(UA, "ann@example.com"));
    const r = await llm(d.token); expect(r.status).toBe(200); await r.text(); await settle();
    expect(gwSeen).toEqual([]);
    const m = teamSeen.filter((s) => s.path === "/v1/messages"); expect(m).toHaveLength(1);
    expect(m[0].auth).toBe(`Bearer ${CALLER}`); expect(m[0].actAs).toBe("ann@example.com"); expect(m[0].apiKey).toBeNull();
    expect(JSON.stringify(teamSeen)).not.toContain(GWKEY);
    const rows = (await e.DB.prepare(`SELECT scope FROM cloud_costs WHERE executor='vcl'`).all()).results as any[]; expect(rows.map((x) => x.scope)).toEqual([GA]);
  });
  it("team gateway not configured => 503, GATEWAY never called", async () => {
    await setFlag(`vcl:${GA}`, "1");
    const d = await link(await teamCookie(UA, "ann@example.com"));
    const r = await llm(d.token, { TEAM_GATEWAY_URL: undefined, VCLIENT_TEAM_CALLER_KEY: undefined });
    expect(r.status).toBe(503); expect(gwSeen).toEqual([]); expect(teamSeen.filter((s) => s.path === "/v1/messages")).toEqual([]);
  });
  it("disabled team user / missing chat entitlement => refused, nothing sent anywhere", async () => {
    await setFlag(`vcl:${GA}`, "1");
    const d = await link(await teamCookie(UA, "ann@example.com"));
    await teamUser(UA, "ann@example.com", "disabled");
    expect((await llm(d.token)).status).toBe(403);
    await teamUser(UA, "ann@example.com"); features = ["vclient_app"]; clearEntitlementCache();
    expect((await llm(d.token)).status).toBe(403);
    expect(gwSeen).toEqual([]); expect(teamSeen.filter((s) => s.path === "/v1/messages")).toEqual([]);
  });
  it("main device still uses GATEWAY_KEY exactly as before", async () => {
    await setFlag("vcl:main", "1");
    const seen: Array<Record<string, string>> = [];
    const gw = { fetch: async (_u: string, init: any) => { seen.push({ ...init.headers }); return new Response(sseBody, { headers: { "content-type": "text/event-stream" } }); } };
    const d = await link(await mainCookie());
    const r = await llm(d.token, { GATEWAY: gw }); expect(r.status).toBe(200); await r.text(); await settle();
    expect(seen).toHaveLength(1); expect(seen[0]["x-api-key"]).toBe(GWKEY);
  });
});
