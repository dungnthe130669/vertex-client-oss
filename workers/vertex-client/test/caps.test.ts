// wscaps1 C1: capsOf / kindCaps pin TODAY's behaviour per base kind (main, e2e, e2e:N, g:<uid>), each in Business and Open, and the old
// hard-coded checks (mayUseErichOnlyModes, vclEnabled, per-user device limit) agree with the resolver. C3: shared_devices_emails allow-list.
import { describe, expect, test } from "bun:test";
import { capsOf, devicesOn, sharedDevicesAllowed } from "../src/caps";
import { ERICH_ONLY_ALLOWED, baseOf, kindCaps, mayUseErichOnlyModes, mayUseErichOnlyModesIn, mayUsePersonalFeatures, parseBase, parseScope, scopeFor, type BaseScope, type Scope } from "../src/scope";
import { vclEnabled } from "../src/devices";
import { MAX_DEVICES } from "../src/device-core";

const fakeDb = (rows: Record<string, string> = {}, boom = false) => ({
  prepare: (_q: string) => ({ bind: (name: string) => ({ first: async () => { if (boom) throw new Error("d1 down"); return name in rows ? { value: rows[name] } : null; } }) }),
}) as unknown as D1Database;
const G = "g:abcdef0123456789abcdef01";
const BASES = ["main", "e2e", "e2e:1", "e2e:2", "e2e:3", G];
const base = (b: string) => parseBase(b)!;
const sc = (b: string, sp: "biz" | "open") => scopeFor(base(b), sp);

describe("kind matrix (today's answers, flags absent)", () => {
  const expected: Record<string, { erich: boolean; personal: boolean; kindDevices: boolean; max: number }> = {
    main: { erich: true, personal: true, kindDevices: true, max: 10 },
    e2e: { erich: true, personal: true, kindDevices: true, max: 10 },
    "e2e:1": { erich: true, personal: true, kindDevices: true, max: 10 },
    "e2e:2": { erich: true, personal: true, kindDevices: true, max: 10 },
    "e2e:3": { erich: true, personal: true, kindDevices: true, max: 10 },
    [G]: { erich: false, personal: false, kindDevices: true, max: 1 },
  };
  for (const b of BASES) {
    test(`${b}: kindCaps + legacy predicates agree`, () => {
      const x = expected[b], k = kindCaps(base(b));
      expect(k).toEqual({ erichOnlyModes: x.erich, personalFeatures: x.personal, devices: x.kindDevices, devicesMax: x.max });
      expect(mayUseErichOnlyModes(base(b))).toBe(x.erich);
      expect(ERICH_ONLY_ALLOWED.has(base(b))).toBe(x.erich);
      expect(mayUseErichOnlyModesIn(sc(b, "biz"))).toBe(x.erich);
      expect(mayUseErichOnlyModesIn(sc(b, "open"))).toBe(false); // Open is never an Erich-only space
      expect(mayUsePersonalFeatures(sc(b, "biz"))).toBe(x.personal);
      expect(mayUsePersonalFeatures(sc(b, "open"))).toBe(x.personal);
    });
    test(`${b}: capsOf with no rows = no devices, with the flag = kind answer; Open never`, async () => {
      const x = expected[b];
      const off = await capsOf(fakeDb(), sc(b, "biz"));
      expect(off).toEqual({ erichOnlyModes: x.erich, personalFeatures: x.personal, devices: false, devicesMax: 0, sharedDevices: false, openSpace: false });
      const on = await capsOf(fakeDb({ [`vcl:${b}`]: "1" }), sc(b, "biz"));
      expect(on.devices).toBe(x.kindDevices); expect(on.devicesMax).toBe(x.max);
      const open = await capsOf(fakeDb({ [`vcl:${b}`]: "1" }), sc(b, "open"));
      expect(open).toMatchObject({ erichOnlyModes: false, devices: false, devicesMax: 0, sharedDevices: false, openSpace: true });
      expect(await vclEnabled(fakeDb({ [`vcl:${b}`]: "1" }), sc(b, "biz"))).toBe(x.kindDevices);
      expect(await vclEnabled(fakeDb({ [`vcl:${b}`]: "1" }), sc(b, "open"))).toBe(false);
    });
  }
  test("the flag must be exactly '1'; a D1 error or missing DB is OFF", async () => {
    for (const v of ["0", "true", "", " 1", "01"]) expect(await devicesOn(fakeDb({ "vcl:main": v }), "main")).toBe(false);
    expect(await devicesOn(fakeDb({ "vcl:main": "1" }, true), "main")).toBe(false);
    expect(await devicesOn(undefined, "main")).toBe(false);
  });
  test("a flag on one base never enables another", async () => {
    const db = fakeDb({ [`vcl:${G}`]: "1" });
    expect(await devicesOn(db, "main")).toBe(false); expect(await devicesOn(db, G as unknown as Scope)).toBe(true);
    expect(await devicesOn(db, "g:zzzzzzzzzzzzzzzzzzzzzzzz" as unknown as Scope)).toBe(false);
  });
  test("device limits: main/e2e keep MAX_DEVICES, a team scope gets exactly one", () => {
    expect(kindCaps("main").devicesMax).toBe(MAX_DEVICES); expect(kindCaps(base(G)).devicesMax).toBe(1);
  });
  test("an unparseable base gets nothing", () => {
    expect(parseScope("g:short")).toBeNull(); expect(parseBase("main~open")).toBeNull();
    expect(kindCaps("nobody" as unknown as BaseScope).devices).toBe(false);
  });
  test("baseOf round trip", () => { expect(baseOf(sc(G, "open"))).toBe(base(G)); });
});

describe("C3 shared_devices_emails", () => {
  const id = { email: "Dung.Nguyentien@Example.com" };
  test("default (absent / empty) = nobody", async () => {
    expect(await sharedDevicesAllowed(fakeDb(), id)).toBe(false);
    expect(await sharedDevicesAllowed(fakeDb({ shared_devices_emails: "" }), id)).toBe(false);
    expect(await sharedDevicesAllowed(fakeDb({ shared_devices_emails: " , ," }), id)).toBe(false);
  });
  test("listed identity (case-insensitive, trimmed) is allowed; others are not; no identity is not", async () => {
    const db = fakeDb({ shared_devices_emails: "a@x.com , dung.nguyentien@example.com" });
    expect(await sharedDevicesAllowed(db, id)).toBe(true);
    expect(await sharedDevicesAllowed(db, { email: "b@x.com" })).toBe(false);
    expect(await sharedDevicesAllowed(db, {})).toBe(false);
    expect(await sharedDevicesAllowed(db, { email: "  " })).toBe(false);
    expect(await sharedDevicesAllowed(fakeDb({ shared_devices_emails: "a@x.com" }, true), { email: "a@x.com" })).toBe(false);
  });
  test("capsOf: sharedDevices needs the account on the list AND devices on", async () => {
    const rows = { shared_devices_emails: "a@x.com", [`vcl:${G}`]: "1" };
    expect((await capsOf(fakeDb(rows), G as unknown as Scope, { email: "a@x.com" })).sharedDevices).toBe(true);
    expect((await capsOf(fakeDb(rows), G as unknown as Scope, { email: "b@x.com" })).sharedDevices).toBe(false);
    expect((await capsOf(fakeDb({ shared_devices_emails: "a@x.com" }), G as unknown as Scope, { email: "a@x.com" })).sharedDevices).toBe(false);
  });
});
