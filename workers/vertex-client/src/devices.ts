// VCL device routes (docs/vertex-client-vcl-protocol.md). Flag-gated: settings row `vcl:<base>`='1' enables it for that base, default OFF; the Open space never; a team scope (g:*) only with its own row and then at most ONE live device (wscaps1).
// Every route answers a plain 404 when the feature is off or the DEVICES binding is absent, so a disabled instance does not reveal that the feature exists.
//   session-authenticated (normal /api/* gate, CSRF on writes):  POST /api/devices/pair, GET /api/devices, DELETE /api/devices/:id, WS /api/devices/:id/session
//   device-authenticated (bearer device token, outside /api):       POST /device/pair (redeems a code), WS /device (daemon dial-in)
import type { Context, Hono } from "hono";
import { baseOf, guestUidOfScope, kindCapsOf, type Scope } from "./scope";
import { devicesOn } from "./caps";
import { DEVICE_ID, PAIR_CREATE_PER_WINDOW, PAIR_FAIL_GLOBAL, PAIR_FAIL_PER_IP, PAIR_MAX_OPEN, PAIR_TTL_S, TOKEN_TTL_S, bearerOf, cleanName, codeHash, mintToken, newDeviceId, newPairCode,
  normalizeCode, nowS, parseToken, sameOrigin, sanitiseRoots, sanitiseSelf, sha256, timingEqual, tokenHash } from "./device-core";
import { dailyCapUsd } from "./bridge-llm-core";
import type { Env } from "./index";

type Ctx = Context<{ Bindings: Env; Variables: { session: import("./auth").Session } }>;
type DeviceRow = { id: string; scope: string; user: string; name: string; token_hash: string | null; created_at: number; last_seen: number; revoked_at: number | null; install_id?: string | null; last_online_at?: number | null; space?: string | null };
/** The desktop app's install id: random, not a secret. Anything else (absent, wrong type, odd characters) is treated as no id at all: never an error, never a guess. */
export const INSTALL_ID = /^[A-Za-z0-9_-]{16,64}$/;
const installOf = (v: unknown): string | null => (typeof v === "string" && INSTALL_ID.test(v) ? v : null);
const nf = (c: Context) => c.json({ error: "not found" }, 404);

/** vclspace1: the device's own space. `devices.space` is NULL for rows paired before the column existed (legacy), else exactly "biz" | "open". Anything else parses to null. */
export type DeviceSpace = "biz" | "open";
export const parseDeviceSpace = (v: unknown): DeviceSpace | null => (v === "biz" || v === "open" ? v : null);
/** May this device use the base's OPEN keys/allowance? "open" yes; "biz" never; NULL = legacy device, keeps the vclopen1 behaviour (the per-base flag alone decides).
 *  Anything unreadable or unrecognised = no (fail closed): a missing column (migration not applied) or a corrupt value never grants Open. */
export async function deviceOpenAllowed(db: D1Database, deviceId: string): Promise<boolean> {
  try {
    const r = await db.prepare(`SELECT space FROM devices WHERE id=? AND revoked_at IS NULL`).bind(deviceId).first<{ space: string | null }>();
    if (!r) return false;
    return r.space === null || r.space === "open";
  } catch { return false; }
}

export async function vclEnabled(db: D1Database | undefined, scope: Scope): Promise<boolean> {
  return devicesOn(db, scope); // wscaps1: the kind ceiling + `vcl:<base>`='1' live in caps.ts (main/e2e as before; g:* now possible but default OFF, capped at one device)
}

/** Devices v2 step 3 (device as chat environment): needs the device flag above AND its own row `vcl_env:<base>`='1' (default OFF for everyone, switched on per user/base by the PO). Same fail-closed rules. */
export async function vclEnvEnabled(db: D1Database | undefined, scope: Scope): Promise<boolean> {
  if (!(await vclEnabled(db, scope))) return false;
  const base = baseOf(scope);
  try { return (await db!.prepare(`SELECT value FROM settings WHERE name=?`).bind(`vcl_env:${base}`).first<{ value: string }>())?.value === "1"; } catch { return false; }
}

/** Device terminal (vclterm3): needs the device flag AND its own row `vcl_term:<base>`='1' (default OFF). Same fail-closed rules; independent of `vcl_env`. */
export async function vclTermEnabled(db: D1Database | undefined, scope: Scope): Promise<boolean> {
  if (!(await vclEnabled(db, scope))) return false;
  const base = baseOf(scope);
  try { return (await db!.prepare(`SELECT value FROM settings WHERE name=?`).bind(`vcl_term:${base}`).first<{ value: string }>())?.value === "1"; } catch { return false; }
}

/** Per-device daily soft cap for the model proxy (src/bridge-llm.ts), USD: settings row `vcl_daily_usd:<base>`; missing/garbage => default. */
export async function vclDailyCapUsd(db: D1Database, scope: Scope): Promise<number> {
  const base = baseOf(scope);
  const v = (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`vcl_daily_usd:${base}`).first<{ value: string }>())?.value;
  return dailyCapUsd(v);
}

/** Live-device limit of a scope (kind table). A team scope counts per SCOPE (one account = one slot, whoever the user string is); main/e2e keep the old per-(scope,user) count. */
const limitOf = (scope: string) => kindCapsOf(scope as Scope).devicesMax;
const guestScope = (scope: string) => guestUidOfScope(scope as Scope) !== null;
const liveWhere = (scope: string) => (guestScope(scope) ? `scope=? AND revoked_at IS NULL` : `scope=? AND user=? AND revoked_at IS NULL`);
const liveBind = (scope: string, user: string) => (guestScope(scope) ? [scope] : [scope, user]);
const limitReply = (c: Context, scope: string, mainMsg: string) => guestScope(scope)
  ? c.json({ error: "device_limit", message: "A team account can link only one device. Remove the linked device first, then link this one." }, 409)
  : c.json({ error: mainMsg }, 409);

export function devicesRoutes(app: Hono<{ Bindings: Env; Variables: { session: import("./auth").Session } }>, scopeOf: (c: Ctx) => Scope) {
  const actor = (c: Ctx) => c.get("session").u;
  const hubOf = (env: Env, id: string) => env.DEVICES!.get(env.DEVICES!.idFromName(id));
  const hubHeaders = (r: { id: string; scope: string; user: string }, extra: Record<string, string> = {}) => ({ "x-vcl-device": r.id, "x-vcl-scope": r.scope, "x-vcl-user": r.user, ...extra });
  const rewrap = (r: Response) => (r.status === 101 ? new Response(null, { status: 101, webSocket: (r as { webSocket?: WebSocket }).webSocket }) : r); // the DO's 101 headers are immutable

  // ---- session-authenticated ----
  const gate = async (c: Ctx, next: () => Promise<void>) => (c.env.DEVICES && (await vclEnabled(c.env.DB, scopeOf(c))) ? next() : nf(c));
  app.use("/api/devices", gate as never); app.use("/api/devices/*", gate as never);

  const owned = (c: Ctx, id: string) => (DEVICE_ID.test(id)
    ? c.env.DB.prepare(`SELECT id, scope, user, name, token_hash, created_at, last_seen, revoked_at FROM devices WHERE id=? AND scope=? AND user=? AND revoked_at IS NULL`).bind(id, scopeOf(c), actor(c)).first<DeviceRow>()
    : Promise.resolve(null));

  app.post("/api/devices/pair", async (c) => {
    const db = c.env.DB, scope = scopeOf(c), user = actor(c), t = nowS();
    try {
      await db.prepare(`DELETE FROM device_pairings WHERE expires_at < ?`).bind(t - 3600).run();
      const win = await db.prepare(`SELECT COUNT(*) AS n FROM device_pairings WHERE scope=? AND user=? AND created_at > ?`).bind(scope, user, t - PAIR_TTL_S).first<{ n: number }>();
      if ((win?.n ?? 0) >= PAIR_CREATE_PER_WINDOW) return c.json({ error: "too many pairing codes, wait a few minutes" }, 429, { "retry-after": String(PAIR_TTL_S) });
      const open = await db.prepare(`SELECT COUNT(*) AS n FROM device_pairings WHERE scope=? AND user=? AND used_at IS NULL AND expires_at > ?`).bind(scope, user, t).first<{ n: number }>();
      if ((open?.n ?? 0) >= PAIR_MAX_OPEN) return c.json({ error: "too many unused pairing codes" }, 429);
      const live = await db.prepare(`SELECT COUNT(*) AS n FROM devices WHERE ${liveWhere(scope)}`).bind(...liveBind(scope, user)).first<{ n: number }>();
      if ((live?.n ?? 0) >= limitOf(scope)) return limitReply(c, scope, "device limit reached, revoke one first");
      const code = newPairCode();
      const body = ((await c.req.json().catch(() => ({}))) as { install_id?: unknown; space?: unknown } | null) ?? {};
      const spc = parseDeviceSpace(body.space) ?? "biz"; // vclspace1: a new device is Business unless the minting user says "open"; an unknown value is refused, never coerced
      if (body.space !== undefined && parseDeviceSpace(body.space) === null) return c.json({ error: "space must be biz or open" }, 400);
      const install = installOf(body.install_id); // only "Add this device" in the desktop shell sends it: a code shown for another computer carries none
      await db.prepare(`INSERT INTO device_pairings (code_hash, scope, user, created_at, expires_at, install_id, space) VALUES (?,?,?,?,?,?,?)`).bind(await codeHash(code), scope, user, t, t + PAIR_TTL_S, install, spc).run();
      return c.json({ code, display: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: t + PAIR_TTL_S, ttl_s: PAIR_TTL_S }, 201, { "cache-control": "no-store" });
    } catch (e) { console.error("devices pair", e instanceof Error ? e.message : String(e)); return c.json({ error: "devices unavailable" }, 503); }
  });

  app.get("/api/devices", async (c) => {
    try {
      const { results } = await c.env.DB.prepare(`SELECT id, scope, user, name, token_hash, created_at, last_seen, revoked_at, install_id, last_online_at FROM devices WHERE scope=? AND user=? AND revoked_at IS NULL ORDER BY created_at, rowid`).bind(scopeOf(c), actor(c)).all<DeviceRow>();
      // "This device": the header must be a well-formed id AND equal a row's install_id (NULL never matches). Rows are this caller's own (scope+user above), so a forged header can only match their own pairings.
      // Several rows from one install = re-pairs: only the newest is this device, the older ones are stale. Rows are ordered (created_at, rowid), so the LAST match is the newest even for two pairings in the same second.
      const mine = installOf(c.req.header("x-vc-install"));
      const thisId = mine ? (results ?? []).filter((r) => r.install_id === mine).at(-1)?.id : undefined;
      const devices = await Promise.all((results ?? []).map(async (r) => {
        let online: boolean | null = null, roots: unknown, self: { os?: string; arch?: string } = {}, heard: number | null = null, hb: boolean | null = null;
        try { const s = await hubOf(c.env, r.id).fetch(new Request("https://do.internal/state", { headers: hubHeaders(r) })); if (s.ok) { const j = (await s.json()) as { online: boolean; roots?: unknown; lastHeardMs?: unknown; hb?: unknown; os?: unknown; arch?: unknown }; online = j.online; roots = sanitiseRoots(j.roots); self = sanitiseSelf({ os: j.os, arch: j.arch }); if (typeof j.lastHeardMs === "number" && Number.isFinite(j.lastHeardMs)) heard = j.lastHeardMs; if (typeof j.hb === "boolean") hb = j.hb; } } catch { /* unknown */ }
        return { id: r.id, name: r.name, created_at: r.created_at, last_seen: r.last_seen, last_online_at: r.last_online_at ?? null, this_install: r.id === thisId, linked: !!r.install_id, online, ...(heard !== null ? { last_heard_at: heard } : {}), ...(hb !== null ? { hb } : {}), ...(roots ? { roots } : {}), ...(self.os ? { os: self.os } : {}), ...(self.arch ? { arch: self.arch } : {}) };
      }));
      return c.json({ devices, server_now: Date.now(), env_chats: await vclEnvEnabled(c.env.DB, scopeOf(c)).catch(() => false) }, 200, { "cache-control": "no-store" });
    } catch (e) { console.error("devices list", e instanceof Error ? e.message : String(e)); return c.json({ error: "devices unavailable" }, 503); }
  });

  // "This is this Mac" (devv2s2c): binds the desktop app's install id to ONE existing row that was paired before install ids existed (install_id NULL). The page names the row; the server never guesses it.
  // Only the caller's own live row, never overwrites a different id, never lets one install id sit on two live rows, idempotent. The id is not a credential and nothing is returned but ok.
  const claimLog = new Map<string, number[]>(); // per isolate, best effort: the conditional UPDATE below is the real guard
  app.post("/api/devices/:id/claim", async (c) => {
    if (!sameOrigin(c.req.raw)) return c.json({ error: "forbidden" }, 403);
    const user = actor(c), now = Date.now(), recent = (claimLog.get(user) ?? []).filter((t) => now - t < 600_000);
    if (recent.length >= 20) { claimLog.set(user, recent); return c.json({ error: "too many attempts, wait a few minutes" }, 429, { "retry-after": "600" }); }
    recent.push(now); claimLog.set(user, recent);
    const install = installOf(((await c.req.json().catch(() => ({}))) as { install_id?: unknown } | null)?.install_id);
    if (!install) return c.json({ error: "install_id required" }, 400);
    try {
      const row = await owned(c, c.req.param("id"));
      if (!row) return nf(c);
      const cur = await c.env.DB.prepare(`SELECT install_id FROM devices WHERE id=? AND scope=? AND user=? AND revoked_at IS NULL`).bind(row.id, row.scope, row.user).first<{ install_id: string | null }>();
      if (!cur) return nf(c);
      if (cur.install_id === install) return c.json({ ok: true, already: true }, 200, { "cache-control": "no-store" });
      if (cur.install_id) return c.json({ error: "this device is already linked to another app install" }, 409);
      const r = await c.env.DB.prepare(`UPDATE devices SET install_id=? WHERE id=? AND scope=? AND user=? AND revoked_at IS NULL AND install_id IS NULL AND NOT EXISTS (SELECT 1 FROM devices WHERE scope=? AND user=? AND revoked_at IS NULL AND install_id=? AND id<>?)`)
        .bind(install, row.id, row.scope, row.user, row.scope, row.user, install, row.id).run();
      if (!r.meta.changes) {
        // Lost a race or blocked by another row: re-read the scoped live row to tell which. A concurrent IDENTICAL claim has already bound this row to the requested install = success, not a conflict.
        const now2 = await c.env.DB.prepare(`SELECT install_id FROM devices WHERE id=? AND scope=? AND user=? AND revoked_at IS NULL`).bind(row.id, row.scope, row.user).first<{ install_id: string | null }>();
        if (!now2) return nf(c);
        if (now2.install_id === install) return c.json({ ok: true, already: true }, 200, { "cache-control": "no-store" });
        return c.json({ error: now2.install_id ? "this device is already linked to another app install" : "this app install is already linked to another device" }, 409);
      }
      return c.json({ ok: true }, 200, { "cache-control": "no-store" });
    } catch (e) { console.error("devices claim", e instanceof Error ? e.message : String(e)); return c.json({ error: "devices unavailable" }, 503); }
  });

  app.delete("/api/devices/:id", async (c) => {
    const row = await owned(c, c.req.param("id")).catch(() => null);
    if (!row) return nf(c);
    const r = await c.env.DB.prepare(`UPDATE devices SET revoked_at=?, token_hash=NULL WHERE id=? AND revoked_at IS NULL`).bind(nowS(), row.id).run();
    if (!r.meta.changes) return nf(c);
    let closed = false; // D1 is the authority and already says revoked; this only drops live sockets now (the DO alarm re-checks D1 within a minute if it fails)
    try { closed = (await hubOf(c.env, row.id).fetch(new Request("https://do.internal/revoke", { method: "POST", headers: hubHeaders(row) }))).ok; } catch (e) { console.error("devices revoke hub", e instanceof Error ? e.message : String(e)); }
    return c.json({ ok: true, closed });
  });

  app.get("/api/devices/:id/session", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket upgrade" }, 426);
    if (!sameOrigin(c.req.raw)) return c.json({ error: "forbidden" }, 403); // cross-site WebSocket hijacking: the cookie rides along, Origin does not lie
    const row = await owned(c, c.req.param("id")).catch(() => null);
    if (!row) return nf(c);
    const since = Number(c.req.query("since") ?? 0) || 0;
    return rewrap(await hubOf(c.env, row.id).fetch(new Request(`https://do.internal/ws/app?since=${since}`, { headers: hubHeaders(row, { upgrade: "websocket", ...(c.get("session").lat !== undefined ? { "x-vcl-lat": String(c.get("session").lat) } : {}) }) })));
  });

  // ---- device-authenticated (public paths: no session, token or code is the credential) ----
  const feat = async (c: Ctx, scope: string) => (c.env.DEVICES ? vclEnabled(c.env.DB, scope as Scope) : false);

  app.post("/device/pair", async (c) => {
    if (!c.env.DEVICES || !c.env.DB) return nf(c);
    const b = (await c.req.json().catch(() => ({}))) as { code?: unknown; name?: unknown };
    const code = normalizeCode(b.code), name = cleanName(b.name), t = nowS();
    if (!name) return c.json({ error: "name required (1-60 chars)" }, 400);
    const ip = await sha256("vcl-ip:" + (c.req.header("cf-connecting-ip") ?? "unknown"));
    const bad = () => c.json({ error: "invalid or expired code" }, 400);
    try {
      await c.env.DB.prepare(`DELETE FROM device_pair_fails WHERE at < ?`).bind(t - PAIR_TTL_S).run();
      const mine = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM device_pair_fails WHERE ip_hash=?`).bind(ip).first<{ n: number }>();
      const all = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM device_pair_fails`).first<{ n: number }>();
      if ((mine?.n ?? 0) >= PAIR_FAIL_PER_IP || (all?.n ?? 0) >= PAIR_FAIL_GLOBAL) return c.json({ error: "too many attempts" }, 429, { "retry-after": String(PAIR_TTL_S) });
      const miss = async () => { await c.env.DB.prepare(`INSERT INTO device_pair_fails (ip_hash, at) VALUES (?, ?)`).bind(ip, t).run(); return bad(); };
      if (!code) return miss();
      const h = await codeHash(code);
      const p = await c.env.DB.prepare(`SELECT scope, user, install_id, space FROM device_pairings WHERE code_hash=? AND used_at IS NULL AND expires_at > ?`).bind(h, t).first<{ scope: string; user: string; install_id: string | null; space: string | null }>();
      if (!p) return miss();
      if (!(await feat(c, p.scope))) return nf(c); // feature switched off since the code was minted: refuse without consuming it
      const live = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM devices WHERE ${liveWhere(p.scope)}`).bind(...liveBind(p.scope, p.user)).first<{ n: number }>();
      if ((live?.n ?? 0) >= limitOf(p.scope)) return limitReply(c, p.scope, "device limit reached");
      const claim = await c.env.DB.prepare(`UPDATE device_pairings SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at > ?`).bind(t, h, t).run(); // single use, race-safe
      if (!claim.meta.changes) return miss();
      const id = newDeviceId(), token = mintToken(id);
      // Atomic limit: the count and the insert are ONE statement (D1 serialises writes), so two racing redemptions cannot both take the last slot.
      const ins = await c.env.DB.prepare(`INSERT INTO devices (id, scope, user, name, token_hash, created_at, last_seen, install_id, space) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM devices WHERE ${liveWhere(p.scope)}) < ?`)
        .bind(id, p.scope, p.user, name, await tokenHash(token), t, t, p.install_id, parseDeviceSpace(p.space) ?? "biz", ...liveBind(p.scope, p.user), limitOf(p.scope)).run();
      if (!ins.meta.changes) { await c.env.DB.prepare(`UPDATE device_pairings SET used_at=NULL WHERE code_hash=?`).bind(h).run(); return limitReply(c, p.scope, "device limit reached"); } // lost the race: give the code back
      return c.json({ deviceId: id, token, name, token_ttl_s: TOKEN_TTL_S }, 201, { "cache-control": "no-store" }); // the only time the token exists in clear text
    } catch (e) { console.error("device pair", e instanceof Error ? e.message : String(e)); return c.json({ error: "devices unavailable" }, 503); }
  });

  app.get("/device", async (c) => {
    if (!c.env.DEVICES || !c.env.DB) return nf(c);
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket upgrade" }, 426);
    const tok = bearerOf(c.req.header("authorization") ?? null), parsed = parseToken(tok);
    if (!tok || !parsed) return c.json({ error: "unauthorized" }, 401);
    try {
      const row = await c.env.DB.prepare(`SELECT id, scope, user, name, token_hash, created_at, last_seen, revoked_at FROM devices WHERE id=?`).bind(parsed.deviceId).first<DeviceRow>();
      const t = nowS();
      // Same answer for unknown id, wrong token, revoked, expired: nothing tells a prober which one it was.
      if (!row || row.revoked_at !== null || !row.token_hash || !timingEqual(row.token_hash, await tokenHash(tok)) || row.last_seen + TOKEN_TTL_S < t) return c.json({ error: "unauthorized" }, 401);
      if (!(await feat(c, row.scope))) return nf(c);
      if (t - row.last_seen > 60) await c.env.DB.prepare(`UPDATE devices SET last_seen=? WHERE id=? AND revoked_at IS NULL`).bind(t, row.id).run();
      return rewrap(await hubOf(c.env, row.id).fetch(new Request("https://do.internal/ws/device", { headers: hubHeaders(row, { upgrade: "websocket" }) })));
    } catch (e) { console.error("device dial-in", e instanceof Error ? e.message : String(e)); return c.json({ error: "devices unavailable" }, 503); }
  });
}
