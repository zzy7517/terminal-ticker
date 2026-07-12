/**
 * Remote model catalog fetch. Uses provider credentials only — no default
 * model resolution, no Pi registry lookup.
 */

import { fetch as browserFetch } from "wreq-js";
import type { AgentConfig } from "../../config/index.js";
import {
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_OPENAI_BASE_URL,
  OPENAI_PROVIDER,
  normalizeProvider,
  jwtClaims,
} from "./constants.js";
import { resolveProviderAccess } from "./resolve.js";

const ANTHROPIC_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

export async function fetchProviderModelCatalog(
  config: AgentConfig,
  providerOverride?: string | null,
): Promise<Array<Record<string, unknown>>> {
  const provider = normalizeProvider(providerOverride ?? config.provider);
  const access = resolveProviderAccess(config, provider);

  if (provider === ANTHROPIC_PROVIDER) return listAnthropicModels(access.apiKey, access.baseUrl);
  if (provider === OPENAI_PROVIDER) return listOpenAIModels(access.apiKey, access.baseUrl);
  if (provider === CODEX_PROVIDER) return listCodexModels(access.apiKey, access.baseUrl, access.accountId ?? null);
  throw new Error(`Unsupported agent provider: ${provider}`);
}

async function listAnthropicModels(apiKey: string, baseUrl: string): Promise<Array<Record<string, unknown>>> {
  if (!apiKey) throw new Error("Anthropic API key is required to fetch models");
  const url = joinUrl(baseUrl || "https://api.anthropic.com", "/v1/models?limit=100");
  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Anthropic models API ${response.status}: ${text}`);
  const data = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
  return (data.data ?? []).map((m) => ({
    slug: String(m.id || ""),
    displayName: String(m.display_name || m.id || ""),
    description: "",
    visibility: "public",
    supportedInApi: true,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [...ANTHROPIC_EFFORT_LEVELS],
    contextWindow: null,
    preferWebsockets: false,
    custom: false,
  })).filter((m) => m.slug);
}

async function listOpenAIModels(apiKey: string, baseUrl: string): Promise<Array<Record<string, unknown>>> {
  if (!apiKey) throw new Error("OpenAI API key is required to fetch models");
  const url = joinUrl(baseUrl || DEFAULT_OPENAI_BASE_URL, "/models");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      accept: "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI models API ${response.status}: ${text}`);
  const data = JSON.parse(text) as { data?: Array<Record<string, unknown>> };
  return (data.data ?? []).map((m) => ({
    slug: String(m.id || ""),
    displayName: String(m.id || ""),
    description: "",
    visibility: "public",
    supportedInApi: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [],
    contextWindow: null,
    preferWebsockets: false,
    custom: false,
  })).filter((m) => m.slug);
}

async function listCodexModels(
  apiKey: string,
  baseUrl: string,
  accountId: string | null,
): Promise<Array<Record<string, unknown>>> {
  if (!apiKey) throw new Error("CODEX_API_KEY or Codex CLI auth is required");
  const url = new URL(`${(baseUrl || DEFAULT_CODEX_BASE_URL).replace(/\/$/, "")}/models`);
  url.searchParams.set("client_version", "1.0.0");
  const response = await browserFetch(url.toString(), {
    profile: "chrome_133",
    operatingSystem: "macos",
    headers: codexHeaders(apiKey, accountId),
  } as never) as unknown as Response;
  const text = await response.text();
  if (!response.ok) throw new Error(`Codex models API ${response.status}: ${text}`);
  const data = JSON.parse(text) as Record<string, unknown>;
  const rawModels = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
  return rawModels
    .map((item) => normalizeCodexModelOption(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.replace(/\/$/, "");
  if (path.startsWith("/v1/") && trimmed.endsWith("/v1")) {
    return `${trimmed}${path.slice(3)}`;
  }
  if (path === "/models" && trimmed.endsWith("/models")) return trimmed;
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

function codexHeaders(accessToken: string, accountId: string | null): Record<string, string> {
  const resolvedAccountId = accountId || accountIdFromToken(accessToken);
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "codex_cli_rs/0.0.0 (tradex)",
    originator: "codex_cli_rs",
    ...(resolvedAccountId ? { "ChatGPT-Account-ID": resolvedAccountId } : {}),
  };
}

function accountIdFromToken(accessToken: string): string | null {
  const claims = jwtClaims(accessToken);
  const nestedAuth = claims["https://api.openai.com/auth"];
  const accountId = claims.chatgpt_account_id
    || (nestedAuth && typeof nestedAuth === "object" && !Array.isArray(nestedAuth)
      ? (nestedAuth as Record<string, unknown>).chatgpt_account_id
      : null);
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
}

function normalizeCodexModelOption(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  const slug = String(obj.slug || obj.id || obj.model || "");
  if (!slug) return null;
  return {
    slug,
    displayName: String(obj.display_name || obj.displayName || obj.name || slug),
    description: String(obj.description || ""),
    visibility: String(obj.visibility || "public"),
    supportedInApi: obj.supported_in_api !== false && obj.supportedInApi !== false,
    defaultReasoningEffort: String(
      obj.default_reasoning_level || obj.default_reasoning_effort || obj.defaultReasoningEffort || "medium",
    ),
    supportedReasoningEfforts: Array.isArray(obj.supported_reasoning_levels)
      ? obj.supported_reasoning_levels
        .map((level) => (
          level && typeof level === "object" && !Array.isArray(level)
            ? String((level as Record<string, unknown>).effort || "")
            : ""
        ))
        .filter(Boolean)
      : Array.isArray(obj.supported_reasoning_efforts)
        ? obj.supported_reasoning_efforts
        : Array.isArray(obj.supportedReasoningEfforts)
          ? obj.supportedReasoningEfforts
          : ["low", "medium", "high", "xhigh"],
    contextWindow: typeof obj.context_window === "number"
      ? obj.context_window
      : typeof obj.contextWindow === "number"
        ? obj.contextWindow
        : null,
    preferWebsockets: Boolean(obj.prefer_websockets || obj.preferWebsockets),
  };
}
