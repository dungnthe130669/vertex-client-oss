import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createApp } from "../src/index";
import { makeSession } from "../src/auth";
// Real Durable Object + D1 in workerd: fork copies the transcript before the chosen user message into a NEW conversation; the original is untouched.
const e = { ...(env as any), ALLOWED_GITHUB_LOGINS: "example-user" };
const ORIGIN = "https://app.test";
const T = (text: string) => ({ type: "text", text });
const doFetch = (id: string, path: string, init?: RequestInit) => e.CHAT.get(e.CHAT.idFromName(id)).fetch(new Request(`https://do.internal${path}`, { ...init, headers: { "x-conv-id": id } }));

describe("fork on a real ChatSession DO", () => {
  it("seeds the prefix into the fork, leaves the original alone, refuses to seed a non-empty conversation", async () => {
    const app = createApp();
    const { cookie, session } = await makeSession(e, "example-user", "github");
    const api = (method: string, path: string, body?: unknown) => app.fetch(new Request(ORIGIN + path, { method, headers: { cookie: cookie.split(";")[0], "x-csrf-token": session.csrf, origin: ORIGIN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), e);
    const src = ((await (await api("POST", "/api/conversations", { model: "claude-sonnet-5-5" })).json()) as any).id as string;
    const msgs = [{ role: "user", content: [T("one")] }, { role: "assistant", content: [T("ONE")] }, { role: "user", content: [T("two")] }, { role: "assistant", content: [T("TWO")] }];
    expect((await doFetch(src, "/seed", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5-5", title: "Src", messages: msgs }) })).status).toBe(200);
    expect((await doFetch(src, "/seed", { method: "POST", body: JSON.stringify({ model: "m", title: "", messages: msgs }) })).status).toBe(409);
    await api("PATCH", `/api/conversations/${src}`, { title: "Src" });
    const before = (await (await doFetch(src, "/state")).json()) as any;
    const second = before.messages.find((m: any) => m.role === "user" && m.content[0].text === "two").id;
    // the source chat is in Bypass (set over its real socket with a confirmation); the fork must still start in Ask
    const sw = (await e.CHAT.get(e.CHAT.idFromName(src)).fetch(new Request("https://do.internal/ws?since=0", { headers: { upgrade: "websocket", "x-conv-id": src } }))) as any; expect(sw.status).toBe(101); sw.webSocket.accept();
    sw.webSocket.send(JSON.stringify({ t: "mode", mode: "bypass", confirmed: true, confirmVersion: 1 }));
    for (let i = 0; i < 200 && ((await (await doFetch(src, "/state")).json()) as any).approvalMode !== "bypass"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(((await (await doFetch(src, "/state")).json()) as any).approvalMode).toBe("bypass");
    const r = await api("POST", `/api/conversations/${src}/fork`, { message_id: second });
    expect(r.status).toBe(201);
    const fk = (await r.json()) as any;
    const st = (await (await doFetch(fk.id, "/state")).json()) as any;
    expect(st.messages.map((m: any) => m.content[0].text)).toEqual(["one", "ONE"]);
    expect(st.model).toBe("claude-sonnet-5-5");
    expect(st.approvalMode).toBe("ask"); expect(((await (await doFetch(src, "/state")).json()) as any).approvalMode).toBe("bypass"); // not inherited; the original keeps its own
    expect(st.title).toBe("Src (edited)");
    const after = (await (await doFetch(src, "/state")).json()) as any;
    expect(after.messages.length).toBe(4);
    const got = (await (await api("GET", `/api/conversations/${fk.id}`)).json()) as any;
    expect(got.conversation.title).toBe("Src (edited)");
    expect(got.conversation.createdAt).toBeTruthy();
  });
});
