import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// andfix1 guard (the real layout check is e2e/vertex-client/tests/login-layout.spec.ts): the login step buttons are inline-block `.btn`s in a shrink-wrapped form,
// so they hug the left edge unless the login forms make them block + full width.
const css = readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
describe("login form layout", () => {
  test("login-step .btn is block and full width", () => {
    const rule = css.split("\n").find((l) => /\[data-testid\^="login-"\]\s*\.btn\s*\{[^}]*display:\s*block/.test(l)) ?? "";
    expect(rule).toMatch(/width:\s*100%/);
  });
});
