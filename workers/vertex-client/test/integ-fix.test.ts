// Integration fix round: (M1) every locked built-in preset is protected from stored-row replacement; (M2) the per-user broken-model list is generic for all providers.
import { describe, expect, test } from "bun:test";
import { builtinPresetConfigs, parseConfig, withBuiltinPresets } from "../src/providers/config";
import { buildRegistry } from "../src/providers/registry";
import { markBroken, loadUserBroken } from "../src/provider-routes";
import { mkEnv, gw } from "./user-keys-harness";

const row = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: "openai-compat", base_url: "https://evil.example/v1", key_binding: "PROVIDER_KEY_EVIL", enabled: 1, models_json: JSON.stringify([{ id: "evil-model", capabilities: { tools: true } }]), auth_header: "bearer", broken_json: "[]", ...over });
const stored = (id: string, over: Record<string, unknown> = {}) => parseConfig(row(id, over))!;

describe("M1: locked built-in presets", () => {
  for (const id of ["groq", "aistudio"]) test(`a stored ${id} row never replaces origin / catalog / defaults / key binding; it only switches on/off`, () => {
    const builtin = builtinPresetConfigs("main").find((c) => c.id === id)!;
    const merged = withBuiltinPresets("main", [stored(id)]).find((c) => c.id === id)!;
    expect(merged).toEqual(builtin);
    expect(merged.baseUrl).not.toContain("evil"); expect(merged.models.map((m) => m.id)).not.toContain("evil-model"); expect(merged.keyBinding).toBeUndefined();
    expect(withBuiltinPresets("main", [stored(id)]).filter((c) => c.id === id).length).toBe(1);
    expect(withBuiltinPresets("main", [stored(id, { enabled: 0 })]).find((c) => c.id === id)).toEqual({ ...builtin, enabled: false });
  });
  test("nvidia keeps its existing rules: a stored row still wins, an edited origin is text-only", () => {
    const merged = withBuiltinPresets("main", [stored("nvidia")]).find((c) => c.id === "nvidia")!;
    expect(merged.baseUrl).toBe("https://evil.example/v1");
    expect(merged.models.map((m) => m.id)).toEqual(["evil-model"]); expect(merged.models[0]!.capabilities.tools).toBe(false);
  });
});

describe("M2: per-user broken list is generic", () => {
  test("a Groq 404 for user A does not hide the model for user B, and never writes provider_configs / the catalog", async () => {
    const env: any = mkEnv();
    const cat = () => JSON.stringify(env._db.query("SELECT provider_id, model_id, broken FROM provider_models ORDER BY 1,2").all());
    const before = cat();
    await env._db.run("INSERT INTO provider_configs (id, scope, kind, base_url, enabled, models_json, broken_json) VALUES ('acme','main','openai-compat','https://a.example/v1',1,'[]','[]')");
    const cfgBefore = JSON.stringify(env._db.query("SELECT * FROM provider_configs").all());
    const model = "openai/gpt-oss-20b";
    await markBroken(env.DB, "groq", model, "g:userAAAA"); await markBroken(env.DB, "groq", model, "g:userAAAA");
    await markBroken(env.DB, "acme", "m1", "g:userAAAA");
    expect(await loadUserBroken(env.DB, "g:userAAAA")).toEqual({ groq: [model], acme: ["m1"] });
    expect(await loadUserBroken(env.DB, "g:userBBBB")).toEqual({});
    expect(cat()).toBe(before); expect(JSON.stringify(env._db.query("SELECT * FROM provider_configs").all())).toBe(cfgBefore);
    const uk = { ids: new Map([["groq", "https://api.groq.com"]]), get: async () => ({ kind: "key" as const, key: "k-not-real" }) } as any;
    const reg = (userBroken?: Record<string, string[]>) => buildRegistry({ scope: "main~open", gateway: gw as any, env: {}, userKeys: uk, userBroken } as any);
    expect((await reg(await loadUserBroken(env.DB, "g:userAAAA")).models()).map((m) => m.id)).not.toContain(`groq:${model}`);
    expect((await reg(await loadUserBroken(env.DB, "g:userBBBB")).models()).map((m) => m.id)).toContain(`groq:${model}`);
  });
  test("a team user (g:*) with no provider_configs row: built-in Groq 404 lands in their own list and hides it for them only", async () => {
    const env: any = mkEnv();
    const calls: string[] = []; const model = "openai/gpt-oss-20b";
    const uk = { ids: new Map([["groq", "https://api.groq.com"]]), get: async () => ({ kind: "key" as const, key: "k-not-real" }) } as any;
    const reg = buildRegistry({ scope: "g:teamUser1~open", gateway: gw as any, env: {}, userKeys: uk, fetchImpl: (async () => new Response("{}", { status: 404 })) as any,
      onBroken: (pid: string, m: string) => { calls.push(`${pid}:${m}`); void markBroken(env.DB, pid, m, "g:teamUser1"); } } as any);
    expect((await reg.models()).map((m) => m.id)).toContain(`groq:${model}`);
    await reg.router.messages({ model: `groq:${model}`, messages: [{ role: "user", content: "hi" }], max_tokens: 100 } as any).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([`groq:${model}`]);
    expect(await loadUserBroken(env.DB, "g:teamUser1")).toEqual({ groq: [model] });
    expect(await loadUserBroken(env.DB, "g:teamUser2")).toEqual({});
    expect(env._db.query("SELECT count(*) AS n FROM provider_configs").get()).toEqual({ n: 0 });
  });
});
