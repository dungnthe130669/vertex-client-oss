// Service-worker versioning. The cache name embeds a build id derived from the built files' content, so every deploy
// that changes anything gets a new cache (old ones are deleted on activate) and the browser sees a byte-different
// sw.js, which is what triggers the "update available" flow. Identical build => identical id (deploys are idempotent).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

export const PLACEHOLDER = "__BUILD_ID__";

/** files: [{ name, bytes }] (bytes: Uint8Array | string). Order-independent. */
export function buildId(files) {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    h.update(f.name); h.update("\0"); h.update(f.bytes); h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

export const COMMIT_PLACEHOLDER = "__COMMIT__";
const COMMIT_RE = /^(?:[0-9a-f]{7,40}|unknown)$/;
const BUILT_AT_RE = /^(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z|unknown)$/;

/** Short git SHA of the checkout being built, or "unknown" (no git / not a repo / detached export). Never throws: a build must not fail over this. */
export function gitCommit(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return COMMIT_RE.test(out) ? out : "unknown";
  } catch { return "unknown"; }
}

/** The stamp written into version.json (served no-cache). meta: { commit, builtAt } (each falls back to "unknown"). builtAt is wall-clock, so it lives ONLY here, never in sw.js. */
export function versionInfo(id, meta = {}) {
  const commit = COMMIT_RE.test(meta.commit ?? "") ? meta.commit : "unknown";
  const builtAt = BUILT_AT_RE.test(meta.builtAt ?? "") ? meta.builtAt : "unknown";
  return { build: id, commit, builtAt };
}

export const ASSETS_PLACEHOLDER = "__ASSETS__";
/** Names (relative to the client root, e.g. "assets/cloud-1a2b.js") of the hashed bundles the service worker must precache: every /assets/ file (so code-split screens work offline), minus ones that are useless offline. */
export function precacheAssets(names) {
  return names.filter((n) => /^assets\/[^/]+\.(?:js|css)$/.test(n) && !/^assets\/(?:rfb|xterm|term-pane)-/.test(n)).sort();
}

export function stampSw(src, id, meta = {}, assets = []) {
  if (!src.includes(`"${PLACEHOLDER}"`)) throw new Error("sw.js has no build-id placeholder");
  if (!/^[0-9a-f]{12}$/.test(id)) throw new Error("bad build id");
  const v = versionInfo(id, meta);
  // Pure function of (src, id, commit): builtAt is deliberately ignored, so identical input is byte-identical output.
  if (assets.some((a) => !/^assets\/[A-Za-z0-9._-]+$/.test(a))) throw new Error("bad asset name");
  return src.replaceAll(`"${PLACEHOLDER}"`, `"${id}"`).replaceAll(`"${COMMIT_PLACEHOLDER}"`, `"${v.commit}"`).replaceAll(`["${ASSETS_PLACEHOLDER}"]`, JSON.stringify(assets.map((a) => "/" + a)));
}
