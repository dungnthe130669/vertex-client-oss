// "Open chat stuck": the model writes "(web_read đang thực hiện...)" as TEXT and the turn ends (docs/reports/toolcall-diag.md). The fixtures are RAW NIM streams
// captured live from nvidia/nemotron-3.5-lightning-30b-a3b with the real request our adapter builds for an Open chat.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import "../src/providers/config";
import { buildRegistry } from "../src/providers/registry";
import { seedCatalog } from "../src/providers/catalog";
import { cfToolsHost, withCfTools } from "../src/cf-tools";
import { ChatEngine } from "../src/turn-engine";
import { scopeFor } from "../src/scope";
import { openaiCompatProvider, toAnthropicStream, toChatRequest } from "../src/providers/openai-compat";
import { toGeminiContents } from "../src/providers/gemini";
import { hasLiveCue } from "../src/live-cues";
import { narratesToolCall, withoutNarration, NARRATION_NOTE, NARRATION_NOTE_AFTER_TOOL } from "../src/tool-narration";

const fx = (n: string) => readFileSync(new URL(`../fixtures/nim-toolcall/${n}`, import.meta.url));
const OPEN = scopeFor("main", "open");
const NAMES = ["web_links", "web_read", "web_screenshot"];
const NARR_TEXT = "Bắt đầu lấy dữ liệu thời tiết thời gian thực...\n\n(web_read đang thực hiện...)";
const sseOf = (delta: any, fin: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: fin }] })}\n\n`;
const narrationStream = () => new Response(sseOf({ role: "assistant", content: "<vc-title>Thời tiết Hà Nội</vc-title>\n" }) + sseOf({ content: NARR_TEXT }) + sseOf({}, "stop") + "data: [DONE]\n\n");
const toolCallStream = () => new Response(sseOf({ role: "assistant", content: "", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "web_read", arguments: JSON.stringify({ url: "https://thoitiet.vn/" }) } }] }) + sseOf({}, "tool_calls") + "data: [DONE]\n\n");
const answerStream = () => new Response(sseOf({ role: "assistant", content: "Hà Nội hôm nay 30°C." }) + sseOf({}, "stop") + "data: [DONE]\n\n");

async function events(raw: Buffer) {
  const out = await new Response(toAnthropicStream(new Response(raw.toString("utf8")).body!, "m")).text();
  return out.split("\n\n").filter(Boolean).map((c) => JSON.parse(c.split("\n").find((l) => l.startsWith("data:"))!.slice(5)));
}

describe("parser on raw captured NIM streams", () => {
  test("reasoning deltas followed by a tool_calls delta -> thinking block + tool_use web_read, stop_reason tool_use", async () => {
    const evs = await events(fx("reasoning-then-tool-call.sse"));
    expect(evs.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type + ":" + (e.content_block.name ?? ""))).toEqual(["thinking:", "tool_use:web_read"]);
    expect(evs.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
    expect(JSON.parse(evs.filter((e) => e.delta?.type === "input_json_delta").map((e) => e.delta.partial_json).join("")).url).toMatch(/^https:/);
  });
  test("tool call with no reasoning, tool_choice required -> tool_use", async () => {
    const evs = await events(fx("noreasoning-required-tool-call.sse"));
    expect(evs.some((e) => e.content_block?.name === "web_read")).toBe(true);
    expect(evs.find((e) => e.type === "message_delta").delta.stop_reason).toBe("tool_use");
  });
  test("the narration stream really has NO tool call: text only, finish stop -> end_turn (the model is the cause, not the parser)", async () => {
    const evs = await events(fx("noreasoning-narration-stop.sse"));
    expect(evs.filter((e) => e.type === "content_block_start").map((e) => e.content_block.type)).toEqual(["text"]);
    expect(evs.find((e) => e.type === "message_delta").delta.stop_reason).toBe("end_turn");
  });
});

describe("narration detection", () => {
  test("the live text is narration; strip removes the dangling call", () => {
    const b = [{ type: "text", text: NARR_TEXT }];
    expect(narratesToolCall(b, NAMES)).toBe(true);
    const s = withoutNarration(b, NAMES);
    expect(JSON.stringify(s)).not.toContain("web_read");
    expect(JSON.stringify(s)).toContain("Bắt đầu");
    expect((withoutNarration(b, NAMES, NARRATION_NOTE).at(-1) as any).text).toBe(NARRATION_NOTE);
  });
  test("not narration: real answer, a call was made, tool not offered, long text", () => {
    expect(narratesToolCall([{ type: "text", text: "Hà Nội hôm nay 30°C, nắng." }], NAMES)).toBe(false);
    expect(narratesToolCall([{ type: "text", text: NARR_TEXT }, { type: "tool_use", id: "x", name: "web_read", input: {} }], NAMES)).toBe(false);
    expect(narratesToolCall([{ type: "text", text: NARR_TEXT }], [])).toBe(false); // no tools offered at all
    expect(narratesToolCall([{ type: "text", text: "x".repeat(900) + " (web_read đang thực hiện...)" }], NAMES)).toBe(false);
    expect(narratesToolCall([{ type: "text", text: "Dùng `web_read` để đọc trang là cách tốt." }], NAMES)).toBe(false); // quoted mention
  });
  const t = (text: string) => narratesToolCall([{ type: "text", text }], NAMES);
  test("negatives: mentions, refusals, quotes, long answers never force a call", () => {
    expect(t("(web_read is unavailable)")).toBe(false);
    expect(t("(web_read không khả dụng lúc này)")).toBe(false);
    expect(t("Tôi không thể dùng web_read vì trang yêu cầu đăng nhập.")).toBe(false);
    expect(t("`web_read` reads a page; `web_links` lists its links.")).toBe(false); // v3: an UNquoted bare tool name in a short reply counts (brief), quoted does not
    expect(t("Bạn có thể gõ `calling web_read...` để thử.")).toBe(false);
    expect(t('Câu lệnh là "I\'ll call web_read now" như đã nói.')).toBe(false);
    expect(t("(web_read)")).toBe(true); // v3: a bare offered-tool name in a short reply counts (brief)
    const long = "Đây là câu trả lời đầy đủ về thời tiết. ".repeat(8) + "\n(web_read đang thực hiện...)";
    expect(long.length).toBeLessThan(400 + 1000); expect(t(long)).toBe(false);
    expect(t("Nội dung thật sự dài hơn hai trăm ký tự, " + "tả chi tiết thời tiết từng giờ trong ngày, ".repeat(5) + "\nĐang gọi web_read...")).toBe(false);
  });
  test("negatives: refusals / unavailability that contain the announcement shape are NOT an announcement", () => {
    for (const x of ["Calling web_read is unavailable now", "Calling web_read failed.", "I can't call web_read right now...", "I cannot call web_read now", "I'll call web_read now but it is not available",
      "Gọi web_read không khả dụng lúc này", "Tôi không thể gọi web_read ngay...", "Đang gọi web_read thất bại", "(web_read đang chạy... không khả dụng)", "web_read unavailable, calling web_read..."]) expect(t(x)).toBe(false);
    expect(t("Đang gọi web_read...")).toBe(true); // control: the plain announcement still matches
  });
  test("positives: announcements of an action in progress or next", () => {
    expect(t("(web_read đang thực hiện...)")).toBe(true);
    expect(t("(web_read running)")).toBe(true);
    expect(t("Đang gọi web_read...")).toBe(true);
    expect(t("Đang gọi web_read")).toBe(true);
    expect(t("I'll call web_read now")).toBe(true);
    expect(t("Let me call web_read now.")).toBe(true);
    expect(t("Calling web_read...")).toBe(true);
  });
});

describe("toChatRequest tool_choice", () => {
  const tools = [{ name: "web_read", description: "d", input_schema: { type: "object", properties: {} } }];
  const b = (tool_choice: any, t: any = tools) => toChatRequest({ messages: [{ role: "user", content: "x" }], tools: t, tool_choice }, "m") as any;
  test("any -> required, auto, none, named tool; never without tools", () => {
    expect(b({ type: "any" }).tool_choice).toBe("required");
    expect(b({ type: "auto" }).tool_choice).toBe("auto");
    expect(b({ type: "tool", name: "web_read" }).tool_choice).toEqual({ type: "function", function: { name: "web_read" } });
    expect(b({ type: "weird" }).tool_choice).toBeUndefined();
    expect(b({ type: "any" }, []).tool_choice).toBeUndefined();
    expect(b(undefined).tool_choice).toBeUndefined();
  });
});

// Whole engine, real adapter, fake fetch: what the user's chat would do for each stream the model can produce.
async function run(model: string, streams: Array<() => Response>, o: { open?: boolean; cues?: boolean | "absent"; text?: string; extra?: string[]; noWeb?: boolean } = {}) {
  buildRegistry({ scope: OPEN, gateway: null, env: { PROVIDER_KEY_NVIDIA: "k" }, catalog: seedCatalog() } as any);
  const browser = { quickAction: async () => Response.json({ success: true, result: "Hà Nội 30°C" }) };
  const cf = cfToolsHost({ shared: async () => true, browser: o.noWeb ? null : browser, image: null, db: {} as any, scope: OPEN, files: null, index: { recordUsage: async () => {} } as any, conv: () => "c1" });
  const host = withCfTools({ list: async () => (o.extra ?? []).map((name) => ({ name, description: "d", inputSchema: { type: "object", properties: {} } })) as any, call: async () => ({ text: "", isError: true }) }, cf);
  const db = new Database(":memory:"), sent: any[] = [], evs: any[] = [];
  let n = 0;
  const cfg: any = { id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", keyBinding: "K", models: [{ id: "nvidia/nemotron-3.5-lightning-30b-a3b", displayName: "x", capabilities: { tools: true }, maxOutput: 16384 }] };
  const real = openaiCompatProvider(cfg, { K: "k" }, async (_u, init) => { const body = JSON.parse(String(init?.body)); if (body.tools) sent.push(body); return body.tools ? (streams[n++] ?? answerStream)() : answerStream(); });
  const provider: any = { name: "p", listModels: async () => [], messages: (b: any) => real.messages({ ...b, model: b.model.replace(/^nvidia:/, "") }) };
  const index = { indexMessage: async () => {}, updateConversation: async () => {}, recordUsage: async () => {} };
  const engine = new ChatEngine({ sql: { exec: (q: string, ...b: any[]) => { const st = db.query(q); const rows = q.trim().toUpperCase().startsWith("SELECT") || /RETURNING/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows as any[] }; } },
    provider, index, sink: { broadcast: (_s: any, _t: any, e: any) => { evs.push(e); } }, retryDelayMs: 1, tools: host, openSpace: () => o.open !== false, ...(o.cues === "absent" ? {} : { forceToolCues: () => o.cues === true }), personalTools: () => true, metaScope: () => OPEN } as any);
  engine.setConvId("c1");
  await engine.send(o.text ?? "thời tiết Hà Nội hôm nay thế nào?", model);
  const saved = evs.filter((e) => e.type === "assistant_saved").map((e) => e.message);
  const history = db.query("SELECT role, content FROM messages ORDER BY id").all().map((r: any) => ({ role: r.role as string, content: JSON.parse(r.content) as any[] }));
  return { sent, evs, saved, history };
}
const NV = "nvidia:nvidia/nemotron-3.5-lightning-30b-a3b";
const textOf = (m: any) => m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

describe("engine: a turn that only announces a tool call", () => {
  test("narration -> ONE retry with tool_choice required (announcement not resent) -> tool runs -> answer; retry counted", async () => {
    const { sent, evs, saved } = await run(NV, [narrationStream, toolCallStream, answerStream]);
    expect(sent.length).toBe(3);
    expect(sent[0].tool_choice).toBeUndefined();
    expect(sent[1].tool_choice).toBe("required");
    expect(sent[1].messages.at(-1).role).toBe("user"); // the announcement is not in the retry request
    expect(JSON.stringify(sent[1].messages)).not.toContain("đang thực hiện");
    expect(sent[2].tool_choice).toBeUndefined(); // only the one retry is forced
    expect(evs.some((e) => e.type === "tool_result" && e.name === "web_read")).toBe(true); // the call really reached the tool host (its stub quota answer is irrelevant here)
    expect(textOf(saved[0])).not.toContain("web_read"); // saved narration never looks like a call is running
    expect(textOf(saved[0])).toContain("Bắt đầu"); // the stripped lead-in is merged into the retry's own message, not saved as its own
    expect(saved[0].content.some((b: any) => b.type === "tool_use")).toBe(true);
    expect(saved[0].retries).toBe(1);
    expect(textOf(saved.at(-1))).toContain("30°C");
    expect(evs.at(-1).type === "title" || evs.some((e) => e.type === "turn_end")).toBe(true);
  });
  test("narration twice -> bounded: exactly 2 model calls, final message carries a note, no dangling (web_read ...)", async () => {
    const { sent, saved } = await run(NV, [narrationStream, narrationStream, answerStream]);
    expect(sent.length).toBe(2);
    expect(textOf(saved.at(-1))).toContain(NARRATION_NOTE);
    expect(saved.map(textOf).join("\n")).not.toMatch(/\(web_read/);
  });
  test("ONE forced retry per TURN: narrate -> retry -> tool -> narrate again after the result -> no second forced retry, note, stop", async () => {
    const { sent, saved } = await run(NV, [narrationStream, toolCallStream, narrationStream, toolCallStream, answerStream]);
    expect(sent.length).toBe(3);
    expect(sent.filter((b) => b.tool_choice === "required").length).toBe(1);
    expect(textOf(saved.at(-1))).toContain(NARRATION_NOTE_AFTER_TOOL);
  });
  test("saved history after a retry turn: no empty or consecutive assistant message; rebuilds validly for openai-compat, gemini and the Anthropic/Vertex shape", async () => {
    for (const streams of [[narrationStream, toolCallStream, answerStream], [narrationStream, narrationStream, answerStream], [narrationStream, toolCallStream, narrationStream]]) {
      const { history } = await run(NV, streams);
      history.forEach((m, i) => {
        expect(m.content.length).toBeGreaterThan(0);
        if (i) expect(m.role).not.toBe(history[i - 1].role);
      });
      expect(history[0].role).toBe("user");
      // Anthropic/Vertex shape is the history itself; openai-compat and gemini are rebuilt from it
      const oa = (toChatRequest({ messages: history, tools: [{ name: "web_read", description: "d", input_schema: { type: "object", properties: {} } }] }, "m") as any).messages.filter((m: any) => m.role !== "system");
      for (let i = 1; i < oa.length; i++) if (oa[i].role === "assistant") expect(oa[i - 1].role).not.toBe("assistant");
      for (const m of oa) if (m.role === "assistant") expect(Boolean(m.content) || (m.tool_calls?.length ?? 0) > 0).toBe(true);
      const g = toGeminiContents({ messages: history }).contents;
      g.forEach((c: any, i: number) => { expect(c.parts.length).toBeGreaterThan(0); if (i) expect(c.role).not.toBe(g[i - 1].role); });
    }
  });
  test("a non-NVIDIA model is never retried (the retry request is made for NVIDIA in the positive case, none here)", async () => {
    const pos = await run(NV, [narrationStream, toolCallStream, answerStream]);
    expect(pos.sent.some((b) => b.tool_choice === "required")).toBe(true); // positive control: a retry request really was made
    const neg = await run("gemini:x", [narrationStream, toolCallStream]).catch((e) => { throw new Error("run failed unexpectedly: " + String(e)); });
    expect(neg.sent.length).toBe(0);
  });
});

const t = (text: string) => narratesToolCall([{ type: "text", text }], NAMES);
const LIVE2 = "Bước 1: Lấy dữ liệu thời tiết trực tiếp cho Hà Nội.✅\nThông qua web_read, truy cập trang forecast thời tiết chính xác cho Hà Nội. (Kết quả sẽ được xử lý ngay sau khi có.)";
describe("narration v2: free-form announcements", () => {
  test("both live replies (and the earlier shape) are detected", () => {
    expect(t(LIVE2)).toBe(true);
    expect(t(NARR_TEXT)).toBe(true);
    expect(t("Bắt đầu lấy dữ liệu thời tiết thời gian thực... (web_read đang thực hiện...)")).toBe(true);
  });
  test("more phrasings: Vietnamese and English promises, ellipsis, no tool name", () => {
    for (const x of ["Tôi sẽ tra cứu thời tiết Hà Nội ngay bây giờ.", "Đang lấy dữ liệu, vui lòng đợi một chút...", "Let me check the weather for you.", "I'll look that up now.",
      "Now fetching the latest rates...", "Bước 1: truy cập trang dự báo.", "Using web_read to open the forecast page.", "Dùng web_read để mở trang."]) expect(t(x)).toBe(true);
  });
  test("negatives: real answers (even naming a tool in passing), refusals, long answers, a tool_use never match", () => {
    expect(t("Hà Nội hôm nay 30°C, nắng nhẹ, độ ẩm 70%.")).toBe(false);
    expect(t("Hà Nội hôm nay 30°C, nắng nhẹ, độ ẩm 70%, gió đông nam cấp 2, nhiệt độ cao nhất 33°C, thấp nhất 26°C, có mưa rào rải rác vào chiều tối, tầm nhìn xa tốt, chỉ số UV ở mức cao vào buổi trưa, nên bôi kem chống nắng. Nguồn: web_read từ thoitiet.vn lúc 10:00.")).toBe(false); // a real answer citing the tool
    for (const x of ["Tôi sẽ không thể dùng web_read vì trang không khả dụng.", "I'll try web_read but it is unavailable.", "Bước 1 thất bại: không thể gọi web_read."]) expect(t(x)).toBe(false);
    expect(t(LIVE2 + " " + "Thông tin thêm về thời tiết Hà Nội mùa thu rất dễ chịu. ".repeat(14))).toBe(false); // > 800 chars
    expect(t("Ngày mai Hà Nội sẽ mưa, nhiệt độ 24 đến 29°C, gió nhẹ cấp 2. Mang theo ô khi ra ngoài nhé, buổi tối trời mát và dễ chịu hơn nhiều so với ban ngày.")).toBe(false);
    expect(narratesToolCall([{ type: "text", text: LIVE2 }, { type: "tool_use", id: "x", name: "web_read", input: {} }], NAMES)).toBe(false);
    expect(narratesToolCall([{ type: "text", text: LIVE2 }], [])).toBe(false); // no tools offered
  });
  test("withoutNarration drops a free-form announcement so the saved text never claims a call is coming", () => {
    const s = withoutNarration([{ type: "text", text: "Hà Nội đang nắng.\n" + LIVE2 }], NAMES, NARRATION_NOTE);
    expect(JSON.stringify(s)).not.toContain("web_read");
    expect(JSON.stringify(s)).not.toContain("Kết quả sẽ");
    expect((s.at(-1) as any).text).toBe(NARRATION_NOTE);
  });
  test("engine: the live reply 2 triggers the ONE forced retry", async () => {
    const live2 = () => new Response(sseOf({ role: "assistant", content: LIVE2 }) + sseOf({}, "stop") + "data: [DONE]\n\n");
    const { sent, saved } = await run(NV, [live2, toolCallStream, answerStream]);
    expect(sent[1].tool_choice).toBe("required");
    expect(textOf(saved.at(-1))).toContain("30°C");
    expect(JSON.stringify(sent[1].messages)).not.toContain("Kết quả sẽ");
  });
});

describe("narration v3: weak shapes alone never trigger", () => {
  test("negatives", () => {
    for (const x of ["Xong rồi, bạn thử lại nhé...", "Đúng vậy...", "Bước 1: cài đặt Node", "Kết quả sẽ khác nhau tùy máy", "Kết quả sẽ được lưu lại."]) expect(t(x)).toBe(false);
  });
  test("promise + fetch verb, or a tool name, still triggers", () => {
    for (const x of ["Tôi sẽ truy cập trang này.", "I'll fetch the page.", "Let me search for it.", "Bước 1: kiểm tra giá vàng.", "Thông qua web_read, tôi lấy trang."]) expect(t(x)).toBe(true);
  });
});

describe("live-data cues -> first call forced", () => {
  test("cue list", () => {
    for (const x of ["thời tiết Hà Nội", "Giá vàng hôm nay", "tỷ giá USD", "tin tức mới nhất", "kết quả trận tối qua", "lịch chiếu phim", "dự báo thời tiết", "giá xăng", "giá bitcoin", "lịch thi đấu V-League", "weather in Hanoi", "latest news", "stock price of AAPL", "exchange rate", "price of gold", "score of the match", "kết quả xổ số", "nhiệt độ hiện tại", "temperature right now"]) expect(hasLiveCue(x)).toBe(true);
    for (const x of ["viết hàm sắp xếp mảng", "giáo viên toán", "I know the answer", "explain recursion", "xin chào", "lịch sử Việt Nam", "hôm nay tôi học gì", "giá trị của biến", "now that it works", "current directory", "bây giờ mấy giờ", "hiện tại thế nào", "what is it now", "score?", "giá"]) expect(hasLiveCue(x)).toBe(false);
  });
  test("forced request offers ONLY web_* tools; extra tools stay out of it", async () => {
    const { sent } = await run(NV, [toolCallStream, answerStream], { cues: true, extra: ["generate_image", "create_artifact"] });
    expect(sent[0].tool_choice).toBe("required");
    expect(sent[0].tools.map((x: any) => x.function.name).sort()).toEqual(["web_links", "web_read", "web_screenshot"]);
    expect(sent[1].tools.map((x: any) => x.function.name)).toEqual(expect.arrayContaining(["generate_image", "create_artifact", "web_read"])); // the next iteration is normal
    const nr = await run(NV, [narrationStream, toolCallStream, answerStream], { extra: ["generate_image", "create_artifact"] });
    expect(nr.sent[1].tool_choice).toBe("required");
    expect(nr.sent[1].tools.every((x: any) => x.function.name.startsWith("web_"))).toBe(true);
  });
  test("no web tool offered: never forced", async () => {
    const { sent } = await run(NV, [answerStream], { cues: true, extra: ["generate_image"], noWeb: true });
    expect(sent[0].tool_choice).toBeUndefined();
  });
  test("cue present: FIRST request required, the iteration after the tool result auto", async () => {
    const { sent } = await run(NV, [toolCallStream, answerStream], { cues: true });
    expect(sent.length).toBe(2);
    expect(sent[0].tool_choice).toBe("required");
    expect(sent[1].tool_choice).toBeUndefined();
  });
  test("no cue: request unchanged", async () => {
    const { sent } = await run(NV, [answerStream], { cues: true, text: "viết cho tôi một bài thơ" });
    expect(sent[0].tool_choice).toBeUndefined();
  });
  test("switch off ('0'), no switch wired, or not Open: untouched", async () => {
    expect((await run(NV, [answerStream], { cues: false })).sent[0].tool_choice).toBeUndefined();
    expect((await run(NV, [answerStream], { cues: "absent" })).sent[0].tool_choice).toBeUndefined();
    expect((await run(NV, [answerStream], { cues: true, open: false })).sent[0].tool_choice).toBeUndefined();
  });
  test("cue + narration on the forced first call: still only ONE forced retry on top", async () => {
    const { sent } = await run(NV, [narrationStream, toolCallStream, answerStream], { cues: true });
    expect(sent.map((b) => b.tool_choice)).toEqual(["required", "required", undefined]);
  });
  test("Vertex / Gemini models are never forced by a cue", async () => {
    expect((await run("gemini:x", [toolCallStream], { cues: true })).sent.length).toBe(0);
  });
});
