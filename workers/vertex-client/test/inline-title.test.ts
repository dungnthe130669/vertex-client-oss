import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ChatEngine, buildRequest, type IndexSink, type ServerEvent } from "../src/turn-engine";
import { SYSTEM_PROMPT } from "../src/system-prompt";
import { TITLE_INSTRUCTION, TitleStream, scrubBlock, inlineTitleEnabled, sanitizeInlineTitle, stripTitleMarkers } from "../src/inline-title";
import type { ModelProvider } from "../src/providers/types";

const sse = (evs: ServerEvent[]) => {
  const enc = new TextEncoder(); let i = 0;
  return new Response(new ReadableStream({ pull(ctl) { if (i < evs.length) ctl.enqueue(enc.encode(`event: ${evs[i].type}\ndata: ${JSON.stringify(evs[i++])}\n\n`)); else ctl.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
};
/** One reply: optional thinking block, then a text block whose deltas are `chunks`. */
const reply = (chunks: string[], opts: { thinking?: string } = {}): ServerEvent[] => {
  const ev: ServerEvent[] = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }];
  let idx = 0;
  if (opts.thinking !== undefined) ev.push({ type: "content_block_start", index: idx, content_block: { type: "thinking", thinking: "" } }, { type: "content_block_delta", index: idx, delta: { type: "thinking_delta", thinking: opts.thinking } }, { type: "content_block_delta", index: idx, delta: { type: "signature_delta", signature: "SIG" } }, { type: "content_block_stop", index: idx++ });
  ev.push({ type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
  for (const c of chunks) ev.push({ type: "content_block_delta", index: idx, delta: { type: "text_delta", text: c } });
  ev.push({ type: "content_block_stop", index: idx }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }, { type: "message_stop" });
  return ev;
};
const blocks = (specs: Array<{ kind: "thinking" | "text"; chunks: string[] }>): ServerEvent[] => {
  const ev: ServerEvent[] = [{ type: "message_start", message: { id: "m", usage: { input_tokens: 10, output_tokens: 1 } } }];
  specs.forEach((b, index) => {
    const f = b.kind === "text" ? "text" : "thinking";
    ev.push({ type: "content_block_start", index, content_block: { type: b.kind, [f]: "" } });
    for (const c of b.chunks) ev.push({ type: "content_block_delta", index, delta: { type: `${f}_delta`, [f]: c } });
    if (b.kind === "thinking") ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "SIG" } });
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } }, { type: "message_stop" });
  return ev;
};
const thinkingOfEvents = (evs: ServerEvent[]) => evs.filter((e) => e.type === "content_block_delta" && e.delta?.type === "thinking_delta").map((e) => e.delta.thinking).join("");
const textOfEvents = (evs: ServerEvent[]) => evs.filter((e) => e.type === "content_block_delta" && e.delta?.type === "text_delta").map((e) => e.delta.text).join("");

function rig(handler: (body: any) => Response, opts: { open?: boolean } = {}) {
  const db = new Database(":memory:");
  const calls: any[] = [];
  const provider: ModelProvider = {
    name: "stub", listModels: async () => [],
    messages: async (body: any) => { calls.push(body); return body.stream === false ? Response.json({ content: [{ type: "text", text: "Side Title" }], usage: { input_tokens: 5, output_tokens: 3 } }) : handler(body); },
  };
  const broadcasts: ServerEvent[] = [];
  const idx = { msgs: [] as any[], convs: [] as any[], applied: [] as any[], counts: [] as any[], exchanges: [] as any[] };
  const index: IndexSink = {
    indexMessage: async (m) => { idx.msgs.push(m); }, updateConversation: async (c) => { idx.convs.push(c); }, recordUsage: async () => {},
    applyAutoTitle: async (c) => { idx.applied.push(c); return true; }, countInlineTitle: async (c) => { idx.counts.push(c); },
    indexExchange: async (e) => { idx.exchanges.push(e); },
  };
  const engine = new ChatEngine({
    sql: { exec: (q, ...b) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...(b as any)) : (st.run(...(b as any)), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (_s, _t, e) => broadcasts.push(e) }, retryDelayMs: 1,
    ...(opts.open === false ? {} : { openSpace: () => true }),
  });
  engine.setConvId("conv-1"); engine.setMeta("model", "nvidia:some-model");
  return { engine, calls, broadcasts, idx, db };
}
const sideCalls = (r: ReturnType<typeof rig>) => r.calls.filter((b) => b.stream === false);
const MARK = "<vc-title>Bike balance physics</vc-title>\nBikes stay up because of steering.";

describe("TitleStream", () => {
  const run = (chunks: string[]) => {
    const f = new TitleStream(true); const out: ServerEvent[] = [];
    for (const e of reply(chunks)) out.push(...f.feed(e));
    return { f, out };
  };
  test("split at EVERY boundary (and char by char): marker never visible, answer intact, title found", () => {
    for (let i = 0; i <= MARK.length; i++) {
      const { f, out } = run([MARK.slice(0, i), MARK.slice(i)].filter(Boolean));
      expect(textOfEvents(out)).toBe("Bikes stay up because of steering.");
      expect(f.title).toBe("Bike balance physics");
    }
    const { f, out } = run([...MARK]);
    expect(textOfEvents(out)).toBe("Bikes stay up because of steering."); expect(f.title).toBe("Bike balance physics");
  });
  test("no delta ever shows any part of the marker, even prefixes, at any chunking", () => {
    const f = new TitleStream(true); const seen: string[] = [];
    for (const e of reply([...MARK])) for (const o of f.feed(e)) if (o.type === "content_block_delta") seen.push(o.delta.text);
    for (const s of seen) expect(/<\/?v?c?-?t?i?t?l?e?>?/.test(s) && s.includes("<")).toBe(false);
  });
  test("no marker: text passes through byte for byte (also a '<' that is not the marker)", () => {
    for (const t of ["Plain answer here.", "<div>html first</div> then more", "<vc not a marker", "  \n leading space answer"]) {
      for (let i = 0; i <= t.length; i++) {
        const { f, out } = run([t.slice(0, i), t.slice(i)].filter(Boolean));
        expect(textOfEvents(out)).toBe(t); expect(f.title).toBeNull();
      }
    }
  });
  test("malformed / oversized / duplicated: dropped silently, never shown", () => {
    let r = run(["<vc-title>never closed and the stream just stops"]); expect(textOfEvents(r.out)).toBe(""); expect(r.f.title).toBeNull();
    r = run([`<vc-title>${"x".repeat(300)}</vc-title>\nAnswer`]); expect(textOfEvents(r.out)).toBe("Answer"); expect(r.f.title).toBeNull();
    r = run(["<vc-title>First</vc-title>\nA", "<vc-title>Second</vc-title>"]); expect(r.f.title).toBe("First");
    r = run(["<vc-title></vc-title>\nAnswer"]); expect(textOfEvents(r.out)).toBe("Answer"); expect(r.f.title).toBeNull();
  });
  test("disabled stream is untouched; a marker in a later text block is stripped and never the title", () => {
    const off = new TitleStream(false); const evs = reply([MARK]);
    expect(evs.flatMap((e) => off.feed(e))).toEqual(evs);
    const f = new TitleStream(true);
    const second = [{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "<vc-title>X</vc-title>" } }];
    f.feed({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }); f.feed({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } }); f.feed({ type: "content_block_stop", index: 0 });
    const out = second.flatMap((e) => f.feed(e)); f.feed({ type: "content_block_stop", index: 1 });
    expect(JSON.stringify(out)).not.toContain("vc-title"); expect(f.title).toBeNull();
  });
  test("sanitize: plain text, <= 60 chars, no markup/quotes/newlines; sentences rejected", () => {
    expect(sanitizeInlineTitle('  "**Bike** <b>physics</b>"\n')).toBe("Bike physics");
    expect(sanitizeInlineTitle("a ".repeat(40).trim()).length).toBeLessThanOrEqual(60);
    expect(sanitizeInlineTitle("I need to think about what a good title for this would be, okay")).toBe("");
    expect(sanitizeInlineTitle("")).toBe("");
    expect(stripTitleMarkers("a <vc-title>x</vc-title> b <vc-title>y</vc-title>c")).toBe("a b c");
    expect(stripTitleMarkers("hi <vc-title>dangling")).toBe("hi ");
  });
});

describe("TitleStream: every block, hardened", () => {
  const run = (evs: ServerEvent[], allow = true) => { const f = new TitleStream(true, allow); return { f, out: evs.flatMap((e) => f.feed(e)) }; };
  test("markers in reasoning and in later text blocks are stripped live, never a title, signature of edited thinking dropped", () => {
    const { f, out } = run(blocks([{ kind: "thinking", chunks: ["plan <vc-ti", "tle>Leak</vc-ti", "tle> go"] }, { kind: "text", chunks: ["Answer. "] }, { kind: "text", chunks: ["more <vc-title>Late</vc-title>text"] }]));
    expect(thinkingOfEvents(out)).toBe("plan go");
    expect(textOfEvents(out)).toBe("Answer. more text");
    expect(JSON.stringify(out)).not.toContain("vc-title"); expect(JSON.stringify(out)).not.toContain("SIG");
    expect(f.title).toBeNull();
  });
  test("a duplicated marker right after the leading one is removed live", () => {
    const { f, out } = run(reply(["<vc-title>One</vc-title>\n<vc-title>Two</vc-title>\nBody ", "<vc-ti", "tle>Three</vc-title> end"]));
    expect(textOfEvents(out)).toBe("Body end"); expect(f.title).toBe("One");
  });
  test("unclosed oversize marker is dropped, never shown; the stream keeps no part of it", () => {
    const { out } = run(reply(["Hi <vc-title>", "x".repeat(900), "y".repeat(900)]));
    expect(textOfEvents(out)).toBe("Hi "); expect(JSON.stringify(out)).not.toContain("xxx");
  });
  test("allowTitle=false (later iteration): marker stripped, title ignored", () => {
    const { f, out } = run(reply(["<vc-title>Tainted</vc-title>\nAnswer"]), false);
    expect(textOfEvents(out)).toBe("Answer"); expect(f.title).toBeNull();
  });
  test("a non-leading marker in the first block is not a title", () => {
    const { f, out } = run(reply(["Answer first <vc-title>Late</vc-title>done"]));
    expect(textOfEvents(out)).toBe("Answer first done"); expect(f.title).toBeNull();
  });
  test("sanitize: controls, ESC, bidi, zero-width removed; lone < or > rejected", () => {
    expect(sanitizeInlineTitle("Bike\u001b\u0085 phys\u202eics\u200b\u0000")).toBe("Bike physics");
    const t = sanitizeInlineTitle("a\u202eb\u200bc\u0007d  e"); expect(t).toBe("abc d e");
    expect(sanitizeInlineTitle("a < b")).toBe(""); expect(sanitizeInlineTitle("<b unclosed")).toBe(""); expect(sanitizeInlineTitle("x > y")).toBe("");
    expect(sanitizeInlineTitle("y".repeat(200)).length).toBeLessThanOrEqual(60);
  });
  test("sanitize: U+061C and every bidi format control removed", () => {
    expect(sanitizeInlineTitle("a\u061Cb\u200Ec\u200Fd\u202Ae\u202Bf\u202Cg\u202Dh\u202Ei\u2066j\u2067k\u2068l\u2069m")).toBe("abcdefghijklm");
  });
  test("scrubBlock: thinking with a marker loses it and its signature; clean blocks untouched", () => {
    expect(scrubBlock({ type: "thinking", thinking: "a<vc-title>x</vc-title>b", signature: "S" })).toEqual({ type: "thinking", thinking: "ab" } as any);
    const clean = { type: "thinking", thinking: "fine", signature: "S" }; expect(scrubBlock(clean)).toBe(clean);
  });
});

describe("TitleStream: unclosed marker (model omits </vc-title>)", () => {
  const run = (chunks: string[]) => { const f = new TitleStream(true); const out: ServerEvent[] = []; for (const e of reply(chunks)) out.push(...f.feed(e)); return { f, out }; };
  const ANS = "Thủ đô của Việt Nam là Hà Nội.";
  test("title line ends at the newline: answer kept, title taken", () => {
    const { f, out } = run(["<vc-title>", "Thủ đô của Việt Nam", "\n\n", ANS]);
    expect(textOfEvents(out)).toBe(ANS); expect(f.title).toBe("Thủ đô của Việt Nam");
  });
  test("no newline ever: stays hidden, nothing after it", () => {
    const { f, out } = run(["<vc-title>Hello"]); expect(textOfEvents(out)).toBe(""); expect(f.title).toBeNull();
  });
  test("saved-text path: same rule", () => {
    expect(stripTitleMarkers(`<vc-title>Thủ đô của Việt Nam\n\n${ANS}`)).toBe(ANS);
    expect(stripTitleMarkers("<vc-title>Hello")).toBe("");
    expect(stripTitleMarkers("hi <vc-title>dangling")).toBe("hi ");
    expect(stripTitleMarkers("<vc-title>Open\n\nBody <vc-title>X</vc-title>end")).toBe("Body end");
  });
  test("closed marker unchanged", () => {
    const { f, out } = run(["<vc-title>Title</vc-title>\n\nAnswer\nline two"]);
    expect(textOfEvents(out)).toBe("Answer\nline two"); expect(f.title).toBe("Title");
    expect(stripTitleMarkers("<vc-title>T</vc-title>\nA\nB")).toBe("A\nB");
  });
  test("opener split across chunks plus late newline, at every split", () => {
    const t = "<vc-title>Hanoi facts\n\nHanoi is the capital.";
    for (let i = 0; i <= t.length; i++) {
      const { f, out } = run([t.slice(0, i), t.slice(i)].filter(Boolean));
      expect(textOfEvents(out)).toBe("Hanoi is the capital."); expect(f.title).toBe("Hanoi facts");
    }
    const { f, out } = run([...t]); expect(textOfEvents(out)).toBe("Hanoi is the capital."); expect(f.title).toBe("Hanoi facts");
  });
  test("oversize unclosed title line is bounded, answer after its newline kept, no title", () => {
    const { f, out } = run(["<vc-title>", "x".repeat(900), "y".repeat(900), "\n\nAnswer"]);
    expect(textOfEvents(out)).toBe("Answer"); expect(f.title).toBeNull(); expect(JSON.stringify(out)).not.toContain("xxx");
    const big = run(["<vc-title>" + "z".repeat(5000) + "\nAnswer"]);
    expect(textOfEvents(big.out)).toBe("Answer"); expect(big.f.title).toBeNull();
  });
});

describe("TitleStream: round 2 (multi-line closed marker, parity of streamed and saved text)", () => {
  const run = (chunks: string[]) => { const f = new TitleStream(true); const out: ServerEvent[] = []; for (const e of reply(chunks)) out.push(...f.feed(e)); return { f, out }; };
  const splits = (t: string, fn: (chunks: string[]) => void) => { for (let i = 0; i <= t.length; i++) fn([t.slice(0, i), t.slice(i)].filter(Boolean)); fn([...t]); };
  test("closed marker whose title spans a newline: normal closed marker at every split", () => {
    const t = "<vc-title>Quarterly\nreport</vc-title>\nAnswer";
    splits(t, (c) => { const { f, out } = run(c); expect(textOfEvents(out)).toBe("Answer"); expect(f.title).toBe("Quarterly report"); });
    expect(stripTitleMarkers(t)).toBe("Answer");
  });
  test("mistral case (no closer) at every split, stream and saved", () => {
    const t = "<vc-title>Thủ đô\n\nThủ đô là Hà Nội.";
    splits(t, (c) => { const { f, out } = run(c); expect(textOfEvents(out)).toBe("Thủ đô là Hà Nội."); expect(f.title).toBe("Thủ đô"); });
    expect(stripTitleMarkers(t)).toBe("Thủ đô là Hà Nội.");
  });
  test("unclosed marker followed by a later closed one: the first ends at its newline", () => {
    const { f, out } = run(["<vc-title>One\n\nBody <vc-title>Two</vc-title> end"]);
    expect(textOfEvents(out)).toBe("Body end"); expect(f.title).toBe("One");
  });
  test("CRLF parity", () => {
    for (const t of ["<vc-title>T\r\n\r\nAnswer", "<vc-title>T</vc-title>\r\n\r\nAnswer", "<vc-title>A\r\nB</vc-title>\r\nAnswer"]) {
      const { out } = run([t]); expect(textOfEvents(out)).toBe("Answer"); expect(stripTitleMarkers(t)).toBe("Answer");
    }
  });
  test("leading whitespace parity before a leading marker, and after it", () => {
    for (const t of ["  \n<vc-title>T</vc-title>\nA\nB", "\n\n<vc-title>T\n\nA\nB", "<vc-title>T</vc-title>  indented", "text <vc-title>T</vc-title>\n more"]) {
      const { out } = run([t]); expect(stripTitleMarkers(t)).toBe(textOfEvents(out));
    }
    expect(stripTitleMarkers("  \n<vc-title>T</vc-title>\nA")).toBe("A");
  });
  test("cap exceeded without a closer: ends at the first newline, buffering bounded", () => {
    const body = "q".repeat(600);
    let r = run([`<vc-title>${body}\nAnswer`]); expect(textOfEvents(r.out)).toBe("Answer"); expect(r.f.title).toBeNull();
    r = run(["<vc-title>short\n", "z".repeat(700), "\nmore"]); expect(textOfEvents(r.out)).toBe("z".repeat(700) + "\nmore"); expect(r.f.title).toBe("short");
    expect(stripTitleMarkers(`<vc-title>${body}\nAnswer`)).toBe("Answer");
    r = run(["<vc-title>", body, body, "\n\nAnswer"]); expect(textOfEvents(r.out)).toBe("Answer");
    r = run([`<vc-title>${body}</vc-title>\nAnswer`]); expect(textOfEvents(r.out)).toBe("Answer"); expect(r.f.title).toBeNull();
  });
});

describe("engine: inline title on the first Open reply", () => {
  test("marker in reasoning + a later text block: not in storage, history, index or stream", async () => {
    const r = rig(() => sse(blocks([{ kind: "thinking", chunks: ["<vc-title>R</vc-title>hm"] }, { kind: "text", chunks: ["<vc-title>Real</vc-title>\nA", " <vc-title>Dup</vc-title>B"] }])));
    await r.engine.send("question");
    expect(r.engine.state().title).toBe("Real");
    expect(JSON.stringify(r.broadcasts)).not.toContain("vc-title");
    expect(JSON.stringify(r.db.query("SELECT data, content FROM events, messages").all())).not.toContain("vc-title");
    expect(JSON.stringify(r.idx.msgs)).not.toContain("vc-title"); expect(JSON.stringify(r.idx.exchanges)).not.toContain("vc-title");
  });
  test("renamed during the first reply: no title event, no fallback overwrite (both paths)", async () => {
    for (const marker of [true, false]) {
      const r = rig(() => sse(reply([marker ? "<vc-title>Auto</vc-title>\nAnswer" : "Answer"])));
      (r.idx as any).changed = false;
      const sink = (r.engine as any).index; sink.applyAutoTitle = async (c: any) => { r.idx.applied.push(c); return false; };
      await r.engine.send("question");
      expect(r.broadcasts.filter((e) => e.type === "title")).toHaveLength(0);
      expect(r.engine.state().title).toBe("");
      expect(r.idx.convs.every((c: any) => c.title === undefined)).toBe(true);
    }
  });
  test("fallback path uses the conditional write and emits only after it changed a row", async () => {
    const r = rig(() => sse(reply(["No marker."])));
    await r.engine.send("question");
    expect(r.idx.applied).toEqual([{ id: "conv-1", title: "Side Title" }]);
    expect(r.broadcasts.filter((e) => e.type === "title")).toHaveLength(1);
  });
  test("tool-only first response: later iterations never ask for or accept a marker; fallback title call runs", async () => {
    let n = 0;
    const r = rig((body) => {
      n++;
      if (n === 1) return sse([{ type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 1 } } }, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "nope", input: {} } }, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }, { type: "message_stop" }]);
      return sse(reply(["<vc-title>Tainted</vc-title>\nDone"]));
    });
    (r.engine as any).tools = { list: async () => [{ name: "nope", description: "d", input_schema: { type: "object", properties: {} } }], run: async () => ({ content: "ok" }), needsApproval: () => false };
    await r.engine.send("question");
    const streamed = r.calls.filter((b) => b.stream);
    expect(streamed[0].system.at(-2).text).toBe(TITLE_INSTRUCTION); expect(streamed[0].system.at(-1).text).toMatch(/^Tools: /);
    for (const b of streamed.slice(1)) expect(b.system.some((x: any) => x.text === TITLE_INSTRUCTION)).toBe(false);
    expect(r.engine.state().title).not.toBe("Tainted");
    expect(JSON.stringify(r.broadcasts)).not.toContain("vc-title");
  });

  test("marker present: hidden everywhere, title applied from it, the title call is NOT made, counted ok", async () => {
    const r = rig(() => sse(reply(["<vc-ti", "tle>Bike balance physics</vc-", "title>\nBikes stay up ", "because of steering."])));
    await r.engine.send("how do bikes balance");
    expect(sideCalls(r)).toHaveLength(0);
    expect(r.engine.state().title).toBe("Bike balance physics");
    expect(r.broadcasts.filter((e) => e.type === "title").map((e) => e.title)).toEqual(["Bike balance physics"]);
    expect(r.idx.applied).toEqual([{ id: "conv-1", title: "Bike balance physics" }]);
    expect(r.idx.counts).toEqual([{ outcome: "ok", model: "nvidia:some-model" }]);
    // the request asked for it (separate block, base prompt untouched)
    expect(r.calls[0].system.at(-2).text).toBe(TITLE_INSTRUCTION); expect(r.calls[0].system.at(-1).text).toMatch(/^Tools: /);
    // hidden: stream events, event log, saved message, index text
    expect(JSON.stringify(r.broadcasts)).not.toContain("vc-title");
    expect(JSON.stringify(r.db.query("SELECT data FROM events").all())).not.toContain("vc-title");
    const a = r.engine.state().messages.find((m: any) => m.role === "assistant")!;
    expect(a.content).toEqual([{ type: "text", text: "Bikes stay up because of steering." }]);
    expect(JSON.stringify(r.idx.msgs)).not.toContain("vc-title");
    expect(JSON.stringify(r.idx.exchanges)).not.toContain("vc-title");
  });
  test("a marker on a LATER turn never streams and never changes the title", async () => {
    let n = 0;
    const r = rig(() => sse(reply([n++ === 0 ? "<vc-title>First</vc-title>\nOne" : "Two <vc-ti", "tle>Later</vc-title>\nmore"])));
    await r.engine.send("first");
    expect(r.engine.state().title).toBe("First");
    r.broadcasts.length = 0;
    await r.engine.send("second");
    expect(JSON.stringify(r.broadcasts)).not.toContain("vc-title"); expect(JSON.stringify(r.broadcasts)).not.toContain("Later");
    expect(r.engine.state().title).toBe("First");
    expect(r.broadcasts.filter((e) => e.type === "title")).toHaveLength(0);
  });
  test("history replayed to the model never contains a marker (even one stored by an older build)", async () => {
    const r = rig(() => sse(reply(["ok"])));
    await r.engine.send("first"); r.engine.setMeta("title", "T");
    r.db.query("UPDATE messages SET content=? WHERE role='assistant'").run(JSON.stringify([{ type: "text", text: "<vc-title>Old</vc-title>\nStored answer" }]));
    await r.engine.send("second");
    const last = r.calls.filter((b) => b.stream).at(-1);
    expect(JSON.stringify(last.messages)).not.toContain("vc-title"); expect(JSON.stringify(last.messages)).toContain("Stored answer");
    expect(last.system.some((s: any) => s.text === TITLE_INSTRUCTION)).toBe(false); // second turn: no instruction
  });
  test("marker missing: the existing title call runs exactly once, counted fallback", async () => {
    const r = rig(() => sse(reply(["Bikes stay up because of steering."])));
    await r.engine.send("how do bikes balance");
    expect(sideCalls(r)).toHaveLength(1);
    expect(r.engine.state().title).toBe("Side Title");
    expect(r.idx.counts).toEqual([{ outcome: "fallback", model: "nvidia:some-model" }]);
    expect(r.idx.applied).toEqual([{ id: "conv-1", title: "Side Title" }]); // fallback also goes through the conditional write
  });
  test("a marker only inside a reasoning block never becomes the title", async () => {
    const r = rig(() => sse(reply(["Answer without a marker."], { thinking: "<vc-title>Leaked Reasoning</vc-title>" })));
    await r.engine.send("question");
    expect(r.engine.state().title).toBe("Side Title"); expect(sideCalls(r)).toHaveLength(1);
  });
  test("a malformed marker is dropped silently and the fallback runs", async () => {
    const r = rig(() => sse(reply([`<vc-title>${"long ".repeat(60)}</vc-title>\nAnswer text`])));
    await r.engine.send("question");
    expect(r.engine.state().title).toBe("Side Title");
    expect(r.engine.state().messages.find((m: any) => m.role === "assistant")!.content).toEqual([{ type: "text", text: "Answer text" }]);
  });
  test("duplicated marker later in the reply is stripped from storage; the first title wins", async () => {
    const r = rig(() => sse(reply(["<vc-title>First</vc-title>\nBody one. ", "<vc-title>Second</vc-title> Body two."])));
    await r.engine.send("question");
    expect(r.engine.state().title).toBe("First");
    expect(JSON.stringify(r.engine.state().messages.find((m: any) => m.role === "assistant"))).not.toContain("vc-title");
  });
  test("a title the user already set is never overwritten, and no marker is requested", async () => {
    const r = rig(() => sse(reply(["<vc-title>Auto</vc-title>\nAnswer"])));
    r.engine.setMeta("title", "My own name");
    await r.engine.send("question");
    expect(r.engine.state().title).toBe("My own name");
    expect(r.calls[0].system.some((s: any) => s.text === TITLE_INSTRUCTION)).toBe(false);
    expect(sideCalls(r)).toHaveLength(0); expect(r.idx.applied).toHaveLength(0);
  });
  test("renamed during the first reply: the D1 write is conditional on an empty title", async () => {
    const src = await Bun.file(new URL("../src/index-d1.ts", import.meta.url)).text();
    expect(src).toContain("WHERE id=? AND (title IS NULL OR title='')");
  });
  test("Business space: no instruction, byte-identical system prompt, marker text is not treated as a title", async () => {
    const r = rig(() => sse(reply(["<vc-title>Nope</vc-title>\nAnswer"])), { open: false });
    await r.engine.send("question");
    expect(r.calls[0].system).toHaveLength(1); expect(r.calls[0].system[0].text).toBe(SYSTEM_PROMPT);
    expect(r.idx.counts).toHaveLength(0);
    expect(inlineTitleEnabled("biz")).toBe(false); expect(inlineTitleEnabled("open")).toBe(true);
    expect(buildRequest("claude-sonnet-5-5", [], [], null, null, false, null, false).system).toHaveLength(1);
  });
});
