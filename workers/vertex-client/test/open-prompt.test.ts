import { describe, expect, test } from "bun:test";
import { buildRequest, NO_TOOLS_LINE } from "../src/turn-engine";
import { TITLE_INSTRUCTION } from "../src/inline-title";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_AUTO_DELEGATE, SYSTEM_PROMPT_OPEN, SYSTEM_PROMPT_OPEN_AUTO_DELEGATE } from "../src/system-prompt";

const text = (r: any) => r.system[0].text as string;
const del = [{ name: "delegate", description: "d", approval: false, input_schema: { type: "object", properties: {} } }];
describe("Open system prompt: no personal-connector / Vertex tool claims", () => {
  test("Business text is byte-identical (cache prefix) and still describes the connector", () => {
    expect(text(buildRequest("claude-sonnet-5-5", [], [], null, null, false))).toBe(SYSTEM_PROMPT);
    expect(text(buildRequest("claude-sonnet-5-5", [], del, null, null, true))).toBe(SYSTEM_PROMPT_AUTO_DELEGATE);
    expect(SYSTEM_PROMPT).toContain("personal connector");
  });
  test("Open variant swaps the connector bullet and the Vertex-stack intro, nothing else is dropped", () => {
    expect(SYSTEM_PROMPT_OPEN).not.toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT_OPEN).not.toContain("personal connector: notes");
    expect(SYSTEM_PROMPT_OPEN).not.toContain("You may have tools that reach his personal connector");
    expect(SYSTEM_PROMPT_OPEN).not.toContain("running on his own Google Vertex AI stack");
    expect(SYSTEM_PROMPT_OPEN).toContain("Open space");
    expect(SYSTEM_PROMPT_OPEN).toContain("## Safety and privacy");
    expect(SYSTEM_PROMPT_OPEN).toContain("create_artifact");
  });
  test("buildRequest picks the Open variant only when asked, with and without auto-delegate", () => {
    expect(text(buildRequest("claude-sonnet-5-5", [], [], null, null, false, null, true))).toBe(SYSTEM_PROMPT_OPEN);
    expect(text(buildRequest("claude-sonnet-5-5", [], del, null, null, true, null, true))).toBe(SYSTEM_PROMPT_OPEN_AUTO_DELEGATE);
    expect(SYSTEM_PROMPT_OPEN_AUTO_DELEGATE).toContain("delegate tool");
  });
});

describe("space lookup failure fails closed; Business bytes pinned to master", () => {
  test("Business prompt bytes are identical to master's (golden hash); Open differs", async () => {
    const h = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await h(SYSTEM_PROMPT)).toBe("907465bb6d6844d46ab1f1566e813e1c98f672eb010e64d4d3ea797c77fc8a7f");
    expect(await h(SYSTEM_PROMPT_OPEN)).not.toBe(await h(SYSTEM_PROMPT));
  });
  test("a throwing openSpace lookup selects the Open prompt (engine source guard)", async () => {
    const src = await Bun.file(new URL("../src/turn-engine.ts", import.meta.url)).text();
    expect(src).toContain("catch { return true; }");
    expect(src).toContain("await this.openForPrompt()");
  });
});

describe("Open: names-only tools line at the end of the system prompt", () => {
  const T = (name: string) => ({ name, description: `long description of ${name}`, approval: false, input_schema: { type: "object", properties: {} } });
  const last = (r: any) => r.system[r.system.length - 1].text as string;
  const tools = ["web_read", "create_artifact", "web_links", "generate_image", "web_screenshot"].map(T);
  test("lists the tools sent in the request, sorted, names only, and is the LAST block on every turn: first reply (title marker) included", () => {
    const first: any = buildRequest("claude-sonnet-5-5", [], tools, "my profile", { name: "P", text: "proj" }, false, null, true, undefined, true);
    expect(first.system.length).toBe(5); expect(first.system[3].text).toMatch(/^Title marker/); // the title block sits BEFORE the tools line
    expect(last(first)).toBe("Tools: create_artifact, generate_image, web_links, web_read, web_screenshot");
    const later: any = buildRequest("claude-sonnet-5-5", [], tools, "my profile", { name: "P", text: "proj" }, false, null, true, undefined, false);
    expect(later.system.length).toBe(4); expect(last(later)).toBe(last(first));
    expect(last(first)).not.toContain("description"); expect(first.system[0].text).toBe(SYSTEM_PROMPT_OPEN);
    expect(first.system.slice(0, -1).every((b: any) => !b.text.startsWith("Tools"))).toBe(true);
  });
  test("deterministic: same tool set in any order and with duplicates = identical bytes; a different set changes it", () => {
    const a = JSON.stringify((buildRequest("claude-sonnet-5-5", [], tools, null, null, false, null, true) as any).system);
    const b = JSON.stringify((buildRequest("claude-sonnet-5-5", [], [...tools].reverse().concat(tools[0]!), null, null, false, null, true) as any).system);
    expect(a).toBe(b);
    expect(JSON.stringify((buildRequest("claude-sonnet-5-5", [], tools.slice(1), null, null, false, null, true) as any).system)).not.toBe(a);
  });
  test("no tools, or a model without tool support = 'Tools: none'", () => {
    expect(last(buildRequest("claude-sonnet-5-5", [], [], null, null, false, null, true))).toBe("Tools: none");
    const noTools: any = { label: "x", vendor: "other", tier: "fast", price: null, caps: { images: false, caching: false, thinking: false, tools: false }, contextWindow: null, adaptiveThinking: false, maxTokens: 100 };
    const r: any = buildRequest("nvidia:x", [], tools, null, null, false, null, true, noTools); expect(last(r)).toBe("Tools: none"); expect(r.tools).toBeUndefined();
    const withTools: any = { ...noTools, caps: { ...noTools.caps, tools: true } };
    expect(last(buildRequest("groq:x", [], tools, null, null, false, null, true, withTools))).toContain("Tools: create_artifact");
  });
  test("no tools offered: ONE no-tools line before the tools line (still last); with tools the prompt is unchanged", () => {
    const sys = (r: any) => r.system.map((b: any) => b.text as string);
    const none = sys(buildRequest("claude-sonnet-5-5", [], [], null, null, false, null, true));
    expect(none.slice(-2)).toEqual([NO_TOOLS_LINE, "Tools: none"]);
    const titled = sys(buildRequest("claude-sonnet-5-5", [], [], null, null, false, null, true, undefined, true));
    expect(titled.slice(-3, -1)).toEqual([NO_TOOLS_LINE, TITLE_INSTRUCTION]); expect(titled.at(-1)).toBe("Tools: none");
    expect(none.filter((t: string) => t === NO_TOOLS_LINE).length).toBe(1);
    const withTools = sys(buildRequest("claude-sonnet-5-5", [], tools, null, null, false, null, true));
    expect(withTools.includes(NO_TOOLS_LINE)).toBe(false);
    expect(withTools.length).toBe(none.length - 1);
    expect(sys(buildRequest("claude-sonnet-5-5", [], [], null, null, false, null, false)).includes(NO_TOOLS_LINE)).toBe(false); // Business
  });
  test("the line follows the real tool list: a tool turned off disappears; a long list is complete (no cap, no count), sorted", () => {
    expect(last(buildRequest("claude-sonnet-5-5", [], tools.filter((t) => t.name !== "web_read"), null, null, false, null, true))).not.toContain("web_read");
    const many = Array.from({ length: 60 }, (_, i) => T(`t${String(i).padStart(2, "0")}`)).reverse();
    const l = last(buildRequest("claude-sonnet-5-5", [], many, null, null, false, null, true));
    expect(l).toBe(`Tools: ${Array.from({ length: 60 }, (_, i) => `t${String(i).padStart(2, "0")}`).join(", ")}`); expect(l).not.toContain("more");
  });
  test("team Open (no personal tools) gets it too; Business is untouched: same blocks as before, no tools line", () => {
    expect(last(buildRequest("claude-sonnet-5-5", [], tools, null, null, false, null, true, undefined, false, true))).toContain("Tools: ");
    const biz: any = buildRequest("claude-sonnet-5-5", [], tools, "my profile", null, false, null, false);
    expect(biz.system.map((b: any) => b.text)).toEqual([SYSTEM_PROMPT, expect.stringContaining("my profile")]); expect(JSON.stringify(biz.system)).not.toContain("Tools:");
    expect((buildRequest("claude-sonnet-5-5", [], [], null, null, false) as any).system.map((b: any) => b.text)).toEqual([SYSTEM_PROMPT]); // no tools, Business: still one block
  });
});
