// Settings > Providers key box: badge text and the save/remove flow. Kept apart from the component so a test can drive it against the real server handlers.
// The key value is only ever a parameter here: it is not stored, logged or returned.
import type { ProviderInfo } from "./api";

type Res = { status: number; data: { ok?: boolean; key_source?: string; error?: string } | null };
export const keyBadge = (p: Pick<ProviderInfo, "key_source" | "keySet" | "status" | "enabled">): string =>
  p.key_source === "stale" ? "Re-enter key" : p.key_source === "user" ? "Ready (your key)" : p.key_source === "worker" || (p.key_source === undefined && p.keySet) ? "Ready (shared)" : "No key";
export const keyNote = (p: Pick<ProviderInfo, "key_source" | "keySet">, secretName: string): string =>
  p.key_source === "stale" ? "This provider's URL changed since your key was saved, so the key is not used. Paste it again below." : p.key_source === "user" ? "Using your key (stored encrypted; it cannot be shown again)." : p.keySet ? "Using the shared key (Worker secret). Paste your own below to use it instead." : `No key yet. Paste yours below, or an admin can run: wrangler secret put ${secretName}`;

/** value === null removes the stored key; otherwise saves it. Resolves to a note on success or an error message. */
export async function saveKeyFlow(id: string, value: string | null, api: { put(id: string, key: string): Promise<Res>; del(id: string): Promise<Res> }): Promise<{ note: string; error: string | null }> {
  const r = value === null ? await api.del(id) : await api.put(id, value.trim());
  if (r.status === 200) return { error: null, note: value === null ? (r.data?.key_source === "worker" ? "Your key was removed; the shared key is used." : "Your key was removed.") : "Key saved." };
  if (r.status === 429) return { note: "", error: "Too many changes, wait a minute and try again." };
  return { note: "", error: r.data?.error ?? `Could not ${value === null ? "remove" : "save"} the key (${r.status})` };
}
