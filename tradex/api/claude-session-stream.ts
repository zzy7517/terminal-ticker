/** 编排 Claude Session 消息、Runtime 事件、持久化投影和 SSE 输出。 */
import crypto from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { detectClaudeCode } from "../agent/runtime/claude-code/discovery.js";
import { ClaudeCodeRuntime, exposeClaudeReadTools } from "../agent/runtime/claude-code/runtime.js";
import type { RuntimeEvent } from "../agent/runtime/types.js";
import { AgentSseWriter } from "./agent_sse.js";
import { buildTradexToolRegistry } from "./agent_tools.js";
import { sessionHistory, sessionResponse } from "./helpers.js";
import type { AppRuntime } from "./runtime.js";

export interface ClaudeSessionStreamInput {
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

interface UsageProjection {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 校验 Session 后启动 Claude，并把运行事件映射为现有 SSE 协议。 */
export async function streamClaudeSession(input: ClaudeSessionStreamInput): Promise<Response> {
  const { runtime, sessionId, requestImages } = input;
  const metadata = runtime.claudeSessions.getMetadata(sessionId);
  if (!metadata) return Response.json({ detail: "agent session not found" }, { status: 404 });
  if (runtime.lockedAgentSessions.has(sessionId)) {
    return Response.json({ detail: "an agent run is already active for this session" }, { status: 409 });
  }
  runtime.lockedAgentSessions.add(sessionId);

  let prompt = input.message;
  try {
    const attachmentPaths = await saveClaudeAttachments(runtime, sessionId, requestImages);
    prompt = promptWithAttachments(prompt, attachmentPaths);
    runtime.claudeSessions.appendMessage(sessionId, {
      role: "user",
      content: input.message,
      metadata: attachmentMetadata(requestImages, attachmentPaths),
    });
  } catch (error) {
    runtime.lockedAgentSessions.delete(sessionId);
    return Response.json({ detail: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }

  const runId = crypto.randomUUID();
  const sse = new AgentSseWriter(sessionId, runId);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => sse.send(controller, event);
      send({ type: "agent_start" });

      const assistantClientId = `assistant:${crypto.randomUUID()}`;
      let assistantStarted = false;
      let assistantText = "";
      let runError: string | null = null;
      let runErrorCode: string | null = null;
      let model = metadata.snapshot.model;
      const usage: UsageProjection = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const toolCalls = new Map<string, ToolCallProjection>();

      try {
        runtime.claudeSessions.beginRun(sessionId);
        const availability = await requireClaudeCode();
        const tools = await buildClaudeTools(runtime, sessionId);
        const run = await new ClaudeCodeRuntime({
          executablePath: availability.executablePath,
          mcpUrl: claudeMcpUrl(input.requestUrl),
          grants: runtime.mcpRunGrants,
        }).start({
          tradexSessionId: sessionId,
          cwd: runtime.claudeSessions.sessionDir(sessionId),
          prompt,
          instructions: claudeInstructions(metadata.snapshot.systemPrompt),
          registry: tools,
          nativeSessionId: runtime.claudeSessions.getMetadata(sessionId)?.nativeSessionId ?? undefined,
          model: metadata.snapshot.model,
          effort: metadata.snapshot.reasoningEffort,
        });
        runtime.activeAgents.set(sessionId, run);
        if (run.nativeSessionId) runtime.claudeSessions.setNativeSessionId(sessionId, run.nativeSessionId);

        const unsubscribe = run.subscribe((event: RuntimeEvent) => {
          if (event.type === "run-start" && event.nativeSessionId) {
            runtime.claudeSessions.setNativeSessionId(sessionId, event.nativeSessionId);
          } else if (event.type === "text-delta") {
            if (!assistantStarted) {
              assistantStarted = true;
              send({ type: "message_start", message: claudeMessageDto(sessionId, assistantClientId) });
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
          } else if (event.type === "tool-end") {
            const toolCall = toolCalls.get(event.callId) ?? { id: event.callId, name: "unknown", arguments: {} };
            runtime.claudeSessions.appendMessage(sessionId, {
              role: "toolResult",
              content: event.output,
              metadata: { toolCallId: event.callId, toolName: toolCall.name, error: event.isError },
              error: event.isError ? event.output : null,
            });
            send({
              type: "tool_execution_end",
              toolCall,
              toolResult: {
                callId: event.callId,
                name: toolCall.name,
                output: event.output.slice(0, 2_000),
                error: event.isError,
              },
            });
          } else if (event.type === "usage") {
            model = event.model;
            usage.input += event.input;
            usage.output += event.output;
            usage.cacheRead += event.cacheRead;
            usage.cacheWrite += event.cacheWrite;
          }
        });

        const result = await run.result;
        unsubscribe();
        runError = result.error;
        runErrorCode = result.errorCode ?? null;
        runtime.claudeSessions.endRun(sessionId, {
          status: runErrorCode === "aborted" ? "cancelled" : runError ? "error" : "completed",
          error: runError,
        });
        if (result.nativeSessionId) runtime.claudeSessions.setNativeSessionId(sessionId, result.nativeSessionId);
        if (!assistantText && result.output) assistantText = result.output;

        const totalTokens = totalUsage(usage);
        const persisted = runtime.claudeSessions.appendMessage(sessionId, {
          role: "assistant",
          content: assistantText,
          error: runError,
          metadata: {
            errorCode: runErrorCode,
            model,
            promptTokens: usage.input,
            completionTokens: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens,
            toolCalls: [...toolCalls.values()],
          },
        });
        if (!assistantStarted) {
          send({ type: "message_start", message: claudeMessageDto(sessionId, assistantClientId) });
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
          totalTokens,
          promptTokens: usage.input,
          sessionStats: { tokens: { ...usage, total: totalTokens }, cost: 0 },
        });
        send({
          type: "session_update",
          session: await sessionResponse(runtime, sessionId),
          history: await sessionHistory(runtime),
          state: await runtime.state(),
        });
      } catch (error) {
        if (error instanceof ClaudeSessionStreamError) runErrorCode = error.code;
        runError = error instanceof Error ? error.message : String(error);
        runtime.claudeSessions.endRun(sessionId, { status: "error", error: runError });
        runtime.claudeSessions.appendMessage(sessionId, {
          role: "assistant",
          content: assistantText,
          error: runError,
          metadata: { errorCode: runErrorCode, toolCalls: [...toolCalls.values()] },
        });
        send({ type: "error", code: runErrorCode ?? "runtime_failure", error: runError });
        send({ type: "agent_end", error: runError, errorCode: runErrorCode, totalTokens: 0, promptTokens: 0, sessionStats: null });
      } finally {
        runtime.activeAgents.delete(sessionId);
        runtime.lockedAgentSessions.delete(sessionId);
        try { controller.close(); } catch { /* stream already cancelled */ }
      }
    },
    cancel() {
      sse.cancel();
      runtime.activeAgents.get(sessionId)?.abort();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}

/** 校验 Claude 图片附件的数量、格式、base64 内容和大小。 */
export function validateClaudeImages(images: ImageContent[]): string | null {
  if (images.length > 10) return "at most 10 images are allowed";
  for (const image of images) {
    if (!CLAUDE_IMAGE_TYPES[image.mimeType]) return `unsupported image type: ${image.mimeType}`;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return "image data must be valid base64";
    if (Buffer.byteLength(image.data, "base64") > 20 * 1024 * 1024) return "each image must be at most 20 MB";
  }
  return null;
}

/** 在真正启动 run 前重新探测 Claude CLI，避免使用过期可用性状态。 */
async function requireClaudeCode() {
  const executablePath = process.env.TRADEX_CLAUDE_PATH?.trim() || "claude";
  const availability = await detectClaudeCode(executablePath);
  if (!availability.available) {
    throw new ClaudeSessionStreamError(
      "runtime_unavailable",
      availability.error ?? "Claude Code runtime is unavailable",
    );
  }
  return availability;
}

class ClaudeSessionStreamError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClaudeSessionStreamError";
  }
}

/** 构建并过滤当前 Claude Session 可以调用的 Tradex MCP 只读 Tool。 */
async function buildClaudeTools(runtime: AppRuntime, sessionId: string) {
  const { tools } = await buildTradexToolRegistry(runtime, {
    sessionId,
    config: runtime.config.agent,
    includeMemory: false,
    includeExternalMcp: false,
    includeFilesystem: false,
  });
  return exposeClaudeReadTools(tools);
}

/** 组合 Tradex 主提示词、Agent instructions 和 Claude 能力边界。 */
function claudeInstructions(agentInstructions: string): string {
  const now = new Date();
  const sessionDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return [
    MAIN_AGENT_PROMPT,
    ...(agentInstructions.trim() && agentInstructions.trim() !== MAIN_AGENT_PROMPT.trim() ? [agentInstructions.trim()] : []),
    `Session date: ${sessionDate} (Asia/Shanghai).`,
    "You are running inside Tradex via Claude Code. Use the native Read tool for files in this Session and the explicitly allowed Tradex MCP read tools for market data.",
    "Do not place trades, modify files, use shell commands, access Memory, configure external MCP servers, or claim those capabilities are available.",
  ].join("\n\n");
}

/** 根据当前 API 请求地址生成 loopback MCP endpoint URL。 */
function claudeMcpUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const host = url.port ? `127.0.0.1:${url.port}` : "127.0.0.1";
  return `${url.protocol}//${host}/mcp/tradex`;
}

const CLAUDE_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 将图片保存到当前 Session 的隔离 attachments 目录并返回后端文件路径。 */
async function saveClaudeAttachments(runtime: AppRuntime, sessionId: string, images: ImageContent[]): Promise<string[]> {
  const directory = path.join(runtime.claudeSessions.sessionDir(sessionId), "attachments");
  return Promise.all(images.map(async (image) => {
    const file = path.join(directory, `${crypto.randomUUID()}.${CLAUDE_IMAGE_TYPES[image.mimeType]}`);
    await writeFile(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
    return file;
  }));
}

/** 把相对 Session cwd 的附件路径加入 prompt，供 Claude 使用原生 Read 读取。 */
export function promptWithAttachments(prompt: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) return prompt;
  return [
    prompt,
    "Attached images are available at these paths relative to the current working directory. Use the Read tool to inspect them:",
    ...attachmentPaths.map((file) => `- attachments/${path.basename(file)}`),
  ].filter(Boolean).join("\n\n");
}

/** 生成不包含原始路径的图片 metadata，供 UI 历史展示。 */
function attachmentMetadata(images: ImageContent[], attachmentPaths: string[]): Record<string, unknown> | null {
  if (attachmentPaths.length === 0) return null;
  return {
    images: images.map((image, index) => ({
      mimeType: image.mimeType,
      filename: path.basename(attachmentPaths[index]),
    })),
  };
}

/** 创建与现有聊天 UI 兼容的 Claude assistant message DTO。 */
function claudeMessageDto(sessionId: string, clientId: string): Record<string, unknown> {
  return {
    id: clientId,
    clientId,
    sessionId,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    metadata: { toolCalls: [] },
    error: null,
    entryId: null,
    parentId: null,
    entryType: "message",
  };
}

/** 汇总本轮 Claude 的输入、输出和缓存 token 数。 */
function totalUsage(usage: UsageProjection): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
