// Connectors P2: user-added remote MCP servers (Streamable HTTP, bearer token or one custom header). No OAuth, no new secrets, no new domains.
// Trust model: the server, its tool descriptions and its tool output are UNTRUSTED. Descriptions/schemas are truncated + size-capped, names are namespaced
// `<slug>__<tool>` (a custom tool can never shadow a built-in: no built-in name contains "__"), output is wrapped like read_url, new tools default to
// "Ask first", and a tool set to Block is never shown to the model. The token is encrypted at rest (AES-GCM, HKDF from SESSION_SECRET) and is never
// returned by any API or written to a log.
import { McpClient, TOOL_RESULT_MAX, classify, wrapUntrusted, type McpFetcher, type McpTool, type ToolDef, type ToolHost } from "./tools";
import { isMainBase, type Scope } from "./scope";

export const MAX_CUSTOM = 20;
export const MAX_TOOLS = 25;
export const DESC_MAX = 1000;
export const SCHEMA_MAX = 3000;
export const SCHEMA_TEXT_MAX = 200;
const SCHEMA_DEPTH_MAX = 12;
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_BODY = 1024 * 1024;
export type Mode = "always" | "ask" | "block";
export const MODES: readonly Mode[] = ["always", "ask", "block"];

export class ConnectorError extends Error {
  constructor(public code: "url" | "oauth" | "auth" | "redirect" | "size" | "timeout" | "type" | "network", msg: string) { super(msg); }
}

// ---------- URL policy ----------
const BLOCKED_SUFFIX = [".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa", ".ts.net", ".internal.invalid", ".workers.dev"];
const BLOCKED_EXACT = new Set(["localhost", "internal.invalid", "workers.dev"]);

/** Strict URL check for an MCP endpoint. https only, default port, no userinfo, no IP literal, no local/internal names, never our own services.
 *  (workers.dev is blocked as a whole: we cannot tell "our account" from any other, and a vclient-to-vclient loop is never wanted.) */
export function validateUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) return { ok: false, error: "enter the MCP server URL" };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, error: "that is not a valid URL" }; }
  if (u.protocol !== "https:") return { ok: false, error: "the URL must start with https://" };
  if (u.username || u.password) return { ok: false, error: "the URL must not contain a username or password" };
  if (u.port !== "") return { ok: false, error: "only the default HTTPS port (443) is allowed" };
  const h = u.hostname.toLowerCase();
  if (h.startsWith("[") || h.includes(":")) return { ok: false, error: "IP addresses are not allowed, use a host name" };
  if (h.endsWith(".")) return { ok: false, error: "that host name is not allowed" };
  const labels = h.split(".");
  if (labels.length < 2) return { ok: false, error: "that host name is not allowed" };
  if (/^(0x[0-9a-f]*|\d+)$/i.test(labels[labels.length - 1]!)) return { ok: false, error: "IP addresses are not allowed, use a host name" };
  if (!/^[a-z0-9.-]+$/.test(h)) return { ok: false, error: "that host name is not allowed" };
  if (BLOCKED_EXACT.has(h) || BLOCKED_SUFFIX.some((s) => h.endsWith(s))) return { ok: false, error: "that host is not allowed (local, internal or one of our own services)" };
  u.hash = "";
  return { ok: true, url: u.toString() };
}

// ---------- SSRF-safe fetch ----------
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) { await res.body?.cancel().catch(() => {}); throw new ConnectorError("size", "the server's response is too large (limit 1 MiB)"); }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new ConnectorError("size", "the server's response is too large (limit 1 MiB)"); }
    chunks.push(value);
  }
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

/** The only way custom-connector traffic leaves the Worker. Re-validates the URL on every call, refuses redirects, 15 s timeout, 1 MiB cap,
 *  JSON/SSE content-type only. 401 is turned into a typed error (needs OAuth vs token rejected). */
export function safeFetcher(o: { hasAuth: boolean; impl?: typeof fetch; timeoutMs?: number; maxBytes?: number }): McpFetcher {
  const impl = o.impl ?? fetch;
  return {
    async fetch(url, init) {
      const v = validateUrl(url);
      if (!v.ok) throw new ConnectorError("url", v.error);
      let res: Response;
      try { res = await impl(v.url, { ...init, redirect: "manual", signal: AbortSignal.timeout(o.timeoutMs ?? FETCH_TIMEOUT_MS) }); }
      catch (e) {
        const n = e instanceof Error ? e.name : "";
        throw n === "TimeoutError" || n === "AbortError" ? new ConnectorError("timeout", "the server did not answer within 15 seconds") : new ConnectorError("network", "could not reach the server");
      }
      const drop = () => res.body?.cancel().catch(() => {});
      if (res.status >= 300 && res.status < 400) { await drop(); throw new ConnectorError("redirect", "the server redirected the request; redirects are refused"); }
      if (res.status === 401) {
        await drop();
        throw o.hasAuth ? new ConnectorError("auth", "the server rejected the token (if it uses OAuth, that is not supported yet)")
          : new ConnectorError("oauth", "this server needs OAuth, not supported yet");
      }
      const empty = res.status === 202 || res.status === 204;
      if (res.ok && !empty && !/^(application\/json|text\/event-stream)\b/i.test(res.headers.get("content-type") ?? "")) { await drop(); throw new ConnectorError("type", "the server did not answer with JSON or an event stream (is that an MCP endpoint?)"); }
      let bytes: Uint8Array;
      try { bytes = await readCapped(res, o.maxBytes ?? MAX_BODY); }
      catch (e) {
        if (e instanceof ConnectorError) throw e;
        throw new ConnectorError("timeout", "the server did not finish its answer within 15 seconds");
      }
      const headers = new Headers(res.headers); headers.delete("content-encoding"); headers.delete("content-length");
      return new Response(bytes.byteLength && res.status !== 204 && res.status !== 205 ? (bytes as unknown as BodyInit) : null, { status: res.status, headers });
    },
  };
}

// ---------- token at rest ----------
const enc = new TextEncoder();
const INFO = "vclient/custom-connector-token/v1";
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function aesKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("no session secret");
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(INFO) }, ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/** `aad` binds the ciphertext to its row (`scope:id`): a ciphertext copied into another row does not decrypt. */
export async function encryptToken(secret: string, aad: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(secret), enc.encode(plain)));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
export async function decryptToken(secret: string, aad: string, blob: string): Promise<string> {
  const raw = unb64(blob);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12), additionalData: enc.encode(aad) }, await aesKey(secret), raw.slice(12));
  return new TextDecoder().decode(pt);
}

// ---------- input validation ----------
const RESERVED_HEADERS = /^(host|content-type|content-length|accept|accept-encoding|mcp-session-id|connection|transfer-encoding|upgrade|cookie|set-cookie|origin|referer|user-agent|x-csrf-token|cf-.*)$/i;
export type AuthKind = "none" | "bearer" | "header";
export interface NewConnector { name: string; url: string; authKind: AuthKind; headerName: string | null; token: string | null }

export function validateNew(b: unknown): { ok: true; v: NewConnector } | { ok: false; error: string } {
  if (!b || typeof b !== "object") return { ok: false, error: "invalid body" };
  const x = b as Record<string, unknown>;
  const name = typeof x.name === "string" ? x.name.trim() : "";
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: "name must be 1-40 characters" };
  if (!slugOf(name)) return { ok: false, error: "name must contain letters or digits" };
  const u = validateUrl(x.url);
  if (!u.ok) return u;
  const authKind = x.authKind ?? "none";
  if (authKind !== "none" && authKind !== "bearer" && authKind !== "header") return { ok: false, error: "authKind must be none, bearer or header" };
  let headerName: string | null = null; let token: string | null = null;
  if (authKind !== "none") {
    if (typeof x.token !== "string" || !x.token.trim() || x.token.length > 2048 || /[\u0000-\u001f\u007f]/.test(x.token)) return { ok: false, error: "enter the token (up to 2048 characters, no line breaks)" };
    token = x.token.trim();
  }
  if (authKind === "header") {
    if (typeof x.headerName !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(x.headerName) || RESERVED_HEADERS.test(x.headerName)) return { ok: false, error: "that header name is not allowed" };
    headerName = x.headerName;
  }
  return { ok: true, v: { name, url: u.url, authKind, headerName, token } };
}

/** Namespace prefix of a connector: lowercase letters/digits/single hyphens, <= 24 chars, never contains "__". */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24).replace(/-+$/g, "");
}

export function authHeaders(kind: AuthKind, headerName: string | null, token: string | null): Record<string, string> {
  if (kind === "bearer" && token) return { authorization: `Bearer ${token}` };
  if (kind === "header" && token && headerName) return { [headerName]: token };
  return {};
}

/** A message safe to show/store: tokens removed, control characters dropped, short. */
export function scrub(e: unknown, token?: string | null): string {
  let m = e instanceof Error ? e.message : String(e);
  if (token) m = m.split(token).join("[token]");
  return m.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200);
}

// ---------- tool sanitising ----------
export interface CustomTool { name: string; raw: string; description: string; input_schema: Record<string, unknown>; approval: boolean }

/** Server tools -> offered tools: safe names, truncated description, capped schema, deduped, at most MAX_TOOLS, sorted by namespaced name.
 *  `modes` (by raw name): block -> dropped, always -> runs without asking, anything else (incl. a NEW tool) -> asks first. */
export function sanitizeTools(slug: string, tools: McpTool[], modes: Record<string, Mode> = {}): CustomTool[] {
  const out = new Map<string, CustomTool>();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t.name !== "string") continue;
    const part = t.name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (!part || part.length > 64 - slug.length - 2) continue;
    const name = `${slug}__${part}`;
    if (out.has(name) || classify(name)) continue;
    const mode = modes[t.name] ?? "ask";
    if (mode === "block") continue;
    let schema: Record<string, unknown> = { type: "object", properties: {} };
    if (t.inputSchema !== undefined) {
      const s = t.inputSchema as unknown;
      if (!s || typeof s !== "object" || Array.isArray(s) || (s as Record<string, unknown>).type !== "object") continue;
      const c = clampSchema(s) as Record<string, unknown> | null;
      if (!c) continue;
      let json = ""; try { json = JSON.stringify(c); } catch { continue; }
      if (json.length > SCHEMA_MAX) continue;
      schema = c;
    }
    const description = (typeof t.description === "string" ? t.description : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, DESC_MAX);
    out.set(name, { name, raw: t.name, description, input_schema: schema, approval: mode !== "always" });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_TOOLS);
}

/** Recursively cut every string `description` / `title` in a schema to SCHEMA_TEXT_MAX (these annotations go verbatim into the model's tool definitions).
 *  Returns null when the schema nests deeper than SCHEMA_DEPTH_MAX (the tool is then not offered). */
export function clampSchema(v: unknown, depth = 0): unknown {
  if (depth > SCHEMA_DEPTH_MAX) return null;
  if (Array.isArray(v)) { const o: unknown[] = []; for (const x of v) { const c = clampSchema(x, depth + 1); if (c === null && x !== null) return null; o.push(c); } return o; }
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === "description" || k === "title") && typeof x === "string") { o[k] = x.slice(0, SCHEMA_TEXT_MAX); continue; }
      const c = clampSchema(x, depth + 1); if (c === null && x !== null) return null; o[k] = c;
    }
    return o;
  }
  return v;
}
const canon = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v) ?? "null");
/** sha256 (hex) of the server's definition of a tool exactly as reported: name + description + input schema, canonical JSON. */
export async function toolHash(t: McpTool): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(canon({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? null })));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Always is only honoured while the live definition still hashes to what Erich confirmed. A changed (or never-hashed) definition is Ask first.
 *  `changed` = raw names whose confirmed Always no longer matches (the detail screen shows "definition changed — review"). */
export async function effectiveModes(tools: McpTool[], modes: Record<string, Mode>, hashes: Record<string, string>): Promise<{ modes: Record<string, Mode>; changed: Set<string> }> {
  const out = { ...modes }; const changed = new Set<string>();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (!t || typeof t.name !== "string" || modes[t.name] !== "always") continue;
    if (hashes[t.name] !== (await toolHash(t))) { out[t.name] = "ask"; changed.add(t.name); }
  }
  return { modes: out, changed };
}

/** Every tool the server reports, as the settings screen shows them (raw names, no mode filtering). */
export function listForSettings(tools: McpTool[]): Array<{ name: string; description: string }> {
  return (Array.isArray(tools) ? tools : []).filter((t) => t && typeof t.name === "string" && /^[\w.-]{1,128}$/.test(t.name))
    .map((t) => ({ name: t.name, description: (typeof t.description === "string" ? t.description : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, DESC_MAX) }))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 100);
}

/** Tolerant parse of the stored per-tool state. Format: `{m: {tool: mode}, h: {tool: sha256 of the confirmed definition}}`; the older flat
 *  `{tool: mode}` is still read (an Always without a hash is simply not honoured). Junk is dropped. */
export function parseState(v: unknown): { modes: Record<string, Mode>; hashes: Record<string, string> } {
  let a: unknown = v;
  if (typeof v === "string") { try { a = JSON.parse(v); } catch { return { modes: {}, hashes: {} }; } }
  const empty = { modes: {} as Record<string, Mode>, hashes: {} as Record<string, string> };
  if (!a || typeof a !== "object" || Array.isArray(a)) return empty;
  const o = a as Record<string, unknown>;
  const env = o.m !== null && typeof o.m === "object" && !Array.isArray(o.m);
  const src = (env ? o.m : o) as Record<string, unknown>;
  const modes: Record<string, Mode> = {};
  for (const [k, m] of Object.entries(src)) if (/^[\w.-]{1,128}$/.test(k) && MODES.includes(m as Mode)) modes[k] = m as Mode;
  const hashes: Record<string, string> = {};
  if (env && o.h && typeof o.h === "object" && !Array.isArray(o.h)) for (const [k, h] of Object.entries(o.h as Record<string, unknown>)) if (modes[k] === "always" && typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) hashes[k] = h;
  const sort = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).sort(([x], [y]) => x.localeCompare(y))) as Record<string, T>;
  return { modes: sort(modes), hashes: sort(hashes) };
}
export const parseModes = (v: unknown): Record<string, Mode> => parseState(v).modes;

// ---------- D1 ----------
type Stmt = { bind(...a: unknown[]): { first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> } };
export type Db = { prepare(q: string): Stmt };
export interface CustomRow { id: string; scope: string; name: string; url: string; auth_kind: AuthKind; auth_header_name: string | null; enc_token: string | null; enabled: number; created_at: string; updated_at: string; last_status: string | null; last_error: string | null }
const COLS = `id, scope, name, url, auth_kind, auth_header_name, enc_token, enabled, created_at, updated_at, last_status, last_error`;

export async function listCustom(db: Db, scope: Scope): Promise<CustomRow[]> {
  return (await db.prepare(`SELECT ${COLS} FROM custom_connectors WHERE scope=? ORDER BY created_at, id`).bind(scope).all<CustomRow>()).results;
}
export const getCustom = (db: Db, scope: Scope, id: string) => db.prepare(`SELECT ${COLS} FROM custom_connectors WHERE scope=? AND id=?`).bind(scope, id).first<CustomRow>();
export async function loadState(db: Db, scope: Scope, id: string): Promise<{ modes: Record<string, Mode>; hashes: Record<string, string> }> {
  const r = await db.prepare(`SELECT tool_modes FROM connector_settings WHERE scope=? AND connector_id=?`).bind(scope, id).first<{ tool_modes: string }>();
  return r ? parseState(r.tool_modes) : { modes: {}, hashes: {} };
}
export async function saveState(db: Db, scope: Scope, id: string, st: { modes: Record<string, Mode>; hashes: Record<string, string> }): Promise<void> {
  const n = parseState({ m: st.modes, h: st.hashes });
  await saveModes(db, scope, id, n.modes, n.hashes);
}
export async function saveModes(db: Db, scope: Scope, id: string, modes: Record<string, Mode>, hashes: Record<string, string> = {}): Promise<void> {
  await db.prepare(`INSERT INTO connector_settings (scope, connector_id, enabled, disabled_tools, tool_modes, updated_at) VALUES (?,?,1,'[]',?,datetime('now'))
    ON CONFLICT(scope, connector_id) DO UPDATE SET tool_modes=excluded.tool_modes, updated_at=excluded.updated_at`).bind(scope, id, JSON.stringify({ m: modes, h: hashes })).run();
}
export async function deleteCustom(db: Db, scope: Scope, id: string): Promise<boolean> {
  const r = (await db.prepare(`DELETE FROM custom_connectors WHERE scope=? AND id=?`).bind(scope, id).run()) as { meta?: { changes?: number } };
  await db.prepare(`DELETE FROM connector_settings WHERE scope=? AND connector_id=?`).bind(scope, id).run();
  return (r.meta?.changes ?? 1) > 0;
}
export async function setStatus(db: Db, scope: Scope, id: string, ok: boolean, error: string | null): Promise<void> {
  await db.prepare(`UPDATE custom_connectors SET last_status=?, last_error=?, updated_at=datetime('now') WHERE scope=? AND id=?`).bind(ok ? "ok" : "error", ok ? null : error, scope, id).run();
}

// ---------- talking to a server ----------
export async function clientFor(r: Pick<CustomRow, "url" | "auth_kind" | "auth_header_name">, token: string | null, impl?: typeof fetch): Promise<McpClient> {
  return new McpClient(safeFetcher({ hasAuth: r.auth_kind !== "none", impl }), "", { url: r.url, headers: authHeaders(r.auth_kind, r.auth_header_name, token), timeoutMs: FETCH_TIMEOUT_MS });
}
async function tokenOf(secret: string, r: CustomRow): Promise<string | null> {
  return r.enc_token ? decryptToken(secret, `${r.scope}:${r.id}`, r.enc_token) : null;
}
/** Live tools/list of a stored connector. Throws a message-safe Error (scrubbed). */
export async function fetchStoredTools(secret: string, r: CustomRow, impl?: typeof fetch): Promise<McpTool[]> {
  let token: string | null = null;
  try { token = await tokenOf(secret, r); return await (await clientFor(r, token, impl)).tools(); }
  catch (e) { throw new Error(scrub(e, token)); }
}

// ---------- the ToolHost the turn loop sees ----------
interface PinnedItem { id: string; tools: CustomTool[] }
const parsePin = (s: string | null): PinnedItem[] | null => {
  if (s === null) return null;
  try {
    const j = JSON.parse(s);
    if (!j || j.v !== 1 || !Array.isArray(j.items)) return null;
    return j.items.filter((i: PinnedItem) => i && typeof i.id === "string" && Array.isArray(i.tools)).map((i: PinnedItem) => ({ id: i.id, tools: i.tools.filter((t) => t && typeof t.name === "string" && typeof t.raw === "string" && !classify(t.name)) }));
  } catch { return null; }
};

/** Tools of this scope's enabled custom connectors, resolved ONCE per conversation (names, descriptions, schemas and modes pinned in `store`, so the tool
 *  block stays byte-stable and a mode change reaches new chats only). If any server was unreachable the result is not pinned (kept in memory for 5 minutes
 *  so each turn does not wait on a dead server). main base only (Business or Open, each with its own rows): every other scope gets nothing. Calls re-check the row, so a disconnect takes effect at once. */
export function customHost(d: { db: Db; scope: Scope; secret: string; store: { get(): string | null; set(v: string): void }; impl?: typeof fetch; now?: () => number }): ToolHost {
  const now = d.now ?? Date.now;
  let mem: { items: PinnedItem[]; until: number } | null = null;
  const resolve = async (): Promise<PinnedItem[]> => {
    if (!isMainBase(d.scope)) return [];
    const pinned = parsePin(d.store.get());
    if (pinned) return pinned;
    if (mem && mem.until > now()) return mem.items;
    const rows = (await listCustom(d.db, d.scope)).filter((r) => r.enabled !== 0);
    let failed = false;
    const items = (await Promise.all(rows.map(async (r): Promise<PinnedItem | null> => {
      try {
        const st = await loadState(d.db, d.scope, r.id);
        const live = await fetchStoredTools(d.secret, r, d.impl);
        return { id: r.id, tools: sanitizeTools(slugOf(r.name), live, (await effectiveModes(live, st.modes, st.hashes)).modes) };
      } catch (e) { failed = true; console.error("custom connector list failed", r.id, scrub(e)); return null; }
    }))).filter((x): x is PinnedItem => x !== null);
    if (failed) mem = { items, until: now() + 300_000 };
    else d.store.set(JSON.stringify({ v: 1, items }));
    return items;
  };
  return {
    async list(): Promise<ToolDef[]> {
      return (await resolve()).flatMap((i) => i.tools).sort((a, b) => a.name.localeCompare(b.name))
        .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, approval: t.approval }));
    },
    async call(name, args) {
      if (!isMainBase(d.scope)) return { text: `tool ${name} is not available for this account`, isError: true };
      const item = (await resolve()).find((i) => i.tools.some((t) => t.name === name));
      const tool = item?.tools.find((t) => t.name === name);
      if (!item || !tool) return { text: `tool ${name} is not available`, isError: true };
      const row = await getCustom(d.db, d.scope, item.id);
      if (!row || row.enabled === 0) return { text: `connector for ${name} was disconnected`, isError: true };
      let token: string | null = null;
      try {
        token = await tokenOf(d.secret, row);
        const r = await (await clientFor(row, token, d.impl)).callRaw(tool.raw, args);
        const text = r.text.length > TOOL_RESULT_MAX ? r.text.slice(0, TOOL_RESULT_MAX) + "\n[truncated]" : r.text;
        return { text: wrapUntrusted(name, text), isError: r.isError };
      } catch (e) { return { text: wrapUntrusted(name, `call failed: ${scrub(e, token)}`), isError: true }; }
    },
  };
}

/** personal-connector host + custom host as one. Sorted by name overall (the tool block is a cache breakpoint); a custom tool whose name collides with,
 *  or is classified like, a built-in is dropped; calls go to the owner by name ("__" = custom). A failing half never takes the other down. */
export function composeHosts(base: ToolHost, custom: ToolHost): ToolHost {
  return {
    async list() {
      const a = await base.list().catch((e) => { console.error("tools", String(e)); return [] as ToolDef[]; });
      const taken = new Set(a.map((t) => t.name));
      const b = (await custom.list().catch((e) => { console.error("custom tools", scrub(e)); return [] as ToolDef[]; })).filter((t) => t.name.includes("__") && !taken.has(t.name) && !classify(t.name));
      return [...a, ...b].sort((x, y) => x.name.localeCompare(y.name));
    },
    call: (name, args) => (name.includes("__") ? custom.call(name, args) : base.call(name, args)),
  };
}
