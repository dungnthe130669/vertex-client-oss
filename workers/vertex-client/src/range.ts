// HTTP Range (RFC 9110 §14) for serving generated video from R2. iOS Safari will not play a <video> whose server ignores Range: it
// probes with `bytes=0-1` and needs a 206 with Content-Range before it loads anything.
export type ByteRange = { offset: number; length: number };

/** null = no (usable) Range header: serve the whole object with 200. "unsatisfiable" = 416. Only a single range is honoured; a
 *  multi-range request is answered with the full body (allowed by the RFC: a server may ignore Range). */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return /^\s*bytes\s*=/i.test(header) && !header.includes(",") ? "unsatisfiable" : null;
  const [, a, b] = m;
  if (a === "" && b === "") return "unsatisfiable";
  if (a === "") { // suffix: the last N bytes
    const n = Number(b);
    if (!Number.isSafeInteger(n) || n <= 0 || size <= 0) return "unsatisfiable";
    const len = Math.min(n, size);
    return { offset: size - len, length: len };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  let end = b === "" ? size - 1 : Number(b);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  end = Math.min(end, size - 1);
  return { offset: start, length: end - start + 1 };
}

/** Response for one stored object, honouring Range. `get` reads the object (optionally a slice) and returns its body stream. */
export async function rangeResponse(size: number, mime: string, rangeHeader: string | null | undefined, get: (r?: ByteRange) => Promise<ReadableStream | null>, extra: Record<string, string> = {}): Promise<Response> {
  const base = { ...extra, "content-type": mime, "accept-ranges": "bytes" };
  const r = parseRange(rangeHeader, size);
  if (r === "unsatisfiable") return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  const body = await get(r ?? undefined);
  if (!body) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  if (!r) return new Response(body, { status: 200, headers: { ...base, "content-length": String(size) } });
  return new Response(body, { status: 206, headers: { ...base, "content-length": String(r.length), "content-range": `bytes ${r.offset}-${r.offset + r.length - 1}/${size}` } });
}
