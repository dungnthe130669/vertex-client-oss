// Pure pieces of the command palette (Ctrl/Cmd+K, drawer search button): fuzzy scoring, the item list and its ordering. No DOM, so bun:test covers them.
import type { ArtifactRow, ConvRow, ProjectRow, PromptRow } from "./api";

export type PalKind = "action" | "nav" | "chat" | "artifact" | "project" | "prompt";
export type PalItem = { id: string; kind: PalKind; label: string; hint?: string; /** run() navigates / acts; fromApp marks a pushed history entry */ path?: string; fromApp?: boolean; act?: "switch-space" | "new-chat" | "toggle-theme" | "shortcuts" | "insert-prompt"; /** the saved prompt text to insert (act = insert-prompt) */ text?: string; pinned?: boolean };

/** Fuzzy score of `q` against `text`: -1 = no match. Substring beats subsequence; prefix / word start / consecutive letters score higher; shorter text wins ties. */
export function fuzzyScore(q: string, text: string): number {
  const n = q.trim().toLowerCase(), t = text.toLowerCase();
  if (!n) return 0;
  const at = t.indexOf(n);
  if (at >= 0) return 1000 + (at === 0 ? 200 : /[^a-z0-9]/.test(t[at - 1]) ? 100 : 0) - Math.min(t.length, 200) / 10;
  let ti = 0, score = 0, run = 0;
  for (const ch of n) {
    if (ch === " ") continue;
    const j = t.indexOf(ch, ti);
    if (j < 0) return -1;
    run = j === ti ? run + 1 : 0;
    score += 10 + run * 5 + (j === 0 || /[^a-z0-9]/.test(t[j - 1]) ? 15 : 0) - Math.min(j - ti, 20);
    ti = j + 1;
  }
  return Math.max(1, score - Math.min(t.length, 200) / 10);
}

export type PalSources = { chats: readonly ConvRow[]; artifacts: readonly ArtifactRow[]; projects?: readonly ProjectRow[]; prompts?: readonly PromptRow[]; /** may use cloud/agents/desktop/remote (server-decided scope policy; false = hidden) */ erichOnly: boolean; /** the OTHER space, offered as "Switch to ..." only when the server says this user has both */ switchTo?: "biz" | "open"; /** the active space is Open: Business-only destinations are left out */ openSpace?: boolean; /** the Devices feature answered /api/devices with 200 (404 = off): its entry is hidden otherwise */ devices?: boolean };

const BASE_ACTIONS: PalItem[] = [
  { id: "a:new", kind: "action", label: "New chat", act: "new-chat" },
  { id: "a:theme", kind: "action", label: "Toggle theme", act: "toggle-theme" },
  { id: "a:keys", kind: "action", label: "Keyboard shortcuts", act: "shortcuts" },
];
const NAV: Array<{ label: string; path: string; erich?: boolean; fromApp?: boolean; /** only for an account that has both spaces (the Settings row shows for them only) */ both?: boolean; devices?: boolean }> = [
  { label: "Chats", path: "/chats" }, { label: "Cloud", path: "/cloud", erich: true }, { label: "Agents", path: "/agents", erich: true },
  { label: "Desktop", path: "/desktop", erich: true }, { label: "Remote", path: "/remote", erich: true },
  { label: "Skills", path: "/skills", erich: true }, { label: "Projects", path: "/projects", erich: true }, { label: "Artifacts", path: "/artifacts", erich: true }, { label: "Library", path: "/library" }, { label: "Usage", path: "/usage" },
  { label: "Settings", path: "/settings", fromApp: true }, { label: "Settings: Profile", path: "/settings/profile", fromApp: true },
  { label: "Settings: Prompts", path: "/settings/prompts", fromApp: true }, { label: "Settings: Appearance", path: "/settings/appearance", fromApp: true }, { label: "Settings: Capabilities", path: "/settings/capabilities", erich: true, fromApp: true }, { label: "Settings: Providers", path: "/settings/providers", erich: true, fromApp: true },
  { label: "Settings: Connectors", path: "/connectors", erich: true, fromApp: true }, { label: "Settings: Devices", path: "/settings/devices", erich: true, devices: true, fromApp: true }, { label: "Settings: Approvals", path: "/settings/approvals", both: true, fromApp: true },
  { label: "Notifications", path: "/notifications", fromApp: true }, { label: "About", path: "/about", fromApp: true },
];

const BIZ_ONLY_PATHS = ["/cloud", "/agents", "/desktop", "/settings/devices"];
export const navItems = (erichOnly: boolean, open = false, both = false, devices = false): PalItem[] => NAV.filter((n) => (!n.erich || erichOnly) && (!n.both || both) && (!n.devices || devices) && !(open && BIZ_ONLY_PATHS.includes(n.path))).map((n) => ({ id: `n:${n.path}`, kind: "nav", label: n.label, path: n.path, fromApp: n.fromApp }));
export const chatItem = (c: ConvRow): PalItem => ({ id: `c:${c.id}`, kind: "chat", label: c.title || "New chat", path: `/c/${c.id}`, pinned: !!c.pinned, ...(c.match === "semantic" && c.snippet ? { hint: c.snippet } : {}) });
export const projectItem = (p: ProjectRow): PalItem => ({ id: `p:${p.id}`, kind: "project", label: p.name, path: `/projects/${p.id}`, fromApp: true });
export const promptItem = (p: PromptRow): PalItem => ({ id: `s:${p.id}`, kind: "prompt", label: p.title, act: "insert-prompt", text: p.text });
export const artifactItem = (a: ArtifactRow): PalItem => ({ id: `f:${a.id}`, kind: "artifact", label: a.title || "Untitled", hint: a.type, path: `/artifacts/${a.id}`, fromApp: true });

/** Items for query `q`. Empty query: New chat first, then the other actions, destinations and the most recent chats. With a query: every match ranked by score, capped. */
export function buildItems(q: string, src: PalSources, cap = 30): PalItem[] {
  const nav = navItems(src.erichOnly, src.openSpace === true, !!src.switchTo, src.devices === true);
  const ACTIONS = src.switchTo ? [...BASE_ACTIONS, { id: "a:space", kind: "action", label: `Switch to ${src.switchTo === "open" ? "Open" : "Business"}`, act: "switch-space" } as PalItem] : BASE_ACTIONS;
  if (!q.trim()) return [...ACTIONS, ...nav, ...src.chats.slice(0, 8).map(chatItem)];
  const seen = new Set<string>(), out: Array<{ it: PalItem; s: number }> = [];
  const add = (it: PalItem, bonus = 0) => { if (seen.has(it.id)) return; const s = fuzzyScore(q, it.label); if (s >= 0) { seen.add(it.id); out.push({ it, s: s + bonus }); } };
  for (const a of ACTIONS) add(a, 50);
  for (const n of nav) add(n, 30);
  for (const c of src.chats) add(chatItem(c), c.pinned ? 20 : 0);
  for (const a of src.artifacts) add(artifactItem(a));
  if (src.erichOnly) for (const p of src.projects ?? []) add(projectItem(p));
  for (const p of src.prompts ?? []) add(promptItem(p));
  return out.sort((x, y) => y.s - x.s).slice(0, cap).map((x) => x.it);
}

/** Arrow-key movement with wrap-around over `n` items (-1 = none yet). */
export const moveActive = (i: number, n: number, dir: 1 | -1): number => (n <= 0 ? -1 : i < 0 ? (dir === 1 ? 0 : n - 1) : (i + dir + n) % n);
