// Live strings from nemotron-3-ultra on turn 2 (docs/reports/debug-log.md): bookkeeping keys next to the tool call must not defeat the text-call conversion.
import { describe, expect, test } from "bun:test";
import "../src/providers/config";
import { WEB_READ_DEF, WEB_LINKS_DEF } from "../src/cf-tools";
import { parseTextToolCall } from "../src/text-tool-call";
import { narratesToolCall, withoutNarration } from "../src/tool-narration";

const DEFS = [WEB_READ_DEF, WEB_LINKS_DEF];
const NAMES = DEFS.map((d) => d.name);
const URL_ = "https://wttr.in/Hanoi?format=j1";
const LIVE = `{"tool": "web_read", "url": "${URL_}", "tool_call_id": "weather-hanoi-1"}`;
const LEAD = "I'll check the current weather in Hanoi for you.";
const blocks = (t: string) => [{ type: "text", text: t }] as any[];

describe("text tool call with bookkeeping keys", () => {
  test("the exact live string converts, with and without lead-in, and in the [[ shape", () => {
    expect(parseTextToolCall(LIVE, DEFS)).toEqual({ name: "web_read", input: { url: URL_ }, lead: "" });
    expect(parseTextToolCall(`${LEAD}\n${LIVE}`, DEFS)?.lead).toBe(LEAD);
    expect(parseTextToolCall(`${LEAD} ${LIVE}`, DEFS)?.input).toEqual({ url: URL_ });
    expect(parseTextToolCall(`[[${LIVE} ]`, DEFS)?.input).toEqual({ url: URL_ });
    expect(parseTextToolCall(`{"tool":"web_read","url":"${URL_}","request_id":"1"}`, DEFS)?.input).toEqual({ url: URL_ });
    for (const k of ["id", "type", "call_id", "toolCallId", "requestId", "tool_call_id", "request_id"]) expect(parseTextToolCall(`{"tool":"web_read","url":"${URL_}","${k}":"x"}`, DEFS)?.input).toEqual({ url: URL_ });
    expect(parseTextToolCall(`{"name":"web_read","parameters":{"url":"${URL_}"},"tool_call_id":"a"}`, DEFS)?.input).toEqual({ url: URL_ });
  });
  test("negatives: arguments stay strict", () => {
    expect(parseTextToolCall(`{"tool":"web_read","url":"${URL_}","tool_call_id":"a","depth":2}`, DEFS)).toBeNull(); // unknown extra arg key
    expect(parseTextToolCall(`{"tool":"web_read","url":"javascript:alert(1)","tool_call_id":"a"}`, DEFS)).toBeNull();
    expect(parseTextToolCall(`{"tool":"web_read","url":"file:///etc/passwd","tool_call_id":"a"}`, DEFS)).toBeNull();
    expect(parseTextToolCall(`{"tool":"web_read","tool_call_id":"a"}`, DEFS)).toBeNull(); // url missing
    expect(parseTextToolCall(LIVE, [WEB_LINKS_DEF])).toBeNull(); // tool not offered
    expect(parseTextToolCall(`{"tool":"nope","url":"${URL_}","tool_call_id":"a"}`, DEFS)).toBeNull();
    expect(parseTextToolCall(`${LIVE}\nHà Nội hôm nay nóng.`, DEFS)).toBeNull(); // prose after the JSON
    expect(parseTextToolCall(`Here is the call: ${LIVE} and then I explain it at length.`, DEFS)).toBeNull();
    expect(parseTextToolCall(`${LIVE}\n${LIVE}`, DEFS)).toBeNull(); // second object
  });
});

describe("narration of the same blob", () => {
  test("announcement with the offered defs (the engine always passes them): the live blob converts, so the forced retry never depends on conversion alone", () => {
    for (const t of [LIVE, `${LEAD}\n${LIVE}`, `[[${LIVE} ]`]) expect(narratesToolCall(blocks(t), NAMES, DEFS)).toBe(true);
    expect(JSON.stringify(withoutNarration(blocks(`${LEAD}\n${LIVE}`), NAMES, undefined, DEFS))).not.toContain("web_read");
  });
  test("an invalid-argument blob stays NOT an announcement (earlier review rule), names-only cannot validate", () => {
    const bad = `{"tool": "web_read", "url": "ftp://x/y", "tool_call_id": "w1"}`;
    expect(narratesToolCall(blocks(bad), NAMES, DEFS)).toBe(false);
    expect(narratesToolCall(blocks(LIVE), NAMES)).toBe(false);
  });
  test("negatives: tool not offered, prose around JSON, a refusal", () => {
    expect(narratesToolCall(blocks(LIVE), ["web_links"], [WEB_LINKS_DEF])).toBe(false);
    expect(narratesToolCall(blocks(`${LIVE}\nNhiệt độ ở Hà Nội hiện nay là 30°C, trời nắng nhẹ, độ ẩm 70%, gió nhẹ từ hướng đông nam, khả năng mưa thấp trong cả ngày hôm nay và ngày mai, nên bạn có thể yên tâm đi chơi cả ngày.`), NAMES, DEFS)).toBe(false);
    expect(narratesToolCall(blocks(`web_read is unavailable. ${LIVE}`), NAMES, DEFS)).toBe(false);
  });
});
