// vclopen2: hardening of the openai-compat conversion for Open models (mid-conversation system role, max_tokens default cap, $schema stripping). Fake providers only.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_MAX_OUTPUT, cleanSchema, openaiCompatProvider, toChatRequest } from "../src/providers/openai-compat";

const roles = (r: any) => (r.messages as any[]).map((m) => m.role);
const noConsecutiveUser = (r: any) => (r.messages as any[]).every((m, i, a) => !(i && m.role === "user" && a[i - 1].role === "user"));
const fx = JSON.parse(readFileSync(new URL("./fixtures/vclopen1-sdk-requests.json", import.meta.url), "utf8")) as { requests: Array<{ body: any }> };

describe("mid-conversation system role", () => {
  test("captured SDK request: no consecutive user turns, system text kept", () => {
    const r: any = toChatRequest(fx.requests[1]!.body, "m");
    expect(noConsecutiveUser(r)).toBe(true);
    expect(roles(r).filter((x) => x === "system")).toEqual(["system"]); // only the real system prompt
  });
  test("system between user and assistant merges into the previous user", () => {
    const r: any = toChatRequest({ messages: [{ role: "user", content: "a" }, { role: "system", content: "S1" }, { role: "assistant", content: "b" }] }, "m");
    expect(roles(r)).toEqual(["user", "assistant"]); expect(r.messages[0].content).toBe("a\nS1");
  });
  test("consecutive system messages and user after: one user turn", () => {
    const r: any = toChatRequest({ messages: [{ role: "system", content: "S1" }, { role: "system", content: [{ type: "text", text: "S2" }] }, { role: "user", content: "u" }] }, "m");
    expect(roles(r)).toEqual(["user"]); expect(r.messages[0].content).toBe("S1\nS2\nu");
  });
  test("tool_result adjacent: tool message stays first, system text folds into the following user, no consecutive user", () => {
    const r: any = toChatRequest({ messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "data" }] },
      { role: "system", content: "S" },
    ] }, "m");
    expect(roles(r)).toEqual(["user", "assistant", "tool", "user"]); expect(r.messages[3].content).toBe("S");
    expect(r.messages[2].tool_call_id).toBe("t1");
  });
  test("tool_result then system then text user", () => {
    const r: any = toChatRequest({ messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "d" }] },
      { role: "system", content: "S" }, { role: "user", content: "next" },
    ] }, "m");
    expect(roles(r)).toEqual(["assistant", "tool", "user"]); expect(r.messages[2].content).toBe("S\nnext");
  });
  test("consecutive user messages merge; images kept", () => {
    const r: any = toChatRequest({ messages: [{ role: "user", content: "a" }, { role: "user", content: [{ type: "text", text: "b" }] }] }, "m");
    expect(roles(r)).toEqual(["user"]); expect(r.messages[0].content).toBe("a\nb");
  });
  test("system before assistant with nothing to merge into is emitted as user", () => {
    const r: any = toChatRequest({ messages: [{ role: "system", content: "S" }, { role: "assistant", content: "x" }] }, "m");
    expect(roles(r)).toEqual(["user", "assistant"]);
  });
});

describe("tool schema cleaning", () => {
  test("$schema and meta keys stripped recursively, property named $schema-like data kept", () => {
    const r: any = toChatRequest({ messages: [{ role: "user", content: "x" }], tools: [{ name: "T", input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string", $comment: "c" }, b: { type: "array", items: { $id: "x", type: "number" } } }, required: ["a"], additionalProperties: false } }] }, "m");
    const p = r.tools[0].function.parameters;
    expect(JSON.stringify(p)).not.toMatch(/\$schema|\$comment|\$id/);
    expect(p.required).toEqual(["a"]); expect(p.additionalProperties).toBe(false); expect(p.properties.b.items.type).toBe("number");
  });
  test("cleanSchema passes primitives/undefined", () => { expect(cleanSchema(undefined)).toBeUndefined(); expect(cleanSchema(3)).toBe(3); });
});

describe("max_tokens clamp", () => {
  const send = async (models: any[], max: number) => {
    const sent: any[] = [];
    const p = openaiCompatProvider({ id: "nvidia", kind: "openai-compat", enabled: true, baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "K", models } as any, { K: "k" }, async (_u, init) => { sent.push(JSON.parse(String(init?.body))); return new Response("data: [DONE]\n\n"); });
    await (await p.messages({ model: "m1", max_tokens: max, messages: [{ role: "user", content: "hi" }] })).text();
    return sent[0];
  };
  const row = (extra: any = {}) => [{ id: "m1", displayName: "M", capabilities: { text: true }, ...extra }];
  test("unknown model: default cap", async () => { expect((await send(row(), 128000)).max_tokens).toBe(DEFAULT_MAX_OUTPUT); });
  test("known maxOutput wins", async () => { expect((await send(row({ maxOutput: 8192 }), 128000)).max_tokens).toBe(8192); });
  test("small request unchanged", async () => { expect((await send(row(), 1000)).max_tokens).toBe(1000); });
});

describe("vclopen4: merge keeps images, cleanSchema is schema-aware", () => {
  const img = (d: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: d } });
  const url = (d: string) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${d}` } });
  const msgs = (...m: any[]) => (toChatRequest({ messages: m }, "m") as any).messages;
  test("text then image-only", () => {
    expect(msgs({ role: "user", content: "look" }, { role: "user", content: [img("AA==")] })).toEqual([{ role: "user", content: [{ type: "text", text: "look" }, url("AA==")] }]);
  });
  test("image then text", () => {
    expect(msgs({ role: "user", content: [img("AA==")] }, { role: "user", content: "what" })).toEqual([{ role: "user", content: [url("AA=="), { type: "text", text: "what" }] }]);
  });
  test("image + image", () => {
    expect(msgs({ role: "user", content: [img("AA==")] }, { role: "user", content: [img("BB==")] })).toEqual([{ role: "user", content: [url("AA=="), url("BB==")] }]);
  });
  test("text + text stays a string", () => {
    expect(msgs({ role: "user", content: "a" }, { role: "user", content: "b" })).toEqual([{ role: "user", content: "a\nb" }]);
  });
  test("tool_result adjacency: tool message is never merged into user", () => {
    const r = msgs({ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }, img("AA==")] }, { role: "user", content: "next" });
    expect(r.map((x: any) => x.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(r[3].content).toEqual([url("AA=="), { type: "text", text: "next" }]);
  });
  test("cleanSchema keeps property named $id and required", () => {
    const o = cleanSchema({ $schema: "x", type: "object", properties: { $id: { type: "string", $comment: "c" } }, required: ["$id"] });
    expect(o).toEqual({ type: "object", properties: { $id: { type: "string" } }, required: ["$id"] });
  });
  test("cleanSchema leaves literal data untouched, cleans $defs values", () => {
    const o = cleanSchema({ $defs: { A: { $id: "a", type: "string" } }, properties: { p: { type: "object", default: { $schema: "keep", $id: 1 }, const: { $comment: "k" }, enum: [{ $id: 1 }], examples: [{ $schema: "s" }] } } });
    expect(o.$defs).toEqual({ A: { type: "string" } });
    expect(o.properties.p).toEqual({ type: "object", default: { $schema: "keep", $id: 1 }, const: { $comment: "k" }, enum: [{ $id: 1 }], examples: [{ $schema: "s" }] });
  });
  test("cleanSchema keeps dependency entries keyed $id, cleans dependent schemas", () => {
    const o = cleanSchema({ type: "object", dependentRequired: { $id: ["b"] }, dependencies: { $id: ["b"] }, dependentSchemas: { $id: { $comment: "x", required: ["b"] } } });
    expect(o).toEqual({ type: "object", dependentRequired: { $id: ["b"] }, dependencies: { $id: ["b"] }, dependentSchemas: { $id: { required: ["b"] } } });
  });
});
