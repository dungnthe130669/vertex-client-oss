// Approval v2 UI: the Bypass confirmation text . happy-dom for this file only, removed afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const REAL_FETCH = globalThis.fetch; const NativeRequest = Request, NativeHeaders = Headers; // happy-dom replaces these globals; put the natives back so later files (the drawer tests) see what they expect
let render: typeof import("preact").render; let h: typeof import("preact").h; let C: typeof import("../web/src/approval-chip");
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null });
  const preact = await import("preact"); render = preact.render; h = preact.h;
  C = await import("../web/src/approval-chip");
});
afterAll(() => { globalThis.fetch = REAL_FETCH; GlobalRegistrator.unregister(); (globalThis as { Request: unknown }).Request = NativeRequest; (globalThis as { Headers: unknown }).Headers = NativeHeaders; delete (globalThis as { matchMedia?: unknown }).matchMedia; });

describe("approval v2 components", () => {
  test("Bypass confirm: plain words in English and Vietnamese, what it skips and what still asks", async () => {
    const root = document.createElement("div"); document.body.appendChild(root); const q = (t: string) => root.querySelector<HTMLElement>(`[data-testid="${t}"]`);
    let ok = 0, no = 0;
    render(h(C.BypassSheet, { onConfirm: () => ok++, onCancel: () => no++ }), root);
    const sk = q("bypass-skips")!.textContent!, as = q("bypass-asks")!.textContent!;
    for (const w of ["web pages", "query string", "read-only"]) expect(sk).toContain(w);
    for (const w of ["deleting", "sending", "spending money", "credentials", "IP address", "redirects", "only for chats you trust", "this chat only", "no timer", "fork"]) expect(as).toContain(w);
    expect(sk).toContain("Bỏ qua"); expect(as).toContain("Vẫn hỏi"); expect(root.querySelectorAll('[lang="vi"]').length).toBeGreaterThanOrEqual(3);
    q("confirm-ok")!.click(); q("confirm-cancel")!.click(); expect([ok, no]).toEqual([1, 1]);
    render(null, root);
    await new Promise((r) => setTimeout(r, 50)); // let preact flush its effects before happy-dom is torn down (a pending effect frame from a dead window starves later files)
  });
});
