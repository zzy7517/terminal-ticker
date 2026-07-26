/** Shared turn lifecycle for Claude Code and Cursor CLI Session adapters. */
import crypto from "node:crypto";
import path from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExternalSessionStorePort } from "../agent/runtime/external-session-store.js";
import type {
  ActiveRuntimeRun,
  ExternalAgentRuntimeId,
  RuntimeEvent,
  RuntimeRunResult,
} from "../agent/runtime/types.js";
import { sessionHistory, sessionResponse } from "./helpers.js";
import type { AppRuntime } from "./runtime.js";
import { IMAGE_FILE_EXTENSIONS } from "./image-input.js";
import {
  sendSessionUpdate,
  type ProjectSessionUpdate,
  type SessionStreamSend,
} from "./session-stream.js";

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

export interface ExternalCliStartContext {
  prompt: string;
  cwd: string;
  nativeSessionId?: string;
}

export interface ExternalCliTurn<Session, History> {
  prepare(start: (context: ExternalCliStartContext) => Promise<ActiveRuntimeRun>): Promise<ActiveRuntimeRun>;
  onEvent(event: RuntimeEvent, send: SessionStreamSend): void;
  complete(result: RuntimeRunResult, send: SessionStreamSend): Promise<void>;
  fail(error: unknown, send: SessionStreamSend): Promise<void>;
  onPrepareFailure(error: unknown, send: SessionStreamSend): Promise<void>;
}

export function createExternalCliTurn<
  Runtime extends ExternalAgentRuntimeId,
  Session = Record<string, unknown>,
  History = Record<string, unknown>,
>(input: {
  runtime: AppRuntime;
  sessionId: string;
  message: string;
  requestImages: ImageContent[];
  sessionStore: ExternalSessionStorePort<Runtime>;
  workspace?: string;
  model: string | null;
  usage: "reported" | "none";
  persistFailedTurn?: boolean;
  projectSessionUpdate?: ProjectSessionUpdate<Session, History>;
  errorCode(error: unknown): string | null;
}): ExternalCliTurn<Session, History> {
  const { runtime, sessionId, requestImages, sessionStore } = input;
  const assistantClientId = `assistant:${crypto.randomUUID()}`;
  const toolCalls = new Map<string, ToolCallProjection>();
  const usage: UsageProjection = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let attachmentPaths: string[] = [];
  let assistantStarted = false;
  let assistantText = "";
  let assistantPersisted = false;
  let userPersisted = false;
  let persistedRunStatus: "completed" | "error" | "cancelled" | null = null;
  let projectionAttempted = false;
  let model = input.model;

  return { prepare, onEvent, complete, fail, onPrepareFailure };

  async function prepare(
    start: (context: ExternalCliStartContext) => Promise<ActiveRuntimeRun>,
  ): Promise<ActiveRuntimeRun> {
    attachmentPaths = await saveExternalAttachments(sessionStore, sessionId, requestImages);
    let run: ActiveRuntimeRun | undefined;
    try {
      run = await start({
        prompt: promptWithAttachments(input.message, attachmentPaths, Boolean(input.workspace)),
        cwd: input.workspace ?? sessionStore.sessionDir(sessionId),
        nativeSessionId: sessionStore.getMetadata(sessionId)?.nativeSessionId ?? undefined,
      });
      sessionStore.beginRun(sessionId);
      sessionStore.appendMessage(sessionId, {
        role: "user",
        content: input.message,
        metadata: attachmentMetadata(requestImages, attachmentPaths),
      });
      userPersisted = true;
      if (run.nativeSessionId) sessionStore.setNativeSessionId(sessionId, run.nativeSessionId);
      return run;
    } catch (error) {
      await run?.abort();
      await run?.result;
      endRun("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  function onEvent(event: RuntimeEvent, send: SessionStreamSend): void {
    if (event.type === "run-start" && event.nativeSessionId) {
      sessionStore.setNativeSessionId(sessionId, event.nativeSessionId);
      return;
    }
    if (event.type === "message-update" && event.message.role === "assistant") {
      if (!assistantStarted) {
        assistantStarted = true;
        send({ type: "message_start", message: externalMessageDto(sessionId, assistantClientId) });
      }
      assistantText += event.delta;
      send({
        type: "message_update",
        message: { clientId: assistantClientId, role: "assistant", content: "", metadata: null, error: null },
        delta: event.delta,
      });
      return;
    }
    if (event.type === "tool-start") {
      const toolCall = { id: event.callId, name: event.name, arguments: event.args };
      toolCalls.set(event.callId, toolCall);
      send({ type: "tool_execution_start", toolCall });
      return;
    }
    if (event.type === "tool-result") {
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
      return;
    }
    if (event.type === "usage" && input.usage === "reported") {
      model = event.model;
      usage.input += event.input;
      usage.output += event.output;
      usage.cacheRead += event.cacheRead;
      usage.cacheWrite += event.cacheWrite;
    }
  }

  async function complete(result: RuntimeRunResult, send: SessionStreamSend): Promise<void> {
    const runError = result.error;
    const runErrorCode = result.errorCode ?? null;
    if (!assistantText && result.output) assistantText = result.output;
    endRun(runErrorCode === "aborted" ? "cancelled" : runError ? "error" : "completed", runError);
    if (result.nativeSessionId) sessionStore.setNativeSessionId(sessionId, result.nativeSessionId);

    const totalTokens = input.usage === "reported" ? totalUsage(usage) : 0;
    const persisted = sessionStore.appendMessage(sessionId, {
      role: "assistant",
      content: assistantText,
      error: runError,
      metadata: {
        errorCode: runErrorCode,
        model,
        ...(input.usage === "reported" ? {
          promptTokens: usage.input,
          completionTokens: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          totalTokens,
        } : {}),
        toolCalls: [...toolCalls.values()],
      },
    });
    assistantPersisted = true;
    sendAssistantIfNeeded(send);
    send({ type: "message_end", message: { ...persisted, id: assistantClientId, clientId: assistantClientId } });
    await projectSession(send);
    send({
      type: "agent_end",
      error: runError,
      errorCode: runErrorCode,
      totalTokens,
      promptTokens: input.usage === "reported" ? usage.input : 0,
      sessionStats: input.usage === "reported" ? { tokens: { ...usage, total: totalTokens } } : null,
    });
  }

  async function fail(error: unknown, send: SessionStreamSend): Promise<void> {
    await persistFailure(error, send, false);
  }

  async function onPrepareFailure(error: unknown, send: SessionStreamSend): Promise<void> {
    await persistFailure(error, send, true);
  }

  async function persistFailure(error: unknown, send: SessionStreamSend, includeUser: boolean): Promise<void> {
    const runError = error instanceof Error ? error.message : String(error);
    const runErrorCode = input.errorCode(error) ?? "runtime_failure";
    if (includeUser && !userPersisted) {
      sessionStore.appendMessage(sessionId, {
        role: "user",
        content: input.message,
        metadata: attachmentMetadata(requestImages, attachmentPaths),
      });
      userPersisted = true;
    }
    endRun("error", runError);
    if (!assistantPersisted) {
      sessionStore.appendMessage(sessionId, {
        role: "assistant",
        content: assistantText,
        error: runError,
        metadata: { errorCode: runErrorCode, toolCalls: [...toolCalls.values()] },
      });
      assistantPersisted = true;
    }
    if (input.persistFailedTurn && input.projectSessionUpdate && !projectionAttempted) {
      await projectSession(send);
    }
    send({ type: "error", code: runErrorCode, error: runError });
    send({
      type: "agent_end",
      error: runError,
      errorCode: runErrorCode,
      totalTokens: 0,
      promptTokens: 0,
      sessionStats: null,
    });
  }

  function endRun(status: "completed" | "error" | "cancelled", error: string | null): void {
    if (persistedRunStatus === "error") return;
    if (persistedRunStatus !== null && status !== "error") return;
    sessionStore.endRun(sessionId, { status, error });
    persistedRunStatus = status;
  }

  function sendAssistantIfNeeded(send: SessionStreamSend): void {
    if (assistantStarted) return;
    assistantStarted = true;
    send({ type: "message_start", message: externalMessageDto(sessionId, assistantClientId) });
    if (assistantText) {
      send({
        type: "message_update",
        message: { clientId: assistantClientId, role: "assistant", content: "", metadata: null, error: null },
        delta: assistantText,
      });
    }
  }

  async function projectSession(send: SessionStreamSend): Promise<void> {
    projectionAttempted = true;
    await sendSessionUpdate({
      send,
      project: input.projectSessionUpdate,
      defaultProject: async () => ({
        session: await sessionResponse(runtime, sessionId),
        history: await sessionHistory(runtime),
      }),
      state: () => runtime.state(),
    });
  }
}

async function saveExternalAttachments<Runtime extends ExternalAgentRuntimeId>(
  sessionStore: ExternalSessionStorePort<Runtime>,
  sessionId: string,
  images: ImageContent[],
): Promise<string[]> {
  return images.map((image) => sessionStore.writeAttachment(
    sessionId,
    IMAGE_FILE_EXTENSIONS[image.mimeType] ?? "bin",
    Buffer.from(image.data, "base64"),
  ));
}

export function promptWithAttachments(prompt: string, attachmentPaths: string[], absolutePaths = false): string {
  if (attachmentPaths.length === 0) return prompt;
  return [
    prompt,
    absolutePaths
      ? "Attached images are available at these absolute paths. Use the Read tool to inspect them:"
      : "Attached images are available at these paths relative to the current working directory. Use the Read tool to inspect them:",
    ...attachmentPaths.map((file) => `- ${absolutePaths ? file : `attachments/${path.basename(file)}`}`),
  ].filter(Boolean).join("\n\n");
}

export function tradexCliUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const host = url.port ? `127.0.0.1:${url.port}` : "127.0.0.1";
  return `${url.protocol}//${host}/cli/tradex`;
}

function attachmentMetadata(images: ImageContent[], attachmentPaths: string[]): Record<string, unknown> | null {
  if (images.length === 0) return null;
  return {
    images: images.map((image, index) => ({
      mimeType: image.mimeType,
      ...(attachmentPaths[index]
        ? { filename: path.basename(attachmentPaths[index]) }
        : { data: image.data }),
    })),
  };
}

function externalMessageDto(sessionId: string, clientId: string): Record<string, unknown> {
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

function totalUsage(usage: UsageProjection): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
