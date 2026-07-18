import {
  AgentChatStore,
  type AgentChat,
  type AgentChatSession,
  type ExistingAgentSession,
} from "./chat-store.js";

/**
 * Owns the logical Agent → Chat → Session-generation identity boundary.
 * Runtime adapters may create physical Sessions, but callers cannot bind one
 * to a Chat without first proving the trusted Agent/Chat pair here.
 */
export class AgentContextManager {
  constructor(private readonly store = new AgentChatStore()) {}

  ensureActiveChat(agentId: string): AgentChat {
    return this.store.activeForAgent(agentId) ?? this.store.create(agentId);
  }

  listChats(agentId: string): AgentChat[] {
    return this.store.listForAgent(agentId);
  }

  requireChat(agentId: string, chatId: string): AgentChat {
    const chat = this.store.get(chatId);
    if (!chat || chat.agentId !== agentId) throw new Error("Chat not found for Agent");
    return chat;
  }

  createNewChat(agentId: string, agentRunning: boolean): AgentChat {
    if (agentRunning) throw new Error("cannot create New Chat while Agent is running");
    return this.store.create(agentId);
  }

  requireWritableChat(agentId: string, chatId?: string | null): AgentChat | null {
    const chat = chatId ? this.requireChat(agentId, chatId) : this.ensureActiveChat(agentId);
    return chat.status === "active" ? chat : null;
  }

  attachSession(
    agentId: string,
    chatId: string,
    input: { sessionId: string; runtime: "pi" | "claude-code"; createdAtMs?: number; rotationReason?: string },
  ): AgentChatSession {
    const chat = this.requireChat(agentId, chatId);
    if (chat.status !== "active") throw new Error("cannot attach a Session to an archived Chat");
    return this.store.attachSession(chat.id, input);
  }

  rotateSession(
    agentId: string,
    chatId: string,
    input: {
      sessionId: string;
      runtime: "pi" | "claude-code";
      reason: "context-overflow" | "config-change" | "resume-failure";
      createdAtMs?: number;
    },
  ): AgentChatSession {
    return this.attachSession(agentId, chatId, {
      sessionId: input.sessionId,
      runtime: input.runtime,
      createdAtMs: input.createdAtMs,
      rotationReason: input.reason,
    });
  }

  indexSessions(sessions: ExistingAgentSession[]): void {
    this.store.indexSessions(sessions);
  }

  listSessions(chatId: string): AgentChatSession[] {
    return this.store.listSessions(chatId);
  }

  chatForSession(sessionId: string): AgentChat | null {
    return this.store.chatForSession(sessionId);
  }

  removeSession(sessionId: string): void {
    this.store.removeSession(sessionId);
  }

  hasSessionsForAgent(agentId: string): boolean {
    return this.store.hasSessionsForAgent(agentId);
  }

  deleteEmptyChatsForAgent(agentId: string): void {
    this.store.deleteEmptyChatsForAgent(agentId);
  }

  close(): void {
    this.store.close();
  }
}
