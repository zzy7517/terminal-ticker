import type { AgentContextManager } from "./agent/context-manager.js";
import { ChatOverlayStore, type ChatMessageReference } from "./chat-overlay.js";
import type { ChannelStore } from "./channel/store.js";
import type { ChatTarget } from "./channel/domain.js";
import type { MessageStore } from "./chat/message-store.js";

interface ChatReferenceInput {
  actorId: string;
  target: ChatTarget;
  messageId: string;
}

/** Trusted boundary for generic message references across Direct Messages and Channels. */
export class ChatReferenceManager {
  constructor(
    private readonly channelStore: ChannelStore,
    private readonly messageStore: MessageStore,
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
    const message = this.messageStore.getMessage(messageId);
    if (message && message.directMessageId === target.directMessageId) return;

    // Legacy Phase 1 sessionId:messageId references while Shared Message import catches up.
    const separator = messageId.lastIndexOf(":");
    if (separator <= 0 || separator === messageId.length - 1) {
      throw new Error("Message not found for ChatTarget");
    }
    const sessionId = messageId.slice(0, separator);
    const context = this.agentContextManager.contextForSession(sessionId);
    const conversation = this.messageStore.getConversation(target.directMessageId);
    if (!context || !conversation) throw new Error("Message not found for ChatTarget");
    const other = this.messageStore.otherParticipant(conversation, "human", "owner");
    if (!other || other.type !== "agent" || other.id !== context.agentId) {
      throw new Error("Message not found for ChatTarget");
    }
  }
}
