import { describe, expect, test } from "bun:test";
import { ME_KEY, ME_TTL_MS, type KV, cachedMe, dropMe, saveMe, validMe } from "../web/src/me-cache";

const kv = (): KV & { m: Map<string, string> } => { const m = new Map<string, string>(); return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }; };
const ME = { user: "a@b.c", via: "sso", csrf: "SECRET", defaultModel: "claude-sonnet-5-5", erichOnly: true, spaces: ["biz", "open"], space: "biz" } as any;
const put = (k: ReturnType<typeof kv>, o: unknown) => k.setItem(ME_KEY, JSON.stringify(o));

describe("me-cache", () => {
  test("round trip: CSRF is never stored, same space only", () => {
    const k = kv(); saveMe(ME, "biz", 1000, k);
    expect(k.m.get(ME_KEY)).not.toContain("SECRET");
    expect(cachedMe("biz", 2000, k)).toEqual({ ...ME, csrf: "" });
    expect(cachedMe("open", 2000, k)).toBeNull(); expect(k.m.has(ME_KEY)).toBe(true); // other space: ignored, left for that space
  });
  test("expires after 7 days and is removed", () => {
    const k = kv(); saveMe(ME, "biz", 1000, k);
    expect(cachedMe("biz", 1000 + ME_TTL_MS, k)).not.toBeNull();
    expect(cachedMe("biz", 1000 + ME_TTL_MS + 1, k)).toBeNull(); expect(k.m.has(ME_KEY)).toBe(false);
  });
  test("a timestamp from the future or a missing one is rejected", () => {
    const k = kv(); put(k, { space: "biz", at: 5000, me: ME }); expect(cachedMe("biz", 1000, k)).toBeNull();
    put(k, { space: "biz", me: ME }); expect(cachedMe("biz", 1000, k)).toBeNull(); expect(k.m.has(ME_KEY)).toBe(false);
  });
  test.each([
    ["spaces object", { ...ME, spaces: { length: 2 } }], ["spaces string", { ...ME, spaces: "biz" }], ["spaces bad member", { ...ME, spaces: ["biz", "x"] }],
    ["user number", { ...ME, user: 5 }], ["via missing", { ...ME, via: undefined }], ["erichOnly string", { ...ME, erichOnly: "yes" }], ["team string", { ...ME, team: "1" }],
    ["sso object", { ...ME, sso: {} }], ["space bad", { ...ME, space: "x" }], ["defaultModel number", { ...ME, defaultModel: 3 }], ["array", [ME]], ["null", null], ["string", "x"],
  ])("corrupt %s is discarded and removed", (_n, me) => {
    const k = kv(); put(k, { space: "biz", at: 1000, me }); expect(cachedMe("biz", 1000, k)).toBeNull(); expect(k.m.has(ME_KEY)).toBe(false);
  });
  test("unparseable JSON is discarded; defaultModel null (Open space) and absent optionals are valid; extra junk is dropped", () => {
    const k = kv(); k.setItem(ME_KEY, "{nope"); expect(cachedMe("biz", 1, k)).toBeNull(); expect(k.m.has(ME_KEY)).toBe(false);
    expect(validMe({ user: "u", via: "sso", defaultModel: null, junk: { x: 1 } })).toEqual({ user: "u", via: "sso", csrf: "", defaultModel: null } as any);
  });
  test("logout (dropMe) also removes the persisted new-chat drafts of every owner, and the legacy one", () => {
    const k: any = kv(); saveMe(ME, "biz", 1, k);
    k.setItem('vc:draft:["new-chat","a@x","biz"]', "t"); k.setItem('vc:draft:["new-chat","a@x","open"]', "t"); k.setItem("vc:draft:__new_chat__", "t"); k.setItem("vc:draft:conv", "keep");
    k.key = (i: number) => [...k.m.keys()][i] ?? null; Object.defineProperty(k, "length", { get: () => k.m.size });
    dropMe(k);
    expect([...k.m.keys()]).toEqual(["vc:draft:conv"]);
  });
  test("dropMe removes it", () => { const k = kv(); saveMe(ME, "biz", 1, k); dropMe(k); expect(k.m.size).toBe(0); });
});
