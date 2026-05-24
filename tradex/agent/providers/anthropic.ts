import Anthropic from "@anthropic-ai/sdk";
import type { AgentModel } from "../models.js";
import type { ChatInput, ApiStreamFunction, ApiListModelsFunction } from "../api_registry.js";
import type { ChatResponse } from "../llm_client.js";
import type { ToolCall } from "../tools/registry.js";

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
const ANTHROPIC_EFFORT_LEVELS: AnthropicEffort[] = ["low", "medium", "high", "xhigh", "max"];

function coerceAnthropicEffort(value: string): AnthropicEffort {
  return (ANTHROPIC_EFFORT_LEVELS as string[]).includes(value) ? (value as AnthropicEffort) : "high";
}

function createClient(model: AgentModel): Anthropic {
  return new Anthropic({
    ...(model.apiKey ? { apiKey: model.apiKey } : {}),
    baseURL: model.baseUrl || undefined,
  });
}

// ---- Stateless stream function (the new primary API) ----

export const streamAnthropic: ApiStreamFunction = async (model: AgentModel, input: ChatInput): Promise<ChatResponse> => {
  if (!model.apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is required");
  }
  const client = createClient(model);
  const effort = coerceAnthropicEffort(model.reasoningEffort);
  const { system, messages } = messagesToAnthropic(input.messages);
  const requestOptions = {
    ...(input.signal ? { signal: input.signal } : {}),
  };
  const stream = client.messages.stream({
    model: model.id,
    max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS || 4096),
    system,
    messages,
    tools: (input.tools ?? []).map((tool) => {
      const fn = (tool.function || {}) as Record<string, unknown>;
      return { name: String(fn.name), description: String(fn.description || ""), input_schema: (fn.parameters || {}) as never };
    }),
    output_config: { effort },
  } as never, requestOptions);
  let content = "";
  for await (const event of stream) {
    if (input.signal?.aborted) break;
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      content += event.delta.text;
      await input.onDelta?.(event.delta.text);
    }
  }
  if (input.signal?.aborted) {
    return {
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
    };
  }
  const final = await stream.finalMessage();
  const toolCalls: ToolCall[] = [];
  for (const block of final.content) {
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: (block.input || {}) as Record<string, unknown> });
  }
  const cacheRead = (final.usage as unknown as Record<string, unknown>).cache_read_input_tokens as number ?? 0;
  const cacheWrite = (final.usage as unknown as Record<string, unknown>).cache_creation_input_tokens as number ?? 0;
  return {
    content: content || final.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    toolCalls,
    finishReason: final.stop_reason || "stop",
    usage: {
      prompt_tokens: final.usage.input_tokens,
      completion_tokens: final.usage.output_tokens,
      total_tokens: final.usage.input_tokens + final.usage.output_tokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    },
  };
};

export const listAnthropicModels: ApiListModelsFunction = async (model: AgentModel): Promise<Array<Record<string, unknown>>> => {
  const client = createClient(model);
  let officialOptions: Array<Record<string, unknown>> = [];
  try {
    const page = await client.models.list({ limit: 100 });
    officialOptions = page.data.map((m) => ({
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
  } catch (error) {
    throw error;
  }
  return officialOptions;
};

// ---- Helper ----

function messagesToAnthropic(messages: Array<Record<string, unknown>>): { system: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const raw: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = String(msg.role || "");
    if (role === "system") {
      systemParts.push(String(msg.content || ""));
      continue;
    }

    if (role === "assistant") {
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls as Array<Record<string, unknown>> : [];
      if (toolCalls.length > 0) {
        const contentBlocks: Array<Record<string, unknown>> = [];
        const text = String(msg.content || "").trim();
        if (text) contentBlocks.push({ type: "text", text });
        for (const tc of toolCalls) {
          const fn = (tc.function ?? tc) as Record<string, unknown>;
          const args = typeof fn.arguments === "string"
            ? (JSON.parse(fn.arguments) as Record<string, unknown>)
            : (fn.arguments ?? {}) as Record<string, unknown>;
          contentBlocks.push({
            type: "tool_use",
            id: String(tc.id || fn.id || ""),
            name: String(fn.name || ""),
            input: args,
          });
        }
        raw.push({ role: "assistant", content: contentBlocks });
      } else {
        const text = String(msg.content || "").trim();
        if (text) raw.push({ role: "assistant", content: text });
      }
      continue;
    }

    if (role === "tool") {
      const toolImages = Array.isArray(msg.images) ? msg.images as Array<{ data: string; mimeType: string }> : [];
      if (toolImages.length > 0) {
        const toolResultContent: Array<Record<string, unknown>> = [];
        const toolText = String(msg.content || "").trim();
        if (toolText) toolResultContent.push({ type: "text", text: toolText });
        for (const img of toolImages) {
          toolResultContent.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: img.data,
            },
          });
        }
        raw.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: String(msg.tool_call_id || ""),
            content: toolResultContent,
          }],
        });
      } else {
        raw.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: String(msg.tool_call_id || ""),
            content: String(msg.content || ""),
          }],
        });
      }
      continue;
    }

    if (role === "user") {
      const images = Array.isArray(msg.images) ? msg.images as Array<{ data: string; mimeType: string }> : [];
      if (images.length > 0) {
        const contentBlocks: Array<Record<string, unknown>> = [];
        const text = String(msg.content || "").trim();
        if (text) contentBlocks.push({ type: "text", text });
        for (const img of images) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: img.data,
            },
          });
        }
        raw.push({ role: "user", content: contentBlocks });
      } else {
        raw.push({ role: "user", content: String(msg.content || "") });
      }
      continue;
    }
  }

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

  return { system: systemParts.join("\n\n"), messages: merged };
}
