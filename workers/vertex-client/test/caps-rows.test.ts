// conv2 (C2): caps read `cap:<class>:<name>` rows from settings. (1) With NO rows (and with the older vcl:/shared rows) every answer equals the pre-conv2
// resolver, table-driven over bases x spaces x flags x identities. (2) Rows only narrow; garbled data never widens. (3) Cross-base isolation; g:* never gets the gateway key.
import { describe, expect, test } from "bun:test";
import { CAP_NAMES, capClassOf, capsOf, devicesOn, type Caps, type Identity } from "../src/caps";
import { baseOf, isGuestScope, kindCapsOf, providerFor, scopeFor, spaceOf, type Scope } from "../src/scope";

type Rows = Record<string, string>;
const fakeDb = (rows: Rows = {}, boom = false) => ({
  prepare: (_q: string) => ({ bind: (name: string) => ({ first: async () => { if (boom) throw new Error("d1 down"); return name in rows ? { value: rows[name] } : null; } }) }),
}) as unknown as D1Database;

// ---- reference: the pre-conv2 resolver, copied verbatim from origin/master 2928f9c (src/caps.ts) ----
async function oldSetting(db: D1Database | undefined, name: string): Promise<string | null> {
  if (!db) return null;
  try { return (await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(name).first<{ value: string }>())?.value ?? null; } catch { return null; }
}
async function oldDevicesOn(db: D1Database | undefined, scope: Scope): Promise<boolean> {
  if (spaceOf(scope) !== "biz") return false;
  const base = baseOf(scope);
  if (!kindCapsOf(scope).devices) return false;
  return (await oldSetting(db, `vcl:${base}`)) === "1";
}
async function oldShared(db: D1Database | undefined, id: Identity): Promise<boolean> {
  const keys = [id.email, id.user].filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim().toLowerCase());
  if (!keys.length) return false;
  const raw = await oldSetting(db, "shared_devices_emails");
  if (!raw) return false;
  const list = new Set(raw.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean));
  return keys.some((k) => list.has(k));
}
async function oldCapsOf(db: D1Database | undefined, scope: Scope, identity: Identity = {}): Promise<Caps> {
  const k = kindCapsOf(scope), biz = spaceOf(scope) === "biz";
  const devices = await oldDevicesOn(db, scope);
  return { erichOnlyModes: biz && k.erichOnlyModes, personalFeatures: k.personalFeatures, devices, devicesMax: devices ? k.devicesMax : 0, sharedDevices: devices && (await oldShared(db, identity)), openSpace: !biz };
}

const G = "g:abcdef0123456789abcdef01", G2 = "g:fedcba9876543210fedcba98";
const BASES = ["main", "e2e", "e2e:1", "e2e:2", "e2e:3", G, G2, "g:short", "o:fleet", "o:acme1", "nobody", ""];
const SPACES = ["biz", "open"] as const;
const scopeOf = (b: string, sp: "biz" | "open"): Scope => (sp === "open" ? `${b}~open` : b) as unknown as Scope;
const IDS: Identity[] = [{}, { email: "a@x.com" }, { user: "u1" }, { email: "A@X.com", user: "zz" }, { email: "b@x.com" }];

// every combination of the OLD rows a deployment can have today
function oldRowSets(b: string): Rows[] {
  const out: Rows[] = [{}];
  for (const flag of [undefined, "0", "1", "true", " 1"]) for (const sh of [undefined, "", "a@x.com", "u1, B@x.com"]) {
    const r: Rows = {};
    if (flag !== undefined) r[`vcl:${b}`] = flag;
    if (sh !== undefined) r["shared_devices_emails"] = sh;
    out.push(r);
  }
  // a flag for ANOTHER base must change nothing for this one
  out.push({ "vcl:main": "1", "vcl:e2e": "1", [`vcl:${G}`]: "1", [`vcl:${G2}`]: "1" });
  return out;
}

describe("defaults EXACTLY equal the pre-conv2 behaviour (table-driven, all bases x spaces x old rows x identities)", () => {
  let cells = 0;
  for (const b of BASES) for (const sp of SPACES) {
    test(`${b || "<empty>"} ${sp}`, async () => {
      const sc = scopeOf(b, sp);
      for (const rows of oldRowSets(b)) for (const id of IDS) {
        const a = await capsOf(fakeDb(rows), sc, id), o = await oldCapsOf(fakeDb(rows), sc, id);
        expect(a).toEqual(o); cells++;
        expect(await devicesOn(fakeDb(rows), sc)).toBe(await oldDevicesOn(fakeDb(rows), sc));
      }
      // D1 down / no DB
      expect(await capsOf(fakeDb({}, true), sc)).toEqual(await oldCapsOf(fakeDb({}, true), sc));
      expect(await capsOf(undefined, sc)).toEqual(await oldCapsOf(undefined, sc));
    });
  }
  test("coverage count (sanity: the table is not empty)", () => { expect(cells).toBeGreaterThan(1000); });
});

describe("cap rows only narrow; bad data never widens", () => {
  const on = (b: string, extra: Rows = {}): Rows => ({ [`vcl:${b}`]: "1", ...extra });
  test("exact '0' turns a capability off, for its class only", async () => {
    const m = await capsOf(fakeDb(on("main", { "cap:m:erichOnlyModes": "0", "cap:m:personalFeatures": "0", "cap:m:devices": "0" })), "main" as Scope);
    expect(m).toMatchObject({ erichOnlyModes: false, personalFeatures: false, devices: false, devicesMax: 0 });
    // the m row does not touch g or o
    const g = await capsOf(fakeDb(on(G, { "cap:m:devices": "0", "cap:m:erichOnlyModes": "0" })), G as unknown as Scope);
    expect(g).toMatchObject({ devices: true, devicesMax: 1 });
    // e2e shares class m with main
    expect((await capsOf(fakeDb(on("e2e:2", { "cap:m:devices": "0" })), "e2e:2" as Scope)).devices).toBe(false);
  });
  test("devicesMax: canonical digits <= ceiling lower it; bigger/garbled = default", async () => {
    const mx = async (v: string) => (await capsOf(fakeDb(on("main", { "cap:m:devicesMax": v })), "main" as Scope)).devicesMax;
    expect(await mx("3")).toBe(3); expect(await mx("0")).toBe(0); expect(await mx("10")).toBe(10);
    for (const bad of ["11", "9999", "-1", "1.5", "03", "ten", "", " 3", "1e1", "99999"]) expect(await mx(bad)).toBe(10);
    const g = async (v: string) => (await capsOf(fakeDb(on(G, { "cap:g:devicesMax": v })), G as unknown as Scope)).devicesMax;
    expect(await g("5")).toBe(1); expect(await g("0")).toBe(0);
  });
  test("no row value other than exactly '0' changes a boolean; and a '1' row never grants", async () => {
    for (const v of ["1", "true", "", " 0", "00", "false", "yes", "null", "{}", "0 "]) {
      for (const name of ["erichOnlyModes", "personalFeatures", "devices", "sharedDevices", "openSpace"] as const) {
        for (const [b, sp] of [["main", "biz"], [G, "biz"], [G, "open"], ["o:fleet", "biz"], ["o:fleet", "open"], ["main", "open"]] as const) {
          const rows = { [`vcl:${b}`]: "1", shared_devices_emails: "a@x.com", [`cap:${capClassOf(b)}:${name}`]: v };
          expect(await capsOf(fakeDb(rows), scopeOf(b, sp), { email: "a@x.com" })).toEqual(await oldCapsOf(fakeDb(rows), scopeOf(b, sp), { email: "a@x.com" }));
        }
      }
    }
  });
  test("a '1' row cannot make g:* an Erich-only/personal scope, nor enable devices without vcl:<base>", async () => {
    const rows = { "cap:g:erichOnlyModes": "1", "cap:g:personalFeatures": "1", "cap:g:devices": "1", "cap:g:devicesMax": "10", "cap:g:sharedDevices": "1", "cap:o:devices": "1", "cap:o:erichOnlyModes": "1" };
    for (const sc of [G, "o:fleet"]) {
      const c = await capsOf(fakeDb(rows), sc as unknown as Scope, { email: "a@x.com" });
      expect(c).toMatchObject({ erichOnlyModes: false, personalFeatures: false, devices: false, devicesMax: 0, sharedDevices: false });
    }
  });
  test("D1 error on the cap rows: defaults, never wider", async () => {
    for (const b of BASES) expect(await capsOf(fakeDb({}, true), b as unknown as Scope)).toEqual(await oldCapsOf(fakeDb({}, true), b as unknown as Scope));
  });
  test("unknown / malformed bases have no class and get nothing", async () => {
    for (const b of ["nobody", "", "g:short", "o:", "o:UPPER", "o:a b", "main~open", "x:fleet"]) expect(capClassOf(b)).toBeNull();
    expect(capClassOf("main")).toBe("m"); expect(capClassOf("e2e:3")).toBe("m"); expect(capClassOf(G)).toBe("g"); expect(capClassOf("o:fleet")).toBe("o");
    const c = await capsOf(fakeDb({ "vcl:nobody": "1" }), "nobody" as Scope);
    expect(c).toMatchObject({ erichOnlyModes: false, personalFeatures: false, devices: false, devicesMax: 0 });
  });
  test("per-request cache: one DB read per name, and no cache = no sharing across calls", async () => {
    let reads = 0;
    const db = { prepare: () => ({ bind: (n: string) => ({ first: async () => { reads++; return n === "vcl:main" ? { value: "1" } : null; } }) }) } as unknown as D1Database;
    const cache = new Map<string, string | null>();
    await capsOf(db, "main" as Scope, { email: "a@x.com" }, cache); const first = reads;
    await capsOf(db, "main" as Scope, { email: "a@x.com" }, cache);
    expect(reads).toBe(first); // second call fully served from the memo
    await capsOf(db, "main" as Scope);
    expect(reads).toBeGreaterThan(first); // a fresh call re-reads (a change in settings is seen by the next request)
  });
  test("CAP_NAMES lists exactly the Caps keys", async () => {
    expect([...CAP_NAMES].map(String).sort()).toEqual(Object.keys(await capsOf(fakeDb(), "main" as Scope)).sort());
  });
});

describe("cross-base isolation matrix (main user, team g:*, e2e, representative o:*)", () => {
  const ALL_ROWS: Rows = {};
  for (const cls of ["m", "g", "o"]) for (const n of CAP_NAMES) { ALL_ROWS[`cap:${cls}:${n}`] = "1"; }
  ALL_ROWS["cap:g:devicesMax"] = "10"; ALL_ROWS["cap:o:devicesMax"] = "10"; ALL_ROWS["cap:m:devicesMax"] = "10";
  const ENABLED: Rows = { ...ALL_ROWS, "vcl:main": "1", "vcl:e2e": "1", [`vcl:${G}`]: "1", "vcl:o:fleet": "1", shared_devices_emails: "a@x.com" };
  test("a flag/row of one class never changes another class's answer", async () => {
    const base = { main: await capsOf(fakeDb(), "main" as Scope), e2e: await capsOf(fakeDb(), "e2e" as Scope), g: await capsOf(fakeDb(), G as unknown as Scope), o: await capsOf(fakeDb(), "o:fleet" as unknown as Scope) };
    for (const cls of ["m", "g", "o"] as const) {
      const rows: Rows = {}; for (const n of CAP_NAMES) rows[`cap:${cls}:${n}`] = "0";
      const got = { main: await capsOf(fakeDb(rows), "main" as Scope), e2e: await capsOf(fakeDb(rows), "e2e" as Scope), g: await capsOf(fakeDb(rows), G as unknown as Scope), o: await capsOf(fakeDb(rows), "o:fleet" as unknown as Scope) };
      const classOf = { main: "m", e2e: "m", g: "g", o: "o" } as const;
      for (const k of ["main", "e2e", "g", "o"] as const) if (classOf[k] !== cls) expect(got[k]).toEqual(base[k]);
    }
  });
  test("one team user's flag/row does not enable another team user, main, or an org", async () => {
    const rows = { [`vcl:${G}`]: "1" };
    expect((await capsOf(fakeDb(rows), G2 as unknown as Scope)).devices).toBe(false);
    expect((await capsOf(fakeDb(rows), "main" as Scope)).devices).toBe(false);
    expect((await capsOf(fakeDb(rows), "o:fleet" as unknown as Scope)).devices).toBe(false);
  });
  test("with every cap row maximal ('1'/'10') the g:* and o:* scopes stay chat-only and one device", async () => {
    const g = await capsOf(fakeDb(ENABLED), G as unknown as Scope, { email: "a@x.com" });
    expect(g).toMatchObject({ erichOnlyModes: false, personalFeatures: false, devicesMax: 1, openSpace: false });
    expect(await capsOf(fakeDb(ENABLED), scopeFor(G as never, "open"), { email: "a@x.com" })).toMatchObject({ devices: false, erichOnlyModes: false, openSpace: true });
    const o = await capsOf(fakeDb(ENABLED), "o:fleet" as unknown as Scope, { email: "a@x.com" });
    expect(o).toMatchObject({ erichOnlyModes: false, personalFeatures: false, devices: false, devicesMax: 0, sharedDevices: false });
  });
  test("INVARIANT: no cap/settings row can make a g:* scope (Business or Open) use the gateway key", () => {
    // providerFor is pure: it takes no settings at all, so no row can reach it; prove the erich() callback is never invoked for g:* / o:* / junk.
    for (const sc of [G, `${G}~open`, G2, "o:fleet", "o:fleet~open", "nobody", "g:short"]) {
      let used = false;
      expect(() => providerFor(sc as unknown as Scope, () => { used = true; return "KEY"; })).toThrow();
      expect(used).toBe(false);
    }
    // the guest callback is the only way in, and it is not the gateway key
    expect(providerFor(G as unknown as Scope, () => "KEY", () => "TEAM")).toBe("TEAM");
    expect(providerFor("main" as Scope, () => "KEY")).toBe("KEY"); expect(providerFor("e2e:1" as Scope, () => "KEY")).toBe("KEY");
    expect(isGuestScope(G as never)).toBe(true);
  });
});
