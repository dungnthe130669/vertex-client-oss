import { describe, expect, test } from "bun:test";
// Load providers/config FIRST: providers/cloudflare <-> providers/config is an import cycle that only resolves when config is the entry point
// (loading cloudflare first throws "Cannot access CLOUDFLARE_MODELS before initialization" under bun; the app always enters via config/registry).
import "../src/providers/config";
import { MODEL_ID_RE, isModelIdSyntax } from "../src/model-id";
import { CLOUDFLARE_MODELS } from "../src/providers/cloudflare";
import { NVIDIA_VERIFIED } from "../src/providers/presets";

// Regression: Erich's first Open chats on Cloudflare/NVIDIA models all failed with "bad model id" because five call sites each had their own
// plain-id regex that rejected `:`, `/` and `@`. Every id a real catalog can hand the picker must pass the one shared syntax check.
describe("model id syntax", () => {
  test("every Cloudflare catalog id, prefixed the way the picker sends it, is accepted", () => {
    for (const m of CLOUDFLARE_MODELS) expect(isModelIdSyntax(`cloudflare:${m.id}`)).toBe(true);
  });
  test("every verified NVIDIA id, prefixed, is accepted", () => {
    for (const id of NVIDIA_VERIFIED) expect(isModelIdSyntax(`nvidia:${id}`)).toBe(true);
  });
  test("plain Vertex ids still pass", () => {
    for (const id of ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "auto"]) expect(isModelIdSyntax(id)).toBe(true);
  });
  test("junk is still rejected", () => {
    for (const v of ["", " ", "a b", "x\ny", "<script>", "a;b", "a`b", "a$b", "a\"b", "a".repeat(161), 5, null, undefined, {}]) expect(isModelIdSyntax(v)).toBe(false);
    expect(MODEL_ID_RE.test("claude-sonnet-5-5")).toBe(true);
  });
});
