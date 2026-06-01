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
export const DEFAULT_ANTHROPIC_MODEL = "global.anthropic.claude-opus-4-6-v1";
export const DEFAULT_OPENAI_MODEL = "gpt-4o";

const SUPPORTED_AGENT_PROVIDERS = new Set([CODEX_PROVIDER, ANTHROPIC_PROVIDER, OPENAI_PROVIDER]);
const SUPPORTED_API_MODES = new Set([CODEX_API_MODE, ANTHROPIC_MESSAGES_API_MODE, OPENAI_COMPLETIONS_API_MODE]);
const SUPPORTED_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CODEX_MODEL_ALIASES = new Map([
  ["default", DEFAULT_CODEX_MODEL],
  ["codex", DEFAULT_CODEX_MODEL],
  ["fast", DEFAULT_CODEX_MODEL],
]);

export interface AgentModelProfile {
  provider: string;
  apiMode: string;
  model: string;
  reasoningEffort: string;
  supportsReasoning: boolean;
  requiresAccountId: boolean;
}

export function normalizeProvider(rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) return CODEX_PROVIDER;
  if (typeof rawValue !== "string") throw new Error("agent.provider must be a string");
  const provider = rawValue.trim().toLowerCase();
  if (!provider) return CODEX_PROVIDER;
  if (!SUPPORTED_AGENT_PROVIDERS.has(provider)) {
    throw new Error(`agent.provider must be one of: ${[...SUPPORTED_AGENT_PROVIDERS].sort().join(", ")}`);
  }
  return provider;
}

export function normalizeApiMode(provider: string, rawValue?: unknown): string {
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    if (provider === CODEX_PROVIDER) return CODEX_API_MODE;
    if (provider === ANTHROPIC_PROVIDER) return ANTHROPIC_MESSAGES_API_MODE;
    if (provider === OPENAI_PROVIDER) return OPENAI_COMPLETIONS_API_MODE;
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
  if (!SUPPORTED_API_MODES.has(apiMode)) {
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

export function resolveAgentModel(config: {
  provider?: unknown;
  apiMode?: unknown;
  api_mode?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  reasoning_effort?: unknown;
}): AgentModelProfile {
  const provider = normalizeProvider(config.provider);
  const apiMode = normalizeApiMode(provider, config.apiMode ?? config.api_mode);
  const model = normalizeModel(provider, config.model);
  const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort ?? config.reasoning_effort);
  if (provider === CODEX_PROVIDER) {
    return { provider, apiMode, model, reasoningEffort, supportsReasoning: true, requiresAccountId: true };
  }
  if (provider === ANTHROPIC_PROVIDER) {
    return { provider, apiMode, model, reasoningEffort, supportsReasoning: true, requiresAccountId: false };
  }
  if (provider === OPENAI_PROVIDER) {
    // reasoning is intentionally disabled for the first cut: OpenAI/o-series and
    // OpenAI-compatible proxies expose reasoning params in incompatible shapes.
    // Basic chat + tool-calling works without it; revisit per-backend later.
    return { provider, apiMode, model, reasoningEffort, supportsReasoning: false, requiresAccountId: false };
  }
  throw new Error(`Unsupported agent provider: ${provider}`);
}
