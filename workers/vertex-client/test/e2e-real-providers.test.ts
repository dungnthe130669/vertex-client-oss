// e2e_real_providers opt-in: the e2e base's Open space may use real NON-Vertex providers only when switched on; never leaks to main/team.
import { describe, expect, test } from "bun:test";
import { buildRegistry, scopeMayUse } from "../src/providers/registry";
import { seedCatalog } from "../src/providers/catalog";
import { loadE2eRealProviders } from "../src/index-d1";
import { scopeFor } from "../src/scope";
import { PROVIDERS } from "../src/providers/config";

const ENV = { PROVIDER_KEY_NVIDIA: "k" };
const ids = (scope: any, e2eReal?: boolean, extra: any[] = []) => buildRegistry({ scope, gateway: null, env: ENV, catalog: seedCatalog(), e2eReal, extra } as any).list().map((p) => p.id).sort();
const E2E_OPEN = scopeFor("e2e", "open"), TEAM = scopeFor(("g:" + "a".repeat(16)) as any, "open");

describe("e2e_real_providers", () => {
  test("OFF by default: e2e Open sees only the offline stub", () => {
    expect(ids(E2E_OPEN)).toEqual(["stub"]);
    expect(ids(E2E_OPEN, false)).toEqual(["stub"]);
  });
  test("ON: e2e Open sees stub + nvidia/groq/aistudio, never the gateway, never custom rows", () => {
    const custom = { id: "acme", kind: "openai-compat", enabled: true, baseUrl: "https://x.example/v1", models: [] };
    const got = ids(E2E_OPEN, true, [custom]);
    expect(got).toEqual(["aistudio", "groq", "nvidia", "stub"]);
    const r = buildRegistry({ scope: E2E_OPEN, gateway: null, env: ENV, catalog: seedCatalog(), e2eReal: true } as any);
    expect(r.list().some((p) => p.id === "gateway")).toBe(false);
  });
  test("ON: nvidia authenticates via the Worker secret; groq/aistudio need a user key (needs-key)", () => {
    const st = Object.fromEntries(buildRegistry({ scope: E2E_OPEN, gateway: null, env: ENV, catalog: seedCatalog(), e2eReal: true } as any).list().map((p) => [p.id, p.status]));
    expect(st.nvidia).toBe("enabled"); expect(st.groq).toBe("needs-key");
  });
  test("ON flag is ignored for the Business space of e2e and for main / team scopes", () => {
    expect(ids(scopeFor("e2e", "biz"), true)).toEqual(["gateway"]); // Business lists the gateway only, never a provider
    expect(ids(TEAM, true)).toEqual(ids(TEAM, false));
    expect(ids(scopeFor("main", "open"), true)).toEqual(ids(scopeFor("main", "open"), false));
  });
  test("scopeMayUse: e2e never reaches a non-listed or non-network kind even when ON", () => {
    const by = (id: string) => PROVIDERS.find((p) => p.id === id)!;
    expect(scopeMayUse("e2e", by("stub"), true)).toBe(true);
    expect(scopeMayUse("e2e", { id: "nvidia", kind: "openai-compat", enabled: true, models: [] } as any)).toBe(false);
    expect(scopeMayUse("e2e", { id: "nvidia", kind: "openai-compat", enabled: true, models: [] } as any, true)).toBe(true);
    expect(scopeMayUse("e2e", { id: "vertex", kind: "openai-compat", enabled: true, models: [] } as any, true)).toBe(false);
    expect(scopeMayUse("e2e", { id: "cloudflare", kind: "cloudflare", enabled: true, models: [] } as any, true)).toBe(false);
  });
  test("loader: only '1' on the e2e base enables; absent / other values / other bases / errors = off", async () => {
    const db = (v: string | null, boom = false) => ({ prepare: () => ({ bind: () => ({ first: async () => { if (boom) throw new Error("x"); return v === null ? null : { value: v }; } }) }) }) as any;
    expect(await loadE2eRealProviders(db("1"), "e2e")).toBe(true);
    expect(await loadE2eRealProviders(db("0"), "e2e")).toBe(false);
    expect(await loadE2eRealProviders(db("true"), "e2e")).toBe(false);
    expect(await loadE2eRealProviders(db(null), "e2e")).toBe(false);
    expect(await loadE2eRealProviders(db("1"), "main")).toBe(false);
    expect(await loadE2eRealProviders(db("1", true), "e2e")).toBe(false);
    expect(await loadE2eRealProviders(undefined, "e2e")).toBe(false);
  });
});
