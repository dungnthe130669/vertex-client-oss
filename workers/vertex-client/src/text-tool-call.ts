// Safety net for a weak tool-caller that writes its tool call as TEXT (NIM nemotron-3-ultra under `tool_choice:"required"`: `Let me check...` + `{"tool":"web_read","url":"...","request_id":"1"}`
// or `[[{"name":"web_read","parameters":{"url":"..."}}]`, tool_calls empty: docs/reports/nim-textcall-diag.md). Pure, no `cloudflare:workers`: the engine uses it, tests drive it directly.
// Strict on purpose: ONE object, an OFFERED tool name, arguments valid against that tool's input_schema (no extra key), a short lead-in at most. Anything else = null (the turn stays as it is).
// Only the model's own reply text of the first assistant turn is ever passed in, never a tool result: page text cannot reach this.
import type { ToolDef } from "./tools";

const MAX_TEXT = 4000, MAX_LEAD = 200, MAX_JSON = 2000;
// Model bookkeeping keys: ignored, never arguments (unless the offered tool itself declares one as a property). Arguments stay strictly validated.
const META_KEYS = new Set(["tool", "name", "type", "id", "request_id", "tool_call_id", "call_id", "toolCallId", "requestId", "function", "tool_call"]);
export interface TextToolCall { name: string; input: Record<string, unknown>; lead: string }

/** The end index (exclusive) of the balanced `{...}` starting at `i`, string/escape aware; -1 when unbalanced. */
function objectEnd(s: string, i: number): number {
  let depth = 0, inStr = false;
  for (let k = i; k < s.length; k++) {
    const c = s[k]!;
    if (inStr) { if (c === "\\") k++; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) return k + 1;
  }
  return -1;
}

/** Strict JSON-schema subset check (type, required, properties with NO additional keys, enum, string length, number range, array items, http(s) for `url`). Unknown schema shape = invalid. */
export function validArgs(schema: unknown, v: unknown, key = ""): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, any>;
  if (Array.isArray(s.enum) && !s.enum.some((e: unknown) => e === v)) return false;
  switch (s.type) {
    case "object": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return false;
      const props = (s.properties && typeof s.properties === "object" ? s.properties : {}) as Record<string, unknown>;
      const o = v as Record<string, unknown>;
      if (Object.keys(o).some((k) => !Object.prototype.hasOwnProperty.call(props, k))) return false; // an extra argument is never tolerated
      if (Array.isArray(s.required) && s.required.some((k: unknown) => typeof k !== "string" || !(k in o))) return false;
      return Object.entries(o).every(([k, x]) => validArgs(props[k], x, k));
    }
    case "string": {
      if (typeof v !== "string") return false;
      if (typeof s.minLength === "number" && v.length < s.minLength) return false;
      if (typeof s.maxLength === "number" && v.length > s.maxLength) return false;
      if (key === "url" || s.format === "uri" || s.format === "url") { try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; } }
      return true;
    }
    case "number": case "integer": {
      if (typeof v !== "number" || !Number.isFinite(v) || (s.type === "integer" && !Number.isInteger(v))) return false;
      return !(typeof s.minimum === "number" && v < s.minimum) && !(typeof s.maximum === "number" && v > s.maximum);
    }
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v) && v.length <= 100 && (s.items === undefined || v.every((x) => validArgs(s.items, x)));
    default: return false;
  }
}

/** `text` = the whole text of the model's reply (no tool_use blocks in it), `offered` = the tools sent in THIS request. Null = not a clean single text tool call. */
export function parseTextToolCall(text: string, offered: ToolDef[]): TextToolCall | null {
  if (!offered.length || typeof text !== "string") return null;
  const t = text.trim();
  if (!t || t.length > MAX_TEXT) return null;
  const at = t.search(/[{[]/);
  if (at < 0) return null;
  const lead = t.slice(0, at).replace(/```[a-z]*\s*$/i, "").trim();
  if (lead.length > MAX_LEAD || /[\n]{2,}/.test(lead) || /[{}[\]]/.test(lead)) return null;
  const m = /^(?:\[\s*)+/.exec(t.slice(at)); // `[`, `[[`, ... (the malformed bracket shape)
  const start = at + (m ? m[0].length : 0);
  if (t[start] !== "{") return null;
  const end = objectEnd(t, start);
  if (end < 0 || end - start > MAX_JSON) return null;
  if (!/^[\]\s`]*$/.test(t.slice(end))) return null; // only closing brackets / a code fence may follow: a second object or any prose means "not a clean single call"
  let o: any;
  try { o = JSON.parse(t.slice(start, end)); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const names = [o.tool, o.name].filter((x) => x !== undefined);
  if (!names.length || names.some((x) => typeof x !== "string" || x !== names[0])) return null;
  const name = names[0] as string;
  const tool = offered.find((x) => x.name === name);
  if (!tool) return null;
  const props = (tool.input_schema as any)?.properties && typeof (tool.input_schema as any).properties === "object" ? (tool.input_schema as any).properties as Record<string, unknown> : {};
  const isMeta = (k: string) => META_KEYS.has(k) && !Object.prototype.hasOwnProperty.call(props, k);
  const wrapped = ["parameters", "arguments", "input"].filter((k) => k in o);
  let input: unknown;
  if (wrapped.length > 1) return null;
  if (wrapped.length === 1) {
    input = o[wrapped[0]!];
    if (typeof input === "string") { try { input = JSON.parse(input); } catch { return null; } }
    if (Object.keys(o).some((k) => !isMeta(k) && k !== wrapped[0])) return null;
  } else {
    input = Object.fromEntries(Object.entries(o).filter(([k]) => !isMeta(k)));
  }
  if (!validArgs(tool.input_schema, input)) return null;
  return { name, input: input as Record<string, unknown>, lead };
}
