import crypto from "node:crypto";
import { fetch as browserFetch } from "wreq-js";
import type { AgentModel } from "../models.js";
import type { ChatInput, ApiStreamFunction, ApiListModelsFunction } from "../api_registry.js";
import type { ChatResponse } from "../loop.js";
import type { ToolCall } from "../tools/registry.js";

// ---- Stateless stream function (the new primary API) ----

export const streamCodex: ApiStreamFunction = async (model: AgentModel, input: ChatInput): Promise<ChatResponse> => {
  if (!model.apiKey) throw new Error("CODEX_API_KEY or Codex CLI auth is required");
  const instructions = input.messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content || ""))
    .join("\n\n");
  const payload = {
    model: model.id,
    input: messagesToCodexInput(input.messages),
    instructions,
    store: false,
    stream: true,
    reasoning: {
      effort: model.reasoningEffort,
      summary: "auto",
    },
    tools: codexToolsPayload(input.tools),
  };
  const response = await codexFetch(`${model.baseUrl}/responses`, {
    method: "POST",
    headers: codexHeaders(model.apiKey, model.accountId ?? null),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Codex API ${response.status}: ${await response.text()}`);
  return collectCodexResponse(response, input.onDelta);
};

export const listCodexModels: ApiListModelsFunction = async (model: AgentModel): Promise<Array<Record<string, unknown>>> => {
  if (!model.apiKey) throw new Error("CODEX_API_KEY or Codex CLI auth is required");
  const url = new URL(`${model.baseUrl}/models`);
  url.searchParams.set("client_version", "1.0.0");
  const response = await codexFetch(url.toString(), {
    headers: codexHeaders(model.apiKey, model.accountId ?? null),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Codex models API ${response.status}: ${text}`);
  const data = JSON.parse(text) as Record<string, unknown>;
  const rawModels = Array.isArray(data.models) ? data.models : Array.isArray(data.data) ? data.data : [];
  return rawModels
    .map((item) => normalizeCodexModelOption(item))
    .filter((item): item is Record<string, unknown> => item !== null);
};

// ---- Internal helpers ----

async function codexFetch(url: string, init: Record<string, unknown>): Promise<Response> {
  return browserFetch(url, {
    profile: "chrome_133",
    operatingSystem: "macos",
    ...init,
  } as never) as unknown as Response;
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
    defaultReasoningEffort: String(obj.default_reasoning_level || obj.default_reasoning_effort || obj.defaultReasoningEffort || "medium"),
    supportedReasoningEfforts: Array.isArray(obj.supported_reasoning_levels)
      ? obj.supported_reasoning_levels
        .map((level) => level && typeof level === "object" && !Array.isArray(level) ? String((level as Record<string, unknown>).effort || "") : "")
        .filter(Boolean)
      : Array.isArray(obj.supported_reasoning_efforts)
        ? obj.supported_reasoning_efforts
      : Array.isArray(obj.supportedReasoningEfforts)
        ? obj.supportedReasoningEfforts
        : ["low", "medium", "high", "xhigh"],
    contextWindow: typeof obj.context_window === "number" ? obj.context_window : typeof obj.contextWindow === "number" ? obj.contextWindow : null,
    preferWebsockets: Boolean(obj.prefer_websockets || obj.preferWebsockets),
  };
}

function codexHeaders(accessToken: string, accountId: string | null): Record<string, string> {
  const resolvedAccountId = accountId || accountIdFromToken(accessToken);
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": "codex_cli_rs/0.0.0 (tradex)",
    "originator": "codex_cli_rs",
    ...(resolvedAccountId ? { "ChatGPT-Account-ID": resolvedAccountId } : {}),
  };
}

function accountIdFromToken(accessToken: string): string | null {
  const claims = jwtClaims(accessToken);
  const nestedAuth = claims["https://api.openai.com/auth"];
  const accountId = claims.chatgpt_account_id || (nestedAuth && typeof nestedAuth === "object" && !Array.isArray(nestedAuth)
    ? (nestedAuth as Record<string, unknown>).chatgpt_account_id
    : null);
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : null;
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

function messagesToCodexInput(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const role = String(message.role || "");
    if (role === "system") continue;
    if (role === "user") {
      out.push({ role: "user", content: [{ type: "input_text", text: String(message.content || "") }] });
    } else if (role === "assistant") {
      const toolCalls = message.tool_calls;
      const renderedToolCalls = renderToolCallsForReplay(toolCalls);
      const text = [String(message.content || ""), renderedToolCalls].filter(Boolean).join("\n\n");
      out.push({ role: "assistant", content: [{ type: "output_text", text }] });
    } else if (role === "tool") {
      out.push({
        role: "user",
        content: [{
          type: "input_text",
          text: `Tool result for ${String(message.tool_call_id || "")}:\n${String(message.content || "")}`,
        }],
      });
    }
  }
  return out;
}

function renderToolCallsForReplay(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls)) return "";
  const lines: string[] = [];
  for (const rawCall of toolCalls) {
    if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) continue;
    const fn = (rawCall as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;
    const name = String((fn as Record<string, unknown>).name || "");
    const args = String((fn as Record<string, unknown>).arguments || "{}");
    if (name) lines.push(`Tool call requested: ${name}`, `Arguments: ${args}`);
  }
  return lines.join("\n");
}

function codexToolsPayload(tools: Array<Record<string, unknown>> | null | undefined): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let hasLocalWebSearch = false;
  for (const tool of tools ?? []) {
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
      ? tool.function as Record<string, unknown>
      : null;
    if (!fn) continue;
    const name = String(fn.name || "");
    if (!name) continue;
    if (name === "web_search") {
      hasLocalWebSearch = true;
      continue;
    }
    out.push({
      type: "function",
      name,
      description: fn.description || "",
      parameters: fn.parameters || {},
    });
  }
  if (hasLocalWebSearch) out.push({ type: "web_search", external_web_access: true });
  return out;
}

async function collectCodexResponse(response: Response, onDelta?: ((delta: string) => void | Promise<void>) | null): Promise<ChatResponse> {
  const textChunks: string[] = [];
  let doneText: string | null = null;
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  const usage: Record<string, number> = {};
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeLine = async (rawLine: string) => {
    if (!rawLine.startsWith("data: ")) return;
    const rawData = rawLine.slice("data: ".length).trim();
    if (!rawData || rawData === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawData) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      event = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(event.type || "");
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
      textChunks.push(event.delta);
      await onDelta?.(event.delta);
    } else if (type === "response.output_text.done" && typeof event.text === "string") {
      doneText = event.text;
    } else if (type === "response.function_call_arguments.delta") {
      const key = functionCallEventKey(event);
      if (!key) return;
      const current = toolCalls.get(key) ?? { id: String(event.call_id || key), name: String(event.name || ""), arguments: "" };
      current.arguments += String(event.delta || "");
      if (typeof event.call_id === "string") current.id = event.call_id;
      if (typeof event.name === "string") current.name = event.name;
      toolCalls.set(key, current);
    } else if (type === "response.function_call_arguments.done") {
      const key = functionCallEventKey(event);
      if (!key) return;
      const current = toolCalls.get(key) ?? { id: String(event.call_id || key), name: String(event.name || ""), arguments: "" };
      if (typeof event.arguments === "string") current.arguments = event.arguments;
      if (typeof event.call_id === "string") current.id = event.call_id;
      if (typeof event.name === "string") current.name = event.name;
      toolCalls.set(key, current);
    } else if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
        ? event.item as Record<string, unknown>
        : null;
      if (item?.type !== "function_call") return;
      const key = functionCallItemKey(item, event);
      if (!key) return;
      const current = toolCalls.get(key) ?? { id: String(item.call_id || item.id || key), name: String(item.name || ""), arguments: String(item.arguments || "") };
      if (typeof item.call_id === "string") current.id = item.call_id;
      if (typeof item.name === "string") current.name = item.name;
      if (typeof item.arguments === "string") current.arguments = item.arguments;
      toolCalls.set(key, current);
    } else if (type === "response.completed") {
      const resp = event.response && typeof event.response === "object" && !Array.isArray(event.response)
        ? event.response as Record<string, unknown>
        : null;
      const rawUsage = resp?.usage && typeof resp.usage === "object" && !Array.isArray(resp.usage)
        ? resp.usage as Record<string, unknown>
        : null;
      const inputTokens = Number(rawUsage?.input_tokens ?? rawUsage?.prompt_tokens ?? 0);
      const outputTokens = Number(rawUsage?.output_tokens ?? rawUsage?.completion_tokens ?? 0);
      if (Number.isFinite(inputTokens)) usage.prompt_tokens = inputTokens;
      if (Number.isFinite(outputTokens)) usage.completion_tokens = outputTokens;
      usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      throw new Error(codexEventErrorMessage(event));
    }
  };
  if (!response.body) {
    throw new Error("Codex stream response body is empty");
  }
  const reader = response.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) await consumeLine(line);
  }
  buffer += decoder.decode();
  for (const line of buffer.split(/\r?\n/)) {
    if (line) await consumeLine(line);
  }
  const content = textChunks.join("").trim() || (doneText || "").trim();
  if (onDelta && doneText && textChunks.length === 0) await onDelta(doneText);
  const calls: ToolCall[] = [...toolCalls.values()]
    .filter((call) => call.name.trim())
    .map((call) => ({ id: call.id, name: call.name, arguments: parseArgs(call.arguments) }));
  return {
    content: content || null,
    toolCalls: calls,
    finishReason: calls.length > 0 ? "tool_calls" : "stop",
    usage,
  };
}

function functionCallEventKey(event: Record<string, unknown>): string {
  for (const key of ["item_id", "call_id", "id"]) {
    const value = event[key];
    if (typeof value === "string" && value) return value;
  }
  return typeof event.output_index === "number" ? `output:${event.output_index}` : "";
}

function functionCallItemKey(item: Record<string, unknown>, event: Record<string, unknown>): string {
  if (typeof item.id === "string" && item.id) return item.id;
  if (typeof item.call_id === "string" && item.call_id) return item.call_id;
  return typeof event.output_index === "number" ? `output:${event.output_index}` : "";
}

function codexEventErrorMessage(event: Record<string, unknown>): string {
  const rawError = event.error;
  if (rawError && typeof rawError === "object" && !Array.isArray(rawError)) {
    const obj = rawError as Record<string, unknown>;
    return String(obj.message || obj.type || JSON.stringify(obj));
  }
  return String(rawError || event.type || "Codex stream failed");
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