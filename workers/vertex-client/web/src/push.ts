import { call } from "./api";

export type PushState =
  | { kind: "unsupported"; reason: string }
  | { kind: "needs-install"; reason: string }
  | { kind: "not-configured" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on"; endpoint: string };

const b64uToBytes = (s: string) => { const t = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4); return Uint8Array.from(atob(t), (c) => c.charCodeAt(0)); };
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => (navigator as unknown as { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;

/** Decide what the Settings toggle can honestly offer on this device. Pure of side effects except reading the subscription. */
export async function pushState(): Promise<PushState> {
  if (isIos() && !standalone()) return { kind: "needs-install", reason: "On iPhone/iPad, notifications only work once the app is added to the Home Screen (Share → Add to Home Screen), then opened from there." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return { kind: "unsupported", reason: "This browser does not support Web Push." };
  const cfg = await call<{ publicKey: string | null }>("/api/push/config");
  if (cfg.status !== 200 || !cfg.data?.publicKey) return { kind: "not-configured" };
  if (Notification.permission === "denied") return { kind: "denied" };
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? { kind: "on", endpoint: sub.endpoint } : { kind: "off" };
}

/** MUST be called from a user tap (iOS requires it for the permission prompt). */
export async function enablePush(): Promise<{ ok: true } | { ok: false; error: string }> {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return { ok: false, error: perm === "denied" ? "Notifications are blocked for this site in the browser/OS settings." : "Permission was not granted." };
  const cfg = await call<{ publicKey: string | null }>("/api/push/config");
  if (!cfg.data?.publicKey) return { ok: false, error: "Push is not configured on the server." };
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(cfg.data.publicKey) }));
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const r = await call<{ error?: string }>("/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }) });
  if (r.status !== 201) { await sub.unsubscribe().catch(() => {}); return { ok: false, error: r.data?.error ?? `Server refused the subscription (${r.status})` }; }
  return { ok: true };
}

export async function disablePush(): Promise<void> {
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  if (!sub) return;
  await call("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe().catch(() => {});
}

export const sendTestPush = () => call<{ sent: number; failed: number; removed: number; errors: string[] }>("/api/push/test", { method: "POST", body: "{}" });
