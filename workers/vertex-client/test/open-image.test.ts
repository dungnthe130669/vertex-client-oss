import { describe, expect, test } from "bun:test";
import { HINT_IMAGE_MODEL, IMAGE_INTENT, pickHintImageModel, showImageHint } from "../web/src/chat-ux";
import { splitSvgFences } from "../web/src/svg-safe";
import { nvidiaDefaultModels, parseConfig } from "../src/providers/config";
import { NVIDIA_TOOLS_VERIFIED, NVIDIA_VERIFIED } from "../src/providers/presets";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">\n  <circle cx="100" cy="100" r="50"/>\n\n  <text x="10" y="20">Dog</text>\n</svg>`;
describe("raw <svg> in a reply is a picture, not a blank gap", () => {
  test("a raw block outside a fence becomes an svg segment (blank line inside included)", () => {
    const segs = splitSvgFences(`Dưới đây là SVG:\n\n${svg}\n\nBạn muốn lưu?`);
    expect(segs.map((s) => s.type)).toEqual(["text", "svg", "text"]);
    expect(segs[1]).toEqual({ type: "svg", source: svg });
  });
  test("a raw <svg inside a ```html fence stays code", () => {
    const t = "a\n```html\n" + svg + "\n```\nb";
    expect(splitSvgFences(t)).toEqual([{ type: "text", text: t }]);
  });
  test("an unclosed raw <svg (streaming) and an unclosed fence stay text", () => {
    const a = "x\n\n<svg viewBox='0 0 1 1'><circle/>"; expect(splitSvgFences(a)).toEqual([{ type: "text", text: "x\n\n" }, { type: "text", text: "```xml\n<svg viewBox='0 0 1 1'><circle/>\n```" }]); // finished + cut off: shown as code, never a blank gap
    const b = "x\n```html\n" + svg; expect(splitSvgFences(b)).toEqual([{ type: "text", text: b }]);
  });
  test("fence and raw block in one reply both render, in order", () => {
    const segs = splitSvgFences("```svg\n" + svg + "\n```\n\nthen\n\n" + svg);
    expect(segs.filter((s) => s.type === "svg").length).toBe(2);
  });
  test("inline `<svg>` mid-sentence is left alone", () => { const t = "use the <svg>tag</svg> here"; expect(splitSvgFences(t)).toEqual([{ type: "text", text: t }]); });
});
describe("NVIDIA default capabilities", () => {
  test("tools only on the live-verified ids; text on all", () => {
    const m = nvidiaDefaultModels();
    expect(m.map((x) => x.id)).toEqual(NVIDIA_VERIFIED);
    for (const x of m) { expect(x.capabilities.text).toBe(true); expect(x.capabilities.tools).toBe(NVIDIA_TOOLS_VERIFIED.includes(x.id)); }
    expect(m.find((x) => x.id.includes("nano-omni"))!.capabilities.tools).toBe(false);
    expect(m.find((x) => x.id.includes("ultra"))!.capabilities.tools).toBe(true);
  });
  test("a fresh preset row uses them", () => {
    const c = parseConfig({ id: "nvidia", kind: "openai-compat", base_url: "https://integrate.api.nvidia.com/v1", auth_header: "bearer", enabled: 1, models_json: "[]" })!;
    expect(c.models.filter((x) => x.capabilities.tools).length).toBe(NVIDIA_TOOLS_VERIFIED.length);
  });
});
describe("image hint", () => {
  test.each(["tạo ảnh 1 con chó", "Tạo cho tôi một ảnh mèo", "vẽ con mèo", "generate an image of a dog", "please draw a picture of a cat", "draw me a logo", "draw a cat", "Draw a dog please", "draw a house", "Create an image of x"])("intent: %s", (t) => expect(IMAGE_INTENT.test(t)).toBe(true));
  test.each(["viết hàm sắp xếp", "what is a drawer", "explain images in css", "tạo bảng", "let me draw a conclusion", "draw the line here", "draw attention to it", "draw lots", "draw a conclusion from this", "draw", "vẽ chuyện"])("no intent: %s", (t) => expect(IMAGE_INTENT.test(t)).toBe(false));
  test("only in Open, only for a model known to lack tools", () => {
    const o = { text: "tạo ảnh 1 con chó" };
    expect(showImageHint({ ...o, space: "open", caps: { tools: false } })).toBe(true);
    expect(showImageHint({ ...o, space: "open", caps: { tools: true } })).toBe(false);
    expect(showImageHint({ ...o, space: "open", caps: undefined })).toBe(false);
    expect(showImageHint({ ...o, space: "biz", caps: { tools: false } })).toBe(false);
    expect(showImageHint({ text: "hello", space: "open", caps: { tools: false } })).toBe(false);
  });
  test("hidden when the image model list loaded empty", () => {
    const o = { text: "tạo ảnh 1 con chó", space: "open" as const, caps: { tools: false } };
    expect(showImageHint({ ...o, imageModels: [] })).toBe(false);
    expect(showImageHint({ ...o, imageModels: [{}] })).toBe(true);
    expect(showImageHint({ ...o, imageModels: null })).toBe(true);
  });
  test("picks FLUX when listed", () => {
    expect(pickHintImageModel(["a", HINT_IMAGE_MODEL])).toBe(HINT_IMAGE_MODEL);
    expect(pickHintImageModel(["a", "b"])).toBe("a");
    expect(pickHintImageModel([])).toBe("");
  });

  describe("raw svg scanner: complexity and unclosed openers", () => {
    const svg = "<svg viewBox='0 0 1 1'><circle r='1'/></svg>";
    const tiny = "<svg><g/></svg>"; // keeps 20000 of them under RAW_SCAN_MAX
    test("20000 code spans + 20000 raw blocks stay fast", () => {
      const t = Array.from({ length: 20000 }, (_, i) => `\`c${i}\`\n\n${tiny}`).join("\n\n");
      const t0 = performance.now(); const segs = splitSvgFences(t); const ms = performance.now() - t0;
      expect(segs.filter((x) => x.type === "svg").length).toBe(20000); expect(ms).toBeLessThan(100);
    });
    test("20000 fences + raw blocks stay fast", () => {
      const t = Array.from({ length: 20000 }, (_, i) => `\`\`\`js\nx${i}\n\`\`\`\n\n${tiny}`).join("\n\n");
      const t0 = performance.now(); const segs = splitSvgFences(t); const ms = performance.now() - t0;
      expect(segs.filter((x) => x.type === "svg").length).toBe(20000); expect(ms).toBeLessThan(100);
    });
    test("an unclosed <svg before a valid block does not swallow it", () => {
      const segs = splitSvgFences(`<svg viewBox='0 0 1 1'>\n\nhello\n\n${svg}\n\nend`);
      expect(segs.filter((x) => x.type === "svg")).toEqual([{ type: "svg", source: svg }]);
    });
    test("nested svg stays one block", () => {
      const nested = "<svg>\n<svg><g/></svg>\n</svg>";
      expect(splitSvgFences(nested)).toEqual([{ type: "svg", source: nested }]);
    });
  });
});
