// 编排 Pi Runtime 运行并投影为现有 Agent SSE 协议。
import crypto from "node:crypto";
import type { AssistantMessage, ImageContent, UserMessage } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../config/index.js";
import { currentTimeInstruction, MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { PiSdkRuntime } from "../agent/runtime/pi/runtime.js";
import { piProviderName, piSessionFileExists } from "../agent/runtime/pi/sessions.js";
import type { RuntimeEvent, RuntimeMessage } from "../agent/runtime/types.js";
import { buildTradexToolRegistry } from "./agent_tools.js";
import { tradexCliUrl } from "./external-cli-turn.js";
import { sessionHistory, sessionResponse } from "./helpers.js";
import {
  sendSessionUpdate,
  streamSessionRun,
  type ProjectSessionUpdate,
  type SessionRunReservation,
} from "./session-stream.js";
import type { AppRuntime } from "./runtime.js";

// 启动一次 Pi Session 消息流并返回 SSE 响应。
export function streamPiSession<Session = Record<string, unknown>, History = Record<string, unknown>>(input: {
  runtime: AppRuntime;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
  workspace?: string;
  reservation?: SessionRunReservation;
  manager: SessionManager;
  snapshot: { systemPrompt: string };
  additionalSystemPrompt?: string;
  preserveDefaultSystemPrompt?: boolean;
  persistFailedTurn?: boolean;
  requestConfig: AgentConfig;
  projectSessionUpdate?: ProjectSessionUpdate<Session, History>;
  cleanup?: () => void | Promise<void>;
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
  let projectionAttempted = false;
  const projectSession = async (send: (event: Record<string, unknown>) => void) => {
    projectionAttempted = true;
    await sendSessionUpdate({
      send,
      project: input.projectSessionUpdate,
      defaultProject: async () => ({ session: await sessionResponse(runtime, sessionId), history: await sessionHistory(runtime) }),
      state: () => runtime.state(),
    });
  };
  return streamSessionRun({
    runtime,
    sessionId,
    reservation: input.reservation,
    // 准备 Pi Tool、系统提示词和本轮 Runtime 句柄。
    async prepare(signal) {
      signal.throwIfAborted();
      const { tools } = await buildTradexToolRegistry(runtime, {
        sessionId,
        config: requestConfig,
        includeExternalMcp: true,
        includeFilesystem: true,
      });
      signal.throwIfAborted();
      const configuredSystemPrompt = snapshot.systemPrompt.trim();
      const additionalSystemPrompt = [
        input.additionalSystemPrompt,
        currentTimeInstruction("bash"),
      ].filter(Boolean).join("\n\n");
      const run = await new PiSdkRuntime().start({
        config: requestConfig,
        modelRuntime: runtime.modelRuntimeSnapshot,
        systemPrompt: configuredSystemPrompt || (input.preserveDefaultSystemPrompt ? "" : MAIN_AGENT_PROMPT),
        additionalSystemPrompt,
        preserveDefaultSystemPrompt: input.preserveDefaultSystemPrompt,
        tools,
        cwd: input.workspace,
        tradexSessionId: sessionId,
        cliUrl: tradexCliUrl(runtime.listenOrigin),
        grants: runtime.cliRunGrants,
        sessionManager: manager,
        compaction: true,
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
          await projectSession(send);
          send({
            type: "agent_end",
            error: finalError,
            errorCode: result.errorCode ?? null,
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
        },
        // 将运行或持久化异常投影为稳定的错误终止事件。
        async fail(error, send) {
          const detail = error instanceof Error ? error.message : String(error);
          if (input.persistFailedTurn && input.projectSessionUpdate && !projectionAttempted) {
            await projectSession(send);
          }
          send({ type: "error", error: detail });
          send({ type: "agent_end", error: detail, totalTokens: 0, promptTokens: 0, sessionStats: null });
        },
      };
    },
    onPrepareFailure: input.persistFailedTurn
      ? async (error, send) => {
          const detail = error instanceof Error ? error.message : String(error);
          const timestamp = Date.now();
          manager.appendMessage({
            role: "user",
            content: [
              ...(input.message ? [{ type: "text" as const, text: input.message }] : []),
              ...input.requestImages,
            ],
            timestamp,
          } satisfies UserMessage);
          const failedAssistant = {
            role: "assistant",
            content: [],
            api: requestConfig.apiMode,
            provider: piProviderName(requestConfig.provider),
            model: requestConfig.model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: detail,
            timestamp,
          } satisfies AssistantMessage;
          manager.appendMessage(failedAssistant);
          if (input.projectSessionUpdate && !projectionAttempted) {
            await projectSession(send);
          }
          send({ type: "error", code: "runtime_failure", error: detail });
          send({ type: "agent_end", error: detail, errorCode: "runtime_failure", totalTokens: 0, promptTokens: 0, sessionStats: null });
        }
      : undefined,
    // Manager cleanup belongs to the run lifecycle even when prepare fails.
    cleanup() {
      if (piSessionFileExists(manager)) runtime.pendingSessionManagers.delete(sessionId);
      return input.cleanup?.();
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
