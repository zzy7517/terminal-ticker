/**
 * AgentContextManager — 逻辑 Agent Context 与物理 Runtime Session 的身份边界。
 *
 * 对应 Raft「Agent 是持久身份，不是单次 chat session」：
 * context overflow / 配置变更 / reset 可轮换 Runtime Session，但不新建用户可见 DM。
 * Direct Message 身份由 MessageStore 拥有，不由本 Manager 拥有。
 */
import {
  AgentContextStore,
  type AgentContextRecord,
  type AgentContextSession,
  type ExistingAgentSession,
} from "./context-store.js";

/**
 * 拥有「逻辑 Agent → Runtime Session generation」身份边界。
 * 调用方不能在没有可信 agentId 的情况下绑定物理 Runtime Session。
 */
export class AgentContextManager {
  constructor(private readonly store = new AgentContextStore()) {}

  /** 若不存在则创建逻辑 Agent Context 行（此时尚无 Runtime Session）。 */
  ensure(agentId: string): AgentContextRecord {
    return this.store.ensure(agentId);
  }

  get(agentId: string): AgentContextRecord | null {
    return this.store.get(agentId);
  }

  /** 把物理 Runtime Session 绑定为该 Agent 的活跃 generation。 */
  attachSession(
    agentId: string,
    input: {
      sessionId: string;
      runtime: "pi" | "claude-code";
      nativeSessionId?: string | null;
      createdAtMs?: number;
      rotationReason?: string;
    },
  ): AgentContextSession {
    this.ensure(agentId);
    return this.store.attachSession(agentId, {
      sessionId: input.sessionId,
      runtime: input.runtime,
      nativeSessionId: input.nativeSessionId,
      startedAtMs: input.createdAtMs,
      rotationReason: input.rotationReason,
    });
  }

  /**
   * 轮换到新的物理 Runtime Session，不改变 DM 身份。
   * 用于 overflow / 配置变更 / resume 失败 / Human session|full reset。
   */
  rotateSession(
    agentId: string,
    input: {
      sessionId: string;
      runtime: "pi" | "claude-code";
      reason:
        | "context-overflow"
        | "config-change"
        | "resume-failure"
        | "session-reset"
        | "full-reset";
      nativeSessionId?: string | null;
      createdAtMs?: number;
    },
  ): AgentContextSession {
    return this.attachSession(agentId, {
      sessionId: input.sessionId,
      runtime: input.runtime,
      nativeSessionId: input.nativeSessionId,
      createdAtMs: input.createdAtMs,
      rotationReason: input.reason,
    });
  }

  indexSessions(sessions: ExistingAgentSession[]): void {
    this.store.indexSessions(sessions);
  }

  listSessions(agentId: string): AgentContextSession[] {
    return this.store.listSessions(agentId);
  }

  contextForSession(sessionId: string): AgentContextRecord | null {
    return this.store.contextForSession(sessionId);
  }

  removeSession(sessionId: string): void {
    this.store.removeSession(sessionId);
  }

  hasSessionsForAgent(agentId: string): boolean {
    return this.store.hasSessionsForAgent(agentId);
  }

  updateStatus(
    agentId: string,
    input: {
      status?: AgentContextRecord["status"];
      paused?: boolean;
      lastError?: string | null;
      lastActivationAtMs?: number | null;
      workspacePath?: string | null;
      memoryScope?: string | null;
    },
  ): AgentContextRecord {
    return this.store.updateStatus(agentId, input);
  }

  /**
   * 解析该 Agent 当前活跃物理 Session。
   * 调用方用 sessionId 查 Runtime map；不要在别处猜 activeSessionId。
   */
  resolveActiveBinding(agentId: string): { agentId: string; sessionId: string } | null {
    const sessionId = this.get(agentId)?.activeSessionId ?? null;
    if (!sessionId) return null;
    return { agentId, sessionId };
  }

  /**
   * 按可信 agentId abort 当前 Runtime run。
   * activeRuns 由 AppRuntime 持有（sessionId → run）；本 Manager 只负责身份边界。
   */
  abortActiveRun(
    agentId: string,
    activeRuns: Map<string, { abort: () => void }>,
  ): { aborted: boolean; sessionId: string | null } {
    const binding = this.resolveActiveBinding(agentId);
    if (!binding) return { aborted: false, sessionId: null };
    const run = activeRuns.get(binding.sessionId);
    if (!run) return { aborted: false, sessionId: binding.sessionId };
    run.abort();
    return { aborted: true, sessionId: binding.sessionId };
  }

  close(): void {
    this.store.close();
  }
}
