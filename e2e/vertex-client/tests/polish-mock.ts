// In-browser mock of the app's API so every screen can be rendered/audited without a backend or a login (used by polish/audit.ts and tests/a11y.spec.ts).
// Data is plainly synthetic. Anything not listed answers 404 {error} so unmocked screens show their real error state.
import type { Page, Route } from "@playwright/test";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = Date.now();
const iso = (ago = 0) => new Date(now - ago).toISOString();
export const IDS = { chat: ID(1), project: ID(50), artifact: ID(70), artifactHtml: ID(71) };

const conv = (i: number, title: string, extra: object = {}) => ({ id: ID(i), title, model: "claude-sonnet-5-5", pinned: 0, costUsd: 0.0123 * i, tokens: 1200 * i, projectId: null, createdAt: iso(3600e3 * i), updatedAt: iso(3600e3 * i), ...extra });
const CONVS = [conv(1, "Planning the Q4 migration of the billing service to the new ledger and what to do about the legacy invoices", { pinned: 1 }), conv(2, "Short one"), conv(3, "Regex help"), conv(4, "Trip itinerary Lisbon → Porto")];
const MODELS = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", meta: { label: "Sonnet 5.5", vendor: "Anthropic", tier: "balanced", price: { input: 3, output: 15 }, caps: { images: true, caching: true, thinking: true, tools: true } } },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", meta: { label: "Haiku 5.5", vendor: "Anthropic", tier: "fast", price: { input: 1, output: 5 }, caps: { images: true, caching: true, thinking: false, tools: true } } },
  { id: "gemini-x", name: "Gemini X", meta: null },
];
const text = (t: string) => [{ type: "text", text: t }];
const MESSAGES = [
  { id: 1, role: "user", content: text("Summarise the migration plan in a table, then show the SQL."), model: null, usage: null, costUsd: null, stopReason: null, status: "done", ttftMs: null, totalMs: null, createdAt: now - 60e3 },
  { id: 2, role: "assistant", content: text("Here is the plan:\n\n| Step | Owner | Risk |\n|---|---|---|\n| Freeze writes | Platform | Low |\n| Backfill ledger | Billing | Medium |\n\n```sql\nSELECT id, total FROM invoices WHERE migrated = false;\n```\n\nA `very-long-unbroken-identifier_that_should_wrap_instead_of_overflowing_the_viewport_on_a_phone` is also covered."), model: "claude-sonnet-5-5", usage: { input: 900, output: 240, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.0061, stopReason: "end_turn", status: "done", ttftMs: 700, totalMs: 4200, createdAt: now - 50e3 },
];
const usage = () => {
  const t = (c: number) => ({ units: 3, calls: 12, costUsd: c, tokens: 48000, input: 30000, output: 18000, cacheRead: 9000, cacheWrite: 1000, cacheHit: 0.3, unratedCalls: 0 });
  const g = (k: string, c: number) => ({ key: k, ...t(c) });
  const p = (c: number) => ({ total: t(c), byMode: [g("chat", c)], byModel: [g("claude-sonnet-5-5", c * 0.8), g("claude-haiku-5-5", c * 0.2)], gen: [] });
  return { asOf: now, tz: 0, today: p(0.42), month: p(8.31), daily: Array.from({ length: 14 }, (_, i) => ({ day: new Date(now - (13 - i) * 864e5).toISOString().slice(0, 10), costUsd: 0.2 + (i % 5) * 0.3, tokens: 10000 * (i % 5 + 1) })), topConversations: CONVS.slice(0, 3).map((c) => ({ id: c.id, title: c.title, costUsd: c.costUsd, tokens: c.tokens, calls: 4 })), reconcile: null };
};
const connector = (id: string, name: string, kind: string, extra: object = {}) => ({ id, name, kind, status: "ok", enabled: true, toolCount: 2, enabledCount: 2, tools: [{ name: "search_notes", description: "Search notes by keyword", approval: false, enabled: true, mode: "always", canAlways: true }, { name: "save_note", description: "Save a note", approval: true, enabled: true, mode: "ask", canAlways: true }], ...extra });
const art = (id: string, title: string, type: string) => ({ id, title, type, language: type === "code" ? "ts" : null, version: 2, bytes: 1800, createdAt: iso(7200e3), updatedAt: iso(3600e3), preview: type === "svg" ? "<svg/>" : "# Heading\nSome preview text of the artifact." });

/** Remote sessions for the audit: 3 live/recent + 37 stale (the real list is ~100 rows of weeks-old history). Epoch seconds like remote-hub. */
const nowS = Math.floor(now / 1000);
export const REMOTE_IDS = { running: "e2e-host:lane2:run-1", done: "e2e-host:lane2:done-1" };
const rsess = (id: string, name: string, status: string, ageS: number, stale: boolean, extra: object = {}) => ({ id, host: "e2e-host", kind: "lane2", name, status, started_at: nowS - ageS - 600, ended_at: status === "running" ? null : nowS - ageS, cwd: "/work/demo", brief: `Brief for ${name}: tidy the build scripts and report`, exit_code: status === "running" ? null : 0, session_ref: null, updated_at: nowS - ageS, stale, ...extra });
export const REMOTE_ROWS = [
  rsess("e2e-host:lane2:old-0", "steer-test-0", "running", 20 * 86400, true),
  ...Array.from({ length: 36 }, (_, i) => rsess(`e2e-host:lane2:old-${i + 1}`, `adhoc-${i + 1}`, i % 5 === 0 ? "failed" : "done", (21 + i) * 86400, true)),
  rsess(REMOTE_IDS.running, "uifix-run", "running", 30, false),
  rsess(REMOTE_IDS.done, "uifix-done", "done", 3600, false),
  rsess("e2e-host:lane2:fail-1", "uifix-failed", "failed", 7200, false, { exit_code: 1 }),
];
const TAIL = Array.from({ length: 160 }, (_, i) => `line ${i + 1}: assistant said something moderately long about step ${i + 1} of the task`).join("\n");

export type MockOpts = {
  /** "empty" = fresh account (empty states), "error" = every data call fails (error states), "slow" = data calls take 1.5s (loading states) */
  mode?: "full" | "empty" | "error" | "slow";
  /** me.erichOnly (cloud/agents/desktop/remote tabs) */
  erich?: boolean;
  /** /api/models also lists a second provider (prefixed ids, provider + capabilities on every item) and /api/providers lists it; "forbidden" = /api/providers answers 403 (guest-like). */
  providers?: "multi" | "forbidden";
  /** a team (g:*) session: /api/me says team + not erichOnly, and every Erich-only route answers 403 like the real server; prompts + profile are stateful and work.
   *  `hits403` collects every 403 the app provoked (must stay empty: the UI hides what cannot work instead of calling it). */
  team?: { hits403: string[] };
};
const TEAM_403 = /^\/api\/(providers|connectors|projects|artifacts|cloud|agents|desktop|remote)(\/|$)/;
const CAPS = (o: object = {}) => ({ text: true, vision: false, tools: false, "image-gen": false, "video-gen": false, reasoning: false, ...o });
const PROVIDER_MODELS = [
  { id: "acme:m1", name: "Acme One", provider: "acme", capabilities: CAPS({ tools: true }), meta: { label: "Acme One", vendor: "other", tier: "balanced", price: { input: 1, output: 2 }, caps: { images: false, caching: false, thinking: false, tools: true } } },
  { id: "acme:m2", name: "Acme Two", provider: "acme", capabilities: CAPS(), meta: { label: "Acme Two", vendor: "other", tier: "balanced", price: null, caps: { images: false, caching: false, thinking: false, tools: false } } },
];
const PROVIDERS_LIST = [
  { id: "gateway", kind: "gateway", enabled: true, status: "enabled", modelCount: 3 },
  { id: "stub", kind: "stub", enabled: false, status: "off", modelCount: 1 },
  { id: "acme", kind: "openai-compat", enabled: true, status: "enabled", modelCount: 2 },
  { id: "beta", kind: "openai-compat", enabled: true, status: "needs-key", modelCount: 1 },
];

export async function mockApp(page: Page, o: MockOpts = {}): Promise<void> {
  const mode = o.mode ?? "full";
  const full = mode !== "empty";
  const teamPrompts: Array<{ id: string; title: string; text: string; createdAt: string; updatedAt: string }> = [];
  const teamProfile = { fullName: "", nickname: "", instructions: "" };
  await page.route(/\/(api|auth)\//, async (route: Route) => {
    const u = new URL(route.request().url());
    const p = u.pathname; const m = route.request().method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (p === "/api/me") return o.team ? json({ user: "ann@example.com", via: "team", csrf: "csrf-demo", defaultModel: "claude-sonnet-5-5", erichOnly: false, team: true }) : json({ user: "demo", via: "sso", csrf: "csrf-demo", defaultModel: "claude-sonnet-5-5", erichOnly: o.erich ?? true });
    if (o.team && TEAM_403.test(p)) { o.team.hits403.push(`${m} ${p}`); return json({ error: "forbidden" }, 403); }
    if (o.team && p === "/api/prompts" && m === "GET") return json({ prompts: teamPrompts });
    if (o.team && p === "/api/prompts" && m === "POST") { const b = route.request().postDataJSON(); const r = { id: ID(900 + teamPrompts.length), title: b.title, text: b.text, createdAt: iso(), updatedAt: iso() }; teamPrompts.push(r); return json(r, 201); }
    if (o.team && p === "/api/profile" && m === "PUT") { const b = route.request().postDataJSON(); if ("instructions" in b) return json({ error: "instructions are not available for this account" }, 400); Object.assign(teamProfile, b); return json(teamProfile); }
    if (o.team && p === "/api/profile") return json(teamProfile);
    if (p === "/auth/config") return json({ github: true, sso: true });
    if (p === "/api/push/config") return json({ enabled: false, publicKey: "" });
    if (p === "/api/version") return json({ build: "mock", commit: "mock", builtAt: "unknown" });
    if (mode === "error") return json({ error: "Something went wrong on the server" }, 500);
    if (mode === "slow") await new Promise((r) => setTimeout(r, 1500));
    if (p === "/api/providers") return o.providers === "forbidden" ? json({ error: "forbidden" }, 403) : json({ providers: o.providers === "multi" ? PROVIDERS_LIST : PROVIDERS_LIST.slice(0, 2) });
    if (p === "/api/models") return json({ default: "claude-sonnet-5-5", models: o.providers === "multi" ? [...MODELS.map((m) => ({ ...m, provider: "gateway", capabilities: CAPS({ vision: !!m.meta, tools: !!m.meta }) })), ...PROVIDER_MODELS] : MODELS });
    if (p === "/api/gen/models") return json({ kind: u.searchParams.get("kind"), confirmUsd: 1, models: [] });
    if (p === "/api/settings/chat-images") return m === "PUT" ? json({ enabled: route.request().postDataJSON().enabled }) : json({ enabled: true, available: true });
    if (p === "/api/profile") return json({ fullName: full ? "Demo User" : "", nickname: full ? "Demo" : "", instructions: full ? "Be concise." : "" });
    if (p === "/api/slash") return json({ items: [] });
    if (p === "/api/conversations" && m === "GET") {
      if (u.searchParams.get("project")) return json({ conversations: full ? CONVS.slice(0, 2).map((c) => ({ ...c, projectId: IDS.project })) : [] });
      return json({ conversations: full ? CONVS : [] });
    }
    if (p === `/api/conversations/${IDS.chat}`) return json({ conversation: CONVS[0], state: { seq: 2, running: false, inflight: null, model: "claude-sonnet-5-5", title: CONVS[0].title, error: null, costUsd: 0.01, tokens: 2400, messages: MESSAGES } });
    if (/^\/api\/conversations\/[^/]+$/.test(p) && m === "GET") return json({ conversation: CONVS[1], state: { seq: 0, running: false, inflight: null, model: "claude-sonnet-5-5", title: "", error: null, costUsd: 0, tokens: 0, messages: [] } });
    if (p === "/api/library") return json({ items: [], next: null });
    if (p === "/api/usage") return json(usage());
    if (p === "/api/skills") return json({ skills: full ? [{ id: "s1", name: "summarise", description: "Summarise the pasted text in five bullets", template: "Summarise: {{input}}", tools: [], createdAt: iso(), updatedAt: iso() }] : [] });
    if (p === "/api/projects" && m === "GET") return json({ projects: full ? [{ id: IDS.project, name: "Billing migration", instructions: "Always answer in the context of the ledger migration.", createdAt: iso(864e5), updatedAt: iso(3600e3), chatCount: 2 }] : [] });
    if (p === `/api/projects/${IDS.project}`) return json({ id: IDS.project, name: "Billing migration", instructions: "Always answer in the context of the ledger migration.", createdAt: iso(864e5), updatedAt: iso(3600e3), chatCount: 2 });
    if (p === "/api/artifacts") return json({ items: full ? [art(IDS.artifact, "Migration plan", "markdown"), art(IDS.artifactHtml, "Dashboard mock", "html"), art(ID(72), "helpers.ts", "code")] : [], next: null });
    if (p === `/api/artifacts/${IDS.artifact}`) return json({ ...art(IDS.artifact, "Migration plan", "markdown"), shown: 2, content: "# Migration plan\n\n- Freeze writes\n- Backfill ledger\n\nSome *body* text.", versions: [{ version: 2, bytes: 1800, createdAt: iso(3600e3) }, { version: 1, bytes: 1200, createdAt: iso(7200e3) }] });
    if (p === "/api/connectors") return json({ connectors: full ? [connector("personal-connector", "Personal connector", "internal-binding"), connector("cc_0123456789abcdef", "Docs MCP", "remote-mcp", { url: "https://mcp.example.com/sse", authKind: "bearer", hasToken: true, status: "unreachable", error: "timeout", toolCount: null, enabledCount: 0, tools: [] })] : [] });
    if (p === "/api/connectors/personal-connector") return json({ connector: connector("personal-connector", "Personal connector", "internal-binding") });
    if (p === "/api/cloud/config") return json({ enabled: true, repos: ["demo/repo"], executors: ["claude"], e2eBasePrefix: "" });
    if (p === "/api/cloud/runs") return json({ enabled: true, runs: full ? [{ id: "a1b2c3d4e5f60718", kind: "task", repo: "demo/repo", base: "main", branch: "feat/x", executor: "claude", title: "Fix flaky test in the ledger package and update the changelog", status: "done", cost_usd: 0.31, created_at: iso(7200e3), updated_at: iso(3600e3) }] : [] });
    if (p === "/api/agents/config") return json({ enabled: true, repos: ["demo/repo"], images: ["base"], executors: ["claude"], namePrefix: "", e2eBasePrefix: null });
    if (p === "/api/agents") return json({ enabled: true, agents: full ? [{ name: "triage-bot", repo: "demo/repo", state: "sleeping", costUsd: 1.2, lastActivity: now - 3600e3 }] : [] });
    if (p === "/api/desktop/config") return json({ enabled: true, maxSteps: { default: 30, max: 100 } });
    if (p === "/api/desktop/runs") return json({ enabled: true, runs: [] });
    if (p === "/api/remote/sessions") return json({ enabled: true, sessions: full ? REMOTE_ROWS : [] });
    if (p.startsWith("/api/remote/sessions/")) { const r = REMOTE_ROWS.find((x) => x.id === decodeURIComponent(p.slice("/api/remote/sessions/".length))); return r ? json({ ...r, tail: TAIL, report: r.status === "running" ? "" : "# Report\n\n- done", commands: [] }) : json({ error: "not found" }, 404); }
    return json({ error: "not mocked" }, 404);
  });
  // chat WebSocket: hello only (state comes from GET), never closes
  await page.routeWebSocket(/\/api\/conversations\/.*\/ws/, (ws) => { ws.send(JSON.stringify({ t: "hello", seq: 2, minSeq: 0, running: false, now: Date.now() })); });
}

/** Every screen worth auditing: [slug, path]. */
export const SCREENS: Array<[string, string]> = [
  ["start", "/"], ["chats", "/chats"], ["chat", `/c/${IDS.chat}`], ["cloud", "/cloud"], ["agents", "/agents"], ["skills", "/skills"],
  ["artifacts", "/artifacts"], ["artifact", `/artifacts/${IDS.artifact}`], ["usage", "/usage"], ["about", "/about"], ["settings", "/settings"],
  ["settings-profile", "/settings/profile"], ["settings-appearance", "/settings/appearance"], ["settings-capabilities", "/settings/capabilities"], ["settings-providers", "/settings/providers"],
  ["remote", "/remote"], ["remote-session", `/m/${encodeURIComponent(REMOTE_IDS.running)}`], ["connectors", "/connectors"], ["connector", "/connectors/personal-connector"], ["connector-new", "/connectors/new"], ["projects", "/projects"], ["project", `/projects/${IDS.project}`],
];

/** Open a Settings page by slug (profile, subagents, skills, ...): the row on the phone's Settings page, or the left-nav pane of the desktop modal (General no longer repeats the pane rows). */
export async function openSettingsRow(page: Page, slug: string): Promise<void> {
  const pane = page.getByTestId(`settings-pane-${slug}`), row = page.getByTestId(`open-${slug}`);
  await pane.or(row).first().waitFor(); // the modal / page may still be rendering
  if (await pane.count()) await pane.click(); else await row.click();
}
