// Client-side image prep: phone photos are 3-12 MB; the API caps an image at 5 MB and bills by pixels, so long edge is
// cut to 1568 px (Anthropic's own downscale point — nothing above it is seen anyway) and re-encoded as JPEG.
import { noImageMessage } from "../../src/models-meta";
import { checkUpload, classifyFile, imageCapFor, imageTooLargeMessage, extOf, isCsvMime, UNSUPPORTED_MSG } from "../../src/files";
export const MAX_EDGE = 1568;

/** Composer gate: only CHAT mode sends the picture to the chat model; Image/Video mode references go to the separately selected generation model. */
export const refusalFor = (mode: string, canImages: boolean, f: { type: string; name: string }, modelId = ""): string | null => (mode === "chat" ? imageRefusal(canImages, f, modelId) : null);

/** Paste and drag bypass the picker's `accept` filter, so the composer re-checks here: an image for a model that cannot see images is refused with
 *  a clear message instead of being sent (the engine would replace it with a note and the model would answer "I can't see images"). null = fine. */
export function imageRefusal(canImages: boolean, f: { type: string; name: string }, modelId = ""): string | null {
  if (canImages) return null;
  const isImg = f.type.startsWith("image/") || classifyFile(f.type, f.name)?.kind === "image";
  return isImg ? noImageMessage(modelId) : null;
}

export function fitWithin(w: number, h: number, max = MAX_EDGE): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** What the chip shows an attachment as (icon), from its mime/name. */
export function chipKind(mime: string, name: string): "image" | "pdf" | "code" | "sheet" | "doc" {
  const k = classifyFile(mime, name);
  if (k?.kind === "image") return "image";
  if (k?.kind === "pdf") return "pdf";
  if (k?.kind === "office") return /spreadsheet/.test(k.mime) ? "sheet" : "doc";
  if (k && (isCsvMime(k.mime) || extOf(name) === "csv" || extOf(name) === "tsv")) return "sheet";
  return k && k.mime !== "text/markdown" && !/^(txt|log|md|markdown|rst)$/.test(extOf(name)) ? "code" : "doc";
}
/** "~12k tokens" for the chip; the server's estimate is chars/4. */
export const tokensLabel = (t?: number) => (t ? `~${t >= 1000 ? `${Math.round(t / 100) / 10}k`.replace(/\.0k$/, "k") : t} tok` : "");

/** Images are downsized; PDF/text/code/Office pass through with their mime normalised (browsers send "" or octet-stream for most code files). */
export async function prepareFile(f: File, modelId = ""): Promise<{ blob: Blob; name: string }> {
  const cls = classifyFile(f.type, f.name);
  if (!cls && !f.type.startsWith("image/")) throw new Error(UNSUPPORTED_MSG); // other image/* (e.g. HEIC) still goes through the canvas below
  if (cls && cls.kind !== "image") {
    const bad = checkUpload(cls.mime, f.size, f.name);
    if (bad) throw new Error(bad.error);
    return { blob: f.type === cls.mime ? f : new Blob([f], { type: cls.mime }), name: f.name };
  }
  const bmp = await createImageBitmap(f, { imageOrientation: "from-image" }); // camera photos carry EXIF rotation: bake it in before the canvas drops the tag
  const { w, h } = fitWithin(bmp.width, bmp.height);
  if (w === bmp.width && h === bmp.height && f.size <= Math.min(1_500_000, imageCapFor(modelId)) && /^image\/(png|jpeg|webp|gif)$/.test(f.type)) { bmp.close(); return { blob: f, name: f.name }; }
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h); bmp.close();
  let blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.85));
  if (blob && blob.size > imageCapFor(modelId)) blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.6)); // still over this model's cap: one lower-quality pass
  if (!blob) throw new Error("Could not process the image");
  if (blob.size > imageCapFor(modelId)) throw new Error(imageTooLargeMessage(modelId));
  return { blob, name: f.name.replace(/\.[^.]+$/, "") + ".jpg" };
}
