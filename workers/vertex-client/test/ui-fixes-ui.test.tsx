// uifix1 DOM tests (happy-dom + preact, registrator scoped to this file): F08 attach-sheet hint, F11 about table.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

let render: typeof import("preact").render; let h: typeof import("preact").h; let S: typeof import("../web/src/composer-sheet"); let A: typeof import("../web/src/about");
let root: HTMLElement;
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/", width: 390, height: 844 });
  render = (await import("preact")).render; h = (await import("preact")).h; S = await import("../web/src/composer-sheet"); A = await import("../web/src/about");
});
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => { render(null, root); root.remove(); document.body.innerHTML = ""; });
const mount = (node: any) => { root = document.createElement("div"); document.body.append(root); render(node, root); };
const q = (s: string) => document.querySelector<HTMLElement>(`[data-testid=${s}]`);
const props = (o: Record<string, unknown>) => ({ mode: "chat", camera: false, photosDisabled: false, filesDisabled: false, onCamera() {}, onPhotos() {}, onFiles() {}, onPrompts() {}, onMode() {}, onClose() {}, anchor: null, ...o });

describe("attach sheet (F08)", () => {
  test("disabled Photos shows the reason", () => {
    mount(h(S.ContextSheet as never, props({ photosDisabled: true, photosWhy: "This model can't read images." })));
    expect((q("ctx-photos") as HTMLButtonElement).disabled).toBe(true);
    expect(q("ctx-photos-why")!.textContent).toBe("This model can't read images.");
  });
  test("enabled Photos shows no hint", () => {
    mount(h(S.ContextSheet as never, props({ photosWhy: "stale text" })));
    expect(q("ctx-photos-why")).toBeNull();
  });
});

describe("about (F11)", () => {
  test("navigator.standalone renders n/a when the browser does not define it", () => {
    const rows = A.viewportRows() as [string, string][] | undefined;
    expect(rows).toBeDefined();
    expect(rows!.find((r) => r[0] === "navigator.standalone")![1]).toBe("n/a");
  });
});
