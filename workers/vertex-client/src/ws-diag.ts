// Diagnostics for WebSocket close/error on the chat DO: one JSON line per event (wrangler tail). No user text, no tokens.
export type WsDiagInput = { ev: "ws_close" | "ws_error"; conv: string; code?: number; reason?: string; wasClean?: boolean; colo?: string | null; lastTurnEnd: number | null; turnActive: boolean; now: number; sockets: number };

/** Pure: builds the log record. `reason` is truncated to 120 chars; `sinceTurnEndMs` is null when no turn has ended yet. */
export function wsDiagRecord(i: WsDiagInput) {
  return {
    ev: i.ev, conv: i.conv,
    ...(i.code !== undefined ? { code: i.code } : {}),
    ...(i.reason !== undefined ? { reason: String(i.reason).slice(0, 120) } : {}),
    ...(i.wasClean !== undefined ? { wasClean: i.wasClean } : {}),
    colo: i.colo ?? null,
    sinceTurnEndMs: i.lastTurnEnd === null ? null : Math.max(0, i.now - i.lastTurnEnd),
    turnActive: i.turnActive, sockets: i.sockets, ts: i.now,
  };
}
export const wsDiagLine = (i: WsDiagInput) => JSON.stringify(wsDiagRecord(i));
