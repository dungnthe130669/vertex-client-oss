import { describe, expect, it } from "vitest";
import { testApp } from "@cf-lite/testing";
import { env } from "cloudflare:workers";
import worker from "../server/worker";

// Image generation through the REAL ChatSession DO in workerd: e2e-scope session => deterministic stub provider (no network, no $),
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
const gen = (o: Record<string, unknown> = {}) => ({ t: "generate", kind: "image", prompt: "a red cube", model: "e2e-stub-image", ...o });

describe("generate over the WebSocket (e2e scope => stub provider)", () => {
  it("1 image: DO writes R2 gen/, saves the block, image is fetchable authed, usage shows Generation, delete removes the object", async () => {
    const { csrf, id } = await login();
    const s = await socket(id);
    s.send(gen());
    await s.until((f) => ended(f));
    const st = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(st.running).toBe(false);
    expect(st.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    const blk = st.messages[1].content[0];
    expect(blk).toMatchObject({ type: "gen_image", mime: "image/png", model: "e2e-stub-image", cost_usd: 0.045, est_usd: 0.045 });
    expect(blk.ref).toMatch(new RegExp(`^vertex-client/${id}/gen/[0-9a-f-]{36}\\.png$`));
    expect(JSON.stringify(st)).not.toContain("iVBOR"); // no base64 in DO state

    const img = await a.fetch(`/api/conversations/${id}/files/${blk.ref.split("/").slice(2).join("/")}`);
    expect(img.status).toBe(200); expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())[1]).toBe(0x50);
    expect(await (env as any).FILES.head(blk.ref)).not.toBeNull();

    const usage = (await (await a.fetch("/api/usage")).json()) as any;
    expect(usage.today.gen.map((g: any) => [g.key, g.units, g.calls])).toEqual([["image · e2e-stub-image", 1, 1]]);

    // reload persistence: a brand-new socket replays nothing it needs; state alone carries the block
    expect(((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state.messages[1].content[0].ref).toBe(blk.ref);

    expect((await a.fetch(`/api/conversations/${id}`, mut(csrf, { method: "DELETE" }))).status).toBe(200);
    expect(await (env as any).FILES.head(blk.ref)).toBeNull();
    expect((await a.fetch(`/api/conversations/${id}/files/${blk.ref.split("/").slice(2).join("/")}`)).status).toBe(404);
    s.ws.close();
  });

  it("estimate > $1: rejected with a typed error and NOTHING happens; with confirmed + est_usd it runs", async () => {
    const { csrf, id } = await login();
    const s = await socket(id);
    s.send(gen({ model: "e2e-stub-pro-image", n: 3 }));
    await s.until((f) => f.some((x) => x.t === "rejected"));
    const rej = s.frames.find((x) => x.t === "rejected");
    expect(rej).toMatchObject({ code: "confirm_required", est_usd: 1.2 });
    expect(rej.error).toContain("confirmation required");
    let st = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(st.messages).toEqual([]);
    expect(((await (await a.fetch("/api/usage")).json()) as any).today.gen).toEqual([]);

    s.send(gen({ model: "e2e-stub-pro-image", n: 3, confirmed: true, est_usd: 0.1 }));
    await s.until((f) => f.filter((x) => x.t === "rejected").length >= 2);
    expect(s.frames.filter((x) => x.t === "rejected")[1].error).toContain("does not cover");

    s.send(gen({ model: "e2e-stub-pro-image", n: 3, confirmed: true, est_usd: 1.2 }));
    await s.until((f) => ended(f));
    st = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(st.messages[1].content.filter((b: any) => b.type === "gen_image")).toHaveLength(3);
    expect(st.messages[1].costUsd).toBeCloseTo(1.2, 6);
    expect(((await (await a.fetch("/api/usage")).json()) as any).today.gen[0]).toMatchObject({ units: 3, calls: 1 });
    await a.fetch(`/api/conversations/${id}`, mut(csrf, { method: "DELETE" }));
    s.ws.close();
  });

  it("a filtered result (prompt says 'blocked') is a normal assistant text message and no image", async () => {
    const { csrf, id } = await login();
    const s = await socket(id);
    s.send(gen({ prompt: "a blocked scene" }));
    await s.until((f) => ended(f));
    const st = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(st.error).toBeNull();
    expect(st.messages[1].content[0].type).toBe("text");
    expect(st.messages[1].content.some((b: any) => b.type === "gen_image")).toBe(false);
    await a.fetch(`/api/conversations/${id}`, mut(csrf, { method: "DELETE" }));
    s.ws.close();
  });

  it("a reference image from this conversation is accepted; another conversation's ref is refused", async () => {
    const { csrf, id } = await login();
    const other = ((await (await a.fetch("/api/conversations", mut(csrf, { method: "POST", body: "{}" }))).json()) as { id: string }).id;
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP438PwH4QZYAwAXJIKKXIKGZIAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
    const up = await a.fetch(`/api/conversations/${id}/files?name=ref.png`, mut(csrf, { method: "POST", body: png, headers: { "content-type": "image/png" } }));
    const f = (await up.json()) as { ref: string; name: string; mime: string; size: number };
    const s = await socket(id);
    s.send(gen({ files: [f] }));
    await s.until((fr) => ended(fr));
    const st = ((await (await a.fetch(`/api/conversations/${id}`)).json()) as any).state;
    expect(st.messages[0].content[0]).toMatchObject({ type: "file_ref", ref: f.ref });
    expect(st.messages[1].content.some((b: any) => b.type === "gen_image")).toBe(true);
    s.send(gen({ files: [{ ...f, ref: f.ref.replace(id, other) }] }));
    await s.until((fr) => fr.some((x) => x.t === "rejected"));
    expect(s.frames.find((x) => x.t === "rejected").error).toBe("bad file reference");
    for (const c of [id, other]) await a.fetch(`/api/conversations/${c}`, mut(csrf, { method: "DELETE" }));
    s.ws.close();
  });
});
