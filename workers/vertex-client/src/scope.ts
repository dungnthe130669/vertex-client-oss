// Tenant scope: the one place that says who a data row / request / conversation belongs to. Fail closed everywhere.
//   main = Erich (GitHub/SSO login), e2e = the automated tester, g:<uid> = a future team user (no login mints it yet; P0 only hardens).
// Policy that depends on the scope (Erich-only modes, tool host, credential, turn caps) lives here as explicit tables, so a new scope
// value gets NOTHING until someone adds it on purpose.
import type { Context, Next } from "hono";
import type { Session } from "./auth";

export const MAIN_SCOPE = "main";
export const E2E_SCOPE = "e2e";
/** Parallel e2e slots. Slot 0 is the historical `e2e` scope / `e2e-bot` user (unchanged). Slots 1..E2E_MAX_SLOT are DISTINCT, synthetic fixture tenants
 *  `e2e:<n>` / `e2e-bot-<n>` with their own rows everywhere a scope is a key. A small closed whitelist: never parsed from free text beyond it. */
export const E2E_MAX_SLOT = 3;
export const E2E_SLOT_SCOPES = ["e2e:1", "e2e:2", "e2e:3"] as const;
export type E2eSlotScope = (typeof E2E_SLOT_SCOPES)[number];

// A scope is a BASE (who: main / e2e / g:<uid>) plus an optional SPACE suffix. Business = the bare base, byte-identical to the
// pre-spaces scope string (zero migration). Open = `<base>~open`. Policy reads the BASE; data keys take the full Scope.
// `g:${string}` alone would also match `g:x~open`, so the guest base is branded: a Scope is NOT assignable to BaseScope, and every
// policy call site must say `baseOf(...)`/`spaceOf(...)` on purpose. Only this file builds or splits a scope string.
declare const baseBrand: unique symbol;
export type GuestScope = `g:${string}` & { readonly [baseBrand]: true };
export type BaseScope = "main" | "e2e" | E2eSlotScope | GuestScope;
export type Space = "biz" | "open";
// The guest Open form is branded too, so a literal like `g:short~open` does not typecheck: only scopeFor/parseScope mint one.
declare const openBrand: unique symbol;
export type OpenScope = "main~open" | "e2e~open" | `${E2eSlotScope}~open` | (`g:${string}~open` & { readonly [openBrand]: true });
export type Scope = BaseScope | OpenScope;

const GUEST = /^g:[a-z0-9]{16,32}$/;
const OPEN_SUFFIX = "~open";

/** Strict base parse: exactly main / e2e / g:<16-32 lowercase alnum>, else null. */
export function parseBase(v: unknown): BaseScope | null {
  if (v === MAIN_SCOPE || v === E2E_SCOPE) return v;
  if (typeof v === "string" && (E2E_SLOT_SCOPES as readonly string[]).includes(v)) return v as E2eSlotScope;
  return typeof v === "string" && GUEST.test(v) ? (v as GuestScope) : null;
}
/** The only parse function: a base, or a base + `~open`; anything else is rejected (null). Fail closed. */
export function parseScope(v: unknown): Scope | null {
  if (typeof v !== "string") return null;
  if (v.endsWith(OPEN_SUFFIX)) return parseBase(v.slice(0, -OPEN_SUFFIX.length)) ? (v as OpenScope) : null;
  return parseBase(v);
}
export const baseOf = (s: Scope): BaseScope => (s.endsWith(OPEN_SUFFIX) ? s.slice(0, -OPEN_SUFFIX.length) : s) as BaseScope;
export const spaceOf = (s: Scope): Space => (s.endsWith(OPEN_SUFFIX) ? "open" : "biz");
/** The ONLY constructor of a Scope from parts. */
export const scopeFor = (b: BaseScope, sp: Space): Scope => (sp === "open" ? `${b}${OPEN_SUFFIX}` : b) as Scope;
/** The same owner in another space: the only way to move a Scope between spaces (the owner never changes). */
export const withSpace = (s: Scope, sp: Space): Scope => scopeFor(baseOf(s), sp);
/** Strict selector parse for `x-vc-space` / `?space=`: exactly "biz" or "open", no case folding, no storage strings. */
export const parseSpace = (v: unknown): Space | null => (v === "biz" || v === "open" ? v : null);
/** The uid of a guest base (`g:<uid>`), the key of team_users. */
export const guestUid = (g: GuestScope): string => g.slice(2);
/** Typed BaseScope-only, so an Open scope cannot reach it without baseOf. Defence in depth for a cast-through value: anything containing `~`
 *  (an Open scope) is NOT a guest. Safe for Business: parseBase only mints `g:[a-z0-9]{16,32}`, so no Business scope contains `~`. */
export const isGuestScope = (s: BaseScope): s is GuestScope => s !== MAIN_SCOPE && !isE2eBase(s) && !s.includes("~");

/** Any e2e fixture tenant: the classic `e2e` or a slot `e2e:<1..3>`. Every policy that said `=== E2E_SCOPE` means this (an e2e tenant gets the SAME restrictions, never more). */
export const isE2eBase = (b: string): b is "e2e" | E2eSlotScope => b === E2E_SCOPE || (E2E_SLOT_SCOPES as readonly string[]).includes(b);
/** The exact Business e2e scope (no Open suffix) of any slot: the old `scope === E2E_SCOPE` test, slot-aware. */
export const isE2eBiz = (s: string): boolean => isE2eBase(s);
/** Fixture user of a slot: 0 -> `e2e-bot` (unchanged), 1..3 -> `e2e-bot-<n>`. */
export const E2E_USER_BASE = "e2e-bot";
export const e2eUserOfSlot = (n: number): string | null => (n === 0 ? E2E_USER_BASE : Number.isInteger(n) && n >= 1 && n <= E2E_MAX_SLOT ? `${E2E_USER_BASE}-${n}` : null);
/** Slot of a fixture user, strictly: exactly `e2e-bot` or `e2e-bot-1..3` (no leading zeros, no other text), else null. */
export const e2eSlotOfUser = (u: unknown): number | null => (u === E2E_USER_BASE ? 0 : typeof u === "string" && /^e2e-bot-[1-3]$/.test(u) ? Number(u.slice(-1)) : null);
/** Strict slot parse from untrusted text (header): "0".."3" only, canonical digits, else null. */
export const parseE2eSlot = (v: unknown): number | null => (typeof v === "string" && /^[0-3]$/.test(v) ? Number(v) : null);
export const e2eScopeOfSlot = (n: number): BaseScope | null => (n === 0 ? E2E_SCOPE : Number.isInteger(n) && n >= 1 && n <= E2E_MAX_SLOT ? E2E_SLOT_SCOPES[n - 1] : null);

/** The single decision point mapping a session to its data scope. An unknown `via` throws: it must never fall through to main.
 *  A future team session maps to `g:<uid>` here and nowhere else. `space` is only ever "open" when the resolution middleware (open-space.ts) validated it. */
export function scopeOfSession(s: Pick<Session, "via"> & { uid?: string; u?: string; own?: boolean }, space: Space = "biz"): Scope {
  if (s.via === "e2e") { const n = s.u === undefined ? 0 : e2eSlotOfUser(s.u); /* no user given = the classic e2e (readSession has already validated u upstream); a GIVEN invalid user throws */ const b = n === null ? null : e2eScopeOfSlot(n); if (b) return scopeFor(b, space); throw new Error("no scope for session"); }
  if (s.via === "github") return scopeFor(MAIN_SCOPE, space);
  if (s.via === "team" && s.own === true) return scopeFor(MAIN_SCOPE, space); // conv4: ONLY a session minted by the team callback for a verified OWNER_EMAILS match (readSession re-checks the env on every request)
  if (s.via === "team") { const g = parseBase(`g:${s.uid}`); if (g && isGuestScope(g)) return scopeFor(g, space); } // a team session is NEVER main by its email alone: only the signed `own` flag (above) maps to main
  throw new Error("no scope for session");
}

/** C1 (wscaps1): the ONE table of what a base KIND may ever do, before any per-account setting. Every older hard-coded check (ERICH_ONLY_ALLOWED,
 *  the `base !== main && !e2e` test in vclEnabled, the per-user device limit) now reads this, with the SAME answers as before. Settings can only narrow
 *  `erichOnlyModes`/`personalFeatures`; `devices` is the kind-level ceiling and the per-base `vcl:<base>` flag (caps.ts) still has to be '1'.
 *  - main / e2e*: Erich-only modes + personal features, devices (flag-gated), up to 10 live devices.
 *  - g:<uid> (team user): chat only; devices only through the flag (C2), at most ONE live device; Open space as before. */
export interface KindCaps { readonly erichOnlyModes: boolean; readonly personalFeatures: boolean; readonly devices: boolean; readonly devicesMax: number }
const FULL_KIND: KindCaps = Object.freeze({ erichOnlyModes: true, personalFeatures: true, devices: true, devicesMax: 10 });
const GUEST_KIND: KindCaps = Object.freeze({ erichOnlyModes: false, personalFeatures: false, devices: true, devicesMax: 1 });
const NO_KIND: KindCaps = Object.freeze({ erichOnlyModes: false, personalFeatures: false, devices: false, devicesMax: 0 });
export const kindCaps = (b: BaseScope): KindCaps => (b === MAIN_SCOPE || isE2eBase(b) ? FULL_KIND : parseBase(b) !== null && isGuestScope(b) ? GUEST_KIND : NO_KIND); // a guest must be a well-formed g:<uid>: anything else gets nothing (fail closed)
/** Kind table of a full Scope (Business or Open), so call sites never split the scope themselves. */
export const kindCapsOf = (s: Scope): KindCaps => kindCaps(baseOf(s));
/** The team uid of a Scope's guest base, or null when the base is not a guest (main / e2e). */
export const guestUidOfScope = (s: Scope): string | null => { const b = baseOf(s); return isGuestScope(b) ? guestUid(b) : null; };
/** Kept for callers/tests that import the set; it is exactly the kinds whose `erichOnlyModes` is true. */
export const ERICH_ONLY_ALLOWED: ReadonlySet<BaseScope> = new Set<BaseScope>([MAIN_SCOPE, E2E_SCOPE, ...E2E_SLOT_SCOPES]);
export const mayUseErichOnlyModes = (s: BaseScope) => kindCaps(s).erichOnlyModes;
/** Same, for a full Scope: these modes run on the Vertex fleet, so they are Business only (an Open scope is always refused). */
export const mayUseErichOnlyModesIn = (s: Scope) => spaceOf(s) === "biz" && mayUseErichOnlyModes(baseOf(s));
/** Personal features (profile + project instructions, projects, artifacts, the personal connector, custom MCP) are decided by WHO the caller is
 *  (the base), in either space; the row read or written is always the space's own full Scope. */
export const mayUsePersonalFeatures = (s: Scope) => kindCaps(baseOf(s)).personalFeatures;
/** Custom MCP connectors and the personal connector exist for the main base only (either space; e2e and guests never). */
export const isMainBase = (s: Scope) => baseOf(s) === MAIN_SCOPE;
/** Cost / quota counters (voice, turn caps) are keyed by WHO, never by space: a second space must not double a limit. */
export const quotaKey = (s: Scope): BaseScope => baseOf(s);
/** Open-space Cloudflare tools (src/cf-tools.ts): any Open scope except the e2e tester's (it must never spend real browser/AI quota). Never Business. */
/** The e2e tester's Open space (the only scope the `e2e_real_providers` opt-in can ever apply to). */
export const isE2eOpen = (s: Scope) => s === scopeFor(E2E_SCOPE, "open"); // slot tenants never opt in to real providers (loadE2eRealProviders is slot-0 only)
export const mayUseCfTools = (s: Scope) => spaceOf(s) === "open" && !isE2eBase(baseOf(s));
/** Semantic search sends chat text to Workers AI (Cloudflare): OPEN space only. Business stays Vertex-only (keyword search), PO decision 2026-10-23. */
export const mayUseSemantic = (s: Scope) => spaceOf(s) === "open" && !isE2eBase(baseOf(s));
/** Only Business can ever reach the gateway key / team act-as provider. */
export const spaceUsesGateway = (s: Scope) => spaceOf(s) === "biz";

/** Provider credential: Erich's gateway key is only ever used for main and e2e (e2e chat has always used it). Anything else throws
 *  until a team provider exists. */
export function providerFor<T>(scope: Scope, erich: () => T, guest?: () => T | null): T {
  if (!spaceUsesGateway(scope)) throw new Error("no provider for scope"); // Open: neither Erich's key nor the guest/team provider, before either callback runs
  if (scope === MAIN_SCOPE || isE2eBase(scope)) return erich();
  // A guest only gets a provider when a provider config explicitly allows guests (default: none), never Erich's gateway key.
  const g = guest?.();
  if (g) return g;
  throw new Error("no provider for scope");
}

/** Per-scope turn caps (active_turns). Main keeps 3; every guest scope gets 1, and all guests together at most GUEST_CEILING.
 *  Main's count only includes main rows, so guests can never starve it. */
export const MAIN_TURN_CAP = 3;
export const E2E_TURN_CAP = 3;
export const GUEST_TURN_CAP = 1;
export const GUEST_CEILING = 3;
export const turnCapFor = (s: BaseScope) => (s === MAIN_SCOPE ? MAIN_TURN_CAP : isE2eBase(s) ? E2E_TURN_CAP : GUEST_TURN_CAP);

/** Hono middleware factory: 403 unless the caller's scope may use Erich-only modes. Mounted by each *Routes function on its own prefix
 *  (HTTP, WS upgrades and relays all live under it), so the routes cannot be mounted without it. */
export const erichOnly = (scopeOf: (c: any) => Scope) => async (c: Context, next: Next): Promise<Response | void> => {
  if (!mayUseErichOnlyModesIn(scopeOf(c))) return c.json({ error: "forbidden" }, 403);
  await next();
};
/** Like erichOnly but decided by base, so the same routes serve the Open space of main/e2e (their own rows). Guests stay refused. */
export const personalOnly = (scopeOf: (c: any) => Scope) => async (c: Context, next: Next): Promise<Response | void> => {
  if (!mayUsePersonalFeatures(scopeOf(c))) return c.json({ error: "forbidden" }, 403);
  await next();
};
export const guardPersonal = (app: { use(path: string, ...h: any[]): unknown }, prefix: string, scopeOf: (c: any) => Scope) => {
  app.use(prefix, personalOnly(scopeOf)); app.use(`${prefix}/*`, personalOnly(scopeOf));
};
export const guardPrefix = (app: { use(path: string, ...h: any[]): unknown }, prefix: string, scopeOf: (c: any) => Scope) => {
  app.use(prefix, erichOnly(scopeOf)); app.use(`${prefix}/*`, erichOnly(scopeOf));
};
