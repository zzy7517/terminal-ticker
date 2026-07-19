/**
 * chat-references — Saved / Pinned 的可信写入边界。
 *
 * 先校验 messageId 确实属于该 ChatTarget，再写入 Overlay。
 * 避免伪造引用污染侧栏；遗留 Phase 1 sessionId:messageId 格式仍兼容校验。
 */
import type { AgentContextManager } from "../agent/context-manager.js";
import { ChatOverlayStore, type ChatMessageReference } from "./overlay.js";
import type { ChannelStore } from "../channel/store.js";
import type { ChatTarget } from "../channel/domain.js";
import type { MessageStore } from "./message-store.js";

interface ChatReferenceInput {
  actorId: string;
  target: ChatTarget;
  messageId: string;
}

/** Saved / Pinned 管理器：校验后委托 ChatOverlayStore。 */
export class ChatReferenceManager {
  constructor(
    private readonly channelStore: ChannelStore,
    private readonly messageStore: MessageStore,
    private readonly agentContextManager: AgentContextManager,
    private readonly store = new ChatOverlayStore(),
  ) {}

  /** 收藏消息。 */
  save(input: ChatReferenceInput): void {
    this.validate(input.target, input.messageId);
    this.store.save(input);
  }

  /** 取消收藏。 */
  unsave(input: ChatReferenceInput): void {
    this.store.unsave(input);
  }

  /** 固定消息。 */
  pin(input: ChatReferenceInput): void {
    this.validate(input.target, input.messageId);
    this.store.pin(input);
  }

  /** 取消固定。 */
  unpin(input: ChatReferenceInput): void {
    this.store.unpin(input);
  }

  /** 列出 actor 的 Saved。 */
  listSaved(actorId: string): ChatMessageReference[] {
    return this.store.listSaved(actorId);
  }

  /** 列出全部 Pinned。 */
  listPinned(): ChatMessageReference[] {
    return this.store.listAllPinned();
  }

  close(): void {
    this.store.close();
  }

  /** 确认 messageId 属于 target；遗留 session:message 格式走 Context 校验。 */
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
