import { createPortal } from "preact/compat";
import { useContext, useEffect, useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";
import { MENU_CLOSED, MENU_CLOSE_MS, MENU_OPEN_MS, menuReducer, menuShown, type MenuState } from "./menu-logic";
import { MeCtx } from "./drawer";
import { deleteConversation, getConversation, pinConversation, renameConversation } from "./api";
import { withBusy } from "./busy";
import { ConfirmSheet, useEscape } from "./confirm";
import { IconChevronDown, IconMore } from "./icons";
import { type Msg, fromServer } from "./chat-state";
import { exportFileName, exportJson, exportMarkdown } from "./library-logic";
import { MoveSheet } from "./projects";
import { errorToast } from "./toast";

export type RowEdit = { title?: string; pinned?: boolean; projectId?: string | null };
type Conv = { id: string; title: string; pinned?: boolean };

/** A successful edit (pin / rename) is announced to every view that holds its own copy of the conversation (sidebar rows, the open chat). */
export const CONV_EDIT_EVENT = "vc:conv-edit";
export type ConvEdit = RowEdit & { id: string };
export const publishConvEdit = (e: ConvEdit) => dispatchEvent(new CustomEvent<ConvEdit>(CONV_EDIT_EVENT, { detail: e }));
/** Subscribe to edits published by any entry point; returns the unsubscribe. */
export function onConvEdit(fn: (e: ConvEdit) => void): () => void {
  const h = (ev: Event) => { const d = (ev as CustomEvent<ConvEdit>).detail; if (d && typeof d.id === "string") fn(d); };
  addEventListener(CONV_EDIT_EVENT, h);
  return () => removeEventListener(CONV_EDIT_EVENT, h);
}

/** Saves text as a file download (object URL, revoked after 10 s). */
export const downloadText = (name: string, mime: string, body: string) => {
  const url = URL.createObjectURL(new Blob([body], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

/** The one implementation of the chat actions behind the shared Chat actions menu (drawer / sidebar rows, the Chats list and the chat header):
 *  pin, delete, rename and export, each with its busy lock and error toast. `onEdit` / `onRemoved` let the owner of the row update its copy. */
export function useConvOps(c: Conv, cb0: { onEdit: (e: RowEdit) => void; onRemoved: () => void }) {
  const cb = { ...cb0, onEdit: (e: RowEdit) => { cb0.onEdit(e); publishConvEdit({ id: c.id, ...e }); } };
  const pin = async () => {
    const next = !c.pinned;
    try { const r = await withBusy("conv-pin", () => pinConversation(c.id, next)); if (r.status === 200) cb.onEdit({ pinned: next }); else errorToast(`Could not ${next ? "pin" : "unpin"} (${r.status})`, () => void pin()); }
    catch { errorToast("Could not update (offline?)", () => void pin()); }
  };
  const remove = async () => {
    try { const d = await withBusy("conv-delete", () => deleteConversation(c.id)); if (d.status === 200) cb.onRemoved(); else errorToast(`Could not delete (${d.status})`, () => void remove()); }
    catch { errorToast("Could not delete (offline?)", () => void remove()); }
  };
  const rename = async (v: string) => {
    const t = v.trim().slice(0, 120);
    if (!t || t === c.title) return;
    try { const r = await withBusy("conv-rename", () => renameConversation(c.id, t)); if (r.status === 200) cb.onEdit({ title: t }); else errorToast(`Could not rename (${r.status})`, () => void rename(t)); }
    catch { errorToast("Could not rename (offline?)", () => void rename(t)); }
  };
  /** `msgs` = the messages when the caller already has them (the open chat); otherwise they are fetched. */
  const exportAs = async (kind: "md" | "json", msgs?: readonly Msg[]) => {
    let m = msgs;
    if (!m) {
      const r = await getConversation(c.id).catch(() => null);
      if (!r || r.status !== 200 || !r.data) { errorToast("Could not export", () => void exportAs(kind)); return; }
      m = fromServer(r.data.state).messages;
    }
    const title = c.title || "Chat";
    downloadText(exportFileName(title, kind), kind === "md" ? "text/markdown" : "application/json", kind === "md" ? exportMarkdown(title, m) : exportJson(title, m));
  };
  return { pin, remove, rename, exportAs };
}

/** The shared Chat actions menu: [Chat info (header only)], Rename, Pin / Unpin, Move to project… (Erich), Export…, Delete. Same words, order and test ids at every entry point. */
export function ChatMenu({ at, pinned, hover, focusFirst = true, passive = false, onClose, onInfo, onRename, onPin, onMove, onExport, onDelete }: { at: { x: number; y: number }; pinned: boolean; focusFirst?: boolean; /** hover-opened and not pinned: the scrim lets the pointer through, so a pointer parked on the trigger keeps it open */ passive?: boolean; hover?: { onPointerEnter?: (e: PointerEvent) => void; onPointerLeave?: (e: PointerEvent) => void; onFocusIn?: (e: FocusEvent) => void; onFocusOut?: (e: FocusEvent) => void }; onClose: () => void; onInfo?: () => void; onRename: () => void; onPin: () => void; onMove: () => void; onExport: () => void; onDelete: () => void }) {
  const erichOnly = useContext(MeCtx)?.erichOnly === true;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: at.x, top: at.y });
  useLayoutEffect(() => { // keep the popover on screen: right-aligned to the point when it would overflow, flipped above near the bottom
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = innerWidth, vh = innerHeight;
    setPos({ left: Math.max(8, Math.min(at.x - (at.x + w > vw - 8 ? w : 0), vw - w - 8)), top: at.y + h > vh - 8 ? Math.max(8, at.y - h - 8) : at.y });
  }, []);
  useLayoutEffect(() => { if (focusFirst) ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }, [focusFirst]); // a hover-opened menu does not steal focus; pinning it (click) moves focus in
  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Tab") { e.preventDefault(); onClose(); }
  };
  return (
    <div class={`cmenu-root${passive ? " passive" : ""}`} data-testid="chat-menu-root">
      <div class="cmenu-scrim" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div ref={ref} class="cmenu" role="menu" aria-label="Chat actions" style={{ left: `${pos.left}px`, top: `${pos.top}px` }} onKeyDown={onKey} data-testid="chat-menu" {...hover}>
        {onInfo && <button class="cmenu-item" role="menuitem" data-testid="chat-menu-info" onClick={onInfo}>Chat info</button>}
        <button class="cmenu-item" role="menuitem" data-testid="chat-menu-rename" onClick={onRename}>Rename</button>
        <button class="cmenu-item" role="menuitem" data-testid="chat-menu-pin" onClick={onPin}>{pinned ? "Unpin" : "Pin"}</button>
        {erichOnly && <button class="cmenu-item" role="menuitem" data-testid="chat-menu-move" onClick={onMove}>Move to project…</button>}
        <button class="cmenu-item" role="menuitem" data-testid="chat-menu-export" onClick={onExport}>Export…</button>
        <button class="cmenu-item danger" role="menuitem" data-testid="chat-menu-delete" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}

/** "Export…": pick the format. */
export function ExportSheet({ onPick, onClose }: { onPick: (k: "md" | "json") => void; onClose: () => void }) {
  useEscape(onClose);
  return (
    <div class="scrim" onClick={onClose} data-testid="export-scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Export chat" onClick={(e) => e.stopPropagation()} data-testid="export-sheet">
        <div class="grabber" />
        <h3 class="confirm-title">Export chat</h3>
        <div class="approve">
          <button class="btn" type="button" data-testid="export-md" onClick={() => onPick("md")}>Export Markdown</button>
          <button class="btn" type="button" data-testid="export-json" onClick={() => onPick("json")}>Export JSON</button>
        </div>
        <button class="btn" type="button" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** Rename from outside a list row (the chat header): a small sheet with the same 120-char field. */
export function RenameSheet({ initial, onSave, onClose }: { initial: string; onSave: (v: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEscape(onClose);
  useLayoutEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const save = () => onSave(ref.current?.value ?? "");
  return (
    <div class="scrim" onClick={onClose} data-testid="rename-scrim">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Rename chat" onClick={(e) => e.stopPropagation()} data-testid="rename-sheet">
        <div class="grabber" />
        <h3 class="confirm-title">Rename chat</h3>
        <input ref={ref} class="rename-input" type="text" maxLength={120} defaultValue={initial} aria-label="Chat title" data-testid="rename-sheet-input" enterkeyhint="done"
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }} />
        <div class="approve"><button class="btn" type="button" onClick={onClose}>Cancel</button><button class="btn primary" type="button" data-testid="rename-sheet-save" onClick={save}>Save name</button></div>
      </div>
    </div>
  );
}

/** The chat header's "⋯" (and, in the desktop app bar, the caret beside the title): the shared Chat actions menu for the open chat, plus the sheets its items open.
 *  Opens on click / Enter, and on hover (pointer moves, 120 ms in, 250 ms out; touch ignored; a pointer parked on it keeps it open). Both triggers drive one menu. */
export function ChatHeaderMenu({ conv, projectId, disabled, messages, onInfo, onEdit, onRemoved, onMoved, caretSlot }: { conv: Conv; projectId: string | null; disabled: boolean; messages: readonly Msg[]; onInfo: () => void; onEdit: (e: RowEdit) => void; onRemoved: () => void; onMoved: (p: string | null) => void; caretSlot?: HTMLElement | null }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [sheet, setSheet] = useState<"none" | "rename" | "move" | "export" | "delete">("none");
  const [ms, md] = useReducer(menuReducer, MENU_CLOSED as MenuState);
  const btn = useRef<HTMLButtonElement>(null), caretBtn = useRef<HTMLButtonElement>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const ops = useConvOps(conv, { onEdit, onRemoved });
  const fine = () => matchMedia("(hover:hover) and (pointer:fine)").matches;
  const openAt = (el: HTMLElement | null) => { const r = el?.getBoundingClientRect(); if (el && r) { anchor.current = el; setMenu({ x: el === caretBtn.current ? r.left : r.right, y: r.bottom + 4 }); } };
  const shut = () => setSheet("none");
  const closeMenu = () => { md({ t: "select" }); setMenu(null); };
  const hoverShown = menuShown(ms);
  useEffect(() => { if (hoverShown && !menu && !disabled) openAt(anchor.current ?? btn.current); else if (!hoverShown && menu) setMenu(null); }, [hoverShown]);
  useEffect(() => {
    if (ms.phase !== "opening" && ms.phase !== "leaving") return;
    const id = setTimeout(() => {
      const on = [btn.current, caretBtn.current, document.querySelector('[data-testid="chat-menu"]')].some((e) => e?.matches(":hover"));
      md({ t: on && ms.phase === "leaving" && fine() ? "hover" : "tick" });
    }, ms.phase === "opening" ? MENU_OPEN_MS : MENU_CLOSE_MS);
    return () => clearTimeout(id);
  }, [ms.phase]);
  useEffect(() => { // a hover-opened (unpinned) menu has a click-through scrim: a click anywhere else closes it
    if (!menu || ms.pinned) return;
    const f = (e: PointerEvent) => { const t = e.target as Node; if (!document.querySelector('[data-testid="chat-menu"]')?.contains(t) && !btn.current?.contains(t) && !caretBtn.current?.contains(t)) closeMenu(); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const inside = !!document.querySelector('[data-testid="chat-menu"]')?.contains(document.activeElement); closeMenu(); if (inside) (anchor.current ?? btn.current)?.focus(); } };
    addEventListener("pointerdown", f, true); addEventListener("keydown", k, true);
    return () => { removeEventListener("pointerdown", f, true); removeEventListener("keydown", k, true); };
  }, [!!menu, ms.pinned]);
  const pick = (s: typeof sheet) => () => { closeMenu(); setSheet(s); };
  const trig = (el: () => HTMLElement | null) => ({
    onPointerMove: (e: PointerEvent) => { if (!disabled && e.pointerType !== "touch" && e.buttons === 0 && fine()) { anchor.current = el(); md({ t: "hover" }); } },
    onPointerEnter: (e: PointerEvent) => { if (e.pointerType !== "touch" && fine() && ms.phase !== "closed") md({ t: "hover" }); },
    onPointerLeave: (e: PointerEvent) => { if (e.pointerType === "touch" || (e.relatedTarget instanceof Element && e.relatedTarget.closest('[data-testid="chat-menu"]'))) return; md({ t: "leave" }); },
    onClick: () => { anchor.current = el(); if (menu && ms.pinned) closeMenu(); else { md({ t: "click" }); openAt(el()); } },
  });
  const menuHover = { onPointerEnter: (e: PointerEvent) => { if (e.pointerType !== "touch" && fine()) md({ t: "hover" }); }, onPointerLeave: (e: PointerEvent) => { if (e.pointerType !== "touch") md({ t: "leave" }); },
    onFocusIn: () => md({ t: "focus" }), onFocusOut: (e: FocusEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) md({ t: "blur" }); } };
  return (
    <>
      <button ref={btn} class={caretSlot ? "abtn" : "rbtn"} aria-label="Chat actions" title="Chat actions" aria-haspopup="menu" aria-expanded={!!menu} data-testid="chat-header-menu" disabled={disabled} {...trig(() => btn.current)}><IconMore /></button>
      {caretSlot && createPortal(<button ref={caretBtn} class="abtn ab-caretbtn" aria-label="Chat menu" title="Chat menu" aria-haspopup="menu" aria-expanded={!!menu} data-testid="chat-title-menu" disabled={disabled} {...trig(() => caretBtn.current)}><IconChevronDown /></button>, caretSlot)}
      {menu && createPortal(<ChatMenu at={menu} pinned={!!conv.pinned} hover={menuHover} focusFirst={ms.pinned} passive={!ms.pinned} onClose={() => { closeMenu(); (anchor.current ?? btn.current)?.focus(); }}
        onInfo={() => { closeMenu(); onInfo(); }} onRename={pick("rename")} onPin={() => { closeMenu(); void ops.pin(); }} onMove={pick("move")} onExport={pick("export")} onDelete={pick("delete")} />, document.body)}
      {sheet === "rename" && <RenameSheet initial={conv.title} onSave={(v) => { shut(); void ops.rename(v); }} onClose={shut} />}
      {sheet === "move" && <MoveSheet convId={conv.id} current={projectId} onClose={shut} onMoved={(p) => { shut(); onMoved(p); }} />}
      {sheet === "export" && <ExportSheet onPick={(k) => { shut(); void ops.exportAs(k, messages); }} onClose={shut} />}
      {sheet === "delete" && <ConfirmSheet title="Delete this conversation?" body={conv.title || "New chat"} onConfirm={() => { shut(); void ops.remove(); }} onCancel={shut} />}
    </>
  );
}
