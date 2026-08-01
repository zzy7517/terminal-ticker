/** Origin lifecycle orchestration: ownership, runtime dispatch, and projection. */
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  OriginMaterializationConflictError,
  type CreateOriginInput,
  type OriginRuntimeId,
} from "../origin/session-store.js";
import type { AgentSkillCatalog } from "../agent/skills.js";
import { purgeClaudeProject } from "../agent/runtime/claude-code/runtime.js";
import { fromPiProviderId } from "../agent/runtime/pi/models/constants.js";
import { agentConfigFromSnapshot } from "./helpers.js";
import { streamExternalCliSession } from "./external-cli-session-stream.js";
import { streamPiSession } from "./pi-session-stream.js";
import { validateImageInput } from "./image-input.js";
import type { AppRuntime } from "./runtime.js";
import { abortSessionRun, withSessionRunReservation } from "./session-stream.js";

export type OriginLifecycleResult = "ok" | "not_found" | "not_running" | "running";
export type OriginDeleteResult = "ok" | "ok_cursor_native_retained" | "not_found" | "running";

export async function startOriginSession(input: {
  runtime: AppRuntime;
  requestUrl: string;
  materializationId: string;
  config: Record<string, unknown>;
  message: string;
  images: ImageContent[];
  skillNames: string[];
}): Promise<Response> {
  const { runtime, materializationId } = input;
  const existing = runtime.originSessions.sessionIdForMaterialization(materializationId);
  if (existing) throw new OriginMaterializationConflictError(existing);

  const createInput = resolveOriginConfig(runtime, input.config);
  const imageError = validateOriginImages(runtime, createInput, input.images);
  if (imageError) throw new Error(imageError);
  const skillInstructions = resolveOriginSkillInstructions(runtime.skillCatalog, input.skillNames);
  const { id } = runtime.originSessions.create({
    ...createInput,
    materializationId,
    systemPrompt: runtime.config.agent.systemPrompt,
  });
  try {
    const response = await streamOriginSession({
      runtime,
      requestUrl: input.requestUrl,
      sessionId: id,
      message: input.message,
      images: input.images,
      skillNames: input.skillNames,
      skillInstructions,
    });
    if (!response.ok) {
      await runtime.originSessions.remove(id);
      return response;
    }
    response.headers.set("X-Origin-Session-Id", id);
    return response;
  } catch (error) {
    await runtime.originSessions.remove(id);
    throw error;
  }
}

function resolveOriginConfig(runtime: AppRuntime, input: Record<string, unknown>): CreateOriginInput {
  const selectedRuntime = runtimeValue(input.runtime);
  let provider = selectedRuntime === "pi" ? stringValue(input.provider) || runtime.config.agent.provider : null;
  const model = stringValue(input.model) || (selectedRuntime === "pi" ? runtime.config.agent.model : null);
  if (selectedRuntime === "pi") {
    const resolved = runtime.modelRuntimeSnapshot.resolveSelection({ provider: provider!, id: model! });
    if (!resolved.runnable) throw new Error("selected model is not runnable");
    provider = fromPiProviderId(resolved.providerId || provider!);
  }
  const reasoningEffort = selectedRuntime === "cursor" ? null : stringValue(input.reasoningEffort)
    || (provider ? runtime.config.agent.providerProfiles[provider]?.modelEfforts.find(([id]) => id === model)?.[1] : null)
    || (selectedRuntime === "pi" ? runtime.config.agent.reasoningEffort : null);
  return {
    runtime: selectedRuntime,
    provider,
    model,
    reasoningEffort,
  };
}

export async function deleteOriginSession(runtime: AppRuntime, id: string): Promise<OriginDeleteResult> {
  if (runtime.lockedAgentSessions.has(id)) return "running";
  runtime.lockedAgentSessions.add(id);
  try {
    const target = runtime.originSessions.deletionTarget(id);
    if (!target) return "not_found";
    if (target.runtime === "claude-code" && target.ownsWorkspace) {
      await purgeClaudeProject(
        process.env.TRADEX_CLAUDE_PATH?.trim() || "claude",
        target.workspace,
      );
    }
    const removed = await runtime.originSessions.remove(id);
    if (!removed) return "not_found";

    // Cursor Agent has no native chat deletion command. The owned Tradex
    // projection and workspace are gone, but callers must not infer that the
    // Cursor service-side chat was deleted too.
    return target.runtime === "cursor" ? "ok_cursor_native_retained" : "ok";
  } finally {
    runtime.lockedAgentSessions.delete(id);
  }
}

export async function stopOriginSession(runtime: AppRuntime, id: string): Promise<OriginLifecycleResult> {
  if (!runtime.originSessions.owns(id)) return "not_found";
  if (!await abortSessionRun(runtime, id)) return "not_running";
  return "ok";
}

export async function streamOriginSession(input: {
  runtime: AppRuntime;
  requestUrl: string;
  sessionId: string;
  message: string;
  images: ImageContent[];
  skillNames: string[];
  skillInstructions?: string;
}): Promise<Response> {
  const { runtime, sessionId, message } = input;
  const metadata = runtime.originSessions.getMetadata(sessionId);
  if (!metadata) return Response.json({ detail: "Origin not found" }, { status: 404 });
  const imageError = validateOriginImages(runtime, metadata.snapshot, input.images);
  if (imageError) return Response.json({ detail: imageError }, { status: 400 });
  const snapshot = metadata.snapshot;
  const skillInstructions = input.skillInstructions
    ?? resolveOriginSkillInstructions(runtime.skillCatalog, input.skillNames);
  const configuredSystemPrompt = snapshot.systemPrompt.trim();
  const additionalSystemPrompt = [originSystemPrompt(), skillInstructions].filter(Boolean).join("\n\n");
  const projectSessionUpdate = async () => ({
    session: await runtime.originSessions.response(sessionId),
    history: await runtime.originSessions.history(runtime.lockedAgentSessions),
  });
  if (snapshot.runtime === "claude-code" || snapshot.runtime === "cursor") {
    return streamExternalCliSession(snapshot.runtime, {
      runtime, requestUrl: input.requestUrl, sessionId, message, requestImages: input.images,
      sessionStore: snapshot.runtime === "claude-code"
        ? runtime.originSessions.claudeSessions
        : runtime.originSessions.cursorSessions,
      workspace: metadata.workspace,
      baseSystemPrompt: configuredSystemPrompt,
      appendSystemPrompt: additionalSystemPrompt,
      preserveNativeSystemPrompt: !configuredSystemPrompt,
      persistFailedTurn: true,
      projectSessionUpdate,
    });
  }
  return withSessionRunReservation({
    runtime,
    sessionId,
    async prepare(reservation) {
      const manager = await runtime.originSessions.openPi(sessionId);
      if (!manager) return Response.json({ detail: "Origin transcript not found" }, { status: 404 });
      const requestConfig = agentConfigFromSnapshot(runtime.config.agent, snapshot);
      requestConfig.reasoningEffort = manager.buildSessionContext().thinkingLevel
        || snapshot.reasoningEffort
        || requestConfig.reasoningEffort;
      return streamPiSession({
        runtime, sessionId, message, requestImages: input.images, manager,
        workspace: metadata.workspace,
        reservation,
        snapshot: { systemPrompt: configuredSystemPrompt },
        additionalSystemPrompt,
        preserveDefaultSystemPrompt: !configuredSystemPrompt,
        persistFailedTurn: true,
        requestConfig,
        projectSessionUpdate,
        cleanup: () => runtime.originSessions.release(manager),
      });
    },
  });
}

export function resolveOriginSkillInstructions(
  catalog: Pick<AgentSkillCatalog, "resolve">,
  skillNames: string[],
): string {
  const resolved = catalog.resolve(skillNames);
  for (const warning of resolved.warnings) console.warn(`[skills] ${warning}`);
  return resolved.instructions;
}

function runtimeValue(value: unknown): OriginRuntimeId {
  if (value === undefined || value === null || value === "" || value === "pi") return "pi";
  if (value === "claude-code" || value === "cursor") return value;
  throw new Error("unsupported Origin runtime");
}

function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

export function validateOriginImages(
  runtime: AppRuntime,
  snapshot: Pick<CreateOriginInput, "runtime" | "provider" | "model">,
  images: ImageContent[],
): string | null {
  const inputError = validateImageInput(images);
  if (inputError) return inputError;
  if (images.length === 0) return null;
  if (snapshot.runtime !== "pi") return null;
  const model = runtime.modelRuntimeSnapshot.resolveSelection({
    provider: snapshot.provider ?? "",
    id: snapshot.model ?? "",
  });
  return Array.isArray(model.input) && !model.input.includes("image")
    ? "selected model does not support image input"
    : null;
}

function originSystemPrompt(): string {
  return [
    "You are a capable assistant running in an Origin Session: an identity-free, user-created Runtime conversation.",
    "Respond directly to the user. Do not claim a persistent Agent identity, Direct Message, Channel membership, inbox, or proactive background role.",
    "Use the tools available in this Session when they materially help complete the request. Follow the user's request and do not take consequential actions without clear authorization.",
  ].join("\n\n");
}
