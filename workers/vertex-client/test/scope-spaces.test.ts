// Spaces T1: the typed scope (BaseScope / Space / Scope) and the static guard that only src/scope.ts builds or splits a scope string.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { baseOf, guestUid, isGuestScope, mayUseErichOnlyModes, mayUseErichOnlyModesIn, parseBase, parseScope, providerFor, scopeFor, spaceOf, spaceUsesGateway, turnCapFor, type BaseScope, type GuestScope, type Scope } from "../src/scope";

const G = "g:abcdefghijklmnopqrstuvwx" as GuestScope;

describe("scope grammar", () => {
  test("Business = the bare base, byte-identical to the pre-spaces string", () => {
    for (const b of ["main", "e2e", G] as BaseScope[]) { expect(scopeFor(b, "biz")).toBe(b); expect(parseScope(b)).toBe(b); expect(spaceOf(b)).toBe("biz"); expect(baseOf(b)).toBe(b); }
  });
  test("Open = <base>~open and round-trips", () => {
    for (const b of ["main", "e2e", G] as BaseScope[]) { const o = scopeFor(b, "open"); expect(o as string).toBe(`${b as string}~open`); expect(parseScope(o)).toBe(o); expect(spaceOf(o)).toBe("open"); expect(baseOf(o)).toBe(b); }
  });
  test("parse fails closed", () => {
    for (const v of [null, undefined, 1, {}, "", "~open", "main~biz", "main~open~open", "main~", "MAIN", "main ", "main~OPEN", "g:short~open", "g:ABCDEFGHIJKLMNOPQRSTUVWX", "g:abcdefghijklmnopqrstuvwx~", "x~open", "open"]) expect(parseScope(v)).toBeNull();
    expect(parseBase("main~open")).toBeNull(); expect(parseBase(scopeFor(G, "open"))).toBeNull();
    expect(parseBase("main")).toBe("main"); expect(parseBase(G)).toBe(G);
  });
  test("an Open scope is never a guest, never Erich-only, never the gateway, whatever its base", () => {
    for (const b of ["main", "e2e", G] as BaseScope[]) {
      const o = scopeFor(b, "open");
      expect(mayUseErichOnlyModesIn(o)).toBe(false); expect(spaceUsesGateway(o)).toBe(false);
      expect(() => providerFor(o, () => "erich")).toThrow("no provider for scope");
    }
    for (const o of ["main~open", "e2e~open", scopeFor(G, "open")] as Scope[]) { // neither callback may run for an Open scope
      let e = 0, g = 0;
      expect(() => providerFor(o, () => { e++; return "erich"; }, () => { g++; return "guest"; })).toThrow("no provider for scope");
      expect([e, g]).toEqual([0, 0]);
    }
    let gc = 0; expect(providerFor(G, () => "erich", () => { gc++; return "guest"; })).toBe("guest"); expect(gc).toBe(1); // Business guest unchanged
    expect(mayUseErichOnlyModesIn("main")).toBe(true); expect(mayUseErichOnlyModesIn("e2e")).toBe(true); expect(mayUseErichOnlyModesIn(G)).toBe(false);
    expect(mayUseErichOnlyModes("main")).toBe(true); expect(isGuestScope(baseOf(scopeFor(G, "open")))).toBe(true); expect(guestUid(G)).toBe("abcdefghijklmnopqrstuvwx");
    expect(turnCapFor(baseOf("main~open"))).toBe(3); expect(turnCapFor(baseOf(scopeFor(G, "open")))).toBe(1);
  });
  test("isGuestScope on a cast-through Open value is false (typed BaseScope-only, so Open cannot reach it; ~ is never a Business guest)", () => {
    expect(isGuestScope("main~open" as unknown as BaseScope)).toBe(false);
    expect(isGuestScope("e2e~open" as unknown as BaseScope)).toBe(false);
    expect(isGuestScope(scopeFor(G, "open") as unknown as BaseScope)).toBe(false);
    expect(isGuestScope(G)).toBe(true);
  });
  test("types: a Scope is not a BaseScope (compile-time; tsc covers this file)", () => {
    const s: Scope = scopeFor("main", "open");
    // @ts-expect-error a Scope (maybe ~open) must not reach a policy function without baseOf/spaceOf
    isGuestScope(s);
    // @ts-expect-error a plain string is not a guest base
    const bad: GuestScope = "g:abcdefghijklmnopqrstuvwx"; void bad;
    // @ts-expect-error a hand-written guest Open literal is not an OpenScope (only scopeFor/parseScope mint one)
    const bad3: Scope = "g:short~open"; void bad3;
    // @ts-expect-error the Open form of a guest is not a base either
    const bad2: BaseScope = scopeFor(G, "open"); void bad2;
    expect(isGuestScope(baseOf(s))).toBe(false);
  });
});

// Only scope.ts may build or split a scope string; baseOf( only at the credential / cost / policy sites listed here.
const SRC = join(import.meta.dir, "..", "src");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : []; });
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, "utf8") })).filter((f) => f.rel !== "scope.ts");
const code = (t: string) => t.split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/\s\/\/ .*$/, "")); // drop comment text (explanations may quote the grammar)

describe("static: scope strings are built and split only in scope.ts", () => {
  const FORBIDDEN: [string, RegExp][] = [
    ["the Open suffix", /~open/],
    ["startsWith/endsWith on a guest prefix", /\.(startsWith|endsWith)\(\s*["'`]g:/],
    ["a guest scope template", /`g:\$\{/],
    ["a guest scope concatenation", /["']g:["']\s*\+/],
    ["string surgery on a scope value", /\b(sc|scope|scopeOf\([a-z]+\)|d\.scope)\.(slice|split|substring|substr|replace|startsWith|endsWith|indexOf|match)\(/],
  ];
  for (const [name, re] of FORBIDDEN) test(`no ${name} outside scope.ts`, () => {
    const hits = files.flatMap((f) => code(f.text).flatMap((l, i) => (re.test(l) ? [`${f.rel}:${i + 1}: ${l.trim().slice(0, 120)}`] : [])));
    expect(hits).toEqual([]);
  });
  test("baseOf( only in exact allowed call expressions (never as an argument to a data-key / SQL-bind helper)", () => {
    // Each allowed use feeds a POLICY predicate keyed by who (the base); none builds a data key or SQL bind value.
    const ALLOWED: RegExp[] = [
      /\bopenAllowed\(\s*[\w.]+,\s*baseOf\(/, // open-space.ts: the per-user Open flag is keyed by who (the base)
      /\b(isGuestScope|turnCapFor|scopeMayUse|scopeGetsGateway|seedsFor|mayUseErichOnlyModes)\(\s*baseOf\(/, // base-keyed policy tables / predicates
      /\bloadProviderConfigs\(\s*[\w.]+,\s*baseOf\(/, // shared credentials: provider_configs are read with the BASE (the one thing shared across spaces)
      /\b(userKeyIds|userKeysFor|userKeyOf|cfAccountOf|featuresOf|featureOn|loadUserBroken|loadE2eRealProviders)\(\s*[\w.]+,\s*baseOf\(/, // provider keys / linked Cloudflare account / per-user feature flags: encrypted or keyed per BASE (who); AAD binds base+provider, never a space
      /\b(approvalAutoOn|loadDebugTurns|loadRunJs|loadAnswerLimit|saveAnswerLimit)\(\s*[\w.]+,\s*baseOf\(/, // approval.ts kill switch / debug_turns diagnostics / run_js flag settings `approval_auto:<base>`: keyed by who (the base), exactly like open_space; answer_limit:<base> the same
      /\bmarkBroken\(\s*[\w.]+,\s*pid,\s*m,\s*baseOf\(scope\)\)/, // a 404 is recorded in THAT user's own broken list (settings pbroken:<base>:<provider>), never the shared catalog
      /\bwithBuiltinPresets\(\s*baseOf\(/, // built-in provider presets are a policy table keyed by who (the base)
      /^\s*const base = \(c: Context<App>\) => baseOf\(scopeOf\(c\)\);/, // cf-routes: the request's base, feeding only the linked-account key store
      /^\s*const baseOfReq = \(c: Context<App>\) => baseOf\(scopeOf\(c\)\);/, // provider-routes: the request's base, feeding only the user-key store
      /^\s*const gb = baseOf\(sc\);/,   // chat-session: base held only to feed isGuestScope(gb) on the next line
      /^\s*const base = baseOf\(scope\);/, // index-d1: base feeds turnCapFor/isGuestScope and scopeFor(base, "biz"|"open") for the by-base cap count
    ];
    const hits = files.flatMap((f) => code(f.text).flatMap((l, i) => {
      const stripped = ALLOWED.reduce((a, re) => a.replace(new RegExp(re.source, "g"), ""), l);
      return /\bbaseOf\(/.test(stripped) && !/^import /.test(l) ? [`${f.rel}:${i + 1}: ${l.trim().slice(0, 120)}`] : [];
    }));
    expect(hits).toEqual([]);
  });
});
