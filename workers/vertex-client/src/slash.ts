// Slash menu catalogue, shared by the Worker (/api/slash) and the web app (ranking). Pure: no I/O.
import { classify } from "./tools";

export interface SlashItem { kind: "tool" | "builtin" | "skill" | "prompt"; name: string; description: string; group: string; approval?: boolean; disabled?: string; /** saved prompt: the text inserted on pick (client-side only, never sent by /api/slash) */ text?: string }
export interface SlashTool { name: string; description: string; group?: string; approval: boolean }

/** Client-only. Only what the app can already do is enabled; the rest is listed disabled with the reason (no invented features). */
export const BUILTINS: SlashItem[] = [
  { kind: "builtin", name: "model", description: "Choose the model for this chat", group: "Commands" },
  { kind: "builtin", name: "image", description: "Switch the composer to Image mode", group: "Commands" },
  { kind: "builtin", name: "video", description: "Switch the composer to Video mode", group: "Commands" },
  { kind: "builtin", name: "advisor", description: "Ask a senior second opinion (Opus) on this conversation", group: "Commands" },
  { kind: "builtin", name: "clear", description: "Clear this conversation", group: "Commands", disabled: "Not available yet: the app has no clear-conversation feature (delete the chat instead)" },
];

/** Never listed: tools the client does not classify (unknown = no consent) and list_agents (registered, deliberately hidden). */
const HIDDEN = new Set(["list_agents"]);

export function slashItems(tools: SlashTool[], only: Set<string> | null = null, skills: SlashItem[] = []): SlashItem[] {
  const t = tools
    .filter((x) => x && typeof x.name === "string" && classify(x.name) && !HIDDEN.has(x.name) && (!only || only.has(x.name)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((x): SlashItem => ({ kind: "tool", name: x.name, description: x.description ?? "", group: x.group || "personal-connector", approval: classify(x.name) === "approval" }));
  // A builtin wins over a same-named user skill (e.g. an old skill `advisor`): the skill is not offered here, but stays in Skills (edit/delete).
  const builtin = new Set(BUILTINS.map((b) => b.name));
  return [...t, ...skills.filter((x) => x.kind === "skill" && !builtin.has(x.name)), ...BUILTINS];
}

/** Text that opens the menu: `/word` at the start, or `/word` after whitespace at the end. Returns the query after `/`, else null. */
export function slashQuery(text: string): string | null {
  const m = /^\/(\S*)$/.exec(text) ?? /\s\/(\S*)$/.exec(text);
  return m ? m[1] : null;
}

/** prefix > substring > recently used; no match drops the item. Empty query = recents first, then catalogue order. */
export function rankSlash(items: SlashItem[], query: string, recent: string[] = []): SlashItem[] {
  const q = query.toLowerCase();
  const rec = (n: string) => { const i = recent.indexOf(n); return i < 0 ? Infinity : i; };
  return items
    .map((it, i) => ({ it, i, s: q ? (it.name.toLowerCase().startsWith(q) ? 0 : it.name.toLowerCase().includes(q) ? 1 : 2) : 0 }))
    .filter((x) => x.s < 2)
    .sort((a, b) => a.s - b.s || rec(a.it.name) - rec(b.it.name) || a.i - b.i)
    .map((x) => x.it);
}

const KEY = "vc.slash.recent";
export function loadRecent(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 20) : []; } catch { return []; }
}
export function pushRecent(name: string): void {
  try { localStorage.setItem(KEY, JSON.stringify([name, ...loadRecent().filter((n) => n !== name)].slice(0, 20))); } catch { /* storage blocked */ }
}

export const SLASH_MAX_ROWS = 8;
/** Top rows after ranking, regrouped so each group is contiguous (groups ordered by their best-ranked row). Arrow keys walk this order. */
export function slashRows(items: SlashItem[], query: string, recent: string[] = []): SlashItem[] {
  const top = rankSlash(items, query, recent).slice(0, SLASH_MAX_ROWS);
  const order: string[] = [];
  for (const it of top) if (!order.includes(it.group)) order.push(it.group);
  return order.flatMap((g) => top.filter((it) => it.group === g));
}

export const ADVISOR_DEFAULT_QUESTION = "Review the conversation so far.";
/** `/advisor <question>` (or `/advisor` alone) -> the exact text of `@advisor <question>`, so it takes the same path and hint; other text is returned as is. */
export function advisorAlias(text: string): string {
  const m = /^\/advisor(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? `@advisor ${(m[1] ?? "").trim() || ADVISOR_DEFAULT_QUESTION}` : text;
}
