// Pure model of the drawer: which entries are primary, which live in collapsible groups, the remembered expanded state, and the
// date buckets of the Recent list. No DOM (bun:test covers it directly); drawer.tsx only maps these to markup and icons.

export type DestKey = "chat" | "cloud" | "agents" | "desktop" | "remote" | "devices" | "skills" | "artifacts" | "library" | "projects" | "usage" | "about";
export type NavItem = { key: DestKey; label: string; path: string; tid: string; fromApp?: boolean };
export type GroupId = "workspaces";
/** A primary entry is a plain destination or a collapsible group of destinations (its own toggle row). */
export type NavEntry = ({ kind: "item" } & NavItem) | { kind: "group"; id: GroupId; label: string; tid: string; items: NavItem[] };
export type DrawerNav = { primary: NavEntry[] };

const item = (key: DestKey, label: string, path: string, tid: string, fromApp = false): NavItem => ({ key, label, path, tid, ...(fromApp ? { fromApp } : {}) });
const CHAT = item("chat", "Chats", "/chats", "menu-mode-chat");
const LIBRARY = item("library", "Library", "/library", "menu-library");
const PROJECTS = item("projects", "Projects", "/projects", "menu-projects");
const ARTIFACTS = item("artifacts", "Artifacts", "/artifacts", "menu-artifacts");
const DEVICES = item("devices", "Computers", "/computers", "menu-devices");
const WORKSPACES: NavItem[] = [
  item("agents", "Agents", "/agents", "menu-mode-agents"), item("cloud", "Cloud", "/cloud", "menu-mode-cloud"),
  item("desktop", "Desktop", "/desktop", "menu-mode-desktop"), item("remote", "Remote", "/remote", "menu-mode-remote"),
];
const BIZ_ONLY: DestKey[] = ["cloud", "agents", "desktop"]; // the server serves these in Business only

/** What the drawer lists for this account. Team-gateway (g:*) sessions get chat + library only: everything else is Erich-only (403 on the server). Usage, About, Theme, version and Skills live in Settings (and the palette), not in the drawer.
 *  `devices` = the Devices feature probe said yes (see devices-available.ts); without it there is no "Computers" row.
 *  Projects is also hidden until `me` says erichOnly (a dead link would only lead to a 403). */
export function drawerNav(me: { erichOnly?: boolean; team?: boolean } | null, space: "biz" | "open" = "biz", devices = false): DrawerNav {
  const main = me?.team !== true;
  const erich = main && me?.erichOnly === true;
  const primary: NavEntry[] = [{ kind: "item", ...CHAT }, { kind: "item", ...LIBRARY }];
  if (erich) primary.push({ kind: "item", ...PROJECTS });
  if (main) primary.push({ kind: "item", ...ARTIFACTS });
  if (erich && space === "biz" && devices) primary.push({ kind: "item", ...DEVICES }); // only where the Devices screens are reachable today: Erich, Business, flag on (the same probe as the Settings row)
  if (main) primary.push({ kind: "group", id: "workspaces", label: "Workspaces", tid: "drawer-group-workspaces", items: space === "open" ? WORKSPACES.filter((i) => !BIZ_ONLY.includes(i.key)) : WORKSPACES });
  return { primary };
}

/** Number of top-level rows in the primary list (a group counts as one). */
export const primaryCount = (n: DrawerNav) => n.primary.length;
/** Group a destination belongs to, null for a primary item. */
export const groupOf = (n: DrawerNav, key: string | null): GroupId | null => {
  if (!key) return null;
  for (const e of n.primary) if (e.kind === "group" && e.items.some((i) => i.key === key)) return e.id;
  return null;
};

// ---- remembered expanded state: per device, localStorage, every access guarded (private mode / quota / disabled storage) ----
export const SECTIONS_KEY = "vc.drawer.sections";
export type Sections = Partial<Record<GroupId, boolean>>;
type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
export function loadSections(store: Store | null = defaultStore()): Sections {
  try {
    const v: unknown = JSON.parse(store?.getItem(SECTIONS_KEY) ?? "null");
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    const out: Sections = {};
    for (const id of ["workspaces"] as const) if (typeof o[id] === "boolean") out[id] = o[id];
    return out;
  } catch { return {}; }
}
export function saveSections(s: Sections, store: Store | null = defaultStore()): boolean {
  try { if (!store) return false; store.setItem(SECTIONS_KEY, JSON.stringify(s)); return true; } catch { return false; }
}
/** Is a group open? The group holding the CURRENT screen is open on entering that route whatever was persisted (a deep link / reload must show where you are);
 *  `dismissed` = the user collapsed it after arriving, respected until the route changes. Any other group: the explicit remembered choice, else open on the roomy desktop sidebar. */
export const groupOpen = (s: Sections, id: GroupId, hasCurrent: boolean, roomy: boolean, dismissed = false): boolean => (hasCurrent ? !dismissed : s[id] ?? roomy);

// ---- Recent: date buckets by local calendar day ----
export type Bucket = "today" | "yesterday" | "week" | "older";
export const BUCKET_LABEL: Record<Bucket, string> = { today: "Today", yesterday: "Yesterday", week: "Previous 7 days", older: "Older" };
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
/** Bucket of a timestamp relative to `now`. Future timestamps count as today; unparseable ones as Older (never merged into Today by accident). */
export function bucketOf(iso: string, now: Date): Bucket {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "older";
  const days = Math.round((dayStart(now) - dayStart(new Date(t))) / 864e5); // calendar days, DST-safe
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days <= 7 ? "week" : "older";
}
export const BUCKET_ORDER: readonly Bucket[] = ["today", "yesterday", "week", "older"];
/** Split rows into one group per bucket in the fixed order Today / Yesterday / Previous 7 days / Older (empty ones omitted); each keeps its rows' input order, so unsorted input still gives unique, canonical groups. */
export function groupByBucket<T extends { updatedAt: string }>(rows: readonly T[], now: Date): Array<{ bucket: Bucket; label: string; rows: T[] }> {
  const by = new Map<Bucket, T[]>();
  for (const r of rows) { const b = bucketOf(r.updatedAt, now); const l = by.get(b); if (l) l.push(r); else by.set(b, [r]); }
  return BUCKET_ORDER.filter((b) => by.has(b)).map((bucket) => ({ bucket, label: BUCKET_LABEL[bucket], rows: by.get(bucket)! }));
}
/** Milliseconds until the next local midnight (+1s so the clock is surely on the new day); the buckets are re-evaluated then. */
export const msUntilMidnight = (now: Date): number => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime() + 1000;
/** The drawer first shows RECENT_PREVIEW rows; "Show all" / "Show more" then grow the window by RECENT_PAGE at a time (never thousands of rows mounted at once). */
export const RECENT_PREVIEW = 12;
export const RECENT_PAGE = 50;
export const previewRows = <T>(rows: readonly T[], limit = RECENT_PREVIEW): T[] => rows.slice(0, limit);
export const nextLimit = (limit: number): number => (limit <= RECENT_PREVIEW ? RECENT_PREVIEW + RECENT_PAGE : limit + RECENT_PAGE);
