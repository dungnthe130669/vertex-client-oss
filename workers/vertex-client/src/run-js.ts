// run_js: lets the model run a small piece of JavaScript (arithmetic, parsing, reshaping data) in a Cloudflare Dynamic Worker sandbox
// (docs: developers.cloudflare.com/dynamic-workers/ , binding `worker_loaders` = env.LOADER). Pure: no network (`globalOutbound: null`, always explicit:
// omitted would INHERIT ours), no env/secrets/bindings, no D1/R2, hard CPU + subrequest caps, a fresh worker per run (`load()`, never `get()`).
// Offered only when env.LOADER exists AND the settings row `run_js:<base>` is exactly '1' (default OFF); otherwise the tool list is unchanged byte for byte.
// The input data travels as the JSON request body, never inside the module source. The result is untrusted text (model-written code can echo anything).
import { TOOL_RESULT_MAX, wrapUntrusted, type ToolDef, type ToolHost } from "./tools";

export const RUN_JS_TOOL = "run_js";
export const RUN_JS_TOOLS = new Set([RUN_JS_TOOL]);
export const RUN_JS_CODE_MAX = 8000;
export const RUN_JS_LIMITS = { cpuMs: 50, subRequests: 0 } as const;
const WALL_MS = 5_000; // a promise that never settles burns no CPU, so cpuMs alone would not end it
export const RUN_JS_TURN_MAX = 8; // executions per engine turn
export const RUN_JS_CONCURRENCY = 2;
const REPLY_MAX_BYTES = 64 * 1024; // what we will read back from the sandbox
const LOG_MAX = 50; // console lines kept
const COMPAT_DATE = "2026-03-01"; // same as wrangler.jsonc

/** The slice of the Worker Loader binding this file uses (the Worker's ambient types do not include it). */
export interface WorkerLoaderLike {
  load(code: {
    compatibilityDate: string; mainModule: string; modules: Record<string, string>; env: Record<string, never>;
    globalOutbound: null; limits: { cpuMs: number; subRequests: number };
  }): { getEntrypoint(name?: string | null, opts?: { limits?: { cpuMs?: number; subRequests?: number } }): { fetch(req: Request): Promise<Response> } };
}

/** Settings row `run_js:<base>` = '1' (default off; a lookup error = off, fail closed). */
export async function loadRunJs(db: D1Database, base: string): Promise<boolean> {
  try { return (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(`run_js:${base}`).first<{ value: string }>())?.value === "1"; } catch { return false; }
}

export const RUN_JS_DEF: ToolDef = {
  name: RUN_JS_TOOL,
  description: "Run JavaScript in an isolated sandbox with no network, no files and no secrets. Use it for exact arithmetic, parsing, sorting, and reshaping data instead of doing it in your head. `code` is the BODY of an async function: it can use `input` (the JSON you pass) and must `return` the result (JSON-serialisable). console.log output is returned too. Limits: about 50 ms of CPU and 5 s of wall time, so keep it small.",
  input_schema: { type: "object", properties: { code: { type: "string", maxLength: RUN_JS_CODE_MAX, description: "Body of an async function; `input` is in scope; `return` the result." }, input: { description: "Optional JSON data, available to the code as `input`." } }, required: ["code"] },
  approval: false,
};

// The user's code lives in its own module so a syntax error fails to load that module (reported as an error) and cannot break the harness.
const USER_MODULE_PRE = "export default async function (input) {\n";
const USER_MODULE_POST = "\n}\n";
const MAIN_MODULE = `import run from "./user.js";
const logs = [];
const fmt = (a) => { try { return typeof a === "string" ? a : JSON.stringify(a) ?? String(a); } catch { return String(a); } };
for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => { if (logs.length < ${LOG_MAX}) logs.push(a.map(fmt).join(" ").slice(0, 2000)); };
export default {
  async fetch(req) {
    let result = null, error = null;
    try {
      const v = await run(await req.json());
      result = v === undefined ? null : JSON.parse(JSON.stringify(v));
    } catch (e) { error = String((e && e.message) || e); }
    return Response.json({ result, logs, error });
  },
};
`;

export interface RunJsResult { result: unknown; logs: string[]; error: string | null }

/** Read a body as bytes with a hard cap (streamed: a huge or endless body is never held whole). Returns null when over the cap. */
async function readCapped(res: Response, cap: number, onReader: (r: ReadableStreamDefaultReader<Uint8Array>) => void): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader(); onReader(reader);
  const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > cap) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(n); let o = 0; for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Everything the sandbox sends back is hostile bytes: size-capped, parsed defensively, shape-checked. */
function parseReply(text: string): RunJsResult {
  let j: unknown; try { j = JSON.parse(text); } catch { return { result: null, logs: [], error: "sandbox returned an unreadable reply" }; }
  const o = (j && typeof j === "object" ? j : {}) as { result?: unknown; logs?: unknown; error?: unknown };
  return { result: o.result ?? null, logs: Array.isArray(o.logs) ? o.logs.slice(0, LOG_MAX).map((l) => String(l).slice(0, 2000)) : [], error: typeof o.error === "string" ? o.error.slice(0, 2000) : null };
}

/** Run `code` once. Never throws: a load failure, a limit hit, an oversized reply, a timeout or an abort comes back as `error`.
 *  The AbortController + the ONE wall-clock timer exist BEFORE load(); the signal is passed into the request to the stub and `outer` (the turn's stop signal)
 *  is linked to it. Whether a fetch to a dynamic-worker stub honours an AbortSignal is NOT stated in the Dynamic Workers docs/types (UNVERIFIED), so on
 *  timeout/abort we also cancel the body reader and drop every reference; the caller keeps its concurrency slot until this promise settles (always: the
 *  race below settles at the wall bound even if the sandbox never answers), so concurrency is bounded by the wall time, not by the sandbox's cooperation. */
export async function runJs(loader: WorkerLoaderLike, code: string, input: unknown, wallMs: number = WALL_MS, outer?: AbortSignal): Promise<RunJsResult> {
  const ac = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onOuter = () => ac.abort(new Error("aborted (turn stopped)"));
  if (outer?.aborted) return { result: null, logs: [], error: "aborted (turn stopped)" };
  outer?.addEventListener("abort", onOuter, { once: true });
  const stop = new Promise<never>((_, rej) => {
    timer = setTimeout(() => ac.abort(new Error(`timed out after ${wallMs} ms`)), wallMs);
    ac.signal.addEventListener("abort", () => rej(ac.signal.reason), { once: true });
  });
  stop.catch(() => {});
  const work = (async (): Promise<RunJsResult> => {
    const worker = loader.load({
      compatibilityDate: COMPAT_DATE, mainModule: "main.js",
      modules: { "main.js": MAIN_MODULE, "user.js": USER_MODULE_PRE + code + USER_MODULE_POST },
      env: {}, globalOutbound: null, limits: { ...RUN_JS_LIMITS },
    });
    const res = await worker.getEntrypoint().fetch(new Request("https://run-js.invalid/", { method: "POST", body: JSON.stringify(input ?? null), signal: ac.signal }));
    const text = await readCapped(res, REPLY_MAX_BYTES, (r) => { reader = r; });
    return text === null ? { result: null, logs: [], error: `output too large (over ${REPLY_MAX_BYTES} bytes)` } : parseReply(text);
  })();
  work.catch(() => {}); // a late rejection after the timeout/abort already won must not be unhandled
  try {
    return await Promise.race([work, stop]);
  } catch (e) {
    return { result: null, logs: [], error: String(e instanceof Error ? e.message : e).slice(0, 500) };
  } finally {
    clearTimeout(timer); outer?.removeEventListener("abort", onOuter);
    if (!ac.signal.aborted) ac.abort(new Error("done")); // cancels the request to the stub if it is somehow still open
    void reader?.cancel().catch(() => {});
  }
}

/** Tool host for run_js. `on` is asked per list/call: the flag off (or no loader) = no tool, and the call is refused.
 *  Cost bounds (the 25-iteration limit bounds model calls, not tool executions: one response can emit many parallel calls): at most RUN_JS_TURN_MAX executions
 *  per user prompt (keyed on the stored user message id `ctx.msg`, so retry/regenerate of the same prompt keeps its count and a new message gets a fresh one;
 *  kept in memory, so an eviction of the DO resets it: accepted residual; excess is refused BEFORE loader.load()) and RUN_JS_CONCURRENCY at once. */
export function runJsHost(loader: WorkerLoaderLike | undefined, on: () => Promise<boolean>, wallMs: number = WALL_MS): ToolHost {
  const live = async () => !!loader && (await on());
  const perPrompt = new Map<number, number>();
  let running = 0; const waiters: Array<() => void> = [];
  /** Take a slot, or leave the queue if `sig` aborts first (returns false: the caller must not load anything and must not release). */
  const acquire = (sig?: AbortSignal): Promise<boolean> => {
    if (sig?.aborted) return Promise.resolve(false);
    if (running < RUN_JS_CONCURRENCY) { running++; return Promise.resolve(true); }
    return new Promise<boolean>((resolve) => {
      const w = () => { sig?.removeEventListener("abort", onAbort); resolve(true); }; // the releaser hands its slot over: `running` stays
      const onAbort = () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(false); };
      waiters.push(w); sig?.addEventListener("abort", onAbort, { once: true });
    });
  };
  const release = () => { const w = waiters.shift(); if (w) w(); else running--; };
  return {
    async list() { return (await live()) ? [RUN_JS_DEF] : []; },
    async call(name, args, ctx) {
      if (name !== RUN_JS_TOOL || !loader || !(await on())) return { text: `tool ${name} is not available`, isError: true };
      const a = (args ?? {}) as { code?: unknown; input?: unknown };
      if (typeof a.code !== "string" || !a.code.trim()) return { text: "run_js needs a non-empty `code` string", isError: true };
      if (a.code.length > RUN_JS_CODE_MAX) return { text: `code is too long (${a.code.length} > ${RUN_JS_CODE_MAX} characters)`, isError: true };
      const key = ctx?.msg ?? -(ctx?.turn ?? 0) - 1; // synchronous check+increment: parallel calls of one batch cannot all pass
      const used = perPrompt.get(key) ?? 0;
      if (used >= RUN_JS_TURN_MAX) return { text: `run_js limit reached: at most ${RUN_JS_TURN_MAX} runs per message. Combine the work into fewer calls or answer without it.`, isError: true };
      perPrompt.set(key, used + 1);
      if (perPrompt.size > 20) for (const k of [...perPrompt.keys()].slice(0, perPrompt.size - 20)) perPrompt.delete(k);
      if (!(await acquire(ctx?.signal))) return { text: "run_js was cancelled before it started", isError: true };
      let r: RunJsResult;
      try { r = await runJs(loader, a.code, a.input, wallMs, ctx?.signal); } finally { release(); }
      let text = JSON.stringify(r);
      if (text.length > TOOL_RESULT_MAX) text = text.slice(0, TOOL_RESULT_MAX) + "\n[truncated]";
      return { text: wrapUntrusted(RUN_JS_TOOL, text), isError: r.error !== null };
    },
  };
}

/** Base host + run_js: sorted by name overall (cache breakpoint), calls routed by name; a connector can never shadow the name. */
export function withRunJs(base: ToolHost, rj: ToolHost): ToolHost {
  return {
    async list() {
      const [a, b] = await Promise.all([base.list(), rj.list()]);
      if (!b.length) return a; // off: the base list, untouched
      return [...a.filter((t) => !RUN_JS_TOOLS.has(t.name)), ...b].sort((x, y) => x.name.localeCompare(y.name));
    },
    call: (name, args, ctx) => (RUN_JS_TOOLS.has(name) ? rj.call(name, args, ctx) : base.call(name, args, ctx)),
  };
}
