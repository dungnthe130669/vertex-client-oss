// Video mode controls from the gateway's /v1/models?kind=video `params` (allowed / defaults / values), with a hard-coded fallback for when
// the list cannot be loaded or a field is missing. Pure: unit-tested under bun.
import { VIDEO_DEFAULT_RESOLUTION, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN } from "../../src/gen-cost";

export type VideoParams = { allowed?: string[]; defaults?: Record<string, unknown>; values?: Record<string, unknown> } | null | undefined;
export type VideoOpts = { seconds: number[]; resolutions: string[]; aspects: string[]; defSeconds: number; defResolution: string };

/** Offered durations when the model allows a range ("3..10"): a short list beats a slider on a phone. */
export const PREFERRED_SECONDS = [3, 5, 8, 10];
const FALLBACK: VideoOpts = { seconds: PREFERRED_SECONDS, resolutions: [VIDEO_DEFAULT_RESOLUTION], aspects: ["16:9", "9:16"], defSeconds: 3, defResolution: VIDEO_DEFAULT_RESOLUTION };

const strs = (v: unknown): string[] | null => (Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? (v as string[]) : null);
function secondsFrom(v: unknown): number[] | null {
  const ok = (n: number) => Number.isInteger(n) && n >= VIDEO_SECONDS_MIN && n <= VIDEO_SECONDS_MAX;
  if (Array.isArray(v)) { const xs = v.map(Number).filter(ok); return xs.length ? [...new Set(xs)].sort((a, b) => a - b) : null; }
  const m = typeof v === "string" ? /^(\d+)\s*\.\.\s*(\d+)$/.exec(v) : null;
  if (!m) return null;
  const lo = Math.max(VIDEO_SECONDS_MIN, Number(m[1])), hi = Math.min(VIDEO_SECONDS_MAX, Number(m[2]));
  const xs = PREFERRED_SECONDS.filter((n) => n >= lo && n <= hi);
  return xs.length ? xs : lo <= hi ? [lo] : null;
}

export function videoOptions(p: VideoParams): VideoOpts {
  const v = p?.values ?? {}, d = p?.defaults ?? {};
  const allowed = Array.isArray(p?.allowed) ? p!.allowed : null;
  const seconds = (!allowed || allowed.includes("duration_seconds") ? secondsFrom(v.duration_seconds) : null) ?? FALLBACK.seconds;
  const resolutions = (!allowed || allowed.includes("resolution") ? strs(v.resolution) : null) ?? FALLBACK.resolutions;
  const aspects = allowed && !allowed.includes("aspect_ratio") ? [] : strs(v.aspect_ratio) ?? FALLBACK.aspects;
  const ds = Number(d.duration_seconds);
  const defSeconds = seconds.includes(ds) ? ds : seconds[0];
  const defResolution = typeof d.resolution === "string" && resolutions.includes(d.resolution) ? d.resolution : resolutions.includes(VIDEO_DEFAULT_RESOLUTION) ? VIDEO_DEFAULT_RESOLUTION : resolutions[0];
  return { seconds, resolutions, aspects, defSeconds, defResolution };
}

/** "0:07", "1:42": the running card's elapsed timer. */
export const fmtElapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
