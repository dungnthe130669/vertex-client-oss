// Chat tool `generate_image`: lets the chat model create an image through the SAME path as Image mode (provider.image, usage row, R2 `gen/` key so
// it shows in Library, the same confirm-cost line). Differences from GenEngine.run, on purpose: it runs INSIDE an already-open chat turn (no own
// turn/message), makes exactly ONE image per call, and never auto-spends above the confirm line - it returns a tool result telling the user to use
// Image mode instead. Offered only when this scope/user has image models, image_gen is allowed (listModels("image") refuses otherwise) and the
// "Let chat create images" setting is on.
import { estimate, needsConfirm } from "./gen-cost";
import { MAX_GEN_PROMPT_CHARS } from "./gen-engine";
import { GEN_IMAGE_MIMES, MAX_GEN_IMAGES_PER_RESPONSE, fromBase64, genImageProblem, genKey, type FileStore } from "./files";
import { ProviderError, type ModelProvider, type ProviderModel } from "./providers/types";
import type { IndexSink } from "./turn-engine";
import type { ToolDef, ToolHost } from "./tools";

import { IMAGE_TOOL } from "./image-tool-parse";
export { IMAGE_TOOL };
export const IMAGE_TOOLS = new Set([IMAGE_TOOL]);
export const MAX_IMAGES_PER_TURN = 2;
const ASPECT_RE = /^\d{1,2}:\d{1,2}$/;

export const IMAGE_TOOL_DEF: ToolDef = {
  name: IMAGE_TOOL, approval: false,
  description: "Create ONE image from a text prompt and show it to the user in the chat (also saved to their Library). Use when the user asks for a picture, illustration or photo-like image; for diagrams/logos you can write as vector code prefer an svg artifact. Describe the subject, style and composition in the prompt. Costs money: do not call it speculatively or repeatedly (max 2 per turn). If the result says to use Image mode, tell the user that.",
  input_schema: { type: "object", properties: { prompt: { type: "string", description: "What to draw, in detail (max 4000 characters)" }, aspect: { type: "string", description: "Optional aspect ratio like 1:1, 16:9, 9:16, 4:3, 3:4" } }, required: ["prompt"] },
};

export interface ImageToolDeps {
  provider: ModelProvider;
  /** Image models for this scope. Throws when image generation is not allowed / the provider is unavailable. */
  models(): Promise<ProviderModel[]>;
  /** Settings -> General "Let chat create images". */
  enabled(): Promise<boolean>;
  files: FileStore | null;
  index: IndexSink;
  conv(): string;
  confirmUsd(): Promise<number>;
  /** Pin the offered/not-offered decision for the conversation's life (the tool block is a prompt-cache breakpoint). */
  pin?: { get(): string | null | Promise<string | null>; set(v: string): void | Promise<void> };
}

export { parseImageToolResult, type ImageToolResult } from "./image-tool-parse";
import type { ImageToolResult } from "./image-tool-parse";

export function imageToolHost(d: ImageToolDeps): ToolHost {
  const perTurn = new Map<number, number>();
  return {
    async list() {
      const pinned = await d.pin?.get();
      if (pinned === "0") return [];
      if (pinned !== "1" && !(await d.enabled().catch(() => false))) { await d.pin?.set("0"); return []; }
      if (pinned === "1") return [IMAGE_TOOL_DEF];
      let models: ProviderModel[];
      try { models = await d.models(); } catch { return []; } // not allowed / gateway down: not offered now, decided again next time (never pinned on an error)
      if (!models.length) { await d.pin?.set("0"); return []; }
      await d.pin?.set("1");
      return [IMAGE_TOOL_DEF];
    },
    async call(name, args, ctx) {
      if (name !== IMAGE_TOOL) return { text: `tool ${name} is not available`, isError: true };
      const a = (args ?? {}) as Record<string, unknown>;
      const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
      if (!prompt) return { text: "prompt is required", isError: true };
      if (prompt.length > MAX_GEN_PROMPT_CHARS) return { text: `prompt too long (max ${MAX_GEN_PROMPT_CHARS} characters)`, isError: true };
      const aspect = typeof a.aspect === "string" && ASPECT_RE.test(a.aspect.trim()) ? a.aspect.trim() : undefined;
      if (a.aspect !== undefined && a.aspect !== null && a.aspect !== "" && !aspect) return { text: "aspect must look like 16:9", isError: true };
      if (!(await d.enabled().catch(() => false))) return { text: "Image creation from chat is turned off in Settings.", isError: true };
      const turn = ctx?.turn ?? -1;
      if ((perTurn.get(turn) ?? 0) >= MAX_IMAGES_PER_TURN) return { text: `At most ${MAX_IMAGES_PER_TURN} images per message. Ask the user before making more.`, isError: true };
      let models: ProviderModel[];
      try { models = await d.models(); } catch (e) { return { text: e instanceof ProviderError && e.status === 403 ? "Image generation is not available for this account." : "Image generation is unavailable right now.", isError: true }; }
      const model = models.find((m) => m.kind === "image" || m.kind === undefined);
      if (!model || !d.provider.image) return { text: "No image model is available.", isError: true };
      if (!d.files?.put) return { text: "File storage is not configured.", isError: true };
      const est = estimate("image", model.id, { n: 1 }, model.price);
      if (needsConfirm(est, await d.confirmUsd().catch(() => 1))) {
        return { text: `Not generated: this image would cost ${est.certainty === "unknown" ? "an unknown amount" : `about $${est.usd.toFixed(2)}`}, above the confirmation limit. Tell the user to open Image mode in the composer, where they can confirm the cost and generate it.`, isError: true };
      }
      perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1);
      const conv = d.conv(), dispatchId = crypto.randomUUID();
      let known: number | null = null, inTok = 0, outTok = 0, dispatched = false, recorded = false;
      const record = async (units: number) => {
        if (!dispatched || recorded || !conv) return;
        try { await d.index.recordUsage({ conversationId: conv, model: model.id, usage: { input_tokens: inTok, output_tokens: outTok }, costUsd: known, kind: "image", estUsd: units === 0 && known === 0 ? 0 : est.usd, units, dispatchId }); recorded = true; }
        catch (e) { console.error("usage", String(e)); }
      };
      let written: string | null = null;
      try {
        dispatched = true;
        const r = await d.provider.image({ model: model.id, prompt, ...(aspect ? { aspect_ratio: aspect } : {}) });
        known = typeof r.cost?.usd === "number" && Number.isFinite(r.cost.usd) && r.cost.usd >= 0 ? r.cost.usd : null;
        inTok = r.usage?.input_tokens ?? 0; outTok = r.usage?.output_tokens ?? 0;
        if (r.images.length > MAX_GEN_IMAGES_PER_RESPONSE) throw new ProviderError("The image service returned too many images.", 502);
        const img = r.images.find((i) => GEN_IMAGE_MIMES[i.mime_type]);
        if (!img) {
          await record(0);
          return { text: `No image was generated${r.finish_reason && r.finish_reason !== "STOP" ? ` (${r.finish_reason})` : ""}${r.text ? `: ${r.text.slice(0, 200)}` : ""}. Try rephrasing the prompt.${known === null ? " No image was returned; the provider may still have charged for the request." : ""}`, isError: true };
        }
        const why = genImageProblem(img.data);
        if (why) throw new ProviderError(`The image service returned an invalid or oversized image (${why}).`, 502);
        const key = genKey(conv, img.mime_type);
        await d.files.put(key, fromBase64(img.data), img.mime_type, conv);
        written = key;
        await record(1); // before the result is returned: a failure after this cannot produce a second row
        const out: ImageToolResult = { generated_image: { ref: key, mime: img.mime_type, prompt, model: model.id, cost_usd: known, est_usd: est.usd },
          note: "The image is already shown to the user in the chat and saved to their Library. Do not repeat the file reference; just say briefly what you made." };
        return { text: JSON.stringify(out), isError: false };
      } catch (e) {
        if (written) await d.files.delete?.([written]).catch(() => {});
        // Blocked / empty result: keep the tokens the gateway reported. Cost is zero only when the gateway says so explicitly (cost.usd === 0);
        // otherwise it stays unknown, whatever the token counts (the provider may still bill).
        const noImage = !written && e instanceof ProviderError && (e.info.type === "generation_blocked" || e.info.type === "empty_result");
        if (e instanceof ProviderError && e.info.usage && !written) { inTok = e.info.usage.input_tokens; outTok = e.info.usage.output_tokens; }
        if (known === null && !written && e instanceof ProviderError && e.info.costUsd === 0) known = 0;
        await record(0);
        console.error("image tool", e instanceof Error ? e.message : String(e));
        const note = !dispatched || known !== null ? "" : noImage ? " No image was returned; the provider may still have charged for the request." : ` Billing uncertain (estimated $${est.usd.toFixed(2)}).`;
        return { text: `${e instanceof ProviderError ? e.message : "Image generation failed."}${note}`, isError: true };
      }
    },
  };
}

/** Base host + the image tool as one: sorted by name overall (the tool block is a cache breakpoint), calls routed by name. */
export function withImageTool(base: ToolHost, img: ToolHost): ToolHost {
  return {
    async list() {
      const [a, b] = await Promise.all([base.list(), img.list()]);
      return [...a.filter((t) => !IMAGE_TOOLS.has(t.name)), ...b].sort((x, y) => x.name.localeCompare(y.name));
    },
    call: (name, args, ctx) => (IMAGE_TOOLS.has(name) ? img.call(name, args, ctx) : base.call(name, args, ctx)),
  };
}

// ---- Settings -> General "Let chat create images": one `settings` row per scope (name `chat_images:<scope>`), absent = ON ----
const settingName = (scope: string) => `chat_images:${scope}`;
export async function loadChatImages(db: D1Database, scope: string): Promise<boolean> {
  const r = await db.prepare(`SELECT value FROM settings WHERE name=?`).bind(settingName(scope)).first<{ value: string }>().catch(() => null);
  return r?.value !== "0";
}
export async function saveChatImages(db: D1Database, scope: string, on: boolean): Promise<void> {
  await db.prepare(`INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value`).bind(settingName(scope), on ? "1" : "0").run();
}
