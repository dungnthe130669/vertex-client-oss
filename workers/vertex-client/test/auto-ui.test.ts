// Auto phase 2: UI-side pure helpers, applied-route usage rows (no new migration: 0023's columns are reused) and per-scope isolation of byRoute.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { AUTO_DESCRIPTION, AUTO_ID, retryChoices, routeCounts, routeLabel, shortModel, takesEffort, withAuto } from "../web/src/auto-ui";
import { d1Index, loadAutoMaxUsd, saveAutoMaxUsd } from "../src/index-d1";
import { usageReport } from "../src/usage";
import { MODELS_META } from "../src/models-meta";
import type { Model } from "../web/src/api";

const mk = (id: string, vendor = "anthropic", text = true): Model => ({ id, name: id, provider: "gateway", meta: { label: id, vendor, tier: "balanced", price: null, caps: { images: true, caching: true, thinking: true, tools: true }, ...(MODELS_META[id]?.acceptsEffort ? { acceptsEffort: true } : {}) },
  capabilities: { text, vision: true, tools: true, "image-gen": false, "video-gen": false, reasoning: true } });

describe("picker entry", () => {
  test("Auto is first, labelled Auto with the spec's description, when a Claude chat model is listed (main and team alike)", () => {
    const out = withAuto([mk("claude-haiku-5-5"), mk("claude-sonnet-5-5"), mk("gemini-3-pro", "google")]);
    expect(out[0]).toMatchObject({ id: AUTO_ID, name: "Auto", description: AUTO_DESCRIPTION, meta: { label: "Auto" } });
    expect(AUTO_DESCRIPTION).toBe("Picks the model and thinking effort for each message");
    expect(out.map((m) => m.id)).toEqual(["auto", "claude-haiku-5-5", "claude-sonnet-5-5", "gemini-3-pro"]);
  });
  test("team scope with no Claude chat model (gemini only, or a Claude entry that is not a chat model): no Auto", () => {
    expect(withAuto([mk("gemini-3-pro", "google")]).some((m) => m.id === AUTO_ID)).toBe(false);
    expect(withAuto([mk("claude-sonnet-5-5", "anthropic", false)]).some((m) => m.id === AUTO_ID)).toBe(false);
    expect(withAuto([])).toEqual([]);
  });
  test("idempotent (a reload never duplicates the entry); Auto is never an override target", () => {
    const once = withAuto([mk("claude-sonnet-5-5")]);
    expect(withAuto(once).filter((m) => m.id === AUTO_ID)).toHaveLength(1);
    expect(retryChoices(once).map((m) => m.id)).toEqual(["claude-sonnet-5-5"]);
    expect(retryChoices(null)).toEqual([]);
  });
  test("effort control only for models that take it", () => {
    expect(takesEffort(mk("claude-sonnet-5-5"))).toBe(true); expect(takesEffort(mk("claude-opus-5-5"))).toBe(true);
    expect(takesEffort(mk("claude-haiku-5-5"))).toBe(false); expect(takesEffort(undefined)).toBe(false);
  });
});

describe("label", () => {
  test("Auto: Sonnet 5.5 · medium (what was sent); no effort part when none was sent", () => {
    expect(routeLabel({ by: "auto-route", model: "claude-sonnet-5-5", effort: "medium", reason: "" })).toBe("Auto: Sonnet 5.5 · medium");
    expect(routeLabel({ by: "auto-route", model: "claude-haiku-5-5", effort: null, reason: "" })).toBe("Auto: Haiku 5.5");
    expect(routeLabel({ by: "auto-fallback", model: "claude-sonnet-5-5", effort: "medium", reason: "", fallbackFrom: "claude-haiku-5-5" })).toBe("Auto: Sonnet 5.5 · medium (fallback from Haiku 5.5)");
    expect(routeLabel({ by: "auto-fallback", model: "claude-sonnet-5-5", effort: null, reason: "", fallbackFrom: "auto" })).toBe("Auto: Sonnet 5.5");
    expect(routeLabel({ by: "manual-override", model: "claude-opus-5-5", effort: "high", reason: "" })).toBe("Retried with Opus 5.5 · high");
  });
  test("shortModel", () => {
    expect(["claude-opus-5-5", "claude-haiku-4-5", "claude-sonnet-5", "weird"].map(shortModel)).toEqual(["Opus 5.5", "Haiku 4.5", "Sonnet 5", "weird"]);
  });
});

describe("Settings counts", () => {
  test("applied routes only, grouped by the model that ran, fallbacks counted; shadow rows and overrides ignored", () => {
    const rows = [
      { model: "claude-sonnet-5-5", routedModel: "claude-sonnet-5-5", routedBy: "auto-route", n: 5 },
      { model: "claude-haiku-5-5", routedModel: "claude-haiku-5-5", routedBy: "auto-route", n: 2 },
      { model: "claude-sonnet-5-5", routedModel: "claude-sonnet-5-5", routedBy: "auto-fallback", n: 1 },
      { model: "claude-opus-5-5", routedModel: "claude-haiku-5-5", routedBy: "auto", n: 40 },
      { model: "claude-opus-5-5", routedModel: "claude-opus-5-5", routedBy: "manual-override", n: 3 },
    ];
    expect(routeCounts(rows)).toEqual([{ model: "claude-sonnet-5-5", n: 6, fallback: 1 }, { model: "claude-haiku-5-5", n: 2, fallback: 0 }]);
    expect(routeCounts(undefined)).toEqual([]);
  });
});

// ---- usage rows: applied routes reuse migration 0023's columns, so nothing new is applied; the window is 30 days and per scope ----
const migs = () => readdirSync(new URL("../migrations/", import.meta.url)).sort();
function d1() {
  const db = new Database(":memory:");
  for (const f of migs()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (q: string, b: unknown[] = []): D1PreparedStatement => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.query(q).get(...(b as any)) as any) ?? null,
    all: async () => ({ results: db.query(q).all(...(b as any)) as any[], success: true, meta: {} }),
    run: async () => { const r = db.query(q).run(...(b as any)); return { results: [], success: true, meta: { changes: r.changes } }; },
  } as any);
  return { db, D: { prepare: (q: string) => stmt(q) } as unknown as D1Database };
}
const U = { input_tokens: 10, output_tokens: 5 };
describe("usage rows for applied routes", () => {
  test("no migration is needed for Auto: the routed_* columns come from 0023 (the latest migration is now 0040, desktop sign-in handoff, unrelated to Auto)", () => {
    expect(migs().at(-1)).toBe("0045_feature_audit.sql"); // feat2 2026-11-06: was 0044_device_space.sql; 0045 is the additive feature_audit table, unrelated to Auto. Correction 2026-11-05: was 0043_term_audit.sql; 0044 is the per-device space columns (vclspace1), unrelated to Auto. Earlier 2026-11-04: was 0042_conversation_env.sql; 0043 is the device-terminal audit table (vclterm3), unrelated to Auto. Earlier correction 2026-11-03: was 0041_device_identity.sql (and before that 0040_app_handoff.sql); 0042 is the device-environment columns of devices v2 step 3, also unrelated to Auto
  });
  test("applied rows carry routed_by auto-route/auto-fallback/manual-override and byRoute returns them for the last 30 days, per scope", async () => {
    const { db, D } = d1();
    db.query(`INSERT INTO conversations (id, model, scope) VALUES ('a','auto','main'), ('b','auto','u:team1')`).run();
    const main = d1Index(D, async () => "main" as any), team = d1Index(D, async () => "u:team1" as any);
    const R = (by: any, model: string) => ({ by, model, reason: "rule 4: code cue | effort medium" });
    await main.recordUsage({ conversationId: "a", model: "claude-sonnet-5-5", usage: U, costUsd: 0.01, routed: R("auto-route", "claude-sonnet-5-5") });
    await main.recordUsage({ conversationId: "a", model: "claude-opus-5-5", usage: U, costUsd: 0.01, routed: R("manual-override", "claude-opus-5-5") });
    await team.recordUsage({ conversationId: "b", model: "claude-haiku-5-5", usage: U, costUsd: 0.01, routed: R("auto-fallback", "claude-haiku-5-5") });
    db.query(`INSERT INTO usage (conversation_id, model, input_tokens, output_tokens, cost_usd, scope, routed_by, routed_model, created_at) VALUES ('a','claude-sonnet-5-5',1,1,0,'main','auto-route','claude-sonnet-5-5', datetime('now','-40 days'))`).run();
    const m = (await usageReport(D, Date.now(), 0, "main")).byRoute;
    expect(m.map((r) => `${r.routedBy}:${r.model}:${r.n}`).sort()).toEqual(["auto-route:claude-sonnet-5-5:1", "manual-override:claude-opus-5-5:1"]); // the 40-day-old row is out
    expect((await usageReport(D, Date.now(), 0, "u:team1")).byRoute).toEqual([{ model: "claude-haiku-5-5", routedModel: "claude-haiku-5-5", routedBy: "auto-fallback", n: 1 }]);
  });
  test("auto_max_usd setting: absent/invalid = null (no ceiling), per scope", async () => {
    const { db, D } = d1();
    expect(await loadAutoMaxUsd(D, "main")).toBeNull();
    db.query(`INSERT INTO settings (name, value) VALUES ('auto_max_usd:main','1.5'), ('auto_max_usd:u:x','nope'), ('auto_max_usd:e2e','-1')`).run();
    expect(await loadAutoMaxUsd(D, "main")).toBe(1.5);
    expect(await loadAutoMaxUsd(D, "u:x")).toBeNull();
    expect(await loadAutoMaxUsd(D, "e2e")).toBeNull();
  });
  test("saveAutoMaxUsd sets, overwrites and clears (null = no ceiling, the default)", async () => {
    const { D } = d1();
    await saveAutoMaxUsd(D, "main", 2); expect(await loadAutoMaxUsd(D, "main")).toBe(2);
    await saveAutoMaxUsd(D, "main", 0.5); expect(await loadAutoMaxUsd(D, "main")).toBe(0.5);
    await saveAutoMaxUsd(D, "main", null); expect(await loadAutoMaxUsd(D, "main")).toBeNull();
  });
});
