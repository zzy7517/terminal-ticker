import type { AgentContextManager } from "./agent/context-manager.js";
import { ChatOverlayStore, type ChatMessageReference } from "./chat-overlay.js";
import type { ChannelStore } from "./channel/store.js";
import type { ChatTarget } from "./channel/domain.js";

interface ChatReferenceInput {
  actorId: string;
  target: ChatTarget;
  messageId: string;
}

/** Trusted boundary for generic message references across Direct Chats and Channels. */
export class ChatReferenceManager {
  constructor(
    private readonly channelStore: ChannelStore,
    private readonly agentContextManager: AgentContextManager,
    private readonly store = new ChatOverlayStore(),
  ) {}

  save(input: ChatReferenceInput): void {
    this.validate(input.target, input.messageId);
    this.store.save(input);
  }

  unsave(input: ChatReferenceInput): void {
    this.store.unsave(input);
  }

  pin(input: ChatReferenceInput): void {
    this.validate(input.target, input.messageId);
    this.store.pin(input);
  }

  unpin(input: ChatReferenceInput): void {
    this.store.unpin(input);
  }

  listSaved(actorId: string): ChatMessageReference[] {
    return this.store.listSaved(actorId);
  }

  listPinned(): ChatMessageReference[] {
    return this.store.listAllPinned();
  }

  close(): void {
    this.store.close();
  }

  private validate(target: ChatTarget, messageId: string): void {
    if (target.kind === "channel") {
      const message = this.channelStore.getMessage(messageId);
      if (!message || message.channelId !== target.channelId) throw new Error("Message not found for ChatTarget");
      return;
    }
    const chat = this.agentContextManager.requireChat(target.agentId, target.chatId);
    const separator = messageId.lastIndexOf(":");
    if (separator <= 0 || separator === messageId.length - 1) throw new Error("Invalid Direct Chat message reference");
    const sessionId = messageId.slice(0, separator);
    if (!this.agentContextManager.listSessions(chat.id).some((generation) => generation.sessionId === sessionId)) {
      throw new Error("Message not found for ChatTarget");
    }
  }
}
