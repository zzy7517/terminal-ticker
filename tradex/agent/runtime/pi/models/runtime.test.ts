import { describe, expect, it } from "vitest";
import type { AgentConfig, ProviderProfile } from "../../../../config/index.js";
import {
  agentConfigForModelSelection,
  buildModelRuntimeSnapshot,
  parseModelSelection,
} from "./runtime.js";

function profile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    enabled: true,
    api: "openai-completions",
    displayName: "Acme",
    requiresAuth: true,
    models: ["acme-reasoner"],
    modelEfforts: [["acme-reasoner", "high"]],
    apiKey: "test-key",
    apiKeyRaw: "${ACME_API_KEY}",
    baseUrl: "https://example.invalid/v1",
    customModels: [],
    customModelDefinitions: [{
      id: "acme-reasoner",
      name: "Acme Reasoner",
      api: "openai-completions",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 8_192,
    }],
    ...overrides,
  };
}

function config(): AgentConfig {
  return {
    enabled: true,
    provider: "acme",
    apiMode: "openai-completions",
    model: "acme-reasoner",
    systemPrompt: "",
    maxCandles: 40,
    candleContextMode: "raw",
    reasoningEffort: "high",
    providerProfiles: { acme: profile() },
  };
}

describe("ModelRuntimeSnapshot", () => {
  it("registers explicit custom model metadata without template inference", () => {
    const dto = buildModelRuntimeSnapshot(config(), 7).toDTO();
    const model = dto.models.find((item) => item.providerId === "acme" && item.id === "acme-reasoner");

    expect(dto.generation).toBe(7);
    expect(model).toMatchObject({
      name: "Acme Reasoner",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 128_000,
      maxTokens: 8_192,
      selected: true,
      source: "custom",
      runnable: true,
    });
  });

  it("uses one qualified-selection parser for canonical aliases and model ids containing colons", () => {
    expect(parseModelSelection("openai-codex:model:version", { provider: "openai", id: "fallback" }))
      .toEqual({ provider: "codex", id: "model:version" });

    const selected = agentConfigForModelSelection(config(), "acme:acme-reasoner");
    expect(selected).toMatchObject({
      provider: "acme",
      model: "acme-reasoner",
      apiMode: "openai-completions",
      reasoningEffort: "high",
    });
  });

  it("supports explicitly unauthenticated local providers", async () => {
    const localConfig = config();
    localConfig.providerProfiles.acme = profile({
      requiresAuth: false,
      apiKey: "",
      apiKeyRaw: "",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    const snapshot = buildModelRuntimeSnapshot(localConfig, 1);
    const dto = snapshot.toDTO();

    expect(dto.providers.find((item) => item.providerId === "acme")).toMatchObject({
      requiresAuth: false,
      authConfigured: true,
      runnable: true,
    });
    expect(dto.models.find((item) => item.providerId === "acme" && item.id === "acme-reasoner")?.runnable)
      .toBe(true);
    const model = snapshot.modelRegistry.find("acme", "acme-reasoner");
    expect(model).toBeDefined();
    expect(await snapshot.modelRegistry.getApiKeyAndHeaders(model!)).toMatchObject({
      ok: true,
      apiKey: "no-auth",
    });
  });

  it("exposes only providers declared in backend providerProfiles", () => {
    const dto = buildModelRuntimeSnapshot(config(), 1).toDTO();

    expect(dto.providers.map((item) => item.providerId)).toEqual(["acme"]);
    expect(dto.models.every((item) => item.providerId === "acme")).toBe(true);
    expect(dto.providers.some((item) => item.providerId === "openrouter")).toBe(false);
  });
});
