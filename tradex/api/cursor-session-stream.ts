/** 编排 Cursor Session 消息、Runtime 事件、持久化投影和 SSE 输出。 */
import crypto from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { currentTimeInstruction, MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { detectCursorCli } from "../agent/runtime/cursor/discovery.js";
import { CursorCliRuntime, exposeCursorReadTools } from "../agent/runtime/cursor/runtime.js";
import type { RuntimeEvent } from "../agent/runtime/types.js";
import { buildTradexToolRegistry } from "./agent_tools.js";
import { sessionHistory, sessionResponse } from "./helpers.js";
import type { AppRuntime } from "./runtime.js";
import { streamSessionRun } from "./session-stream.js";
import { claudeMcpUrl, validateClaudeImages, promptWithAttachments } from "./claude-session-stream.js";

export interface CursorSessionStreamInput {
  runtime: AppRuntime;
  requestUrl: string;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
}

interface ToolCallProjection {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 校验 Session 后启动 Cursor CLI，并把运行事件映射为现有 SSE 协议。 */
export async function streamCursorSession(input: CursorSessionStreamInput): Promise<Response> {
  const { runtime, sessionId, requestImages } = input;
  const metadata = runtime.cursorSessions.getMetadata(sessionId);
  if (!metadata) return Response.json({ detail: "agent session not found" }, { status: 404 });
  let prompt = input.message;

  const assistantClientId = `assistant:${crypto.randomUUID()}`;
  let assistantStarted = false;
  let assistantText = "";
  let runError: string | null = null;
  let runErrorCode: string | null = null;
  let assistantPersisted = false;
  const model = metadata.snapshot.model;
  const toolCalls = new Map<string, ToolCallProjection>();

  return streamSessionRun({
    runtime,
    sessionId,
    async prepare() {
      const attachmentPaths = await saveCursorAttachments(runtime, sessionId, requestImages);
      prompt = promptWithAttachments(prompt, attachmentPaths);
      const availability = await requireCursorCli();
      const tools = await buildCursorTools(runtime, sessionId);
      let run;
      try {
        run = await new CursorCliRuntime({
          executablePath: availability.executablePath,
          mcpUrl: claudeMcpUrl(input.requestUrl),
          grants: runtime.mcpRunGrants,
        }).start({
          tradexSessionId: sessionId,
          cwd: runtime.cursorSessions.sessionDir(sessionId),
          prompt,
          instructions: cursorInstructions(metadata.snapshot.systemPrompt),
          registry: tools,
          nativeSessionId: runtime.cursorSessions.getMetadata(sessionId)?.nativeSessionId ?? undefined,
          model: metadata.snapshot.model,
        });
        runtime.cursorSessions.beginRun(sessionId);
        runtime.cursorSessions.appendMessage(sessionId, {
          role: "user",
          content: input.message,
          metadata: attachmentMetadata(requestImages, attachmentPaths),
        });
      } catch (error) {
        await run?.abort();
        await run?.result;
        runtime.cursorSessions.endRun(sessionId, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (run.nativeSessionId) runtime.cursorSessions.setNativeSessionId(sessionId, run.nativeSessionId);
      return {
        run,
        onEvent(event: RuntimeEvent, send: (event: Record<string, unknown>) => void) {
          if (event.type === "run-start" && event.nativeSessionId) {
            runtime.cursorSessions.setNativeSessionId(sessionId, event.nativeSessionId);
          } else if (event.type === "message-update" && event.message.role === "assistant") {
            if (!assistantStarted) {
              assistantStarted = true;
              send({ type: "message_start", message: cursorMessageDto(sessionId, assistantClientId) });
            }
            assistantText += event.delta;
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
            const toolCall = toolCalls.get(event.callId) ?? { id: event.callId, name: "unknown", arguments: {} };
            const output = event.result.content
              .filter((item): item is Extract<typeof item, { type: "text" }> => item.type === "text")
              .map((item) => item.text)
              .join("");
            runtime.cursorSessions.appendMessage(sessionId, {
              role: "toolResult",
              content: output,
              metadata: { toolCallId: event.callId, toolName: toolCall.name, error: event.isError },
              error: event.isError ? output : null,
            });
            send({
              type: "tool_execution_end",
              toolCall,
              toolResult: {
                callId: event.callId,
                name: toolCall.name,
                output: output.slice(0, 2_000),
                error: event.isError,
              },
            });
          }
        },
        async complete(result, send) {
          runError = result.error;
          runErrorCode = result.errorCode ?? null;
          runtime.cursorSessions.endRun(sessionId, {
            status: runErrorCode === "aborted" ? "cancelled" : runError ? "error" : "completed",
            error: runError,
          });
          if (result.nativeSessionId) runtime.cursorSessions.setNativeSessionId(sessionId, result.nativeSessionId);
          if (!assistantText && result.output) assistantText = result.output;

          const persisted = runtime.cursorSessions.appendMessage(sessionId, {
            role: "assistant",
            content: assistantText,
            error: runError,
            metadata: {
              errorCode: runErrorCode,
              model,
              toolCalls: [...toolCalls.values()],
            },
          });
          assistantPersisted = true;
          if (!assistantStarted) {
            send({ type: "message_start", message: cursorMessageDto(sessionId, assistantClientId) });
            if (assistantText) {
              send({
                type: "message_update",
                message: { clientId: assistantClientId, role: "assistant", content: "", metadata: null, error: null },
                delta: assistantText,
              });
            }
          }
          send({ type: "message_end", message: { ...persisted, id: assistantClientId, clientId: assistantClientId } });
          send({
            type: "agent_end",
            error: runError,
            errorCode: runErrorCode,
            totalTokens: 0,
            promptTokens: 0,
            sessionStats: null,
          });
          send({
            type: "session_update",
            session: await sessionResponse(runtime, sessionId),
            history: await sessionHistory(runtime),
            state: await runtime.state(),
          });
        },
        fail(error, send) {
          if (error instanceof CursorSessionStreamError) runErrorCode = error.code;
          runError = error instanceof Error ? error.message : String(error);
          runtime.cursorSessions.endRun(sessionId, { status: "error", error: runError });
          if (!assistantPersisted) {
            runtime.cursorSessions.appendMessage(sessionId, {
              role: "assistant",
              content: assistantText,
              error: runError,
              metadata: { errorCode: runErrorCode, toolCalls: [...toolCalls.values()] },
            });
            assistantPersisted = true;
          }
          send({ type: "error", code: runErrorCode ?? "runtime_failure", error: runError });
          send({ type: "agent_end", error: runError, errorCode: runErrorCode, totalTokens: 0, promptTokens: 0, sessionStats: null });
        },
      };
    },
  });
}

async function requireCursorCli() {
  const availability = await detectCursorCli(process.env.TRADEX_CURSOR_PATH?.trim() || "");
  if (!availability.available) {
    throw new CursorSessionStreamError(
      "runtime_unavailable",
      availability.error ?? "Cursor CLI runtime is unavailable",
    );
  }
  return availability;
}

class CursorSessionStreamError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CursorSessionStreamError";
  }
}

async function buildCursorTools(runtime: AppRuntime, sessionId: string) {
  const { tools } = await buildTradexToolRegistry(runtime, {
    sessionId,
    config: runtime.config.agent,
    includeExternalMcp: false,
    includeFilesystem: false,
  });
  return exposeCursorReadTools(tools);
}

function cursorInstructions(agentInstructions: string): string {
  return [
    MAIN_AGENT_PROMPT,
    ...(agentInstructions.trim() && agentInstructions.trim() !== MAIN_AGENT_PROMPT.trim() ? [agentInstructions.trim()] : []),
    "You are running inside Tradex via Cursor Agent CLI. Use Cursor's native coding tools in this Session workspace and the explicitly allowed Tradex Tools exposed through MCP for market data.",
    currentTimeInstruction("shell"),
    "Do not place trades, access Memory outside this workspace, configure external MCP servers, or claim those capabilities are available.",
  ].join("\n\n");
}

const CURSOR_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

async function saveCursorAttachments(runtime: AppRuntime, sessionId: string, images: ImageContent[]): Promise<string[]> {
  const directory = path.join(runtime.cursorSessions.sessionDir(sessionId), "attachments");
  return Promise.all(images.map(async (image) => {
    const file = path.join(directory, `${crypto.randomUUID()}.${CURSOR_IMAGE_TYPES[image.mimeType] ?? "bin"}`);
    await writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return file;
  }));
}

function attachmentMetadata(images: ImageContent[], attachmentPaths: string[]): Record<string, unknown> | null {
  if (attachmentPaths.length === 0) return null;
  return {
    images: images.map((image, index) => ({
      mimeType: image.mimeType,
      filename: path.basename(attachmentPaths[index]),
    })),
  };
}

function cursorMessageDto(sessionId: string, clientId: string): Record<string, unknown> {
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

export { validateClaudeImages as validateCursorImages };
