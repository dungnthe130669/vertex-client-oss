// Pure logic for the Remote list (no DOM, no network).
const SHOWN = 20;
/** Live/recent sessions first (stable), then stale history; only the first SHOWN rows (never fewer than all non-stale ones) unless expanded. */
export function splitRemoteRows<T extends { stale: boolean }>(rows: T[], all: boolean): { shown: T[]; hidden: number } {
  const ordered = [...rows.filter((r) => !r.stale), ...rows.filter((r) => r.stale)];
  const live = rows.filter((r) => !r.stale).length;
  if (all) return { shown: ordered, hidden: 0 };
  const n = Math.max(SHOWN, live);
  return { shown: ordered.slice(0, n), hidden: Math.max(0, ordered.length - n) };
}
