// Gateway catalog permission flags (allow_chat/image/audio/video) as seen by vclient: entries explicitly denied are dropped, an empty
// kind with the feature on says why (never an empty picker), older gateways without the field keep working.
import { beforeEach, describe, expect, test } from "vitest";
import { NO_MODELS, clearEntitlementCache, teamGatewayProvider } from "../src/providers/team-gateway";

const perm = (o: Partial<Record<"chat" | "image" | "audio" | "video", boolean>>) => ({ chat: false, image: false, audio: false, video: false, ...o });
const mk = (models: unknown[], features = ["vclient_app", "chat", "image_gen", "video_gen"]) => (async (input: string | URL | Request) => {
  const u = new URL(String(input));
  if (u.pathname === "/v1/entitlements") return Response.json({ features });
  if (u.pathname === "/v1/models") return Response.json({ object: "list", data: models });
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;
const env = { TEAM_GATEWAY_URL: "https://gw.example", VCLIENT_TEAM_CALLER_KEY: "CALLER-KEY-FAKE" };
const P = (f: typeof fetch) => teamGatewayProvider(env, "ann@example.com", f);

describe("permission flags from /v1/models", () => {
  beforeEach(() => clearEntitlementCache());
  test("an entry whose own-kind permission is false is dropped; true and absent stay", async () => {
    const f = mk([
      { id: "img-a", kind: "image", display_name: "A", permissions: perm({ image: true }) },
      { id: "img-b", kind: "image", display_name: "B", permissions: perm({ image: false }) },
      { id: "img-old", kind: "image", display_name: "Old" }, // older gateway: no field
    ]);
    expect((await P(f).listModels("image")).map((m) => m.id)).toEqual(["img-a", "img-old"]);
  });
  test("chat and video lists apply the same rule", async () => {
    const f = mk([
      { id: "claude-a", kind: "chat", capabilities: {}, permissions: perm({ chat: true }) },
      { id: "claude-b", kind: "chat", capabilities: {}, permissions: perm({ chat: false }) },
      { id: "vid-a", kind: "video", permissions: perm({ video: true }) },
      { id: "vid-b", kind: "video", permissions: perm({ video: false }) },
    ]);
    expect((await P(f).listModels()).map((m) => m.id)).toEqual(["claude-a"]);
    expect((await P(f).listModels("video")).map((m) => m.id)).toEqual(["vid-a"]);
  });
  test("a malformed permissions field is ignored (treated as not stated), other kinds' flags do not matter", async () => {
    const f = mk([{ id: "i1", kind: "image", permissions: "no" }, { id: "i2", kind: "image", permissions: perm({ image: true, video: false }) }]);
    expect((await P(f).listModels("image")).map((m) => m.id)).toEqual(["i1", "i2"]);
  });
  test("feature on but every image/video model switched off: a plain 403 reason, not an empty list", async () => {
    const f = mk([{ id: "img-b", kind: "image", permissions: perm({ image: false }) }, { id: "vid-b", kind: "video", permissions: perm({ video: false }) }, { id: "claude-a", kind: "chat", capabilities: {}, permissions: perm({ chat: true }) }]);
    await expect(P(f).listModels("image")).rejects.toMatchObject({ status: 403, message: NO_MODELS.image });
    await expect(P(f).listModels("video")).rejects.toMatchObject({ status: 403, message: NO_MODELS.video });
    expect((await P(f).listModels()).map((m) => m.id)).toEqual(["claude-a"]); // chat unaffected
  });
  test("feature off keeps its own message (user-level), unchanged", async () => {
    clearEntitlementCache();
    const f = mk([], ["vclient_app", "chat"]);
    await expect(P(f).listModels("image")).rejects.toMatchObject({ status: 403, message: expect.stringContaining("not enabled for your account") });
  });
  test("reason texts are factual (no promise, no cause guessed)", () => {
    for (const t of Object.values(NO_MODELS)) { expect(t).toMatch(/^No (image|video) models are enabled for the team right now\./); expect(t).not.toMatch(/\$|free|soon/i); }
  });
});
