import { test, expect } from "@playwright/test";
import { mockApp } from "./polish-mock";
const offered = (page: import("@playwright/test").Page, slug: string) => page.getByTestId(`open-${slug}`).or(page.getByTestId(`settings-pane-${slug}`)); // phone row or desktop modal nav pane

// Team instance UI (mocked API; no login, no cost). Written, not run by the author (e2e runs on build-host).
// Contract: /auth/config {team:true} shows "Sign in with team gateway" (only then); a team session (/api/me {team:true, erichOnly:false}) does not see Erich-only modes or pages.
test.describe("team instance UI (mocked API)", () => {
  test.use({ serviceWorkers: "block" });
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

  test("login screen: the team button appears only when /auth/config says team, and points at /auth/team", async ({ page }) => {
    await page.route("**/api/me", (r) => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' }));
    await page.route("**/auth/config", (r) => r.fulfill(json({ github: false, sso: false, team: true })));
    await page.goto("/"); await expect(page.getByTestId("sign-in-team")).toHaveAttribute("href", "/auth/team");
    await page.unroute("**/auth/config");
    await page.route("**/auth/config", (r) => r.fulfill(json({ github: true, sso: true })));
    await page.reload(); await expect(page.getByText("Sign in", { exact: true })).toBeVisible(); await expect(page.getByTestId("sign-in-team")).toHaveCount(0);
  });

  test("team session: drawer shows only chat/library (Usage + About live in Settings); Settings hides providers, capabilities, skills, connectors", async ({ page }) => {
    await mockApp(page);
    await page.route("**/api/me", (r) => r.fulfill(json({ user: "ann@example.com", via: "team", csrf: "c", defaultModel: "claude-sonnet-5-5", erichOnly: false, team: true })));
    await page.goto("/settings"); await page.waitForLoadState("networkidle");
    for (const id of ["open-providers", "open-capabilities", "open-skills", "open-connectors"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(offered(page, "prompts")).toBeVisible(); // saved prompts are per-scope now
    await expect(offered(page, "usage"), "Usage stays reachable for a team session via Settings").toBeVisible();
    await expect(page.getByTestId("app-version"), "Version/About stays in Settings").toBeVisible();
    await expect(page.getByTestId("sign-out")).toBeVisible();
    await page.goto("/"); await page.waitForLoadState("networkidle");
    for (const id of ["menu-mode-cloud", "menu-mode-agents", "menu-mode-desktop", "menu-mode-remote", "menu-skills", "menu-projects", "menu-artifacts"]) await expect(page.getByTestId(id)).toHaveCount(0);
  });

  test("Erich's session keeps every mode and settings row (no team flag)", async ({ page }) => {
    await mockApp(page, { erich: true });
    await page.goto("/settings"); await page.waitForLoadState("networkidle");
    for (const slug of ["providers", "capabilities", "skills", "connectors"]) await expect(offered(page, slug), slug).toBeVisible();
  });
});
