import { expect, test } from "bun:test";

// bun runs every test file in one process (alphabetical): this one runs after drawer-ui.test.tsx and proves it left nothing behind.
test("drawer-ui.test.tsx leaves no DOM, fake Date or helper global behind", () => {
  const g = globalThis as Record<string, unknown>;
  expect(typeof g.document).toBe("undefined");
  expect(typeof g.window === "undefined" || g.window === globalThis).toBe(true);
  expect("__RealDate" in g).toBe(false);
  expect(typeof g.localStorage).toBe("undefined");
  expect(Date.name).toBe("Date");
  expect(new Date(2026, 0, 1).getFullYear()).toBe(2026);
  expect(Function.prototype.toString.call(Date)).toContain("[native code]"); // the real Date, not the test's FrozenDate subclass
  expect(typeof g.matchMedia).toBe("undefined");
});
