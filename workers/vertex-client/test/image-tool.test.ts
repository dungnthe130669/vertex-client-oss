import { describe, expect, test } from "bun:test";
import { IMAGE_TOOL, imageToolHost, parseImageToolResult, withImageTool, type ImageToolDeps } from "../src/image-tool";
import { stubImage, stubImageModels } from "../src/providers/stub-image";
import { classify } from "../src/tools";
import type { ModelProvider } from "../src/providers/types";

function setup(over: Partial<ImageToolDeps> = {}, opts: { models?: any } = {}) {
  const puts: string[] = [], usage: any[] = [], calls: any[] = [], meta = new Map<string, string>();
  const provider: ModelProvider = { name: "t", listModels: async () => [], messages: async () => new Response(), image: async (r) => { calls.push(r); return stubImage(r); } };
  const deps: ImageToolDeps = {
    provider, enabled: async () => true, models: async () => opts.models ?? stubImageModels(),
    files: { size: async () => null, get: async () => null, put: async (k) => { puts.push(k); }, delete: async () => {} },
    index: { recordUsage: async (u: any) => { usage.push(u); } } as any, conv: () => "c1", confirmUsd: async () => 1,
    pin: { get: () => meta.get("p") ?? null, set: (v) => { meta.set("p", v); } }, ...over,
  };
  return { host: imageToolHost(deps), puts, usage, calls, meta };
}

describe("generate_image tool", () => {
  test("classified as an automatic tool", () => { expect(classify(IMAGE_TOOL)).toBe("auto"); });
  test("happy path: one image to R2 gen/, one usage row, parseable result", async () => {
    const t = setup();
    const r = await t.host.call(IMAGE_TOOL, { prompt: "a red fox", aspect: "16:9" }, { turn: 1 });
    expect(r.isError).toBe(false);
    const g = parseImageToolResult(IMAGE_TOOL, r.text)!;
    expect(g.ref).toMatch(/\/gen\/[0-9a-f-]+\.png$/); expect(g.model).toBe("e2e-stub-image");
    expect(t.puts).toEqual([g.ref]);
    expect(t.calls[0]).toMatchObject({ model: "e2e-stub-image", prompt: "a red fox", aspect_ratio: "16:9" });
    expect(t.usage).toHaveLength(1); expect(t.usage[0]).toMatchObject({ conversationId: "c1", kind: "image", units: 1 });
  });
  test("above the confirm line: no provider call, no spend, asks for Image mode", async () => {
    const t = setup({ confirmUsd: async () => 0 });
    const r = await t.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(r.isError).toBe(true); expect(r.text).toMatch(/Image mode/);
    expect(t.calls).toHaveLength(0); expect(t.usage).toHaveLength(0); expect(t.puts).toHaveLength(0);
  });
  test("unknown price counts as above the line", async () => {
    const t = setup({}, { models: [{ id: "mystery-image", displayName: "M", kind: "image" }] });
    const r = await t.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(r.text).toMatch(/Image mode/); expect(t.calls).toHaveLength(0);
  });
  test("max 2 per turn; a new turn resets", async () => {
    const t = setup();
    await t.host.call(IMAGE_TOOL, { prompt: "a" }, { turn: 1 }); await t.host.call(IMAGE_TOOL, { prompt: "b" }, { turn: 1 });
    expect((await t.host.call(IMAGE_TOOL, { prompt: "c" }, { turn: 1 })).isError).toBe(true);
    expect((await t.host.call(IMAGE_TOOL, { prompt: "c" }, { turn: 2 })).isError).toBe(false);
  });
  test("bad input", async () => {
    const t = setup();
    expect((await t.host.call(IMAGE_TOOL, {}, { turn: 1 })).isError).toBe(true);
    expect((await t.host.call(IMAGE_TOOL, { prompt: "x", aspect: "wide" }, { turn: 1 })).isError).toBe(true);
    expect((await t.host.call(IMAGE_TOOL, { prompt: "x".repeat(5000) }, { turn: 1 })).isError).toBe(true);
    expect(t.calls).toHaveLength(0);
  });
  test("a blocked prompt is a soft error with a usage row of 0 units", async () => {
    const t = setup();
    const r = await t.host.call(IMAGE_TOOL, { prompt: "blocked thing" }, { turn: 1 });
    expect(r.isError).toBe(true); expect(t.puts).toHaveLength(0); expect(t.usage[0]).toMatchObject({ units: 0 });
  });
  test("gateway says blocked with cost 0: clear error, no charge claim, usage row has est 0", async () => {
    const { ProviderError } = await import("../src/providers/types");
    const t = setup({ provider: { name: "t", listModels: async () => [], messages: async () => new Response(),
      image: async () => { throw new ProviderError("The model declined to generate this image (IMAGE_SAFETY).", 422, { type: "generation_blocked", costUsd: 0 }); } } });
    const r = await t.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(r.isError).toBe(true); expect(r.text).toMatch(/declined/); expect(r.text).not.toMatch(/Billing uncertain/);
    expect(t.usage).toHaveLength(1); expect(t.usage[0]).toMatchObject({ units: 0, costUsd: 0, estUsd: 0 });
  });
  test("200 with no image and cost 0: soft error, est 0 row; with no cost info the estimate is kept", async () => {
    const mk = (cost: any) => setup({ provider: { name: "t", listModels: async () => [], messages: async () => new Response(),
      image: async (r) => ({ model: r.model, images: [], text: "just words", finish_reason: "STOP", cost }) } });
    const a = mk({ usd: 0 }); await a.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(a.usage[0]).toMatchObject({ units: 0, estUsd: 0 });
    const b = mk(undefined); await b.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(b.usage[0].estUsd).toBeGreaterThan(0);
  });
  test("blocked with billed tokens and no cost: tokens recorded, cost unknown, honest 'may still have charged' text; zero tokens => est 0", async () => {
    const { ProviderError } = await import("../src/providers/types");
    const mk = (usage: any) => setup({ provider: { name: "t", listModels: async () => [], messages: async () => new Response(),
      image: async () => { throw new ProviderError("The model declined to generate this image (IMAGE_SAFETY).", 422, { type: "generation_blocked", usage }); } } });
    const a = mk({ input_tokens: 7, output_tokens: 0 });
    const r = await a.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(r.text).toMatch(/may still have charged/); expect(r.text).not.toMatch(/free|Billing uncertain/);
    expect(a.usage[0]).toMatchObject({ units: 0, usage: { input_tokens: 7, output_tokens: 0 }, costUsd: null }); expect(a.usage[0].estUsd).toBeGreaterThan(0);
    const z = mk({ input_tokens: 0, output_tokens: 0 });
    const rz = await z.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(rz.text).toMatch(/may still have charged/); expect(z.usage[0]).toMatchObject({ costUsd: null }); expect(z.usage[0].estUsd).toBeGreaterThan(0);
  });
  test("end to end: gateway error JSON {usage 0/0, cost null} -> mediaError -> usage row keeps tokens, cost unknown; {cost.usd 0} -> known zero", async () => {
    const { mediaError } = await import("../src/providers/gateway");
    const mk = (error: any) => setup({ provider: { name: "t", listModels: async () => [], messages: async () => new Response(),
      image: async () => { throw mediaError(422, { type: "error", error }, null, "image"); } } });
    const a = mk({ type: "generation_blocked", usage: { input_tokens: 0, output_tokens: 0 }, cost: null });
    const ra = await a.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(ra.text).toMatch(/may still have charged/);
    expect(a.usage[0]).toMatchObject({ units: 0, usage: { input_tokens: 0, output_tokens: 0 }, costUsd: null }); expect(a.usage[0].estUsd).toBeGreaterThan(0);
    const b = mk({ type: "generation_blocked", usage: { input_tokens: 7, output_tokens: 3 }, cost: null });
    await b.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(b.usage[0]).toMatchObject({ usage: { input_tokens: 7, output_tokens: 3 }, costUsd: null });
    const c = mk({ type: "generation_blocked", usage: { input_tokens: 7, output_tokens: 0 }, cost: { usd: 0 } });
    const rc = await c.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(rc.text).not.toMatch(/may still have charged/); expect(c.usage[0]).toMatchObject({ usage: { input_tokens: 7, output_tokens: 0 }, costUsd: 0, estUsd: 0 });
    const d = mk({ type: "generation_blocked", usage: { input_tokens: 0, output_tokens: 0 }, cost: { usd: -1 } });
    await d.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 });
    expect(d.usage[0].costUsd).toBeNull();
  });
  test("toggle off at call time: refused, nothing spent", async () => {
    const t = setup({ enabled: async () => false });
    expect((await t.host.call(IMAGE_TOOL, { prompt: "x" }, { turn: 1 })).isError).toBe(true); expect(t.calls).toHaveLength(0);
  });
});

describe("generate_image is offered only when it can work", () => {
  const base = { list: async () => [{ name: "a_tool", description: "", input_schema: {}, approval: false }], call: async () => ({ text: "base", isError: false }) };
  test("image models + enabled: listed, sorted in with the others; pinned for the conversation", async () => {
    const t = setup();
    const names = (await withImageTool(base, t.host).list()).map((x) => x.name);
    expect(names).toEqual(["a_tool", IMAGE_TOOL]); expect(t.meta.get("p")).toBe("1");
  });
  test("no image models (e.g. team user without image_gen): not offered", async () => {
    const t = setup({}, { models: [] });
    expect((await withImageTool(base, t.host).list()).map((x) => x.name)).toEqual(["a_tool"]);
  });
  test("image listing refused (403 / gateway down): not offered, and not pinned off", async () => {
    const t = setup({ models: async () => { throw new Error("403"); } });
    expect(await t.host.list()).toEqual([]); expect(t.meta.get("p")).toBeUndefined();
  });
  test("setting off: not offered", async () => {
    const t = setup({ enabled: async () => false });
    expect(await t.host.list()).toEqual([]);
  });
  test("calls route by name", async () => {
    const t = setup(); const h = withImageTool(base, t.host);
    expect((await h.call("a_tool", {}, { turn: 1 })).text).toBe("base");
    expect((await h.call(IMAGE_TOOL, { prompt: "p" }, { turn: 1 })).isError).toBe(false);
  });
});

import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { loadChatImages, saveChatImages } from "../src/image-tool";
describe("Let chat create images setting", () => {
  const mk = () => {
    const db = new Database(":memory:");
    for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
    const stmt = (q: string, b: unknown[] = []): any => ({ bind: (...v: unknown[]) => stmt(q, v), first: async () => (db.query(q).get(...(b as any)) as any) ?? null, run: async () => { db.query(q).run(...(b as any)); return { meta: {} }; } });
    return { prepare: (q: string) => stmt(q) } as unknown as D1Database;
  };
  test("default ON; per scope, one scope's switch never touches another's", async () => {
    const db = mk(), A = "g:aaaaaaaaaaaaaaaaaaaaaaaa", B = "main";
    expect(await loadChatImages(db, A)).toBe(true); expect(await loadChatImages(db, B)).toBe(true);
    await saveChatImages(db, A, false);
    expect(await loadChatImages(db, A)).toBe(false); expect(await loadChatImages(db, B)).toBe(true);
    await saveChatImages(db, A, true); expect(await loadChatImages(db, A)).toBe(true);
  });
});
