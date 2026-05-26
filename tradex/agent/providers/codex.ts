/**
 * providers/codex.ts — OpenAI Codex Responses API provider.
 *
 * Returns an AssistantMessageEventStream with fine-grained streaming events.
 * Codex only supports text output and function calls (no thinking blocks).
 */

import { fetch as browserFetch } from "wreq-js";
import type {
  AgentContext,
  AgentMessage,
  AgentModelDescriptor,
  AssistantMessage,
  AssistantMessageEventStreamType,
  ImageContent,
  StreamFn,
  StreamOptions,
  TextContent,
  ToolCallContent,
} from "../core/types.js";
import { AssistantMessageEventStream } from "../core/event-stream.js";
import { computeUsage } from "../core/usage.js";
import type { ApiListModelsFunction } from "../api_registry.js";

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const streamCodex: StreamFn = (
  model: AgentModelDescriptor,
  context: AgentContext,
  options: StreamOptions,
): AssistantMessageEventStreamType => {
  const eventStream = new AssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      provider: model.provider,
      model: model.id,
      usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const apiKey = options.apiKey || "";
      if (!apiKey) throw new Error("CODEX_API_KEY or Codex CLI auth is required");

      const payload = {
        model: model.id,
        input: contextToCodexInput(context),
        instructions: context.systemPrompt ?? "",
        store: false,
        stream: true,
        reasoning: {
          effort: model.reasoningEffort,
          summary: "auto",
        },
        tools: codexToolsPayload(context),
      };

      const response = await codexFetch(`${model.baseUrl}/responses`, {
        method: "POST",
        headers: codexHeaders(apiKey, model.accountId ?? null),
        body: JSON.stringify(payload),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      // Emit start event
      eventStream.push({ type: "start", partial: output });

      // Track state for text accumulation
      let textBlockStarted = false;
      let textContentIndex = -1;
      const toolCalls = new Map<string, { id: string; name: string; arguments: string; contentIndex: number }>();
      const usage: Record<string, number> = {};

      const consumeLine = (rawLine: string) => {
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
          if (!textBlockStarted) {
            // Start a new text block
            textBlockStarted = true;
            output.content.push({ type: "text", text: "" });
            textContentIndex = output.content.length - 1;
            eventStream.push({ type: "text_start", contentIndex: textContentIndex, partial: output });
          }
          const textBlock = output.content[textContentIndex] as TextContent;
          textBlock.text += event.delta;
          eventStream.push({
            type: "text_delta",
            contentIndex: textContentIndex,
            delta: event.delta,
            partial: output,
          });
        } else if (type === "response.output_text.done") {
          if (textBlockStarted && textContentIndex >= 0) {
            const textBlock = output.content[textContentIndex] as TextContent;
            // Use the done text if no deltas arrived
            if (typeof event.text === "string" && !textBlock.text) {
              textBlock.text = event.text;
            }
            eventStream.push({
              type: "text_end",
              contentIndex: textContentIndex,
              content: textBlock.text,
              partial: output,
            });
          }
        } else if (type === "response.function_call_arguments.delta") {
          const key = functionCallEventKey(event);
          if (!key) return;
          let current = toolCalls.get(key);
          if (!current) {
            // Start a new tool call block
            const tc: ToolCallContent = {
              type: "toolCall",
              id: String(event.call_id || key),
              name: String(event.name || ""),
              arguments: {},
            };
            output.content.push(tc);
            const idx = output.content.length - 1;
            current = { id: tc.id, name: tc.name, arguments: "", contentIndex: idx };
            toolCalls.set(key, current);
            eventStream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          }
          current.arguments += String(event.delta || "");
          if (typeof event.call_id === "string") current.id = event.call_id;
          if (typeof event.name === "string") current.name = event.name;
          eventStream.push({
            type: "toolcall_delta",
            contentIndex: current.contentIndex,
            delta: String(event.delta || ""),
            partial: output,
          });
        } else if (type === "response.function_call_arguments.done") {
          const key = functionCallEventKey(event);
          if (!key) return;
          let current = toolCalls.get(key);
          if (!current) {
            const tc: ToolCallContent = {
              type: "toolCall",
              id: String(event.call_id || key),
              name: String(event.name || ""),
              arguments: {},
            };
            output.content.push(tc);
            const idx = output.content.length - 1;
            current = { id: tc.id, name: tc.name, arguments: String(event.arguments || ""), contentIndex: idx };
            toolCalls.set(key, current);
            eventStream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          } else {
            if (typeof event.arguments === "string") current.arguments = event.arguments;
          }
          if (typeof event.call_id === "string") current.id = event.call_id;
          if (typeof event.name === "string") current.name = event.name;
          // Finalize the tool call
          const tc = output.content[current.contentIndex] as ToolCallContent;
          tc.id = current.id;
          tc.name = current.name;
          tc.arguments = parseArgs(current.arguments);
          eventStream.push({
            type: "toolcall_end",
            contentIndex: current.contentIndex,
            toolCall: tc,
            partial: output,
          });
        } else if (type === "response.output_item.added" || type === "response.output_item.done") {
          const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
            ? event.item as Record<string, unknown>
            : null;
          if (item?.type !== "function_call") return;
          const key = functionCallItemKey(item, event);
          if (!key) return;
          let current = toolCalls.get(key);
          if (!current) {
            const tc: ToolCallContent = {
              type: "toolCall",
              id: String(item.call_id || item.id || key),
              name: String(item.name || ""),
              arguments: parseArgs(item.arguments),
            };
            output.content.push(tc);
            const idx = output.content.length - 1;
            current = { id: tc.id, name: tc.name, arguments: String(item.arguments || ""), contentIndex: idx };
            toolCalls.set(key, current);
            eventStream.push({ type: "toolcall_start", contentIndex: idx, partial: output });
          } else {
            if (typeof item.call_id === "string") current.id = item.call_id;
            if (typeof item.name === "string") current.name = item.name;
            if (typeof item.arguments === "string") current.arguments = item.arguments;
          }
          // If done event, finalize
          if (type === "response.output_item.done") {
            const tc = output.content[current.contentIndex] as ToolCallContent;
            tc.id = current.id;
            tc.name = current.name;
            tc.arguments = parseArgs(current.arguments);
            eventStream.push({
              type: "toolcall_end",
              contentIndex: current.contentIndex,
              toolCall: tc,
              partial: output,
            });
          }
        } else if (type === "response.completed") {
          const resp = event.response && typeof event.response === "object" && !Array.isArray(event.response)
            ? event.response as Record<string, unknown>
            : null;
          const rawUsage = resp?.usage && typeof resp.usage === "object" && !Array.isArray(resp.usage)
            ? resp.usage as Record<string, unknown>
            : null;
          const inputTokens = Number(rawUsage?.input_tokens ?? rawUsage?.prompt_tokens ?? 0);
          const outputTokens = Number(rawUsage?.output_tokens ?? rawUsage?.completion_tokens ?? 0);
          const inputDetails = rawUsage?.input_tokens_details && typeof rawUsage.input_tokens_details === "object" ? rawUsage.input_tokens_details as Record<string, unknown> : null;
          const cacheReadTokens = Number(inputDetails?.cached_tokens ?? rawUsage?.cache_read_input_tokens ?? 0);
          const cacheWriteTokens = Number(rawUsage?.cache_creation_input_tokens ?? 0);
          if (Number.isFinite(inputTokens)) usage.prompt_tokens = inputTokens;
          if (Number.isFinite(outputTokens)) usage.completion_tokens = outputTokens;
          usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
          usage.cache_read_tokens = Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0;
          usage.cache_write_tokens = Number.isFinite(cacheWriteTokens) ? cacheWriteTokens : 0;
        } else if (type === "response.failed" || type === "response.incomplete" || type === "error") {
          throw new Error(codexEventErrorMessage(event));
        }
      };

      if (!response.body) {
        throw new Error("Codex stream response body is empty");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      const reader = response.body.getReader();

      while (true) {
        if (options.signal?.aborted) {
          await reader.cancel();
          break;
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
      buffer += decoder.decode();
      for (const line of buffer.split(/\r?\n/)) {
        if (line) consumeLine(line);
      }

      if (options.signal?.aborted) {
        output.stopReason = "aborted";
        output.errorMessage = "Request was aborted";
        eventStream.push({ type: "error", reason: "aborted", error: output });
        eventStream.end();
        return;
      }

      // Finalize usage
      output.usage = computeUsage({
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        cacheReadTokens: Number(usage.cache_read_tokens ?? 0),
        cacheWriteTokens: Number(usage.cache_write_tokens ?? 0),
        rates: model.cost,
      });

      // Determine stop reason
      const hasToolCalls = output.content.some((c) => c.type === "toolCall");
      output.stopReason = hasToolCalls ? "toolUse" : "stop";

      eventStream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      eventStream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      eventStream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
      eventStream.end();
    }
  })();

  return eventStream;
};

export const listCodexModels: ApiListModelsFunction = async (
  model: AgentModelDescriptor,
  options?: { apiKey?: string },
): Promise<Array<Record<string, unknown>>> => {
  const apiKey = options?.apiKey || "";
  if (!apiKey) throw new Error("CODEX_API_KEY or Codex CLI auth is required");
  const url = new URL(`${model.baseUrl}/models`);
  url.searchParams.set("client_version", "1.0.0");
  const response = await codexFetch(url.toString(), {
    headers: codexHeaders(apiKey, model.accountId ?? null),
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

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function codexFetch(url: string, init: Record<string, unknown>): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await browserFetch(url, {
        profile: "chrome_133",
        operatingSystem: "macos",
        ...init,
      } as never) as unknown as Response;

      if (response.ok) return response;

      const status = response.status;
      const errorText = await response.text();

      if (attempt < MAX_RETRIES && isRetryableStatus(status, errorText)) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      throw new Error(`Codex API ${status}: ${errorText}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.message.includes("usage limit") || lastError.message.includes("usage_limit")) {
        throw lastError;
      }

      if (attempt < MAX_RETRIES && isRetryableNetworkError(lastError)) {
        await sleep(BASE_DELAY_MS * 2 ** attempt);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError ?? new Error("codexFetch: failed after retries");
}

function isRetryableStatus(status: number, errorText: string): boolean {
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect/i.test(errorText);
}

function isRetryableNetworkError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("unexpected eof") ||
    msg.includes("connection reset") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("fetch failed")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function contextToCodexInput(context: AgentContext): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of context.messages) {
    if (msg.role === "user") {
      out.push({ role: "user", content: userContentToCodex(msg.content) });
      continue;
    }
    if (msg.role === "assistant") {
      const text = msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("");
      const toolCallParts = msg.content.filter((c): c is ToolCallContent => c.type === "toolCall");
      const renderedToolCalls = renderToolCallsForReplay(toolCallParts);
      const replayText = [text, renderedToolCalls].filter(Boolean).join("\n\n");
      out.push({ role: "assistant", content: [{ type: "output_text", text: replayText }] });
      continue;
    }
    if (msg.role === "toolResult") {
      out.push({ role: "user", content: toolResultToCodex(msg) });
      continue;
    }
  }
  return out;
}

function userContentToCodex(
  content: string | (TextContent | ImageContent)[],
): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (item.type === "text") {
      out.push({ type: "input_text", text: item.text });
    } else {
      out.push({ type: "input_image", image_url: `data:${item.mimeType};base64,${item.data}` });
    }
  }
  if (!out.some((b) => b.type === "input_text")) {
    out.unshift({ type: "input_text", text: "" });
  }
  return out;
}

function toolResultToCodex(msg: { toolCallId: string; content: (TextContent | ImageContent)[] }): Array<Record<string, unknown>> {
  const text = msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
  const images = msg.content.filter((c): c is ImageContent => c.type === "image");
  const out: Array<Record<string, unknown>> = [{
    type: "input_text",
    text: `Tool result for ${msg.toolCallId}:\n${text}`,
  }];
  for (const img of images) {
    out.push({ type: "input_image", image_url: `data:${img.mimeType};base64,${img.data}` });
  }
  return out;
}

function renderToolCallsForReplay(toolCalls: ToolCallContent[]): string {
  if (!toolCalls.length) return "";
  const lines: string[] = [];
  for (const tc of toolCalls) {
    if (!tc.name) continue;
    lines.push(`Tool call requested: ${tc.name}`, `Arguments: ${JSON.stringify(tc.arguments ?? {})}`);
  }
  return lines.join("\n");
}

function codexToolsPayload(context: AgentContext): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let hasLocalWebSearch = false;
  for (const tool of context.tools ?? []) {
    if (!tool.name) continue;
    if (tool.name === "web_search") {
      hasLocalWebSearch = true;
      continue;
    }
    out.push({
      type: "function",
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? {},
    });
  }
  if (hasLocalWebSearch) out.push({ type: "web_search", external_web_access: true });
  return out;
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