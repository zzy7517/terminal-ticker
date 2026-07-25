/** Origin lifecycle orchestration: ownership, runtime dispatch, and projection. */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { OriginRuntimeId } from "../origin/session-store.js";
import type { AgentSkillCatalog } from "../agent/skills.js";
import { agentConfigFromSnapshot } from "./helpers.js";
import { streamClaudeSession, validateClaudeImages } from "./claude-session-stream.js";
import { streamCursorSession, validateCursorImages } from "./cursor-session-stream.js";
import { streamPiSession } from "./pi-session-stream.js";
import type { AppRuntime } from "./runtime.js";

export type OriginLifecycleResult = "ok" | "not_found" | "not_running" | "running";

export async function createOriginSession(runtime: AppRuntime, input: Record<string, unknown>) {
  const selectedRuntime = runtimeValue(input.runtime);
  const provider = selectedRuntime === "pi" ? stringValue(input.provider) || runtime.config.agent.provider : null;
  const model = stringValue(input.model) || (selectedRuntime === "pi" ? runtime.config.agent.model : null);
  if (selectedRuntime === "pi") {
    const resolved = runtime.modelRuntimeSnapshot.resolveSelection({ provider: provider!, id: model! });
    if (!resolved.runnable) throw new Error("selected model is not runnable");
  }
  const reasoningEffort = selectedRuntime === "cursor" ? null : stringValue(input.reasoningEffort)
    || (provider ? runtime.config.agent.providerProfiles[provider]?.modelEfforts.find(([id]) => id === model)?.[1] : null)
    || (selectedRuntime === "pi" ? runtime.config.agent.reasoningEffort : null);
  const { id } = runtime.originSessions.create({
    title: stringValue(input.title),
    runtime: selectedRuntime,
    systemPrompt: stringValue(input.systemPrompt),
    provider,
    model,
    reasoningEffort,
    workspace: stringValue(input.workspace),
  });
  return {
    ...await runtime.originSessions.response(id),
    history: await runtime.originSessions.history(runtime.lockedAgentSessions),
  };
}

export async function deleteOriginSession(runtime: AppRuntime, id: string): Promise<OriginLifecycleResult> {
  if (!runtime.originSessions.owns(id)) return "not_found";
  if (runtime.lockedAgentSessions.has(id)) return "running";
  return await runtime.originSessions.remove(id) ? "ok" : "not_found";
}

export async function stopOriginSession(runtime: AppRuntime, id: string): Promise<OriginLifecycleResult> {
  if (!runtime.originSessions.owns(id)) return "not_found";
  const run = runtime.activeAgents.get(id);
  if (!run) return "not_running";
  await run.abort();
  return "ok";
}

export async function streamOriginSession(input: {
  runtime: AppRuntime;
  requestUrl: string;
  sessionId: string;
  message: string;
  images: ImageContent[];
  skillNames: string[];
}): Promise<Response> {
  const { runtime, sessionId, message } = input;
  const metadata = runtime.originSessions.getMetadata(sessionId);
  if (!metadata) return Response.json({ detail: "Origin not found" }, { status: 404 });
  const snapshot = metadata.snapshot;
  const skillInstructions = resolveOriginSkillInstructions(runtime.skillCatalog, input.skillNames);
  const baseSystemPrompt = [originSystemPrompt(), skillInstructions].filter(Boolean).join("\n\n");
  const projectSessionUpdate = async () => ({
    session: await runtime.originSessions.response(sessionId),
    history: await runtime.originSessions.history(runtime.lockedAgentSessions),
  });
  if (snapshot.runtime === "claude-code") {
    const imageError = validateClaudeImages(input.images);
    if (imageError) return Response.json({ detail: imageError }, { status: 400 });
    return streamClaudeSession({
      runtime, requestUrl: input.requestUrl, sessionId, message, requestImages: input.images,
      sessionStore: runtime.originSessions.claudeSessions,
      workspace: metadata.workspace,
      baseSystemPrompt,
      projectSessionUpdate,
    });
  }
  if (snapshot.runtime === "cursor") {
    const imageError = validateCursorImages(input.images);
    if (imageError) return Response.json({ detail: imageError }, { status: 400 });
    return streamCursorSession({
      runtime, requestUrl: input.requestUrl, sessionId, message, requestImages: input.images,
      sessionStore: runtime.originSessions.cursorSessions,
      workspace: metadata.workspace,
      baseSystemPrompt,
      projectSessionUpdate,
    });
  }
  const manager = await runtime.originSessions.openPi(sessionId);
  if (!manager) return Response.json({ detail: "Origin transcript not found" }, { status: 404 });
  const requestConfig = agentConfigFromSnapshot(runtime.config.agent, snapshot);
  requestConfig.reasoningEffort = manager.buildSessionContext().thinkingLevel
    || snapshot.reasoningEffort
    || requestConfig.reasoningEffort;
  return streamPiSession({
    runtime, sessionId, message, requestImages: input.images, manager,
    snapshot: { systemPrompt: [baseSystemPrompt, snapshot.systemPrompt.trim()].filter(Boolean).join("\n\n") },
    requestConfig,
    projectSessionUpdate,
    cleanup: () => runtime.originSessions.release(manager),
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
  return value === "claude-code" || value === "cursor" ? value : "pi";
}

function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function originSystemPrompt(): string {
  return [
    "You are a capable assistant running in an Origin: an identity-free, user-created Agent Session.",
    "Respond directly to the user. Do not claim a persistent Agent identity, Direct Message, Channel membership, inbox, or proactive background role.",
    "Use the tools available in this Session when they materially help complete the request. Follow the user's request and do not take consequential actions without clear authorization.",
  ].join("\n\n");
}
