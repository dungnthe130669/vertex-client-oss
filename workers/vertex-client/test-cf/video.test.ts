import { describe, expect, it } from "vitest";
import { testApp } from "@cf-lite/testing";
import { env } from "cloudflare:workers";
import worker from "../server/worker";

// Video generation through the REAL ChatSession DO in workerd: e2e-scope session => deterministic stub provider (no network, no $),
// real R2 (FILES), real D1 (migrations applied), real alarm path. Covers the WebSocket `generate` command end to end.
const ORIGIN = "https://app.test";
const E2E = "e2e-test-token-0123456789abcdef0123456789abcdef";
const a = testApp({ worker, origin: ORIGIN, env: { ASSETS: { fetch: async () => new Response("<!doctype html>") } } });
const mut = (csrf: string, init: RequestInit = {}) => ({ ...init, headers: { origin: ORIGIN, "x-csrf-token": csrf, ...(init.headers as object) } });
async function login() {
  expect((await a.fetch("/auth/e2e", { method: "POST", headers: { "x-e2e-token": E2E, origin: ORIGIN } })).status).toBe(200);
  const csrf = ((await (await a.fetch("/api/me")).json()) as { csrf: string }).csrf;
  const id = ((await (await a.fetch("/api/conversations", mut(csrf, { method: "POST", body: "{}" }))).json()) as { id: string }).id;
  return { csrf, id };
}
async function socket(id: string) {
  const r = await a.fetch(`/api/conversations/${id}/ws?since=0`, { headers: { upgrade: "websocket", origin: ORIGIN } });
  expect(r.status).toBe(101);
  const ws = r.webSocket!; ws.accept();
  const frames: any[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => { frames.push(JSON.parse(String(e.data))); waiters.splice(0).forEach((w) => w()); });
  const until = async (pred: (f: any[]) => boolean, ms = 8000) => {
    const t0 = Date.now();
    while (!pred(frames)) { if (Date.now() - t0 > ms) throw new Error("timeout; frames=" + JSON.stringify(frames.map((f) => f.e?.type ?? f.t))); await new Promise<void>((res) => { waiters.push(res); setTimeout(res, 50); }); }
  };
  await until((f) => f.some((x) => x.t === "hello"));
  return { ws, frames, until, send: (o: unknown) => ws.send(JSON.stringify(o)) };
}
const ended = (f: any[], n = 1) => f.filter((x) => x.e?.type === "turn_end").length >= n;
const gen = (o: Record<string, unknown> = {}) => ({ t: "generate", kind: "video", prompt: "a cat walking", model: "e2e-stub-video", duration_seconds: 3, ...o });
const tailOf = (ref: string) => ref.split("/").slice(2).join("/");

describe("generate kind=video over the WebSocket (e2e scope => stub provider)", () => {
  it("one clip: R2 gen/*.mp4, gen_video block, Range 206 served, usage kind video (units = seconds), delete removes the object", async () => {
    const { csrf, id } = await login();
    const s = await socket(id);
    s.send(gen({ duration_seconds: 5 }));
    await s.until((f) => ended(f));
    expect(s.frames.find((x) => x.e?.type === "turn_start")?.e).toMatchObject({ kind: "video" });
    const st = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(st.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    const blk = st.messages[1].content[0];
    expect(blk).toMatchObject({ type: "gen_video", mime: "video/mp4", seconds: 5, resolution: "360p", model: "e2e-stub-video", cost_usd: 0.175, est_usd: 0.175 });
    expect(blk.ref).toMatch(new RegExp(`^vertex-client/${id}/gen/[0-9a-f-]{36}\\.mp4$`));
    expect(JSON.stringify(st)).not.toContain("AAAAHGZ0eXA"); // no base64 in DO state

    const head = await (env as any).FILES.head(blk.ref);
    expect(head.size).toBe(2818);
    const probe = await a.fetch(`/api/conversations/${id}/files/${tailOf(blk.ref)}`, { headers: { range: "bytes=0-1" } });
    expect(probe.status).toBe(206);
    expect(probe.headers.get("content-range")).toBe("bytes 0-1/2818");
    expect(probe.headers.get("content-type")).toBe("video/mp4");
    expect((await probe.arrayBuffer()).byteLength).toBe(2);
    const full = await a.fetch(`/api/conversations/${id}/files/${tailOf(blk.ref)}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect((await full.arrayBuffer()).byteLength).toBe(2818);
    expect((await a.fetch(`/api/conversations/${id}/files/${tailOf(blk.ref)}`, { headers: { range: "bytes=5000-" } })).status).toBe(416);

    const usage = (await (await a.fetch("/api/usage")).json()) as any;
    expect(usage.today.gen.find((g: any) => g.key === "video · e2e-stub-video")).toMatchObject({ units: 5, calls: 1 });

    expect((await a.fetch(`/api/conversations/${id}`, mut(csrf, { method: "DELETE" }))).status).toBe(200);
    expect(await (env as any).FILES.head(blk.ref)).toBeNull();
    expect((await a.fetch(`/api/conversations/${id}/files/${tailOf(blk.ref)}`)).status).toBe(404);
    s.ws.close();
  });

  it("> $1 (pro stub, 8 s = $1.20): rejected with confirm_required and nothing happens; confirmed runs it", async () => {
    const { csrf, id } = await login();
    const s = await socket(id);
    s.send(gen({ model: "e2e-stub-pro-video", duration_seconds: 8 }));
    await s.until((f) => f.some((x) => x.t === "rejected"));
    expect(s.frames.find((x) => x.t === "rejected")).toMatchObject({ code: "confirm_required", est_usd: 1.2 });
    expect(((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state.messages).toEqual([]);
    s.send(gen({ model: "e2e-stub-pro-video", duration_seconds: 8, confirmed: true, est_usd: 1.2 }));
    await s.until((f) => ended(f));
    const st = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(st.messages[1].content[0]).toMatchObject({ type: "gen_video", seconds: 8 });
    await a.fetch(`/api/conversations/${id}`, mut(csrf, { method: "DELETE" }));
    s.ws.close();
  });

  it("while a slow call runs, /state reports generating video with a start time; stop ends it as interrupted with the billing note", async () => {
    const { csrf, id } = await login();
    const s = await socket(id);
    s.send(gen({ prompt: "a slow cat" }));
    await s.until((f) => f.some((x) => x.e?.type === "turn_start"));
    const st = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(st).toMatchObject({ running: true, generating: true, genKind: "video" });
    expect(typeof st.genStartedAt).toBe("number");
    s.send({ t: "stop" });
    await s.until((f) => ended(f));
    const after = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(after.messages[1]).toMatchObject({ status: "interrupted" });
    expect(after.messages[1].content[0].text).toContain("may still be billed");
    await a.fetch(`/api/conversations/${id}`, mut(csrf, { method: "DELETE" }));
    s.ws.close();
  });

  it("504 upstream_timeout ('timeout' prompt): error card, not retryable, billing uncertain; no R2 object", async () => {
    const { csrf, id } = await login();
    const s = await socket(id);
    s.send(gen({ prompt: "timeout please" }));
    await s.until((f) => ended(f));
    const end = s.frames.find((x) => x.e?.type === "turn_end").e;
    expect(end.status).toBe("error");
    expect(end.error).toMatchObject({ type: "upstream_timeout", retryable: false });
    expect(end.error.message).toContain("Billing uncertain");
    const listed = await (env as any).FILES.list({ prefix: `vertex-client/${id}/gen/` });
    expect(listed.objects).toEqual([]);
    await a.fetch(`/api/conversations/${id}`, mut(csrf, { method: "DELETE" }));
    s.ws.close();
  });
});
