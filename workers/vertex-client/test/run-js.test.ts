import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runJs, runJsHost, withRunJs, RUN_JS_CODE_MAX, RUN_JS_CONCURRENCY, RUN_JS_LIMITS, RUN_JS_TURN_MAX, RUN_JS_TOOL, type WorkerLoaderLike } from "../src/run-js";
import { classify, TOOL_RESULT_MAX, type ToolDef, type ToolHost } from "../src/tools";
import { buildRequest } from "../src/turn-engine";
import { SYSTEM_PROMPT } from "../src/system-prompt";

// A loader stand-in that really imports the generated modules from a temp dir (so the harness source is exercised), and records each load() argument.
// It cannot enforce cpuMs / globalOutbound: those are proven in workerd (test-cf/run-js.test.ts) and live.
const realConsole = { ...console };
afterEach(() => { Object.assign(console, realConsole); });
function fakeLoader(calls: any[] = []): WorkerLoaderLike {
  return {
    load(code) {
      calls.push(code);
      const dir = mkdtempSync(join(tmpdir(), "runjs-"));
      for (const [n, src] of Object.entries(code.modules)) writeFileSync(join(dir, n), src);
      const mod = import(join(dir, code.mainModule));
      return { getEntrypoint: () => ({ fetch: async (req: Request) => (await mod).default.fetch(req) }) };
    },
  };
}

describe("runJs (harness module, real import)", () => {
  test("returns the value of the code, with input as data", async () => {
    const r = await runJs(fakeLoader(), "return input.a + input.b;", { a: 2, b: 40 });
    expect(r).toEqual({ result: 42, logs: [], error: null });
  });
  test("captures console.log lines", async () => {
    const r = await runJs(fakeLoader(), `console.log("hi", {x:1}); console.warn("w"); return "ok";`, null);
    expect(r.logs).toEqual(['hi {"x":1}', "w"]); expect(r.result).toBe("ok");
  });
  test("a thrown error comes back as error, not an exception", async () => {
    const r = await runJs(fakeLoader(), `throw new Error("boom");`, null);
    expect(r.error).toBe("boom"); expect(r.result).toBeNull();
  });
  test("invalid code returns a clear error", async () => {
    const r = await runJs(fakeLoader(), `return ((;`, null);
    expect(r.error).toBeTruthy(); expect(r.result).toBeNull();
  });
  test("a load() that throws (e.g. a limit hit) is an error result", async () => {
    const r = await runJs({ load: () => { throw new Error("CPU limit exceeded"); } }, "return 1", null);
    expect(r.error).toContain("CPU limit exceeded");
  });
  test("load() gets: null outbound, empty env, the hard limits, and the input only in the request body (never in the module source)", async () => {
    const calls: any[] = [];
    await runJs(fakeLoader(calls), "return input;", { secret: "SENTINEL-123" });
    const c = calls[0];
    expect(c.globalOutbound).toBeNull(); expect(c.env).toEqual({});
    expect(c.limits).toEqual({ cpuMs: 50, subRequests: 0 }); expect(RUN_JS_LIMITS).toEqual({ cpuMs: 50, subRequests: 0 });
    expect(Object.values(c.modules).join("\n")).not.toContain("SENTINEL-123");
    expect(c.bindings).toBeUndefined();
  });
  test("an undefined result becomes null", async () => {
    expect((await runJs(fakeLoader(), "let x = 1;", null)).result).toBeNull();
  });
});

describe("run_js host", () => {
  const on = async () => true;
  test("output is wrapped as untrusted and truncated to TOOL_RESULT_MAX", async () => {
    const h = runJsHost(fakeLoader(), on);
    const big = await h.call(RUN_JS_TOOL, { code: `return "x".repeat(60000);` });
    expect(big.text.startsWith('<untrusted_content source="run_js">')).toBe(true);
    expect(big.text).toContain("[truncated]");
    expect(big.text.length).toBeLessThan(TOOL_RESULT_MAX + 400);
    const small = await h.call(RUN_JS_TOOL, { code: "return 6*7;" });
    expect(small.isError).toBe(false); expect(small.text).toContain('"result":42');
  });
  test("a failing run is isError; bad args are refused before any load", async () => {
    const calls: any[] = [];
    const h = runJsHost(fakeLoader(calls), on);
    expect((await h.call(RUN_JS_TOOL, { code: "throw 1" })).isError).toBe(true);
    const n = calls.length;
    expect((await h.call(RUN_JS_TOOL, {})).isError).toBe(true);
    expect((await h.call(RUN_JS_TOOL, { code: "x".repeat(RUN_JS_CODE_MAX + 1) })).text).toContain("too long");
    expect(calls.length).toBe(n);
  });
  test("flag off or LOADER missing: not listed, call refused", async () => {
    const off = runJsHost(fakeLoader(), async () => false);
    expect(await off.list()).toEqual([]); expect((await off.call(RUN_JS_TOOL, { code: "return 1" })).isError).toBe(true);
    const none = runJsHost(undefined, on);
    expect(await none.list()).toEqual([]); expect((await none.call(RUN_JS_TOOL, { code: "return 1" })).isError).toBe(true);
  });
  test("flag on: listed with an auto (no-approval) def; classify says auto", async () => {
    const l = await runJsHost(fakeLoader(), on).list();
    expect(l.map((t) => t.name)).toEqual(["run_js"]); expect(l[0]!.approval).toBe(false);
    expect(classify("run_js")).toBe("auto");
  });
});

describe("withRunJs: flag off changes nothing", () => {
  const T = (name: string): ToolDef => ({ name, description: `d ${name}`, approval: false, input_schema: { type: "object", properties: {} } });
  const base: ToolHost = { list: async () => [T("web_read"), T("create_artifact")], call: async (n) => ({ text: "base:" + n, isError: false }) };
  test("off: the exact same list (same array contents, same order); on: run_js added in sorted position", async () => {
    const off = withRunJs(base, runJsHost(fakeLoader(), async () => false));
    expect(JSON.stringify(await off.list())).toBe(JSON.stringify(await base.list()));
    const on = withRunJs(base, runJsHost(fakeLoader(), async () => true));
    expect((await on.list()).map((t) => t.name)).toEqual(["create_artifact", "run_js", "web_read"]);
    expect((await on.call("web_read", {})).text).toBe("base:web_read");
    expect((await on.call("run_js", { code: "return 1" })).text).toContain('"result":1');
  });
  test("prompt bytes: Business system text unchanged and Open tools line has no run_js when off; shows it (sorted, last block) when on", () => {
    const T2 = (name: string) => ({ name, description: "d", approval: false, input_schema: { type: "object", properties: {} } });
    const biz: any = buildRequest("claude-sonnet-5-5", [], [T2("web_read")], null, null, false);
    expect(biz.system[0].text).toBe(SYSTEM_PROMPT);
    const last = (r: any) => r.system[r.system.length - 1].text as string;
    const offReq: any = buildRequest("claude-sonnet-5-5", [], ["web_read", "create_artifact"].map(T2), null, null, false, null, true);
    expect(last(offReq)).toBe("Tools: create_artifact, web_read");
    const onReq: any = buildRequest("claude-sonnet-5-5", [], ["web_read", "create_artifact", "run_js"].map(T2), null, null, false, null, true);
    expect(last(onReq)).toBe("Tools: create_artifact, run_js, web_read");
  });
});

// A loader whose reply body we control (the sandbox's reply is hostile bytes).
const bodyLoader = (mk: () => Response, calls: any[] = []): WorkerLoaderLike => ({ load(c) { calls.push(c); return { getEntrypoint: () => ({ fetch: async () => mk() }) }; } });
const enc = new TextEncoder();

describe("hostile reply: whole-operation timeout and size cap", () => {
  test("a body stream that never ends settles with a timeout error (race covers the body read) and the stream is cancelled", async () => {
    let cancelled = false;
    const l = bodyLoader(() => new Response(new ReadableStream({ pull: () => new Promise(() => {}), cancel() { cancelled = true; } })));
    const t0 = Date.now();
    const r = await runJs(l, "return 1", null, 150);
    expect(r.error).toContain("timed out after 150 ms"); expect(Date.now() - t0).toBeLessThan(1000);
    await Bun.sleep(20); expect(cancelled).toBe(true);
  });
  test("a fetch() that never resolves also times out; default wall is 5 s", async () => {
    const l: WorkerLoaderLike = { load: () => ({ getEntrypoint: () => ({ fetch: () => new Promise<Response>(() => {}) }) }) };
    expect((await runJs(l, "return 1", null, 100)).error).toContain("timed out");
    expect(await Bun.file(new URL("../src/run-js.ts", import.meta.url)).text()).toContain("const WALL_MS = 5_000");
  });
  test("an endless body is bounded by the byte cap (not read whole) and reported", async () => {
    let pulled = 0, cancelled = false;
    const chunk = enc.encode("x".repeat(16 * 1024));
    const l = bodyLoader(() => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(chunk); }, cancel() { cancelled = true; } })));
    const r = await runJs(l, "return 1", null, 2000);
    expect(r.error).toContain("output too large"); expect(pulled).toBeLessThan(10); expect(cancelled).toBe(true);
  });
  test("garbage / wrong-shaped replies are parsed defensively", async () => {
    expect((await runJs(bodyLoader(() => new Response("not json")), "x", null)).error).toContain("unreadable");
    const r = await runJs(bodyLoader(() => new Response(JSON.stringify({ result: 5, logs: "no", error: { a: 1 } }))), "x", null);
    expect(r).toEqual({ result: 5, logs: [], error: null });
    expect((await runJs(bodyLoader(() => new Response("null")), "x", null))).toEqual({ result: null, logs: [], error: null });
  });
});

describe("run_js cost bounds", () => {
  const ok = () => new Response(JSON.stringify({ result: 1, logs: [], error: null }));
  test("calls beyond the per-prompt cap are refused BEFORE load(); a new user message starts fresh", async () => {
    const calls: any[] = [];
    const h = runJsHost(bodyLoader(ok, calls), async () => true);
    const rs = await Promise.all(Array.from({ length: RUN_JS_TURN_MAX + 5 }, () => h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 3, msg: 30 })));
    expect(calls.length).toBe(RUN_JS_TURN_MAX);
    expect(rs.filter((r) => r.isError).length).toBe(5); expect(rs.filter((r) => r.isError).every((r) => r.text.includes("limit reached"))).toBe(true);
    expect((await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 4, msg: 40 })).isError).toBe(false);
    expect((await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 3, msg: 30 })).isError).toBe(true); // repeated batches in the same turn stay capped
  });
  test("at most RUN_JS_CONCURRENCY runs at once; the rest wait and still complete", async () => {
    let cur = 0, max = 0;
    const l: WorkerLoaderLike = { load: () => ({ getEntrypoint: () => ({ fetch: async () => { cur++; max = Math.max(max, cur); await Bun.sleep(30); cur--; return ok(); } }) }) };
    const h = runJsHost(l, async () => true);
    const rs = await Promise.all(Array.from({ length: 6 }, () => h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 1 })));
    expect(max).toBe(RUN_JS_CONCURRENCY); expect(rs.every((r) => !r.isError)).toBe(true);
  });
  test("errors do not leak slots", async () => {
    const h = runJsHost({ load: () => { throw new Error("x"); } }, async () => true);
    for (let i = 0; i < 5; i++) await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: i, msg: 100 + i });
    expect((await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 99, msg: 999 })).text).toContain("run_js"); // returned (load error result), no deadlock
  });
  test("retry (same user message, new engine turn) keeps the used count; a new message gets a fresh allowance", async () => {
    const calls: any[] = [];
    const h = runJsHost(bodyLoader(ok, calls), async () => true);
    for (let i = 0; i < RUN_JS_TURN_MAX; i++) await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 7 });
    const retry = await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 2, msg: 7 }); // retry(): turn counter +1, same prompt
    expect(retry.isError).toBe(true); expect(retry.text).toContain("limit reached"); expect(calls.length).toBe(RUN_JS_TURN_MAX);
    expect((await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 3, msg: 8 })).isError).toBe(false); // new user message
  });
});

// A loader whose request never completes but which observes the abort signal (like a handler awaiting forever).
function hangLoader(seen: { loads: number; aborted: number; signals: AbortSignal[] }): WorkerLoaderLike {
  return { load() { seen.loads++; return { getEntrypoint: () => ({ fetch: (req: Request) => { seen.signals.push(req.signal); req.signal.addEventListener("abort", () => seen.aborted++); return new Promise<Response>(() => {}); } }) }; } };
}
describe("timeout and turn-stop abort the request and free the slot", () => {
  const ok2 = () => new Response(JSON.stringify({ result: 1, logs: [], error: null }));
  test("real 5 s wall: abort observed, timeout error at ~5 s, and the NEXT call proceeds", async () => {
    const seen = { loads: 0, aborted: 0, signals: [] as AbortSignal[] };
    let hang = true;
    const l: WorkerLoaderLike = { load: (c) => (hang ? hangLoader(seen).load(c) : bodyLoader(ok2).load(c)) };
    const h = runJsHost(l, async () => true);
    const t0 = Date.now();
    const r = await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 1 });
    const dt = Date.now() - t0;
    expect(r.isError).toBe(true); expect(r.text).toContain("timed out after 5000 ms"); expect(dt).toBeGreaterThanOrEqual(4900); expect(dt).toBeLessThan(5500);
    expect(seen.aborted).toBe(1); expect(seen.signals[0]!.aborted).toBe(true);
    hang = false;
    expect((await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 1 })).isError).toBe(false);
  }, 15000);
  test("slots are freed after timeouts: more hung runs than slots, each in turn, then a good one", async () => {
    const seen = { loads: 0, aborted: 0, signals: [] as AbortSignal[] };
    let hang = true;
    const l: WorkerLoaderLike = { load: (c) => (hang ? hangLoader(seen).load(c) : bodyLoader(ok2).load(c)) };
    const h = runJsHost(l, async () => true, 80);
    const rs = await Promise.all(Array.from({ length: RUN_JS_CONCURRENCY + 2 }, () => h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 2 })));
    expect(rs.every((r) => r.text.includes("timed out"))).toBe(true); expect(seen.aborted).toBe(RUN_JS_CONCURRENCY + 2);
    hang = false;
    expect((await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 2 })).isError).toBe(false);
  });
  test("a queued call aborted by ctx.signal never loads and leaves the queue; slots stay consistent", async () => {
    const seen = { loads: 0, aborted: 0, signals: [] as AbortSignal[] };
    const h = runJsHost(hangLoader(seen), async () => true, 300);
    const stop = new AbortController();
    const running = Array.from({ length: RUN_JS_CONCURRENCY }, () => h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 3 }));
    await Bun.sleep(20); expect(seen.loads).toBe(RUN_JS_CONCURRENCY);
    const queued = h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 3, signal: stop.signal });
    await Bun.sleep(20); stop.abort();
    const q = await queued;
    expect(q.isError).toBe(true); expect(q.text).toContain("cancelled"); expect(seen.loads).toBe(RUN_JS_CONCURRENCY);
    await Promise.all(running);
    expect(seen.loads).toBe(RUN_JS_CONCURRENCY); // the aborted one never loaded, even after slots freed
    const after = await h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 4 }); // slots all free again
    expect(seen.loads).toBe(RUN_JS_CONCURRENCY + 1); expect(after.text).toContain("timed out");
  });
  test("ctx.signal aborting a RUNNING call aborts the request at once", async () => {
    const seen = { loads: 0, aborted: 0, signals: [] as AbortSignal[] };
    const h = runJsHost(hangLoader(seen), async () => true, 5000);
    const stop = new AbortController();
    const p = h.call(RUN_JS_TOOL, { code: "return 1" }, { turn: 1, msg: 5, signal: stop.signal });
    await Bun.sleep(20); stop.abort();
    const t0 = Date.now(); const r = await p;
    expect(Date.now() - t0).toBeLessThan(500); expect(r.text).toContain("aborted"); expect(seen.aborted).toBe(1);
  });
  test("load() is inside the timed/abortable region: a signal already aborted never loads", async () => {
    const seen = { loads: 0, aborted: 0, signals: [] as AbortSignal[] };
    const ac = new AbortController(); ac.abort();
    const r = await runJs(hangLoader(seen), "return 1", null, 100, ac.signal);
    expect(r.error).toContain("aborted"); expect(seen.loads).toBe(0);
  });
});
