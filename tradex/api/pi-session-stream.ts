// 编排 Pi Runtime 运行并投影为现有 Agent SSE 协议。
import crypto from "node:crypto";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../config/index.js";
import { MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { PiSdkRuntime } from "../agent/runtime/pi/runtime.js";
import { EXTERNAL_CONTEXT_ENTRY, piSessionFileExists, type SessionAgentSnapshot } from "../agent/runtime/pi/sessions.js";
import type { RuntimeEvent, RuntimeMessage } from "../agent/runtime/types.js";
import { buildTradexToolRegistry } from "./agent_tools.js";
import { sessionHistory, sessionResponse } from "./helpers.js";
import { streamSessionRun } from "./session-stream.js";
import type { AppRuntime } from "./runtime.js";

// 启动一次 Pi Session 消息流并返回 SSE 响应。
export function streamPiSession(input: {
  runtime: AppRuntime;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
  manager: SessionManager;
  snapshot: SessionAgentSnapshot;
  requestConfig: AgentConfig;
}): Response {
  const { runtime, sessionId, manager, snapshot, requestConfig } = input;
  let assistantClientId = "";
  const toolCalls = new Map<string, { id: string; name: string; arguments: Record<string, unknown> }>();
  let finalError: string | null = null;
  let totalTokens = 0;
  let promptTokens = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let initialUserMessageSeen = false;
  let externalContextRecorded = false;

  return streamSessionRun({
    runtime,
    sessionId,
    // 准备 Pi Tool、系统提示词和本轮 Runtime 句柄。
    async prepare() {
      const { tools, externalContextToolNames } = await buildTradexToolRegistry(runtime, {
        sessionId,
        config: requestConfig,
        includeMemory: true,
        includeExternalMcp: true,
        includeFilesystem: true,
      });
      const memoryInstructions = await runtime.memoryPort.getPromptContext();
      const now = new Date();
      const sessionDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const baseSystemPrompt = snapshot.systemPrompt.trim() || MAIN_AGENT_PROMPT;
      const systemPrompt = [baseSystemPrompt, memoryInstructions ?? ""].filter(Boolean).join("\n")
        + `\nSession date: ${sessionDate} (Asia/Shanghai)`;
      const run = await new PiSdkRuntime().start({
        config: requestConfig,
        modelRuntime: runtime.modelRuntimeSnapshot,
        systemPrompt,
        tools,
        sessionManager: manager,
        prompt: input.message,
        images: input.requestImages.length > 0 ? input.requestImages : undefined,
      });
      return {
        run,
        // 按顺序持久化 Runtime 事件并发送对应 SSE 事件。
        async onEvent(event: RuntimeEvent, send: (event: Record<string, unknown>) => void) {
          if (event.type === "message-start" && event.message.role === "assistant") {
            toolCalls.clear();
            assistantClientId = `assistant:${crypto.randomUUID()}`;
            send({ type: "message_start", message: emptyAssistantMessage(sessionId, assistantClientId) });
          } else if (event.type === "message-update" && event.message.role === "assistant" && event.delta) {
            send({
              type: "message_update",
              message: { clientId: assistantClientId, role: "assistant", content: "", metadata: null, error: null },
              delta: event.delta,
            });
          } else if (event.type === "tool-start") {
            const toolCall = { id: event.callId, name: event.name, arguments: event.args };
            toolCalls.set(event.callId, toolCall);
            if (!externalContextRecorded && externalContextToolNames.has(event.name)) {
              externalContextRecorded = true;
              manager.appendCustomEntry(EXTERNAL_CONTEXT_ENTRY, { toolName: event.name });
            }
            send({ type: "tool_execution_start", toolCall });
          } else if (event.type === "tool-result") {
            const output = runtimeMessageText({
              id: `toolResult:${event.callId}`,
              role: "toolResult",
              content: event.result.content,
              timestamp: Date.now(),
            });
            const images = event.result.content
              .filter((item): item is Extract<typeof item, { type: "image" }> => item.type === "image")
              .map((item) => ({ data: item.data, mimeType: item.mimeType }));
            send({
              type: "tool_execution_end",
              toolCall: toolCalls.get(event.callId) ?? { id: event.callId, name: event.name, arguments: {} },
              toolResult: {
                callId: event.callId,
                name: event.name,
                output: output.slice(0, 2_000),
                error: event.isError,
                ...(images.length > 0 ? { images } : {}),
              },
            });
          } else if (event.type === "message-end") {
            const message = event.message;
            if (message.role === "user" && !initialUserMessageSeen) {
              initialUserMessageSeen = true;
              return;
            }
            if (message.role === "assistant") {
              const text = runtimeMessageText(message);
              await runtime.memoryPort.recordAssistantResponse(text);
              finalError = message.error ?? null;
              totalTokens += message.usage?.total ?? 0;
              promptTokens += message.usage?.input ?? 0;
              totalOutput += message.usage?.output ?? 0;
              totalCacheRead += message.usage?.cacheRead ?? 0;
              totalCacheWrite += message.usage?.cacheWrite ?? 0;
              for (const item of message.content) {
                if (item.type === "toolCall") toolCalls.set(item.id, { id: item.id, name: item.name, arguments: item.arguments });
              }
            }
            send({ type: "message_end", message: runtimeMessageDto(sessionId, message, message.role === "assistant" ? assistantClientId : undefined) });
          }
        },
        // 汇总本轮统计并发送最终 Session 状态。
        async complete(result, send) {
          finalError = result.error ?? finalError;
          send({
            type: "agent_end",
            error: finalError,
            totalTokens,
            promptTokens,
            sessionStats: {
              tokens: {
                input: promptTokens,
                output: totalOutput,
                cacheRead: totalCacheRead,
                cacheWrite: totalCacheWrite,
                total: promptTokens + totalOutput + totalCacheRead + totalCacheWrite,
              },
            },
          });
          send({
            type: "session_update",
            session: await sessionResponse(runtime, sessionId),
            history: await sessionHistory(runtime),
            state: await runtime.state(),
          });
        },
        // 将运行或持久化异常投影为稳定的错误终止事件。
        fail(error, send) {
          const detail = error instanceof Error ? error.message : String(error);
          send({ type: "error", error: detail });
          send({ type: "agent_end", error: detail, totalTokens: 0, promptTokens: 0, sessionStats: null });
        },
        // 清理已经落盘的临时 Pi SessionManager。
        cleanup() {
          if (piSessionFileExists(manager)) runtime.pendingSessionManagers.delete(sessionId);
        },
      };
    },
  });
}

// 创建前端流式渲染所需的空 assistant 消息。
function emptyAssistantMessage(sessionId: string, clientId: string): Record<string, unknown> {
  return {
    id: clientId,
    clientId,
    sessionId,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    metadata: { toolCalls: [] },
    error: null,
  };
}

// 将统一 RuntimeMessage 投影为前端 AgentMessage DTO。
function runtimeMessageDto(sessionId: string, message: RuntimeMessage, clientId?: string): Record<string, unknown> {
  return {
    id: clientId ?? message.id,
    ...(clientId ? { clientId } : {}),
    sessionId,
    role: message.role,
    content: runtimeMessageText(message),
    createdAt: new Date(message.timestamp).toISOString(),
    metadata: message.role === "assistant"
      ? {
          totalTokens: message.usage?.total ?? 0,
          promptTokens: message.usage?.input ?? 0,
          completionTokens: message.usage?.output ?? 0,
          cacheRead: message.usage?.cacheRead ?? 0,
          cacheWrite: message.usage?.cacheWrite ?? 0,
          toolCalls: message.content.filter((item) => item.type === "toolCall"),
        }
      : message.role === "toolResult"
        ? {
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            error: message.isError,
            ...runtimeImageMetadata(message),
          }
        : runtimeImageMetadata(message),
    error: message.error ?? (message.isError ? runtimeMessageText(message) : null),
  };
}

// 拼接 RuntimeMessage 中的文本内容用于 SSE 和持久化。
function runtimeMessageText(message: RuntimeMessage): string {
  return message.content.filter((item) => item.type === "text").map((item) => item.text).join("");
}

// 提取 RuntimeMessage 图片并转换为前端 metadata。
function runtimeImageMetadata(message: RuntimeMessage): Record<string, unknown> | null {
  const images = message.content
    .filter((item): item is Extract<typeof item, { type: "image" }> => item.type === "image")
    .map((item) => ({ data: item.data, mimeType: item.mimeType }));
  return images.length > 0 ? { images } : null;
}
