/**
 * 编排外接 CLI（Claude / Cursor）Session 消息、Runtime 事件、持久化投影和 SSE 输出。
 * Runtime 差异（usage 上报、effort、guardrail 文案）全部由 external-cli-registry 提供。
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import { currentTimeInstruction, MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import {
  EXTERNAL_CLI_RUNTIMES,
  type ExternalCliRuntimeDescriptor,
  type ExternalCliRuntimeId,
} from "../agent/runtime/external-cli-registry.js";
import type { ExternalSessionStorePort } from "../agent/runtime/external-session-store.js";
import { buildTradexToolRegistry } from "./agent-tools.js";
import { createExternalCliTurn, tradexCliUrl } from "./external-cli-turn.js";
import { validateImageInput } from "./image-input.js";
import type { AppRuntime } from "./runtime.js";
import { SessionRunError, streamSessionRun, type ProjectSessionUpdate } from "./session-stream.js";

export interface ExternalCliSessionStreamInput<Session, History> {
  runtime: AppRuntime;
  requestUrl: string;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
  sessionStore?: ExternalSessionStorePort<ExternalCliRuntimeId>;
  workspace?: string;
  baseSystemPrompt?: string;
  appendSystemPrompt?: string;
  /** 仅 Claude 支持；Cursor descriptor 会丢弃。 */
  preserveNativeSystemPrompt?: boolean;
  persistFailedTurn?: boolean;
  projectSessionUpdate?: ProjectSessionUpdate<Session, History>;
}

/** 校验 Session 后启动外接 CLI，并把运行事件映射为现有 SSE 协议。 */
export async function streamExternalCliSession<Session = Record<string, unknown>, History = Record<string, unknown>>(
  runtimeId: ExternalCliRuntimeId,
  input: ExternalCliSessionStreamInput<Session, History>,
): Promise<Response> {
  const { runtime, sessionId } = input;
  const descriptor = EXTERNAL_CLI_RUNTIMES[runtimeId];
  const sessionStore = input.sessionStore
    ?? (runtimeId === "claude-code" ? runtime.claudeSessions : runtime.cursorSessions);
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
    usage: descriptor.usageReporting,
    persistFailedTurn: input.persistFailedTurn,
    projectSessionUpdate: input.projectSessionUpdate,
    errorCode: (error) => error instanceof SessionRunError
      ? error.code
      : error instanceof ExternalCliSessionStreamError ? error.code : null,
  });

  return streamSessionRun({
    runtime,
    sessionId,
    // 准备附件、CLI、Tool 注册表和本轮 Runtime 句柄。
    async prepare(signal) {
      signal.throwIfAborted();
      const availability = await requireExternalCli(descriptor);
      signal.throwIfAborted();
      const tools = await buildSessionTools(runtime, sessionId, descriptor);
      signal.throwIfAborted();
      const run = await turn.prepare(async ({ prompt, cwd, nativeSessionId }) => {
        return descriptor.start({
          executablePath: availability.executablePath,
          cliUrl: tradexCliUrl(input.requestUrl),
          grants: runtime.cliRunGrants,
        }, {
          tradexSessionId: sessionId,
          cwd,
          prompt,
          instructions: sessionInstructions(
            descriptor,
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

/** 校验外接 CLI 图片附件的数量、格式、base64 内容和大小。 */
export function validateExternalCliImages(images: ImageContent[]): string | null {
  return validateImageInput(images);
}

/** 在真正启动 run 前重新探测 CLI，避免使用过期可用性状态。 */
async function requireExternalCli(descriptor: ExternalCliRuntimeDescriptor) {
  const availability = await descriptor.detect();
  if (!availability.available) {
    throw new ExternalCliSessionStreamError(
      "runtime_unavailable",
      availability.error ?? `${descriptor.label} runtime is unavailable`,
    );
  }
  return availability;
}

class ExternalCliSessionStreamError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ExternalCliSessionStreamError";
  }
}

/** 构建并过滤当前 Session 可以调用的 Tradex CLI 只读 Tool。 */
async function buildSessionTools(
  runtime: AppRuntime,
  sessionId: string,
  descriptor: ExternalCliRuntimeDescriptor,
) {
  const { tools } = await buildTradexToolRegistry(runtime, {
    sessionId,
    config: runtime.config.agent,
    includeExternalMcp: false,
    includeFilesystem: false,
  });
  return descriptor.exposeReadTools(tools);
}

/** 组合 Tradex 主提示词、Agent instructions 和该 Runtime 的能力边界。 */
function sessionInstructions(
  descriptor: ExternalCliRuntimeDescriptor,
  agentInstructions: string,
  baseSystemPrompt = MAIN_AGENT_PROMPT,
  appendSystemPrompt = "",
): string {
  return [
    baseSystemPrompt,
    ...(agentInstructions.trim() && agentInstructions.trim() !== baseSystemPrompt.trim() ? [agentInstructions.trim()] : []),
    appendSystemPrompt.trim(),
    descriptor.cliInstructions,
    currentTimeInstruction(descriptor.timeToolName),
    descriptor.sessionGuardrail,
  ].join("\n\n");
}
