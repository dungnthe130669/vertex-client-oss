// Pure chat-UX logic (no DOM, no IO): unit-testable under bun. chat.tsx wires it to the page.
import type { Msg } from "./chat-state";
import type { Uploaded } from "./api";

/** The "jump to latest" button shows once the reader is further than this above the bottom. */
export const JUMP_THRESHOLD = 200;
export const awayFromBottom = (el: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = JUMP_THRESHOLD) =>
  el.scrollHeight - el.scrollTop - el.clientHeight > threshold;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Wraps sanitized `<pre><code>` blocks in a header (language label + Copy button). No inline style or handler: the button is wired by a delegated listener. */
export const decorateCode = (html: string) => html.replace(/<pre><code(?: class="language-([\w+#.-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
  (_m, lang: string | undefined, code: string) => `<div class="codeblock"><div class="codehead"><span class="lang">${esc(lang ?? "text")}</span><button type="button" class="copy" data-copy>Copy</button></div><pre tabindex="0"><code>${code.replace(/\n$/, "")}</code></pre></div>`);

export type Resend = { text: string; files: Uploaded[] };
const isToolResultOnly = (m: Msg) => m.content.every((b) => b.type === "tool_result");
const asResend = (m: Msg): Resend => ({
  text: m.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
  files: m.content.filter((b) => b.type === "file_ref").map((b) => ({ ref: String(b.ref), name: String(b.name), mime: String(b.mime), size: Number(b.size) || 0 })),
});

/** The user turn that started the answer ending at message `id`: the nearest earlier real user message (tool results are not user turns). */
export function resendFor(messages: Msg[], id: number): Resend | null {
  const i = messages.findIndex((m) => m.id === id);
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role === "user" && !isToolResultOnly(m)) { const r = asResend(m); return r.text || r.files.length ? r : null; }
  }
  return null;
}

/** Id of the last real user message (the only one that offers Edit), or null. */
export function lastUserId(messages: Msg[]): number | null {
  for (let j = messages.length - 1; j >= 0; j--) if (messages[j].role === "user" && !isToolResultOnly(messages[j])) return messages[j].id;
  return null;
}
export const editDraft = (messages: Msg[], id: number): Resend | null => { const m = messages.find((x) => x.id === id && x.role === "user"); return m ? asResend(m) : null; };

export type KeyEv = { key: string; shiftKey: boolean; isComposing?: boolean };
/** Desktop (fine pointer): Enter sends, Shift+Enter newline. Coarse pointer (phones): Enter is always a newline. */
export function enterAction(e: KeyEv, finePointer: boolean): "send" | "newline" {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing && finePointer ? "send" : "newline";
}
/** Esc stops a running turn on desktop only, and never when something else (slash menu, dialog) already took the key. */
export const escStops = (e: { key: string; defaultPrevented: boolean }, o: { running: boolean; finePointer: boolean; dialogOpen: boolean }) =>
  e.key === "Escape" && o.running && o.finePointer && !e.defaultPrevented && !o.dialogOpen;

/** The model id to put on a send frame: "" (the picker has not loaded its default yet) must not go out as an id, the server rejects it as "bad model id". */
export const sendModel = (m: string): string | undefined => m || undefined;

/** Does this drag carry files (and not, say, selected text)? */
export const dragHasFiles = (types: ArrayLike<string> | undefined) => !!types && Array.prototype.includes.call(types, "Files");

/** The Stop button / Esc are live from the moment a send is accepted by the socket, not only once the server's turn_start arrives (a stop in that gap used to be dropped). */
export const canStop = (running: boolean, sendWait: boolean) => running || sendWait;

/** Why the composer cannot send right now ("" = it can). Offline wins over a merely reconnecting socket. */
export function composerBlock(o: { online: boolean; socket: "connecting" | "open" | "closed"; draftScreen: boolean }): string {
  if (o.draftScreen) return ""; // the start screen has no socket: it creates the chat over plain HTTP
  if (!o.online) return "Offline - will send when back";
  if (o.socket !== "open") return o.socket === "connecting" ? "Reconnecting…" : "Not connected - retrying…";
  return "";
}

/** A connection notice never shifts layout (it is an overlay) and only appears once the socket has been away this long; offline is shown at once. */
export const CONN_NOTICE_DELAY_MS = 2000;
export const connNoticeDelay = (socket: "connecting" | "open" | "closed", online: boolean): number | null => !online ? 0 : socket === "open" ? null : CONN_NOTICE_DELAY_MS; // navigator.onLine=false wins even while the socket object still reports open
/** Debounced notice: show(true) only after the delay of continuous non-open; any "open" cancels and hides. Timers injectable for tests. */
export function connNotice(show: (v: boolean) => void, t: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void } = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as number) }) {
  let h: unknown = null; let shown = false;
  const set = (v: boolean) => { if (v !== shown) { shown = v; show(v); } };
  return {
    update(socket: "connecting" | "open" | "closed", online: boolean) {
      const d = connNoticeDelay(socket, online);
      if (d === null) { if (h !== null) { t.clear(h); h = null; } set(false); return; }
      if (shown || h !== null) { if (d === 0 && !shown) { t.clear(h); h = null; set(true); } return; } // already pending/shown: a connecting<->closed flap must not restart the clock
      if (d === 0) return set(true);
      h = t.set(() => { h = null; set(true); }, d);
    },
    dispose() { if (h !== null) t.clear(h); h = null; },
  };
}

// Unsent text per chat survives a reload / a crashed tab. Storage can be missing, full or blocked: every access is guarded and never throws.
const DRAFT_KEY = (id: string) => `vc:draft:${id}`;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const store = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
export function loadDraft(id: string, s: Store | null = store()): string {
  try { return s?.getItem(DRAFT_KEY(id)) ?? ""; } catch { return ""; }
}
/** The unsent NEW chat has no conversation id: it is owned by (account, space), so a Business draft is never offered in Open and another account on the same browser sees nothing. */
export const newChatKey = (user: string, space: string): string => JSON.stringify(["new-chat", user, space]);
const NEW_CHAT_PREFIX = 'vc:draft:["new-chat",';
const LEGACY_NEW_CHAT_ID = "__new_chat__"; // the first version of this feature: one shared entry for everybody, never read again
/** Restores this owner's unsent new chat; also discards the legacy shared entry. */
export function loadNewChatDraft(owner: string, s: Store | null = store()): string {
  try { s?.removeItem(DRAFT_KEY(LEGACY_NEW_CHAT_ID)); } catch { /* ignore */ }
  return loadDraft(owner, s);
}
/** Sign-out / session gone: every owner's persisted new-chat draft (and the legacy entry) goes with the identity. */
export function dropNewChatDrafts(s: (Store & Partial<Pick<Storage, "key" | "length">>) | null = store()): void {
  try {
    if (!s) return;
    s.removeItem(DRAFT_KEY(LEGACY_NEW_CHAT_ID));
    if (typeof s.key !== "function" || typeof s.length !== "number") return;
    const hit: string[] = [];
    for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(NEW_CHAT_PREFIX)) hit.push(k); }
    for (const k of hit) s.removeItem(k);
  } catch { /* ignore */ }
}
export function saveDraft(id: string, text: string, s: Store | null = store()): void {
  try { if (!s) return; if (text.trim()) s.setItem(DRAFT_KEY(id), text); else s.removeItem(DRAFT_KEY(id)); } catch { /* quota / blocked */ }
}

/** Every keyboard shortcut the app really has (one list: the help dialog renders it, a test pins it). `keys` are alternatives for the platform (Ctrl vs Cmd). */
export const SHORTCUTS: ReadonlyArray<{ keys: string[]; does: string; where: string }> = [
  { keys: ["Ctrl+K", "Cmd+K"], does: "Open the command palette", where: "Anywhere (desktop)" },
  { keys: ["Ctrl+B", "Cmd+B"], does: "Show or hide the sidebar", where: "Anywhere (desktop)" },
  { keys: ["Ctrl+F", "Cmd+F"], does: "Find in this chat", where: "In a chat" },
  { keys: ["Ctrl+Shift+O", "Cmd+Shift+O"], does: "Start a new chat", where: "Anywhere (desktop)" },
  { keys: ["Ctrl+N", "Cmd+N"], does: "Start a new chat", where: "Desktop app only (a browser keeps it for a new window)" },
  { keys: ["Ctrl+,", "Cmd+,"], does: "Open Settings", where: "Anywhere (desktop)" },
  { keys: ["Enter"], does: "Send the message", where: "Composer (desktop)" },
  { keys: ["Shift+Enter"], does: "New line in the message", where: "Composer" },
  { keys: ["Esc"], does: "Stop the reply that is being written", where: "In a chat (desktop)" },
  { keys: ["Esc"], does: "Close the open dialog, menu or find bar", where: "Anywhere" },
  { keys: ["?"], does: "Show this list", where: "Anywhere outside a text field (desktop)" },
];

/** "?" opens the help: desktop only, never while typing, never with a modifier, never when something already handled the key. */
export function opensShortcutHelp(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; defaultPrevented: boolean; target: unknown }, finePointer: boolean): boolean {
  if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !finePointer) return false;
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = (t?.tagName ?? "").toUpperCase();
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable);
}

/** The user is asking the model to make a picture. Non-AI on purpose: a plain regex over the user's own words. */
export const IMAGE_INTENT = new RegExp([
  "t[ạa]o\\s+(?:cho\\s+(?:t[ôo]i\\s+)?)?(?:m[ộo]t\\s+)?[ảa]nh",
  // vẽ alone is too common ("vẽ chuyện"): an image noun has to follow within a few words
  "(?<!\\p{L})v[ẽe](?!\\p{L})[^.\\n]{0,30}?(?<!\\p{L})(?:[ảa]nh|h[ìi]nh|tranh|logo|con|minh h[ọo]a|bi[ểe]u t[ượu]ng)(?!\\p{L})",
  "(?<!\\p{L})ve\\s+(?:anh|hinh|con)(?!\\p{L})",
  "generate\\s+(?:an?\\s+)?image", "create\\s+(?:an?\\s+)?image",
  // draw: anything but the common idioms (draw a conclusion / attention / the line / lots ...)
  "\\bdraw\\b(?!\\s+(?:(?:a|an|the|some|your|their|his|her|my|our)\\s+)?(?:conclusions?|attention|the\\s+line|lots|blood|breath|straws?|inspiration|parallels?|comparisons?|distinctions?|interest|crowds?|blank)(?![\\p{L}]))\\s+\\S",
].join("|"), "iu");
/** Preferred model in the existing Image mode when the hint is tapped. */
export const HINT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
/** Show "this model can't generate images" under a user message: Open only, the message asks for an image, and the selected model is known to lack tools
 *  (so generate_image is never offered to it). An unknown model (list not loaded) or Auto shows nothing. */
export const showImageHint = (o: { space: "open" | "biz"; text: string; caps?: { tools: boolean } | undefined; imageModels?: ReadonlyArray<unknown> | null }) =>
  o.space === "open" && !!o.caps && !o.caps.tools && IMAGE_INTENT.test(o.text) && !(o.imageModels && o.imageModels.length === 0);
/** Pick the hint's image model: FLUX when the list has it, else the first one. */
export const pickHintImageModel = (ids: string[]) => (ids.includes(HINT_IMAGE_MODEL) ? HINT_IMAGE_MODEL : ids[0] ?? "");

/** The persistent data-use notice for the selected model's provider (server sends `providerNotices` keyed by provider id); "" when none (Auto, gateway, no notice). */
export const noticeFor = (models: Array<{ id: string; provider?: string }> | null, modelId: string, notices: Record<string, string> | undefined): string => {
  const p = models?.find((m) => m.id === modelId)?.provider;
  return (p && notices?.[p]) || "";
};
