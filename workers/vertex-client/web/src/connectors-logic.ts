// Pure state helpers for the Connectors screens (no DOM, unit-tested).
import type { AuthKind, ConnectorMode, ConnectorPut, ConnectorRow, NewConnector } from "./api";

/** The row as it will look once `b` is applied (optimistic update; the server stays the authority and the screen reloads after a failure). */
export function applyPut(c: ConnectorRow, b: ConnectorPut): ConnectorRow {
  const enabled = b.enabled ?? c.enabled;
  // Master switch off hides every tool; the per-tool modes keep their own state underneath, so turning it back on restores them.
  const tools = c.tools.map((t) => (b.tool && t.name === b.tool.name ? { ...t, changed: false, mode: b.tool.mode, enabled: b.tool.mode !== "block", approval: b.tool.mode === "block" ? t.approval : b.tool.mode === "ask" } : t));
  return { ...c, enabled, tools };
}
/** Tools actually offered to the model: connector on AND the tool is not blocked. */
export const offeredCount = (c: ConnectorRow) => (c.enabled ? c.tools.filter((t) => t.mode !== "block").length : 0);
export const MODE_LABEL: Record<ConnectorMode, string> = { always: "Always", ask: "Ask first", block: "Block" };
/** Modes offered for a tool: Block is a mode of the USER's choosing (the model never sees a blocked tool); an approval tool never offers Always. */
export const modesFor = (t: { canAlways: boolean }): ConnectorMode[] => (t.canAlways ? ["always", "ask", "block"] : ["ask", "block"]);
export const CHANGED_BADGE = "Definition changed — review";
export const CHANGED_HELP = "The server changed this tool since you set Always, so it asks first. Read its description, then confirm Always again if you trust it.";
export const CONNECTORS_NEW_CHATS_NOTE = "Applies to new chats";
export const ADD_NOTE = "Remote MCP servers using a bearer token or header. OAuth connectors are not supported yet.";

/** Client-side check before posting (the server validates again, strictly). Returns an error message or null. */
export function newConnectorError(f: { name: string; url: string; authKind: AuthKind; headerName: string; token: string }): string | null {
  if (!f.name.trim()) return "Enter a name";
  if (!f.url.trim()) return "Enter the MCP server URL";
  if (!/^https:\/\//i.test(f.url.trim())) return "The URL must start with https://";
  if (f.authKind !== "none" && !f.token.trim()) return "Enter the token";
  if (f.authKind === "header" && !/^[A-Za-z0-9-]{1,64}$/.test(f.headerName)) return "Enter a header name (letters, digits, hyphens)";
  return null;
}
export function newConnectorBody(f: { name: string; url: string; authKind: AuthKind; headerName: string; token: string }): NewConnector {
  return { name: f.name.trim(), url: f.url.trim(), authKind: f.authKind, ...(f.authKind === "header" ? { headerName: f.headerName } : {}), ...(f.authKind !== "none" ? { token: f.token.trim() } : {}) };
}
export const disconnectText = (c: { name: string; kind: "internal-binding" | "remote-mcp" }) => c.kind === "remote-mcp"
  ? { title: `Disconnect ${c.name}?`, body: "This deletes the connector and its saved token from the server. Its tools stop working in every chat, including ones already open.", confirm: "Disconnect" }
  : { title: `Disconnect ${c.name}?`, body: "This is built in, so it is turned off, not deleted. New chats get none of its tools (chats already open keep theirs). You can reconnect it here any time.", confirm: "Disconnect" };
