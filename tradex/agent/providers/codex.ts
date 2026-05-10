import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { AgentConfig, ProviderProfile } from "../../config/index.js";
import { DEFAULT_CODEX_BASE_URL, AgentModelProfile } from "../../config/agent_models.js";
import { ChatResponse } from "../loop.js";
import { ToolCall } from "../tools/registry.js";

export class CodexProvider {
  readonly name = "codex";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly accountId: string | null;

  constructor(config: AgentConfig, profile: AgentModelProfile) {
    this.model = profile.model;
    const providerProfile = config.providerProfiles.codex as ProviderProfile | undefined;
    const credentials = resolveCodexCredentials();
    this.accessToken = providerProfile?.apiKey || process.env.CODEX_API_KEY || credentials.accessToken;
    this.accountId = credentials.accountId;
    this.baseUrl = providerProfile?.baseUrl || DEFAULT_CODEX_BASE_URL;
    if (!this.accessToken) throw new Error("CODEX_API_KEY or Codex CLI auth is required");
  }

  async chat(input: { messages: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> | null; onDelta?: ((delta: string) => void | Promise<void>) | null }): Promise<ChatResponse> {
    const payload = {
      model: this.model,
      input: messagesToCodexInput(input.messages),
      tools: input.tools ?? [],
      stream: false,
    };
    const response = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: codexHeaders(this.accessToken, this.accountId),
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Codex API ${response.status}: ${text}`);
    const data = JSON.parse(text) as Record<string, unknown>;
    const content = extractText(data);
    if (content) await input.onDelta?.(content);
    return { content, toolCalls: extractToolCalls(data), finishReason: String(data.status || "stop"), usage: extractUsage(data) };
  }

  async listModels(): Promise<Array<Record<string, unknown>>> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: codexHeaders(this.accessToken, this.accountId),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Codex models API ${response.status}: ${text}`);
    const data = JSON.parse(text) as Record<string, unknown>;
    const rawModels = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return rawModels
      .map((item) => normalizeCodexModelOption(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }
}

function normalizeCodexModelOption(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const obj = item as Record<string, unknown>;
  const slug = String(obj.id || obj.slug || obj.model || "");
  if (!slug) return null;
  return {
    slug,
    displayName: String(obj.display_name || obj.displayName || obj.name || slug),
    description: String(obj.description || ""),
    visibility: String(obj.visibility || "public"),
    supportedInApi: obj.supported_in_api !== false && obj.supportedInApi !== false,
    defaultReasoningEffort: String(obj.default_reasoning_effort || obj.defaultReasoningEffort || "medium"),
    supportedReasoningEfforts: Array.isArray(obj.supported_reasoning_efforts)
      ? obj.supported_reasoning_efforts
      : Array.isArray(obj.supportedReasoningEfforts)
        ? obj.supportedReasoningEfforts
        : ["low", "medium", "high", "xhigh"],
    contextWindow: typeof obj.context_window === "number" ? obj.context_window : typeof obj.contextWindow === "number" ? obj.contextWindow : null,
    preferWebsockets: Boolean(obj.prefer_websockets || obj.preferWebsockets),
  };
}

function resolveCodexCredentials(): { accessToken: string; accountId: string | null } {
  if (process.env.CODEX_API_KEY) return { accessToken: process.env.CODEX_API_KEY, accountId: process.env.CODEX_ACCOUNT_ID || null };
  const authPath = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "auth.json") : path.join(os.homedir(), ".codex", "auth.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const accessToken = String(parsed.access_token || parsed.accessToken || "");
    const accountId = parsed.account_id || parsed.accountId;
    return { accessToken, accountId: typeof accountId === "string" ? accountId : null };
  } catch {
    return { accessToken: "", accountId: null };
  }
}

function codexHeaders(accessToken: string, accountId: string | null): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    ...(accountId ? { "OpenAI-Account": accountId } : {}),
  };
}

function messagesToCodexInput(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return messages.map((message) => ({ role: message.role, content: String(message.content || "") }));
}

function extractText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  const output = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const content = (item as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && !Array.isArray(block)) {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
  }
  return parts.join("");
}

function extractToolCalls(data: Record<string, unknown>): ToolCall[] {
  const output = Array.isArray(data.output) ? data.output : [];
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === "function_call" || obj.type === "tool_call") {
      calls.push({
        id: String(obj.call_id || obj.id || crypto.randomUUID()),
        name: String(obj.name || ""),
        arguments: parseArgs(obj.arguments),
      });
    }
  }
  return calls.filter((call) => call.name);
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function extractUsage(data: Record<string, unknown>): Record<string, number> {
  const usage = data.usage && typeof data.usage === "object" && !Array.isArray(data.usage) ? (data.usage as Record<string, unknown>) : {};
  const prompt = Number(usage.input_tokens || usage.prompt_tokens || 0);
  const completion = Number(usage.output_tokens || usage.completion_tokens || 0);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}
