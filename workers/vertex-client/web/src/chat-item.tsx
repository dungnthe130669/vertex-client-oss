import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ConvRow } from "./api";
import { ConfirmSheet } from "./confirm";
import { IconMore, IconPin } from "./icons";
import { fmtTokens } from "./chat-state";
import { ChatMenu, ExportSheet, type RowEdit, useConvOps } from "./chat-menu";
import { MoveSheet } from "./projects";

export type { RowEdit };
const LONG_PRESS_MS = 500;

/** One chat row with the shared Chat actions menu (chat-menu.tsx): hover "…" (desktop) or long-press (touch) -> Rename (inline) / Pin / Move / Export / Delete (confirm).
 *  `variant` picks the markup of the surrounding list (drawer / sidebar row, or the All chats card). The parent owns the rows: `onEdit` / `onRemoved` update them. */
export function ChatItem({ row, variant, current, onOpen, onEdit, onRemoved }: { row: ConvRow; variant: "drawer" | "list"; current?: boolean; onOpen: () => void; onEdit: (id: string, e: RowEdit) => void; onRemoved: (id: string) => void }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [ask, setAsk] = useState(false);
  const [moving, setMoving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longFired = useRef(false);
  const more = useRef<HTMLButtonElement>(null);
  const label = row.title || "New chat";
  const openAt = (x: number, y: number) => setMenu({ x, y });
  const openFromButton = () => { const r = more.current?.getBoundingClientRect(); if (r) openAt(r.right, r.bottom + 4); };
  const clearPress = () => { if (press.current) { clearTimeout(press.current.t); press.current = null; } };
  useEffect(() => clearPress, []);
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" || renaming) return;
    longFired.current = false;
    const x = e.clientX, y = e.clientY;
    press.current = { x, y, t: setTimeout(() => { longFired.current = true; press.current = null; openAt(x, y); }, LONG_PRESS_MS) };
  };
  const onPointerMove = (e: PointerEvent) => { const p = press.current; if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) clearPress(); }; // scrolling is not a press
  const onClick = (e: MouseEvent) => { if (longFired.current) { e.preventDefault(); longFired.current = false; return; } onOpen(); };
  const onContext = (e: MouseEvent) => { e.preventDefault(); if (!menu) openAt(e.clientX, e.clientY); };
  const ops = useConvOps({ id: row.id, title: row.title, pinned: !!row.pinned }, { onEdit: (e) => onEdit(row.id, e), onRemoved: () => onRemoved(row.id) });
  const save = (v: string) => { setRenaming(false); void ops.rename(v); };
  const main = renaming
    ? <RenameField initial={row.title} onSave={save} onCancel={() => setRenaming(false)} />
    : variant === "drawer"
      ? <button class={`drow conv${current ? " on" : ""}`} aria-current={current ? "page" : undefined} data-testid="recent-row" onClick={onClick} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={clearPress} onPointerCancel={clearPress} onContextMenu={onContext}>
          {!!row.pinned && <span class="conv-pin" aria-label="Pinned"><IconPin /></span>}<span class="drow-l ellip">{label}</span></button>
      : <button class="row" data-testid="list-row" onClick={onClick} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={clearPress} onPointerCancel={clearPress} onContextMenu={onContext}>
          <strong class="ellip">{!!row.pinned && <span class="conv-pin" aria-label="Pinned"><IconPin /></span>}{label}</strong>
          <span class="muted small">{row.model} · {fmtTokens(row.tokens)} tokens · {row.updatedAt.slice(0, 16)}</span>
        </button>;
  return (
    <li class={`citem c-${variant}${renaming ? " renaming" : ""}${menu ? " menu-open" : ""}`} data-testid="chat-item">
      {main}
      {!renaming && <button ref={more} class="icon cmenu-btn" aria-label={`Actions for ${label}`} aria-haspopup="menu" aria-expanded={!!menu} data-testid="chat-menu-button" onClick={openFromButton}><IconMore /></button>}
      {menu && createPortal(<ChatMenu at={menu} pinned={!!row.pinned} onClose={() => { setMenu(null); more.current?.focus(); }}
        onRename={() => { setMenu(null); setRenaming(true); }} onPin={() => { setMenu(null); void ops.pin(); }} onMove={() => { setMenu(null); setMoving(true); }} onExport={() => { setMenu(null); setExporting(true); }} onDelete={() => { setMenu(null); setAsk(true); }} />, document.body)}
      {exporting && <ExportSheet onPick={(k) => { setExporting(false); void ops.exportAs(k); }} onClose={() => setExporting(false)} />}
      {moving && <MoveSheet convId={row.id} current={row.projectId ?? null} onClose={() => setMoving(false)} onMoved={(pid) => { setMoving(false); onEdit(row.id, { projectId: pid }); }} />}
      {ask && <ConfirmSheet title="Delete this conversation?" body={label} onConfirm={() => { setAsk(false); void ops.remove(); }} onCancel={() => setAsk(false)} />}
    </li>
  );
}

function RenameField({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (save: boolean) => { if (done.current) return; done.current = true; if (save) onSave(ref.current?.value ?? ""); else onCancel(); };
  return <input ref={ref} class="rename-input" type="text" maxLength={120} defaultValue={initial} aria-label="Chat title" data-testid="rename-input" enterkeyhint="done"
    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); } }} onBlur={() => finish(true)} />;
}
