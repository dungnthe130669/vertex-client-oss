import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createApp } from "../src/index";
import { makeSession } from "../src/auth";
import { takeTranscribeSlot } from "../src/transcribe";
// Real D1 in workerd: the per-scope hourly counter (INSERT .. ON CONFLICT .. RETURNING) and the route end to end with a stub AI binding.
const ORIGIN = "https://app.test";
describe("transcribe on real D1", () => {
  it("counter: counts, limits, is per scope, rolls over with the hour", async () => {
    const t = 1_800_000_000_000;
    for (let i = 0; i < 2; i++) expect(await takeTranscribeSlot((env as any).DB, "main", t, 2)).toBe(true);
    expect(await takeTranscribeSlot((env as any).DB, "main", t, 2)).toBe(false);
    expect(await takeTranscribeSlot((env as any).DB, "e2e", t, 2)).toBe(true);
    expect(await takeTranscribeSlot((env as any).DB, "main", t + 3_600_000, 2)).toBe(true);
  });
  it("route: 200 with a stub AI, 503 without", async () => {
    const e: any = { ...(env as any), AI: { run: async () => ({ text: "ok" }) } };
    const { cookie, session } = await makeSession(e, "example-user", "github");
    const go = (en: any) => createApp().fetch(new Request(ORIGIN + "/api/transcribe", { method: "POST", headers: { cookie: cookie.split(";")[0], "x-csrf-token": session.csrf, origin: ORIGIN, "content-type": "audio/mp4" }, body: Uint8Array.from({ length: 2048 }, (_, i) => [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70][i] ?? 7) }), en);
    expect(await (await go(e)).json()).toEqual({ text: "ok" });
    expect((await go({ ...e, AI: undefined })).status).toBe(503);
  });
});
