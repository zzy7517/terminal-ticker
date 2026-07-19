import {
  AgentContextStore,
  type AgentContextRecord,
  type AgentContextSession,
  type ExistingAgentSession,
} from "./context-store.js";

/**
 * Owns the logical Agent → Runtime-session-generation identity boundary.
 * Callers cannot bind a physical Runtime Session without a trusted agentId.
 * Direct Message identity is owned by MessageStore, not this Manager.
 */
export class AgentContextManager {
  constructor(private readonly store = new AgentContextStore()) {}

  ensure(agentId: string): AgentContextRecord {
    return this.store.ensure(agentId);
  }

  get(agentId: string): AgentContextRecord | null {
    return this.store.get(agentId);
  }

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

  rotateSession(
    agentId: string,
    input: {
      sessionId: string;
      runtime: "pi" | "claude-code";
      reason: "context-overflow" | "config-change" | "resume-failure";
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

  close(): void {
    this.store.close();
  }
}
