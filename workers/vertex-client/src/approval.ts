// Approval modes, pure policy (no I/O; the engine and the tests use it). See docs/design/approval-modes.md (option B), Erich's decisions of 2026-10-26 and v2 (Bypass, 2026-10-27, bottom of this file).
// What can ever be auto-approved: ONLY the Open browse tools (web_*) in a tainted conversation, i.e. the calls that today show a card because a web page was read earlier.
// Everything else is HARD-ASK and never consults a grant or the mode: the connector write/delete/ask tools (save_note, update_task, assign_task, delete_note,
// delete_thread, ask_vertex), every custom MCP tool, anything unclassified. A write tool in a tainted chat therefore still asks, with or without Auto.
import { normalizeUrl, WEB_TOOLS } from "./web-taint";

export const AWAITING_TTL_MS = 30 * 60_000;
export const AUDIT_TTL_MS = 30 * 24 * 60 * 60_000;
export const MAX_CHAT_GRANTS = 50;
export const MAX_USER_GRANTS = 200;
/** Version of the Bypass confirmation text. The server accepts a Bypass switch only with `confirmed:true` + this exact version; bump it when the dialog text changes materially. */
export const BYPASS_CONFIRM_VERSION = 1;
export type ApprovalMode = "ask" | "auto" | "bypass";
export type AutoSource = "chat-grant" | "user-grant" | "mode-auto" | "mode-bypass";
export const EXPIRED_TEXT = "The approval request expired after 30 minutes without an answer; the action was not run. Ask the user again if it is still needed.";

/** The exact lowercase host a grant may be made for, or null when this URL is not eligible: userinfo (`https://good.com@evil.com`), an explicit port, IP literals,
 *  dotless / local names. Exact match only: no www-stripping, no subdomain or suffix matching (`evil.com.example.org` is a different host from `example.org`). */
export function grantHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL; try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.port) return null; // the WHATWG parser drops a default port, so any remaining port is non-default
  const h = u.hostname.replace(/\.+$/, "").toLowerCase();
  if (!h || h.startsWith("[") || !h.includes(".")) return null; // IPv6 literal / dotless name
  if (/^\d+(\.\d+){3}$/.test(h) || /^[\d.]+$/.test(h)) return null; // IPv4 literal (the parser canonicalises 0x7f.1 etc. to dotted decimal)
  if (/\.(internal|local|localhost|lan|home|corp|intranet)$/.test(h)) return null;
  if (h.length > 253 || !/^[a-z0-9.-]+$/.test(h)) return null; // punycode (xn--) is ASCII, so it passes; anything else the parser left non-ASCII is refused
  return h;
}

/** Plain-words reason this address is NEVER covered by a grant or Auto (it always shows a card), or null when it is an ordinary public web address. Covers IP literals
 *  (v4 in any decimal/hex/octal form, which the WHATWG parser canonicalises; v6, bracketed), localhost, single-label and *.local/*.internal-style names, any port other than
 *  the default 80/443, userinfo, and non-http(s) schemes. A malformed address is also a card. */
export function hardAskReason(raw: unknown): string | null {
  if (typeof raw !== "string") return "This address could not be read, so it needs your approval.";
  let u: URL; try { u = new URL(raw.trim()); } catch { return "This address could not be read, so it needs your approval."; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "This is not a normal web address (http or https), so it always needs your approval.";
  if (u.username || u.password) return "This address contains a username or password, which can disguise the real site, so it always needs your approval.";
  if (u.port && u.port !== "80" && u.port !== "443") return "This address uses an unusual port, so it always needs your approval.";
  const h = u.hostname.replace(/\.+$/, "").toLowerCase();
  if (!h) return "This address could not be read, so it needs your approval.";
  if (h.startsWith("[") || h.includes(":") || /^[\d.]+$/.test(h) || /^0x[0-9a-f.]*$/i.test(h)) return "This address is a raw IP number rather than a website name, so it always needs your approval.";
  if (h === "localhost" || !h.includes(".") || /\.(internal|local|localhost|lan|home|corp|intranet|arpa)$/.test(h)) return "This address points at a local or private network name, so it always needs your approval.";
  return null;
}

/** A URL that looks like it carries data out (long query, base64/hex blob): never auto-approved, even on a granted host. */
export function urlLooksLikeData(raw: string): boolean {
  const n = normalizeUrl(raw); if (!n) return true;
  const u = new URL(n);
  if (u.search.length > 150 || u.pathname.length > 300) return true;
  for (const seg of `${u.pathname}${u.search}`.split(/[\/?&=;,]/)) {
    if (seg.length >= 32 && /^[0-9a-f]+$/i.test(seg)) return true; // hex blob
    if (seg.length >= 40 && /^[A-Za-z0-9+_=-]+$/.test(seg) && (seg.match(/\d/g)?.length ?? 0) >= 8 && (seg.match(/[-_]/g)?.length ?? 0) <= 3) return true; // base64-ish blob (a slug has many hyphens)
  }
  return false;
}

/** Auto mode on a host the user never granted, in a tainted conversation: the strictest shape. A query string is the channel an injected page uses to smuggle data,
 *  so the address must be a plain path (no userinfo, no query) and not look like a blob. */
export function autoUrlOk(raw: string): boolean {
  if (hardAskReason(raw)) return false;
  const n = normalizeUrl(raw); if (!n) return false;
  const u = new URL(n);
  return !u.username && !u.password && !u.search && u.pathname.length <= 100 && !urlLooksLikeData(raw);
}

export type WebAuto = { kind: "approval" } | { kind: "auto"; source: AutoSource; subject: string };
/** For a web_* call the taint gate already wants a card for: may a grant or Auto mode answer it instead? `chat` / `user` are exact-host sets.
 *  Pure; the caller (engine) additionally checks redirects for a grant and writes the audit row BEFORE running the call. */
export function webAuto(name: string, input: unknown, o: { chat: ReadonlySet<string>; user: ReadonlySet<string>; auto: boolean }): WebAuto {
  if (!WEB_TOOLS.has(name)) return { kind: "approval" };
  const raw = typeof (input as { url?: unknown } | null)?.url === "string" ? (input as { url: string }).url : "";
  const host = hardAskReason(raw) ? null : grantHost(raw);
  if (host && !urlLooksLikeData(raw)) {
    if (o.chat.has(host)) return { kind: "auto", source: "chat-grant", subject: host };
    if (o.user.has(host)) return { kind: "auto", source: "user-grant", subject: host };
  }
  if (o.auto && autoUrlOk(raw)) { const n = normalizeUrl(raw)!; return { kind: "auto", source: "mode-auto", subject: new URL(n).hostname.replace(/\.+$/, "") }; }
  return { kind: "approval" };
}

/** True only when `url` answers WITHOUT redirecting. Browser Rendering returns no final URL, so a separate probe cannot prove where the real fetch lands (a TOCTOU gap with
 *  exact-host grants): any 3xx (even to the same host), a failure, or an off-host / ineligible address = false, and the caller shows a card instead. `fetchImpl` is called with redirect:"manual". */
export async function noRedirect(url: string, host: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<boolean> {
  if (hardAskReason(url) || grantHost(url) !== host) return false;
  let res: Response;
  try { res = await fetchImpl(url, { method: "GET", redirect: "manual", signal, headers: { range: "bytes=0-0" } }); } catch { return false; }
  try { await res.body?.cancel(); } catch { /* ignore */ }
  return res.status >= 200 && res.status < 300 || res.status === 416;
}

/** Plain-words reason for a card on a browse call (shown on the card), or null when the ordinary taint text is enough. */
export const REDIRECT_CARD_REASON = "This page redirects or could not be checked, so it might land on a different site than the one approved. It needs your approval.";

// ---- Bypass (guarded): per chat, no timer, never inherited by a fork, never a user default. It answers the cards Auto still shows, but has a floor it never crosses ----
/** Built-in read tools Bypass may approve (only reached when the user set one to Ask), by EXACT name. read_url is NOT here: it fetches an address the model chose (an egress channel), so it keeps asking.
 *  There is no name-pattern matching anywhere: a custom connector's tool is namespaced `<slug>__<tool>` and can never equal one of these, so every custom tool, and every unknown or mislabelled name, falls to ASK. */
export const BYPASS_READ_TOOLS: ReadonlySet<string> = new Set(["search_notes", "get_note", "list_projects", "check_tasks", "list_threads", "connector_usage", "fleet_status", "fleet_usage"]);
/** Writes Bypass may approve, by exact name, and only while the chat is clean. */
export const BYPASS_CLEAN_WRITE_TOOLS: ReadonlySet<string> = new Set(["save_note", "update_task"]);
/** What Bypass may do with a NON-browse tool call. `tainted` = untrusted content is already in the chat OR a sibling call of this batch will put some there.
 *  Allow-list by exact name only: a read tool from BYPASS_READ_TOOLS the user set to Ask; save_note / update_task while the chat is clean. Everything else (delete_*, assign_task, ask_vertex,
 *  read_url, every custom connector tool, anything unknown) asks. */
export function bypassTool(name: string, o: { tainted: boolean }): boolean {
  if (BYPASS_READ_TOOLS.has(name)) return true;
  if (BYPASS_CLEAN_WRITE_TOOLS.has(name)) return !o.tainted;
  return false;
}
/** Bypass on a browse call: any ordinary public address, a query string included (a search result link), but the floor stays: IP / local / odd port / userinfo are hardAsk, a blob-looking
 *  address is a card, and the caller still runs the redirect probe (a redirecting page is demoted to a card). */
export function bypassWeb(name: string, input: unknown): { host: string } | null {
  if (!WEB_TOOLS.has(name)) return null;
  const raw = typeof (input as { url?: unknown } | null)?.url === "string" ? (input as { url: string }).url : "";
  if (hardAskReason(raw) || urlLooksLikeData(raw)) return null;
  const host = grantHost(raw);
  return host ? { host } : null;
}
