// Serve a built web client (workers/vertex-client/dist/client) with the app's real CSP, SPA fallback. For in-browser-mock specs (no backend):
//   node scripts/serve-dist.mjs <dist/client dir> [port]    then   E2E_BASE_URL=http://127.0.0.1:<port> npx playwright test device-term
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
const dir = process.argv[2], port = Number(process.argv[3] ?? 8788);
if (!dir) { console.error("usage: serve-dist.mjs <dist/client> [port]"); process.exit(2); }
const csp = /Content-Security-Policy: (.*)/.exec(readFileSync(join(dir, "_headers"), "utf8"))?.[1]; // the same line production sends
if (!csp) throw new Error("no CSP in _headers");
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };
createServer((req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  let f = join(dir, p); if (!existsSync(f) || statSync(f).isDirectory()) f = join(dir, "index.html");
  res.writeHead(200, { "content-type": types[extname(f)] ?? "application/octet-stream", "content-security-policy": csp, "cache-control": "no-cache" });
  res.end(readFileSync(f));
}).listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port}`));
