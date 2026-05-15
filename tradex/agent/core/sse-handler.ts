/**
 * core/sse-handler.ts — SSE streaming handler using the new Agent.
 *
 * This replaces the inline SSE logic in routes/agent.ts.
 * The handler creates an Agent, subscribes to events, sends the prompt,
 * and streams events as SSE frames until agent_end.
 */

import crypto from "node:crypto";
import type { AgentConfig } from "../../config/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { Agent } from "./agent.js";
import { createAgent } from "./agent-runtime.js";
import { registryToAgentTools } from "./tool-adapter.js";
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
} from "./types.js";

export interface SSEHandlerOptions {
  sessionId: string;
  message: string;
  config: AgentConfig;
  tools: ToolRegistry;
  systemPrompt: string;
  history: Array<Record<string, unknown>>;
  /** Called when assistant message is finalized. */
  onAssistantComplete?: (result: {
    content: string;
    usage: { input: number; output: number; totalTokens: number };
    toolCalls: ToolCallContent[];
    error: string | null;
  }) => void;
  /** Called for each tool result. */
  onToolResult?: (result: { toolCallId: string; toolName: string; output: string; isError: boolean }) => void;
}

export interface SSEFrame {
  type: string;
  [key: string]: unknown;
}

/**
 * Run an agent prompt and yield SSE frames.
 * Returns an async generator of SSEFrame objects.
 */
export async function* runAgentSSE(options: SSEHandlerOptions): AsyncGenerator<SSEFrame> {
  const agent = createAgent({
    config: options.config,
    tools: options.tools,
    systemPrompt: options.systemPrompt,
  });

  // Restore history into agent messages
  for (const msg of options.history) {
    const role = String(msg.role || "");
    if (role === "user") {
      agent.messages = [...agent.messages, {
        role: "user",
        content: String(msg.content || ""),
        timestamp: Date.now(),
      }];
    } else if (role === "assistant") {
      const content: (TextContent | ToolCallContent)[] = [{ type: "text", text: String(msg.content || "") }];
      agent.messages = [...agent.messages, {
        role: "assistant",
        content,
        provider: agent.model.provider,
        model: agent.model.id,
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: "stop",
        timestamp: Date.now(),
      }];
    } else if (role === "system") {
      // System messages from branch summaries → inject as user context
      agent.messages = [...agent.messages, {
        role: "user",
        content: String(msg.content || ""),
        timestamp: Date.now(),
      }];
    } else if (role === "tool") {
      agent.messages = [...agent.messages, {
        role: "toolResult",
        toolCallId: String(msg.tool_call_id || ""),
        toolName: String(msg.name || ""),
        content: [{ type: "text", text: String(msg.content || "") }],
        isError: false,
        timestamp: Date.now(),
      }];
    }
  }

  // Set up delta streaming
  let deltaBuffer = "";
  agent.onDelta = (delta: string) => {
    deltaBuffer += delta;
  };

  // Collect events via a queue
  const eventQueue: AgentEvent[] = [];
  let resolveWait: (() => void) | null = null;
  let agentDone = false;

  agent.subscribe((event) => {
    eventQueue.push(event);
    if (resolveWait) {
      resolveWait();
      resolveWait = null;
    }
  });

  // Start the prompt (non-blocking)
  const promptPromise = agent.prompt(options.message).catch((err) => {
    eventQueue.push({
      type: "agent_end",
      messages: [],
    } as AgentEvent);
    if (resolveWait) { resolveWait(); resolveWait = null; }
  });

  // Yield initial frame
  yield { type: "agent_start" };

  // Process events as they arrive
  while (!agentDone) {
    if (eventQueue.length === 0) {
      await new Promise<void>((resolve) => { resolveWait = resolve; });
    }

    while (eventQueue.length > 0) {
      const event = eventQueue.shift()!;
      const frames = eventToFrames(event, options, deltaBuffer);
      deltaBuffer = "";

      for (const frame of frames) {
        yield frame;
      }

      if (event.type === "agent_end") {
        agentDone = true;
        break;
      }
    }
  }

  // Wait for prompt to fully settle
  await promptPromise;
}

// ============================================================================
// Event → SSE Frame conversion
// ============================================================================

function eventToFrames(event: AgentEvent, options: SSEHandlerOptions, pendingDelta: string): SSEFrame[] {
  const frames: SSEFrame[] = [];

  // Flush any pending delta
  if (pendingDelta) {
    frames.push({ type: "message_update", delta: pendingDelta });
  }

  switch (event.type) {
    case "turn_start":
      // No frame needed
      break;

    case "tool_execution_start":
      frames.push({
        type: "tool_execution_start",
        toolCall: { id: event.toolCallId, name: event.toolName, arguments: event.args },
      });
      break;

    case "tool_execution_end": {
      const toolOutput = event.result.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      frames.push({
        type: "tool_execution_end",
        toolCall: { id: event.toolCallId, name: event.toolName, arguments: {} },
        toolResult: {
          callId: event.toolCallId,
          name: event.toolName,
          output: toolOutput.slice(0, 2000),
          error: event.isError,
        },
      });
      if (options.onToolResult) {
        options.onToolResult({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: toolOutput,
          isError: event.isError,
        });
      }
      break;
    }

    case "message_end": {
      const msg = event.message;
      if (msg.role === "assistant") {
        const assistant = msg as AssistantMessage;
        const text = assistant.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
        const toolCalls = assistant.content
          .filter((c): c is ToolCallContent => c.type === "toolCall");

        if (options.onAssistantComplete) {
          options.onAssistantComplete({
            content: text,
            usage: assistant.usage,
            toolCalls,
            error: assistant.errorMessage ?? null,
          });
        }
      }
      break;
    }

    case "agent_end":
      frames.push({
        type: "agent_end",
        error: null,
        totalTokens: 0,
        promptTokens: 0,
      });
      break;
  }

  return frames;
}
