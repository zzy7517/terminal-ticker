import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { RuntimeContent, RuntimeEvent, RuntimeMessage, RuntimeToolResult } from "../types.js";

export function piEventToRuntimeEvents(event: AgentEvent, turnId: string): RuntimeEvent[] {
  switch (event.type) {
    case "agent_start": return [{ type: "run-start" }];
    case "agent_end": {
      const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
      return [{
        type: "run-end",
        result: assistant ? runtimeMessageText(piMessageToRuntimeMessage(assistant)) : "",
        status: assistant && "errorMessage" in assistant && assistant.errorMessage ? "error" : "completed",
      }];
    }
    case "turn_start": return [{ type: "turn-start", turnId }];
    case "turn_end": return [{
      type: "turn-end",
      turnId,
      message: piMessageToRuntimeMessage(event.message),
      toolResults: event.toolResults.map(piMessageToRuntimeMessage),
    }];
    case "message_start": return [{ type: "message-start", message: piMessageToRuntimeMessage(event.message) }];
    case "message_update": {
      const delta = event.assistantMessageEvent.type === "text_delta" ? event.assistantMessageEvent.delta : "";
      return [{ type: "message-update", message: piMessageToRuntimeMessage(event.message), delta }];
    }
    case "message_end": return [{ type: "message-end", message: piMessageToRuntimeMessage(event.message) }];
    case "tool_execution_start": return [{ type: "tool-start", callId: event.toolCallId, name: event.toolName, args: event.args }];
    case "tool_execution_update": return [{
      type: "tool-update",
      callId: event.toolCallId,
      name: event.toolName,
      args: event.args,
      partialResult: piToolResult(event.partialResult),
    }];
    case "tool_execution_end": return [{
      type: "tool-result",
      callId: event.toolCallId,
      name: event.toolName,
      result: piToolResult(event.result),
      isError: event.isError,
    }];
  }
}

export function piMessageToRuntimeMessage(message: AgentMessage): RuntimeMessage {
  if (message.role === "user") {
    const user = message as UserMessage;
    return { id: `user:${user.timestamp}`, role: "user", content: piContent(user.content), timestamp: user.timestamp };
  }
  if (message.role === "toolResult") {
    const tool = message as ToolResultMessage;
    return {
      id: `toolResult:${tool.toolCallId}`,
      role: "toolResult",
      content: piContent(tool.content),
      timestamp: tool.timestamp,
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      isError: tool.isError,
    };
  }
  const assistant = message as AssistantMessage;
  return {
    id: `assistant:${assistant.timestamp}`,
    role: "assistant",
    content: assistant.content.flatMap((item): RuntimeContent[] => item.type === "toolCall"
      ? [{ type: "toolCall", id: item.id, name: item.name, arguments: item.arguments }]
      : item.type === "text"
        ? [{ type: "text", text: item.text }]
        : []),
    timestamp: assistant.timestamp,
    usage: {
      model: assistant.model,
      input: assistant.usage.input,
      output: assistant.usage.output,
      cacheRead: assistant.usage.cacheRead,
      cacheWrite: assistant.usage.cacheWrite,
      total: assistant.usage.totalTokens,
    },
    error: assistant.errorMessage ?? null,
  };
}

function runtimeMessageText(message: RuntimeMessage): string {
  return message.content
    .filter((item): item is Extract<RuntimeContent, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function piToolResult(result: { content?: unknown; details?: unknown; terminate?: boolean }): RuntimeToolResult {
  return {
    content: piContent(Array.isArray(result.content) ? result.content : []),
    details: result.details,
    terminate: result.terminate,
  };
}

function piContent(content: unknown): RuntimeContent[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item): RuntimeContent[] => {
    if (!item || typeof item !== "object" || !("type" in item)) return [];
    if (item.type === "text") return [{ type: "text", text: (item as TextContent).text }];
    if (item.type === "image") {
      const image = item as ImageContent;
      return [{ type: "image", data: image.data, mimeType: image.mimeType }];
    }
    return [];
  });
}
