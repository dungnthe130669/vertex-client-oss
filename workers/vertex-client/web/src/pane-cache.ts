// Stale-while-revalidate cache for settings-pane data: a remounted pane renders the last data at once and refreshes quietly.
// The key always carries the active space, and the whole cache is dropped on space switch, sign-out and CSRF reset (= new session),
// so one user's / space's rows can never show in another.
import { getSpace } from "./space";

const store = new Map<string, unknown>();
let gen = 0; // bumped by every clear: a response that started before it must not repopulate the cache
const issued = new Map<string, number>(); // per-key monotonic request sequence
const committed = new Map<string, number>(); // highest sequence already stored per key: an older request must not overwrite it
export type PaneToken = { gen: number; key: string; seq: number };
/** Capture at the START of a fetch; putPane drops the result if the cache was cleared or the space changed since. */
export const paneToken = (endpoint: string): PaneToken => {
  const key = paneKey(endpoint);
  const seq = (issued.get(key) ?? 0) + 1;
  issued.set(key, seq);
  return { gen, key, seq };
};
export const paneKey = (endpoint: string): string => `${getSpace()}|${endpoint}`;

/** Last data for this endpoint in the current space, or null (first load ever: show the skeleton). */
export const peekPane = <T>(endpoint: string): T | null => (store.has(paneKey(endpoint)) ? (store.get(paneKey(endpoint)) as T) : null);
/** Stores data unless stale (cache cleared / space switched / a newer request already stored since the token was taken). Returns whether it was stored: callers also skip setState when false. */
export const putPane = (endpoint: string, data: unknown, tok: PaneToken = paneToken(endpoint)): boolean => {
  if (tok.gen !== gen || tok.key !== paneKey(endpoint)) return false;
  if (tok.seq < (committed.get(tok.key) ?? 0)) return false; // a newer request / local write already landed
  committed.set(tok.key, tok.seq);
  store.set(tok.key, data);
  return true;
};
export const clearPaneCache = (): void => { gen++; store.clear(); issued.clear(); committed.clear(); };
