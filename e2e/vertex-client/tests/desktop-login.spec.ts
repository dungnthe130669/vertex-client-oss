import { createHash, randomBytes } from "node:crypto";
import { chromium, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { test, expect, BOT, login } from "./fixtures";

// Desktop app sign-in through the system browser, server side (docs/vertex-client-desktop-app.md section 9; src/auth-app.ts).
// The e2e-bot session stands in for the SSO leg. A headless browser will not open vertexclient://, so the link is read from the DOM; the app's
// side (verifier, deep link, the WebView) is played by this file. Skipped, visibly, while the feature flag `desktop_login:main` is off or the code
// is not deployed (the routes then answer 404): nothing here may fail a nightly before the flag is switched on.
const b64u = (b: Buffer) => b.toString("base64url");
const newVerifier = () => b64u(randomBytes(32));
const challengeOf = (v: string) => b64u(createHash("sha256").update(v).digest());
const newState = () => b64u(randomBytes(16));

async function flagOn(page: Page): Promise<boolean> { return (await page.request.get("/auth/app/start")).status() !== 404; }   // flag on: 400 (bad link); off / not deployed: 404. (/complete now answers 403 to a non-navigation request)

/** start -> consent -> Allow in the signed-in page; returns what the app would receive on the deep link. The link is read, never followed. */
async function approveInPage(page: Page, verifier: string, st = newState()) {
  await page.goto(`/auth/app/start?c=${challengeOf(verifier)}&st=${st}`);
  await expect(page.getByRole("heading", { name: "Sign in the Vertex Client app?" })).toBeVisible();
  await expect(page.getByText(BOT, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  const link = page.getByRole("link", { name: "Open Vertex Client" });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href"))!;
  const u = new URL(href);
  expect(u.protocol).toBe("vertexclient:"); expect(u.host + u.pathname).toBe("auth/callback");
  expect(u.searchParams.get("st")).toBe(st);
  return { code: u.searchParams.get("code")!, st };
}

async function freshContext(browser: Browser, baseURL: string): Promise<BrowserContext> { return browser.newContext({ baseURL }); }
const exchange = (req: APIRequestContext, baseURL: string, body: unknown, origin: string | null = baseURL) =>
  req.post("/auth/app/exchange", { data: body, headers: { ...(origin ? { origin } : {}), "content-type": "application/json" } });
const UNIFORM = { error: "invalid or expired code" };

test.describe("desktop sign-in handoff (server side)", () => {
  test.beforeEach(async ({ app: { page } }) => { test.skip(!(await flagOn(page)), "desktop_login:main is off (or not deployed): /auth/app/* answers 404"); });

  test("start -> consent -> approve -> the app's WebView exchanges the fragment and lands signed in as e2e-bot with a working csrf", async ({ app: { page }, browser, baseURL }) => {
    const verifier = newVerifier();
    const { code } = await approveInPage(page, verifier);
    const ctx = await freshContext(browser, baseURL!);
    try {
      const wv = await ctx.newPage();
      expect((await wv.request.get("/api/me")).status()).toBe(401);   // truly fresh: no session before the handoff
      await wv.goto(`/auth/app/complete#code=${code}&v=${verifier}`);   // page.goto = a top-level load with Sec-Fetch-Site: none, the way the app opens the URL (NOT a link click from some page)
      await wv.waitForURL((u) => u.pathname === "/");                 // the page exchanged, got the cookie and navigated home
      expect(wv.url()).not.toContain(code); expect(wv.url()).not.toContain(verifier);
      const me = await wv.request.get("/api/me");
      expect(me.status()).toBe(200);
      const j = await me.json();
      expect(j.user).toBe(BOT); expect(j.via).toBe("e2e"); expect(j.csrf).toMatch(/^[0-9a-f]{32}$/);
      const cookie = (await ctx.cookies()).find((c) => c.name === "__Host-vc_session");
      expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
      // the minted csrf really authorises a write (create + delete a throwaway chat in the e2e scope)
      const mk = await wv.request.post("/api/conversations", { data: { model: "claude-haiku-5-5" }, headers: { origin: baseURL!, "x-csrf-token": j.csrf } });
      expect(mk.status()).toBe(201);
      const id = (await mk.json()).id as string;
      expect((await wv.request.delete(`/api/conversations/${id}`, { headers: { origin: baseURL!, "x-csrf-token": j.csrf } })).status()).toBe(200);
    } finally { await ctx.close(); }
  });

  test("the code is single use: a second exchange (same verifier) is the uniform 400 and sets no cookie", async ({ app: { page }, browser, baseURL }) => {
    const verifier = newVerifier();
    const { code } = await approveInPage(page, verifier);
    const ctx = await freshContext(browser, baseURL!);
    try {
      const first = await exchange(ctx.request, baseURL!, { code, verifier });
      expect(first.status()).toBe(200);
      const again = await exchange((await freshContext(browser, baseURL!)).request, baseURL!, { code, verifier });
      expect(again.status()).toBe(400); expect(await again.json()).toEqual(UNIFORM); expect(again.headers()["set-cookie"]).toBeUndefined();
    } finally { await ctx.close(); }
  });

  test("a wrong verifier is the uniform 400 AND burns the code (the right verifier afterwards is 400 too)", async ({ app: { page }, browser, baseURL }) => {
    const verifier = newVerifier();
    const { code } = await approveInPage(page, verifier);
    const ctx = await freshContext(browser, baseURL!);
    try {
      const wrong = await exchange(ctx.request, baseURL!, { code, verifier: newVerifier() });
      expect(wrong.status()).toBe(400); expect(await wrong.json()).toEqual(UNIFORM); expect(wrong.headers()["set-cookie"]).toBeUndefined();
      const right = await exchange(ctx.request, baseURL!, { code, verifier });
      expect(right.status()).toBe(400); expect(await right.json()).toEqual(UNIFORM);
      expect((await ctx.request.get("/api/me")).status()).toBe(401);
    } finally { await ctx.close(); }
  });

  test("expired: a code past its 60 s life is the uniform 400 (waits on the SERVER clock, read from the Date header, not on a sleep) @desktop-only", async ({ app: { page }, browser, baseURL }) => {
    test.setTimeout(140_000);
    const verifier = newVerifier();
    const { code } = await approveInPage(page, verifier);
    const approvedAt = Date.parse((await page.request.get("/api/version")).headers()["date"]);
    const ctx = await freshContext(browser, baseURL!);
    try {
      await expect.poll(async () => Date.parse((await ctx.request.get("/api/version")).headers()["date"]) - approvedAt, { timeout: 110_000, intervals: [2_000] }).toBeGreaterThanOrEqual(62_000);
      const r = await exchange(ctx.request, baseURL!, { code, verifier });
      expect(r.status()).toBe(400); expect(await r.json()).toEqual(UNIFORM);
      expect((await ctx.request.get("/api/me")).status()).toBe(401);
    } finally { await ctx.close(); }
  });

  // Login CSRF: a foreign page navigating a signed-in victim to /auth/app/complete#<attacker's code+verifier> must not replace the victim's session (the page auto-exchanges its fragment).
  // The attacker pages are served by route interception on foreign origins (nothing real is contacted); the victim is a separate, already signed-in context.
  const attackOrigins = (baseURL: string) => {
    const u = new URL(baseURL);
    const labels = u.hostname.split(".");
    const sameSiteHost = labels.length >= 3 ? `evil.${labels.slice(1).join(".")}` : u.hostname;                 // sibling subdomain in prod; on localhost another origin of the same site (scheme+host, other port)
    const sameSite = `${u.protocol}//${sameSiteHost}:${labels.length >= 3 ? (u.port || "443") : "8798"}`;
    return { "cross-site": "https://attacker.example", "same-site": sameSite };
  };
  for (const kind of ["cross-site", "same-site"] as const) for (const how of ["link click", "script navigation", "meta refresh"] as const) {
    test(`a ${kind} page that sends the victim to /auth/app/complete#<attacker credentials> (${how}) does not change the victim's session`, async ({ app: { page: attackerApproves }, browser, baseURL }) => {
      const evil = attackOrigins(baseURL!)[kind];
      const verifier = newVerifier();
      const { code } = await approveInPage(attackerApproves, verifier);          // the attacker's own approved code
      const victim = await freshContext(browser, baseURL!);
      try {
        await login(victim, baseURL!);
        const before = (await victim.cookies()).find((c) => c.name === "__Host-vc_session")!.value;
        const target = `${baseURL}/auth/app/complete#code=${code}&v=${verifier}`;
        // (WebKit's route.fulfill cannot answer a 3xx, so the "redirect" case is a meta refresh)
        const body = how === "link click" ? `<a id="go" href="${target}">go</a>` : how === "script navigation" ? `<script>location.href=${JSON.stringify(target)}</script>` : `<meta http-equiv="refresh" content="0;url=${target}">`;
        await victim.route(`${evil}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body }));
        const p = await victim.newPage();
        await p.goto(`${evil}/`);
        if (how === "link click") await p.locator("#go").click();
        await p.waitForURL((u) => u.href.startsWith(baseURL! + "/auth/app/complete"));
        await expect(p.locator("body")).toContainText("untrusted navigation");   // refused with 403, no page, no script ran
        expect((await victim.cookies()).find((c) => c.name === "__Host-vc_session")!.value).toBe(before);
        // and the attacker's code is still unspent: the refusal touched nothing
        const spare = await freshContext(browser, baseURL!);
        try { expect((await exchange(spare.request, baseURL!, { code, verifier })).status()).toBe(200); } finally { await spare.close(); }
      } finally { await victim.close(); }
    });
  }

  // Speculative loading (Chromium only; WebKit has no Speculation Rules, hence @desktop-only): a foreign same-site page prefetches / prerenders the completion URL (arrives as Sec-Fetch-Site: none +
  // Sec-Purpose: prefetch[;prerender]) and later navigates there. The victim's session must not change and the attacker's code must stay unspent.
  // Needs a REAL second origin (route interception disables speculation), so it runs only against the local stand-in (workers/vertex-client/scripts/dev-desktop-login-server.ts), which serves
  // the attacker page on port+1 and counts the speculative requests it received. Set E2E_ATTACKER_ORIGIN=https://localhost:<port+1>; unset (the live app) => skipped, visibly.
  for (const kind of ["prefetch", "prerender"] as const) {
    test(`a foreign same-site page that ${kind}s /auth/app/complete#<attacker credentials> then navigates there does not change the victim's session @desktop-only`, async ({ app: { page: attackerApproves }, baseURL }) => {
      const evil = process.env.E2E_ATTACKER_ORIGIN;
      test.skip(!evil, "E2E_ATTACKER_ORIGIN not set: needs the local stand-in's attacker origin (speculation rules need a real second origin)");
      const verifier = newVerifier();
      const { code } = await approveInPage(attackerApproves, verifier);
      // its own browser in Chromium's NEW headless mode: the default headless shell does not run Speculation Rules at all (a describe-level `channel` would force a new worker)
      const browser = await chromium.launch({ channel: "chromium" });
      const victim = await browser.newContext({ baseURL: baseURL!, ignoreHTTPSErrors: true });   // ignoreHTTPSErrors: only ever reached against the local stand-in's self-signed cert
      try {
        await login(victim, baseURL!);
        const before = (await victim.cookies()).find((c) => c.name === "__Host-vc_session")!.value;
        const target = `${baseURL}/auth/app/complete#code=${code}&v=${verifier}`;
        const spec = `${evil}/spec?kind=${kind}&target=${encodeURIComponent(target)}`;
        const stats = async () => ((await (await victim.request.get(`${evil}/stats`)).json()) as { speculative: number }).speculative;
        const seenBefore = await stats();
        const p = await victim.newPage();
        await p.goto(spec);
        // measured condition, not a sleep: the stand-in has actually received (and refused) the speculative request before we navigate
        await expect.poll(stats, { timeout: 20_000, message: `${kind} request never reached the server` }).toBeGreaterThan(seenBefore);
        await p.locator("#go").click();
        await p.waitForURL((u) => u.href.startsWith(baseURL! + "/auth/app/complete"));
        await expect(p.locator("body")).toContainText("untrusted navigation");
        expect((await victim.cookies()).find((c) => c.name === "__Host-vc_session")!.value).toBe(before);
        const spare = await freshContext(browser, baseURL!);
        try { expect((await exchange(spare.request, baseURL!, { code, verifier })).status()).toBe(200); } finally { await spare.close(); }
      } finally { await victim.close(); await browser.close(); }
    });
  }

  test("a complete link with no fragment shows the message, sends no exchange, and leaves the browser signed out", async ({ browser, baseURL }) => {
    const ctx = await freshContext(browser, baseURL!);
    try {
      const wv = await ctx.newPage();
      let exchanged = false;
      wv.on("request", (r) => { if (r.url().includes("/auth/app/exchange")) exchanged = true; });
      await wv.goto("/auth/app/complete");
      await expect(wv.locator("#msg")).toContainText("incomplete");
      expect(exchanged).toBe(false);
      expect((await wv.request.get("/api/me")).status()).toBe(401);
    } finally { await ctx.close(); }
  });

  test("exchange needs a same-origin Origin: none or a foreign one is refused (403) and does not spend the code", async ({ app: { page }, browser, baseURL }) => {
    const verifier = newVerifier();
    const { code } = await approveInPage(page, verifier);
    const ctx = await freshContext(browser, baseURL!);
    try {
      expect((await exchange(ctx.request, baseURL!, { code, verifier }, null)).status()).toBe(403);
      expect((await exchange(ctx.request, baseURL!, { code, verifier }, "https://evil.example")).status()).toBe(403);
      expect((await exchange(ctx.request, baseURL!, { code, verifier })).status()).toBe(200);
    } finally { await ctx.close(); }
  });

  test("approve from another origin, or without the csrf field, is refused (403) and mints nothing", async ({ app: { page }, baseURL }) => {
    await page.goto(`/auth/app/start?c=${challengeOf(newVerifier())}&st=${newState()}`);
    const csrf = await page.locator('input[name="csrf"]').getAttribute("value");
    const verifier = newVerifier(), c = challengeOf(verifier), st = newState();
    const post = (form: Record<string, string>, origin: string | null) => page.request.post("/auth/app/approve", { form, headers: origin ? { origin } : {} });
    expect((await post({ c, st, csrf: csrf! }, "https://evil.example")).status()).toBe(403);
    expect((await post({ c, st, csrf: csrf! }, null)).status()).toBe(403);
    expect((await post({ c, st }, baseURL!)).status()).toBe(403);
    expect((await post({ c, st, csrf: "0".repeat(32) }, baseURL!)).status()).toBe(403);
    // none of those minted anything: a correct approve still works, and it is the ONLY code that exists (spend it so no unused code outlives the test)
    const ok = await post({ c, st, csrf: csrf! }, baseURL!);
    expect(ok.status()).toBe(200);
    const code = /code=([A-Za-z0-9_-]{43})/.exec(await ok.text())![1];
    expect((await exchange(page.request, baseURL!, { code, verifier })).status()).toBe(200);
  });

  test("approve with no session at all is 401", async ({ browser, baseURL }) => {
    const ctx = await freshContext(browser, baseURL!);
    try {
      const r = await ctx.request.post("/auth/app/approve", { form: { c: challengeOf(newVerifier()), st: newState(), csrf: "0".repeat(32) }, headers: { origin: baseURL! } });
      expect(r.status()).toBe(401);
    } finally { await ctx.close(); }
  });

  test("bad challenge / state on start is a 400 page, no consent form", async ({ app: { page } }) => {
    const r = await page.request.get("/auth/app/start?c=short&st=short");
    expect(r.status()).toBe(400); expect(await r.text()).not.toContain("/auth/app/approve");
  });
});
