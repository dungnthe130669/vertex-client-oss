// Team gateway /v1/models carries only {id, object, owned_by}: the app derives kind/display name from the id (team4 bugs B1/B2).
import { beforeEach, describe, expect, test } from "vitest";
import { classifyTeamModel, clearEntitlementCache, teamGatewayProvider } from "../src/providers/team-gateway";

const IDS = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-image", "text-embedding-005"];
const fakeFetch = (async (input: string | URL | Request) => {
  const u = new URL(String(input));
  if (u.pathname === "/v1/entitlements") return Response.json({ features: ["vclient_app", "chat", "image_gen"] });
  if (u.pathname === "/v1/models") return Response.json({ object: "list", data: IDS.map((id) => ({ id, object: "model", owned_by: "vertex" })) });
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;
const env = { TEAM_GATEWAY_URL: "https://gw.example", VCLIENT_TEAM_CALLER_KEY: "CALLER-KEY-FAKE" };

describe("team model lists", () => {
  beforeEach(() => clearEntitlementCache());
  const p = () => teamGatewayProvider(env, "ann@example.com", fakeFetch);
  test("chat list: claude-* only, no image/embedding, no gemini chat (B1+B2)", async () => {
    expect((await p().listModels()).map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
  });
  test("image list: the image model with a display name; nothing else leaks", async () => {
    const l = await p().listModels("image");
    expect(l).toEqual([{ id: "gemini-2.5-flash-image", displayName: "Gemini 2.5 Flash Image", kind: "image" }]);
  });
  test("embedding is excluded everywhere; an explicit gateway kind is respected", () => {
    expect(classifyTeamModel({ id: "text-embedding-005" })).toBeNull();
    expect(classifyTeamModel({ id: "gemini-2.5-pro" })).toBeNull();
    expect(classifyTeamModel({ id: "claude-x", kind: "chat", display_name: "X" })).toMatchObject({ kind: "chat", display_name: "X" });
  });
});

import { MODELS_META as MODELS } from "../src/models-meta";
test("B5: sonnet-5-5 cacheRead matches the gateway rate (0.1)", () => { expect((MODELS as any)["claude-sonnet-5-5"].price.cacheRead).toBe(0.1); });
