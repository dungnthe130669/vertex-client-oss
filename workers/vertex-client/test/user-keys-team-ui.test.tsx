// REAL team-user session -> REAL handlers -> REAL Settings > Providers page, in the app's BUSINESS space (the page still reads the Open list). happy-dom for this file only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { makeSession } from "../src/auth";
import { createApp } from "../src/index";
import { setOpenFlag } from "../src/open-space";
import { GA, gw, fetchImpl, mkEnv } from "./user-keys-harness";

let render: typeof import("preact").render; let h: typeof import("preact").h;
let Page: typeof import("../web/src/settings-pages").ProvidersPage; let S: typeof import("../web/src/space");
const REAL_FETCH = globalThis.fetch; const NativeRequest = Request, NativeHeaders = Headers;
const FAKE_UI = "fake-team-ui-key-QQQQ7777RRRR6666";
const until = async (f: () => unknown) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); };
const wait = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const app = createApp({ fetchImpl, scopeOf: (s) => (s.u === "guest-a" ? GA : "main"), provider: () => gw });

beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const preact = await import("preact"); render = preact.render; h = preact.h;
  Page = (await import("../web/src/settings-pages")).ProvidersPage; S = await import("../web/src/space");
});
afterAll(() => { globalThis.fetch = REAL_FETCH; S.resetSpaceForTest(); GlobalRegistrator.unregister(); delete (globalThis as { matchMedia?: unknown }).matchMedia; });

test("team user: NVIDIA shows 'No key' with a key box and no custom-provider controls; pasting a key makes it 'Ready (your key)'; the key is in no response", async () => {
  const env = mkEnv({ worker: "worker-secret-SHARED-0000111122223333" }); env.ALLOWED_GITHUB_LOGINS = "guest-a"; await setOpenFlag(env.DB!, GA, true);
  const m = await makeSession(env, "guest-a", "github"); const wire: string[] = []; const responses: string[] = [];
  globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
    const headers = new NativeHeaders(); new Headers(init?.headers).forEach((v, k) => headers.set(k, v)); headers.set("cookie", m.cookie.split(";")[0]!); headers.set("origin", "https://app.test");
    const res = await app.fetch(new NativeRequest("https://app.test" + String(u), { ...init, headers }), env);
    wire.push(`${init?.method ?? "GET"} ${u} ${headers.get("x-vc-space") ?? ""}`.trim()); responses.push(await res.clone().text()); return res;
  }) as typeof fetch;
  S.setSpace("biz"); // the Business space: the page must still list the presets (reads the Open list explicitly)
  const A = await import("../web/src/api"); (A as any).setCsrf?.(m.session.csrf);
  const root = document.createElement("div"); document.body.appendChild(root);
  const q = (id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const badge = () => root.querySelector('[data-id="nvidia"] [data-testid="provider-badge"]')?.textContent;
  const click = async (el: Element | null) => { (el as HTMLElement).click(); await wait(8); };
  render(h(Page, { onBack: () => {} }), root); await until(() => badge());
  expect(badge()).toBe("No key");                  // the shared Worker secret is NOT used for a team user
  expect(q("provider-preset")).toBeNull();         // presets are already listed: nothing to "add"
  await click(q("provider-edit")); await until(() => q("pf-key"));
  expect(q("pf-test")).toBeNull(); expect(q("pf-delete")).toBeNull(); // presets only: no model listing, no removing the preset
  expect(q("provider-status-note")?.textContent).toMatch(/^No key yet\. Paste your own key/);
  const input = q("pf-key") as HTMLInputElement; input.value = FAKE_UI; input.dispatchEvent(new Event("input", { bubbles: true })); await wait(3);
  await click(q("pf-key-save")); await until(() => badge() === "Ready (your key)");
  expect(badge()).toBe("Ready (your key)"); expect((q("pf-key") as HTMLInputElement).value).toBe("");
  expect(wire.some((w) => w.startsWith("PUT /api/providers/nvidia/key"))).toBe(true);
  expect(wire.find((w) => w.startsWith("GET /api/providers"))).toContain("open");
  await click(q("pf-key-remove")); await until(() => badge() === "No key"); expect(badge()).toBe("No key");
  for (const t of responses) expect(t).not.toContain(FAKE_UI);
  expect(root.innerHTML).not.toContain(FAKE_UI);
  render(null, root);
});
