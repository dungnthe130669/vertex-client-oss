// Connectors v1: per-scope on/off switches for the one connector vclient has (personal-connector). A switch can only REMOVE tools from
// what the model is offered; it can never add one or change an approval tier (tiers come from tools.ts and are copied through untouched).
import { classify, type ToolDef, type ToolHost } from "./tools";
import { spaceOf, type Scope } from "./scope";
import { parseModes, type Mode } from "./custom-connectors";

export const CONNECTOR_ID = "personal-connector";
export const CONNECTOR_NAME = "personal-connector";

/** `modes` holds the built-in's per-tool "ask" overrides only (Block lives in `disabled`; Always is the default of a read tool and is never offered for an approval tool). */
export interface ConnectorSettings { enabled: boolean; disabled: string[]; modes: Record<string, Mode> }
export const DEFAULT_SETTINGS: ConnectorSettings = { enabled: true, disabled: [], modes: {} };
/** No row yet: Business keeps the default ON; Open is OFF (the personal connector's tool results would go to a non-Vertex provider), until a row for that space enables it. */
export const defaultSettingsFor = (scope: Scope): ConnectorSettings => ({ ...DEFAULT_SETTINGS, enabled: spaceOf(scope) === "biz", disabled: [], modes: {} });

/** Only {name: "ask"} for a known READ tool survives: the sole override that can tighten, never relax, a tier. */
export function parseBuiltinModes(v: unknown): Record<string, Mode> {
  return Object.fromEntries(Object.entries(parseModes(v)).filter(([k, m]) => m === "ask" && classify(k) === "auto"));
}

type Db = { prepare(q: string): { bind(...a: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> } } };

/** Tolerant parse of a stored list: anything that is not an array of known tool names is dropped (a bad row never widens or crashes). */
export function parseDisabled(v: unknown): string[] {
  let a: unknown = v;
  if (typeof v === "string") { try { a = JSON.parse(v); } catch { return []; } }
  return Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === "string" && classify(x) !== null))].sort() : [];
}

/** Settings of this scope. A D1 error throws (callers fail closed: no tools rather than silently-ignored switches). */
export async function loadSettings(db: Db, scope: Scope): Promise<ConnectorSettings> {
  const r = await db.prepare(`SELECT enabled, disabled_tools, tool_modes FROM connector_settings WHERE scope=? AND connector_id=?`).bind(scope, CONNECTOR_ID).first<{ enabled: number; disabled_tools: string; tool_modes: string }>();
  return r ? { enabled: r.enabled !== 0, disabled: parseDisabled(r.disabled_tools), modes: parseBuiltinModes(r.tool_modes) } : defaultSettingsFor(scope);
}

export type ConnectorPatch = { enabled?: unknown; tool?: unknown };
/** Validates a PUT body: `{enabled: boolean}` and/or `{tool: {name, enabled}}` or `{tool: {name, mode}}` (a known, classified tool). Mode: block = off,
 *  ask = ask first, always = run automatically (read tools only: an approval tool can be Ask first or Block, never Always). Returns the next settings. */
export function applyPatch(cur: ConnectorSettings, b: ConnectorPatch): { ok: true; next: ConnectorSettings } | { ok: false; error: string } {
  if (!b || typeof b !== "object") return { ok: false, error: "invalid body" };
  if (b.enabled === undefined && b.tool === undefined) return { ok: false, error: "nothing to change" };
  const next: ConnectorSettings = { enabled: cur.enabled, disabled: [...cur.disabled], modes: { ...cur.modes } };
  if (b.enabled !== undefined) { if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" }; next.enabled = b.enabled; }
  if (b.tool !== undefined) {
    const t = b.tool as { name?: unknown; enabled?: unknown; mode?: unknown };
    if (!t || typeof t !== "object" || typeof t.name !== "string" || (typeof t.enabled !== "boolean" && t.mode === undefined)) return { ok: false, error: "tool must be {name, enabled} or {name, mode}" };
    const tier = classify(t.name);
    if (!tier) return { ok: false, error: "unknown tool" };
    const set = new Set(next.disabled);
    if (t.mode !== undefined) {
      if (t.mode !== "always" && t.mode !== "ask" && t.mode !== "block") return { ok: false, error: "mode must be always, ask or block" };
      if (t.mode === "always" && tier === "approval") return { ok: false, error: "this tool always asks first" };
      if (t.mode === "block") set.add(t.name); else set.delete(t.name);
      if (t.mode === "ask" && tier === "auto") next.modes[t.name] = "ask"; else delete next.modes[t.name];
    } else if (t.enabled) set.delete(t.name); else set.add(t.name);
    next.disabled = [...set].sort();
  }
  return { ok: true, next };
}

export async function saveSettings(db: Db, scope: Scope, s: ConnectorSettings): Promise<void> {
  await db.prepare(`INSERT INTO connector_settings (scope, connector_id, enabled, disabled_tools, tool_modes, updated_at) VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(scope, connector_id) DO UPDATE SET enabled=excluded.enabled, disabled_tools=excluded.disabled_tools, tool_modes=excluded.tool_modes, updated_at=excluded.updated_at`)
    .bind(scope, CONNECTOR_ID, s.enabled ? 1 : 0, JSON.stringify(s.disabled), JSON.stringify(s.modes)).run();
}

/** Composite ToolHost filter: a disabled connector/tool is neither listed nor callable (a stale tool_use from before a toggle must not run).
 *  `approval` can only be raised here (an "ask" override), never downgraded. */
export function filterHost(inner: ToolHost, s: ConnectorSettings): ToolHost {
  const off = new Set(s.disabled);
  const allowed = (n: string) => s.enabled && !off.has(n);
  return {
    async list() { return s.enabled ? (await inner.list()).filter((t) => !off.has(t.name)).map((t) => (s.modes[t.name] === "ask" && !t.approval ? { ...t, approval: true } : t)) : []; },
    async call(name, args) { return allowed(name) ? inner.call(name, args) : { text: `tool ${name} is turned off in Settings → Connectors`, isError: true }; },
  };
}

/** What GET /api/connectors returns for one connector. `tools` is the full (unfiltered, scope-visible) list with each tool's switch. */
export interface ConnectorView {
  id: string; name: string; kind: "internal-binding"; status: "ok" | "unreachable"; error?: string; enabled: boolean; toolCount: number; enabledCount: number;
  tools: Array<{ name: string; description: string; approval: boolean; enabled: boolean; mode: Mode; canAlways: boolean }>;
}
export function connectorView(defs: ToolDef[], s: ConnectorSettings, error?: string): ConnectorView {
  const hidden = new Set(["list_agents"]);
  const tools = defs.filter((t) => classify(t.name) && !hidden.has(t.name)).sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => { const tier = classify(t.name); const off = s.disabled.includes(t.name);
      const mode: Mode = off ? "block" : tier === "approval" || s.modes[t.name] === "ask" ? "ask" : "always";
      return { name: t.name, description: t.description, approval: tier === "approval" || s.modes[t.name] === "ask", enabled: !off, mode, canAlways: tier === "auto" }; }); // per-tool mode, independent of the master switch
  const ok = !error && tools.length > 0;
  return { id: CONNECTOR_ID, name: CONNECTOR_NAME, kind: "internal-binding", status: ok ? "ok" : "unreachable", ...(ok ? {} : { error: (error ?? "no tools returned").slice(0, 200) }),
    enabled: s.enabled, toolCount: tools.length, enabledCount: s.enabled ? tools.filter((t) => t.enabled).length : 0, tools };
}

/** Resolve-once pinning: the first call loads from `load` and stores the result under `store`; every later call returns the stored set, so a toggle
 *  never reaches a conversation that already started (byte-stable tool block). A corrupt pin is re-resolved; a `load` error propagates (nothing pinned). */
export async function pinSettings(store: { get(): string | null; set(v: string): void }, load: () => Promise<ConnectorSettings>): Promise<ConnectorSettings> {
  const e = store.get();
  if (e !== null) {
    try { const v = JSON.parse(e); if (v && typeof v.enabled === "boolean") return { enabled: v.enabled, disabled: parseDisabled(v.disabled), modes: parseBuiltinModes(v.modes) }; } catch { /* corrupt pin: re-resolve below */ }
  }
  const s = await load();
  store.set(JSON.stringify(s));
  return s;
}
