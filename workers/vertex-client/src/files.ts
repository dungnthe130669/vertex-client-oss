// Upload rules + helpers for attachments. Files live in R2 (bucket `personal`, prefix vertex-client/<conv>/); messages store a
// `file_ref` block and the engine expands it on every request: image/PDF -> image/document block (Claude only), text/code/CSV
// and extracted Office text -> a text block (any model).
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // the Messages API rejects images over 5 MB (the client downsizes well below this)
/** The company gateway silently drops a Gemini image above ~5 MB decoded (HTTP 200, the model answers blind: gemprobe2), so Gemini gets a 4 MB cap with margin. */
export const GEMINI_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
const GEMINI_NON_CHAT = /tts|image|embedding|live|transcribe|translate|audio|omni/i;
/** A bare (no provider prefix) gateway Gemini CHAT id: the one predicate for "gateway gemini" (turn-engine's isGatewayGemini and the image cap both use it). */
export const isGatewayGeminiId = (id: string | undefined | null): boolean => { const m = id ?? ""; return !m.includes(":") && /^gemini-/.test(m) && !GEMINI_NON_CHAT.test(m); };
/** Bare gateway Grok CHAT id: same silent-failure class as Gemini (the gateway cap is 5 MB decoded), so it shares the 4 MB cap. */
export const isGatewayGrokId = (id: string | undefined | null): boolean => { const m = id ?? ""; return !m.includes(":") && /^grok-/.test(m) && !GEMINI_NON_CHAT.test(m); };
/** Ids that get the 4 MB image cap + history-size rule (Claude keeps MAX_IMAGE_BYTES, unchanged). */
export const isGatewayCappedImageId = (id: string | undefined | null): boolean => isGatewayGeminiId(id) || isGatewayGrokId(id);
export const imageCapFor = (modelId: string | undefined | null): number => (isGatewayCappedImageId(modelId) ? GEMINI_IMAGE_MAX_BYTES : MAX_IMAGE_BYTES);
export const imageTooLargeMessage = (modelId: string | undefined | null): string => `image too large for this model (max ${imageCapFor(modelId) / 1024 / 1024} MB after resizing)`;
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_BYTES = 10 * 1024 * 1024;
export const MAX_OFFICE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
export const FILE_PREFIX = "vertex-client/";
export const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type FileKind = "image" | "pdf" | "text" | "office";
export const OFFICE_MIMES: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const OFFICE_BY_MIME = new Set(Object.values(OFFICE_MIMES));
const TEXT_EXT_MIME: Record<string, string> = {
  txt: "text/plain", log: "text/plain", md: "text/markdown", markdown: "text/markdown", rst: "text/plain",
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", jsonl: "application/json", ndjson: "application/json",
  xml: "application/xml", yaml: "application/yaml", yml: "application/yaml", toml: "text/plain", ini: "text/plain", cfg: "text/plain", conf: "text/plain",
  ts: "text/plain", tsx: "text/plain", js: "text/javascript", jsx: "text/plain", mjs: "text/javascript", cjs: "text/javascript",
  py: "text/x-python", go: "text/plain", rs: "text/plain", java: "text/plain", kt: "text/plain", c: "text/plain", h: "text/plain",
  cpp: "text/plain", hpp: "text/plain", cc: "text/plain", cs: "text/plain", rb: "text/plain", php: "text/plain", sh: "text/x-shellscript", bash: "text/x-shellscript",
  zsh: "text/x-shellscript", sql: "text/plain", swift: "text/plain", lua: "text/plain", pl: "text/plain", r: "text/plain", scala: "text/plain",
  css: "text/css", scss: "text/plain", less: "text/plain", vue: "text/plain", svelte: "text/plain", tf: "text/plain", hcl: "text/plain",
  diff: "text/plain", patch: "text/plain", gradle: "text/plain", dart: "text/plain", ex: "text/plain", exs: "text/plain", hs: "text/plain", proto: "text/plain",
};
const TEXT_BASENAMES = new Set(["dockerfile", "makefile", "readme", "license", "changelog"]);
const TEXT_APP_MIMES = new Set(["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript", "application/x-sh", "application/toml"]);
// Browsers send "" or application/octet-stream for most code files; those are classified by extension instead.
const VAGUE_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

export const extOf = (name: string): string => { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i + 1).toLowerCase(); };
export const isCsvMime = (mime: string) => mime === "text/csv" || mime === "text/tab-separated-values";
export const MIME_BY_EXT = TEXT_EXT_MIME;

/** What an upload is, from its declared mime and (as a fallback) its file name. null = not supported. `mime` is the canonical one stored. */
export function classifyFile(mime: string, name = ""): { kind: FileKind; mime: string } | null {
  const m = mime.split(";")[0].trim().toLowerCase();
  if (IMAGE_MIMES.has(m)) return { kind: "image", mime: m };
  if (m === "application/pdf") return { kind: "pdf", mime: m };
  if (OFFICE_BY_MIME.has(m)) return { kind: "office", mime: m };
  const ext = extOf(name);
  if (VAGUE_MIMES.has(m)) {
    if (OFFICE_MIMES[ext]) return { kind: "office", mime: OFFICE_MIMES[ext] };
    if (ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
    const t = TEXT_EXT_MIME[ext] ?? (!ext && TEXT_BASENAMES.has(name.toLowerCase()) ? "text/plain" : undefined);
    return t ? { kind: "text", mime: t } : null;
  }
  if (m === "text/html" || m === "text/rtf" || m === "text/richtext") return null;
  if (m.startsWith("text/") || TEXT_APP_MIMES.has(m)) return { kind: "text", mime: m === "application/x-yaml" ? "application/yaml" : m };
  return null;
}

export const UNSUPPORTED_MSG = "unsupported file type (images, PDF, text/code, CSV/JSON/Markdown, Word, Excel and PowerPoint only; no audio, video or zip)";
export type FileRef = { ref: string; name: string; mime: string; size: number };

export function cleanName(n: string): string {
  const s = n.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "").slice(0, 80);
  return s || "file";
}

/** null = ok, else the reason (HTTP status alongside). `name` enables the extension fallback for vague mimes. */
export function checkUpload(mime: string, size: number, name = ""): { status: number; error: string } | null {
  const c = classifyFile(mime, name);
  if (!c) return { status: 415, error: UNSUPPORTED_MSG };
  if (!Number.isFinite(size) || size <= 0) return { status: 400, error: "empty file" };
  if (c.kind === "image" && size > MAX_IMAGE_BYTES) return { status: 413, error: "image too large (max 5 MB after resizing)" };
  if (c.kind === "text") {
    const max = isCsvMime(c.mime) ? MAX_CSV_BYTES : MAX_TEXT_BYTES;
    if (size > max) return { status: 413, error: `${isCsvMime(c.mime) ? "CSV" : "text"} file too large (max ${max / 1024 / 1024} MB)` };
  }
  if (c.kind === "office" && size > MAX_OFFICE_BYTES) return { status: 413, error: `document too large (max ${MAX_OFFICE_BYTES / 1024 / 1024} MB)` };
  if (size > MAX_FILE_BYTES) return { status: 413, error: `file too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB)` };
  return null;
}

export const fileKey = (conv: string, name: string) => `${FILE_PREFIX}${conv}/${crypto.randomUUID()}-${cleanName(name)}`;

/** A ref is only valid for the conversation it was uploaded under. */
export const refBelongsTo = (ref: unknown, conv: string): ref is string =>
  typeof conv === "string" && conv.length > 0 && !conv.includes("/") && typeof ref === "string" && ref.startsWith(`${FILE_PREFIX}${conv}/`) && !ref.includes("..") && ref.length < 300;

/** Sidecar holding the text extracted from an Office upload (same prefix, so conversation cleanup covers it). */
export const sidecarKey = (ref: string) => `${ref}.txt`;

export function toBase64(u8: Uint8Array): string {
  let s = ""; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

export interface FileStore {
  get(ref: string): Promise<Uint8Array | null>;
  /** Stored size in bytes without downloading the body (null = missing). */
  size(ref: string): Promise<number | null>;
  /** Write one object (generated images). Absent on read-only stores. */
  put?(ref: string, bytes: Uint8Array, mime: string, conversation: string): Promise<void>;
  /** Best-effort removal (rolling back a partial generation). */
  delete?(refs: string[]): Promise<void>;
}
export const r2Store = (b: R2Bucket): FileStore => ({
  async get(ref) { const o = await b.get(ref); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
  async size(ref) { const o = await b.head(ref); return o ? o.size : null; },
  async put(ref, bytes, mime, conversation) { await b.put(ref, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { httpMetadata: { contentType: mime }, customMetadata: { conversation, generated: "1" } }); },
  async delete(refs) { if (refs.length) await b.delete(refs); },
});

// ---- generated media: same prefix as uploads (vertex-client/<conv>/gen/<uuid>.<ext>), so refBelongsTo, the file endpoint and the
// conversation-delete cleanup (list by prefix) all cover it with no special case.
export const GEN_IMAGE_MIMES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
export const GEN_VIDEO_MIMES: Record<string, string> = { "video/mp4": "mp4" };
export const genKey = (conv: string, mime: string) => `${FILE_PREFIX}${conv}/gen/${crypto.randomUUID()}.${GEN_IMAGE_MIMES[mime] ?? GEN_VIDEO_MIMES[mime] ?? "bin"}`;
/** Reference images the gateway accepts (png/jpeg/webp, <= 7 MB decoded each, max 4). */
export const MAX_REF_IMAGES = 4;
export const MAX_REF_IMAGE_BYTES = 7 * 1024 * 1024;

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- bounds on what the gateway may hand back (checked on the raw base64 BEFORE decoding / allocating / writing to R2).
// Source of the numbers: fleet-vertex-gateway/src/media.ts caps a whole upstream result at MAX_RESULT_CHARS = 60M chars (and sends no
// per-image cap), so the 5 MiB used here before was the attachment INPUT limit, not an output limit; 4K-class models can exceed it.
// 20 MiB decoded per image is generous for a PNG at 4K while keeping the DO (128 MB) safe:
//   - one response may carry at most MAX_GEN_IMAGE_BYTES of image in total (images are summed, see gateway.ts), so its body is
//     <= ceil(20MiB/3)*4 = 27,962,028 base64 chars + 64 KiB of JSON;
//   - calls run GEN_CONCURRENCY = 1 at a time and each result is written to R2 and dropped before the next call, so the worst case in
//     memory is ONE body: ~28 MB bytes + ~28 MB decoded string (chunk copies are freed) + ~21 MB atob output + 21 MB Uint8Array
//     ~= 100 MB transient < 128 MB. n parallel max-size bodies (4 x 28 MB x 3) would not fit, hence sequential.
export const MAX_GEN_IMAGES_PER_RESPONSE = 2; // 1 expected; one spare for a text+image quirk
export const MAX_GEN_IMAGE_BYTES = 20 * 1024 * 1024; // decoded; also the total per response
export const MAX_GEN_IMAGE_B64 = Math.ceil(MAX_GEN_IMAGE_BYTES / 3) * 4;
/** Hard cap on the HTTP body of one /v1/images response (images + a little JSON). */
export const MAX_GEN_BODY_BYTES = MAX_GEN_IMAGE_B64 + 64 * 1024;
/** Aggregate decoded bytes one generation (n calls) may write to R2 (R2 side only: memory is bounded per call, above). */
export const MAX_GEN_TOTAL_BYTES = 4 * MAX_GEN_IMAGE_BYTES;
/** Provider calls in flight at once for one generation. */
export const GEN_CONCURRENCY = 1;

// Generated video (one Omni clip per call): the same 20 MiB decoded / ~28 MB body budget as one image, so the DO memory arithmetic
// above holds unchanged (one body in flight, written to R2 and dropped). Measured: 3 s / 360p = 1.7 MB (smoke report); a 10 s 360p clip is
// ~6 MB. Higher resolutions at 10 s may exceed the cap: they are refused (502, billing uncertain) rather than risking the DO.
export const MAX_GEN_VIDEO_BYTES = 20 * 1024 * 1024;
export const MAX_GEN_VIDEO_B64 = Math.ceil(MAX_GEN_VIDEO_BYTES / 3) * 4;
/** Hard cap on the HTTP body of one /v1/videos response (the clip + a little JSON). */
export const MAX_GEN_VIDEO_BODY_BYTES = MAX_GEN_VIDEO_B64 + 64 * 1024;

/** Decoded size of a base64 string without decoding it (0 for a length that cannot be valid base64). */
export function b64DecodedLen(s: string): number {
  if (s.length % 4 !== 0) return 0;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}
/** null = ok, else why this base64 payload is refused. */
export function genImageProblem(data: string): string | null {
  if (data.length > MAX_GEN_IMAGE_B64) return "image too large";
  if (b64DecodedLen(data) <= 0) return "malformed image data";
  if (b64DecodedLen(data) > MAX_GEN_IMAGE_BYTES) return "image too large";
  return null;
}

/** Same as genImageProblem for a generated clip. */
export function genVideoProblem(data: string): string | null {
  if (data.length > MAX_GEN_VIDEO_B64) return "video too large";
  if (b64DecodedLen(data) <= 0) return "malformed video data";
  if (b64DecodedLen(data) > MAX_GEN_VIDEO_BYTES) return "video too large";
  return null;
}

/** Delete every object under a prefix: re-list until empty (a page of <=1000 at a time, so truncation is honoured), refuse to spin. */
export async function deletePrefix(b: Pick<R2Bucket, "list" | "delete">, prefix: string, maxRounds = 10000): Promise<number> {
  let total = 0, prev = "";
  for (let i = 0; i < maxRounds; i++) {
    const l = await b.list({ prefix, limit: 1000 });
    const keys = l.objects.map((o) => o.key);
    if (!keys.length) { if (l.truncated) throw new Error("r2 list truncated with no objects"); return total; }
    const sig = keys.join("\n");
    if (sig === prev) throw new Error("r2 cleanup made no progress");
    prev = sig;
    await b.delete(keys);
    total += keys.length;
  }
  throw new Error("r2 cleanup did not finish");
}

/** Conversation teardown order, shared by the DO's /destroy: R2 objects first, local storage only after that succeeded. A thrown/failed sweep
 *  leaves `clear` uncalled so the transcript stays readable and the whole delete can be retried. */
export async function destroyOrdered(files: Pick<R2Bucket, "list" | "delete"> | null | undefined, conv: string | null, clear: () => Promise<void>): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (files) {
    if (!conv) return { ok: false, status: 400, error: "conversation id required" };
    try { await deletePrefix(files, `${FILE_PREFIX}${conv}/`); } catch (e) { console.error("files cleanup", String(e)); return { ok: false, status: 500, error: "file cleanup failed; conversation not deleted, retry" }; }
  }
  await clear();
  return { ok: true };
}
