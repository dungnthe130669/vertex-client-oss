// GET /api/version payload: what is deployed. build/commit/builtAt come from /version.json in the static assets (written by the client
// build, same values stamped into sw.js); worker_version_id from the version_metadata binding. Anything missing or malformed is null.
export type VersionReply = { worker_version_id: string | null; build: string | null; commit: string | null; builtAt: string | null };

const pick = (v: unknown, re: RegExp): string | null => (typeof v === "string" && re.test(v) ? v : null);

export async function versionReply(env: { ASSETS: Fetcher; CF_VERSION_METADATA?: { id?: string } }): Promise<VersionReply> {
  let j: Record<string, unknown> = {};
  try {
    const r = await env.ASSETS.fetch(new Request("https://assets.invalid/version.json"));
    if (r.ok) { const x = await r.json(); if (x && typeof x === "object") j = x as Record<string, unknown>; }
  } catch { /* no version.json (dev / tests): fields stay null */ }
  return {
    worker_version_id: pick(env.CF_VERSION_METADATA?.id, /^[0-9a-f-]{8,64}$/i),
    build: pick(j.build, /^[0-9a-f]{12}$/),
    commit: pick(j.commit, /^(?:[0-9a-f]{7,40}|unknown)$/),
    builtAt: pick(j.builtAt, /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z|unknown)$/),
  };
}
