import { useEffect, useState } from "preact/hooks";
import { IconBack, IconChevron, IconInfo } from "./icons";
import { applyUpdate, busyNow, runningBuild, checkNow, refreshBuild, refreshServer, resetApp, swState, updateNow, useUpdate } from "./update";
import { canUpdateNow, formatAbout, lastResultText, relation, relationText, shortBuild, shortUa } from "./update-logic";
import { THEME_LABEL, useTheme } from "./theme";
import { toast } from "./toast";
import { installRows } from "./desktop-info";
import { isStandalone, probePx, setStyles } from "./viewport";

const go = (path: string) => { history.pushState({ fromApp: true }, "", path); dispatchEvent(new PopStateEvent("popstate")); };
const val = (v: string | null | undefined) => v || "unknown";

/** Clipboard with a textarea fallback (non-secure contexts / older iOS). */
async function copyText(t: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* fall through */ }
  const ta = document.createElement("textarea");
  ta.value = t; ta.setAttribute("readonly", ""); setStyles(ta, { position: "fixed", top: "0", left: "0", opacity: "0" });
  document.body.appendChild(ta); ta.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { ta.remove(); }
}

function insets(): string {
  const p = document.createElement("div");
  setStyles(p, { position: "absolute", visibility: "hidden", "padding-top": "var(--sat)", "padding-bottom": "var(--sab)" });
  document.body.appendChild(p);
  const c = getComputedStyle(p);
  const r = `top ${parseFloat(c.paddingTop) || 0}px · bottom ${parseFloat(c.paddingBottom) || 0}px`;
  p.remove();
  return r;
}

/** Viewport facts for debugging the standalone-PWA bottom gap (display only, no network). */
export function viewportRows(): Array<[string, string]> {
  const vv = window.visualViewport, r = (n: number) => `${Math.round(n * 10) / 10}`;
  const sa = document.createElement("div");
  setStyles(sa, { position: "absolute", visibility: "hidden", "padding-top": "env(safe-area-inset-top,0px)", "padding-bottom": "env(safe-area-inset-bottom,0px)" });
  document.body.appendChild(sa);
  const c = getComputedStyle(sa), env = `top ${c.paddingTop} · bottom ${c.paddingBottom}`;
  sa.remove();
  return [
    ["innerHeight", r(innerHeight)],
    ["visualViewport", vv ? `h ${r(vv.height)} · offsetTop ${r(vv.offsetTop)}` : "n/a"],
    ["screen.height", r(screen.height)],
    ["display-mode standalone", String(matchMedia("(display-mode: standalone)").matches)],
    ["navigator.standalone", String((navigator as unknown as { standalone?: boolean }).standalone ?? "n/a")],
    ["100vh / 100dvh / 100lvh", `${r(probePx("100vh"))} / ${r(probePx("100dvh"))} / ${r(probePx("100lvh"))}`],
    ["env(safe-area-inset)", env],
    ["--appvh", getComputedStyle(document.documentElement).getPropertyValue("--appvh").trim() || "unset"],
    ["standalone (app)", String(isStandalone())],
  ];
}

/** About (/about): the facts to cross-check against what the PO reports, plus check / update / reset. */
export function About({ onBack }: { onBack: () => void }) {
  const u = useUpdate();
  const [theme] = useTheme();
  const [online, setOnline] = useState(navigator.onLine);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [serverErr, setServerErr] = useState("");
  const [, bump] = useState(0);
  useEffect(() => {
    void refreshBuild();
    void refreshServer().then(setServerErr);
    const f = () => setOnline(navigator.onLine);
    addEventListener("online", f); addEventListener("offline", f);
    return () => { removeEventListener("online", f); removeEventListener("offline", f); };
  }, []);
  useEffect(() => { bump((n) => n + 1); }, [u.waiting, u.check]);

  const rel = relation(runningBuild(u), u.server?.build ?? null);
  const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const rows: Array<[string, string]> = [
    ["App build", val(u.build)],
    ["Code commit", val(u.commit)],
    ["Built at (UTC)", val(u.builtAt)],
    ["Deployed Worker version", val(u.server?.worker_version_id)],
    ["Server build", val(u.server?.build)],
    ["Server commit", val(u.server?.commit)],
    ["Server built at (UTC)", val(u.server?.builtAt)],
    ...installRows(standalone, navigator.userAgent),
    ["Service worker", swState()],
    ["Browser", shortUa(navigator.userAgent)],
    ["Safe-area inset", insets()],
    ["Theme", THEME_LABEL[theme]],
    ["Network", online ? "online" : "offline"],
  ];
  const status = u.check === "checking" ? "Checking…" : u.check === "ready" ? "Update ready" : u.check === "uptodate" ? "Up to date" : u.check === "error" ? (u.error.startsWith("You are offline") ? u.error : `Error: ${u.error}`) : "";
  const canUpdate = canUpdateNow(u.waiting, rel);
  const doUpdate = () => { setConfirmBusy(false); void (u.waiting ? Promise.resolve(applyUpdate()) : updateNow()); };
  const onUpdate = () => (busyNow() ? setConfirmBusy(true) : doUpdate());
  const copy = async () => toast((await copyText(formatAbout(rows))) ? "Copied." : "Could not copy.");

  return (
    <div class="shell">
      <header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={onBack}><IconBack /></button><h2 class="title">About</h2></header>
      <main class="page" data-testid="about-screen">
        <section>
          <h3>Version</h3>
          <dl class="kv" data-testid="about-rows">
            {rows.map(([k, v]) => (
              <div class="kv-row" key={k} data-testid={`about-${k.toLowerCase().replace(/[^a-z]+/g, "-")}`}><dt class="muted small">{k}</dt><dd><code>{v}</code></dd></div>
            ))}
          </dl>
          <p class={rel === "older" ? "" : "muted small"} role="status" data-testid="about-relation">{relationText(rel)}{rel === "unknown" && serverErr ? ` (${serverErr})` : ""}</p>
          <div class="actions"><button class="btn" data-testid="about-copy" onClick={() => void copy()}>Copy</button></div>
        </section>
        <section>
          <h3>Viewport</h3>
          <dl class="kv" data-testid="about-viewport">
            {viewportRows().map(([k, v]) => (
              <div class="kv-row" key={k}><dt class="muted small">{k}</dt><dd><code>{v}</code></dd></div>
            ))}
          </dl>
        </section>
        <section>
          <h3>Updates</h3>
          <div class="actions">
            <button class="btn" data-testid="check-update" disabled={u.check === "checking"} onClick={() => void checkNow()}>Check for updates</button>
            <button class="btn primary" data-testid="update-now-about" disabled={!canUpdate} onClick={onUpdate}>Update now</button>
          </div>
          <p class={u.last?.kind === "failed" ? "error small" : "muted small"} data-testid="last-update">{lastResultText(u.last)}</p>
          {status && <p class={u.check === "error" ? "error" : "muted small"} role="status" data-testid="update-status">{status}</p>}
          {confirmBusy && (
            <div class="card" role="alertdialog" aria-label="Reply in progress" data-testid="update-busy-warning">
              <p>A reply is in progress — updating will interrupt it.</p>
              <div class="actions"><button class="btn" data-testid="update-cancel" onClick={() => setConfirmBusy(false)}>Cancel</button><button class="btn primary" data-testid="update-anyway" onClick={doUpdate}>Update anyway</button></div>
            </div>
          )}
        </section>
        <section>
          <h3>Troubleshooting</h3>
          <p class="muted small">Drops the service worker and cached app files, then loads fresh from the network. Needs a connection.</p>
          <div class="actions"><button class="btn" data-testid="reset-app" onClick={() => (confirmReset ? void resetApp() : setConfirmReset(true))}>{confirmReset ? "Tap again to reset & reload" : "Reset app cache & reload"}</button></div>
        </section>
      </main>
    </div>
  );
}

/** Settings: a compact card row (version + update state) that opens About, where the logic lives. */
export function VersionSetting() {
  const u = useUpdate();
  useEffect(() => { void refreshBuild(); }, []);
  return (
    <div class="scard" data-testid="version-setting">
      <button class="srow" data-testid="open-about" onClick={() => go("/about")}>
        <IconInfo /><span class="srow-l">Version</span>
        <span class="srow-v"><code data-testid="app-version">{shortBuild(u.build)}</code>{u.waiting && <> · update ready</>}</span><IconChevron />
      </button>
    </div>
  );
}
