// Static guard (node --test e2e/vertex-client/scripts/tests-public.test.mjs): the public CI list only names existing specs, has no duplicates,
// and never names a spec that the OSS export excludes or that is live-only. Keeps the export's CI honest when specs are added/renamed.
import { test } from "node:test"; import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs"; import { dirname, join } from "node:path"; import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const list = readFileSync(join(ROOT, "tests-public.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
test("tests-public.txt: unique, existing specs", () => {
  assert.equal(new Set(list).size, list.length);
  for (const b of list) assert.ok(existsSync(join(ROOT, "tests", `${b}.spec.ts`)), `no such spec ${b}`);
});
test("tests-public.txt: no cloud/live/voice/agent spec", () => {
  for (const b of list) assert.ok(!/^(cloud|device-term-live|voice|agents$|desktop$|desktop-login)/.test(b), `${b} needs a live backend`);
});
