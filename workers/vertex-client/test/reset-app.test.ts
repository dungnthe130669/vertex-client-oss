import { afterEach, describe, expect, test } from "bun:test";

const g = globalThis as any;
function setup(fetchImpl: () => Promise<{ ok: boolean; status: number }>) {
  const calls: string[] = [];
  g.fetch = async (u: string, o: any) => { calls.push(`fetch ${u.replace(/=\d+/, "=T")} ${o?.cache}`); return fetchImpl(); };
  g.navigator = { serviceWorker: { getRegistrations: async () => [{ unregister: async () => { calls.push("unregister"); } }] } };
  g.caches = { keys: async () => ["vc-shell-1", "other"], delete: async (k: string) => { calls.push(`delete ${k}`); } };
  g.location = { reload: () => calls.push("reload") };
  return calls;
}
afterEach(() => { delete g.caches; delete g.location; });

describe("resetApp", () => {
  test("offline: touches nothing, does not reload, reports the error", async () => {
    const calls = setup(async () => { throw new TypeError("Failed to fetch"); });
    const { resetApp, OFFLINE_RESET_MSG } = await import("../web/src/update");
    expect(await resetApp()).toBe(false);
    expect(calls).toEqual(["fetch /?vc-reset=T reload"]);
    expect(OFFLINE_RESET_MSG).toBe("You are offline — try again when connected");
  });
  test("server error (!ok): also refuses", async () => {
    const calls = setup(async () => ({ ok: false, status: 503 }));
    const { resetApp } = await import("../web/src/update");
    expect(await resetApp()).toBe(false); expect(calls).toEqual(["fetch /?vc-reset=T reload"]);
  });
  test("online: fetch first, then unregister, delete vc-shell-* only, reload", async () => {
    const calls = setup(async () => ({ ok: true, status: 200 }));
    const { resetApp } = await import("../web/src/update");
    expect(await resetApp()).toBe(true);
    expect(calls).toEqual(["fetch /?vc-reset=T reload", "unregister", "delete vc-shell-1", "reload"]);
  });
});
