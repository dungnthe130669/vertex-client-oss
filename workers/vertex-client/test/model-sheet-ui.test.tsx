// DOM-level test: the model picker closes on Escape like the drawer and the composer "+" sheet. Registrator installed for this file only (see drawer-ui.test.tsx).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let render: typeof import("preact").render; let h: typeof import("preact").h; let ModelSheet: typeof import("../web/src/chat").ModelSheet;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/chats", width: 390, height: 844 });
  const preact = await import("preact"); render = preact.render; h = preact.h;
  ModelSheet = (await import("../web/src/chat")).ModelSheet;
});
afterAll(() => { GlobalRegistrator.unregister(); });

const settle = async () => { await new Promise((r) => setTimeout(r, 130)); }; // preact schedules effects on rAF / a 100ms fallback

test("ModelSheet: Escape calls onClose; other keys do not; the listener is removed on unmount", async () => {
  const root = document.createElement("div"); document.body.appendChild(root);
  let closed = 0;
  render(h(ModelSheet, { models: [], current: "m", onPick: () => {}, onClose: () => { closed++; } }), root);
  await settle();
  expect(root.querySelector('[role="dialog"]')).not.toBeNull();
  dispatchEvent(new KeyboardEvent("keydown", { key: "a" })); expect(closed).toBe(0);
  dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(closed).toBe(1);
  render(null, root); await settle();
  dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); expect(closed).toBe(1);
});
