// Approval modes UI: card buttons, the "Auto-allowed ..." audit line, the composer Ask/Auto chip, and the in-chat allowed-hosts line.
import { useEffect, useState } from "preact/hooks";
import type { AutoLogEntry } from "./chat-state";
import { useEscape } from "./confirm";
import { BYPASS_SKIPS, BYPASS_STILL_ASKS, BYPASS_TITLE, MODE_INFO, SOURCE_NOTE, autoLine, chipAria, chipLabel, expiryNote, offeredModes, type Mode } from "./approval-logic";

/** Approve / Deny, plus (for a browse call with an eligible host) the two grant buttons. The host shown is the one the server derived from the parked call. */
export function ApprovalButtons({ id, host, canAlways, reason, expiresAt, onDecide }: { id: string; host: string | null; reason?: string | null; canAlways: boolean; expiresAt?: number | null; onDecide: (id: string, d: "approve" | "deny", grant?: "once" | "chat" | "user") => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  const note = expiryNote(expiresAt, now);
  return (
    <div data-testid="approval">
      {reason && <div class="small" role="note" data-testid="approval-reason">{reason}</div>}
      <div class="approve">
        <button class="btn primary" data-testid="approve-once" onClick={() => onDecide(id, "approve")}>{host ? "Approve once" : "Approve"}</button>
        <button class="btn" data-testid="deny" onClick={() => onDecide(id, "deny")}>Deny</button>
      </div>
      {host && (
        <div class="approve grants">
          <button class="btn" data-testid="allow-chat" onClick={() => onDecide(id, "approve", "chat")}>Allow {host} in this chat</button>
          {canAlways && <button class="btn" data-testid="allow-always" onClick={() => onDecide(id, "approve", "user")}>Always allow {host}</button>}
        </div>
      )}
      {note && <div class="muted small" data-testid="approval-expiry">{note}. After 30 minutes the request is cancelled and nothing runs.</div>}
    </div>
  );
}

/** One line in the chat for every automatically approved call. */
export function AutoLine({ e }: { e: AutoLogEntry }) {
  return <div class="autoline muted small" role="note" data-testid="auto-allowed" data-source={e.source} title={SOURCE_NOTE[e.source]}>{autoLine(e)}</div>;
}

/** Composer mode picker (replaces the Ask/Auto chip): one pill showing the chat's mode; tapping opens the three-way choice. Bypass shows in the warning colour for as long as it is on. */
export function ApprovalChip({ mode, disabled, approvalAuto, onPick }: { mode: Mode; disabled: boolean; approvalAuto: boolean; onPick: (m: Mode) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button class={`pill apchip${mode !== "ask" ? " on" : ""}${mode === "bypass" ? " bypass" : ""}`} type="button" data-testid="approval-chip" data-mode={mode} aria-haspopup="dialog" aria-expanded={open} aria-label={chipAria(mode)} disabled={disabled} onClick={() => setOpen(true)}><span class="pill-l">{chipLabel(mode)}</span></button>
      {open && <ModeSheet mode={mode} modes={offeredModes({ approvalAuto, mode })} onPick={(m) => { setOpen(false); if (m !== mode) onPick(m); }} onClose={() => setOpen(false)} />}
    </>
  );
}

function ModeSheet({ mode, modes, onPick, onClose }: { mode: Mode; modes: Mode[]; onPick: (m: Mode) => void; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div class="scrim" onClick={onClose} data-testid="mode-scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Approval mode" onClick={(e) => e.stopPropagation()} data-testid="mode-sheet">
        <h3 class="confirm-title">Approval mode</h3>
        <div role="radiogroup" aria-label="Approval mode" class="modelist">
          {modes.map((m) => (
            <button type="button" role="radio" aria-checked={mode === m} class={`row mode-row${m === "bypass" ? " bypass" : ""}`} data-testid={`mode-${m}`} onClick={() => onPick(m)}>
              <strong>{MODE_INFO[m].label.en}{MODE_INFO[m].label.vi !== MODE_INFO[m].label.en ? ` / ${MODE_INFO[m].label.vi}` : ""}</strong>
              <span class="muted small">{MODE_INFO[m].desc.en}<br /><span lang="vi">{MODE_INFO[m].desc.vi}</span></span>
            </button>
          ))}
        </div>
        <div class="approve"><button class="btn" onClick={onClose} data-testid="mode-close">Close</button></div>
      </div>
    </div>
  );
}

/** The strong first-time confirmation for Bypass: what it skips and what still asks, in English and Vietnamese. */
export function BypassSheet({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  useEscape(onCancel);
  return (
    <div class="scrim" onClick={onCancel} data-testid="confirm-scrim">
      <div class="sheet" role="alertdialog" aria-modal="true" aria-label={BYPASS_TITLE.en} onClick={(e) => e.stopPropagation()} data-testid="bypass-sheet">
        <h3 class="confirm-title">{BYPASS_TITLE.en}<br /><span lang="vi">{BYPASS_TITLE.vi}</span></h3>
        <p class="small" data-testid="bypass-skips"><strong>Skips / Bỏ qua:</strong> {BYPASS_SKIPS.en}<br /><span lang="vi">{BYPASS_SKIPS.vi}</span></p>
        <p class="small" data-testid="bypass-asks"><strong>Still asks / Vẫn hỏi:</strong> {BYPASS_STILL_ASKS.en}<br /><span lang="vi">{BYPASS_STILL_ASKS.vi}</span></p>
        <div class="approve">
          <button class="btn" onClick={onCancel} data-testid="confirm-cancel">Cancel / Hủy</button>
          <button class="btn danger" onClick={onConfirm} data-testid="confirm-ok">Turn on Bypass / Bật Bypass</button>
        </div>
      </div>
    </div>
  );
}

/** Hosts allowed for this chat only, each with a way to take it back. */
export function GrantsLine({ hosts, onRevoke }: { hosts: string[]; onRevoke: (h: string) => void }) {
  return (
    <div class="grantsline muted small" data-testid="chat-grants">
      <span>Allowed in this chat:</span>
      {hosts.map((h) => <span class="gchip" key={h}>{h}<button type="button" class="gx" data-testid="revoke-chat-grant" aria-label={`Stop allowing ${h} in this chat`} onClick={() => onRevoke(h)}>×</button></span>)}
    </div>
  );
}
