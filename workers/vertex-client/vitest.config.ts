import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cfLiteTest } from "@cf-lite/testing/config";

// Runs test-cf/**/*.test.ts inside workerd against the real wrangler.jsonc bindings (D1, the ChatSession DO, R2, vars, cron, D1 migrations applied per test).
// workerd refuses to boot with a service binding whose target Worker does not exist (GATEWAY/CONNECTOR/AGENT/REMOTE live in other Workers), so the
// tests use a derived copy of wrangler.jsonc with `services` and `routes` removed (written at startup, so it cannot drift); those bindings are absent =
// "Cloud/Remote/tools off" paths, exactly what the app does when they are missing. The domain/route tests in test/ stay on bun:test (`bun test ./test/`).
const strip = (t: string) => t.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, s) => s ?? "").replace(/,(\s*[}\]])/g, "$1");
const cfg = JSON.parse(strip(readFileSync("wrangler.jsonc", "utf8")));
delete cfg.services; delete cfg.routes; delete cfg.env;
// `ai` (Workers AI) is a remote-only binding: workerd would need a Cloudflare API token + a remote proxy session just to boot. Stripped for the test pool only
// (this derived copy; wrangler.jsonc / wrangler.team.jsonc keep it, test/config-contract.test.ts enforces that). Tests inject a stub AI instead.
delete cfg.ai;
cfg.main = "../server/worker.ts";
mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/wrangler.test.json", JSON.stringify(cfg, null, 1));

export default cfLiteTest({
  wrangler: "./.wrangler/wrangler.test.json",
  migrations: "./migrations",
  include: ["test-cf/**/*.test.ts"],
  bindings: { SESSION_SECRET: "test-session-secret-0123456789abcdef", E2E_TOKEN: "e2e-test-token-0123456789abcdef0123456789abcdef" },
});
