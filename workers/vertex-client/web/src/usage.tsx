import { useEffect, useState } from "preact/hooks";
import { IconBack } from "./icons";
import { type Group, type Period, type UsageReport, getUsage } from "./api";
import { fmtCost, fmtTokens } from "./chat-state";
import { errorToast } from "./toast";

const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);
const ESTIMATE_NOTE = "tokens × public list price";
const MODE_LABEL: Record<string, string> = { chat: "Chat", cloud: "Cloud", gen: "Generation" };

function Skeleton() {
  return <div class="page" aria-busy="true">{[0, 1, 2].map((i) => <div class="skel block" key={i} />)}</div>;
}

function Stat({ label, p }: { label: string; p: Period }) {
  const t = p.total;
  return (
    <section class="card" data-testid={`usage-${label.toLowerCase().replace(/\s/g, "-")}`}>
      <h3>{label}</h3>
      <div class="big" data-testid="usage-cost" title={ESTIMATE_NOTE}>{fmtCost(t.costUsd)}</div>
      <div class="muted small" data-testid="usage-estimate">Estimated total cost (estimate, not a bill) · {ESTIMATE_NOTE}</div>
      <div class="muted small">{fmtTokens(t.tokens)} tokens · {t.calls} calls · cache hit {pct(t.cacheHit)}{t.unratedCalls ? ` · ${t.unratedCalls} unrated` : ""}</div>
      {p.byMode.length > 0 && <Rows title="By mode" rows={p.byMode.map((g) => ({ ...g, key: MODE_LABEL[g.key] ?? g.key }))} />}
      {p.byModel.length > 0 && <Rows title="By model" rows={p.byModel.filter((g) => !p.gen.some((x) => x.key.endsWith(` · ${g.key}`)))} />}
      {p.gen.length > 0 && (
        <div class="rows" data-testid="usage-generation">
          <div class="muted small">Generation</div>
          {p.gen.map((g) => (
            <div class="row2" key={g.key}>
              <span class="ellip">{g.key}</span>
              <span class="muted small">{g.key.startsWith("video ·") ? `${g.units} s of video` : `${g.units} image${g.units === 1 ? "" : "s"}`} · {g.calls} request{g.calls === 1 ? "" : "s"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Rows({ title, rows }: { title: string; rows: Group[] }) {
  return (
    <div class="rows">
      <div class="muted small">{title}</div>
      {rows.map((g) => (
        <div class="row2" key={g.key}>
          <span class="ellip">{g.key}</span>
          <span class="muted small">{g.tokens === 0 && g.calls === 0 ? "– (no token count)" : `${fmtTokens(g.tokens)} tokens · cache ${pct(g.cacheHit)}`}</span>
        </div>
      ))}
    </div>
  );
}

function Bars({ daily }: { daily: UsageReport["daily"] }) {
  const max = Math.max(1, ...daily.map((d) => d.tokens));
  return (
    <div class="bars" role="img" aria-label="Daily tokens, last 14 days">
      {daily.map((d) => <div class="bar-col" key={d.day} title={`${d.day} ${fmtTokens(d.tokens)} tokens`}><div class={`bar-fill h${Math.max(1, Math.round((d.tokens / max) * 20))}`} /></div>)}
    </div>
  );
}

export function Usage({ onBack, onOpen }: { onBack: () => void; onOpen: (id: string) => void }) {
  const [rep, setRep] = useState<UsageReport | null>(null);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    void getUsage().then((r) => { if (r.status === 200 && r.data) setRep(r.data); else { setFailed(true); errorToast(`Could not load usage (${r.status})`, load); } })
      .catch(() => { setFailed(true); errorToast("Could not load usage (offline?)", load); });
  };
  useEffect(load, []);
  return (
    <div class="shell">
      <header class="bar"><button class="rbtn" aria-label="Back" title="Back" onClick={onBack}><IconBack /></button><h2 class="title">Usage</h2><button class="rbtn bar-act" aria-label="Refresh" title="Refresh" data-testid="usage-refresh" onClick={load}>↻</button></header>
      {!rep && !failed && <Skeleton />}
      {failed && !rep && <div class="empty state-panel" role="alert"><h2>Usage unavailable</h2><p class="muted">Check your connection, then try again.</p><button class="btn" onClick={load}>Retry</button></div>}
      {rep && (
        <main class="page wide usage">
          {rep.month.total.calls === 0 && <div class="empty full"><h2>No usage yet this month</h2><p class="muted">Usage appears here after your first reply.</p></div>}
          <Stat label="Today" p={rep.today} />
          <Stat label="This month" p={rep.month} />
          {rep.daily.length > 0 && <section class="full"><h3>Last 14 days</h3><Bars daily={rep.daily} /></section>}
          {rep.topConversations.length > 0 && (
            <section>
              <h3>Top conversations (month)</h3>
              <ul class="list">
                {rep.topConversations.map((c) => (
                  <li key={c.id}><button class="row" onClick={() => onOpen(c.id)}><strong class="ellip">{c.title || "New chat"}</strong><span class="muted small">{fmtTokens(c.tokens)} tokens · {c.calls} calls</span></button></li>
                ))}
              </ul>
            </section>
          )}
          <section data-testid="usage-reconcile">
            <h3>Gateway reconciliation</h3>
            {!rep.reconcile && <p class="muted small">Not run yet. <code>scripts/reconcile-gateway.mjs</code> compares this table with the gateway's own log for caller <code>vertex-client</code>.</p>}
            {rep.reconcile && (
              <div class="muted small">
                <div>Last run {rep.reconcile.at}, since {rep.reconcile.since}</div>
                <div>Calls — app {rep.reconcile.client.calls}, gateway {rep.reconcile.gateway.calls} (drift {rep.reconcile.drift.calls >= 0 ? "+" : ""}{rep.reconcile.drift.calls})</div>
                <div>Tokens — app {fmtTokens(rep.reconcile.client.tokens)}, gateway {fmtTokens(rep.reconcile.gateway.tokens)} (drift {rep.reconcile.drift.tokens >= 0 ? "+" : ""}{fmtTokens(Math.abs(rep.reconcile.drift.tokens))})</div>
                {rep.reconcile.note && <div>{rep.reconcile.note}</div>}
              </div>
            )}
          </section>
          <p class="muted small full">Days follow this device's timezone. The total cost at the top is an estimate computed from token counts at public list prices (tokens × public list price), not a bill; per-item figures are tokens only. Cloud runs report cost, not tokens, so they count toward the total but show no token count. Deleting a conversation removes it from the per-conversation list but its spend stays in the totals, so the list can sum to less than the total.</p>
        </main>
      )}
    </div>
  );
}
