// Pure pieces of saved prompts: placeholder resolution, the slash-menu items and the composer text a pick produces. No DOM; the clipboard is passed in.
import type { SavedPrompt } from "../../src/prompts";
import type { SlashItem } from "../../src/slash";

export const PROMPT_GROUP = "Prompts";

const pad = (n: number) => String(n).padStart(2, "0");
/** `{{date}}` -> local date as YYYY-MM-DD. */
export const todayLocal = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Resolves `{{clipboard}}` and `{{date}}` (case-insensitive, inner spaces allowed). Replacement text is inserted literally, so a `$&` in the clipboard stays as typed. */
export function resolvePlaceholders(text: string, ctx: { clipboard: string; now: Date }): string {
  return text.replace(/\{\{\s*(clipboard|date)\s*\}\}/gi, (_, k: string) => (k.toLowerCase() === "date" ? todayLocal(ctx.now) : ctx.clipboard));
}
export const usesClipboard = (text: string): boolean => /\{\{\s*clipboard\s*\}\}/i.test(text);

/** The slash-menu name for a title: lowercase, runs of anything but letters/digits become `-` (Vietnamese letters stay). Duplicates get `-2`, `-3`… */
export function promptSlashNames(titles: string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((t) => {
    const base = t.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "prompt";
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

const oneLine = (s: string, max = 80) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
export function promptSlashItems(prompts: readonly SavedPrompt[]): SlashItem[] {
  const names = promptSlashNames(prompts.map((p) => p.title));
  return prompts.map((p, i): SlashItem => ({ kind: "prompt", name: names[i], description: `${p.title}: ${oneLine(p.text)}`, group: PROMPT_GROUP, text: p.text }));
}

/** The composer text after picking a prompt from the slash menu: what was typed before the `/query`, then the resolved text. */
export function insertPrompt(composer: string, resolved: string): string {
  const at = composer.lastIndexOf("/");
  const base = (at < 0 ? composer : composer.slice(0, at)).trimEnd();
  return base ? `${base} ${resolved}` : resolved;
}

/** Reads the clipboard only when the prompt asks for it; a denied or unsupported clipboard resolves to "" (the prompt still inserts). */
export async function readClipboard(): Promise<string> {
  try { return (await navigator.clipboard?.readText?.()) ?? ""; } catch { return ""; }
}
