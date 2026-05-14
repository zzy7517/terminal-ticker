import Anthropic from "@anthropic-ai/sdk";
import type { AgentModel } from "../models.js";
import type { ChatInput, ApiStreamFunction, ApiListModelsFunction } from "../api_registry.js";
import type { ChatResponse } from "../loop.js";
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
  } as never);
  let content = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      content += event.delta.text;
      await input.onDelta?.(event.delta.text);
    }
  }
  const final = await stream.finalMessage();
  const toolCalls: ToolCall[] = [];
  for (const block of final.content) {
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, arguments: (block.input || {}) as Record<string, unknown> });
  }
  return {
    content: content || final.content.filter((b) => b.type === "text").map((b) => b.text).join(""),
    toolCalls,
    finishReason: final.stop_reason || "stop",
    usage: { prompt_tokens: final.usage.input_tokens, completion_tokens: final.usage.output_tokens, total_tokens: final.usage.input_tokens + final.usage.output_tokens },
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
  const output: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const role = String(msg.role || "");
    if (role === "system") systemParts.push(String(msg.content || ""));
    else if (role === "user" || role === "assistant") output.push({ role, content: String(msg.content || "") });
    else if (role === "tool") output.push({ role: "user", content: `Tool ${String(msg.name || "")} returned:\n${String(msg.content || "")}` });
  }
  return { system: systemParts.join("\n\n"), messages: output };
}
