// Shared client state of the Open failover settings, for the always-visible composer line. Fail VISIBLE: `null` = not confirmed by the server, and the line shows unless the
// server CONFIRMED failover OFF. A failed fetch never overwrites a known value and never hides the line. The Settings toggles push their new value here (no reload needed).
export interface FailoverState { failover: boolean | null; aistudio: boolean | null }
export const FAILOVER_BANNER = "If a model fails, this chat may be sent to another Open provider (NVIDIA, Groq). Policies: Settings.";
export const AISTUDIO_BANNER = "Google AI Studio may be used (Google may use your conversation to improve its products).";
/** The base line unless failover is confirmed OFF; the AI Studio sentence only when that fallback is confirmed ON. */
export const failoverBanner = (failover: boolean | null, aistudio: boolean | null): string => (failover === false ? "" : aistudio === true ? `${FAILOVER_BANNER} ${AISTUDIO_BANNER}` : FAILOVER_BANNER);

let state: FailoverState = { failover: null, aistudio: null };
const subs = new Set<(s: FailoverState) => void>();
export const failoverState = () => state;
export function setFailoverState(p: Partial<FailoverState>) { state = { ...state, ...p }; for (const f of [...subs]) f(state); }
export function subscribeFailover(f: (s: FailoverState) => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
type Got = Promise<{ status: number; data?: { enabled: boolean } | null }>;
/** Re-read both settings; anything that is not a clean 200 leaves the previous value untouched. */
export async function refreshFailover(get: { failover: () => Got; aistudio: () => Got }): Promise<void> {
  const ok = async (g: () => Got) => { try { const r = await g(); return r.status === 200 && typeof r.data?.enabled === "boolean" ? r.data.enabled : undefined; } catch { return undefined; } };
  const [f, a] = await Promise.all([ok(get.failover), ok(get.aistudio)]);
  setFailoverState({ ...(f !== undefined ? { failover: f } : {}), ...(a !== undefined ? { aistudio: a } : {}) });
}
export const resetFailoverState = () => { state = { failover: null, aistudio: null }; subs.clear(); };
