/**
 * providers/anthropic.ts — Anthropic Messages API provider.
 *
 * Modeled after pi-mono's packages/ai/src/providers/anthropic.ts. Speaks the
 * core typed contract directly: receives an `AgentContext` containing typed
 * `Message[]` and returns a `StreamResult { message: AssistantMessage }`.
 * No intermediate stringly-typed shape.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentContext,
  AgentMessage,
  AgentModelDescriptor,
  AssistantMessage,
  ImageContent,
  StreamFn,
  StreamOptions,
  StreamResult,
  TextContent,
  ToolCallContent,
} from "../core/types.js";
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
  });
}

export const streamAnthropic: StreamFn = async (
  model: AgentModelDescriptor,
  context: AgentContext,
  options: StreamOptions,
): Promise<StreamResult> => {
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

  let collectedText = "";
  for await (const event of stream) {
    if (options.signal?.aborted) break;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      collectedText += event.delta.text;
      await options.onDelta?.(event.delta.text);
    }
  }

  const aborted = options.signal?.aborted === true;

  if (aborted) {
    const message: AssistantMessage = {
      role: "assistant",
      content: collectedText ? [{ type: "text", text: collectedText }] : [],
      provider: model.provider,
      model: model.id,
      usage: computeUsage({ inputTokens: 0, outputTokens: 0, rates: model.cost }),
      stopReason: "aborted",
      errorMessage: "Request was aborted",
      timestamp: Date.now(),
    };
    return { message };
  }

  const final = await stream.finalMessage();
  const finalText = final.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const text = collectedText || finalText;

  const content: (TextContent | ToolCallContent)[] = [];
  if (text) content.push({ type: "text", text });
  for (const block of final.content) {
    if (block.type === "tool_use") {
      content.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }

  const usageRaw = final.usage as unknown as Record<string, unknown>;
  const cacheRead = Number(usageRaw.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(usageRaw.cache_creation_input_tokens ?? 0);
  const usage = computeUsage({
    inputTokens: final.usage.input_tokens,
    outputTokens: final.usage.output_tokens,
    cacheReadTokens: Number.isFinite(cacheRead) ? cacheRead : 0,
    cacheWriteTokens: Number.isFinite(cacheWrite) ? cacheWrite : 0,
    rates: model.cost,
  });

  const hasToolCalls = content.some((c) => c.type === "toolCall");
  const message: AssistantMessage = {
    role: "assistant",
    content,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: hasToolCalls ? "toolUse" : "stop",
    timestamp: Date.now(),
  };
  return { message };
};

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
        // thinking blocks are not yet wired through tradex; skipped intentionally.
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
 * content shape. Returns a string when only plain text is present so the
 * payload stays minimal.
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
