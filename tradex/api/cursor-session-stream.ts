/** 编排 Cursor Session 消息、Runtime 事件、持久化投影和 SSE 输出。 */
import type { ImageContent } from "@earendil-works/pi-ai";
import { CURSOR_CLI_INSTRUCTIONS, currentTimeInstruction, MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { detectCursorCli } from "../agent/runtime/cursor/discovery.js";
import { CursorCliRuntime, exposeCursorReadTools } from "../agent/runtime/cursor/runtime.js";
import type { ExternalSessionStorePort } from "../agent/runtime/external-session-store.js";
import { buildTradexToolRegistry } from "./agent_tools.js";
import {
  createExternalCliTurn,
  tradexCliUrl,
} from "./external-cli-turn.js";
import { validateImageInput } from "./image-input.js";
import type { AppRuntime } from "./runtime.js";
import { SessionRunError, streamSessionRun, type ProjectSessionUpdate } from "./session-stream.js";

export interface CursorSessionStreamInput<Session, History> {
  runtime: AppRuntime;
  requestUrl: string;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
  sessionStore?: ExternalSessionStorePort<"cursor">;
  workspace?: string;
  baseSystemPrompt?: string;
  appendSystemPrompt?: string;
  persistFailedTurn?: boolean;
  projectSessionUpdate?: ProjectSessionUpdate<Session, History>;
}

/** 校验 Session 后启动 Cursor CLI，并把运行事件映射为现有 SSE 协议。 */
export async function streamCursorSession<Session = Record<string, unknown>, History = Record<string, unknown>>(
  input: CursorSessionStreamInput<Session, History>,
): Promise<Response> {
  const { runtime, sessionId } = input;
  const sessionStore = input.sessionStore ?? runtime.cursorSessions;
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
    usage: "none",
    persistFailedTurn: input.persistFailedTurn,
    projectSessionUpdate: input.projectSessionUpdate,
    errorCode: (error) => error instanceof SessionRunError
      ? error.code
      : error instanceof CursorSessionStreamError ? error.code : null,
  });

  return streamSessionRun({
    runtime,
    sessionId,
    async prepare(signal) {
      signal.throwIfAborted();
      const availability = await requireCursorCli();
      signal.throwIfAborted();
      const tools = await buildCursorTools(runtime, sessionId);
      signal.throwIfAborted();
      const run = await turn.prepare(async ({ prompt, cwd, nativeSessionId }) => {
        return new CursorCliRuntime({
          executablePath: availability.executablePath,
          cliUrl: tradexCliUrl(input.requestUrl),
          grants: runtime.cliRunGrants,
        }).start({
          tradexSessionId: sessionId,
          cwd,
          prompt,
          instructions: cursorInstructions(
            metadata.snapshot.systemPrompt,
            input.baseSystemPrompt,
            input.appendSystemPrompt,
          ),
          registry: tools,
          nativeSessionId,
          model: metadata.snapshot.model,
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

function cursorInstructions(
  agentInstructions: string,
  baseSystemPrompt = MAIN_AGENT_PROMPT,
  appendSystemPrompt = "",
): string {
  return [
    baseSystemPrompt,
    ...(agentInstructions.trim() && agentInstructions.trim() !== baseSystemPrompt.trim() ? [agentInstructions.trim()] : []),
    appendSystemPrompt.trim(),
    CURSOR_CLI_INSTRUCTIONS,
    currentTimeInstruction("shell"),
    "Do not place trades, access Memory outside this workspace, configure additional tool servers, or claim those capabilities are available.",
  ].join("\n\n");
}

export function validateCursorImages(images: ImageContent[]): string | null {
  return validateImageInput(images);
}
