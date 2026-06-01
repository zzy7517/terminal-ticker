/**
 * providers/anthropic.ts — Anthropic Messages API provider.
 *
 * Returns an AssistantMessageEventStream with fine-grained streaming events.
 */

import Anthropic from "@anthropic-ai/sdk";
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
  ThinkingContent,
  ToolCallContent,
} from "../core/types.js";
import { AssistantMessageEventStream } from "../core/event-stream.js";
import { computeUsage } from "../core/usage.js";
import type { ApiListModelsFunction } from "../api_registry.js";

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
const ANTHROPIC_EFFORT_LEVELS: AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];
type AnthropicMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function coerceAnthropicEffort(value: string): AnthropicEffort {
  return (ANTHROPIC_EFFORT_LEVELS as string[]).includes(value) ? (value as AnthropicEffort) : "high";
}

function createClient(model: AgentModelDescriptor, apiKey: string): Anthropic {
  return new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    baseURL: model.baseUrl || undefined,
    maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES || 4),
    timeout: Number(process.env.ANTHROPIC_TIMEOUT_MS || 120000),
  });
}

/**
 * Extract a human-readable, diagnosable error message from an Anthropic SDK
 * error. The SDK collapses network failures into the unhelpful string
 * "Connection error." with the real reason buried in `.cause`, and API
 * failures expose status/type/request-id on the error object. This surfaces
 * status code, error type, request id, and the underlying cause chain so the
 * frontend shows something actionable instead of "Connection error.".
 *
 * Property names match @anthropic-ai/sdk's APIError: `status`, `type`,
 * `requestID`, and `error` (the parsed response body), plus `cause` on
 * APIConnectionError.
 */
function describeAnthropicError(error: unknown, model: AgentModelDescriptor): string {
  if (!(error instanceof Error)) return String(error);

  const err = error as Error & {
    status?: number;
    type?: string | null;
    requestID?: string | null;
    error?: unknown;
    cause?: unknown;
  };
  const parts: string[] = [];

  if (typeof err.status === "number") {
    // HTTP-level API error (4xx/5xx). err.message is already "<status> <msg>".
    parts.push(err.message);
    const body = err.error as { error?: { type?: string } } | undefined;
    const bodyType = body?.error?.type;
    if (bodyType) parts.push(`type=${bodyType}`);
    else if (err.type) parts.push(`type=${err.type}`);
    if (err.requestID) parts.push(`request_id=${err.requestID}`);
  } else {
    // Network-level failure (APIConnectionError / timeout). The bare message
    // is "Connection error."; the real reason is in the cause chain.
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
    // Connection failures almost always mean the proxy/base URL is unreachable.
    if (model.baseUrl) parts.push(`baseURL=${model.baseUrl}`);
  }

  return parts.join(" | ");
}

const EMPTY_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const streamAnthropic: StreamFn = (
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
      const apiKey = options.apiKey
        || process.env.ANTHROPIC_API_KEY
        || process.env.ANTHROPIC_AUTH_TOKEN
        || "";
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required");
      }
      const client = createClient(model, apiKey);
      const effort = coerceAnthropicEffort(model.reasoningEffort);
      const { system, messages } = convertContextToAnthropic(context);

      const requestOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const stream = client.messages.stream({
        model: model.id,
        max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 4096),
        system,
        messages,
        tools: (context.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters as never,
        })),
        output_config: { effort },
      } as never, requestOptions);

      // Emit start event
      eventStream.push({ type: "start", partial: output });

      // Track content blocks by index for delta routing
      type Block = (TextContent | ThinkingContent | (ToolCallContent & { partialJson: string })) & { blockIndex: number };
      const blocks = output.content as unknown as Block[];

      for await (const event of stream) {
        if (options.signal?.aborted) break;

        if (event.type === "message_start") {
          // Capture initial usage
          const msg = (event as unknown as { message: { usage?: Record<string, number> } }).message;
          if (msg?.usage) {
            output.usage.input = msg.usage.input_tokens || 0;
            output.usage.output = msg.usage.output_tokens || 0;
            output.usage.cacheRead = Number(msg.usage.cache_read_input_tokens ?? 0);
            output.usage.cacheWrite = Number(msg.usage.cache_creation_input_tokens ?? 0);
            output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          }
        } else if (event.type === "content_block_start") {
          const blockEvent = event as unknown as { index: number; content_block: { type: string; id?: string; name?: string; input?: unknown } };
          if (blockEvent.content_block.type === "text") {
            const block: Block = { type: "text", text: "", blockIndex: blockEvent.index };
            blocks.push(block);
            eventStream.push({ type: "text_start", contentIndex: blocks.length - 1, partial: output });
          } else if (blockEvent.content_block.type === "thinking") {
            const block: Block = { type: "thinking", thinking: "", blockIndex: blockEvent.index };
            blocks.push(block);
            eventStream.push({ type: "thinking_start", contentIndex: blocks.length - 1, partial: output });
          } else if (blockEvent.content_block.type === "tool_use") {
            const block: Block = {
              type: "toolCall",
              id: blockEvent.content_block.id || "",
              name: blockEvent.content_block.name || "",
              arguments: (blockEvent.content_block.input ?? {}) as Record<string, unknown>,
              partialJson: "",
              blockIndex: blockEvent.index,
            };
            blocks.push(block);
            eventStream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
          }
        } else if (event.type === "content_block_delta") {
          const deltaEvent = event as unknown as { index: number; delta: { type: string; text?: string; thinking?: string; partial_json?: string } };
          const blockIdx = blocks.findIndex((b) => b.blockIndex === deltaEvent.index);
          const block = blocks[blockIdx];
          if (!block) continue;

          if (deltaEvent.delta.type === "text_delta" && block.type === "text") {
            block.text += deltaEvent.delta.text || "";
            eventStream.push({
              type: "text_delta",
              contentIndex: blockIdx,
              delta: deltaEvent.delta.text || "",
              partial: output,
            });
          } else if (deltaEvent.delta.type === "thinking_delta" && block.type === "thinking") {
            block.thinking += deltaEvent.delta.thinking || "";
            eventStream.push({
              type: "thinking_delta",
              contentIndex: blockIdx,
              delta: deltaEvent.delta.thinking || "",
              partial: output,
            });
          } else if (deltaEvent.delta.type === "input_json_delta" && block.type === "toolCall") {
            (block as Block & { partialJson: string }).partialJson += deltaEvent.delta.partial_json || "";
            try {
              block.arguments = JSON.parse((block as Block & { partialJson: string }).partialJson);
            } catch {
              // Partial JSON, keep accumulating
            }
            eventStream.push({
              type: "toolcall_delta",
              contentIndex: blockIdx,
              delta: deltaEvent.delta.partial_json || "",
              partial: output,
            });
          }
        } else if (event.type === "content_block_stop") {
          const stopEvent = event as unknown as { index: number };
          const blockIdx = blocks.findIndex((b) => b.blockIndex === stopEvent.index);
          const block = blocks[blockIdx];
          if (!block) continue;

          // Clean up blockIndex before emitting end
          delete (block as { blockIndex?: number }).blockIndex;

          if (block.type === "text") {
            eventStream.push({ type: "text_end", contentIndex: blockIdx, content: block.text, partial: output });
          } else if (block.type === "thinking") {
            eventStream.push({ type: "thinking_end", contentIndex: blockIdx, content: block.thinking, partial: output });
          } else if (block.type === "toolCall") {
            // Finalize JSON parsing
            const partialJson = (block as unknown as { partialJson: string }).partialJson;
            if (partialJson) {
              try { block.arguments = JSON.parse(partialJson); } catch { /* keep last valid parse */ }
            }
            delete (block as unknown as { partialJson?: string }).partialJson;
            eventStream.push({
              type: "toolcall_end",
              contentIndex: blockIdx,
              toolCall: block as ToolCallContent,
              partial: output,
            });
          }
        } else if (event.type === "message_delta") {
          const deltaEvent = event as unknown as { delta: { stop_reason?: string }; usage?: Record<string, number> };
          if (deltaEvent.delta.stop_reason) {
            output.stopReason = mapStopReason(deltaEvent.delta.stop_reason);
          }
          if (deltaEvent.usage) {
            if (deltaEvent.usage.output_tokens != null) {
              output.usage.output = deltaEvent.usage.output_tokens;
            }
            if (deltaEvent.usage.input_tokens != null) {
              output.usage.input = deltaEvent.usage.input_tokens;
            }
            const usageAny = deltaEvent.usage as Record<string, unknown>;
            if (usageAny.cache_read_input_tokens != null) {
              output.usage.cacheRead = Number(usageAny.cache_read_input_tokens);
            }
            if (usageAny.cache_creation_input_tokens != null) {
              output.usage.cacheWrite = Number(usageAny.cache_creation_input_tokens);
            }
            output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
            // Recompute cost
            const computed = computeUsage({
              inputTokens: output.usage.input,
              outputTokens: output.usage.output,
              cacheReadTokens: output.usage.cacheRead,
              cacheWriteTokens: output.usage.cacheWrite,
              rates: model.cost,
            });
            output.usage.cost = computed.cost;
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

      // Clean up any remaining blockIndex fields
      for (const block of blocks) {
        delete (block as { blockIndex?: number }).blockIndex;
        delete (block as { partialJson?: string }).partialJson;
      }

      // Determine final stop reason from content
      const hasToolCalls = output.content.some((c) => c.type === "toolCall");
      if (hasToolCalls && output.stopReason === "stop") {
        output.stopReason = "toolUse";
      }

      eventStream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      eventStream.end();
    } catch (error) {
      // Clean up content blocks
      for (const block of output.content as unknown as Array<{ blockIndex?: number; partialJson?: string }>) {
        delete block.blockIndex;
        delete block.partialJson;
      }
      output.stopReason = options.signal?.aborted ? "aborted" : "error";
      output.errorMessage = options.signal?.aborted
        ? "Request was aborted"
        : describeAnthropicError(error, model);
      eventStream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
      eventStream.end();
    }
  })();

  return eventStream;
};

function mapStopReason(reason: string): "stop" | "length" | "toolUse" | "error" | "aborted" {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "toolUse";
    case "stop_sequence": return "stop";
    default: return "stop";
  }
}

export const listAnthropicModels: ApiListModelsFunction = async (
  model: AgentModelDescriptor,
  options?: { apiKey?: string },
): Promise<Array<Record<string, unknown>>> => {
  const apiKey = options?.apiKey
    || process.env.ANTHROPIC_API_KEY
    || process.env.ANTHROPIC_AUTH_TOKEN
    || "";
  const client = createClient(model, apiKey);
  const page = await client.models.list({ limit: 100 });
  return page.data.map((m) => ({
    slug: m.id,
    displayName: m.display_name || m.id,
    description: "",
    visibility: "public",
    supportedInApi: true,
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: [...ANTHROPIC_EFFORT_LEVELS],
    contextWindow: null,
    preferWebsockets: false,
    custom: false,
  }));
};

// ---- AgentContext → Anthropic wire format ----

function convertContextToAnthropic(context: AgentContext): {
  system: string;
  messages: Array<Record<string, unknown>>;
} {
  const system = context.systemPrompt ?? "";
  const raw = convertMessages(context.messages);

  // Anthropic requires strictly alternating user/assistant. Merge consecutive
  // same-role messages (e.g. multiple tool_result user blocks in a row).
  const merged: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === entry.role) {
      const prevContent = Array.isArray(prev.content)
        ? prev.content as Array<Record<string, unknown>>
        : [{ type: "text", text: String(prev.content || "") }];
      const curContent = Array.isArray(entry.content)
        ? entry.content as Array<Record<string, unknown>>
        : [{ type: "text", text: String(entry.content || "") }];
      prev.content = [...prevContent, ...curContent];
    } else {
      merged.push({ ...entry });
    }
  }

  return { system, messages: merged };
}

function convertMessages(messages: AgentMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      out.push(convertUserMessage(msg.content));
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          if (block.text.trim()) blocks.push({ type: "text", text: block.text });
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments ?? {},
          });
        }
        // thinking blocks are not yet wired through for replay; skipped.
      }
      if (blocks.length === 0) continue;
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.role === "toolResult") {
      out.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: convertContentBlocks(msg.content),
          is_error: msg.isError,
        }],
      });
      continue;
    }
    // custom messages are not sent to the LLM
  }
  return out;
}

function convertUserMessage(content: string | (TextContent | ImageContent)[]): Record<string, unknown> {
  if (typeof content === "string") {
    return { role: "user", content };
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (item.type === "text") {
      if (item.text.trim()) blocks.push({ type: "text", text: item.text });
    } else {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: item.mimeType as AnthropicMediaType,
          data: item.data,
        },
      });
    }
  }
  if (blocks.length === 0) return { role: "user", content: "" };
  return { role: "user", content: blocks };
}

/**
 * Convert tool-result content (text + images) into Anthropic's tool_result
 * content shape. Returns a string when only plain text is present.
 */
function convertContentBlocks(
  content: (TextContent | ImageContent)[],
): string | Array<Record<string, unknown>> {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return content.map((c) => (c as TextContent).text).join("\n");
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (item.type === "text") {
      blocks.push({ type: "text", text: item.text });
    } else {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: item.mimeType as AnthropicMediaType,
          data: item.data,
        },
      });
    }
  }
  // If only images, prepend a placeholder text block so Anthropic doesn't reject.
  if (!blocks.some((b) => b.type === "text")) {
    blocks.unshift({ type: "text", text: "(see attached image)" });
  }
  return blocks;
}