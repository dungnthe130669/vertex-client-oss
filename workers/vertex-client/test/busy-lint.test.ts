import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

// Lint-style guard: every awaited server mutation in web/src must hold the busy registry (withBusy) so the PWA update flow never
// reloads the page under it. Mutators = exported functions in the api modules whose body sends a non-GET request.
const DIR = new URL("../web/src/", import.meta.url).pathname;
const API_FILES = ["api.ts", "agents-api.ts", "cloud-api.ts", "desktop-api.ts", "remote-api.ts", "push.ts"];
// Explicit exceptions (name -> why). Everything else must be inside withBusy(...).
const ALLOW: Record<string, string> = {};

const src = (f: string) => readFileSync(DIR + f, "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export function mutators(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const f of API_FILES) {
    const t = strip(files[f] ?? "");
    // one top-level statement per exported function / const; a non-GET marker anywhere in it makes it a mutator
    for (const m of t.matchAll(/export (?:async )?(?:function|const) (\w+)([\s\S]*?)(?=\n(?:export|const|let|function|async function) |\n*$)/g)) {
      if (/method:\s*"(?:POST|PATCH|PUT|DELETE)"|\bB\(/.test(m[2]) || /method\s*=\s*"(?:POST|PATCH|PUT|DELETE)"/.test(m[2])) out.push(m[1]);
    }
  }
  return out;
}

/** Offending call sites: a mutator referenced (called or passed) outside any withBusy( ... ) span, or a raw non-GET fetch outside the api modules. */
export function violations(files: Record<string, string>, names: string[]): string[] {
  const bad: string[] = [];
  for (const [f, raw] of Object.entries(files)) {
    if (API_FILES.includes(f)) continue;
    const t = strip(raw).split("\n").filter((l) => !/^\s*import /.test(l)).join("\n");
    for (const n of names) {
      if (ALLOW[n]) continue;
      for (const m of t.matchAll(new RegExp(`(?<![\\w.])${n}\\b`, "g"))) {
        const before = t.slice(0, m.index);
        const w = before.lastIndexOf("withBusy(");
        let depth = 0;
        if (w >= 0) for (const ch of before.slice(w + "withBusy".length)) { if (ch === "(") depth++; else if (ch === ")") depth--; }
        if (w < 0 || depth <= 0) bad.push(`${f}: ${n} (line ${before.split("\n").length})`);
      }
    }
    for (const m of t.matchAll(/fetch\([^)]*method:\s*"(POST|PATCH|PUT|DELETE)"/g)) bad.push(`${f}: raw ${m[1]} fetch`);
  }
  return bad;
}

const files = Object.fromEntries(readdirSync(DIR).filter((f) => /\.tsx?$/.test(f)).map((f) => [f, src(f)]));

describe("mutations hold the busy registry", () => {
  const names = mutators(files);
  test("finds the known mutators (guards against the scan going blind)", () => {
    for (const n of ["logout", "createConversation", "deleteSkill", "agentAction", "cancelSchedule", "runAction", "approveCommand", "desktopStop", "sendTestPush"]) expect(names).toContain(n);
    expect(names).not.toContain("getMe");
    expect(names).not.toContain("listConversations");
  });
  test("no mutating call in web/src outside withBusy", () => expect(violations(files, names)).toEqual([]));
  test("the detector flags an unwrapped call and accepts a wrapped one", () => {
    expect(violations({ "x.tsx": "const a = async () => { await runAction(id, a); };" }, ["runAction"])).toHaveLength(1);
    expect(violations({ "x.tsx": "const a = async () => { await withBusy('k', () => runAction(id, a)); };" }, ["runAction"])).toEqual([]);
    expect(violations({ "x.tsx": "await withBusy('k', logout); await withBusy('k', () => 1); await logout();" }, ["logout"])).toHaveLength(1);
    expect(violations({ "x.tsx": 'fetch("/x", { method: "POST" })' }, [])).toHaveLength(1);
  });
});
