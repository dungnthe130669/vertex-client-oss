import { useEffect, useState } from "preact/hooks";

export type Toast = { id: number; text: string; kind: "info" | "error"; action?: { label: string; run: () => void }; sticky?: boolean };
let items: Toast[] = []; let seq = 0;
const subs = new Set<(t: Toast[]) => void>();
const emit = () => subs.forEach((f) => f(items));

export function dismiss(id: number) { items = items.filter((t) => t.id !== id); emit(); }
export function toast(text: string, o: { kind?: Toast["kind"]; action?: Toast["action"]; sticky?: boolean } = {}): number {
  const t: Toast = { id: ++seq, text, kind: o.kind ?? "info", action: o.action, sticky: o.sticky };
  items = [...items.filter((x) => x.text !== text), t]; emit();
  if (!t.sticky) setTimeout(() => dismiss(t.id), t.action ? 12000 : 5000);
  return t.id;
}
/** Error toast with a Retry button; the toast goes away when the retry is pressed. */
export const errorToast = (text: string, retry?: () => void) =>
  toast(text, { kind: "error", action: retry ? { label: "Retry", run: retry } : undefined });

export function Toasts() {
  const [list, setList] = useState<Toast[]>(items);
  useEffect(() => { subs.add(setList); return () => { subs.delete(setList); }; }, []);
  // the live region stays mounted (empty) so a toast inserted into it is announced; an error toast is also role=alert (assertive)
  return (
    <div class="toasts" role="status" aria-live="polite" aria-relevant="additions text">
      {list.map((t) => (
        <div class={`toast ${t.kind}`} key={t.id} role={t.kind === "error" ? "alert" : undefined}>
          <span>{t.text}</span>
          {t.action && <button class="btn small" onClick={() => { dismiss(t.id); t.action!.run(); }}>{t.action.label}</button>}
          <button class="icon x" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
