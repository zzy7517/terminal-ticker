/**
 * core/agent-loop.ts — Pure stateless agent loop.
 *
 * This function does not own state. The caller (Agent class) passes a
 * COPIED context snapshot. The loop mutates context.messages on its own
 * copy (for building LLM context across turns) and emits events through
 * the sink. The Agent class receives these events and updates its own
 * authoritative state independently.
 *
 * Two entry points:
 * - runAgentLoop(): starts from new prompt messages
 * - runAgentLoopContinue(): resumes from existing context (retry)
 */

import type {
  AgentContext,
  AgentEvent,
  AgentEventSink,
  AgentLoopConfig,
  AgentMessage,
  AgentToolResult,
  AssistantMessage,
  StreamFn,
  ToolCallContent,
  ToolResultMessage,
  Usage,
} from "./types.js";
import { EventStream } from "./event-stream.js";

/**
 * Maximum number of automatic continuations when the assistant response is
 * truncated (stopReason: "length"). Prevents infinite continuation loops.
 */
const MAX_CONTINUATIONS = 3;

/** System message injected to prompt the LLM to continue its truncated output. */
const CONTINUATION_PROMPT = "Your previous response was truncated due to length limits. Please continue exactly where you left off.";

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

// ============================================================================
// Public API
// ============================================================================

/**
 * Start an agent loop with new prompt messages.
 * Returns an EventStream that can be consumed via `for await`.
 *
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = new EventStream<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );

  void runAgentLoop(
    prompts,
    context,
    config,
    async (event) => { stream.push(event); },
    signal,
    streamFn,
  ).then((messages) => {
    stream.end(messages);
  });

  return stream;
}

/**
 * Continue an agent loop from current context without adding a new message.
 * Returns an EventStream that can be consumed via `for await`.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const stream = new EventStream<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );

  void runAgentLoopContinue(
    context,
    config,
    async (event) => { stream.push(event); },
    signal,
    streamFn,
  ).then((messages) => {
    stream.end(messages);
  });

  return stream;
}

/**
 * Start an agent loop with new prompt messages (async, sink-based).
 * The prompts are added to context.messages and events are emitted.
 */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];

  // Add prompts to context
  for (const prompt of prompts) {
    context.messages.push(prompt);
  }

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  // Emit message events for the initial prompts
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(context, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

/**
 * Continue an agent loop from current context without adding a new message.
 * Used for retries — context already has user message or tool results.
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }

  const lastMessage = context.messages[context.messages.length - 1];
  if (lastMessage.role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const newMessages: AgentMessage[] = [];

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(context, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

// ============================================================================
// Core Loop
// ============================================================================

async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;

  // Check for steering messages at start
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

  // Outer loop: continues when follow-up messages arrive after agent would stop
  while (true) {
    let hasMoreToolCalls = true;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        await emit({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      // Process pending messages (inject before next assistant response)
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // Check abort
      if (signal?.aborted) {
        const abortMsg = createAbortedMessage(config);
        await emitAssistantMessage(abortMsg, emit);
        currentContext.messages.push(abortMsg);
        newMessages.push(abortMsg);
        await emit({ type: "turn_end", message: abortMsg, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Stream assistant response
      let message = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // ── Output Guard: auto-continue on truncation ──────────────────────
      // When the assistant's response is cut off (stopReason: "length") and
      // there are no tool calls, automatically prompt the LLM to continue.
      if (message.stopReason === "length" && !message.content.some((c) => c.type === "toolCall")) {
        let continuations = 0;
        let lastMsg = message;
        while (lastMsg.stopReason === "length" && continuations < MAX_CONTINUATIONS) {
          continuations++;
          await emit({ type: "turn_end", message: lastMsg, toolResults: [] });

          // Inject continuation prompt
          const continuationMsg: AgentMessage = {
            role: "user",
            content: CONTINUATION_PROMPT,
            timestamp: Date.now(),
          };
          currentContext.messages.push(continuationMsg);
          newMessages.push(continuationMsg);
          await emit({ type: "turn_start" });
          await emit({ type: "message_start", message: continuationMsg });
          await emit({ type: "message_end", message: continuationMsg });

          // Stream the continuation response
          lastMsg = await streamAssistantResponse(currentContext, config, signal, emit, streamFn);
          newMessages.push(lastMsg);

          if (lastMsg.stopReason === "error" || lastMsg.stopReason === "aborted") {
            await emit({ type: "turn_end", message: lastMsg, toolResults: [] });
            await emit({ type: "agent_end", messages: newMessages });
            return;
          }
        }
        // Update message reference to the final continuation
        message = lastMsg;
      }

      // Check for tool calls
      const toolCalls = message.content.filter((c): c is ToolCallContent => c.type === "toolCall");
      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;

      if (toolCalls.length > 0) {
        const batch = await executeToolCalls(currentContext, message, toolCalls, config, signal, emit);
        toolResults.push(...batch.messages);
        hasMoreToolCalls = !batch.terminate;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });

      // prepareNextTurn hook
      const turnContext = { message, toolResults, context: currentContext, newMessages };
      const nextTurnSnapshot = await config.prepareNextTurn?.(turnContext);
      if (nextTurnSnapshot) {
        if (nextTurnSnapshot.context) currentContext = nextTurnSnapshot.context;
        config = {
          ...config,
          model: nextTurnSnapshot.model ?? config.model,
          reasoning: nextTurnSnapshot.thinkingLevel === undefined
            ? config.reasoning
            : nextTurnSnapshot.thinkingLevel === "off"
              ? undefined
              : nextTurnSnapshot.thinkingLevel,
        };
      }

      // shouldStopAfterTurn hook
      if (await config.shouldStopAfterTurn?.(turnContext)) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Poll steering messages
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // Agent would stop here. Check for follow-up messages.
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    // No more messages, exit
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

// ============================================================================
// Assistant Response Streaming
// ============================================================================

/**
 * Stream an assistant response from the LLM.
 * Consumes the AssistantMessageEventStream via `for await`, emitting
 * fine-grained AgentEvents for each provider event.
 *
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<AssistantMessage> {
  // Apply context transform if configured (AgentMessage[] → AgentMessage[])
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // Convert to LLM-compatible messages (AgentMessage[] → Message[])
  const llmMessages = config.convertToLlm(messages);

  // Build LLM context
  const llmContext: AgentContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  // Resolve API key (important for expiring tokens)
  const resolvedApiKey = (config.getApiKey
    ? await config.getApiKey(config.model.provider)
    : undefined) || config.apiKey;

  const streamFunction = streamFn || config.streamFn;

  // Call provider — returns an AssistantMessageEventStream (async iterable)
  const response = streamFunction(config.model, llmContext, {
    apiKey: resolvedApiKey,
    signal,
    reasoning: config.reasoning,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  // Fallback: stream ended without done/error event
  const finalMessage = await response.result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

// ============================================================================
// Tool Execution
// ============================================================================

interface ExecutedToolBatch {
  messages: ToolResultMessage[];
  terminate: boolean;
}

async function executeToolCalls(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolBatch> {
  const hasSequentialTool = toolCalls.some(
    (tc) => context.tools.find((t) => t.name === tc.name)?.executionMode === "sequential",
  );

  if (config.toolExecution === "sequential" || hasSequentialTool) {
    return executeToolCallsSequential(context, assistantMessage, toolCalls, config, signal, emit);
  }
  return executeToolCallsParallel(context, assistantMessage, toolCalls, config, signal, emit);
}

async function executeToolCallsSequential(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolBatch> {
  const messages: ToolResultMessage[] = [];
  const results: { terminate?: boolean }[] = [];

  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    const { message, result } = await executeSingleToolCall(
      context, assistantMessage, toolCall, config, signal, emit,
    );

    await emit({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError: message.isError,
    });

    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });

    messages.push(message);
    results.push(result);
  }

  const terminate = results.length > 0 && results.every((r) => r.terminate === true);
  return { messages, terminate };
}

async function executeToolCallsParallel(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: ToolCallContent[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolBatch> {
  // Emit all tool_execution_start events first
  for (const toolCall of toolCalls) {
    await emit({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
  }

  // Execute all in parallel
  const promises = toolCalls.map((toolCall) =>
    executeSingleToolCall(context, assistantMessage, toolCall, config, signal, emit),
  );
  const outcomes = await Promise.all(promises);

  // Emit completion events in order
  const messages: ToolResultMessage[] = [];
  const results: { terminate?: boolean }[] = [];

  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    const { message, result } = outcomes[i];

    await emit({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError: message.isError,
    });

    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });

    messages.push(message);
    results.push(result);
  }

  const terminate = results.length > 0 && results.every((r) => r.terminate === true);
  return { messages, terminate };
}

async function executeSingleToolCall(
  context: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: ToolCallContent,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<{ message: ToolResultMessage; result: AgentToolResult }> {
  const tool = context.tools.find((t) => t.name === toolCall.name);

  if (!tool) {
    const result = createErrorToolResult(`Tool ${toolCall.name} not found`);
    return { message: createToolResultMessage(toolCall, result, true), result };
  }

  // beforeToolCall hook
  if (config.beforeToolCall) {
    const beforeResult = await config.beforeToolCall(
      { assistantMessage, toolCall, args: toolCall.arguments, context },
      signal,
    );
    if (beforeResult?.block) {
      const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
      return { message: createToolResultMessage(toolCall, result, true), result };
    }
  }

  // Execute tool
  let result: AgentToolResult;
  let isError = false;

  try {
    result = await tool.execute(
      toolCall.id,
      toolCall.arguments,
      signal,
      (partialResult) => {
        // Fire-and-forget update event
        void emit({
          type: "tool_execution_update",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          partialResult,
        });
      },
    );
  } catch (error) {
    result = createErrorToolResult(error instanceof Error ? error.message : String(error));
    isError = true;
  }

  // afterToolCall hook
  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        { assistantMessage, toolCall, args: toolCall.arguments, result, isError, context },
        signal,
      );
      if (afterResult) {
        result = {
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }

  return { message: createToolResultMessage(toolCall, result, isError), result };
}

// ============================================================================
// Helpers
// ============================================================================

function createErrorToolResult(message: string): AgentToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

function createToolResultMessage(
  toolCall: ToolCallContent,
  result: AgentToolResult,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now(),
  };
}

function createErrorMessage(config: AgentLoopConfig, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    provider: config.model.provider,
    model: config.model.id,
    usage: EMPTY_USAGE,
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function createAbortedMessage(config: AgentLoopConfig): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    provider: config.model.provider,
    model: config.model.id,
    usage: EMPTY_USAGE,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  };
}

async function emitAssistantMessage(message: AssistantMessage, emit: AgentEventSink): Promise<void> {
  await emit({ type: "message_start", message });
  await emit({ type: "message_end", message });
}
