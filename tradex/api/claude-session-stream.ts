/** 编排 Claude Session 消息、Runtime 事件、持久化投影和 SSE 输出。 */
import type { ImageContent } from "@earendil-works/pi-ai";
import { CLAUDE_CLI_INSTRUCTIONS, currentTimeInstruction, MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { detectClaudeCode } from "../agent/runtime/claude-code/discovery.js";
import { ClaudeCodeRuntime, exposeClaudeReadTools } from "../agent/runtime/claude-code/runtime.js";
import type { ExternalSessionStorePort } from "../agent/runtime/external-session-store.js";
import { buildTradexToolRegistry } from "./agent_tools.js";
import {
  createExternalCliTurn,
  tradexCliUrl,
} from "./external-cli-turn.js";
import { validateImageInput } from "./image-input.js";
import type { AppRuntime } from "./runtime.js";
import { SessionRunError, streamSessionRun, type ProjectSessionUpdate } from "./session-stream.js";

export interface ClaudeSessionStreamInput<Session, History> {
  runtime: AppRuntime;
  requestUrl: string;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
  sessionStore?: ExternalSessionStorePort<"claude-code">;
  workspace?: string;
  baseSystemPrompt?: string;
  appendSystemPrompt?: string;
  preserveNativeSystemPrompt?: boolean;
  persistFailedTurn?: boolean;
  projectSessionUpdate?: ProjectSessionUpdate<Session, History>;
}

/** 校验 Session 后启动 Claude，并把运行事件映射为现有 SSE 协议。 */
export async function streamClaudeSession<Session = Record<string, unknown>, History = Record<string, unknown>>(
  input: ClaudeSessionStreamInput<Session, History>,
): Promise<Response> {
  const { runtime, sessionId } = input;
  const sessionStore = input.sessionStore ?? runtime.claudeSessions;
  const metadata = sessionStore.getMetadata(sessionId);
  if (!metadata) return Response.json({ detail: "agent session not found" }, { status: 404 });
  const turn = createExternalCliTurn({
    runtime,
    sessionId,
    message: input.message,
    requestImages: input.requestImages,
    sessionStore,
    workspace: input.workspace,
    model: metadata.snapshot.model,
    usage: "reported",
    persistFailedTurn: input.persistFailedTurn,
    projectSessionUpdate: input.projectSessionUpdate,
    errorCode: (error) => error instanceof SessionRunError
      ? error.code
      : error instanceof ClaudeSessionStreamError ? error.code : null,
  });

  return streamSessionRun({
    runtime,
    sessionId,
    // 准备附件、Claude CLI、Tool 注册表和本轮 Runtime 句柄。
    async prepare(signal) {
      signal.throwIfAborted();
      const availability = await requireClaudeCode();
      signal.throwIfAborted();
      const tools = await buildClaudeTools(runtime, sessionId);
      signal.throwIfAborted();
      const run = await turn.prepare(async ({ prompt, cwd, nativeSessionId }) => {
        return new ClaudeCodeRuntime({
          executablePath: availability.executablePath,
          cliUrl: tradexCliUrl(input.requestUrl),
          grants: runtime.cliRunGrants,
        }).start({
          tradexSessionId: sessionId,
          cwd,
          prompt,
          instructions: claudeInstructions(
            metadata.snapshot.systemPrompt,
            input.baseSystemPrompt,
            input.appendSystemPrompt,
          ),
          preserveNativeSystemPrompt: input.preserveNativeSystemPrompt,
          registry: tools,
          nativeSessionId,
          model: metadata.snapshot.model,
          effort: metadata.snapshot.reasoningEffort,
        });
      });
      return {
        run,
        onEvent: turn.onEvent,
        complete: turn.complete,
        fail: turn.fail,
      };
    },
    onPrepareFailure: input.persistFailedTurn
      ? turn.onPrepareFailure
      : undefined,
  });
}

/** 校验 Claude 图片附件的数量、格式、base64 内容和大小。 */
export function validateClaudeImages(images: ImageContent[]): string | null {
  return validateImageInput(images);
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

/** 构建并过滤当前 Claude Session 可以调用的 Tradex CLI 只读 Tool。 */
async function buildClaudeTools(runtime: AppRuntime, sessionId: string) {
  const { tools } = await buildTradexToolRegistry(runtime, {
    sessionId,
    config: runtime.config.agent,
    includeExternalMcp: false,
    includeFilesystem: false,
  });
  return exposeClaudeReadTools(tools);
}

/** 组合 Tradex 主提示词、Agent instructions 和 Claude 能力边界。 */
function claudeInstructions(
  agentInstructions: string,
  baseSystemPrompt = MAIN_AGENT_PROMPT,
  appendSystemPrompt = "",
): string {
  return [
    baseSystemPrompt,
    ...(agentInstructions.trim() && agentInstructions.trim() !== baseSystemPrompt.trim() ? [agentInstructions.trim()] : []),
    appendSystemPrompt.trim(),
    CLAUDE_CLI_INSTRUCTIONS,
    currentTimeInstruction("Bash"),
    "Do not place trades, modify files, configure additional tool servers, or claim those capabilities are available.",
  ].join("\n\n");
}
