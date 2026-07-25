/** 编排 Cursor Session 消息、Runtime 事件、持久化投影和 SSE 输出。 */
import crypto from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { CURSOR_CLI_INSTRUCTIONS, currentTimeInstruction, MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { detectCursorCli } from "../agent/runtime/cursor/discovery.js";
import { CursorCliRuntime, exposeCursorReadTools } from "../agent/runtime/cursor/runtime.js";
import type { ExternalSessionStorePort } from "../agent/runtime/external-session-store.js";
import type { RuntimeEvent } from "../agent/runtime/types.js";
import { buildTradexToolRegistry } from "./agent_tools.js";
import { sessionHistory, sessionResponse } from "./helpers.js";
import type { AppRuntime } from "./runtime.js";
import { sendSessionUpdate, streamSessionRun, type ProjectSessionUpdate } from "./session-stream.js";
import { tradexCliUrl, validateClaudeImages, promptWithAttachments } from "./claude-session-stream.js";

export interface CursorSessionStreamInput<Session, History> {
  runtime: AppRuntime;
  requestUrl: string;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
  sessionStore?: ExternalSessionStorePort<"cursor">;
  workspace?: string;
  baseSystemPrompt?: string;
  projectSessionUpdate?: ProjectSessionUpdate<Session, History>;
}

interface ToolCallProjection {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 校验 Session 后启动 Cursor CLI，并把运行事件映射为现有 SSE 协议。 */
export async function streamCursorSession<Session = Record<string, unknown>, History = Record<string, unknown>>(
  input: CursorSessionStreamInput<Session, History>,
): Promise<Response> {
  const { runtime, sessionId, requestImages } = input;
  const sessionStore = input.sessionStore ?? runtime.cursorSessions;
  const metadata = sessionStore.getMetadata(sessionId);
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
      const attachmentPaths = await saveCursorAttachments(sessionStore, sessionId, requestImages);
      prompt = promptWithAttachments(prompt, attachmentPaths, Boolean(input.workspace));
      const availability = await requireCursorCli();
      const tools = await buildCursorTools(runtime, sessionId);
      let run;
      try {
        run = await new CursorCliRuntime({
          executablePath: availability.executablePath,
          cliUrl: tradexCliUrl(input.requestUrl),
          grants: runtime.cliRunGrants,
        }).start({
          tradexSessionId: sessionId,
          cwd: input.workspace ?? sessionStore.sessionDir(sessionId),
          prompt,
          instructions: cursorInstructions(metadata.snapshot.systemPrompt, input.baseSystemPrompt),
          registry: tools,
          nativeSessionId: sessionStore.getMetadata(sessionId)?.nativeSessionId ?? undefined,
          model: metadata.snapshot.model,
        });
        sessionStore.beginRun(sessionId);
        sessionStore.appendMessage(sessionId, {
          role: "user",
          content: input.message,
          metadata: attachmentMetadata(requestImages, attachmentPaths),
        });
      } catch (error) {
        await run?.abort();
        await run?.result;
        sessionStore.endRun(sessionId, {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      if (run.nativeSessionId) sessionStore.setNativeSessionId(sessionId, run.nativeSessionId);
      return {
        run,
        onEvent(event: RuntimeEvent, send: (event: Record<string, unknown>) => void) {
          if (event.type === "run-start" && event.nativeSessionId) {
            sessionStore.setNativeSessionId(sessionId, event.nativeSessionId);
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
            sessionStore.appendMessage(sessionId, {
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
          sessionStore.endRun(sessionId, {
            status: runErrorCode === "aborted" ? "cancelled" : runError ? "error" : "completed",
            error: runError,
          });
          if (result.nativeSessionId) sessionStore.setNativeSessionId(sessionId, result.nativeSessionId);
          if (!assistantText && result.output) assistantText = result.output;

          const persisted = sessionStore.appendMessage(sessionId, {
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
          await sendSessionUpdate({
            send,
            project: input.projectSessionUpdate,
            defaultProject: async () => ({ session: await sessionResponse(runtime, sessionId), history: await sessionHistory(runtime) }),
            state: () => runtime.state(),
          });
        },
        fail(error, send) {
          if (error instanceof CursorSessionStreamError) runErrorCode = error.code;
          runError = error instanceof Error ? error.message : String(error);
          sessionStore.endRun(sessionId, { status: "error", error: runError });
          if (!assistantPersisted) {
            sessionStore.appendMessage(sessionId, {
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

function cursorInstructions(agentInstructions: string, baseSystemPrompt = MAIN_AGENT_PROMPT): string {
  return [
    baseSystemPrompt,
    ...(agentInstructions.trim() && agentInstructions.trim() !== baseSystemPrompt.trim() ? [agentInstructions.trim()] : []),
    CURSOR_CLI_INSTRUCTIONS,
    currentTimeInstruction("shell"),
    "Do not place trades, access Memory outside this workspace, configure additional tool servers, or claim those capabilities are available.",
  ].join("\n\n");
}

const CURSOR_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

async function saveCursorAttachments(
  sessionStore: { sessionDir(id: string): string },
  sessionId: string,
  images: ImageContent[],
): Promise<string[]> {
  const directory = path.join(sessionStore.sessionDir(sessionId), "attachments");
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
