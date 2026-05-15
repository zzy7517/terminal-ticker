/**
 * core/stream-adapter.ts — Bridges existing provider stream functions to the new StreamFn interface.
 *
 * The old providers return ChatResponse (content string + toolCalls array).
 * The new core expects StreamFn returning StreamResult (AssistantMessage).
 * This adapter converts between them.
 */

import type { ApiStreamFunction, ChatInput } from "../api_registry.js";
import { getApiStream } from "../api_registry.js";
import type { AgentModel } from "../models.js";
import type {
  AgentContext,
  AgentMessage,
  AgentModelDescriptor,
  AssistantMessage,
  StreamFn,
  StreamOptions,
  StreamResult,
  TextContent,
  ToolCallContent,
  UserMessage,
  ToolResultMessage,
} from "./types.js";

/**
 * Create a StreamFn from the existing api_registry dispatch.
 * This allows the new Agent to use the existing Codex/Anthropic providers.
 */
export function createStreamFnFromRegistry(): StreamFn {
  return async (model: AgentModelDescriptor, context: AgentContext, options: StreamOptions): Promise<StreamResult> => {
    const streamFn = getApiStream(model.api);

    // Convert AgentContext to the old ChatInput format
    const messages = contextToLegacyMessages(context);
    const tools = contextToLegacyToolSchemas(context);

    const legacyModel: AgentModel = {
      id: model.id,
      provider: model.provider,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoningEffort: model.reasoningEffort,
      apiKey: options.apiKey,
      accountId: model.accountId,
    };

    const chatInput: ChatInput = {
      messages,
      tools: tools.length > 0 ? tools : null,
      onDelta: options.onDelta,
      signal: options.signal,
    };

    const response = await streamFn(legacyModel, chatInput);

    // Convert ChatResponse to AssistantMessage
    const content: (TextContent | ToolCallContent)[] = [];

    if (response.content) {
      content.push({ type: "text", text: response.content });
    }

    for (const call of response.toolCalls) {
      content.push({
        type: "toolCall",
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      });
    }

    const aborted = options.signal?.aborted === true;
    const assistantMessage: AssistantMessage = {
      role: "assistant",
      content,
      provider: model.provider,
      model: model.id,
      usage: {
        input: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
        output: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
        totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0,
      },
      stopReason: aborted ? "aborted" : response.toolCalls.length > 0 ? "toolUse" : "stop",
      ...(aborted ? { errorMessage: "Request was aborted" } : {}),
      timestamp: Date.now(),
    };

    return { message: assistantMessage };
  };
}

// ============================================================================
// Conversion Helpers
// ============================================================================

/**
 * Convert AgentContext messages to the legacy Record<string, unknown>[] format
 * expected by existing providers.
 */
function contextToLegacyMessages(context: AgentContext): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];

  // System prompt
  if (context.systemPrompt) {
    out.push({ role: "system", content: context.systemPrompt });
  }

  for (const msg of context.messages) {
    if (msg.role === "user") {
      const userMsg = msg as UserMessage;
      const text = typeof userMsg.content === "string"
        ? userMsg.content
        : userMsg.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("\n");
      out.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const assistantMsg = msg as AssistantMessage;
      const textParts = assistantMsg.content.filter((c): c is TextContent => c.type === "text");
      const toolCallParts = assistantMsg.content.filter((c): c is ToolCallContent => c.type === "toolCall");
      const text = textParts.map((c) => c.text).join("");

      if (toolCallParts.length > 0) {
        out.push({
          role: "assistant",
          content: text,
          tool_calls: toolCallParts.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else {
        out.push({ role: "assistant", content: text });
      }
    } else if (msg.role === "toolResult") {
      const toolMsg = msg as ToolResultMessage;
      const text = toolMsg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      out.push({
        role: "tool",
        tool_call_id: toolMsg.toolCallId,
        name: toolMsg.toolName,
        content: text,
      });
    }
    // Skip "custom" messages — they are not sent to LLM
  }

  return out;
}

/**
 * Convert AgentTool[] to OpenAI tool schema format.
 */
function contextToLegacyToolSchemas(context: AgentContext): Array<Record<string, unknown>> {
  return (context.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}
