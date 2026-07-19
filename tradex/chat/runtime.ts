import type { AppRuntime } from "../api/runtime.js";
import type { InboxItem } from "./inbox-store.js";
import { buildWakePrompt, MESSAGE_OPERATING_INSTRUCTIONS } from "./prompts.js";
import { createMessageToolRegistry } from "./message-tools.js";
import { PiSdkRuntime } from "../agent/runtime/pi/runtime.js";
import { ClaudeCodeRuntime } from "../agent/runtime/claude-code/runtime.js";
import { detectClaudeCode } from "../agent/runtime/claude-code/discovery.js";
import { currentTimeInstruction, MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { agentConfigForRequest, openSessionManager } from "../api/helpers.js";
import {
  AGENT_SNAPSHOT_ENTRY,
  appendAgentSnapshot,
  createPiSession,
  piProviderName,
  readAgentSnapshot,
} from "../agent/runtime/pi/sessions.js";
import { buildTradexToolRegistry } from "../api/agent_tools.js";
import { ensurePrivateWorkspace } from "../agent/private-workspace.js";

/**
 * Starts one Agent activation for pending inbox items using the existing Runtime seam.
 * Wake prompt is content-free; Agent must call Message Tools to read bodies.
 */
export async function startMessageActivation(
  runtime: AppRuntime,
  agentId: string,
  pending: InboxItem[],
): Promise<void> {
  const agent = runtime.agentStore.get(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const workspace = ensurePrivateWorkspace(agentId);
  runtime.agentContextManager.updateStatus(agentId, {
    workspacePath: workspace.workspacePath,
    memoryScope: workspace.memoryPath,
  });

  const context = runtime.agentContextManager.ensure(agentId);
  let sessionId = context.activeSessionId;
  if (!sessionId) {
    sessionId = await ensureActivationSession(runtime, agentId);
  }
  if (runtime.lockedAgentSessions.has(sessionId)) {
    throw new Error("agent session already active");
  }

  const wake = buildWakePrompt(pending);
  const prompt = [MESSAGE_OPERATING_INSTRUCTIONS, "", wake].join("\n");
  const messageTools = createMessageToolRegistry(runtime, agentId);
  runtime.lockedAgentSessions.add(sessionId);

  try {
    if (agent.runtime === "claude-code") {
      const availability = await detectClaudeCode();
      if (!availability.available || !availability.executablePath) {
        throw new Error(availability.error || "Claude Code runtime unavailable");
      }
      const tools = await buildTradexToolRegistry(runtime, {
        sessionId,
        config: runtime.config.agent,
        includeExternalMcp: true,
        includeFilesystem: true,
        additionalRegistries: [messageTools],
        agentId,
      }).then((result) => result.tools);
      const instructions = [
        agent.systemPrompt?.trim() || runtime.config.agent.systemPrompt.trim() || MAIN_AGENT_PROMPT,
        currentTimeInstruction("run_command"),
        MESSAGE_OPERATING_INSTRUCTIONS,
        `Private workspace: ${workspace.workspacePath}`,
        `Private memory: ${workspace.memoryPath}`,
      ].filter(Boolean).join("\n\n");
      const run = await new ClaudeCodeRuntime({
        executablePath: availability.executablePath,
        mcpUrl: "http://127.0.0.1:8765/mcp",
        grants: runtime.mcpRunGrants,
      }).start({
        tradexSessionId: sessionId,
        cwd: runtime.claudeSessions.sessionDir(sessionId),
        prompt,
        instructions,
        registry: tools,
        nativeSessionId: runtime.claudeSessions.getMetadata(sessionId)?.nativeSessionId ?? undefined,
        model: agent.model,
        effort: agent.reasoningEffort,
      });
      runtime.activeAgents.set(sessionId, run);
      const result = await run.result;
      if (result.error) throw new Error(result.error);
      return;
    }

    const mgr = await openSessionManager(sessionId, runtime);
    if (!mgr) throw new Error(`activation session not found: ${sessionId}`);
    let snapshot = readAgentSnapshot(mgr);
    const hasSnapshot = mgr.getEntries().some((entry) => entry.type === "custom" && entry.customType === AGENT_SNAPSHOT_ENTRY);
    if (!hasSnapshot) {
      snapshot = {
        agentId: agent.id,
        agentName: agent.name,
        runtime: "pi",
        systemPrompt: agent.systemPrompt?.trim() || runtime.config.agent.systemPrompt.trim() || MAIN_AGENT_PROMPT,
        provider: agent.provider || runtime.config.agent.provider,
        model: agent.model || runtime.config.agent.model,
        reasoningEffort: agent.reasoningEffort || runtime.config.agent.reasoningEffort,
      };
      appendAgentSnapshot(mgr, snapshot);
    }
    const requestConfig = agentConfigForRequest(runtime.config.agent, {
      provider: snapshot.provider,
      model: snapshot.model,
    });
    const { tools } = await buildTradexToolRegistry(runtime, {
      sessionId,
      config: requestConfig,
      includeExternalMcp: true,
      includeFilesystem: true,
      additionalRegistries: [messageTools],
      agentId,
    });
    const systemPrompt = [
      snapshot.systemPrompt.trim() || MAIN_AGENT_PROMPT,
      currentTimeInstruction("run_command"),
      `Private workspace: ${workspace.workspacePath}`,
      `Private memory: ${workspace.memoryPath}`,
    ].filter(Boolean).join("\n\n");
    const run = await new PiSdkRuntime().start({
      config: requestConfig,
      modelRuntime: runtime.modelRuntimeSnapshot,
      systemPrompt,
      tools,
      sessionManager: mgr,
      compaction: true,
      prompt,
    });
    runtime.activeAgents.set(sessionId, run);
    const result = await run.result;
    if (result.error) throw new Error(result.error);
  } finally {
    runtime.activeAgents.delete(sessionId);
    runtime.lockedAgentSessions.delete(sessionId);
  }
}

async function ensureActivationSession(runtime: AppRuntime, agentId: string): Promise<string> {
  const agent = runtime.agentStore.get(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (agent.runtime === "claude-code") {
    const metadata = runtime.claudeSessions.create({
      title: `Activation ${agentId}`,
      snapshot: {
        agentId: agent.id,
        agentName: agent.name,
        runtime: "claude-code",
        systemPrompt: agent.systemPrompt?.trim() || runtime.config.agent.systemPrompt.trim() || "",
        provider: null,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
      },
    });
    runtime.agentContextManager.attachSession(agentId, {
      sessionId: metadata.id,
      runtime: "claude-code",
      rotationReason: "activation",
    });
    return metadata.id;
  }
  const mgr = createPiSession({ title: `Activation ${agentId}` });
  const provider = agent.provider || runtime.config.agent.provider;
  const model = agent.model || runtime.config.agent.model;
  mgr.appendModelChange(piProviderName(provider), model);
  mgr.appendThinkingLevelChange(agent.reasoningEffort || runtime.config.agent.reasoningEffort);
  runtime.pendingSessionManagers.set(mgr.getSessionId(), mgr);
  runtime.agentContextManager.attachSession(agentId, {
    sessionId: mgr.getSessionId(),
    runtime: "pi",
    rotationReason: "activation",
  });
  return mgr.getSessionId();
}
