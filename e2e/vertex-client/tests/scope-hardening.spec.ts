import { test, expect } from "./fixtures";

// P0 scope hardening, as far as the e2e user can observe it (it is scope `e2e`; it cannot see main or any other tenant). Nothing here
// may change for it: push stays closed, the Erich-only modes still answer (against stubs/fixtures), models still list through the gateway.
test.describe("scope hardening: e2e scope unchanged", () => {
  test("push stays closed to the e2e user (config probe 200 'off', everything else 403)", async ({ app: { api } }) => {
    const cfg = await api.get("/api/push/config");
    expect(cfg.status()).toBe(200);
    expect(await cfg.json()).toEqual({ publicKey: null, subscriptions: 0 });
    expect((await api.mut("POST", "/api/push/test", {})).status()).toBe(403);
    expect((await api.mut("POST", "/api/push/unsubscribe", { endpoint: "https://fcm.googleapis.com/fcm/send/x" })).status()).toBe(403);
  });

  test("Erich-only modes still answer for the e2e scope (not 403)", async ({ app: { api } }) => {
    for (const p of ["/api/cloud/config", "/api/agents/config", "/api/desktop/config", "/api/remote/config"]) expect((await api.get(p)).status(), p).toBe(200);
    const r = await (await api.get("/api/remote/sessions")).json();
    expect(r.sessions.every((s: { host: string }) => s.host === "e2e-host")).toBe(true); // fixtures, never real sessions
  });

  test("chat and media model lists still load (provider is still selected for the e2e scope)", async ({ app: { api } }) => {
    expect((await api.get("/api/models")).status()).toBe(200);
    expect((await api.get("/api/gen/models?kind=image")).status()).toBe(200);
  });

  test("a conversation is created and listed in the caller's own scope only", async ({ app: { api } }) => {
    const id = await api.newChat();
    expect((await api.conversations()).map((c) => c.id)).toContain(id);
    expect((await api.get(`/api/conversations/00000000-0000-4000-8000-000000000000`)).status()).toBe(404);
  });
});
