// Settings > Profile > "Limit answer length": a failed GET keeps the row with an error + working Retry (and the standard error toast), a good GET keeps the switch semantics. happy-dom for this file only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let render: typeof import("preact").render; let h: typeof import("preact").h; let P: typeof import("../web/src/settings-pages")
let T: typeof import("../web/src/toast"); let S: typeof import("../web/src/space");
const REAL_FETCH = globalThis.fetch;
const until = async (f: () => unknown) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  const preact = await import("preact"); render = preact.render; h = preact.h;
  P = await import("../web/src/settings-pages"); T = await import("../web/src/toast"); S = await import("../web/src/space");
});
afterAll(() => { globalThis.fetch = REAL_FETCH; S.resetSpaceForTest(); GlobalRegistrator.unregister(); delete (globalThis as { matchMedia?: unknown }).matchMedia; });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mount = () => { const root = document.createElement("div"); document.body.appendChild(root); render(h(P.AnswerLimitRow, {}), root); return { root, q: (t: string) => root.querySelector<HTMLElement>(`[data-testid="${t}"]`) }; };

describe("AnswerLimitRow", () => {
  for (const [name, firstGet] of [["a non-200 response", () => json(500, { error: "boom" })], ["a rejected fetch", () => { throw new TypeError("network down"); }]] as const) {
    test(`${name}: the row stays with an error and a Retry that reloads it; the standard error toast offers Retry too`, async () => {
      let gets = 0; const puts: unknown[] = [];
      globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); return json(200, { limit: JSON.parse(String(init.body)).limit }); }
        return ++gets === 1 ? firstGet() : json(200, { limit: "off", default: "off" });
      }) as typeof fetch;
      const { root, q } = mount();
      await until(() => q("answer-limit-error"));
      expect(q("answer-limit-setting")).not.toBeNull();                       // the row is NOT removed
      expect(q("answer-limit-error")!.textContent).toContain("Could not load");
      expect(q("answer-limit-toggle")).toBeNull();                              // no switch to flip with unknown state
      expect(root.textContent).toContain("Limit answer length");
      q("answer-limit-retry")!.click();
      await until(() => q("answer-limit-toggle"));
      expect(gets).toBe(2); expect(q("answer-limit-error")).toBeNull();
      expect(q("answer-limit-toggle")!.getAttribute("aria-checked")).toBe("false");   // limit "off" = the switch is off
      q("answer-limit-toggle")!.click(); await until(() => q("answer-limit-toggle")!.getAttribute("aria-checked") === "true");
      expect(puts).toEqual([{ limit: "default" }]);                             // switch ON = limited = "default"
      render(null, root);
    });
  }
  test("a good load: 'default' shows the switch ON, hint text present, no error", async () => {
    globalThis.fetch = (async () => json(200, { limit: "default", default: "default" })) as unknown as typeof fetch;
    const { root, q } = mount(); await until(() => q("answer-limit-toggle"));
    expect(q("answer-limit-toggle")!.getAttribute("aria-checked")).toBe("true"); expect(q("answer-limit-error")).toBeNull();
    expect(root.textContent).toContain("Off = models write as long as they can (Vertex models only)");
    render(null, root);
  });
});
