// Open chat answered with a blank bubble (2026-10-26): NVIDIA's reasoning model streams reasoning_content + content and was cut at 4096 tokens mid-<svg>.
import { describe, expect, test } from "bun:test";
import { MAX_HOLD } from "../src/inline-title";
import { toAnthropicStream } from "../src/providers/openai-compat";
import { asCodeBlock, htmlIsBlank, splitSvgFences } from "../web/src/svg-safe";
import { emptyAnswerNote } from "../web/src/chat-state";
import { nvidiaDefaultModels } from "../src/providers/config";

const sse = (chunks: unknown[]) => new ReadableStream<Uint8Array>({ start(c) { const e = new TextEncoder(); for (const x of chunks) c.enqueue(e.encode(`data: ${JSON.stringify(x)}\n\n`)); c.enqueue(e.encode("data: [DONE]\n\n")); c.close(); } });
const events = async (s: ReadableStream<Uint8Array>) => (await new Response(s).text()).split("\n\n").filter(Boolean).map((b) => JSON.parse(b.split("\n").find((l) => l.startsWith("data:"))!.slice(5)));
const d = (delta: unknown, finish: string | null = null) => ({ choices: [{ delta, finish_reason: finish }] });

describe("openai-compat keeps reasoning", () => {
  test("reasoning_content -> thinking block, then content -> text block; finish length -> max_tokens", async () => {
    const ev = await events(toAnthropicStream(sse([d({ role: "assistant" }), d({ reasoning_content: "think " }), d({ reasoning_content: "more" }), d({ content: "Hi" }), d({}, "length"), { choices: [], usage: { prompt_tokens: 78, completion_tokens: 4096 } }]), "m"));
    const starts = ev.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type);
    expect(starts).toEqual(["thinking", "text"]);
    expect(ev.filter((e) => e.delta?.type === "thinking_delta").map((e) => e.delta.thinking).join("")).toBe("think more");
    expect(ev.find((e) => e.type === "message_delta").delta.stop_reason).toBe("max_tokens");
  });
  test("`reasoning` field also works; reasoning-only reply still yields a thinking block", async () => {
    const ev = await events(toAnthropicStream(sse([d({ reasoning: "only thoughts" }), d({}, "length")]), "m"));
    expect(ev.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type)).toEqual(["thinking"]);
  });
});

describe("a finished reply is never blank", () => {
  const raw = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9 9">\n<circle r="4"/>\n<ellipse cx="1" cy';
  test("unclosed raw <svg (output limit) shows as a code block, prose kept", () => {
    const segs = splitSvgFences(`Here:\n\n${raw}`);
    expect(segs.every((s) => s.type === "text")).toBe(true);
    const all = segs.map((s) => (s as any).text).join("");
    expect(all).toContain("Here:");
    expect(all).toContain("```xml\n<svg");
    expect(all.trim().endsWith("```")).toBe(true);
  });
  test("raw only, no prose", () => expect((splitSvgFences(raw)[0] as any).text).toMatch(/^```xml\n<svg/));
  test("unclosed raw <svg inside a code fence is untouched; valid svg still an svg segment", () => {
    expect(splitSvgFences("```html\n" + raw)).toEqual([{ type: "text", text: "```html\n" + raw }]);
    const ok = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
    expect(splitSvgFences(ok)).toEqual([{ type: "svg", source: ok }]);
  });
  test("streaming still shows the pending placeholder", () => expect(splitSvgFences(`x\n${raw}`, true).map((s) => s.type)).toEqual(["text", "pending"]));
  test("unclosed ```xml fence (the observed shape) stays markdown, which renders as code", () => expect(splitSvgFences("Done.\n\n```xml\n" + raw)).toEqual([{ type: "text", text: "Done.\n\n```xml\n" + raw }]));
  test("htmlIsBlank / asCodeBlock", () => {
    expect(htmlIsBlank("<p></p>\n")).toBe(true);
    expect(htmlIsBlank("<p>hi</p>")).toBe(false);
    expect(htmlIsBlank('<p><img src="/x"></p>')).toBe(false);
    expect(asCodeBlock("a ``` b")).toBe("````\na ``` b\n````");
  });
  test("empty-answer notes name the cause", () => {
    expect(emptyAnswerNote("max_tokens", true)).toContain("thinking");
    expect(emptyAnswerNote("max_tokens", false)).toContain("output limit");
    expect(emptyAnswerNote("end_turn", false)).toContain("empty answer");
  });
});

test("NVIDIA models get room for an answer (4096 cut the SVG mid-tag)", () => {
  for (const m of nvidiaDefaultModels()) expect(m.maxTokens).toBeGreaterThanOrEqual(8192);
});

describe("openai-compat: reasoning written into content (<think>/<thinking> at the START of the reply)", () => {
  const run = async (parts: string[], extra: unknown[] = [d({}, "stop")]) => {
    const ev = await events(toAnthropicStream(sse([...parts.map((c) => d({ content: c })), ...extra]), "m"));
    return {
      blocks: ev.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type),
      think: ev.filter((e) => e.delta?.type === "thinking_delta").map((e) => e.delta.thinking).join(""),
      text: ev.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join(""),
    };
  };
  test("<thinking> split across chunks -> thinking block, then the answer as text", async () => {
    const r = await run(["<thin", "king> The user asks", "</thinking>\n", "Hà Nội."]);
    expect(r.blocks).toEqual(["thinking", "text"]); expect(r.think).toBe(" The user asks"); expect(r.text).toBe("Hà Nội.");
  });
  test("never closed -> thinking only, no text block", async () => {
    const r = await run(["<think>The user asks", " a thing and I keep going"]);
    expect(r.blocks).toEqual(["thinking"]); expect(r.text).toBe(""); expect(r.think).toBe("The user asks a thing and I keep going");
  });
  test("a half-seen close tag at the end is released as thinking, not lost", async () => {
    const r = await run(["<think>abc</thi"]);
    expect(r.blocks).toEqual(["thinking"]); expect(r.think).toBe("abc</thi");
  });
  test("plain text is unchanged and released as soon as it cannot be a tag", async () => {
    const ev = await events(toAnthropicStream(sse([d({ content: "Hà" }), d({ content: " Nội" }), d({}, "stop")]), "m"));
    const deltas = ev.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text);
    expect(deltas).toEqual(["Hà", " Nội"]); // "H" is not "<": no hold at all
    const r = await run(["<", "b>bold</b>"]); expect(r.blocks).toEqual(["text"]); expect(r.text).toBe("<b>bold</b>");
    const r2 = await run(["<thinker", " says hi"]); expect(r2.blocks).toEqual(["text"]); expect(r2.text).toBe("<thinker says hi");
  });
  test("a held head is flushed at the end of the reply", async () => {
    const r = await run(["<thin"]); expect(r.blocks).toEqual(["text"]); expect(r.text).toBe("<thin");
  });
  test("a later mention of <think> inside a real answer is untouched", async () => {
    const r = await run(["Use the ", "<think>", " tag like this</think> ok"]);
    expect(r.blocks).toEqual(["text"]); expect(r.text).toBe("Use the <think> tag like this</think> ok");
  });
  test("reasoning_content + normal content is unchanged", async () => {
    const ev = await events(toAnthropicStream(sse([d({ reasoning_content: "why" }), d({ content: "Hi" }), d({}, "stop")]), "m"));
    expect(ev.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type)).toEqual(["thinking", "text"]);
  });
  test("think block, then a <vc-title> marker, then the answer: the text stream carries marker + answer for the title scrub", async () => {
    const r = await run(["<think>hmm</think>\n", "<vc-title>x</vc-title>", "answer"]);
    expect(r.blocks).toEqual(["thinking", "text"]); expect(r.think).toBe("hmm"); expect(r.text).toBe("<vc-title>x</vc-title>answer");
  });
  test("<vc-title> first (no think block) is plain text, as before", async () => {
    const r = await run(["<vc-title>x</vc-title>answer"]);
    expect(r.blocks).toEqual(["text"]); expect(r.text).toBe("<vc-title>x</vc-title>answer");
  });
  test("every split of the open tag gives the same result", async () => {
    const full = "<thinking>why</thinking>\nHà Nội.";
    for (let i = 1; i < full.length; i++) for (let j = i; j < full.length; j++) {
      const r = await run([full.slice(0, i), full.slice(i, j), full.slice(j)].filter(Boolean));
      expect([i, j, r.blocks.join(","), r.think, r.text]).toEqual([i, j, "thinking,text", "why", "Hà Nội."]);
    }
  });
  test("a tool call right after a held head does not land the text after the tool block", async () => {
    const ev = await events(toAnthropicStream(sse([d({ content: "<thin" }), d({ tool_calls: [{ index: 0, id: "c1", function: { name: "web_read", arguments: "{}" } }] }), d({}, "tool_calls")]), "m"));
    expect(ev.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type)).toEqual(["text", "tool_use"]);
  });
  test("property: every 1-, 2- and 3-way split gives the same thinking and visible text as the unsplit run", async () => {
    const inputs = ["<think>secret</think>answer", "   <think>why</think>answer", "\n\n<thinking>why</thinking>\nHà Nội.", "Hà Nội, plain text", "<thinker>x", "<th plain", "<think>never closed </thi", "<think>a</think>\n    code", "  \t<thinking>q</thinking>  \n  x"];
    for (const full of inputs) {
      const base = await run([full]);
      const seen = (r: typeof base) => JSON.stringify([r.blocks, r.think, r.text]);
      const cuts: number[][] = [];
      for (let i = 1; i < full.length; i++) { cuts.push([i]); for (let j = i + 1; j < full.length; j++) { cuts.push([i, j]); for (let k = j + 1; k < full.length; k++) cuts.push([i, j, k]); } }
      for (const c of cuts) {
        const parts = [0, ...c, full.length].slice(0, -1).map((a, n, arr) => full.slice(a, [...arr, full.length][n + 1]!));
        const r = await run(parts);
        if (seen(r) !== seen(base)) throw new Error(`split ${JSON.stringify(parts)} of ${JSON.stringify(full)}: ${seen(r)} != ${seen(base)}`);
      }
    }
    for (const full of [" ".repeat(70) + "<think>s</think>a", " ".repeat(66) + "<vc-title>x</vc-title><think>s</think>a"]) {
      const base = await run([full]);
      for (let i = 1; i < full.length; i++) for (let j = i + 1; j < full.length; j += 3) {
        const r = await run([full.slice(0, i), full.slice(i, j), full.slice(j)]);
        expect(JSON.stringify([r.think, r.text])).toBe(JSON.stringify([base.think, base.text]));
      }
    }
  }, 300000);
  test("leading whitespace is not counted against the tag hold; arbitrarily long whitespace is bounded and the tag after it is still detected", async () => {
    const r = await run([" ".repeat(13), "<think>secret</think>answer"]);
    expect(r.think).toBe("secret"); expect(r.text).toBe("answer");
    for (const n of [65, 70, 5000]) {
      const r2 = await run([" ".repeat(n), "<think>x</think>y"]);
      expect(r2.think).toBe("x"); expect(r2.text.trim()).toBe("y");
      const r3 = await run([" ".repeat(n) + "<think>x</think>y"]); expect(r3.think).toBe("x");
    }
    expect((await run([" ".repeat(5000) + "plain"])).text).toBe(" ".repeat(5000) + "plain");
  });
  test("a leading <vc-title> marker is transparent: title->think and think->title both hide the reasoning, the marker reaches the text stream unchanged", async () => {
    const a = await run(["<vc-title>x</vc-title><think>secret</think>answer"]);
    expect(a.think).toBe("secret"); expect(a.text).toBe("<vc-title>x</vc-title>answer");
    const b = await run(["<think>secret</think>\n<vc-title>x</vc-title>answer"]);
    expect(b.think).toBe("secret"); expect(b.text).toBe("<vc-title>x</vc-title>answer");
    const c = await run(["<vc-title>x</vc-title>\n<thinking>secret</thinking>answer"]);
    expect(c.think).toBe("secret"); expect(c.text).toBe("<vc-title>x</vc-title>answer");
    const e = await run(["<vc-title>x</vc-title>answer <think>kept</think>"]); expect(e.think).toBe(""); expect(e.text).toBe("<vc-title>x</vc-title>answer <think>kept</think>");
    const big = `<vc-title>${"t".repeat(MAX_HOLD + 50)}</vc-title><think>s</think>a`; expect((await run([big])).think).toBe("");
  });
  test("an in-band SSE error event flushes the held head first", async () => {
    const ev = await events(toAnthropicStream(sse([d({ content: "<thin" }), { error: { message: "upstream failed" } }]), "m"));
    expect(ev.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("")).toBe("<thin");
    expect(ev.at(-1).type).toBe("error");
  });
  test("structured reasoning seen: a literal leading <think> in content is kept as text", async () => {
    const ev = await events(toAnthropicStream(sse([d({ reasoning_content: "r" }), d({ content: "<think>literal</think> visible" }), d({}, "stop")]), "m"));
    expect(ev.filter((e) => e.delta?.type === "thinking_delta").map((e) => e.delta.thinking).join("")).toBe("r");
    expect(ev.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("")).toBe("<think>literal</think> visible");
  });
  test("only the separator after the close tag is consumed: indentation of the answer is kept", async () => {
    expect((await run(["<think>x</think>\n    code"])).text).toBe("    code");
    expect((await run(["<think>x</think>", " ", " ", "\n", "  ", "  y"])).text).toBe("    y");
    expect((await run(["<think>x</think>  y"])).text).toBe("y");
    expect((await run(["<think>x</think>\n\n\nz"])).text).toBe("\n\nz");
  });
  test("a held head survives an upstream read error and an abort", async () => {
    const enc = new TextEncoder(); let n = 0;
    const bad = new ReadableStream<Uint8Array>({ pull(c) { if (n++ === 0) c.enqueue(enc.encode(`data: ${JSON.stringify(d({ content: "<thin" }))}\n\n`)); else c.error(new Error("boom")); } });
    const ev = await events(toAnthropicStream(bad, "m"));
    expect(ev.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("")).toBe("<thin");
    expect(ev.some((e) => e.type === "error")).toBe(true);
    const ac = new AbortController(); let m = 0;
    const hang = new ReadableStream<Uint8Array>({ pull(c) { if (m++ === 0) { c.enqueue(enc.encode(`data: ${JSON.stringify(d({ content: "<thin" }))}\n\n`)); return; } return new Promise(() => {}); }, cancel() {} });
    const out = toAnthropicStream(hang, "m", ac.signal); setTimeout(() => ac.abort(), 20);
    const ev2 = await events(out);
    expect(ev2.filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("")).toBe("<thin");
  });
});
