import { withBusy } from "./busy";
import { useEffect, useState } from "preact/hooks";
import { Chat, ConversationList, go, useRoute } from "./chat";
import { ProjectPage, Projects } from "./projects";
import { Library } from "./library";
import { Toasts } from "./toast";
import { NotifToasts, NotificationsPage } from "./notifications";
import { resetNotifs, startNotifs } from "./notif-store";
import { UpdateBanner } from "./update-ui";
import { MeCtx } from "./drawer";
import { getSpace, isBizOnlyPath, reconcileSpace } from "./space";
import { teamMayOpen } from "./desk-logic";
import { hasOpen } from "./space-ui";
import { DeskShell, useDesktop } from "./desk";
import { Palette } from "./palette";
import { ShortcutHelp } from "./shortcuts";
import { lazyScreen, preloadWhenIdle } from "./lazy-screen";
// Small and constantly switched between: static, so moving between Settings panes never shows a Suspense fallback.
import { Settings } from "./settings";
import { AppearancePage, ApprovalsPage, CapabilitiesPage, CloudflarePage, ProfilePage, PromptsPage, ProvidersPage } from "./settings-pages";
import { Subagents } from "./subagents";
import { About } from "./about";
import { cachedMe as cachedMeFor, dropMe, saveMe as saveMeAt } from "./me-cache";
import { type AuthConfig, type Me, devLoginCheck, devLoginPost, getAuthConfig, getMe, logout, setCsrf } from "./api";

// Everything except the chat shell and the Settings panes is code-split (see lazy-screen.tsx); the common ones are preloaded when the browser is idle. Projects stays static: chat-item.tsx already imports its MoveSheet.
const Usage = lazyScreen(() => import("./usage").then((m) => m.Usage));
const Skills = lazyScreen(() => import("./skills").then((m) => m.Skills));
const Artifacts = lazyScreen(() => import("./artifacts").then((m) => m.Artifacts));
const ArtifactViewer = lazyScreen(() => import("./artifacts").then((m) => m.ArtifactViewer));
const Connectors = lazyScreen(() => import("./connectors").then((m) => m.Connectors));
const AddConnector = lazyScreen(() => import("./connectors").then((m) => m.AddConnector));
const ConnectorDetail = lazyScreen(() => import("./connectors").then((m) => m.ConnectorDetail));
const CloudList = lazyScreen(() => import("./cloud").then((m) => m.CloudList));
const RunView = lazyScreen(() => import("./cloud").then((m) => m.RunView));
const AgentList = lazyScreen(() => import("./agents").then((m) => m.AgentList));
const AgentView = lazyScreen(() => import("./agents").then((m) => m.AgentView));
const DevicesPage = lazyScreen(() => import("./devices").then((m) => m.DevicesPage));
const ThisDevicePage = lazyScreen(() => import("./this-device").then((m) => m.ThisDevicePage));
const ComputersPage = lazyScreen(() => import("./computers").then((m) => m.ComputersPage));
const DeviceView = lazyScreen(() => import("./devices").then((m) => m.DeviceView));
const RemoteList = lazyScreen(() => import("./remote").then((m) => m.RemoteList));
const RemoteView = lazyScreen(() => import("./remote").then((m) => m.RemoteView));
const DesktopList = lazyScreen(() => import("./desktop").then((m) => m.DesktopList));
const DesktopView = lazyScreen(() => import("./desktop").then((m) => m.DesktopView));

preloadWhenIdle([() => import("./usage"), () => import("./skills"), () => import("./connectors"), () => import("./artifacts")]);

type Auth = { state: "loading" } | { state: "offline" } | { state: "out" } | { state: "in"; me: Me; offline?: boolean };

// Offline identity cache: see me-cache.ts. Without it (first ever load, signed out) the full-screen error stays.
const saveMe = (me: Me) => saveMeAt(me, getSpace());
const cachedMe = () => cachedMeFor(getSpace());

/** One offline indicator for the whole app: the screen underneath stays usable (cached data), this only says why it may be out of date. */
function OfflinePill({ onRetry }: { onRetry: () => void }) {
  return <div class="offline-pill" role="status" data-testid="offline-pill"><span>Offline — showing saved data</span><button class="linkbtn" onClick={onRetry}>Retry now</button></div>;
}

export function App() {
  const [auth, setAuth] = useState<Auth>({ state: "loading" });
  const refresh = async () => {
    // Only a 401 means "signed out". A network failure or a 5xx is "can't tell" - never show a login page for that, and never
    // hang on the skeleton (offline used to leave the app on the loading state forever).
    const r = await getMe().catch(() => null);
    if (r && r.status === 200 && r.data) {
      const rec = reconcileSpace(r.data); // a remembered Open the server does not confirm is dropped before anything renders in its accent
      if (rec === "reload") return; // reloading into Business: keep the skeleton
      if (rec === "stay") return void refresh(); // guard hit: already Business now, re-read /api/me without the Open selector
      setCsrf(r.data.csrf); saveMe(r.data); setAuth({ state: "in", me: r.data });
    }
    else if (r && (r.status === 401 || (r.status === 403 && (r.data as { error?: string } | null)?.error === "forbidden"))) { dropMe(); setCsrf(""); setAuth({ state: "out" }); } // signed out, or the account's access was revoked: never keep showing a cached identity
    else setAuth((a) => { const me = a.state === "in" ? a.me : cachedMe(); return me ? { state: "in", me, offline: true } : { state: "offline" }; });
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (auth.state === "in") return startNotifs(); if (auth.state === "out") resetNotifs(); }, [auth.state]); // bell count + toasts for rows no socket carries
  const lost = auth.state === "offline" || (auth.state === "in" && !!auth.offline);
  useEffect(() => { // come back by itself when the network returns
    if (!lost) return;
    const on = () => void refresh();
    addEventListener("online", on); const t = setInterval(on, 10_000);
    return () => { removeEventListener("online", on); clearInterval(t); };
  }, [lost]);
  useEffect(() => { // the browser knows before a request fails: show the indicator at once, re-check when it is back
    if (auth.state !== "in") return;
    const off = () => setAuth((a) => (a.state === "in" ? { ...a, offline: true } : a));
    const on = () => void refresh();
    addEventListener("offline", off); addEventListener("online", on);
    return () => { removeEventListener("offline", off); removeEventListener("online", on); };
  }, [auth.state]);
  if (auth.state === "offline") return <main class="center" data-testid="offline"><h1>Vertex Client</h1><p class="muted" role="status">Can't reach the server (offline?). Retrying…</p><button class="btn" onClick={() => void refresh()}>Retry now</button></main>;
  if (auth.state === "loading") return <main class="center" aria-busy="true"><div class="skel line wide" /><div class="skel line" /></main>;
  if (auth.state === "out") return <Login />;
  return <MeCtx.Provider value={auth.me}><Toasts /><NotifToasts /><UpdateBanner />{auth.offline && <OfflinePill onRetry={() => void refresh()} />}<Home me={auth.me} onSignOut={async () => { dropMe(); const r = await withBusy("logout", logout).catch(() => null); if (r?.data?.ssoLogout) { location.assign(r.data.ssoLogout); return; } setAuth({ state: "out" }); }} /></MeCtx.Provider>;
}

function Login() {
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const [email, setEmail] = useState("");
  const [needPw, setNeedPw] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => { void getAuthConfig().then((r) => setCfg(r.data ?? { github: false })).catch(() => setCfg({ github: false })); }, []);
  // Email step (only when the server says so): a listed email asks for the password, any other continues the existing sign-in.
  const next = async (e: Event) => {
    e.preventDefault(); setErr("");
    const r = await withBusy("login-check", () => devLoginCheck(email)).catch(() => null);
    if (r?.data?.password) setNeedPw(true); else location.assign(cfg?.team === true ? "/auth/team" : "/auth/login");
  };
  const submitPw = async (e: Event) => {
    e.preventDefault(); setErr("");
    const r = await withBusy("login", () => devLoginPost(email, pw)).catch(() => null);
    if (r?.status === 200) location.assign("/"); else setErr("Sign-in failed");
  };
  return (
    <main class="center">
      <h1>Vertex Client</h1>
      {cfg?.emailStep && !needPw && (
        <form onSubmit={next} data-testid="login-email-step">
          <input type="email" autocomplete="username" placeholder="Email" aria-label="Email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} required />
          <button class="btn primary" type="submit">Continue</button>
        </form>
      )}
      {cfg?.emailStep && needPw && (
        <form onSubmit={submitPw} data-testid="login-password-step">
          <input type="password" autocomplete="current-password" placeholder="Password" aria-label="Password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} required />
          <button class="btn primary" type="submit">Sign in</button>
          {err && <p class="muted" role="alert">{err}</p>}
        </form>
      )}
      {cfg && !cfg.emailStep && (cfg.sso || cfg.github) && <a class="btn primary" href="/auth/login">Sign in</a>}
      {cfg && !cfg.emailStep && cfg.sso && cfg.github && <a class="muted small" href="/auth/github">Use GitHub directly</a>}
      {cfg?.team === true && <a class="btn primary" href="/auth/team" data-testid="sign-in-team">Sign in with team gateway</a>}
      {cfg && !cfg.sso && !cfg.github && !cfg.team && <p class="muted">No sign-in method is configured.</p>}
    </main>
  );
}

function Home({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const path = useRoute();
  const desk = useDesktop();
  // Settings is a real route (/settings) so a deep link / reload lands on it, not on the start screen.
  // Back returns to where you were only if you came from inside the app (history.state marks that); a deep link / reload goes home.
  const openSettings = () => { history.pushState({ fromApp: true }, "", "/settings"); dispatchEvent(new PopStateEvent("popstate")); };
  const back = () => (history.state?.fromApp ? history.back() : go("/"));
  const backToSettings = () => (history.state?.fromApp ? history.back() : go("/settings"));
  const page = (path: string) => {
    if (me.team === true && !teamMayOpen(path, hasOpen(me))) path = "/"; // a team session never lands on an Erich-only screen (deep link, stale tab): start screen instead of a 403 page
    if (/^\/computers(\/|$)/.test(path) && (me.erichOnly !== true || me.team === true)) path = "/"; // Computers = the sidebar entry's gating (Erich, not team); Business + devices-200 are enforced by the next line and the page itself
    if (getSpace() === "open" && isBizOnlyPath(path)) path = "/"; // Cloud/Agents/Desktop are Business-only: a deep link or stale tab lands on the start screen, not a dead page
    if (path === "/settings") return <Settings me={me} onBack={back} onSignOut={onSignOut} />;
    if (path === "/settings/profile") return <ProfilePage onBack={backToSettings} />;
    if (path === "/settings/appearance") return <AppearancePage onBack={backToSettings} />;
    if (path === "/settings/subagents") return <Subagents onBack={backToSettings} />;
    if (path === "/settings/prompts") return <PromptsPage onBack={backToSettings} />;
    if (path === "/settings/capabilities") return <CapabilitiesPage onBack={backToSettings} />;
    if (path === "/settings/providers") return <ProvidersPage onBack={backToSettings} />;
    if (path === "/settings/cloudflare") return <CloudflarePage onBack={backToSettings} />;
    if (path === "/settings/skills") return <Skills onBack={backToSettings} />; // the desktop modal's own copies of /skills, /connectors, /usage
    if (path === "/settings/connectors") return <Connectors onBack={backToSettings} />;
    if (path === "/settings/usage") return <Usage onBack={backToSettings} onOpen={(id) => go(`/c/${id}`)} />;
    if (path === "/computers") return <ComputersPage onBack={() => go("/")} />;
    const cpm = /^\/computers\/([0-9a-f]{32})$/.exec(path);
    if (cpm) return <DeviceView id={cpm[1]} key={cpm[1]} computers />;
    if (path === "/devices") return <DevicesPage onBack={() => go("/")} top />;
    if (path === "/settings/devices") return <DevicesPage onBack={backToSettings} />;
    if (path === "/settings/this-device") return <ThisDevicePage onBack={backToSettings} onDevices={() => go("/settings/devices")} />;
    const dvm = /^\/dv\/([0-9a-f]{32})$/.exec(path);
    if (dvm) return <DeviceView id={dvm[1]} key={dvm[1]} />;
    if (path === "/settings/approvals") return <ApprovalsPage onBack={backToSettings} />;
    if (path === "/notifications") return <NotificationsPage />;
    if (path === "/about") return <About onBack={back} />;
    if (path === "/usage") return <Usage onBack={() => go("/")} onOpen={(id) => go(`/c/${id}`)} />;
    if (path === "/skills") return <Skills onBack={() => go("/settings")} />;
    if (path === "/projects") return <Projects />;
    const pm = /^\/projects\/([0-9a-f-]{36})$/.exec(path);
    if (pm) return <ProjectPage id={pm[1]} key={pm[1]} />;
    if (path === "/library") return <Library />;
    if (path === "/artifacts") return <Artifacts />;
    const arm = /^\/artifacts\/([0-9a-f-]{36})$/.exec(path);
    if (arm) return <ArtifactViewer id={arm[1]} key={arm[1]} />;
    if (path === "/connectors") return <Connectors onBack={() => go("/settings")} />;
    if (path === "/connectors/new") return <AddConnector onBack={() => go("/connectors")} />;
    const cm = /^\/connectors\/(personal-connector|cc_[0-9a-f]{16})$/.exec(path);
    if (cm) return <ConnectorDetail id={cm[1]} key={cm[1]} onBack={() => go("/connectors")} />;
    if (path === "/cloud") return <CloudList onSettings={openSettings} />;
    if (path === "/desktop") return <DesktopList onSettings={openSettings} />;
    const dm = /^\/d\/([0-9a-f]{16})$/.exec(path);
    if (dm) return <DesktopView id={dm[1]} key={dm[1]} />;
    if (path === "/remote") return <RemoteList onSettings={openSettings} />;
    const mm = /^\/m\/([^/]+)$/.exec(path);
    if (mm) return <RemoteView id={decodeURIComponent(mm[1])} key={mm[1]} />;
    if (path === "/agents") return <AgentList onSettings={openSettings} />;
    const am = /^\/a\/([a-z0-9][a-z0-9._-]{1,39})$/.exec(path);
    if (am) return <AgentView name={am[1]} key={am[1]} />;
    const rm = /^\/r\/([0-9a-z]{16})$/.exec(path);
    if (rm) return <RunView id={rm[1]} key={rm[1]} />;
    const m = /^\/c\/([0-9a-f-]{36})$/.exec(path);
    if (m) return <Chat id={m[1]} key={m[1]} />;
    if (path === "/chats") return <ConversationList onSettings={openSettings} />;
    // "/" (and anything unknown): the empty new chat; the conversation is created lazily on the first send
    return <Chat id={null} key={`new:${me.user}:${getSpace()}`} />; // a different account / space = a fresh start screen with ITS draft
  };
  // >=1024px: persistent sidebar + main + artifact panel + settings modal around the same pages; below it, one page at a time as before
  return <>{desk ? <DeskShell path={path} render={page} /> : page(path)}<Palette /><ShortcutHelp /></>;
}
