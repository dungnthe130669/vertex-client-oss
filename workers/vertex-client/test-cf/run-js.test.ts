import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runJs, runJsHost, type WorkerLoaderLike } from "../src/run-js";

// The real Dynamic Worker sandbox, in workerd (wrangler `worker_loaders` -> env.LOADER). The seam the unit tests cannot prove:
// cpuMs kills a loop, globalOutbound:null blocks fetch, and nothing of ours (env, secrets, process) is reachable.
const loader = (env as unknown as { LOADER?: WorkerLoaderLike }).LOADER!;

describe("run_js sandbox (workerd worker_loaders)", () => {
  it("the binding exists", () => { expect(loader).toBeTruthy(); });
  it("runs code with input as data", async () => {
    expect(await runJs(loader, "console.log('a'); return input.n * 2;", { n: 21 })).toEqual({ result: 42, logs: ["a"], error: null });
  });
  it("a thrown error and invalid code come back as errors", async () => {
    expect((await runJs(loader, `throw new Error("boom")`, null)).error).toBe("boom");
    expect((await runJs(loader, `return ((;`, null)).error).toBeTruthy();
  });
  // SKIPPED: local workerd (vitest pool) does not enforce WorkerCode `limits.cpuMs`: `while(true){}` never ends and hangs the pool (observed 2026-10-27, >40 s, killed by timeout).
  // The real Cloudflare runtime must prove it: see the manual procedure in docs/reports/runjs-spike.md (live, flag on). Un-skip only to run against a runtime that enforces it.
  it.skip("an infinite loop is killed by the CPU limit", async () => {
    const t0 = Date.now();
    const r = await runJs(loader, "while (true) {}", null);
    expect(r.error).toBeTruthy(); expect(r.result).toBeNull();
    expect(Date.now() - t0).toBeLessThan(4500);
  });
  it("fetch() is blocked (no network)", async () => {
    const r = await runJs(loader, `try { await fetch("https://example.com"); return "REACHED"; } catch (e) { return "blocked: " + e.message; }`, null);
    expect(r.result).toMatch(/^blocked/); expect(r.result).not.toBe("REACHED");
  });
  it("no process / env / our secrets are reachable", async () => {
    const r = await runJs(loader, `
      const out = { process: typeof process, Deno: typeof Deno, require: typeof require };
      try { out.envKeys = Object.keys(globalThis.env ?? {}); } catch { out.envKeys = "n/a"; }
      return out;`, null);
    expect(r.error).toBeNull();
    expect(r.result).toMatchObject({ process: "undefined", Deno: "undefined", require: "undefined" });
    expect(JSON.stringify(r.result)).not.toContain("test-session-secret");
  });
  it("the tool host end to end: wrapped, flag respected", async () => {
    const h = runJsHost(loader, async () => true);
    const out = await h.call("run_js", { code: "return [3,1,2].sort();" });
    expect(out.text).toContain('"result":[1,2,3]'); expect(out.text).toContain("untrusted_content");
  });
});
