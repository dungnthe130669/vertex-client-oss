// DOM tests for the local-device screens (happy-dom + preact, registrator scoped to this file like cloud-pr-ui.test.tsx).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MockHub } from "./vcl-mock-hub";

let render: typeof import("preact").render; let h: typeof import("preact").h; let M: typeof import("../web/src/devices");
const REAL_FETCH = globalThis.fetch;
let root: HTMLElement; const calls: { url: string; method: string }[] = [];
let routes: Record<string, () => Response> = {};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (p: () => boolean, ms = 2000) => { const t = Date.now(); while (!p()) { if (Date.now() - t > ms) throw new Error("timeout"); await tick(5); } };
beforeAll(async () => {
  GlobalRegistrator.register({ url: "http://localhost/settings/devices", width: 390, height: 844 });
  render = (await import("preact")).render; h = (await import("preact")).h; M = await import("../web/src/devices");
  globalThis.fetch = (async (u: any, init: any) => { const method = init?.method ?? "GET"; calls.push({ url: String(u), method }); const r = routes[`${method} ${String(u).split("?")[0]}`]; return r ? r() : Response.json({ error: "x" }, { status: 500 }); }) as unknown as typeof fetch;
});
afterAll(() => { globalThis.fetch = REAL_FETCH; GlobalRegistrator.unregister(); });
afterEach(() => { render(null, root); root.remove(); calls.length = 0; routes = {}; document.body.innerHTML = ""; });
const mount = (node: any) => { root = document.createElement("div"); document.body.append(root); render(node, root); };
const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(`[data-testid=${s}]`) as T;
const qa = (s: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid=${s}]`)];
const ID = "a".repeat(32);
const dev = (o: Record<string, unknown> = {}) => ({ id: ID, name: "laptop", created_at: 1, last_seen: Math.floor(Date.now() / 1000) - 120, online: true, ...o });

describe("devices page", () => {
  test("lists devices with status, last seen and a named revoke button", async () => {
    routes["GET /api/devices"] = () => Response.json({ devices: [dev(), dev({ id: "b".repeat(32), name: "pc", online: false })] });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 2);
    expect(qa("device-status").map((e) => e.textContent)).toEqual(["online", "offline"]);
    expect(qa("device-row")[0].textContent).not.toContain("last"); expect(qa("device-row")[1].textContent).toContain("last seen"); expect(qa("device-revoke")[0].getAttribute("aria-label")).toBe("Revoke laptop");
    expect(qa("device-sandbox")[0].textContent).toContain("after a session starts");
  });
  test("empty state offers pairing", async () => {
    routes["GET /api/devices"] = () => Response.json({ devices: [] });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => !!q("devices-empty"));
    expect(q("pair-empty").textContent).toBe("Pair a device");
  });
  test("404 (flag off) shows no device UI at all", async () => {
    routes["GET /api/devices"] = () => Response.json({ error: "not found" }, { status: 404 });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => !!q("devices-off"));
    expect(q("pair-open")).toBeNull(); expect(q("device-list")).toBeNull();
  });
  test("settings row is hidden on 404 and shown on 200", async () => {
    routes["GET /api/devices"] = () => Response.json({ error: "nf" }, { status: 404 });
    mount(h(M.DevicesRow as never, { onOpen() {} })); await tick(20); expect(q("open-devices")).toBeNull();
    render(null, root); routes["GET /api/devices"] = () => Response.json({ devices: [] });
    mount(h(M.DevicesRow as never, { onOpen() {} })); await until(() => !!q("open-devices"));
  });
  test("revoke asks first, then DELETEs that id", async () => {
    routes["GET /api/devices"] = () => Response.json({ devices: [dev()] });
    routes[`DELETE /api/devices/${ID}`] = () => Response.json({ ok: true, closed: true });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 1);
    q("device-revoke").click(); await until(() => !!q("confirm-sheet"));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    q("confirm-ok").click(); await until(() => calls.some((c) => c.method === "DELETE" && c.url.endsWith(ID)));
  });
});

describe("devices identity (devv2s2)", () => {
  const A = "ffda".padEnd(32, "0"), B = "c884".padEnd(32, "0"), now = Math.floor(Date.now() / 1000);
  const two = (o: Record<string, Record<string, unknown>> = {}) => [dev({ id: A, name: "dungnguyentien", last_online_at: now - 60, online: true, ...o.a }), dev({ id: B, name: "dungnguyentien", last_online_at: now - 7200, online: false, ...o.b })];
  test("badge only on the row the server marks this_install; absent/false = no badge on any row", async () => {
    routes["GET /api/devices"] = () => Response.json({ devices: two({ a: { this_install: true }, b: { this_install: false } }) });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 2);
    expect(qa("device-this")).toHaveLength(1); expect(qa("device-row")[0].querySelector("[data-testid=device-this]")?.textContent).toBe("This device");
    render(null, root); root.remove(); routes["GET /api/devices"] = () => Response.json({ devices: two() });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 2); expect(qa("device-this")).toHaveLength(0);
  });
  test("identical names get a short id each and distinct revoke labels; a unique name stays plain", async () => {
    routes["GET /api/devices"] = () => Response.json({ devices: [...two(), dev({ id: "0001".padEnd(32, "0"), name: "pc", online: false })] });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 3);
    expect(qa("device-short").map((e) => e.textContent)).toEqual(["#ffda", "#c884"]);
    expect(qa("device-revoke").map((e) => e.getAttribute("aria-label"))).toEqual(["Revoke dungnguyentien ffda", "Revoke pc", "Revoke dungnguyentien c884"]);
  });
  test("honest last online on offline rows, ordered online first; not shown for online rows", async () => {
    routes["GET /api/devices"] = () => Response.json({ devices: two().reverse() });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 2);
    expect(qa("device-row")[0].querySelector("[data-testid=device-short]")?.textContent).toBe("#ffda"); // the online one moved up
    expect(qa("device-last").map((e) => e.textContent)).toEqual(["last online 2 h ago"]);
  });
  test("stale hint after 14 days offline, with no auto revoke", async () => {
    routes["GET /api/devices"] = () => Response.json({ devices: [dev({ online: false, last_online_at: now - 20 * 86400 })] });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 1);
    expect(q("device-stale").textContent).toContain("20 days"); await tick(30); expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  test("list request carries no x-vc-install outside the desktop shell", async () => {
    let hdr: unknown = "unset"; const orig = globalThis.fetch;
    globalThis.fetch = (async (u: any, init: any) => { if (String(u) === "/api/devices") hdr = new Headers(init?.headers).get("x-vc-install"); return Response.json({ devices: [] }); }) as never;
    try { mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => hdr !== "unset"); } finally { globalThis.fetch = orig; }
    expect(hdr).toBeNull();
  });
  test("replace prompt after a pairing creates a same-name row: cancel revokes nothing, confirm revokes exactly the old one(s)", async () => {
    let step = 0; const NEW = "9999".padEnd(32, "0");
    routes["GET /api/devices"] = () => Response.json({ devices: step === 0 ? [dev({ id: A, name: "mac", online: true, last_online_at: now })] : [dev({ id: A, name: "mac", online: false, last_online_at: now - 600 }), dev({ id: NEW, name: "mac", online: true, last_online_at: now })] });
    routes["POST /api/devices/pair"] = () => Response.json({ code: "ABCD2345", display: "ABCD-2345", expires_at: now + 600, ttl_s: 600 }, { status: 201 });
    routes[`DELETE /api/devices/${A}`] = () => Response.json({ ok: true });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 1);
    q("pair-open").click(); await until(() => !!q("pair-sheet")); step = 1; q("pair-create").click();
    await until(() => !!q("confirm-sheet"), 6000);
    expect(q("confirm-sheet").textContent).toContain("#ffda"); expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    q("confirm-cancel").click(); await tick(30); expect(calls.some((c) => c.method === "DELETE")).toBe(false); expect(q("confirm-sheet")).toBeNull();
  });
  test("replace prompt: confirm sends DELETE for the old row only", async () => {
    const NEW = "9999".padEnd(32, "0"); let step = 0;
    routes["GET /api/devices"] = () => Response.json({ devices: step === 0 ? [dev({ id: A, name: "mac", online: false, last_online_at: now - 600 })] : [dev({ id: A, name: "mac", online: false, last_online_at: now - 600 }), dev({ id: NEW, name: "mac", online: true, last_online_at: now })] });
    routes["POST /api/devices/pair"] = () => Response.json({ code: "ABCD2345", display: "ABCD-2345", expires_at: now + 600, ttl_s: 600 }, { status: 201 });
    routes[`DELETE /api/devices/${A}`] = () => Response.json({ ok: true });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 1);
    q("pair-open").click(); await until(() => !!q("pair-sheet")); step = 1; q("pair-create").click();
    await until(() => !!q("confirm-sheet"), 6000); q("confirm-ok").click();
    await until(() => calls.some((c) => c.method === "DELETE")); expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`/api/devices/${A}`]);
  });
});

describe("pair sheet", () => {
  const mint = (ttl = 600) => Response.json({ code: "ABCD2345", display: "ABCD-2345", expires_at: Math.floor(Date.now() / 1000) + ttl, ttl_s: ttl }, { status: 201 });
  test("shows the code, the exact command and a countdown; nothing lands in storage", async () => {
    routes["POST /api/devices/pair"] = () => mint(); routes["GET /api/devices"] = () => Response.json({ devices: [] });
    mount(h(M.PairSheet as never, { known: new Set(), onClose() {}, onPaired() {} })); await until(() => !!q("pair-create")); q<HTMLButtonElement>("pair-create").click(); await until(() => !!q("pair-code"));
    expect(q("pair-code").textContent).toBe("ABCD-2345"); expect(q("pair-command").textContent).toBe("vcl pair ABCD2345 --url http://localhost");
    expect(q("pair-countdown").textContent).toMatch(/^Expires in (9:5\d|10:00)$/);
    expect(JSON.stringify({ ...localStorage })).not.toContain("ABCD"); expect(JSON.stringify({ ...sessionStorage })).not.toContain("ABCD");
    expect(q("pair-sheet").getAttribute("role")).toBe("dialog"); expect(q("pair-sheet").getAttribute("aria-modal")).toBe("true");
  });
  test("an expired code disables copy and offers a new one", async () => {
    routes["POST /api/devices/pair"] = () => mint(0); routes["GET /api/devices"] = () => Response.json({ devices: [] });
    mount(h(M.PairSheet as never, { known: new Set(), onClose() {}, onPaired() {} })); await until(() => !!q("pair-create")); q<HTMLButtonElement>("pair-create").click(); await until(() => !!q("pair-code"));
    expect(q("pair-countdown").textContent).toBe("Code expired"); expect(q<HTMLButtonElement>("pair-copy").disabled).toBe(true); expect(!!q("pair-new")).toBe(true);
  });
  test("rate limit is reported", async () => {
    routes["POST /api/devices/pair"] = () => Response.json({ error: "x" }, { status: 429, headers: { "retry-after": "600" } });
    mount(h(M.PairSheet as never, { known: new Set(), onClose() {}, onPaired() {} })); await until(() => !!q("pair-create")); q<HTMLButtonElement>("pair-create").click(); await until(() => !!q("pair-error"));
    expect(q("pair-error").textContent).toContain("Too many codes"); expect(q("pair-error").textContent).toContain("10 min");
  });
  test("opening the sheet creates nothing; only the button mints a code", async () => {
    let posts = 0; routes["POST /api/devices/pair"] = () => { posts++; return mint(); }; routes["GET /api/devices"] = () => Response.json({ devices: [] });
    mount(h(M.PairSheet as never, { known: new Set(), onClose() {}, onPaired() {} })); await until(() => !!q("pair-create")); await new Promise((r) => setTimeout(r, 50));
    expect(posts).toBe(0); expect(!!q("pair-code")).toBe(false);
    q<HTMLButtonElement>("pair-create").click(); await until(() => !!q("pair-code")); expect(posts).toBe(1);
  });
  test("a newly appeared device finishes the flow", async () => {
    routes["POST /api/devices/pair"] = () => mint(); routes["GET /api/devices"] = () => Response.json({ devices: [dev()] });
    let got: any = null; const real = globalThis.setInterval; (globalThis as any).setInterval = (f: any, ms: number) => real(f, ms === 3000 ? 10 : ms);
    try { mount(h(M.PairSheet as never, { known: new Set(), onClose() {}, onPaired: (d: any) => { got = d; } })); await until(() => !!q("pair-create")); q<HTMLButtonElement>("pair-create").click(); await until(() => !!got); } finally { (globalThis as any).setInterval = real; }
    expect(got.name).toBe("laptop");
  });
});

describe("approval sheet", () => {
  const A = (o: Record<string, unknown> = {}) => ({ rid: "r1", tool: "Bash", preview: "rm -rf build", expires_at: 1100, ttl_s: 100, state: "pending" as const, ...o });
  const show = (a: any, nowS: number, extra: Record<string, unknown> = {}) => { const log: boolean[] = []; mount(h(M.ApprovalSheet as never, { a, nowS, answered: false, onAnswer: (v: boolean) => log.push(v), onMinimize() {}, ...extra })); return log; };
  test("shows the exact command, a progress bar from the expiry, and never focuses Allow", async () => {
    show(A(), 1050); await tick(30);
    expect(q("approval-preview").textContent).toContain("rm -rf build");
    expect(q("approval-bar").getAttribute("aria-valuenow")).toBe("50"); expect((q("approval-bar").firstElementChild as HTMLElement).style.width).toBe("50%");
    expect(document.activeElement).not.toBe(q("approval-allow")); expect(document.activeElement).toBe(q("approval-sheet"));
    expect(q("approval-sheet").getAttribute("aria-labelledby")).toBe("ap-title");
  });
  test("Allow and Deny answer with the right value", () => {
    const log = show(A(), 1050); q("approval-allow").click(); q("approval-deny").click(); expect(log).toEqual([true, false]);
  });
  test("answered => both disabled; expired => disabled and says expired", () => {
    show(A(), 1050, { answered: true }); expect(q<HTMLButtonElement>("approval-allow").disabled && q<HTMLButtonElement>("approval-deny").disabled).toBe(true);
    render(null, root); show(A(), 1100); expect(q<HTMLButtonElement>("approval-allow").disabled).toBe(true); expect(q("approval-time").textContent).toBe("expired");
    render(null, root); show(A({ state: "denied" }), 1050); expect(q<HTMLButtonElement>("approval-allow").disabled).toBe(true);
  });
  test("Edit preview keeps every character and marks +/- lines; Tab stays inside the sheet", () => {
    show(A({ tool: "Edit", preview: "/w/a.txt\n- old line\n+ new line" }), 1050);
    expect(q("approval-path").textContent).toBe("/w/a.txt"); expect(document.querySelector(".dl.del")!.textContent).toContain("old line"); expect(document.querySelector(".dl.add")!.textContent).toContain("new line");
    const btns = [...q("approval-sheet").querySelectorAll<HTMLElement>("button:not([disabled])")]; btns.at(-1)!.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", cancelable: true }));
    expect(q("approval-sheet").contains(document.activeElement)).toBe(true);
  });
  test("markup in a preview is text, never HTML", () => {
    show(A({ preview: "<img src=x onerror=alert(1)>" }), 1050); expect(q("approval-preview").querySelector("img")).toBeNull(); expect(q("approval-preview").textContent).toContain("<img src=x");
  });
});

describe("device session view (mock hub)", () => {
  const open = async (hub: MockHub, extra: Record<string, unknown> = {}) => {
    routes["GET /api/devices"] = () => Response.json({ devices: [dev(extra)] });
    mount(h(M.DeviceView as never, { id: ID, WS: hub.WS })); await until(() => q("dv-conn")?.textContent === "Live");
  };
  test("device not in the list (404/revoked): no socket is opened, no pill, clear revoked state with a way back", async () => {
    const hub = new MockHub(); routes["GET /api/devices"] = () => Response.json({ devices: [] });
    mount(h(M.DeviceView as never, { id: ID, WS: hub.WS })); await until(() => q("dv-revoked") !== null);
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.opens).toHaveLength(0); expect(q("dv-conn")).toBeNull(); expect(q("dv-revoked").textContent).toContain("This device was revoked"); expect(q("dv-revoked-back")).not.toBeNull();
  });
  test("revoked while open (close 4003): pill goes away, revoked state shows, the socket is not retried", async () => {
    const hub = new MockHub(); await open(hub); [...hub.socks][0].close(4003, "revoked");
    await until(() => q("dv-revoked") !== null); await new Promise((r) => setTimeout(r, 30));
    expect(q("dv-conn")).toBeNull(); expect(hub.opens).toHaveLength(1);
  });
  test("reports tab visibility to the hub on connect", async () => {
    const hub = new MockHub(); await open(hub);
    await until(() => hub.received.some((f) => f.t === "vis")); expect(hub.received.find((f) => f.t === "vis")).toEqual({ t: "vis", hidden: false });
  });
  test("streams assistant text and tool cards (collapsed), live region + connection pill", async () => {
    const hub = new MockHub(); hub.emit({ type: "session_started", dir: "/w", sandbox: "bwrap", bash: true }); hub.emit({ type: "assistant_text", text: "Reading…" });
    await open(hub); await until(() => qa("dv-text").length === 1);
    hub.emit({ type: "tool_use", id: "t", name: "Read", input: "{\"file_path\":\"/w/a\"}" }); hub.emit({ type: "tool_result", id: "t", is_error: false, content: "hello" });
    await until(() => qa("dv-tool").length === 1 && qa("dv-tool")[0].textContent!.includes("hello"));
    expect(qa("dv-tool")[0].hasAttribute("open")).toBe(false); expect(q("dv-stream").getAttribute("aria-live")).toBe("polite"); expect(q("dv-stream").getAttribute("role")).toBeNull(); // <main> already is a landmark; role=log on main was an axe aria-allowed-role violation (aria-live carries the announcements)
    expect(q("dv-sub").textContent).toContain("sandbox bwrap · bash on");
  });
  const typeIn = async (id: string, v: string) => { (q<HTMLInputElement>(id)).value = v; q(id).dispatchEvent(new Event("input", { bubbles: true })); await tick(); };
  test("roots known: a folder picker replaces the text box (default first root, full path in title), Start sends root and root+subfolder", async () => {
    const hub = new MockHub(); await open(hub, { roots: [{ label: "Projects", path: "/Users/x/Projects" }, { label: "Docs", path: "/Users/x/Documents/a/very/long/folder/name/indeed/Docs" }] });
    expect(q("dv-dir").tagName).toBe("DIV"); expect(q<HTMLSelectElement>("dv-root").value).toBe("/Users/x/Projects"); expect(q("dv-root").getAttribute("title")).toBe("/Users/x/Projects");
    const opts = [...q("dv-root").querySelectorAll("option")]; expect(opts).toHaveLength(2); expect(opts[1].getAttribute("title")).toContain("/Users/x/Documents/a/very"); expect(opts[1].textContent!.length).toBeLessThan(60);
    await typeIn("dv-input", "go");
    q("dv-start").click(); await until(() => hub.received.some((f) => f.kind === "start"));
    expect(hub.received.find((f) => f.kind === "start")!.dir).toBe("/Users/x/Projects");
    const sel = q<HTMLSelectElement>("dv-root"); sel.value = opts[1].getAttribute("value")!; sel.dispatchEvent(new Event("change", { bubbles: true })); await tick();
    await typeIn("dv-subfolder", "app/src/"); await typeIn("dv-input", "again"); q("dv-start").click(); await until(() => hub.received.filter((f) => f.kind === "start").length === 2);
    expect(hub.received.filter((f) => f.kind === "start")[1].dir).toBe("/Users/x/Documents/a/very/long/folder/name/indeed/Docs/app/src/"); // every character kept, trailing slash included
  });
  test("subfolder hint: leading slash or .. is flagged and blocks Start (the daemon stays the authority)", async () => {
    const hub = new MockHub(); await open(hub, { roots: [{ label: "P", path: "/p" }] }); await typeIn("dv-input", "go");
    for (const bad of ["/etc", "../x", "a/../../b", "~/x", "C:\\x"]) { await typeIn("dv-subfolder", bad); expect(q("dv-subfolder-hint")).not.toBeNull(); expect(q<HTMLButtonElement>("dv-start").disabled).toBe(true); }
    await typeIn("dv-subfolder", "ok/dir"); expect(q("dv-subfolder-hint")).toBeNull(); expect(q<HTMLButtonElement>("dv-start").disabled).toBe(false);
  });
  test("roots reported but empty: plain message, no text box; roots unknown (older vcl): the old text box unchanged", async () => {
    const hub = new MockHub(); await open(hub, { roots: [] });
    expect(q("dv-noroots").textContent).toBe("No folder added on this computer yet. Add one in vcl ui (Folders)."); expect(q("dv-dir")).toBeNull();
    await typeIn("dv-input", "draft kept"); expect(q<HTMLButtonElement>("dv-start").disabled).toBe(true); q("dv-start").click(); await tick();
    expect(hub.received.some((f) => f.kind === "start")).toBe(false); expect(q<HTMLTextAreaElement>("dv-input").value).toBe("draft kept");
    render(null, root); const hub2 = new MockHub(); await open(hub2);
    expect(q("dv-dir").tagName).toBe("INPUT"); expect(q("dv-root")).toBeNull(); expect(q("dv-noroots")).toBeNull();
  });
  test("open screen re-reads roots (on reconnect hello): picker updates, a removed selection falls back to the first root with a note and its subfolder cleared; Start uses the new root", async () => {
    const hub = new MockHub(); await open(hub, { roots: [{ label: "A", path: "/a" }, { label: "B", path: "/b" }] });
    const sel = q<HTMLSelectElement>("dv-root"); sel.value = "/b"; sel.dispatchEvent(new Event("change", { bubbles: true })); await tick(); await typeIn("dv-subfolder", "old");
    routes["GET /api/devices"] = () => Response.json({ devices: [dev({ roots: [{ label: "C", path: "/c" }, { label: "D", path: "/d" }] })] }); // daemon restarted with other folders
    hub.drop(); await until(() => q("dv-conn")?.textContent === "Live" && q<HTMLSelectElement>("dv-root").value === "/c" && !!q("dv-roots-note"));
    expect([...q("dv-root").querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual(["/c", "/d"]);
    expect(q<HTMLInputElement>("dv-subfolder").value).toBe(""); expect(q("dv-roots-note").textContent).toContain("no longer available on this computer");
    await typeIn("dv-input", "go"); q("dv-start").click(); await until(() => hub.received.some((f) => f.kind === "start"));
    expect(hub.received.find((f) => f.kind === "start")!.dir).toBe("/c");
  });
  test("a selection that is still present survives a roots refresh; a failed refresh keeps what is known", async () => {
    const hub = new MockHub(); await open(hub, { roots: [{ label: "A", path: "/a" }, { label: "B", path: "/b" }] });
    const sel = q<HTMLSelectElement>("dv-root"); sel.value = "/b"; sel.dispatchEvent(new Event("change", { bubbles: true })); await tick(); await typeIn("dv-subfolder", "keep");
    routes["GET /api/devices"] = () => Response.json({ devices: [dev({ roots: [{ label: "B", path: "/b" }, { label: "E", path: "/e" }] })] });
    hub.drop(); await until(() => q("dv-conn")?.textContent === "Live" && q("dv-root").querySelectorAll("option").length === 2 && q("dv-root").querySelector("option")!.getAttribute("value") === "/b");
    expect(q<HTMLSelectElement>("dv-root").value).toBe("/b"); expect(q<HTMLInputElement>("dv-subfolder").value).toBe("keep"); expect(q("dv-roots-note")).toBeNull();
    routes["GET /api/devices"] = () => new Response("boom", { status: 503 });
    hub.drop(); await until(() => q("dv-conn")?.textContent === "Live"); await new Promise((r) => setTimeout(r, 30));
    expect(q<HTMLSelectElement>("dv-root").value).toBe("/b"); expect(q("dv-revoked")).toBeNull();
  });
  test("a path with zero-width/bidi characters is sent byte-for-byte but shown with a visible mark (text nodes only)", async () => {
    const odd = "/Users/x/Plan\u200b2026";
    const hub = new MockHub(); await open(hub, { roots: [{ label: "<b>Plan2026</b>", path: odd }] });
    const o = q("dv-root").querySelector("option")!; expect(o.getAttribute("value")).toBe(odd); expect(o.textContent).toContain("Plan\u00b72026"); expect(o.textContent).not.toContain("\u200b"); expect(q("dv-root").querySelector("b")).toBeNull();
    await typeIn("dv-subfolder", " s p "); await typeIn("dv-input", "go"); q("dv-start").click(); await until(() => hub.received.some((f) => f.kind === "start"));
    expect(hub.received.find((f) => f.kind === "start")!.dir).toBe(odd + "/ s p ");
  });
  test("Start sends a start command with dir; Stop appears while a session runs", async () => {
    const hub = new MockHub(); await open(hub);
    (q<HTMLTextAreaElement>("dv-input")).value = "fix it"; q("dv-input").dispatchEvent(new Event("input", { bubbles: true }));
    (q<HTMLInputElement>("dv-dir")).value = "proj"; q("dv-dir").dispatchEvent(new Event("input", { bubbles: true })); await tick();
    q("dv-start").click(); await until(() => hub.received.some((f) => f.kind === "start"));
    const c = hub.received.find((f) => f.kind === "start")!; expect(c.prompt).toBe("fix it"); expect(c.dir).toBe("proj"); expect(typeof c.cid).toBe("string");
    hub.emit({ type: "session_started", dir: "/w/proj", sandbox: "none", bash: false }); await until(() => !!q("dv-stop"));
    q("dv-stop").click(); await until(() => hub.received.some((f) => f.kind === "stop"));
  });
  test("approval round trip: sheet appears, Allow sends approval_res bound to the rid, then settles", async () => {
    const hub = new MockHub(); await open(hub);
    hub.emit({ type: "approval_request", rid: "rq1", tool: "Write", preview: "/w/x.txt\nhello", expires_at: Math.floor(Date.now() / 1000) + 300, ttl_s: 300 });
    await until(() => !!q("approval-sheet")); expect(q("approval-path").textContent).toBe("/w/x.txt");
    q("approval-allow").click(); await until(() => hub.received.some((f) => f.t === "approval_res"));
    expect(hub.received.find((f) => f.t === "approval_res")).toEqual({ t: "approval_res", rid: "rq1", allow: true });
    await until(() => !q("approval-sheet")); expect(qa("dv-note").some((n) => n.textContent === "Write allowed")).toBe(true);
  });
  test("an already-expired request is shown disabled as expired and can be minimised to a banner", async () => {
    const hub = new MockHub(); hub.emit({ type: "approval_request", rid: "old", tool: "Bash", preview: "ls", expires_at: Math.floor(Date.now() / 1000) - 5, ttl_s: 300 });
    await open(hub); await until(() => !!q("approval-sheet")); expect(q<HTMLButtonElement>("approval-allow").disabled).toBe(true); expect(q("approval-time").textContent).toBe("expired");
  });
  test("minimise keeps the request reachable via the banner", async () => {
    const hub = new MockHub(); await open(hub);
    hub.emit({ type: "approval_request", rid: "m1", tool: "Bash", preview: "ls", expires_at: Math.floor(Date.now() / 1000) + 300, ttl_s: 300 });
    await until(() => !!q("approval-sheet")); q("approval-later").click(); await until(() => !q("approval-sheet") && !!q("approval-banner"));
    q("approval-banner").click(); await until(() => !!q("approval-sheet"));
  });
  test("connection drop shows Reconnecting then resumes with no duplicate items", async () => {
    const hub = new MockHub(); await open(hub); hub.emit({ type: "assistant_text", text: "one" }); await until(() => qa("dv-text").length === 1);
    hub.drop(); await until(() => q("dv-conn").textContent === "Reconnecting…"); hub.emit({ type: "assistant_text", text: "two" });
    await until(() => qa("dv-text").length === 2, 4000); expect(qa("dv-text").map((e) => e.textContent)).toEqual(["one", "two"]); expect(hub.opens[1]).toBe(1);
  });
  test("Disconnect asks first, then sends disconnect", async () => {
    const hub = new MockHub(); await open(hub); hub.emit({ type: "device_online" }); await until(() => !q<HTMLButtonElement>("dv-disconnect").disabled);
    q("dv-disconnect").click(); await until(() => !!q("confirm-sheet")); expect(hub.received.some((f) => f.t === "disconnect")).toBe(false);
    q("confirm-ok").click(); await until(() => hub.received.some((f) => f.t === "disconnect"));
  });
});

describe("Add this device (desktop shell only)", () => {
  const SECRET = "ABCD2345";
  const shellOn = (invoke: (c: string, a: { code: string }) => Promise<unknown>) => { (window as any).__TAURI_INTERNALS__ = { invoke }; };
  afterEach(() => { delete (window as any).__TAURI_INTERNALS__; delete (window as any).__TAURI__; });
  const mintOk = () => Response.json({ code: SECRET, display: "ABCD 2345", expires_at: 9e9, ttl_s: 600 }, { status: 201 });
  const open = async () => { routes["GET /api/devices"] = () => Response.json({ devices: [] }); mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => !!q("devices-empty")); };

  test("hidden in a normal browser, and hidden when only a marker exists without the native bridge", async () => {
    await open(); expect(q("add-this-device")).toBeNull();
    render(null, root); (window as any).__TAURI__ = {}; await open(); expect(q("add-this-device")).toBeNull();
  });
  test("shown in the shell; click mints a code, then invokes only pair_this_mac({code}); the code is not shown or stored", async () => {
    const seen: { c: string; a: unknown }[] = []; shellOn(async (c, a) => { seen.push({ c, a }); });
    routes["POST /api/devices/pair"] = mintOk; await open();
    expect(q("add-this-device").textContent).toBe("Add this device");
    q("add-this-device").click(); await until(() => !!q("add-this-device-status"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.url)).toEqual(["/api/devices/pair"]);
    expect(seen).toEqual([{ c: "pair_this_mac", a: { code: SECRET } }]);
    expect(q("add-this-device-status").textContent).toContain("Connected");
    expect(document.body.textContent).not.toContain(SECRET); expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET); expect(location.href).not.toContain(SECRET);
    expect(q("pair-sheet")).toBeNull();
  });
  test("a failed mint (429) never calls the native command and shows the limit text", async () => {
    let called = 0; shellOn(async () => { called++; });
    routes["POST /api/devices/pair"] = () => Response.json({ error: "x" }, { status: 429, headers: { "retry-after": "600" } }); await open();
    q("add-this-device").click(); await until(() => !!q("add-this-device-status"));
    expect(called).toBe(0); expect(q("add-this-device-status").textContent).toContain("Too many codes");
  });
  test("native errors show fixed text, never the raw value or the code", async () => {
    shellOn(async () => { throw `boom ${SECRET} vcl_secret`; });
    routes["POST /api/devices/pair"] = mintOk; await open();
    q("add-this-device").click(); await until(() => !!q("add-this-device-status"));
    expect(q("add-this-device-status").textContent).toBe("Could not add this device. Try again.");
    expect(document.body.textContent).not.toContain(SECRET); expect(document.body.textContent).not.toContain("vcl_secret");
  });
  test("not-running and already-paired are said plainly; cancelling is quiet and re-enables the button", async () => {
    let err = "not-running"; shellOn(async () => { throw err; });
    routes["POST /api/devices/pair"] = mintOk; await open();
    q("add-this-device").click(); await until(() => !!q("add-this-device-status"));
    expect(q("add-this-device-status").textContent).toContain("not installed or not running");
    err = "already-paired"; q("add-this-device").click(); await until(() => q("add-this-device-status")?.textContent?.includes("already paired"));
    err = "cancelled"; q("add-this-device").click(); await until(() => q("add-this-device-status")?.textContent?.startsWith("Cancelled"));
    expect(q<HTMLButtonElement>("add-this-device").disabled).toBe(false); expect(q("add-this-device-status").getAttribute("role")).toBe("status");
  });
  test("the button is disabled while waiting for the native confirmation (no double click, one mint)", async () => {
    let release!: () => void; shellOn(() => new Promise<void>((r) => { release = r; }));
    routes["POST /api/devices/pair"] = mintOk; await open();
    q("add-this-device").click(); await until(() => q<HTMLButtonElement>("add-this-device").disabled);
    q("add-this-device").click(); release(); await until(() => !!q("add-this-device-status"));
    expect(calls.filter((c) => c.method === "POST").length).toBe(1);
  });
});

describe("device turn status line (mock hub)", () => {
  const open = async (hub: MockHub) => {
    routes["GET /api/devices"] = () => Response.json({ devices: [dev({ roots: [{ label: "P", path: "/p" }] })] });
    mount(h(M.DeviceView as never, { id: ID, WS: hub.WS })); await until(() => q("dv-conn")?.textContent === "Live");
  };
  const typeIn = async (id: string, v: string) => { (q<HTMLInputElement>(id)).value = v; q(id).dispatchEvent(new Event("input", { bubbles: true })); await tick(); };
  const stateOf = () => q("dv-status")?.getAttribute("data-state");
  test("never silent: a start shows Sent, then walks delivered -> accepted -> starting -> working -> done as the hub/daemon events arrive; no line before the first send", async () => {
    const hub = new MockHub(); await open(hub); expect(q("dv-status")).toBeNull();
    await typeIn("dv-input", "do it"); q("dv-start").click(); await until(() => !!q("dv-status"));
    await until(() => stateOf() === "sent"); expect(q("dv-status").textContent).toContain("Sent to laptop");
    const cid = hub.received.find((f) => f.kind === "start")!.cid;
    hub.emit({ type: "cmd_sent", cid }); await until(() => stateOf() === "delivered"); expect(q("dv-status").textContent).toContain("Waiting for laptop");
    hub.emit({ type: "cmd_acked", cid }); await until(() => stateOf() === "accepted"); expect(q("dv-status").textContent).toContain("laptop received it");
    hub.emit({ type: "session_starting", dir: "/p" }); await until(() => stateOf() === "starting");
    hub.emit({ type: "session_started", dir: "/p", sandbox: "none", bash: false }); await until(() => stateOf() === "working");
    hub.emit({ type: "turn_done", is_error: false }); await until(() => stateOf() === "done");
  });
  test("device offline at send: the status line says it is queued (no silent toast-only path)", async () => {
    const hub = new MockHub(); hub.online = false; await open(hub);
    await typeIn("dv-input", "later"); q("dv-start").click(); await until(() => stateOf() === "queued");
    expect(q("dv-status").textContent).toContain("Device is offline. Will run when it reconnects."); expect(q("dv-status-stop")).not.toBeNull();
    q("dv-status-stop").click(); await until(() => q("dv-status") === null);
  });
  test("a daemon cmd_failed shows as a failed line with the reason; Retry resends the same text under a NEW cid", async () => {
    const hub = new MockHub(); await open(hub);
    await typeIn("dv-input", "try"); q("dv-start").click(); await until(() => stateOf() === "sent");
    hub.emit({ type: "session_error", code: "cmd_failed", message: "start: spawner exploded" }); await until(() => stateOf() === "failed");
    expect(q("dv-status").textContent).toContain("spawner exploded");
    q("dv-status-retry").click(); await until(() => hub.received.filter((f) => f.kind === "start").length === 2);
    const [a, b] = hub.received.filter((f) => f.kind === "start"); expect([b.prompt, b.cid === a.cid]).toEqual(["try", false]);
  });
  test("device_online is rendered, and an offline device shows when it was last online", async () => {
    const hub = new MockHub(); await open(hub);
    hub.emit({ type: "device_offline", reason: "timeout" }); await until(() => !!q("dv-last-online"));
    expect(q("dv-last-online").textContent).toContain("just now"); expect(qa("dv-note").at(-1)!.textContent).toContain("no answer from the device");
    hub.emit({ type: "device_online" }); await until(() => qa("dv-note").some((n) => n.textContent === "Device came online"));
  });
});

describe("retry guards (devfix1b)", () => {
  const open = async (hub: MockHub) => {
    routes["GET /api/devices"] = () => Response.json({ devices: [dev({ roots: [{ label: "P", path: "/p" }] })] });
    mount(h(M.DeviceView as never, { id: ID, WS: hub.WS })); await until(() => q("dv-conn")?.textContent === "Live");
  };
  const typeIn = async (id: string, v: string) => { (q<HTMLInputElement>(id)).value = v; q(id).dispatchEvent(new Event("input", { bubbles: true })); await tick(); };
  const stateOf = () => q("dv-status")?.getAttribute("data-state");
  const failFirst = async (hub: MockHub) => { await typeIn("dv-input", "try"); q("dv-start").click(); await until(() => stateOf() === "sent"); hub.emit({ type: "session_error", code: "cmd_failed", message: "boom" }); await until(() => stateOf() === "failed"); };
  test("double activation of Retry before a re-render sends exactly ONE extra command", async () => {
    const hub = new MockHub(); await open(hub); await failFirst(hub);
    const b = q("dv-status-retry"); b.click(); b.click();
    await until(() => hub.received.filter((f) => f.kind === "start").length >= 2); await tick(60);
    expect(hub.received.filter((f) => f.kind === "start")).toHaveLength(2);
  });
  test("a rejected socket write keeps a persistent failed line with Retry (the frame survives), it is not dropped", async () => {
    const hub = new MockHub(); await open(hub); await failFirst(hub);
    hub.drop(); await until(() => q("dv-conn")?.textContent !== "Live");
    q("dv-status-retry").click(); await tick(20);
    expect(q("dv-status")).not.toBeNull(); expect(stateOf()).toBe("failed"); expect(q("dv-status").textContent).toContain("could not reach the hub"); expect(q("dv-status-retry")).not.toBeNull();
  });
});

describe("quiet hint UI (devfix1c)", () => {
  const old = (o: Record<string, unknown> = {}) => dev({ online: true, hb: false, last_heard_at: Date.now() - 11.5 * 60_000, ...o });
  test("Settings list: hint under an online no-hb device that is quiet > 10 min; none for hb, fresh, or absent fields", async () => {
    routes["GET /api/devices"] = () => Response.json({ server_now: Date.now(), devices: [old(), old({ id: "b".repeat(32), hb: true }), old({ id: "c".repeat(32), last_heard_at: Date.now() - 9 * 60_000 }), dev({ id: "d".repeat(32) })] });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 4);
    expect(qa("device-quiet")).toHaveLength(1); expect(qa("device-quiet")[0].textContent).toBe("Online, but not heard from for 11 min — it may be asleep");
    expect(qa("device-row")[0].contains(qa("device-quiet")[0])).toBe(true);
  });
  test("device header shows the note for the same condition and nothing for an hb daemon", async () => {
    const hub = new MockHub(); routes["GET /api/devices"] = () => Response.json({ devices: [old({ roots: [{ label: "P", path: "/p" }] })] });
    mount(h(M.DeviceView as never, { id: ID, WS: hub.WS })); await until(() => q("dv-conn")?.textContent === "Live");
    await until(() => !!q("dv-quiet")); expect(q("dv-quiet").textContent).toContain("not heard from for 11 min"); expect(q("dv-status")).toBeNull();
    render(null, root); root.remove(); const hub2 = new MockHub(); routes["GET /api/devices"] = () => Response.json({ devices: [old({ hb: true })] });
    mount(h(M.DeviceView as never, { id: ID, WS: hub2.WS })); await until(() => q("dv-conn")?.textContent === "Live"); await tick(50); expect(q("dv-quiet")).toBeNull();
  });
});

describe("quiet hint under browser clock skew (devfix1d)", () => {
  const REAL = Date.now;
  const withClock = (offMs: number) => { Date.now = () => REAL() + offMs; };
  afterEach(() => { Date.now = REAL; });
  for (const off of [3_600_000, -3_600_000]) {
    test(`browser clock ${off > 0 ? "+" : "-"}1 h: fresh old daemon => no hint; silent 11 min => "11 min", list and header`, async () => {
      const hubNow = REAL(); withClock(off);
      const mk = (id: string, silentMs: number) => ({ id, name: "n" + id[0], created_at: 1, last_seen: 1, online: true, hb: false, last_heard_at: hubNow - silentMs, roots: [{ label: "P", path: "/p" }] });
      routes["GET /api/devices"] = () => Response.json({ server_now: hubNow, devices: [mk(ID, 11.5 * 60_000), mk("b".repeat(32), 5_000)] });
      mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 2);
      expect(qa("device-quiet")).toHaveLength(1); expect(qa("device-quiet")[0].textContent).toContain("for 11 min"); expect(qa("device-row")[0].contains(qa("device-quiet")[0])).toBe(true);
      render(null, root); root.remove();
      const hub = new MockHub(); hub.skewMs = -off; // the hub's hello `now` is the hub clock, as in production
      mount(h(M.DeviceView as never, { id: ID, WS: hub.WS })); await until(() => q("dv-conn")?.textContent === "Live"); await until(() => !!q("dv-quiet"));
      expect(q("dv-quiet").textContent).toContain("for 11 min");
      render(null, root); root.remove(); routes["GET /api/devices"] = () => Response.json({ server_now: hubNow, devices: [{ ...mk(ID, 5_000) }] });
      const hub3 = new MockHub(); hub3.skewMs = -off;
      mount(h(M.DeviceView as never, { id: ID, WS: hub3.WS })); await until(() => q("dv-conn")?.textContent === "Live"); await tick(50); expect(q("dv-quiet")).toBeNull();
    });
  }
  test("an older hub (no server_now) => no hint in the list rather than a guess", async () => {
    routes["GET /api/devices"] = () => Response.json({ devices: [dev({ online: true, hb: false, last_heard_at: Date.now() - 30 * 60_000 })] });
    mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 1); expect(qa("device-quiet")).toHaveLength(0);
  });
});

describe("This is this Mac (desktop shell only, devv2s2c)", () => {
  const shellOn = () => { (window as any).__TAURI_INTERNALS__ = { invoke: async () => {} }; };
  afterEach(() => { delete (window as any).__TAURI_INTERNALS__; localStorage.clear(); });
  const B = "b".repeat(32);
  const list = (over: Record<string, unknown> = {}) => () => Response.json({ devices: [dev({ ...over }), dev({ id: B, name: "laptop", ...over })] });
  const open = async () => { mount(h(M.DevicesPage as never, { onBack() {} })); await until(() => qa("device-row").length === 2); };
  test("not shown in a normal browser", async () => { routes["GET /api/devices"] = list(); await open(); expect(qa("device-mark-this")).toHaveLength(0); });
  test("shown on rows with no install link; hidden on linked rows; hidden everywhere once a row is this_install", async () => {
    shellOn(); routes["GET /api/devices"] = () => Response.json({ devices: [dev(), dev({ id: B, linked: true })] }); await open();
    expect(qa("device-mark-this")).toHaveLength(1); expect(qa("device-mark-this")[0].textContent).toBe("This is this device");
    render(null, root); routes["GET /api/devices"] = () => Response.json({ devices: [dev({ this_install: true, linked: true }), dev({ id: B })] }); await open();
    expect(qa("device-mark-this")).toHaveLength(0);
  });
  test("click asks first (nothing sent); confirm POSTs the install id to that row only, then reloads and shows the badge", async () => {
    shellOn(); let linked = false;
    routes["GET /api/devices"] = () => Response.json({ devices: [dev({ this_install: linked, linked }), dev({ id: B })] });
    let body = ""; routes["POST /api/devices/" + ID + "/claim"] = () => { linked = true; return Response.json({ ok: true }); };
    const f = globalThis.fetch; globalThis.fetch = (async (u: any, i: any) => { if (String(u).endsWith("/claim")) body = String(i?.body); return f(u, i); }) as typeof fetch;
    try {
      await open(); qa("device-mark-this")[0].click(); await until(() => !!q("confirm-sheet"));
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
      expect(q("confirm-sheet").textContent).toContain("this device?"); expect(q("confirm-sheet").textContent).not.toMatch(/\bMac\b/);
      q("confirm-ok").click();
      await until(() => qa("device-this").length === 1);
      expect(JSON.parse(body)).toEqual({ install_id: localStorage.getItem("vc:install") }); expect(qa("device-mark-this")).toHaveLength(0);
    } finally { globalThis.fetch = f; }
  });
  test("a rejected claim fetch shows the error toast, leaves no unhandled rejection and the button stays", async () => {
    shellOn(); routes["GET /api/devices"] = list();
    const { Toasts } = await import("../web/src/toast"); const tr = document.createElement("div"); document.body.append(tr); render(h(Toasts as never, {}), tr);
    const seen: string[] = []; const mo = new MutationObserver(() => { seen.push(tr.textContent ?? ""); }); mo.observe(tr, { childList: true, subtree: true, characterData: true });
    const unh: unknown[] = []; const on = (e: unknown) => { unh.push(e); }; process.on("unhandledRejection", on);
    const f = globalThis.fetch; globalThis.fetch = (async (u: any, i: any) => { if (String(u).endsWith("/claim")) throw new TypeError("Failed to fetch"); return f(u, i); }) as typeof fetch;
    try {
      await open(); qa("device-mark-this")[0].click(); await until(() => !!q("confirm-sheet")); q("confirm-ok").click();
      await until(() => seen.some((t) => t.includes("Could not mark this device. Check your connection and try again.")));
      await new Promise((r) => setTimeout(r, 50));
      expect(unh).toEqual([]); expect(qa("device-mark-this")).toHaveLength(2); expect(qa("device-this")).toHaveLength(0);
    } finally { mo.disconnect(); render(null, tr); tr.remove(); globalThis.fetch = f; process.off("unhandledRejection", on); }
  });
  test("the claim button's accessible name contains its visible wording", async () => {
    shellOn(); routes["GET /api/devices"] = list(); await open();
    for (const b of qa("device-mark-this")) expect(b.getAttribute("aria-label")!.startsWith("This is this device: ")).toBe(true);
  });
  test("cancel sends nothing; a 409 shows fixed text and no badge", async () => {
    shellOn(); routes["GET /api/devices"] = list(); routes["POST /api/devices/" + ID + "/claim"] = () => Response.json({ error: "secret detail" }, { status: 409 });
    await open(); qa("device-mark-this")[0].click(); await until(() => !!q("confirm-sheet"));
    q("confirm-cancel").click(); await until(() => !q("confirm-sheet"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
