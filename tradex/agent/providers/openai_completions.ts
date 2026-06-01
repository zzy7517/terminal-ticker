/**
 * providers/openai_completions.ts — OpenAI Chat Completions compatible provider.
 *
 * Speaks the OpenAI `/chat/completions` wire format. This single provider
 * covers OpenAI itself plus any OpenAI-compatible backend — most importantly
 * a LiteLLM proxy, but also Ollama, vLLM, OpenRouter, DeepSeek, etc.
 *
 * Mirrors pi's "provider per wire-format, not per vendor" design
 * (packages/ai/src/providers/openai-completions.ts): switching backends is
 * just changing `base_url`; this file never needs to change per vendor.
 *
 * Returns an AssistantMessageEventStream with fine-grained streaming events,
 * matching the contract of streamAnthropic / streamCodex.
 */

import OpenAI from "openai";
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

/**
 * Resolve the API key for an OpenAI-compatible request. The caller-supplied
 * key (from the resolved AgentModel) wins; the env vars are a second-layer
 * fallback so the provider still works when invoked outside the config flow.
 */
function resolveApiKey(provided?: string): string {
  return provided
    || process.env.OPENAI_API_KEY
    || process.env.LITELLM_API_KEY
    || "";
}

function createClient(model: AgentModelDescriptor, apiKey: string): OpenAI {
  return new OpenAI({
    // OpenAI-compatible proxies (LiteLLM) still require *some* key; callers
    // supply the proxy's master key. A blank key would 401 on real OpenAI.
    apiKey: apiKey || "missing-api-key",
    baseURL: model.baseUrl || undefined,
    maxRetries: Number(process.env.OPENAI_MAX_RETRIES || 4),
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 120000),
  });
}

/**
 * Extract a diagnosable error message from an OpenAI SDK error. Like the
 * Anthropic SDK, connection failures collapse to a terse string with the real
 * cause buried in `.cause`; API failures expose status/code/request id.
 */
function describeOpenAIError(error: unknown, model: AgentModelDescriptor): string {
  if (!(error instanceof Error)) return String(error);
  const err = error as Error & {
    status?: number;
    code?: string | null;
    type?: string | null;
    requestID?: string | null;
    error?: { message?: string; type?: string; code?: string };
    cause?: unknown;
  };
  const parts: string[] = [];

  if (typeof err.status === "number") {
    parts.push(err.message);
    const bodyType = err.error?.type;
    const bodyCode = err.error?.code;
    if (bodyType) parts.push(`type=${bodyType}`);
    if (bodyCode) parts.push(`code=${bodyCode}`);
    if (err.requestID) parts.push(`request_id=${err.requestID}`);
  } else {
    parts.push(`${err.constructor?.name || "Error"}: ${err.message}`);
    let cause: unknown = err.cause;
    const seen = new Set<unknown>();
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        const code = (cause as Error & { code?: string }).code;
        parts.push(code ? `${cause.message} (${code})` : cause.message);
        cause = (cause as Error & { cause?: unknown }).cause;
      } else {
        parts.push(String(cause));
        break;
      }
    }
    if (model.baseUrl) parts.push(`baseURL=${model.baseUrl}`);
  }
  return parts.join(" | ");
}

function mapFinishReason(reason: string | null | undefined): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "length": return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    default: return "stop";
  }
}

export const streamOpenAICompletions: StreamFn = (
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
      const apiKey = resolveApiKey(options.apiKey);
      const client = createClient(model, apiKey);
      const messages = convertContextToOpenAI(context);
      const tools = (context.tools ?? []).map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters as Record<string, unknown>,
        },
      }));

      const stream = await client.chat.completions.create(
        {
          model: model.id,
          messages: messages as never,
          ...(tools.length > 0 ? { tools, tool_choice: "auto" as const } : {}),
          stream: true,
          // Ask the proxy to include token usage in the final stream chunk.
          // LiteLLM/OpenAI both honor this; absent usage falls back to zeros.
          stream_options: { include_usage: true },
          max_tokens: Number(process.env.OPENAI_MAX_TOKENS || 4096),
        },
        { ...(options.signal ? { signal: options.signal } : {}) },
      );

      eventStream.push({ type: "start", partial: output });

      // Tool calls arrive as deltas keyed by `index`. Accumulate raw JSON
      // string per index, parse lazily.
      interface ToolAccum {
        contentIndex: number; // index into output.content
        id: string;
        name: string;
        argsJson: string;
      }
      const toolsByIndex = new Map<number, ToolAccum>();
      let textContentIndex = -1; // index into output.content for the text block
      let finishReason: string | null = null;

      for await (const chunk of stream) {
        if (options.signal?.aborted) break;

        // Usage typically arrives on the final chunk (choices may be empty).
        const usage = (chunk as { usage?: Record<string, number> | null }).usage;
        if (usage) {
          output.usage.input = Number(usage.prompt_tokens ?? 0);
          output.usage.output = Number(usage.completion_tokens ?? 0);
          // LiteLLM may surface a cached-prompt-tokens breakdown.
          const details = (usage as Record<string, unknown>).prompt_tokens_details as
            | { cached_tokens?: number }
            | undefined;
          output.usage.cacheRead = Number(details?.cached_tokens ?? 0);
          output.usage.totalTokens = output.usage.input + output.usage.output;
          output.usage.cost = computeUsage({
            inputTokens: output.usage.input,
            outputTokens: output.usage.output,
            cacheReadTokens: output.usage.cacheRead,
            rates: model.cost,
          }).cost;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta;
        if (!delta) continue;

        // --- text deltas ---
        if (typeof delta.content === "string" && delta.content.length > 0) {
          if (textContentIndex === -1) {
            const block: TextContent = { type: "text", text: "" };
            output.content.push(block);
            textContentIndex = output.content.length - 1;
            eventStream.push({ type: "text_start", contentIndex: textContentIndex, partial: output });
          }
          const block = output.content[textContentIndex] as TextContent;
          block.text += delta.content;
          eventStream.push({
            type: "text_delta",
            contentIndex: textContentIndex,
            delta: delta.content,
            partial: output,
          });
        }

        // --- tool call deltas ---
        const toolCallDeltas = (delta as { tool_calls?: Array<Record<string, unknown>> }).tool_calls;
        if (Array.isArray(toolCallDeltas)) {
          for (const tcDelta of toolCallDeltas) {
            const idx = Number(tcDelta.index ?? 0);
            let accum = toolsByIndex.get(idx);
            if (!accum) {
              const block: ToolCallContent = { type: "toolCall", id: "", name: "", arguments: {} };
              output.content.push(block);
              accum = { contentIndex: output.content.length - 1, id: "", name: "", argsJson: "" };
              toolsByIndex.set(idx, accum);
              eventStream.push({ type: "toolcall_start", contentIndex: accum.contentIndex, partial: output });
            }
            const fn = tcDelta.function as { name?: string; arguments?: string } | undefined;
            if (tcDelta.id) accum.id = String(tcDelta.id);
            if (fn?.name) accum.name = fn.name;
            if (fn?.arguments) {
              accum.argsJson += fn.arguments;
              eventStream.push({
                type: "toolcall_delta",
                contentIndex: accum.contentIndex,
                delta: fn.arguments,
                partial: output,
              });
            }
            // Keep the live block in sync so `partial` snapshots are accurate.
            const block = output.content[accum.contentIndex] as ToolCallContent;
            block.id = accum.id;
            block.name = accum.name;
            try {
              block.arguments = accum.argsJson ? JSON.parse(accum.argsJson) : {};
            } catch {
              // partial JSON; keep last good parse
            }
          }
        }
      }

      if (options.signal?.aborted) {
        output.stopReason = "aborted";
        output.errorMessage = "Request was aborted";
        eventStream.push({ type: "error", reason: "aborted", error: output });
        eventStream.end();
        return;
      }

      // Finalize text block.
      if (textContentIndex !== -1) {
        const block = output.content[textContentIndex] as TextContent;
        eventStream.push({ type: "text_end", contentIndex: textContentIndex, content: block.text, partial: output });
      }

      // Finalize tool blocks.
      for (const accum of toolsByIndex.values()) {
        const block = output.content[accum.contentIndex] as ToolCallContent;
        block.id = accum.id;
        block.name = accum.name;
        try {
          block.arguments = accum.argsJson ? JSON.parse(accum.argsJson) : {};
        } catch {
          block.arguments = {};
        }
        eventStream.push({
          type: "toolcall_end",
          contentIndex: accum.contentIndex,
          toolCall: block,
          partial: output,
        });
      }

      // Determine final stop reason. Prefer the server's finish_reason; fall
      // back to inferring toolUse from accumulated content.
      const hasToolCalls = output.content.some((c) => c.type === "toolCall");
      output.stopReason = mapFinishReason(finishReason);
      if (hasToolCalls && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }

      eventStream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      eventStream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = options.signal?.aborted
        ? "Request was aborted"
        : describeOpenAIError(error, model);
      eventStream.push({
        type: "error",
        reason: output.stopReason as "aborted" | "error",
        error: output,
      });
      eventStream.end();
    }
  })();

  return eventStream;
};

export const listOpenAICompletionsModels: ApiListModelsFunction = async (
  model: AgentModelDescriptor,
  options?: { apiKey?: string },
): Promise<Array<Record<string, unknown>>> => {
  const apiKey = resolveApiKey(options?.apiKey);
  const client = createClient(model, apiKey);
  const page = await client.models.list();
  const out: Array<Record<string, unknown>> = [];
  for await (const m of page) {
    out.push({
      slug: m.id,
      displayName: m.id,
      description: "",
      visibility: "public",
      supportedInApi: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [],
      contextWindow: null,
      preferWebsockets: false,
      custom: false,
    });
  }
  return out;
};

// ---- AgentContext → OpenAI Chat Completions wire format ----

function convertContextToOpenAI(context: AgentContext): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const system = context.systemPrompt ?? "";
  if (system.trim()) {
    out.push({ role: "system", content: system });
  }
  for (const msg of context.messages) {
    appendMessage(out, msg);
  }
  return out;
}

function appendMessage(out: Array<Record<string, unknown>>, msg: AgentMessage): void {
  if (msg.role === "user") {
    out.push(convertUserMessage(msg.content));
    return;
  }
  if (msg.role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: Array<Record<string, unknown>> = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        if (block.text.trim()) textParts.push(block.text);
      } else if (block.type === "toolCall") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.arguments ?? {}),
          },
        });
      }
      // thinking blocks are not replayed to OpenAI-compatible endpoints
    }
    if (textParts.length === 0 && toolCalls.length === 0) return;
    const entry: Record<string, unknown> = {
      role: "assistant",
      content: textParts.length > 0 ? textParts.join("") : null,
    };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    out.push(entry);
    return;
  }
  if (msg.role === "toolResult") {
    // OpenAI requires one `tool` message per tool_call_id, content as string.
    out.push({
      role: "tool",
      tool_call_id: msg.toolCallId,
      content: toolResultText(msg.content),
    });
    return;
  }
  // custom messages are not sent to the LLM
}

function convertUserMessage(content: string | (TextContent | ImageContent)[]): Record<string, unknown> {
  if (typeof content === "string") {
    return { role: "user", content };
  }
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    const text = content.map((c) => (c as TextContent).text).join("\n");
    return { role: "user", content: text };
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (item.type === "text") {
      if (item.text.trim()) parts.push({ type: "text", text: item.text });
    } else {
      parts.push({
        type: "image_url",
        image_url: { url: `data:${item.mimeType};base64,${item.data}` },
      });
    }
  }
  return { role: "user", content: parts };
}

/**
 * Flatten tool-result content into a string. OpenAI-compatible `tool` messages
 * take string content; image results are downgraded to a placeholder since the
 * tool role cannot carry image parts in the Chat Completions schema.
 */
function toolResultText(content: (TextContent | ImageContent)[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text") parts.push(item.text);
    else parts.push("(image omitted)");
  }
  return parts.join("\n");
}