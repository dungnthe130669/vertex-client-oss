import { defineConfig, type Plugin } from "vite";
import cfLite from "cf-lite/vite";
import preact from "@preact/preset-vite";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
// @ts-expect-error plain .mjs shared with the tests
import { buildId, gitCommit, precacheAssets, stampSw, versionInfo } from "./scripts/sw-version.mjs";

// After the client bundle is written, stamp sw.js with a content-derived build id (everything in the client output except sw.js itself).
function swStamp(): Plugin {
  return {
    name: "sw-stamp", apply: "build",
    applyToEnvironment: (env) => env.name === "client",
    closeBundle() {
      const cfg = this.environment.config;
      const out = resolve(cfg.root, cfg.build.outDir);
      const files: Array<{ name: string; bytes: Buffer }> = [];
      const meta = { commit: gitCommit(cfg.root), builtAt: new Date().toISOString().replace(/\.\d+Z$/, "Z") };
      const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push({ name: relative(out, p), bytes: readFileSync(p) }); } };
      walk(out);
      const swSrc = readFileSync(join(out, "sw.js"), "utf8");
      const id = buildId([...files.filter((f) => f.name !== "sw.js" && f.name !== "version.json"), { name: "sw.js", bytes: Buffer.from(swSrc) }]);
      writeFileSync(join(out, "sw.js"), stampSw(swSrc, id, meta, precacheAssets(files.map((f) => f.name.replaceAll("\\", "/"))))); // sw.js: content + commit only (no wall clock => no-op rebuilds are byte-identical)
      // version.json: what the deployed assets are, and the ONLY place builtAt lives (served no-cache; /api/version reads it). Not part of the build-id hash.
      writeFileSync(join(out, "version.json"), JSON.stringify(versionInfo(id, meta)) + "\n");
      console.log(`sw build id ${id} commit ${meta.commit} built ${meta.builtAt}`);
    },
  };
}

// index.html is at the project root (cf-lite's client entry); the PWA sources stay in web/src, static files in web/public.
export default defineConfig({
  publicDir: "web/public",
  plugins: [preact(), cfLite(), swStamp()],
  build: { target: "es2022", sourcemap: false },
});
