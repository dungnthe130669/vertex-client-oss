// Web Push for device approvals: the pure helper with a recording sender (no network, no secrets).
import { describe, expect, test } from "bun:test";
import { PUSH_DEBOUNCE_MS, approvalPayload, previewBase, pushApprovalRequest } from "../src/device-push";

const NOW = 1_800_000_000_000;
const mk = (over: Partial<Parameters<typeof pushApprovalRequest>[0]> = {}, d: { flag?: boolean; pending?: boolean; name?: string; fail?: boolean } = {}) => {
  const sent: any[] = [];
  const deps = {
    flagOn: async () => d.flag ?? true, deviceName: async () => d.name ?? "Erich's laptop", pending: () => d.pending ?? true,
    push: async (p: any) => { if (d.fail) throw new Error("boom"); sent.push(p); return { sent: 1, failed: 0, errors: [] as string[] }; },
  };
  const a = { scope: "main", deviceId: "dev12345", rid: "req-1", tool: "Write", preview: "/home/u/proj/secret.env\nAPI_KEY=hunter2", expiresAt: NOW / 1000 + 300, nowMs: NOW, watching: false, lastPushMs: 0, ...over };
  return { sent, run: () => pushApprovalRequest(a, deps) };
};

describe("device approval push", () => {
  test("sent when no PWA socket is watching: title, tag = request id, deep link", async () => {
    const t = mk(); expect(await t.run()).toBe(true);
    expect(t.sent).toEqual([{ title: "Approval needed", body: "Erich's laptop: Write (secret.env)", url: "/dv/dev12345", tag: "req-1" }]);
  });
  test("not sent while a visible PWA socket is connected", async () => { const t = mk({ watching: true }); expect(await t.run()).toBe(false); expect(t.sent).toHaveLength(0); });
  test("debounce: at most 1 push per device per 10 s", async () => {
    const t = mk({ lastPushMs: NOW - (PUSH_DEBOUNCE_MS - 1) }); expect(await t.run()).toBe(false); expect(t.sent).toHaveLength(0);
    const u = mk({ lastPushMs: NOW - PUSH_DEBOUNCE_MS }); expect(await u.run()).toBe(true);
  });
  test("expired or answered-in-the-meantime requests are not sent", async () => {
    expect(await mk({ expiresAt: NOW / 1000 - 1 }).run()).toBe(false);
    expect(await mk({ expiresAt: NOW / 1000 }).run()).toBe(false);
    const t = mk({}, { pending: false }); expect(await t.run()).toBe(false); expect(t.sent).toHaveLength(0);
  });
  test("flag off and e2e scope send nothing", async () => {
    const t = mk({}, { flag: false }); expect(await t.run()).toBe(false); expect(t.sent).toHaveLength(0);
    const e = mk({ scope: "e2e" }); expect(await e.run()).toBe(false); expect(e.sent).toHaveLength(0);
  });
  test("a failing sender never throws into the approval flow", async () => { const t = mk({}, { fail: true }); expect(await t.run()).toBe(false); });
  test("payload never carries file contents or commands: only tool name + path basename", () => {
    const body = (tool: string, preview: string) => approvalPayload("d", "Box", "r", tool, preview).body;
    expect(body("Write", "/w/a/b/notes.md\nTOKEN=abc123 secret body")).toBe("Box: Write (notes.md)");
    expect(body("Bash", "rm -rf build && curl -H 'Authorization: Bearer xyz'")).toBe("Box: Bash");
    expect(body("Bash", "export API_KEY=hunter2")).toBe("Box: Bash");
    expect(body("Edit", "// comment about the secret\n- old\n+ new")).toBe("Box: Edit");
    expect(body("Write", "import x from './a/b'\nconst k = 'sk-123'")).toBe("Box: Write");
    expect(JSON.stringify(approvalPayload("d", "Box", "r", "Write", "/w/x.ts\nSECRETCONTENT"))).not.toContain("SECRETCONTENT");
  });
  test("previewBase: path-looking first token only; bounded", () => {
    expect(previewBase("~/p/q/f.txt")).toBe("f.txt"); expect(previewBase("./a/b.ts more")).toBe("b.ts"); expect(previewBase("plain words")).toBe("");
    expect(previewBase("//x/y")).toBe(""); expect(previewBase("/" + "a/".repeat(200) + "f")).toBe(""); expect(previewBase("")).toBe("");
    expect(previewBase("/w/" + "n".repeat(100)).length).toBe(60);
  });
});
