// VCL model proxy for paired devices: POST /bridge/llm/v1/messages (Anthropic Messages API, streaming or not). Outside /api: the device token is the credential.
// The `vcl` daemon's loopback proxy points ANTHROPIC_BASE_URL here. Flag-gated like /device (settings row `vcl:<base>`='1', else plain 404).
// Upstream is the GATEWAY service binding with the app's existing GATEWAY_KEY (never read into a response or log) for main/e2e devices ONLY. A team (g:*) device
// never touches GATEWAY_KEY: it goes through the team gateway as its owner's team_users email (act-as + chat entitlement, fail closed), or is refused (wscaps1 C4). See docs/vertex-client-vcl-protocol.md.
import type { Context, Hono } from "hono";
import { guestUidOfScope, type Scope } from "./scope";
import { FEATURE_CHAT, requireFeature, teamActAsFetcher, teamConfigured } from "./providers/team-gateway";
import { DEVICE_ID, TOKEN_TTL_S, bearerOf, nowS, parseToken, timingEqual, tokenHash } from "./device-core";
import { deviceOpenAllowed, vclDailyCapUsd, vclEnabled } from "./devices";
import { LLM_MODELS, LLM_BODY_DEADLINE_MS, LLM_LEASE_S, LLM_MAX_BODY, LLM_MAX_RESPONSE, LLM_REVOKE_CHECK_MS, SseUsage, checkLlmBody, effectiveUsage, isProblem, llmError, mapUpstream, reserveUsd, upstreamHeaders, usageOfJson } from "./bridge-llm-core";
import { MODELS_META } from "./models-meta";
import { costOf } from "./pricing";
import { isOpenModelId, openModelList, openPriceOf, openRegistry, openReserveUsd, openUsage, vclOpenEnabled } from "./bridge-llm-open";
import { ProviderError } from "./providers/types";
import type { Usage } from "./reducer";
import type { Env } from "./index";

type Ctx = Context<{ Bindings: Env; Variables: { session: import("./auth").Session } }>;
type Row = { id: string; scope: string; user: string; token_hash: string | null; last_seen: number; revoked_at: number | null };
const json = (status: number, type: string, message: string, extra: Record<string, string> = {}) =>
  new Response(llmError(type, message), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const unauthorized = () => json(401, "authentication_error", "unauthorized");

export function bridgeLlmRoutes(app: Hono<{ Bindings: Env; Variables: { session: import("./auth").Session } }>) {
  app.post("/bridge/llm/v1/messages", async (c: Ctx) => {
    const env = c.env;
    if (!env.DEVICES || !env.DB) return c.json({ error: "not found" }, 404);
    const tok = bearerOf(c.req.header("authorization") ?? null), parsed = parseToken(tok);
    if (!tok || !parsed) return unauthorized();
    let row: Row | null, hub!: DurableObjectStub, slot: string | null = null;
    const release = () => { const id = slot; slot = null; if (id) c.executionCtx.waitUntil(hub.fetch(new Request("https://do.internal/llm/release?id=" + id, { method: "POST", headers: hdrs(row!) })).catch(() => {})); };
    const hdrs = (r: Row) => ({ "x-vcl-device": r.id, "x-vcl-scope": r.scope, "x-vcl-user": r.user });
    try {
      row = await env.DB.prepare(`SELECT id, scope, user, token_hash, last_seen, revoked_at FROM devices WHERE id=?`).bind(parsed.deviceId).first<Row>();
      const t = nowS();
      // Uniform with /device: unknown id, wrong token, revoked, idle-expired all look the same.
      if (!row || row.revoked_at !== null || !row.token_hash || !timingEqual(row.token_hash, await tokenHash(tok)) || row.last_seen + TOKEN_TTL_S < t) return unauthorized();
      if (!(await vclEnabled(env.DB, row.scope as Scope))) return c.json({ error: "not found" }, 404);
      if (t - row.last_seen > 60) await env.DB.prepare(`UPDATE devices SET last_seen=? WHERE id=? AND revoked_at IS NULL`).bind(t, row.id).run();
      const openOn = (await vclOpenEnabled(env.DB, row.scope as Scope)) && (await deviceOpenAllowed(env.DB, row.id)); // + vclspace1: this DEVICE's own space must allow Open (a biz device never reaches the base's Open keys) // vclopen1 flag, default OFF: then nothing below differs from the Claude-only proxy

      hub = env.DEVICES.get(env.DEVICES.idFromName(row.id));
      // Body first (size cap + read deadline), so a slot is only ever held for the model call itself, never by a slow or half-sent body.
      const cl = Number(c.req.header("content-length"));
      if (Number.isFinite(cl) && cl > LLM_MAX_BODY) return json(413, "request_too_large", "request body too large");
      const raw = await readCapped(c.req.raw, LLM_MAX_BODY, LLM_BODY_DEADLINE_MS);
      if (raw === "timeout") return json(408, "invalid_request_error", "request body not received in time");
      if (raw === null) return json(413, "request_too_large", "request body too large");
      const chk = checkLlmBody(raw, openOn);
      if (isProblem(chk)) return json(chk.status, chk.status === 413 ? "request_too_large" : "invalid_request_error", chk.message);

      // Open model (flag on): served by the user's own provider key through the Open registry; the Vertex gateway is not involved and its config is not required.
      const isOpen = openOn && isOpenModelId(chk.model);
      const guestUid = guestUidOfScope(row.scope as Scope), guest = guestUid !== null;
      let teamUp: { fetch(input: string, init?: RequestInit): Promise<Response> } | null = null;
      let openReg: Awaited<ReturnType<typeof openRegistry>> = null, openMeta: import("./models-meta").ModelMeta | null = null, openNotice: string | undefined;
      if (isOpen) {
        if (!chk.stream) return json(400, "invalid_request_error", "Open models need stream:true");
        openReg = await openRegistry(env as never, row.scope as Scope);
        const listed = openReg ? (await openReg.models()).find((m) => m.id === chk.model) : undefined;
        if (!openReg || !listed) return json(400, "invalid_request_error", "model not available (is the provider enabled and your key saved in Settings > Providers?)");
        openMeta = listed.meta; openNotice = (await openModelList(openReg)).find((m) => m.id === chk.model)?.data_use_notice;
      } else if (guest) {
        // Team owner: the owner's own entitlement pays. No team_users row / disabled / team gateway not configured / no chat feature => refused, GATEWAY_KEY never read.
        if (!teamConfigured(env)) return json(503, "api_error", "model provider not configured");
        const tu = await env.DB.prepare(`SELECT email, status FROM team_users WHERE uid=?`).bind(guestUid).first<{ email: string; status: string }>();
        if (!tu || tu.status !== "active") return json(403, "permission_error", "this team account is not active");
        try { await requireFeature(env, tu.email, FEATURE_CHAT); } catch (e) { if (e instanceof ProviderError) { if (e.status === 403) return json(403, "permission_error", "your team account does not have access to this feature"); const m = mapUpstream(e.status); return json(m.status, m.type, m.message); } return json(503, "api_error", "model provider unreachable"); }
        teamUp = teamActAsFetcher(env, tu.email);
      } else if (!env.GATEWAY || !env.GATEWAY_KEY) return json(503, "api_error", "model provider not configured");

      // Admission (DeviceHub, persisted): rate, concurrency, and the daily soft cap counting spent-today PLUS the worst case of every open request and this one.
      const cap = await vclDailyCapUsd(env.DB, row.scope as Scope);
      const reserve = isOpen ? openReserveUsd(openMeta, raw.length, chk.body.max_tokens as number) : reserveUsd(chk.model, raw.length, chk.body.max_tokens as number) ?? 0;
      const reqId = crypto.randomUUID();
      const acq = await hub.fetch(new Request(`https://do.internal/llm/acquire?id=${reqId}&cap=${cap}&reserve=${reserve}`, { method: "POST", headers: hdrs(row) }));
      if (acq.status === 410 || acq.status === 404) return unauthorized();
      if (!acq.ok) return json(503, "api_error", "model proxy unavailable"); // fail closed
      const a = (await acq.json()) as { ok: boolean; id?: string; reason?: string; retryAfterS?: number; cap?: number };
      if (!a.ok) {
        if (a.reason === "budget") return json(429, "rate_limit_error", `daily budget for this device is used up ($${cap.toFixed(2)}); it resets at 00:00 UTC`, { "retry-after": "3600" });
        return json(429, "rate_limit_error", a.reason === "concurrent" ? "too many concurrent requests for this device" : "rate limit exceeded for this device", { "retry-after": String(a.retryAfterS ?? 5) });
      }
      slot = reqId;

      // ---- forward ----
      const up = new AbortController();
      // The lease is the DO's only proof this request is alive: end the upstream call before it can lapse.
      const lease = setTimeout(() => up.abort(), (LLM_LEASE_S - 30) * 1000);
      const onAbort = () => up.abort();
      if (c.req.raw.signal.aborted) up.abort(); else c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
      let res: Response;
      try {
        res = isOpen ? await openReg!.router.messages(chk.body, up.signal) : (teamUp ? await teamUp.fetch("https://gateway.internal/v1/messages", { method: "POST", signal: up.signal, body: raw, headers: upstreamHeaders(c.req.raw.headers) }) : guest ? (() => { throw new Error("no provider for scope"); })() : await env.GATEWAY!.fetch("https://gateway.internal/v1/messages", { method: "POST", signal: up.signal, body: raw, headers: { ...upstreamHeaders(c.req.raw.headers), "x-api-key": env.GATEWAY_KEY! } }));
      } catch (e) {
        release(); clearTimeout(lease);
        if (isOpen && e instanceof ProviderError) { const m = mapUpstream(e.status === 409 || e.status === 410 ? 400 : e.status); return json(m.status, m.type, m.message, e.status === 429 ? { "retry-after": String(Math.min(60, Math.max(1, e.info.retryAfterS ?? 5))) } : {}); }
        return json(502, "api_error", "model provider unreachable");
      }
      if (!res.ok) { void res.body?.cancel().catch(() => {}); clearTimeout(lease); release(); const m = mapUpstream(res.status); return json(m.status, m.type, m.message, res.status === 429 ? { "retry-after": String(Math.min(60, Math.max(1, Number(res.headers.get("retry-after")) || 5))) } : {}); }

      const meta = isOpen ? openMeta : MODELS_META[chk.model], runId = `vcl:${row.id}:${crypto.randomUUID()}`, scope = row.scope, rowId = row.id;
      let recorded = false;
      // Cost row first, slot release after it: the DO's next admission then sees this request either as an open reservation or as spent money, never as neither.
      const record = (u: Usage) => {
        if (recorded) return; recorded = true; clearTimeout(lease);
        const cost = costOf(u, isOpen ? openPriceOf(meta) : meta?.price ?? undefined); // Open: unpriced models are charged the fallback rate (fail closed), never skipped
        if (cost === null) { release(); return; }
        c.executionCtx.waitUntil(env.DB.prepare(`INSERT INTO cloud_costs (run_id, executor, cost_usd, scope) VALUES (?,?,?,?)`).bind(runId, "vcl", cost, scope).run().then(() => {}).catch((e) => console.error("vcl usage", e instanceof Error ? e.message : String(e))).finally(release));
      };
      const outHeaders: Record<string, string> = { "content-type": res.headers.get("content-type") ?? "application/json", "cache-control": "no-store", ...(openNotice ? { "x-vcl-data-use-notice": openNotice.replace(/[^\x20-\x7e]/g, "?") } : {}), ...(isOpen ? { "x-vcl-model-space": "open" } : {}) };

      if (!chk.stream || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const text = await readCapped(res, LLM_MAX_RESPONSE);
        c.req.raw.signal.removeEventListener("abort", onAbort);
        if (text === null) { record({}); return json(502, "api_error", "model provider response too large"); }
        let j: unknown = null; try { j = JSON.parse(text); } catch { /* not JSON: passed through, no usage */ }
        record(usageOfJson(j));
        return new Response(text, { status: 200, headers: outHeaders });
      }

      // Streaming: bytes pass through unchanged; a tap reads usage and re-checks the device row so a revoke ends the stream within LLM_REVOKE_CHECK_MS.
      const sse = new SseUsage(), dec = new TextDecoder(), reader = res.body!.getReader(); let lastCheck = Date.now();
      const done = () => { c.req.raw.signal.removeEventListener("abort", onAbort); record(isOpen ? openUsage(sse, raw.length) : effectiveUsage(sse)); };
      const tap = new ReadableStream<Uint8Array>({
        async pull(ctl) {
          try {
            const { done: end, value } = await reader.read();
            if (end) { done(); ctl.close(); return; }
            sse.feed(dec.decode(value, { stream: true }));
            if (Date.now() - lastCheck > LLM_REVOKE_CHECK_MS) {
              lastCheck = Date.now();
              const r = await env.DB.prepare(`SELECT revoked_at FROM devices WHERE id=?`).bind(rowId).first<{ revoked_at: number | null }>().catch(() => null);
              if (!r || r.revoked_at !== null || !(await vclEnabled(env.DB, scope as Scope))) { up.abort(); void reader.cancel().catch(() => {}); done(); ctl.error(new Error("revoked")); return; }
            }
            ctl.enqueue(value);
          } catch (e) { done(); ctl.error(e); } // upstream error / abort mid-stream: bill what was seen, release the slot
        },
        cancel() { up.abort(); void reader.cancel().catch(() => {}); done(); }, // the client went away: abort upstream, still bill what streamed (conservatively)
      });
      return new Response(tap, { status: 200, headers: outHeaders });
    } catch (e) {
      if (slot) release();
      console.error("bridge llm", e instanceof Error ? e.message : String(e));
      return json(503, "api_error", "model proxy unavailable");
    }
  });
  // Model list for vcl (device token = credential, same uniformity as /messages). Claude's three always; Open ids only with the flag on AND a usable provider key. Flag off => identical to before.
  app.get("/bridge/llm/v1/models", async (c: Ctx) => {
    const env = c.env;
    if (!env.DEVICES || !env.DB) return c.json({ error: "not found" }, 404);
    const tok = bearerOf(c.req.header("authorization") ?? null), parsed = parseToken(tok);
    if (!tok || !parsed) return unauthorized();
    try {
      const row = await env.DB.prepare(`SELECT id, scope, user, token_hash, last_seen, revoked_at FROM devices WHERE id=?`).bind(parsed.deviceId).first<Row>();
      if (!row || row.revoked_at !== null || !row.token_hash || !timingEqual(row.token_hash, await tokenHash(tok)) || row.last_seen + TOKEN_TTL_S < nowS()) return unauthorized();
      if (!(await vclEnabled(env.DB, row.scope as Scope))) return c.json({ error: "not found" }, 404);
      const data: Array<Record<string, unknown>> = LLM_MODELS.map((id) => ({ type: "model", id, display_name: MODELS_META[id]?.label ?? id }));
      if ((await vclOpenEnabled(env.DB, row.scope as Scope)) && (await deviceOpenAllowed(env.DB, row.id))) { const reg = await openRegistry(env as never, row.scope as Scope).catch(() => null); if (reg) data.push(...(await openModelList(reg).catch(() => [])).map((m) => ({ type: "model", ...m }))); }
      return new Response(JSON.stringify({ data, has_more: false }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) { console.error("bridge llm models", e instanceof Error ? e.message : String(e)); return json(503, "api_error", "model proxy unavailable"); }
  });
  app.all("/bridge/*", (c) => c.json({ error: "not found" }, 404));
}

/** Read a request/response body with a hard byte limit; null = exceeded. */
async function readCapped(m: Request | Response, max: number, deadlineMs?: number): Promise<string | null | "timeout"> {
  if (!m.body) return "";
  const reader = m.body.getReader(), parts: Uint8Array[] = []; let n = 0;
  let timer: ReturnType<typeof setTimeout> | undefined, late = false;
  const lateP = deadlineMs ? new Promise<never>((_r, rej) => { timer = setTimeout(() => { late = true; rej(new Error("deadline")); }, deadlineMs); }) : null;
  for (;;) {
    let step: Awaited<ReturnType<typeof reader.read>>;
    try { step = await (lateP ? Promise.race([reader.read(), lateP]) : reader.read()); } catch { void reader.cancel().catch(() => {}); return late ? "timeout" : null; }
    const { done, value } = step;
    if (done) break;
    n += value.byteLength;
    if (n > max) { clearTimeout(timer); void reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  clearTimeout(timer);
  const all = new Uint8Array(n); let o = 0; for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}
