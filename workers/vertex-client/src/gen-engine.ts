// Image + video generation engine. NOT part of the Claude turn loop: one request/response per media call, no streaming, different
// protocol. It runs inside the same per-conversation ChatEngine (shared message log, event seq, busy flag) through the small
// GenHost interface, so a generation shows up in the transcript like any other turn and survives reload/reconnect the same way.
//
// Rules enforced HERE (never trusted to the UI): an estimate above the confirm line, or an unknown model, needs
// {confirmed:true, est_usd >= server estimate} (spec §5); abort is honoured; a filtered/empty result is a normal assistant
// message, not an error; a failed call keeps its estimate and is labelled "billing uncertain"; nothing is ever retried automatically
// (a retried generation can bill twice). Video (Omni, sync, up to ~150 s) is ONE clip per request and reuses every rule above.
import { estimate, confirmError, normalizeCount, validSeconds, GEN_CONFIRM_USD_DEFAULT, VIDEO_DEFAULT_RESOLUTION, VIDEO_SECONDS_MIN, VIDEO_SECONDS_MAX, type GenEstimate, type GenKind } from "./gen-cost";
import { GEN_IMAGE_MIMES, GEN_VIDEO_MIMES, genVideoProblem, GEN_CONCURRENCY, MAX_GEN_IMAGES_PER_RESPONSE, MAX_GEN_TOTAL_BYTES, MAX_REF_IMAGES, b64DecodedLen, genImageProblem, MAX_REF_IMAGE_BYTES, fromBase64, genKey, refBelongsTo, toBase64, type FileRef, type FileStore } from "./files";
import { ProviderError, type GatewayPrice, type ImagePayload, type ImageResult, type ModelProvider, type VideoRequest, type VideoResult } from "./providers/types";
import type { Block, IndexSink, ServerEvent, StoredMessage } from "./turn-engine";

export const MAX_GEN_PROMPT_CHARS = 4000; // gateway accepts 8000; keep headroom and a readable transcript
import { MODEL_ID_RE as MODEL_RE } from "./model-id";
const ASPECT_RE = /^\d{1,2}:\d{1,2}$/;
const RESOLUTION_RE = /^(\d{3,4}p|[48]k)$/;
const REF_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const SOFT_ERRORS = new Set(["generation_blocked", "empty_result"]); // the model said no / returned nothing: a message, not a failure

export type GenCommand = { kind?: unknown; prompt?: unknown; model?: unknown; n?: unknown; aspect_ratio?: unknown; files?: unknown; confirmed?: unknown; est_usd?: unknown;
  /** video only */ duration_seconds?: unknown; resolution?: unknown };
export type GenReject = { error: string; code: "busy" | "invalid" | "confirm_required" | "unavailable"; est_usd?: number };
export type GenPlan = { kind: GenKind; prompt: string; model: string; n: number; aspect_ratio?: string; files: FileRef[]; est: GenEstimate;
  /** video only (n is always 1) */ seconds?: number; resolution?: string };
/** Persisted (DO storage) from the moment a provider request is dispatched until its usage row is recorded: if the DO is evicted in
 *  between, ChatEngine.init() records the row from this (NULL cost + estimate, "billing uncertain") instead of losing it.
 *  `id` is the stable dispatch id: the usage insert is idempotent on it, and the marker is cleared only AFTER the insert succeeded. */
export type GenDispatch = { id: string; kind: GenKind; model: string; est_usd: number };

/** What the generation needs from the ChatEngine that owns the conversation. */
export interface GenHost {
  readonly convId: string;
  busy(): boolean;
  /** Claims the engine (running) and bumps the turn; `signal` aborts on stop(). */
  begin(): { turn: number; signal: AbortSignal };
  /** Saves + emits the prompt as the user message, then emits turn_start (kind "image" | "video"). */
  open(turn: number, model: string, text: string, files: FileRef[], kind?: GenKind): StoredMessage;
  /** Set right before the provider call, cleared when its usage row is written (see GenDispatch). */
  markDispatched(d: GenDispatch | null): void;
  saveAssistant(turn: number, model: string, content: Block[], costUsd: number | null, stop: string, status: "complete" | "interrupted"): StoredMessage;
  /** Ends the turn (turn_end + cost totals + conversation index + auto-title from the prompt). `notify` = push "<kind> ready" on done. */
  finish(turn: number, status: "done" | "error" | "interrupted", error?: ServerEvent, notify?: "video"): Promise<void>;
}

export type GenDeps = { host: GenHost; provider: ModelProvider; files: FileStore | null; index: IndexSink; confirmUsd?: () => number | Promise<number> };

const cost = (usd: unknown): number | null => (typeof usd === "number" && Number.isFinite(usd) && usd >= 0 ? usd : null);
const money = (n: number) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;

export class GenEngine {
  constructor(private d: GenDeps) {}

  /** The catalog price the gateway publishes for `model` (same source the picker showed). A failure or a row without a usable price => UNKNOWN (confirm forced); the fallback tables only serve ids with no catalog row. */
  private async priceOf(kind: GenKind, model: string): Promise<GatewayPrice | null | undefined> {
    // undefined = the listing has no row for this id / carries no price field (legacy: tables may apply); null = a catalog row with no usable price (unknown).
    // A listing FAILURE is unknown too (never a silent table price for a model the catalog might have re-priced).
    try { return (await this.d.provider.listModels(kind)).find((m) => m.id === model)?.price; } catch { return null; }
  }
  private async threshold(): Promise<number> {
    try { const v = Number(await this.d.confirmUsd?.()); return Number.isFinite(v) && v >= 0 ? v : GEN_CONFIRM_USD_DEFAULT; } catch { return GEN_CONFIRM_USD_DEFAULT; }
  }

  /** Validation + the server-side confirm gate. Cheap and side-effect free: the socket handler calls it before arming the alarm. */
  async plan(c: GenCommand): Promise<{ ok: true; plan: GenPlan } | { ok: false; reject: GenReject }> {
    const bad = (error: string, code: GenReject["code"] = "invalid", est_usd?: number) => ({ ok: false as const, reject: { error, code, ...(est_usd !== undefined ? { est_usd } : {}) } });
    if (this.d.host.busy()) return bad("busy", "busy");
    if (c.kind !== "image" && c.kind !== "video") return bad("unsupported generation kind");
    const kind: GenKind = c.kind;
    if (kind === "image" ? !this.d.provider.image : !this.d.provider.video) return bad(`${kind} generation is not available`, "unavailable");
    if (!this.d.files?.put) return bad("file storage not configured", "unavailable");
    const prompt = typeof c.prompt === "string" ? c.prompt.trim() : "";
    if (!prompt) return bad("empty prompt");
    if (prompt.length > MAX_GEN_PROMPT_CHARS) return bad(`prompt too long (max ${MAX_GEN_PROMPT_CHARS} characters)`);
    if (typeof c.model !== "string" || !MODEL_RE.test(c.model)) return bad("bad model id");
    const aspect = c.aspect_ratio === undefined || c.aspect_ratio === null || c.aspect_ratio === "" ? undefined : c.aspect_ratio;
    if (aspect !== undefined && (typeof aspect !== "string" || !ASPECT_RE.test(aspect))) return bad("bad aspect ratio");
    const list = c.files === undefined || c.files === null ? [] : c.files;
    if (kind === "video") {
      if (!Array.isArray(list) || list.length) return bad("video generation takes no reference images");
      const seconds = c.duration_seconds === undefined || c.duration_seconds === null ? VIDEO_SECONDS_MIN : c.duration_seconds;
      if (!validSeconds(seconds)) return bad(`duration must be a whole number of seconds, ${VIDEO_SECONDS_MIN}-${VIDEO_SECONDS_MAX}`);
      const resolution = c.resolution === undefined || c.resolution === null || c.resolution === "" ? VIDEO_DEFAULT_RESOLUTION : c.resolution;
      if (typeof resolution !== "string" || !RESOLUTION_RE.test(resolution)) return bad("bad resolution");
      const est = estimate("video", c.model, { seconds, resolution }, await this.priceOf("video", c.model));
      const ce = confirmError(est, c, await this.threshold());
      if (ce) return bad(ce, "confirm_required", est.usd);
      return { ok: true, plan: { kind, prompt, model: c.model, n: 1, aspect_ratio: aspect, files: [], est, seconds, resolution } };
    }
    if (!Array.isArray(list) || list.length > MAX_REF_IMAGES) return bad(`too many reference images (max ${MAX_REF_IMAGES})`);
    const files: FileRef[] = [];
    for (const f of list as Array<Partial<FileRef>>) {
      if (!refBelongsTo(f?.ref, this.d.host.convId)) return bad("bad file reference");
      if (typeof f.mime !== "string" || !REF_MIMES.has(f.mime.toLowerCase())) return bad("reference images must be PNG, JPEG or WebP");
      files.push({ ref: f.ref!, name: String(f.name ?? "image").slice(0, 120), mime: f.mime.toLowerCase(), size: Number(f.size) || 0 });
    }
    const n = normalizeCount(c.n);
    const est = estimate("image", c.model, { n }, await this.priceOf("image", c.model));
    const limit = await this.threshold();
    const ce = confirmError(est, c, limit);
    if (ce) return bad(ce, "confirm_required", est.usd);
    return { ok: true, plan: { kind, prompt, model: c.model, n, aspect_ratio: aspect, files, est } };
  }

  async run(c: GenCommand): Promise<{ ok: true } | { ok: false; error: string }> {
    const p = await this.plan(c);
    if (!p.ok) return { ok: false, error: p.reject.error };
    if (p.plan.kind === "video") return this.runVideo(p.plan);
    const { prompt, model, n, aspect_ratio, files, est } = p.plan;
    const h = this.d.host, conv = h.convId, store = this.d.files!;
    const { turn, signal } = h.begin();
    const written: string[] = [];
    // Usage accounting: once a provider request has been dispatched, exactly ONE image usage row is attempted on every exit path.
    let dispatched = false, recorded = false;
    const acct = { known: 0, uncertain: true, inTok: 0, outTok: 0 }; // pessimistic until the settled results are read
    const dispatchId = crypto.randomUUID();
    const recordOnce = async (units: number, forceNull = false) => {
      if (!dispatched || recorded) return;
      const total = !forceNull && (acct.known > 0 || !acct.uncertain) ? acct.known : null;
      recorded = await this.record(dispatchId, "image", conv, model, acct.inTok, acct.outTok, total, est.usd, units);
    };
    const uncertainNote = () => (acct.known > 0 && !acct.uncertain ? "" : ` Billing may be uncertain (estimated ${money(est.usd)}).`);
    try {
      h.open(turn, model, prompt, files);
      const refs: ImagePayload[] = [];
      for (const f of files) {
        const bytes = await store.get(f.ref);
        if (!bytes) throw new ProviderError("A reference image is no longer available.", 404);
        if (bytes.length > MAX_REF_IMAGE_BYTES) throw new ProviderError("A reference image is larger than 7 MB.", 413);
        refs.push({ mime_type: f.mime, data: toBase64(bytes) });
      }
      const req = { model, prompt, ...(refs.length ? { images: refs } : {}), ...(aspect_ratio ? { aspect_ratio } : {}) };
      // The gateway takes ONE image request per call (no `n`; unknown keys are rejected), so n images = n calls, run GEN_CONCURRENCY at a
      // time. Each result is validated, written to R2 and DROPPED before the next call starts: at most GEN_CONCURRENCY max-size bodies
      // (+ their decode copies) are ever in memory, never n of them (see MAX_GEN_IMAGE_BYTES in files.ts for the numbers).
      h.markDispatched({ id: dispatchId, kind: "image", model, est_usd: est.usd });
      dispatched = true;
      const blocks: Block[] = [];
      const perCallEst = est.usd / n;
      const hard: unknown[] = [], soft: ProviderError[] = [];
      let images = 0, okCount = 0, totalBytes = 0, sent = 0;
      acct.known = 0; acct.inTok = 0; acct.outTok = 0; acct.uncertain = true; // pessimistic until every dispatched call has settled
      let knownAll = true;
      while (sent < n && (sent === 0 || !signal.aborted)) {
        const batch = Math.min(GEN_CONCURRENCY, n - sent); sent += batch;
        const settled = await Promise.allSettled(Array.from({ length: batch }, () => this.d.provider.image!(req, signal)));
        // What the gateway reported, captured BEFORE any validation / R2 write so a later failure still records it.
        for (const st of settled) {
          if (st.status === "fulfilled") {
            const c1 = cost((st.value as ImageResult).cost?.usd);
            if (c1 === null) knownAll = false; else acct.known += c1;
            acct.inTok += (st.value as ImageResult).usage?.input_tokens ?? 0; acct.outTok += (st.value as ImageResult).usage?.output_tokens ?? 0;
          } else if (st.reason instanceof ProviderError && SOFT_ERRORS.has(st.reason.info.type ?? "")) {
            const u = st.reason.info.usage;
            if (u) { acct.inTok += u.input_tokens; acct.outTok += u.output_tokens; }
            // Unknown unless the gateway says an explicit cost (incl. 0); zero/missing tokens never establish $0 (the provider may still bill).
            const c1 = cost(st.reason.info.costUsd);
            if (c1 === null) knownAll = false; else acct.known += c1;
          } else knownAll = false;
        }
        acct.uncertain = !knownAll || sent < n || signal.aborted; // calls not yet dispatched are not billed, but keep the flag until the loop ends
        for (const st of settled) {
          if (st.status === "rejected") {
            if (st.reason instanceof ProviderError && SOFT_ERRORS.has(st.reason.info.type ?? "")) soft.push(st.reason); else hard.push(st.reason);
            continue;
          }
          const r = st.value as ImageResult; okCount++;
          const c1 = cost(r.cost?.usd);
          if (r.images.length > MAX_GEN_IMAGES_PER_RESPONSE) throw new ProviderError("The image service returned too many images.", 502, { type: "api_error" });
          const usable = r.images.filter((i) => GEN_IMAGE_MIMES[i.mime_type]);
          for (const img of usable) { // bounds on the base64 text, before anything is decoded or written
            const why = genImageProblem(img.data);
            if (why) throw new ProviderError(`The image service returned an invalid or oversized image (${why}).`, 502, { type: "api_error" });
            totalBytes += b64DecodedLen(img.data);
            if (totalBytes > MAX_GEN_TOTAL_BYTES) throw new ProviderError("The image service returned more image data than allowed.", 502, { type: "api_error" });
          }
          for (const img of usable) {
            const key = genKey(conv, img.mime_type);
            await store.put!(key, fromBase64(img.data), img.mime_type, conv);
            written.push(key); images++;
            blocks.push({ type: "gen_image", ref: key, mime: img.mime_type, prompt, model, cost_usd: c1 === null ? null : c1 / usable.length, est_usd: perCallEst / usable.length });
          }
          r.images = []; // drop the base64 now that it is in R2
          if (r.text) blocks.push({ type: "text", text: r.text });
          if (!usable.length) blocks.push({ type: "text", text: `No image was generated${r.finish_reason && r.finish_reason !== "STOP" ? ` (${r.finish_reason})` : ""}. Try rephrasing the prompt.` });
        }
      }
      const stopped = signal.aborted;
      acct.uncertain = !knownAll || hard.length > 0 || stopped;
      for (const e of soft) blocks.push({ type: "text", text: cost(e.info.costUsd) === null ? `${e.message} No image was returned; the provider may still have charged for the request.` : e.message });
      if (!okCount && !soft.length) { // every call failed for real: an error card, no assistant message, estimate kept
        await recordOnce(0, true);
        const first = hard[0];
        if (stopped) { await h.finish(turn, "interrupted"); return { ok: true }; }
        const pe = first instanceof ProviderError ? first : null;
        const msg = pe ? pe.message : "Image generation failed.";
        const err = { type: pe?.info.type ?? "gen_failed", status: pe?.status, retryable: false, message: `${msg} Billing uncertain (estimated ${money(est.usd)}).` };
        await h.finish(turn, "error", err);
        return { ok: true };
      }
      if (hard.length) blocks.push({ type: "text", text: `${hard.length} of ${sent} requests failed${hard[0] instanceof ProviderError ? `: ${hard[0].message}` : ""}. Billing uncertain for those (estimated ${money(perCallEst * hard.length)}).` });
      if (stopped) blocks.push({ type: "text", text: "Stopped. Requests already sent may still be billed." });
      await recordOnce(images); // before the transcript write: a failure after this point cannot produce a second row
      h.saveAssistant(turn, model, blocks, !acct.uncertain || acct.known > 0 ? acct.known : null, images ? "gen_image" : "gen_filtered", stopped ? "interrupted" : "complete");
      await h.finish(turn, stopped ? "interrupted" : "done");
      return { ok: true };
    } catch (e) {
      if (written.length) await store.delete?.(written).catch((e) => console.error("gen rollback: r2 delete failed", String(e))); // nothing in the transcript references them: do not leak objects
      await recordOnce(0); // malformed/oversized data, R2 failure, abort, crash: gateway-reported cost kept when known, else NULL + estimate
      if (signal.aborted) { await h.finish(turn, "interrupted"); return { ok: true }; }
      const pe = e instanceof ProviderError ? e : null;
      console.error("generation crashed", e instanceof Error ? e.message : String(e));
      await h.finish(turn, "error", { type: pe?.info.type ?? "internal_error", retryable: false, message: `${pe ? pe.message : "Image generation failed."}${dispatched ? uncertainNote() : ""}` });
      return { ok: true };
    }
  }

  /** One clip, one call (no n, no reference images in v1). Units of the usage row = SECONDS of video delivered (0 when none). */
  private async runVideo(p: GenPlan): Promise<{ ok: true }> {
    const { prompt, model, aspect_ratio, est } = p;
    const seconds = p.seconds!, resolution = p.resolution!;
    const h = this.d.host, conv = h.convId, store = this.d.files!;
    const { turn, signal } = h.begin();
    let written: string | null = null;
    // Same accounting contract as images: once dispatched, exactly ONE usage row on every exit path; NULL cost (+ estimate) unless the
    // gateway reported one.
    let dispatched = false, recorded = false, known: number | null = null, inTok = 0, outTok = 0;
    const dispatchId = crypto.randomUUID();
    const recordOnce = async (units: number) => {
      if (!dispatched || recorded) return;
      recorded = await this.record(dispatchId, "video", conv, model, inTok, outTok, known, est.usd, units);
    };
    const uncertain = () => (known === null ? ` Billing uncertain (estimated ${money(est.usd)}).` : "");
    const say = async (text: string, status: "complete" | "interrupted" = "complete") => {
      h.saveAssistant(turn, model, [{ type: "text", text }], known, "gen_filtered", status);
      await h.finish(turn, status === "interrupted" ? "interrupted" : "done");
      return { ok: true as const };
    };
    try {
      h.open(turn, model, prompt, [], "video");
      const req: VideoRequest = { model, prompt, duration_seconds: seconds, resolution, ...(aspect_ratio ? { aspect_ratio } : {}) };
      h.markDispatched({ id: dispatchId, kind: "video", model, est_usd: est.usd });
      dispatched = true;
      let r: VideoResult;
      try {
        r = await this.d.provider.video!(req, signal);
      } catch (e) {
        if (!(e instanceof ProviderError) || !SOFT_ERRORS.has(e.info.type ?? "") || signal.aborted) throw e;
        known = cost(e.info.costUsd); // the model said no: a normal message, cost as the gateway reported it
        await recordOnce(0);
        return await say(`${e.message}${uncertain()}`);
      }
      // What the gateway reported, captured BEFORE validation / R2 write so a later failure still records it.
      known = cost(r.cost?.usd); inTok = r.usage?.input_tokens ?? 0; outTok = r.usage?.output_tokens ?? 0;
      const v = r.video;
      if (!v || !GEN_VIDEO_MIMES[v.mime_type]) {
        await recordOnce(0);
        return await say(`No video was generated${r.finish_reason && r.finish_reason !== "completed" ? ` (${r.finish_reason})` : ""}. Try rephrasing the prompt.${uncertain()}`);
      }
      const why = genVideoProblem(v.data);
      if (why) throw new ProviderError(`The video service returned an invalid or oversized video (${why}).`, 502, { type: "api_error" });
      const secs = typeof v.duration_seconds === "number" && v.duration_seconds > 0 && v.duration_seconds <= VIDEO_SECONDS_MAX ? v.duration_seconds : seconds;
      const key = genKey(conv, v.mime_type);
      let bytes: Uint8Array | null = fromBase64(v.data);
      r.video = null; // drop the base64 before the R2 write: one decoded copy in memory, not two
      const size = bytes.length;
      await store.put!(key, bytes, v.mime_type, conv);
      bytes = null; written = key;
      // A stop that lands after the clip arrived changes nothing: it is paid for and stored, so it is shown.
      await recordOnce(secs); // before the transcript write: a failure after this point cannot produce a second row
      h.saveAssistant(turn, model, [{ type: "gen_video", ref: key, mime: v.mime_type, seconds: secs, resolution: v.resolution ?? resolution, ...(aspect_ratio ? { aspect_ratio } : {}),
        has_audio: v.has_audio ?? null, size, prompt, model, cost_usd: known, est_usd: est.usd }], known, "gen_video", "complete");
      await h.finish(turn, "done", undefined, "video");
      return { ok: true };
    } catch (e) {
      if (written) await store.delete?.([written]).catch((e) => console.error("gen rollback: r2 delete failed", String(e)));
      await recordOnce(0);
      if (signal.aborted) return await say(`Stopped. The video request was already sent and may still be billed (estimated ${money(est.usd)}).`, "interrupted");
      const pe = e instanceof ProviderError ? e : null;
      console.error("video generation failed", e instanceof Error ? e.message : String(e));
      await h.finish(turn, "error", { type: pe?.info.type ?? "internal_error", status: pe?.status, retryable: false, message: `${pe ? pe.message : "Video generation failed."}${dispatched ? uncertain() : ""}` });
      return { ok: true };
    }
  }

  /** Inserts the usage row (idempotent on dispatchId) and clears the persisted dispatch marker ONLY after it succeeded. On failure the
   *  marker stays (ChatEngine.init() retries the same id later, never a second row) and false is returned. Never throws. */
  private async record(dispatchId: string, kind: GenKind, conv: string, model: string, input: number, output: number, costUsd: number | null, estUsd: number, units: number): Promise<boolean> {
    try {
      if (conv) await this.d.index.recordUsage({ conversationId: conv, model, usage: { input_tokens: input, output_tokens: output }, costUsd, kind, estUsd, units, dispatchId });
      this.d.host.markDispatched(null);
      return true;
    } catch (e) { console.error("usage", String(e)); return false; }
  }
}
