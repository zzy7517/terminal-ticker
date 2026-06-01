/**
 * models.ts — AgentModel value object.
 *
 * An AgentModel is a pure data structure that carries everything needed to
 * route and authenticate a single LLM request. No I/O, no state.
 * Switching models mid-conversation is just replacing this object.
 */

import { AgentConfig, ProviderProfile } from "../config/index.js";
import {
  CODEX_PROVIDER,
  ANTHROPIC_PROVIDER,
  OPENAI_PROVIDER,
  CODEX_API_MODE,
  ANTHROPIC_MESSAGES_API_MODE,
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_ANTHROPIC_MODEL,
  normalizeProvider,
  normalizeModel,
  normalizeReasoningEffort,
  normalizeApiMode,
} from "../config/agent_models.js";

/**
 * A pure-data model descriptor. Acts as the routing key for the API registry.
 */
export interface AgentModel {
  /** Model identifier, e.g. "gpt-5.4-mini" or "claude-opus-4-6-v1" */
  id: string;
  /** Provider name, e.g. "codex" or "anthropic" */
  provider: string;
  /** API wire format, determines which stream function handles the request */
  api: string;
  /** Base URL for the provider endpoint */
  baseUrl: string;
  /** Reasoning effort level */
  reasoningEffort: string;
  /** API key (resolved at construction time) */
  apiKey: string;
  /** Optional account ID (Codex-specific) */
  accountId?: string | null;
}

/**
 * Resolve an AgentModel from the runtime AgentConfig.
 * This is the primary way to get a model from config on each request.
 */
export function resolveAgentModelFromConfig(config: AgentConfig): AgentModel {
  const provider = normalizeProvider(config.provider);
  const api = normalizeApiMode(provider, config.apiMode);
  const modelId = normalizeModel(provider, config.model);
  const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort);

  const profile: ProviderProfile | undefined = config.providerProfiles[provider];

  if (provider === CODEX_PROVIDER) {
    const { accessToken, accountId } = resolveCodexCredentials(profile);
    return {
      id: modelId,
      provider,
      api,
      baseUrl: profile?.baseUrl || DEFAULT_CODEX_BASE_URL,
      reasoningEffort,
      apiKey: accessToken,
      accountId,
    };
  }

  if (provider === ANTHROPIC_PROVIDER) {
    const apiKey = profile?.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
    return {
      id: modelId,
      provider,
      api,
      baseUrl: profile?.baseUrl || process.env.ANTHROPIC_BASE_URL || "",
      reasoningEffort,
      apiKey,
    };
  }

  if (provider === OPENAI_PROVIDER) {
    // For LiteLLM, point `base_url` at the proxy (e.g. http://localhost:4000/v1)
    // and put the LiteLLM master key in `api_key` (or OPENAI_API_KEY env).
    const apiKey = profile?.apiKey
      || process.env.OPENAI_API_KEY
      || process.env.LITELLM_API_KEY
      || "";
    const baseUrl = profile?.baseUrl
      || process.env.OPENAI_BASE_URL
      || DEFAULT_OPENAI_BASE_URL;
    return {
      id: modelId,
      provider,
      api,
      baseUrl,
      reasoningEffort,
      apiKey,
    };
  }

  throw new Error(`Unsupported agent provider: ${provider}`);
}

/**
 * Build an AgentModel from explicit provider/model strings + the config's profiles.
 * Used by the SSE endpoint when the request body overrides provider/model.
 */
export function buildAgentModel(provider: string, modelId: string, config: AgentConfig): AgentModel {
  const overriddenConfig: AgentConfig = {
    ...config,
    provider,
    model: modelId,
    apiMode: normalizeApiMode(provider),
  };
  return resolveAgentModelFromConfig(overriddenConfig);
}

// ---- Codex credential resolution (moved from providers/codex.ts) ----

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function resolveCodexCredentials(profile?: ProviderProfile | null): { accessToken: string; accountId: string | null } {
  if (profile?.apiKey) return { accessToken: profile.apiKey, accountId: null };
  if (process.env.CODEX_API_KEY) return { accessToken: process.env.CODEX_API_KEY, accountId: process.env.CODEX_ACCOUNT_ID || null };
  const authPath = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : path.join(os.homedir(), ".codex", "auth.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { accessToken: "", accountId: null };
  }
  const tokens = parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
    ? parsed.tokens as Record<string, unknown>
    : {};
  const accessToken = String(tokens.access_token || parsed.access_token || parsed.accessToken || "").trim();
  if (!accessToken) return { accessToken: "", accountId: null };
  if (accessTokenIsExpired(accessToken)) {
    throw new Error("Codex CLI access token is expired. Run `codex` once to refresh the login.");
  }
  const accountId = tokens.account_id || parsed.account_id || parsed.accountId || jwtClaims(accessToken).chatgpt_account_id;
  return { accessToken, accountId: typeof accountId === "string" && accountId.trim() ? accountId.trim() : null };
}

function accessTokenIsExpired(accessToken: string): boolean {
  const exp = jwtClaims(accessToken).exp;
  return typeof exp === "number" && exp <= Date.now() / 1000;
}

function jwtClaims(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const payload = parts[1] + "=".repeat((4 - (parts[1].length % 4)) % 4);
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
