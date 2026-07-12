export const CODEX_PROVIDER = "codex";
export const ANTHROPIC_PROVIDER = "anthropic";
// OpenAI Chat Completions compatible provider. Covers OpenAI itself plus any
// OpenAI-compatible backend (LiteLLM proxy, Ollama, vLLM, OpenRouter, etc.).
// Following pi's design, providers are keyed by wire-format, not by vendor:
// switching backends is just changing `base_url`, never the provider code.
export const OPENAI_PROVIDER = "openai";
export const CODEX_API_MODE = "codex_responses";
export const ANTHROPIC_MESSAGES_API_MODE = "anthropic_messages";
export const OPENAI_COMPLETIONS_API_MODE = "openai_completions";
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENAI_MODEL = "gpt-5.4";
export const CODEX_PI_API = "openai-codex-responses";
export const ANTHROPIC_PI_API = "anthropic-messages";
export const OPENAI_PI_API = "openai-completions";

/** Logical Tradex provider IDs mapped to Pi's registry provider IDs. */
export const PI_PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  [CODEX_PROVIDER]: "openai-codex",
});

export function toPiProviderId(provider: string): string {
  return PI_PROVIDER_ALIASES[provider] ?? provider;
}

export function fromPiProviderId(provider: string): string {
  for (const [logicalId, piId] of Object.entries(PI_PROVIDER_ALIASES)) {
    if (piId === provider) return logicalId;
  }
  return provider;
}

const SUPPORTED_API_MODES = new Set([CODEX_API_MODE, ANTHROPIC_MESSAGES_API_MODE, OPENAI_COMPLETIONS_API_MODE]);
const SUPPORTED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CODEX_MODEL_ALIASES = new Map([
  ["default", DEFAULT_CODEX_MODEL],
  ["codex", DEFAULT_CODEX_MODEL],
  ["fast", DEFAULT_CODEX_MODEL],
]);

export function normalizeProvider(rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) return CODEX_PROVIDER;
  if (typeof rawValue !== "string") throw new Error("agent.provider must be a string");
  const provider = rawValue.trim().toLowerCase();
  if (!provider) return CODEX_PROVIDER;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) {
    throw new Error("agent.provider must use 1-64 lowercase letters, numbers, dots, underscores, or hyphens");
  }
  return fromPiProviderId(provider);
}

export function defaultProviderApi(provider: string): string {
  if (provider === CODEX_PROVIDER) return CODEX_PI_API;
  if (provider === ANTHROPIC_PROVIDER) return ANTHROPIC_PI_API;
  return OPENAI_PI_API;
}

export function normalizeApiMode(provider: string, rawValue?: unknown): string {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    if (provider === CODEX_PROVIDER) return CODEX_API_MODE;
    if (provider === ANTHROPIC_PROVIDER) return ANTHROPIC_MESSAGES_API_MODE;
    if (provider === OPENAI_PROVIDER) return OPENAI_COMPLETIONS_API_MODE;
    return OPENAI_COMPLETIONS_API_MODE;
  }
  if (typeof rawValue !== "string") throw new Error("agent.api_mode must be a string");
  const apiMode = rawValue.trim().toLowerCase();
  if (!apiMode) return normalizeApiMode(provider);
  if (provider === CODEX_PROVIDER && apiMode !== CODEX_API_MODE) {
    throw new Error(`agent.api_mode for codex must be ${CODEX_API_MODE}`);
  }
  if (provider === ANTHROPIC_PROVIDER && apiMode !== ANTHROPIC_MESSAGES_API_MODE) {
    throw new Error(`agent.api_mode for anthropic must be ${ANTHROPIC_MESSAGES_API_MODE}`);
  }
  if (provider === OPENAI_PROVIDER && apiMode !== OPENAI_COMPLETIONS_API_MODE) {
    throw new Error(`agent.api_mode for openai must be ${OPENAI_COMPLETIONS_API_MODE}`);
  }
  if (
    provider !== CODEX_PROVIDER
    && provider !== ANTHROPIC_PROVIDER
    && provider !== OPENAI_PROVIDER
    && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(apiMode)
  ) {
    throw new Error("agent.api_mode must be a safe wire-format identifier");
  }
  if (
    (provider === CODEX_PROVIDER || provider === ANTHROPIC_PROVIDER || provider === OPENAI_PROVIDER)
    && !SUPPORTED_API_MODES.has(apiMode)
  ) {
    throw new Error(`agent.api_mode must be one of: ${[...SUPPORTED_API_MODES].sort().join(", ")}`);
  }
  return apiMode;
}

export function normalizeModel(provider: string, rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) {
    if (provider === CODEX_PROVIDER) return DEFAULT_CODEX_MODEL;
    if (provider === ANTHROPIC_PROVIDER) return DEFAULT_ANTHROPIC_MODEL;
    if (provider === OPENAI_PROVIDER) return DEFAULT_OPENAI_MODEL;
    return "";
  }
  if (typeof rawValue !== "string") throw new Error("agent.model must be a string");
  const model = rawValue.trim();
  if (!model) return normalizeModel(provider, null);
  if (provider === CODEX_PROVIDER) return CODEX_MODEL_ALIASES.get(model.toLowerCase()) ?? model;
  return model;
}

export function normalizeReasoningEffort(rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) return "medium";
  if (typeof rawValue !== "string") throw new Error("agent.reasoning_effort must be a string");
  const effort = rawValue.trim().toLowerCase();
  if (!effort) return "medium";
  const normalized = new Map([
    ["minimal", "low"],
    ["extra", "xhigh"],
    ["extra_high", "xhigh"],
  ]).get(effort) ?? effort;
  if (!SUPPORTED_REASONING_EFFORTS.has(normalized)) {
    throw new Error(`agent.reasoning_effort must be one of: ${[...SUPPORTED_REASONING_EFFORTS].sort().join(", ")}`);
  }
  return normalized;
}

/** Decode JWT payload claims without verifying the signature. */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const payload = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
