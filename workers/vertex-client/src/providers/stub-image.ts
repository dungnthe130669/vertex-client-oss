// Deterministic fake image provider for e2e: no network, no money. Chosen per conversation scope in ChatSession and in /api/gen/models:
// ONLY the e2e user (scope 'e2e', i.e. a session minted by POST /auth/e2e) is ever routed here; Erich's 'main' scope never is.
import { E2E_STUB_RATES } from "../gen-cost";
import type { ImageRequest, ImageResult, ProviderModel } from "./types";

// A real, valid 2x2 RGBA PNG (opaque orange), so <img> decodes it and naturalWidth > 0 in the browser.
export const STUB_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP438PwH4QZYAwAXJIKKXIKGZIAAAAASUVORK5CYII=";

export const stubImageModels = (): ProviderModel[] => [
  { id: "e2e-stub-image", displayName: "E2E stub image", kind: "image", price: { unitEstimateUsd: E2E_STUB_RATES["e2e-stub-image"].perImage, verified: false } },
  { id: "e2e-stub-pro-image", displayName: "E2E stub pro image", kind: "image", price: { unitEstimateUsd: E2E_STUB_RATES["e2e-stub-pro-image"].perImage, verified: false } },
];

export function stubImage(req: ImageRequest): ImageResult {
  const rate = E2E_STUB_RATES[req.model];
  if (!rate) return { model: req.model, images: [], text: null, finish_reason: "SAFETY", cost: { usd: 0, basis: "stub" } };
  // A prompt containing "blocked" simulates a safety-filtered result (no image, finish_reason != STOP).
  if (/\bblocked\b/i.test(req.prompt)) return { model: req.model, images: [], text: "Stub: the prompt was filtered.", finish_reason: "SAFETY", cost: { usd: 0, basis: "stub" } };
  return { id: "img_stub", model: req.model, images: [{ mime_type: "image/png", data: STUB_PNG_B64 }], text: null, finish_reason: "STOP",
    usage: { input_tokens: 10, output_tokens: 1120, image_tokens: 1120 }, cost: { usd: rate.perImage, basis: "stub", estimate_usd: rate.perImage, price_verified: false } };
}
