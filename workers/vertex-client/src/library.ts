import { withDevVisibility } from "./dev-visibility";
// Library: every image/video the scope generated, newest first. No index table: generated media lives in R2 under
// vertex-client/<conv>/gen/<uuid>.<ext> (see files.ts genKey), so the list is built from the scope's own conversations (D1, scope filter)
// and one R2 prefix listing per conversation. Nothing outside the caller's conversations is ever listed, so scope isolation is structural.
import { FILE_PREFIX } from "./files";

export const LIBRARY_PAGE = 60;
const MAX_CONVS = 500;
const BATCH = 6;
const EXT: Record<string, { type: "image" | "video"; mime: string }> = {
  png: { type: "image", mime: "image/png" }, jpg: { type: "image", mime: "image/jpeg" }, webp: { type: "image", mime: "image/webp" }, mp4: { type: "video", mime: "video/mp4" },
};
export type LibraryItem = { conv: string; title: string; ref: string; type: "image" | "video"; mime: string; size: number; createdAt: string };
export type LibraryPage = { items: LibraryItem[]; next: string | null };
type Lister = Pick<R2Bucket, "list">;

/** Cursor = "<uploaded ms>~<full key>": strictly older than that (uploaded, then key). null = invalid. */
export function parseCursor(v: string | undefined | null): { ms: number; key: string } | null | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const m = /^(\d{1,15})~(vertex-client\/[0-9a-f-]{36}\/gen\/[A-Za-z0-9._-]{1,100})$/.exec(v);
  return m ? { ms: Number(m[1]), key: m[2] } : null;
}
export const makeCursor = (ms: number, key: string) => `${ms}~${key}`;
const dbMs = (s: string) => { const t = Date.parse(`${s.replace(" ", "T")}Z`); return Number.isFinite(t) ? t : 0; };

export function classifyGenKey(key: string): { type: "image" | "video"; mime: string } | null {
  const i = key.lastIndexOf(".");
  return i < 0 ? null : EXT[key.slice(i + 1).toLowerCase()] ?? null;
}

/** One page for `scope`. `type` filters, `before` pages. A conversation's media can only be newer than its own created_at and older than
 *  its updated_at (+ slack for second-resolution timestamps), which lets the walk stop as soon as a page is certain. */
export async function libraryPage(db: D1Database, files: Lister, scope: string, opts: { type?: "image" | "video"; before?: { ms: number; key: string }; limit?: number; user?: string }): Promise<LibraryPage> {
  const limit = opts.limit ?? LIBRARY_PAGE;
  const run = (dv: string, dva: unknown[]) => db.prepare(`SELECT c.id, c.title, c.updated_at FROM conversations c WHERE c.scope = ?${dv} ORDER BY c.updated_at DESC LIMIT ${MAX_CONVS}`).bind(scope, ...dva).all();
  const convs = ((await (opts.user === undefined ? run("", []) : withDevVisibility("c", opts.user, run))).results ?? []) as Array<{ id: string; title: string; updated_at: string }>;
  const found: Array<LibraryItem & { ms: number; key: string }> = [];
  const older = (ms: number, key: string) => !opts.before || ms < opts.before.ms || (ms === opts.before.ms && key < opts.before.key);
  const order = (a: { ms: number; key: string }, b: { ms: number; key: string }) => b.ms - a.ms || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
  for (let i = 0; i < convs.length; i += BATCH) {
    if (found.length > limit) {
      found.sort(order);
      if (dbMs(convs[i].updated_at) + 5000 < found[limit].ms) break; // every remaining conversation is older than the first item past the page
    }
    await Promise.all(convs.slice(i, i + BATCH).map(async (c) => {
      let cursor: string | undefined;
      for (let round = 0; round < 20; round++) {
        const l = await files.list({ prefix: `${FILE_PREFIX}${c.id}/gen/`, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const o of l.objects) {
          const k = classifyGenKey(o.key);
          if (!k || (opts.type && k.type !== opts.type)) continue;
          const up = (o as { uploaded?: Date | number }).uploaded;
          const ms = up instanceof Date ? up.getTime() : Number(up) || 0;
          if (!older(ms, o.key)) continue;
          found.push({ conv: c.id, title: c.title, ref: o.key.slice(`${FILE_PREFIX}${c.id}/`.length), type: k.type, mime: k.mime, size: Number((o as { size?: number }).size) || 0, createdAt: new Date(ms).toISOString(), ms, key: o.key });
        }
        if (!l.truncated || !(l as { cursor?: string }).cursor) break;
        cursor = (l as { cursor?: string }).cursor;
      }
    }));
  }
  found.sort(order);
  const page = found.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(({ ms: _m, key: _k, ...it }) => it), next: found.length > limit && last ? makeCursor(last.ms, last.key) : null };
}
