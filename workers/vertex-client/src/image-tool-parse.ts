// Web-safe half of image-tool.ts (no server imports): the shape of a generate_image tool result and its parser.
export const IMAGE_TOOL = "generate_image";
export type ImageToolResult = { generated_image: { ref: string; mime: string; prompt: string; model: string; cost_usd: number | null; est_usd: number; /** which service produced it (generate_image in Open) */ backend?: string }; note?: string };
export function parseImageToolResult(tool: string, text: string): ImageToolResult["generated_image"] | null {
  if (tool !== IMAGE_TOOL && tool !== "web_screenshot") return null; // web_screenshot (Open Cloudflare tools) reuses the same result shape/card
  try {
    const g = (JSON.parse(text) as Partial<ImageToolResult>).generated_image;
    return g && typeof g.ref === "string" && typeof g.mime === "string" ? g : null;
  } catch { return null; }
}

