import { useEffect } from "preact/hooks";

/** Escape closes the topmost sheet (keyboard users on desktop). */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
}

// In-app confirmation sheet (replaces native confirm(): unstyled, blocks the main thread, and Playwright must special-case it).
export function ConfirmSheet({ title, body, confirmLabel = "Delete", danger = true, onConfirm, onCancel }: { title: string; body?: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onCancel: () => void }) {
  useEscape(onCancel);
  return (
    <div class="scrim" onClick={onCancel} data-testid="confirm-scrim">
      <div class="sheet" role="alertdialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} data-testid="confirm-sheet">
        <h3 class="confirm-title">{title}</h3>
        {body && <p class="muted small">{body}</p>}
        <div class="approve">
          <button class="btn" onClick={onCancel} data-testid="confirm-cancel">Cancel</button>
          <button class={danger ? "btn danger" : "btn primary"} onClick={onConfirm} data-testid="confirm-ok" autoFocus>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
