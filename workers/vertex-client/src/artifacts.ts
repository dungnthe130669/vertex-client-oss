// Artifacts v1a/v1b: documents the model creates (markdown | code | svg | html) through the client-side tools create_artifact / update_artifact.
// D1 holds metadata (migrations/0016_artifacts.sql), R2 FILES holds each version's text under vertex-client/artifacts/<scope-hash>/<id>/v<n>.
// Rules: every query filters by scope; the R2 key is always rebuilt from the verified row (scope + id + version), never taken from the client;
// only `main` is offered the tools (everyone else gets an empty host), and rows are never rendered as HTML by the server (the web client shows
// markdown through the sanitized renderer, code as text, svg only as an <img> blob). html (model-authored JS/CSS) is the one exception: it is served ONLY by GET /af/:id/:version,
// a session-less route (HMAC view token) whose CSP `sandbox` makes the document an opaque origin, and the app embeds it only in <iframe sandbox="allow-scripts">.
import type { Context, Hono } from "hono";
import { ARTIFACT_TOOLS, type ToolDef, type ToolHost } from "./tools";
import { isE2eBase, guardPersonal, isMainBase, mayUsePersonalFeatures, parseScope, type Scope } from "./scope";
import { FILE_PREFIX, deletePrefix } from "./files";
import { ARTIFACT_FRAME_HEADERS } from "./headers";

export const ARTIFACT_TYPES = ["markdown", "code", "svg", "html"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
export const MAX_CONTENT_BYTES = 256 * 1024;
export const MAX_TITLE = 120;
export const MAX_ARTIFACTS = 500;
export const MAX_SCOPE_BYTES = 200 * 1024 * 1024;
export const MAX_WRITES_PER_TURN = 10;
export const MAX_VERSIONS = 50;
export const PREVIEW_CHARS = 200;
export const PAGE = 30;
export const UNDO_GRACE_MS = 10 * 60 * 1000;
const LANG = /^[A-Za-z0-9+#._-]{1,32}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const enc = new TextEncoder();

export interface Row { id: string; scope: string; conv_id: string | null; title: string; type: ArtifactType; language: string | null; current_version: number; preview: string; bytes: number; created_at: string; updated_at: string; deleted_at: string | null }
export interface Deps { db: D1Database; files: Pick<R2Bucket, "get" | "put" | "delete" | "list"> | undefined; scope: Scope; conv: string | null }
type Res<T> = { ok: true; v: T } | { ok: false; status: number; error: string };
const fail = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

export const byteLen = (s: string) => enc.encode(s).length;
export async function scopeHash(scope: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`artifacts:${scope}`)));
  return [...d.slice(0, 12)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
/** The only way an R2 key is built: from a verified row's scope + id and a numeric version. */
export async function artifactKey(scope: string, id: string, version: number): Promise<string> {
  if (!ID.test(id) || !Number.isInteger(version) || version < 1) throw new Error("bad artifact key input");
  return `${FILE_PREFIX}artifacts/${await scopeHash(scope)}/${id}/v${version}`;
}
const prefixOf = async (scope: string, id: string) => `${FILE_PREFIX}artifacts/${await scopeHash(scope)}/${id}/`;

export interface Input { title?: unknown; type?: unknown; language?: unknown; content?: unknown }
/** Pure validation. Errors are written for the model to read and act on. */
export function validateInput(a: Input, creating: boolean): Res<{ title?: string; type?: ArtifactType; language: string | null; content: string }> {
  const o = (a ?? {}) as Input;
  let title: string | undefined, type: ArtifactType | undefined, language: string | null = null;
  if (creating || o.title !== undefined) {
    if (typeof o.title !== "string" || !o.title.trim()) return fail(400, "title is required (a short plain-text name)");
    title = o.title.trim();
    if (title.length > MAX_TITLE) return fail(400, `title is ${title.length} characters; the limit is ${MAX_TITLE}`);
  }
  if (creating) {
    if (typeof o.type !== "string" || !(ARTIFACT_TYPES as readonly string[]).includes(o.type)) return fail(400, `type must be one of: ${ARTIFACT_TYPES.join(", ")}`);
    type = o.type as ArtifactType;
    if (type === "code" && o.language !== undefined && o.language !== null && o.language !== "") {
      if (typeof o.language !== "string" || !LANG.test(o.language)) return fail(400, "language must be a short name such as typescript or python");
      language = o.language;
    }
  }
  if (typeof o.content !== "string" || !o.content.trim()) return fail(400, "content is required and must be a non-empty string");
  const n = byteLen(o.content);
  if (n > MAX_CONTENT_BYTES) return fail(413, `content is ${n} bytes; the limit is ${MAX_CONTENT_BYTES} (256 KB). Shorten it, or split it into several artifacts.`);
  if (type === "svg" && !/<svg[\s>]/i.test(o.content)) return fail(400, "an svg artifact's content must be a complete <svg>…</svg> document");
  return { ok: true, v: { title, type, language, content: o.content } };
}

const COLS = "id, scope, conv_id, title, type, language, current_version, preview, bytes, created_at, updated_at, deleted_at";
export const preview = (s: string) => s.slice(0, PREVIEW_CHARS);
const nowIso = () => new Date().toISOString();

async function getRow(d: Pick<Deps, "db" | "scope">, id: string, includeDeleted = false): Promise<Row | null> {
  if (!ID.test(id)) return null;
  return d.db.prepare(`SELECT ${COLS} FROM artifacts WHERE id=? AND scope=?${includeDeleted ? "" : " AND deleted_at IS NULL AND current_version>=1"}`).bind(id, d.scope).first<Row>();
}

async function usage(d: Deps): Promise<{ n: number; bytes: number }> {
  const c = await d.db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE scope=? AND deleted_at IS NULL`).bind(d.scope).first<{ n: number }>();
  const b = await d.db.prepare(`SELECT COALESCE(SUM(v.bytes),0) AS b FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.scope=? AND a.deleted_at IS NULL`).bind(d.scope).first<{ b: number }>();
  return { n: c?.n ?? 0, bytes: b?.b ?? 0 };
}
async function writesThisTurn(d: Deps, turn: number): Promise<number> {
  if (!d.conv) return 0;
  const r = await d.db.prepare(`SELECT COUNT(*) AS n FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id WHERE a.scope=? AND v.conv_id=? AND v.turn=?`).bind(d.scope, d.conv, turn).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Serialize every mutation of one scope inside this isolate. The engine runs a turn's tool calls with Promise.all, so without this N parallel creates would all pass
 *  the per-turn / quota checks before any of them wrote. (Count quota is additionally enforced atomically in the INSERT; cross-isolate races on the byte quota are bounded
 *  by one write of <= 256 KB each.) */
const chains = new Map<string, Promise<unknown>>();
export function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

const nextVersion = async (d: Pick<Deps, "db">, id: string) => ((await d.db.prepare(`SELECT COALESCE(MAX(version),0) AS m FROM artifact_versions WHERE artifact_id=?`).bind(id).first<{ m: number }>())?.m ?? 0) + 1;

/** Undo a reserved version: its R2 object first, then its row (one retry each). Returns false if a leftover remains (the row without bytes is then still removed on the next write's
 *  version numbering, because numbering is MAX+1, so a leftover never wedges the artifact). */
async function release(d: Deps, id: string, scope: string, n: number): Promise<boolean> {
  let ok = true;
  for (let i = 0; i < 2; i++) { try { await d.files?.delete(await artifactKey(scope, id, n)); ok = true; break; } catch (e) { ok = false; console.error("artifact release r2", String(e)); } }
  for (let i = 0; i < 2; i++) { try { await d.db.prepare(`DELETE FROM artifact_versions WHERE artifact_id=? AND version=?`).bind(id, n).run(); return ok; } catch (e) { ok = false; console.error("artifact release row", String(e)); } }
  return false;
}

/** Write the next version of `row` (D1 version row first: its PK is the guard against two writers; then R2; then the artifact row). Every failure after the reservation is
 *  compensated, so a failed write leaves neither a version row nor an R2 object behind. */
async function putVersion(d: Deps, row: Pick<Row, "id" | "scope">, content: string, turn: number | null, meta?: Partial<Row>): Promise<Res<number>> {
  if (!d.files) return fail(503, "artifact storage is not configured");
  const n = await nextVersion(d, row.id);
  const key = await artifactKey(row.scope, row.id, n);
  const bytes = byteLen(content), ts = nowIso();
  try { await d.db.prepare(`INSERT INTO artifact_versions (artifact_id, version, r2_key, bytes, created_at, conv_id, turn) VALUES (?,?,?,?,?,?,?)`).bind(row.id, n, key, bytes, ts, d.conv, turn).run(); }
  catch { return fail(409, "the artifact changed while you were writing; read it again and retry"); }
  try { await d.files.put(key, content, { httpMetadata: { contentType: "text/plain; charset=utf-8" } }); }
  catch (e) { console.error("artifact r2 put", String(e)); await release(d, row.id, row.scope, n); return fail(500, "could not store the artifact; try again"); }
  try { await d.db.prepare(`UPDATE artifacts SET current_version=?, preview=?, bytes=?, updated_at=?, title=COALESCE(?, title) WHERE id=? AND scope=?`).bind(n, preview(content), bytes, ts, meta?.title ?? null, row.id, row.scope).run(); }
  catch (e) { console.error("artifact row update", String(e)); await release(d, row.id, row.scope, n); return fail(500, "could not save the artifact; try again"); }
  await prune(d, row);
  return { ok: true, v: n };
}

/** Keep MAX_VERSIONS per artifact: drop the oldest non-current ones. The D1 row goes FIRST (a version is exposed only while its bytes exist); if the R2 delete then fails the row is
 *  put back (the bytes still exist), so the prune stays retryable on the next write. */
async function prune(d: Deps, row: Pick<Row, "id" | "scope">) {
  try {
    const cur = await d.db.prepare(`SELECT current_version AS c FROM artifacts WHERE id=? AND scope=?`).bind(row.id, row.scope).first<{ c: number }>();
    const all = (await d.db.prepare(`SELECT version, r2_key, bytes, created_at, conv_id, turn FROM artifact_versions WHERE artifact_id=? ORDER BY version ASC`).bind(row.id).all<{ version: number; r2_key: string; bytes: number; created_at: string; conv_id: string | null; turn: number | null }>()).results;
    const extra = all.length - MAX_VERSIONS;
    if (extra <= 0 || !cur) return;
    for (const v of all.filter((x) => x.version !== cur.c).slice(0, extra)) {
      await d.db.prepare(`DELETE FROM artifact_versions WHERE artifact_id=? AND version=?`).bind(row.id, v.version).run();
      try { await d.files?.delete(await artifactKey(row.scope, row.id, v.version)); }
      catch (e) {
        console.error("artifact prune r2", String(e));
        await d.db.prepare(`INSERT INTO artifact_versions (artifact_id, version, r2_key, bytes, created_at, conv_id, turn) VALUES (?,?,?,?,?,?,?)`).bind(row.id, v.version, v.r2_key, v.bytes, v.created_at, v.conv_id, v.turn).run().catch(() => {});
        return;
      }
    }
  } catch (e) { console.error("artifact prune", String(e)); }
}

export interface Summary { id: string; title: string; type: ArtifactType; language: string | null; version: number; bytes: number; createdAt: string; updatedAt: string }
const summary = (r: Row): Summary => ({ id: r.id, title: r.title, type: r.type, language: r.language, version: r.current_version, bytes: r.bytes, createdAt: r.created_at, updatedAt: r.updated_at });

export const createArtifact = (d: Deps, a: Input, turn: number | null) => serial(d.scope, () => createInner(d, a, turn));
async function createInner(d: Deps, a: Input, turn: number | null): Promise<Res<Summary>> {
  const v = validateInput(a, true);
  if (!v.ok) return v;
  if (turn !== null && (await writesThisTurn(d, turn)) >= MAX_WRITES_PER_TURN) return fail(429, `at most ${MAX_WRITES_PER_TURN} artifact creates/updates per turn; continue in your next reply`);
  const u = await usage(d);
  if (u.n >= MAX_ARTIFACTS) return fail(409, `the artifact limit (${MAX_ARTIFACTS}) is reached; ask the user to delete some`);
  if (u.bytes + byteLen(v.v.content) > MAX_SCOPE_BYTES) return fail(409, "the artifact storage limit (200 MB) is reached; ask the user to delete some");
  const id = crypto.randomUUID(), ts = nowIso();
  // The count quota is enforced atomically in the INSERT itself (in-flight reservations count too), not only by the check above.
  const ins = await d.db.prepare(`INSERT INTO artifacts (id, scope, conv_id, title, type, language, current_version, preview, bytes, created_at, updated_at) SELECT ?,?,?,?,?,?,0,'',0,?,? WHERE (SELECT COUNT(*) FROM artifacts WHERE scope=? AND deleted_at IS NULL) < ${MAX_ARTIFACTS} RETURNING id`)
    .bind(id, d.scope, d.conv, v.v.title!, v.v.type!, v.v.type === "code" ? v.v.language : null, ts, ts, d.scope).first<{ id: string }>();
  if (!ins) return fail(409, `the artifact limit (${MAX_ARTIFACTS}) is reached; ask the user to delete some`);
  const w = await putVersion(d, { id, scope: d.scope }, v.v.content, turn);
  if (!w.ok) {
    // remove the parent reservation; if even that fails the row stays at current_version=0 (hidden) and the cron sweep removes it after the grace
    await d.db.prepare(`DELETE FROM artifacts WHERE id=? AND scope=? AND current_version=0`).bind(id, d.scope).run().catch((e) => console.error("artifact create cleanup", String(e)));
    return w;
  }
  return { ok: true, v: summary((await getRow(d, id))!) };
}

export const updateArtifact = (d: Deps, id: unknown, a: Input, turn: number | null) => serial(d.scope, () => updateInner(d, id, a, turn));
async function updateInner(d: Deps, id: unknown, a: Input, turn: number | null): Promise<Res<Summary>> {
  if (typeof id !== "string") return fail(400, "id is required");
  const v = validateInput({ title: a.title, content: a.content }, false);
  if (!v.ok) return v;
  const row = await getRow(d, id);
  if (!row) return fail(404, "artifact not found (wrong id, or it was deleted); use create_artifact for a new one");
  if (turn !== null && (await writesThisTurn(d, turn)) >= MAX_WRITES_PER_TURN) return fail(429, `at most ${MAX_WRITES_PER_TURN} artifact creates/updates per turn; continue in your next reply`);
  const u = await usage(d);
  if (u.bytes + byteLen(v.v.content) > MAX_SCOPE_BYTES) return fail(409, "the artifact storage limit (200 MB) is reached; ask the user to delete some");
  if (row.type === "svg" && !/<svg[\s>]/i.test(v.v.content)) return fail(400, "an svg artifact's content must be a complete <svg>…</svg> document");
  const w = await putVersion(d, row, v.v.content, turn, { title: v.v.title });
  return w.ok ? { ok: true, v: summary((await getRow(d, id))!) } : w;
}

/** Restore = a NEW version holding an old version's text (history is never rewritten). */
export const restoreVersion = (d: Deps, id: string, version: number) => serial(d.scope, () => restoreInner(d, id, version));
async function restoreInner(d: Deps, id: string, version: number): Promise<Res<Summary>> {
  const row = await getRow(d, id);
  if (!row) return fail(404, "not found");
  const old = await readVersion(d, row, version);
  if (!old.ok) return old;
  if ((await usage(d)).bytes + byteLen(old.v) > MAX_SCOPE_BYTES) return fail(409, "the artifact storage limit (200 MB) is reached; delete some artifacts first");
  const w = await putVersion(d, row, old.v, null);
  return w.ok ? { ok: true, v: summary((await getRow(d, id))!) } : w;
}

async function readVersion(d: Deps, row: Row, version: number): Promise<Res<string>> {
  if (!d.files) return fail(503, "artifact storage is not configured");
  if (!Number.isInteger(version) || version < 1) return fail(400, "bad version");
  const ex = await d.db.prepare(`SELECT version FROM artifact_versions WHERE artifact_id=? AND version=?`).bind(row.id, version).first();
  if (!ex) return fail(404, "no such version");
  const o = await d.files.get(await artifactKey(row.scope, row.id, version));
  if (!o) { // a version row without bytes (a compensation that could not finish) heals itself on first read; the current version is never touched
    if (version !== row.current_version) await d.db.prepare(`DELETE FROM artifact_versions WHERE artifact_id=? AND version=?`).bind(row.id, version).run().catch(() => {});
    return fail(404, "version content is missing");
  }
  return { ok: true, v: new TextDecoder().decode(await o.arrayBuffer()) };
}

export async function getArtifact(d: Deps, id: string, version?: number) {
  const row = await getRow(d, id);
  if (!row) return fail(404, "not found");
  const r = await readVersion(d, row, version ?? row.current_version);
  if (!r.ok) return r;
  const versions = (await d.db.prepare(`SELECT version, bytes, created_at AS createdAt FROM artifact_versions WHERE artifact_id=? ORDER BY version ASC`).bind(row.id).all<{ version: number; bytes: number; createdAt: string }>()).results;
  return { ok: true as const, v: { ...summary(row), shown: version ?? row.current_version, content: r.v, versions } };
}

const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
export async function listArtifacts(d: Pick<Deps, "db" | "scope">, q: string, cursor: string | null, deleted = false): Promise<Res<{ items: Array<Summary & { preview: string }>; next: string | null }>> {
  const args: unknown[] = [d.scope];
  // deleted=true: the "Deleted" tab = soft-deleted rows still inside the undo window (older ones are swept), newest deletion first, one page.
  if (deleted) {
    const cutoff = new Date(Date.now() - UNDO_GRACE_MS).toISOString();
    const rows = (await d.db.prepare(`SELECT ${COLS} FROM artifacts WHERE scope=? AND deleted_at IS NOT NULL AND deleted_at>=? AND current_version>=1 ORDER BY deleted_at DESC, id DESC LIMIT ${PAGE}`).bind(d.scope, cutoff).all<Row>()).results;
    return { ok: true, v: { items: rows.map((r) => ({ ...summary(r), preview: r.preview })), next: null } };
  }
  let where = `scope=? AND deleted_at IS NULL AND current_version>=1`;
  const term = q.trim().slice(0, 100);
  if (term) { where += ` AND (title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')`; const p = `%${likeEsc(term)}%`; args.push(p, p); }
  if (cursor) {
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\|([0-9a-f-]{36})$/.exec(cursor);
    if (!m) return fail(400, "bad cursor");
    where += ` AND (updated_at < ? OR (updated_at = ? AND id < ?))`; args.push(m[1], m[1], m[2]);
  }
  const rows = (await d.db.prepare(`SELECT ${COLS} FROM artifacts WHERE ${where} ORDER BY updated_at DESC, id DESC LIMIT ${PAGE + 1}`).bind(...args).all<Row>()).results;
  const page = rows.slice(0, PAGE);
  return { ok: true, v: { items: page.map((r) => ({ ...summary(r), preview: r.preview })), next: rows.length > PAGE ? `${page[PAGE - 1]!.updated_at}|${page[PAGE - 1]!.id}` : null } };
}

/** Soft delete now (so it disappears at once and Undo works); sweepDeleted removes rows + R2 after UNDO_GRACE_MS. */
export async function deleteArtifact(d: Deps, id: string): Promise<Res<null>> {
  if (!(await getRow(d, id))) return fail(404, "not found");
  await d.db.prepare(`UPDATE artifacts SET deleted_at=? WHERE id=? AND scope=? AND deleted_at IS NULL`).bind(nowIso(), id, d.scope).run();
  return { ok: true, v: null };
}
export const undeleteArtifact = (d: Deps, id: string) => serial(d.scope, () => undeleteInner(d, id));
async function undeleteInner(d: Deps, id: string): Promise<Res<null>> {
  const row = await getRow(d, id, true);
  if (!row || !row.deleted_at) return fail(404, "not found");
  if (Date.now() - Date.parse(row.deleted_at) > UNDO_GRACE_MS) return fail(410, "too late to undo");
  // reactivating it adds one artifact and ALL of its versions' bytes back to the live totals
  const u = await usage(d);
  const mine = (await d.db.prepare(`SELECT COALESCE(SUM(bytes),0) AS b FROM artifact_versions WHERE artifact_id=?`).bind(row.id).first<{ b: number }>())?.b ?? 0;
  if (u.n + 1 > MAX_ARTIFACTS) return fail(409, `the artifact limit (${MAX_ARTIFACTS}) is reached; delete another artifact first`);
  if (u.bytes + mine > MAX_SCOPE_BYTES) return fail(409, "the artifact storage limit (200 MB) would be exceeded; delete another artifact first");
  await d.db.prepare(`UPDATE artifacts SET deleted_at=NULL WHERE id=? AND scope=?`).bind(id, d.scope).run();
  return { ok: true, v: null };
}

/** Cron pass: hard-delete artifacts soft-deleted longer than the undo grace ago (R2 objects first; a failed sweep leaves the row for the next pass). */
export async function sweepDeleted(db: D1Database, files: Pick<R2Bucket, "list" | "delete"> | undefined, now = Date.now(), batch = 20): Promise<number> {
  if (!files) return 0;
  const cutoff = new Date(now - UNDO_GRACE_MS).toISOString();
  // reservations a failed create could not remove (current_version=0, never exposed): same grace, same R2 + row cleanup
  await db.prepare(`UPDATE artifacts SET deleted_at=? WHERE current_version=0 AND deleted_at IS NULL AND created_at < ?`).bind(nowIso(), cutoff).run().catch(() => {});
  const rows = (await db.prepare(`SELECT id, scope FROM artifacts WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ${batch}`).bind(cutoff).all<{ id: string; scope: string }>()).results;
  let n = 0;
  for (const r of rows) {
    try {
      await deletePrefix(files, await prefixOf(r.scope, r.id));
      await db.prepare(`DELETE FROM artifact_versions WHERE artifact_id=?`).bind(r.id).run();
      await db.prepare(`DELETE FROM artifacts WHERE id=? AND scope=? AND deleted_at IS NOT NULL`).bind(r.id, r.scope).run();
      n++;
    } catch (e) { console.error("artifact sweep", r.id, String(e)); }
  }
  return n;
}

// ---- the model-facing tools ----
export const ARTIFACT_TOOL_DEFS: ToolDef[] = [
  { name: "create_artifact", approval: false,
    description: "Create a standalone document the user will keep and reuse (a report, README, plan, script, config, diagram). type: markdown | code | svg | html. For code give `language`. html is one self-contained page (inline <style> and <script> only; no external scripts, fonts, images or network access - they are blocked; use data: URIs) shown in a sandbox: use it for an interactive demo, calculator, chart or small tool. Content is the complete text (max 256 KB). Returns the artifact id; to change it later call update_artifact with that id. Do not use for short snippets or chat answers.",
    input_schema: { type: "object", properties: { title: { type: "string", description: "Short name, max 120 characters" }, type: { type: "string", enum: [...ARTIFACT_TYPES] }, language: { type: "string", description: "For type=code: e.g. typescript, python, bash" }, content: { type: "string", description: "The full document text" } }, required: ["title", "type", "content"] } },
  { name: "update_artifact", approval: false,
    description: "Replace the content of an artifact you created, as a new version. Send the COMPLETE new content, not a diff. Optionally rename with title.",
    input_schema: { type: "object", properties: { id: { type: "string", description: "The id returned by create_artifact" }, content: { type: "string", description: "The full new document text" }, title: { type: "string" } }, required: ["id", "content"] } },
];

/** Artifact tools for one conversation. Only `main` gets any (the table in chat-session also gates this; this is the second lock). */
export function artifactTools(d: Deps): ToolHost {
  const on = isMainBase(d.scope);
  return {
    async list() { return on ? ARTIFACT_TOOL_DEFS : []; },
    async call(name, args, ctx) {
      if (!on || !ARTIFACT_TOOLS.has(name)) return { text: `tool ${name} is not available for this account`, isError: true };
      const a = (args ?? {}) as Record<string, unknown>;
      try {
        const r = name === "create_artifact" ? await createArtifact(d, a, ctx?.turn ?? null) : await updateArtifact(d, a.id, a, ctx?.turn ?? null);
        if (!r.ok) return { text: r.error, isError: true };
        const s = r.v;
        return { text: JSON.stringify({ artifact: { id: s.id, title: s.title, type: s.type, version: s.version } }), isError: false };
      } catch (e) { console.error("artifact tool", String(e)); return { text: "artifact tool failed; try again", isError: true }; }
    },
  };
}

/** Base host + artifact host as one: sorted by name overall (the tool block is a cache breakpoint), calls routed by name. */
export function withArtifacts(base: ToolHost, art: ToolHost): ToolHost {
  return {
    async list() {
      const [a, b] = await Promise.all([base.list(), art.list()]);
      const taken = new Set(b.map((t) => t.name));
      return [...a.filter((t) => !taken.has(t.name)), ...b].sort((x, y) => x.name.localeCompare(y.name));
    },
    call: (name, args, ctx) => (ARTIFACT_TOOLS.has(name) ? art.call(name, args, ctx) : base.call(name, args, ctx)),
  };
}

// ---- html view tokens (GET /af/:id/:version?t=...) ----
// The frame route has no session: access = a short-lived HMAC token over {id, version, scope, exp}, minted by the authenticated POST /api/artifacts/:id/view.
// The key is HKDF-derived from SESSION_SECRET with its own info string (no new secret, and a token can never be confused with a session cookie).
export const VIEW_TTL_S = 5 * 60;
const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string): Uint8Array<ArrayBuffer> | null => {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try { return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)); } catch { return null; }
};
async function viewKey(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("artifact-view") }, ikm, { name: "HMAC", hash: "SHA-256", length: 256 }, false, [usage]);
}
export interface ViewClaims { i: string; v: number; s: string; e: number }
export async function mintViewToken(secret: string, c: { id: string; version: number; scope: string }, nowS = Math.floor(Date.now() / 1000)): Promise<{ token: string; exp: number }> {
  const exp = nowS + VIEW_TTL_S;
  const body = b64u(enc.encode(JSON.stringify({ i: c.id, v: c.version, s: c.scope, e: exp } satisfies ViewClaims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await viewKey(secret, "sign"), enc.encode(body)));
  return { token: `${body}.${b64u(sig)}`, exp };
}
/** Claims of a token whose signature (constant-time, via subtle.verify) and expiry hold; null for anything else. The caller still compares id/version to the URL. */
export async function verifyViewToken(secret: string | undefined, token: string, nowS = Math.floor(Date.now() / 1000)): Promise<ViewClaims | null> {
  if (!secret || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [p0, p1] = [parts[0]!, parts[1]!];
  const sig = unb64u(p1), raw = unb64u(p0);
  if (!sig || !raw) return null;
  if (!(await crypto.subtle.verify("HMAC", await viewKey(secret, "verify"), sig, enc.encode(p0)))) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(raw)) as Partial<ViewClaims>;
    if (typeof c.i !== "string" || typeof c.s !== "string" || !Number.isInteger(c.v) || !Number.isInteger(c.e) || (c.e as number) < nowS) return null;
    return c as ViewClaims;
  } catch { return null; }
}

/** GET /af/:id/:version?t=<token> - the html document itself. Mounted OUTSIDE /api (no session, no cookie auth); its headers replace the app's (withSecurityHeaders + ARTIFACT_FRAME_HEADERS).
 *  Fail closed: bad/expired/mismatched token -> bare 403; scope that may not use artifacts, wrong scope, soft-deleted, non-html or missing version -> bare 404. */
export function artifactFrameRoute(app: Hono<any>) {
  const reply = (status: number, body: string | null = null) => new Response(body, { status, headers: { ...ARTIFACT_FRAME_HEADERS, ...(status === 200 ? { "content-type": "text/html; charset=utf-8" } : {}) } });
  app.get("/af/:id/:version", async (c: Ctx) => {
    const id = c.req.param("id") ?? "", vs = c.req.param("version") ?? "";
    if (!ID.test(id) || !/^\d{1,6}$/.test(vs)) return reply(404);
    const claims = await verifyViewToken(c.env.SESSION_SECRET, c.req.query("t") ?? "");
    if (!claims || claims.i !== id || claims.v !== Number(vs)) return reply(403);
    const sc = parseScope(claims.s); // the storage scope the token was minted for (either space); the row is read with exactly it
    if (!sc || !mayUsePersonalFeatures(sc)) return reply(404);
    const d: Deps = { db: c.env.DB, files: c.env.FILES, scope: sc, conv: null };
    const row = await getRow(d, id);
    if (!row || row.type !== "html") return reply(404);
    const r = await readVersion(d, row, claims.v);
    return r.ok ? reply(200, r.v) : reply(404);
  });
  app.all("/af/*", () => reply(404)); // anything else under /af/ is not a frame URL
}

// ---- HTTP ----
type Ctx = Context<any>;
export function artifactRoutes(app: Hono<any>, scopeOf: (c: Ctx) => Scope) {
  guardPersonal(app, "/api/artifacts", scopeOf); // main + e2e bases (either space); every g:* gets 403 before any handler
  const noStore = { "cache-control": "no-store" };
  const deps = (c: Ctx): Deps => ({ db: c.env.DB, files: c.env.FILES, scope: scopeOf(c), conv: null });
  const out = (c: Ctx, r: Res<unknown>, ok = 200) => (r.ok ? c.json(r.v as object, ok as 200, noStore) : c.json({ error: r.error }, r.status as 400, noStore));
  app.get("/api/artifacts", async (c) => out(c, await listArtifacts(deps(c), c.req.query("q") ?? "", c.req.query("cursor") || null, c.req.query("deleted") === "1")));
  // Test-data seam: the e2e tester has no model that can call the tools, so it may create rows in ITS OWN scope. main only ever creates through the model.
  app.post("/api/artifacts", async (c) => {
    if (!isE2eBase(scopeOf(c))) return c.json({ error: "forbidden" }, 403);
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as Input & { id?: unknown };
    if (b.id !== undefined) return out(c, await updateArtifact(deps(c), b.id, b, null)); // a further version of a row it seeded (still scope-checked)
    return out(c, await createArtifact(deps(c), b, null), 201);
  });
  app.get("/api/artifacts/:id", async (c) => {
    const vq = c.req.query("v");
    const v = vq === undefined ? undefined : /^\d{1,6}$/.test(vq) ? Number(vq) : NaN;
    return out(c, await getArtifact(deps(c), c.req.param("id"), v));
  });
  app.delete("/api/artifacts/:id", async (c) => out(c, await deleteArtifact(deps(c), c.req.param("id")).then((r) => (r.ok ? { ok: true as const, v: { ok: true } } : r))));
  app.post("/api/artifacts/:id/undelete", async (c) => out(c, await undeleteArtifact(deps(c), c.req.param("id")).then((r) => (r.ok ? { ok: true as const, v: { ok: true } } : r))));
  // Mint a short-lived view URL for an html artifact (main + e2e only: guardPrefix above; CSRF + same-origin come from the /api gate).
  app.post("/api/artifacts/:id/view", async (c) => {
    if (!c.env.SESSION_SECRET) return c.json({ error: "view tokens are not configured" }, 503, noStore);
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { version?: unknown };
    const d = deps(c), row = await getRow(d, c.req.param("id"));
    if (!row) return c.json({ error: "not found" }, 404, noStore);
    if (row.type !== "html") return c.json({ error: "only html artifacts have a frame" }, 400, noStore);
    const version = b.version === undefined ? row.current_version : b.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return c.json({ error: "bad version" }, 400, noStore);
    if (!(await d.db.prepare(`SELECT version FROM artifact_versions WHERE artifact_id=? AND version=?`).bind(row.id, version).first())) return c.json({ error: "no such version" }, 404, noStore);
    const { token, exp } = await mintViewToken(c.env.SESSION_SECRET, { id: row.id, version, scope: d.scope });
    return c.json({ url: `/af/${row.id}/${version}?t=${token}`, expiresAt: exp }, 200, noStore);
  });
  app.post("/api/artifacts/:id/restore", async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as { version?: unknown };
    if (typeof b.version !== "number") return c.json({ error: "version required" }, 400, noStore);
    return out(c, await restoreVersion(deps(c), c.req.param("id"), b.version));
  });
}
