import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/providers/config";
import { NVIDIA_VERIFIED } from "../src/providers/presets";

const row = (over: Record<string, unknown> = {}) => ({ id: "nvidia", kind: "openai-compat", base_url: "https://integrate.api.nvidia.com/v1", key_binding: "PROVIDER_KEY_NVIDIA", auth_header: "bearer", enabled: 1, models_json: "[]", ...over });

describe("fresh NVIDIA row starts with every verified model on", () => {
  test("empty models => all verified", () => {
    const c = parseConfig(row())!;
    expect(c.models.map((m) => m.id)).toEqual(NVIDIA_VERIFIED);
    expect(c.models[0].displayName).toBe("Nemotron 3.5 Lightning 30B");
  });
  test("explicit ticks win", () => {
    const c = parseConfig(row({ models_json: JSON.stringify([{ id: "minimaxai/minimax-m3.1-flash" }]) }))!;
    expect(c.models.map((m) => m.id)).toEqual(["minimaxai/minimax-m3.1-flash"]);
  });
  test("edited origin gets no defaults", () => {
    expect(parseConfig(row({ base_url: "https://evil.example/v1" }))!.models).toEqual([]);
  });
});
