// REAL server handlers -> REAL Settings > Providers page. The page's fetch is routed straight into createApp (the same handlers production runs),
// so a server/client mismatch (field name, status, badge source) fails here instead of on the phone. happy-dom for this file only, removed afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { makeSession } from "../src/auth";
import { app, mkEnv } from "./user-keys-harness";

let render: typeof import("preact").render; let h: typeof import("preact").h;
let Page: typeof import("../web/src/settings-pages").ProvidersPage; let A: typeof import("../web/src/api"); let L: typeof import("../web/src/provider-key-logic"); let S: typeof import("../web/src/space");
const REAL_FETCH = globalThis.fetch; const NativeRequest = Request, NativeHeaders = Headers; // happy-dom's Headers drops the forbidden `cookie` header: build the server-side request natively
const FAKE_UI = "fake-ui-key-ZZZZ9999YYYY8888";
const until = async (f: () => unknown) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); };
const wait = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const preact = await import("preact"); render = preact.render; h = preact.h;
  Page = (await import("../web/src/settings-pages")).ProvidersPage; A = await import("../web/src/api"); L = await import("../web/src/provider-key-logic"); S = await import("../web/src/space");
});
afterAll(() => { globalThis.fetch = REAL_FETCH; S.resetSpaceForTest(); GlobalRegistrator.unregister(); delete (globalThis as { matchMedia?: unknown }).matchMedia; });

test("settings page against the real handlers: add provider, paste key (field cleared, badge 'Ready (your key)'), remove (badge back to 'No key'); the key is in no response and not in storage", async () => {
  const env = mkEnv(); const m = await makeSession(env, "example-user", "github");
  const wire: string[] = []; const responses: string[] = [];
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const headers = new NativeHeaders(); new Headers(init?.headers).forEach((v, k) => headers.set(k, v)); headers.set("cookie", m.cookie.split(";")[0]!); headers.set("origin", "https://app.test"); headers.set("x-vc-space", "open");
    const res = await app.fetch(new NativeRequest("https://app.test" + String(u), { ...init, headers }), env);
    wire.push(`${init?.method ?? "GET"} ${u}`); responses.push(await res.clone().text()); return res;
  }) as typeof fetch;
  S.setSpace?.("open" as never);
  const root = document.createElement("div"); document.body.appendChild(root);
  const q = (id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const badge = () => root.querySelector('[data-id="nvidia"] [data-testid="provider-badge"]')?.textContent;
  const click = async (el: Element | null) => { (el as HTMLElement).click(); await wait(8); };
  // csrf for the client: the real api module keeps it from /api/me
  await A.getMe().catch(() => {}); (A as any).setCsrf?.(m.session.csrf);
  render(h(Page, { onBack: () => {} }), root); await until(() => root.querySelector('[data-id="nvidia"]')); // the built-in preset is listed without any row
  expect(badge()).toBe("No key");
  await click(q("provider-edit")); await until(() => q("pf-key"));
  const input = q("pf-key") as HTMLInputElement; expect(input.type).toBe("password"); expect(input.getAttribute("autocomplete")).toBe("off");
  expect((q("pf-key-save") as HTMLButtonElement).disabled).toBe(true); expect((q("pf-key-remove") as HTMLButtonElement).disabled).toBe(true);
  input.value = FAKE_UI; input.dispatchEvent(new Event("input", { bubbles: true })); await wait(3);
  await click(q("pf-key-save")); await until(() => badge() === "Ready (your key)");
  expect((q("pf-key") as HTMLInputElement).value).toBe("");                       // cleared after save
  expect(badge()).toBe("Ready (your key)");               // the page re-read GET /api/providers -> key_source "user"
  expect(q("pf-note")?.textContent).toBe("Key saved.");
  expect((q("pf-key-remove") as HTMLButtonElement).disabled).toBe(false);
  expect(wire.some((w) => w.startsWith("PUT /api/providers/nvidia/key"))).toBe(true);
  await click(q("pf-key-remove")); await until(() => badge() === "No key");
  expect(badge()).toBe("No key"); expect(q("pf-note")?.textContent).toMatch(/removed/);
  // errors from the real handler surface in the page: no storage secret => 409 text
  delete (env as any).KEY_ENC_SECRET;
  (q("pf-key") as HTMLInputElement).value = FAKE_UI; (q("pf-key") as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true })); await wait(3);
  await click(q("pf-key-save")); await until(() => q("pf-error"));
  expect(q("pf-error")?.textContent).toBe("key storage not configured"); expect((q("pf-key") as HTMLInputElement).value).toBe("");
  for (const t of responses) expect(t).not.toContain(FAKE_UI);
  expect(JSON.stringify({ ...localStorage })).not.toContain(FAKE_UI); expect(JSON.stringify({ ...sessionStorage })).not.toContain(FAKE_UI);
  expect(root.innerHTML).not.toContain(FAKE_UI);
  render(null, root);
});

describe("badge logic", () => {
  test("Ready (your key) / Ready (shared) / No key from the server's key_source", () => {
    expect(L.keyBadge({ key_source: "user", keySet: true, status: "enabled", enabled: true })).toBe("Ready (your key)");
    expect(L.keyBadge({ key_source: "worker", keySet: true, status: "enabled", enabled: true })).toBe("Ready (shared)");
    expect(L.keyBadge({ key_source: "stale", keySet: true, status: "enabled", enabled: true })).toBe("Re-enter key");
    expect(L.keyBadge({ key_source: "none", keySet: false, status: "needs-key", enabled: true })).toBe("No key");
    expect(L.keyBadge({ keySet: true, status: "enabled", enabled: true })).toBe("Ready (shared)"); // older server without key_source
  });
});
