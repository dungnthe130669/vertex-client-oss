// feat2: the feature registry's effective set equals TODAY's answers when no `unlock:` rows exist (table-driven: scope x space x binding set x old rows x identity),
// unlock rows only widen what legacy refuses (never over a narrowing "0", never for e2e, never for a malformed class), D1 errors never widen, and
// /api/me gains ONLY `features`.
import { describe, expect, test } from "bun:test";
import { FEATURES, featureFlags, featuresEffective } from "../src/feature-registry";
import { capsOf, type Identity } from "../src/caps";
import { featureOn } from "../src/features";
import { openAllowed } from "../src/open-space";
import { loadRunJs } from "../src/run-js";
import { baseOf, isE2eBiz, isMainBase, mayUseSemantic, quotaKey, spaceUsesGateway, isGuestScope, type BaseScope, type Scope } from "../src/scope";

type Rows = Record<string, string>;
// supports the two query shapes the existing gates use: `WHERE name=?` (first) and `name LIKE ?` + value='0' (featureOn, all)
const fakeDb = (rows: Rows = {}, boom = false) => ({
  prepare: (q: string) => ({ bind: (arg: string) => ({
    first: async () => { if (boom) throw new Error("d1 down"); return arg in rows ? { value: rows[arg] } : null; },
    all: async () => { if (boom) throw new Error("d1 down"); const p = arg.replace(/%$/, ""); void q; return { results: Object.entries(rows).filter(([k, v]) => k.startsWith(p) && v === "0").map(([name]) => ({ name })) }; },
  }) }),
}) as unknown as D1Database;

const G = "g:abcdef0123456789abcdef01";
const BASES = ["main", "e2e", "e2e:1", G, "g:short", "o:acme1", "nobody"];
const SPACES = ["biz", "open"] as const;
const scopeOf = (b: string, sp: "biz" | "open"): Scope => (sp === "open" ? `${b}~open` : b) as unknown as Scope;
const IDS: Identity[] = [{}, { email: "a@x.com" }];
const ALLB = ["DB", "CHAT", "GATEWAY", "GATEWAY_KEY", "KEY_ENC_SECRET", "AI", "BROWSER", "FILES", "LOADER", "VECTORIZE", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "AGENT", "AGENT_INTERNAL_SECRET", "REMOTE", "CONNECTOR", "CONNECTOR_TOKEN", "DEVICES"] as const;
const envWith = (present: readonly string[], extra: Record<string, unknown> = {}) => ({ ...Object.fromEntries(present.map((k) => [k, {}])), ...extra });
const BINDING_SETS: Array<[string, readonly string[]]> = [["all", ALLB], ["none", []], ["no-gateway-no-ai", ALLB.filter((k) => k !== "GATEWAY" && k !== "GATEWAY_KEY" && k !== "AI")], ["no-devices-files", ALLB.filter((k) => k !== "DEVICES" && k !== "FILES")]];
const ROWSETS = (b: string): Rows[] => [
  {}, { [`vcl:${b}`]: "1" }, { [`vcl:${b}`]: "1", [`vcl_env:${b}`]: "1" }, { [`vcl:${b}`]: "1", "shared_devices_emails": "a@x.com" },
  { [`open_space:${b}`]: "0" }, { [`feat:${b}:workers-ai`]: "0" }, { [`run_js:${b}`]: "1" }, { [`semantic_ready:${b}`]: "1" },
  { "cap:m:personalFeatures": "0", "cap:g:personalFeatures": "0", "cap:m:erichOnlyModes": "0", "cap:g:erichOnlyModes": "0", "cap:o:personalFeatures": "0" },
  { [`vcl:${b}`]: "1", "cap:m:devices": "0", "cap:g:devices": "0", "cap:o:devices": "0" }, { [`vcl:${b}`]: "garbage", [`run_js:${b}`]: "true" },
];
const OPEN_MODES = [undefined, "off", "on", "per-user"];

// ---- reference: TODAY's gates, composed straight from the existing exports (NOT from feature-registry's legacy) ----
async function today(id: string, env: Record<string, unknown>, db: D1Database | undefined, scope: Scope, identity: Identity): Promise<boolean> {
  const need = FEATURES.find((f) => f.id === id)!.needs;
  if (!need.every((k) => !!env[k])) return false;
  const base = baseOf(scope) as BaseScope, caps = await capsOf(db, scope, identity);
  switch (id) {
    case "chat": case "files": case "transcribe": case "usage": case "scheduler": case "spaces": return true;
    case "vertex-models": return spaceUsesGateway(scope) && (isGuestScope(base) || !!env.GATEWAY_KEY);
    case "open-space": return openAllowed({ DB: db, OPEN_SPACE: env.OPEN_SPACE as string | undefined }, base);
    case "workers-ai": return featureOn(db, base, "workers-ai");
    case "run-js": return db ? loadRunJs(db, base) : false;
    case "semantic-search": return mayUseSemantic(scope) && !!db && (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`semantic_ready:${quotaKey(scope)}`).first<{ value: string }>().catch(() => null))?.value === "1";
    case "push": return !isE2eBiz(scope);
    case "personal-features": return caps.personalFeatures;
    case "erich-only-modes": case "remote": return caps.erichOnlyModes;
    case "connectors": return isMainBase(scope) || isE2eBiz(scope);
    case "devices": return caps.devices;
    case "devices-shared": return caps.sharedDevices;
    case "devices-env": return caps.devices && !!db && (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`vcl_env:${base}`).first<{ value: string }>().catch(() => null))?.value === "1";
    default: throw new Error("unpinned feature " + id);
  }
}

describe("no unlock rows: effective set EXACTLY equals today (scope x space x bindings x rows x identity x OPEN_SPACE)", () => {
  let cells = 0;
  for (const b of BASES) for (const sp of SPACES) {
    test(`${b} ${sp}`, async () => {
      const sc = scopeOf(b, sp);
      for (const [, set] of BINDING_SETS) for (const rows of ROWSETS(b)) for (const id of IDS) for (const om of OPEN_MODES) {
        const env = envWith(set, om ? { OPEN_SPACE: om } : {});
        for (const boom of [false, true]) {
          const db = fakeDb(rows, boom);
          const eff = await featuresEffective(env, db, sc, id);
          for (const f of FEATURES) { expect(eff[f.id]!.on, `${f.id} ${b} ${sp} ${JSON.stringify(rows)} boom=${boom}`).toBe(await today(f.id, env, db, sc, id)); cells++; }
        }
        const eff2 = await featuresEffective(env, undefined, sc, id); // no DB at all
        for (const f of FEATURES) { expect(eff2[f.id]!.on, `${f.id} nodb`).toBe(await today(f.id, env, undefined, sc, id)); cells++; }
      }
    });
  }
  test("coverage count", () => { expect(cells).toBeGreaterThan(5000); });
  test("every registered feature has a reference (no silent gap) and the catalogue ids are all present", () => {
    expect(FEATURES.map((f) => f.id)).toEqual(["chat", "vertex-models", "open-space", "workers-ai", "files", "run-js", "semantic-search", "transcribe", "push", "personal-features", "erich-only-modes", "remote", "connectors", "devices", "devices-shared", "devices-env", "usage", "scheduler", "spaces"]);
  });
});

describe("unlock rows: widen only what legacy refuses, with the binding present", () => {
  const all = envWith(ALLB);
  test("guest: personal-features locked -> unlock:g row turns it on; the m row does not", async () => {
    const sc = G as unknown as Scope;
    expect((await featuresEffective(all, fakeDb(), sc))["personal-features"]).toEqual({ on: false, reason: "locked" });
    expect((await featuresEffective(all, fakeDb({ "unlock:g:personal-features": "1" }), sc))["personal-features"]).toEqual({ on: true, reason: "ok" });
    expect((await featuresEffective(all, fakeDb({ "unlock:m:personal-features": "1", "unlock:o:personal-features": "1" }), sc))["personal-features"].on).toBe(false);
  });
  test("only the exact value '1' unlocks", async () => {
    for (const v of ["0", "true", " 1", "", "yes", "2"]) expect((await featuresEffective(all, fakeDb({ "unlock:g:run-js": v }), G as unknown as Scope))["run-js"].on).toBe(false);
  });
  test("a narrowing '0' beats an unlock; an absent binding beats an unlock", async () => {
    const sc = G as unknown as Scope;
    expect((await featuresEffective(all, fakeDb({ "unlock:g:personal-features": "1", "cap:g:personalFeatures": "0" }), sc))["personal-features"]).toEqual({ on: false, reason: "narrowed" }); // a cap row "0" beats the unlock even though the kind table already refuses a guest
    expect((await featuresEffective(all, fakeDb({ "unlock:m:workers-ai": "1", "feat:main:workers-ai": "0" }), "main" as Scope))["workers-ai"]).toEqual({ on: false, reason: "narrowed" });
    expect((await featuresEffective(envWith(ALLB.filter((k) => k !== "LOADER")), fakeDb({ "unlock:g:run-js": "1" }), sc))["run-js"]).toEqual({ on: false, reason: "no-binding" });
  });
  test("an e2e tenant never gains anything from a shared class row; a malformed class is inert", async () => {
    const rows = Object.fromEntries(FEATURES.flatMap((f) => [[`unlock:m:${f.id}`, "1"], [`unlock:g:${f.id}`, "1"], [`unlock:o:${f.id}`, "1"]]));
    const eRows = await featuresEffective(all, fakeDb(rows), "e2e" as Scope);
    expect(featureFlags(eRows)).toEqual(featureFlags(await featuresEffective(all, fakeDb(), "e2e" as Scope)));
    expect(featureFlags(await featuresEffective(all, fakeDb(rows), "g:short" as Scope))).toEqual(featureFlags(await featuresEffective(all, fakeDb(), "g:short" as Scope)));
    expect(featureFlags(await featuresEffective(all, fakeDb(rows), "nobody" as Scope))).toEqual(featureFlags(await featuresEffective(all, fakeDb(), "nobody" as Scope)));
  });
  test("D1 down never unlocks anything (guest)", async () => {
    const rows = { "unlock:g:personal-features": "1", "unlock:g:run-js": "1" };
    const eff = await featuresEffective(all, fakeDb(rows, true), G as unknown as Scope);
    expect(eff["personal-features"].on).toBe(false); expect(eff["run-js"].on).toBe(false);
  });
  test("main owner base stays on with D1 down (kind-level features)", async () => {
    const eff = await featuresEffective(all, fakeDb({}, true), "main" as Scope);
    expect(eff["personal-features"].on).toBe(true); expect(eff["erich-only-modes"].on).toBe(true); expect(eff["workers-ai"].on).toBe(true);
  });
  test("featureFlags maps to booleans only", async () => {
    const f = featureFlags(await featuresEffective(all, fakeDb(), "main" as Scope));
    expect(Object.values(f).every((v) => typeof v === "boolean")).toBe(true);
    expect(Object.keys(f).length).toBe(FEATURES.length);
  });
});
