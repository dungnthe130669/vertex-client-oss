import { describe, expect, test } from "bun:test";
import { insertPrompt, promptSlashItems, promptSlashNames, resolvePlaceholders, todayLocal, usesClipboard } from "../web/src/prompts-logic";
import { rankSlash, slashRows } from "../src/slash";
import { buildItems } from "../web/src/palette-logic";

const now = new Date(2026, 9, 5, 23, 59);
describe("placeholders", () => {
  test("{{date}} is the local date, {{clipboard}} the clipboard; case and inner spaces tolerated; unknown braces untouched", () => {
    expect(todayLocal(now)).toBe("2026-10-05");
    expect(resolvePlaceholders("On {{date}}: {{ Clipboard }} / {{CLIPBOARD}} / {{other}}", { clipboard: "X", now })).toBe("On 2026-10-05: X / X / {{other}}");
  });
  test("clipboard text is inserted literally ($ patterns, braces)", () => {
    expect(resolvePlaceholders("a {{clipboard}} b", { clipboard: "$& $1 {{date}}", now })).toBe("a $& $1 {{date}} b");
  });
  test("usesClipboard", () => { expect(usesClipboard("x {{clipboard}}")).toBe(true); expect(usesClipboard("{{date}}")).toBe(false); });
});
describe("slash items and insertion", () => {
  test("names are slugs, duplicates numbered, Vietnamese kept, empty becomes prompt", () => {
    expect(promptSlashNames(["Code Review", "code  review!", "Dịch sang Anh", "???"])).toEqual(["code-review", "code-review-2", "dịch-sang-anh", "prompt"]);
  });
  test("items sit in the Prompts group, carry the text, and rank like any other slash item", () => {
    const items = promptSlashItems([{ id: "1", title: "Code Review", text: "Review this:\n{{clipboard}}", createdAt: "", updatedAt: "" }, { id: "2", title: "Summarize", text: "x".repeat(300), createdAt: "", updatedAt: "" }]);
    expect(items.map((i) => [i.kind, i.group, i.name])).toEqual([["prompt", "Prompts", "code-review"], ["prompt", "Prompts", "summarize"]]);
    expect(items[1].description.length).toBeLessThanOrEqual(120);
    expect(rankSlash(items, "rev").map((i) => i.name)).toEqual(["code-review"]);
    expect(slashRows(items, "").length).toBe(2);
  });
  test("insertPrompt replaces the /query, keeps what came before", () => {
    expect(insertPrompt("/cod", "TEXT")).toBe("TEXT");
    expect(insertPrompt("please /cod", "TEXT")).toBe("please TEXT");
  });
  test("palette lists prompts (every scope, each its own) and finds them by title", () => {
    const p = [{ id: "9", title: "Weekly report", text: "Write it", createdAt: "", updatedAt: "" }];
    const hit = buildItems("weekly", { chats: [], artifacts: [], prompts: p, erichOnly: true });
    expect(hit.find((i) => i.kind === "prompt")).toMatchObject({ label: "Weekly report", act: "insert-prompt", text: "Write it" });
    expect(buildItems("weekly", { chats: [], artifacts: [], prompts: p, erichOnly: false }).some((i) => i.kind === "prompt")).toBe(true); // prompts are per-scope, so a team user gets their own
  });
});
