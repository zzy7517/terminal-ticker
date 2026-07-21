/**
 * runtime — 在现有 Pi / Claude / Cursor seam 上启动一次 Message Fabric activation。
 *
 * 复用 AgentContextManager 的活跃 Runtime Session（或懒创建）。
 * 不另建第三套 Agent loop。Message Tools 按 agentId 绑定到 Pi（进程内）
 * 与外接 Runtime（经 listToolsForExternalMcp 的 MCP grant）。
 */
import type { AppRuntime } from "../api/runtime.js";
import type { InboxItem } from "./inbox-store.js";
import { buildWakePrompt, MESSAGE_OPERATING_INSTRUCTIONS } from "./prompts.js";
import { createMessageToolRegistry } from "./message-tools.js";
import { PiSdkRuntime } from "../agent/runtime/pi/runtime.js";
import { ClaudeCodeRuntime, exposeClaudeReadTools } from "../agent/runtime/claude-code/runtime.js";
import { detectClaudeCode } from "../agent/runtime/claude-code/discovery.js";
import { CursorCliRuntime, exposeCursorReadTools } from "../agent/runtime/cursor/runtime.js";
import { detectCursorCli } from "../agent/runtime/cursor/discovery.js";
import { claudeMcpUrlFromOrigin } from "../api/claude-session-stream.js";
import { currentTimeInstruction, MAIN_AGENT_PROMPT } from "../agent/prompts.js";
import { agentConfigFromSnapshot, openSessionManager } from "../api/helpers.js";
import {
  AGENT_SNAPSHOT_ENTRY,
  appendAgentSnapshot,
  createPiSession,
  piProviderName,
  readAgentSnapshot,
} from "../agent/runtime/pi/sessions.js";
import { buildTradexToolRegistry } from "../api/agent_tools.js";
import { ensurePrivateWorkspace } from "../agent/private-workspace.js";
import { memoryApplyRetention } from "../agent/memory.js";

/**
 * 用现有 Runtime seam 为 pending inbox 启动一次 Agent activation。
 * wake prompt 无正文；Agent 必须调用 Message Tools 读取正文。
 */
export async function startMessageActivation(
  runtime: AppRuntime,
  agentId: string,
  pending: InboxItem[],
): Promise<void> {
  const agent = runtime.agentStore.get(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);

  const workspace = ensurePrivateWorkspace(agentId);
  try {
    memoryApplyRetention(agentId);
  } catch {
    // retention failure must not block Shared Message activation
  }
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

  // ops 进 system；user prompt 只留短 wake（多条 pending 合并为一次）。
  const prompt = buildWakePrompt(pending);
  const messageTools = createMessageToolRegistry(runtime, agentId);
  runtime.lockedAgentSessions.add(sessionId);

  try {
    await runActivationOnce(runtime, agent, agentId, sessionId, workspace, prompt, messageTools);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const resumeFailed = /resume|session.*not found|conversation.*not found|native_session_resume/i.test(detail);
    const overflow = /context.*(overflow|length|too long)|maximum context/i.test(detail);
    if (!resumeFailed && !overflow) throw error;
    const reason = overflow ? "context-overflow" as const : "resume-failure" as const;
    const nextSessionId = await createRotatedSession(runtime, agentId, reason);
    runtime.lockedAgentSessions.delete(sessionId);
    runtime.lockedAgentSessions.add(nextSessionId);
    try {
      await runActivationOnce(runtime, agent, agentId, nextSessionId, workspace, prompt, messageTools);
    } finally {
      runtime.lockedAgentSessions.delete(nextSessionId);
    }
    return;
  } finally {
    runtime.activeAgents.delete(sessionId);
    runtime.lockedAgentSessions.delete(sessionId);
  }
}

async function runActivationOnce(
  runtime: AppRuntime,
  agent: NonNullable<ReturnType<AppRuntime["agentStore"]["get"]>>,
  agentId: string,
  sessionId: string,
  workspace: ReturnType<typeof ensurePrivateWorkspace>,
  prompt: string,
  messageTools: ReturnType<typeof createMessageToolRegistry>,
): Promise<void> {
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
      }).then((result) => exposeClaudeReadTools(result.tools));
      const instructions = [
        agent.systemPrompt?.trim() || runtime.config.agent.systemPrompt.trim() || MAIN_AGENT_PROMPT,
        currentTimeInstruction("run_command"),
        MESSAGE_OPERATING_INSTRUCTIONS,
        `Private workspace: ${workspace.workspacePath}`,
        `Private memory: ${workspace.memoryPath}`,
      ].filter(Boolean).join("\n\n");
      const run = await new ClaudeCodeRuntime({
        executablePath: availability.executablePath,
        mcpUrl: claudeMcpUrlFromOrigin(runtime.listenOrigin),
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

    if (agent.runtime === "cursor") {
      const availability = await detectCursorCli();
      if (!availability.available || !availability.executablePath) {
        throw new Error(availability.error || "Cursor CLI runtime unavailable");
      }
      const tools = await buildTradexToolRegistry(runtime, {
        sessionId,
        config: runtime.config.agent,
        includeExternalMcp: true,
        includeFilesystem: true,
        additionalRegistries: [messageTools],
        agentId,
      }).then((result) => exposeCursorReadTools(result.tools));
      const instructions = [
        agent.systemPrompt?.trim() || runtime.config.agent.systemPrompt.trim() || MAIN_AGENT_PROMPT,
        currentTimeInstruction("shell"),
        MESSAGE_OPERATING_INSTRUCTIONS,
        `Private workspace: ${workspace.workspacePath}`,
        `Private memory: ${workspace.memoryPath}`,
      ].filter(Boolean).join("\n\n");
      const run = await new CursorCliRuntime({
        executablePath: availability.executablePath,
        mcpUrl: claudeMcpUrlFromOrigin(runtime.listenOrigin),
        grants: runtime.mcpRunGrants,
      }).start({
        tradexSessionId: sessionId,
        cwd: runtime.cursorSessions.sessionDir(sessionId),
        prompt,
        instructions,
        registry: tools,
        nativeSessionId: runtime.cursorSessions.getMetadata(sessionId)?.nativeSessionId ?? undefined,
        model: agent.model,
      });
      runtime.activeAgents.set(sessionId, run);
      const result = await run.result;
      if (result.nativeSessionId) {
        runtime.cursorSessions.setNativeSessionId(sessionId, result.nativeSessionId);
      }
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
    const requestConfig = agentConfigFromSnapshot(runtime.config.agent, snapshot);
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
      MESSAGE_OPERATING_INSTRUCTIONS,
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
  }
}

/** 配置变更后轮换物理 Runtime Session；不改变 DM 身份。 */
export async function rotateAgentSessionForConfigChange(
  runtime: AppRuntime,
  agentId: string,
): Promise<string> {
  return createRotatedSession(runtime, agentId, "config-change");
}

/**
 * Human Owner 三档 reset（对齐 Raft Lifecycle）：
 * - restart：中止当前 run，保留同一 Runtime Session，解除 pause 并继续 pending
 * - session-reset：新开物理 Session，workspace/memory 保留
 * - full-reset：新开物理 Session，并清空 private workspace/memory
 */
export async function applyAgentLifecycleReset(
  runtime: AppRuntime,
  agentId: string,
  mode: "restart" | "session-reset" | "full-reset",
): Promise<{ mode: string; sessionId: string | null }> {
  if (!runtime.agentStore.get(agentId)) throw new Error(`Agent not found: ${agentId}`);
  await runtime.agentCoordinator?.abort(agentId);

  if (mode === "restart") {
    runtime.agentContextManager.updateStatus(agentId, {
      paused: false,
      status: "idle",
      lastError: null,
    });
    runtime.agentCoordinator?.notify(agentId);
    return {
      mode,
      sessionId: runtime.agentContextManager.get(agentId)?.activeSessionId ?? null,
    };
  }

  if (mode === "full-reset") {
    const { wipePrivateWorkspace } = await import("../agent/private-workspace.js");
    const workspace = wipePrivateWorkspace(agentId);
    runtime.agentContextManager.updateStatus(agentId, {
      workspacePath: workspace.workspacePath,
      memoryScope: workspace.memoryPath,
      paused: false,
      status: "idle",
      lastError: null,
    });
  } else {
    runtime.agentContextManager.updateStatus(agentId, {
      paused: false,
      status: "idle",
      lastError: null,
    });
  }

  const sessionId = await createRotatedSession(
    runtime,
    agentId,
    mode === "full-reset" ? "full-reset" : "session-reset",
  );
  runtime.agentCoordinator?.notify(agentId);
  return { mode, sessionId };
}

/** 为 Agent Context 懒创建第一个物理 Runtime Session。 */
async function ensureActivationSession(runtime: AppRuntime, agentId: string): Promise<string> {
  return createRotatedSession(runtime, agentId, "activation");
}

async function createRotatedSession(
  runtime: AppRuntime,
  agentId: string,
  reason:
    | "activation"
    | "context-overflow"
    | "config-change"
    | "resume-failure"
    | "session-reset"
    | "full-reset",
): Promise<string> {
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
    if (reason === "activation") {
      runtime.agentContextManager.attachSession(agentId, {
        sessionId: metadata.id,
        runtime: "claude-code",
        rotationReason: reason,
      });
    } else {
      runtime.agentContextManager.rotateSession(agentId, {
        sessionId: metadata.id,
        runtime: "claude-code",
        reason,
      });
    }
    return metadata.id;
  }
  if (agent.runtime === "cursor") {
    const metadata = runtime.cursorSessions.create({
      title: `Activation ${agentId}`,
      snapshot: {
        agentId: agent.id,
        agentName: agent.name,
        runtime: "cursor",
        systemPrompt: agent.systemPrompt?.trim() || runtime.config.agent.systemPrompt.trim() || "",
        provider: null,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
      },
    });
    if (reason === "activation") {
      runtime.agentContextManager.attachSession(agentId, {
        sessionId: metadata.id,
        runtime: "cursor",
        rotationReason: reason,
      });
    } else {
      runtime.agentContextManager.rotateSession(agentId, {
        sessionId: metadata.id,
        runtime: "cursor",
        reason,
      });
    }
    return metadata.id;
  }
  const mgr = createPiSession({ title: `Activation ${agentId}` });
  const provider = agent.provider || runtime.config.agent.provider;
  const model = agent.model || runtime.config.agent.model;
  mgr.appendModelChange(piProviderName(provider), model);
  mgr.appendThinkingLevelChange(agent.reasoningEffort || runtime.config.agent.reasoningEffort);
  runtime.pendingSessionManagers.set(mgr.getSessionId(), mgr);
  if (reason === "activation") {
    runtime.agentContextManager.attachSession(agentId, {
      sessionId: mgr.getSessionId(),
      runtime: "pi",
      rotationReason: reason,
    });
  } else {
    runtime.agentContextManager.rotateSession(agentId, {
      sessionId: mgr.getSessionId(),
      runtime: "pi",
      reason,
    });
  }
  return mgr.getSessionId();
}
