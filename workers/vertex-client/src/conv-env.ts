// Devices v2 step 3, Worker side: binding a conversation to a device environment and reading its derived state. Everything here is flag-gated by `vcl_env:<base>` (vclEnvEnabled) and fails CLOSED:
// a chat is never silently created as a cloud chat when a device was asked for, and a missing column / D1 hiccup is a 503, not a guess.
import type { Env } from "./index";
import type { Scope } from "./scope";
import { DEVICE_ID, sanitiseRoots } from "./device-core";
import { vclEnvEnabled } from "./devices";
import type { EnvSpec } from "./device-env";

export type EnvView = { kind: "device"; device_id: string; dir: string | null; name: string | null; state: "ready" | "offline" | "revoked" | "unavailable"; roots?: Array<{ label: string; path: string }> };

/** The creator's OWN live device (same scope, same user, not revoked) or null. */
export async function ownDevice(env: Env, scope: Scope, user: string, id: string): Promise<{ id: string; name: string } | null> {
  if (!DEVICE_ID.test(id)) return null;
  return env.DB.prepare(`SELECT id, name FROM devices WHERE id=? AND scope=? AND user=? AND revoked_at IS NULL`).bind(id, scope, user).first<{ id: string; name: string }>();
}

export type CreateResult = { ok: true } | { ok: false; status: 404 | 502 | 503; error: string };
/** After the Worker validated the body: refuse unless the flag is on and the device is the caller's own; then insert the conversation WITH its env columns in one statement, and pin the env in the chat's DO.
 *  `insert` receives the env columns so the caller's single INSERT stays the only place a conversation row is created. */
export async function bindDeviceEnv(env: Env, scope: Scope, user: string, spec: EnvSpec, insert: (cols: { env_kind: string; env_device_id: string; env_dir: string | null; env_user: string }) => Promise<void>, pin: () => Promise<Response>, undo: () => Promise<void>): Promise<CreateResult> {
  if (!env.DEVICES || !(await vclEnvEnabled(env.DB, scope).catch(() => false))) return { ok: false, status: 404, error: "not found" };   // flag off / team / open: indistinguishable from "no such feature"
  let dev: { id: string; name: string } | null;
  try { dev = await ownDevice(env, scope, user, spec.device_id); } catch (e) { console.error("env device lookup", e instanceof Error ? e.message : String(e)); return { ok: false, status: 503, error: "environments unavailable" }; }
  if (!dev) return { ok: false, status: 404, error: "not found" };                                                                       // another user's, revoked or unknown: the same answer
  try { await insert({ env_kind: "device", env_device_id: dev.id, env_dir: spec.dir, env_user: user }); }
  catch (e) { console.error("env insert", e instanceof Error ? e.message : String(e)); return { ok: false, status: 503, error: "environments unavailable" }; } // migration 0042 not applied: nothing was created
  try { const r = await pin(); if (!r.ok) throw new Error(`pin ${r.status}`); }
  catch (e) { console.error("env pin", e instanceof Error ? e.message : String(e)); 
    // A failed compensating DELETE leaves a device row whose chat has no pin. Never swallow it: log it loudly. The row cannot run (ChatSession compares the D1 row with the pin before any dispatch and refuses), and the id is returned to the caller for the log.
    await undo().catch((e2) => console.error("env undo FAILED: orphan device conversation row, it refuses every send until removed", e2 instanceof Error ? e2.message : String(e2)));
    return { ok: false, status: 502, error: "could not set up the environment" }; }
  return { ok: true };
}

/** The env of a conversation for the page: null = a cloud chat (or env columns not there, or flag never used). Derived state, never stored: ready (live + hub online) / offline / revoked / unavailable (flag off, hub error). */
export async function envView(env: Env, scope: Scope, convId: string): Promise<EnvView | null> {
  let row: { env_kind: string | null; env_device_id: string | null; env_dir: string | null; env_user: string | null } | null;
  try { row = await env.DB.prepare(`SELECT env_kind, env_device_id, env_dir, env_user FROM conversations WHERE id=? AND scope=?`).bind(convId, scope).first(); } catch { return null; } // no column yet = no device chats can exist
  if (!row || row.env_kind !== "device" || !row.env_device_id || !row.env_user) return null;
  const base: EnvView = { kind: "device", device_id: row.env_device_id, dir: row.env_dir, name: null, state: "unavailable" };
  try {
    if (!env.DEVICES || !(await vclEnvEnabled(env.DB, scope))) return base;
    const d = await env.DB.prepare(`SELECT name, revoked_at FROM devices WHERE id=? AND scope=? AND user=?`).bind(row.env_device_id, scope, row.env_user).first<{ name: string; revoked_at: number | null }>();
    if (!d || d.revoked_at !== null) return { ...base, name: d?.name ?? null, state: "revoked" };
    const r = await env.DEVICES.get(env.DEVICES.idFromName(row.env_device_id)).fetch(new Request("https://do.internal/state", { headers: { "x-vcl-device": row.env_device_id, "x-vcl-scope": scope, "x-vcl-user": row.env_user } }));
    if (r.status === 410) return { ...base, name: d.name, state: "revoked" };
    if (!r.ok) return { ...base, name: d.name };
    const j = (await r.json()) as { online?: unknown; roots?: unknown };
    const roots = sanitiseRoots(j.roots);
    return { ...base, name: d.name, state: j.online === true ? "ready" : "offline", ...(roots ? { roots } : {}) };
  } catch (e) { console.error("env view", e instanceof Error ? e.message : String(e)); return base; }
}
