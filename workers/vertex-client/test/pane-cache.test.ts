import { beforeEach, expect, test } from "bun:test";
import { clearPaneCache, paneKey, paneToken, peekPane, putPane } from "../web/src/pane-cache";
import { resetSpaceForTest, setSpace } from "../web/src/space";
import { setCsrf } from "../web/src/api";

beforeEach(() => { resetSpaceForTest(); setSpace("biz"); clearPaneCache(); });

test("miss then hit", () => {
  expect(peekPane("/api/prompts")).toBeNull();
  putPane("/api/prompts", [1]);
  expect(peekPane<number[]>("/api/prompts")).toEqual([1]);
  expect(peekPane("/api/profile")).toBeNull();
});
test("key carries the space", () => {
  expect(paneKey("/x")).toBe("biz|/x");
});
test("space switch drops the cache", () => {
  putPane("/api/prompts", [1]);
  setSpace("open");
  expect(peekPane("/api/prompts")).toBeNull();
  putPane("/api/prompts", [2]);
  expect(paneKey("/api/prompts").startsWith("open|")).toBe(true);
  setSpace("biz");
  expect(peekPane("/api/prompts")).toBeNull();
});
test("CSRF reset (new session) drops the cache", () => {
  putPane("/api/profile", { a: 1 });
  setCsrf("new-token");
  expect(peekPane("/api/profile")).toBeNull();
});
test("a cached falsy value is a hit", () => {
  putPane("/api/prompts", []);
  expect(peekPane<number[]>("/api/prompts")).toEqual([]);
});
test("in-flight response resolving after clear (logout / csrf reset) is discarded", () => {
  const tok = paneToken("/api/profile");
  setCsrf("other-user");
  expect(putPane("/api/profile", { old: 1 }, tok)).toBe(false);
  expect(peekPane("/api/profile")).toBeNull();
});
test("in-flight response resolving after a space switch is discarded", () => {
  const tok = paneToken("/api/prompts");
  setSpace("open");
  expect(putPane("/api/prompts", [1], tok)).toBe(false);
  expect(peekPane("/api/prompts")).toBeNull();
  setSpace("biz");
  expect(putPane("/api/prompts", [1], tok)).toBe(false); // gen moved on even though the space is back
  expect(peekPane("/api/prompts")).toBeNull();
});
test("a fresh token stores", () => {
  expect(putPane("/api/prompts", [3], paneToken("/api/prompts"))).toBe(true);
  expect(peekPane<number[]>("/api/prompts")).toEqual([3]);
});
test("slow request A resolving after newer request B keeps B", () => {
  const a = paneToken("/api/prompts");
  const b = paneToken("/api/prompts");
  expect(putPane("/api/prompts", ["B"], b)).toBe(true);
  expect(putPane("/api/prompts", ["A"], a)).toBe(false);
  expect(peekPane<string[]>("/api/prompts")).toEqual(["B"]);
});
test("slow request A resolving after a local save write keeps the save", () => {
  const a = paneToken("/api/profile");
  putPane("/api/profile", { n: "saved" }); // local write takes a fresh token
  expect(putPane("/api/profile", { n: "old" }, a)).toBe(false);
  expect(peekPane<{ n: string }>("/api/profile")).toEqual({ n: "saved" });
});
