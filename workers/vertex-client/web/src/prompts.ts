// Saved prompts, client side: the list the slash menu uses, and the one-way bus the palette uses to put a prompt into the composer.
import { useEffect, useState } from "preact/hooks";
import { listPrompts } from "./api";
import { promptSlashItems, readClipboard, resolvePlaceholders, usesClipboard } from "./prompts-logic";
import type { SlashItem } from "../../src/slash";

/** Slash-menu items for the saved prompts. Refetched on window focus (like the rest of the catalogue); a failure (g:* is 403, offline) just means none. */
export function usePromptItems(): SlashItem[] {
  const [items, setItems] = useState<SlashItem[]>([]);
  useEffect(() => {
    const load = () => { void listPrompts().then((r) => setItems(r.status === 200 && r.data ? promptSlashItems(r.data.prompts) : [])).catch(() => {}); };
    load(); addEventListener("focus", load);
    return () => removeEventListener("focus", load);
  }, []);
  return items;
}

/** Placeholders resolved right now; the clipboard is read only when the text asks for it. */
export async function resolvePrompt(text: string): Promise<string> {
  return resolvePlaceholders(text, { clipboard: usesClipboard(text) ? await readClipboard() : "", now: new Date() });
}

// Palette -> composer. `pending` survives a navigation to the start screen (the composer mounts after the click); a mounted composer takes it at once.
const EVENT = "vc:insert-prompt";
let pending: string | null = null;
export const composerMounted = () => !!document.querySelector("footer.composer textarea");
export function requestInsertPrompt(text: string): void { pending = text; dispatchEvent(new Event(EVENT)); }
/** Calls `put(resolved)` for a prompt the palette queued (now, or when this composer mounts). */
export function useInsertPromptRequest(put: (resolved: string) => void): void {
  useEffect(() => {
    const take = () => { const t = pending; if (t === null) return; pending = null; void resolvePrompt(t).then(put); };
    take(); addEventListener(EVENT, take);
    return () => removeEventListener(EVENT, take);
  }, []);
}
