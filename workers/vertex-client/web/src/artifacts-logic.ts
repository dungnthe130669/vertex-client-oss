// Pure helpers for the Artifacts UI (unit-tested in test/artifacts-ui.test.ts).
export const ARTIFACT_TOOL_NAMES = ["create_artifact", "update_artifact"];
export const SVG_MAX_BYTES = 256 * 1024;
export type ArtifactRef = { id: string; title: string; type: "markdown" | "code" | "svg" | "html"; version: number };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The chat card is built only from a create/update_artifact tool result of the exact shape the server emits; anything else stays a plain tool card.
 *  The id is only ever used to ask the server (which checks scope), so a forged result can show text but never reach another scope's data. */
export function parseArtifactResult(tool: string, text: string): ArtifactRef | null {
  if (!ARTIFACT_TOOL_NAMES.includes(tool)) return null;
  try {
    const a = (JSON.parse(text) as { artifact?: Record<string, unknown> }).artifact;
    if (!a || typeof a.id !== "string" || !ID.test(a.id) || typeof a.title !== "string" || typeof a.version !== "number") return null;
    if (a.type !== "markdown" && a.type !== "code" && a.type !== "svg" && a.type !== "html") return null;
    return { id: a.id, title: a.title.slice(0, 120), type: a.type, version: a.version };
  } catch { return null; }
}

export const TYPE_LABEL = { markdown: "Markdown", code: "Code", svg: "SVG", html: "HTML" } as const;

/** "Edited 6d ago" style label. */
export function relTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** First n non-trailing-blank lines of the stored preview, for the gallery thumbnail (CSS clamps the rest). */
export const previewLines = (p: string, n = 6): string => p.split("\n").slice(0, n).join("\n");

/** SVG is shown only as <img src=blob:> (scripts never run in an img). Refuse anything over the cap rather than building a huge blob. */
export const svgOk = (content: string) => content.length <= SVG_MAX_BYTES && /<svg[\s>]/i.test(content);

export function stepVersion(shown: number, versions: number[], dir: -1 | 1): number {
  const i = versions.indexOf(shown);
  const j = Math.min(Math.max(i + dir, 0), versions.length - 1);
  return versions[j] ?? shown;
}

// ---- Download / copy -------------------------------------------------------------------------------------------------
const slug = (t: string) => t.normalize("NFKD").replace(/[^\w\s.-]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60).replace(/^[.-]+/, "") || "artifact";
const LANG_EXT: Record<string, string> = { typescript: "ts", ts: "ts", tsx: "tsx", javascript: "js", js: "js", jsx: "jsx", python: "py", py: "py", json: "json", css: "css", sh: "sh", bash: "sh", shell: "sh", sql: "sql", go: "go", rust: "rs", java: "java", c: "c", cpp: "cpp", ruby: "rb", yaml: "yml", yml: "yml", html: "html", markdown: "md", md: "md", php: "php", kotlin: "kt", swift: "swift", toml: "toml", xml: "xml" };
/** File name + mime for a Blob download. Code uses the language's extension (txt when unknown); the mime is never text/html for non-html. */
export function downloadMeta(a: { title: string; type: ArtifactRef["type"]; language?: string | null }): { name: string; mime: string } {
  const base = slug(a.title);
  if (a.type === "markdown") return { name: `${base}.md`, mime: "text/markdown;charset=utf-8" };
  if (a.type === "svg") return { name: `${base}.svg`, mime: "image/svg+xml" };
  if (a.type === "html") return { name: `${base}.html`, mime: "text/html;charset=utf-8" };
  const ext = LANG_EXT[(a.language ?? "").toLowerCase()] ?? "txt";
  return { name: `${base}.${ext}`, mime: "text/plain;charset=utf-8" };
}

// ---- Line diff (LCS) -------------------------------------------------------------------------------------------------
export type DiffOp = { t: "eq" | "add" | "del"; line: string };
export const DIFF_MAX_LINES = 2000;
/** Line diff old -> new by longest common subsequence (prefix/suffix trimmed first). Returns null when the middle is too large (n*m > cap) so the UI can say so instead of freezing. */
export function lineDiff(oldText: string, newText: string, cap = 4_000_000): DiffOp[] | null {
  const a = oldText.split("\n"), b = newText.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, m = B.length;
  if (n > DIFF_MAX_LINES || m > DIFF_MAX_LINES || n * m > cap) return null;
  const w = m + 1, L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
  const out: DiffOp[] = a.slice(0, s).map((line) => ({ t: "eq" as const, line }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ t: "eq", line: A[i]! }); i++; j++; }
    else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) out.push({ t: "del", line: A[i++]! });
    else out.push({ t: "add", line: B[j++]! });
  }
  while (i < n) out.push({ t: "del", line: A[i++]! });
  while (j < m) out.push({ t: "add", line: B[j++]! });
  for (const line of a.slice(ea)) out.push({ t: "eq", line });
  return out;
}
export const diffStats = (ops: DiffOp[]) => ({ add: ops.filter((o) => o.t === "add").length, del: ops.filter((o) => o.t === "del").length });

// ---- Gallery filter / sort -------------------------------------------------------------------------------------------
export type TypeFilter = "all" | ArtifactRef["type"];
export type SortKey = "recent" | "name";
export const FILTERS: Array<{ key: TypeFilter; label: string }> = [{ key: "all", label: "All" }, { key: "markdown", label: "Markdown" }, { key: "code", label: "Code" }, { key: "svg", label: "SVG" }, { key: "html", label: "HTML" }];
export function viewRows<T extends { type: string; title: string; updatedAt: string }>(rows: T[], filter: TypeFilter, sort: SortKey): T[] {
  const f = filter === "all" ? rows : rows.filter((r) => r.type === filter);
  return sort === "name" ? [...f].sort((x, y) => x.title.localeCompare(y.title, undefined, { sensitivity: "base" })) : [...f].sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0));
}

// ---- HTML viewport presets -------------------------------------------------------------------------------------------
export type Preset = "desktop" | "tablet" | "mobile";
export const PRESET_WIDTH: Record<Preset, string> = { mobile: "390px", tablet: "768px", desktop: "100%" };

// ---- Live version of artifacts seen in the chat (cards update in place when update_artifact bumps the version) ----------
const latest = new Map<string, number>();
const subs = new Set<() => void>();
export function noteArtifactVersion(id: string, version: number): void {
  if ((latest.get(id) ?? 0) >= version) return;
  latest.set(id, version);
  for (const f of subs) f();
}
export const latestArtifactVersion = (id: string, own: number) => Math.max(own, latest.get(id) ?? 0);
export function subscribeArtifactVersions(f: () => void): () => void { subs.add(f); return () => void subs.delete(f); }
