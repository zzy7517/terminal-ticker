import type { AppRuntime } from "../api/runtime.js";
import { channelTarget, directMessageTarget, type ChatTarget } from "../channel/domain.js";
import type { InboxReason } from "./inbox-store.js";
import type { DirectMessage } from "./message-store.js";
import type { ChannelMessage } from "../channel/domain.js";

/** Fan-out inbox rows for recipients and wake the coordinator. Call after an atomic append+notify txn. */
export function wakeRecipients(runtime: AppRuntime, agentIds: string[]): void {
  for (const agentId of agentIds) {
    runtime.agentCoordinator?.notify(agentId);
  }
}

export function resolveRecipients(
  runtime: AppRuntime,
  target: ChatTarget,
  authorType: "human" | "agent" | "system",
  authorId: string,
): string[] {
  if (target.kind === "direct-message") {
    const conversation = runtime.messageStore.getConversation(target.directMessageId);
    if (!conversation) return [];
    const ids: string[] = [];
    for (const participant of [
      { type: conversation.participantAType, id: conversation.participantAId },
      { type: conversation.participantBType, id: conversation.participantBId },
    ]) {
      if (participant.type !== "agent") continue;
      if (authorType === "agent" && authorId === participant.id) continue;
      ids.push(participant.id);
    }
    return ids;
  }
  return runtime.channelStore.listAgentMemberIds(target.channelId)
    .filter((agentId) => !(authorType === "agent" && authorId === agentId));
}

export function appendHumanDmAndNotify(
  runtime: AppRuntime,
  input: {
    agentId: string;
    content: string;
    threadRootId?: string | null;
  },
): { message: DirectMessage; directMessageId: string; recipients: string[] } {
  runtime.inboxStore.ensureReady();
  const dm = runtime.messageStore.requireHumanAgentDm(input.agentId);
  const target = directMessageTarget(dm.id);
  const recipients = resolveRecipients(runtime, target, "human", "owner");
  const message = runtime.messageStore.appendMessage({
    directMessageId: dm.id,
    authorType: "human",
    authorId: "owner",
    content: input.content,
    threadRootId: input.threadRootId,
    onCommitted: (conn, created) => {
      for (const agentId of recipients) {
        runtime.inboxStore.notifyWithConn(conn, {
          agentId,
          target,
          messageId: created.id,
          reason: "dm",
        });
      }
    },
  });
  wakeRecipients(runtime, recipients);
  return { message, directMessageId: dm.id, recipients };
}

export function appendChannelMessageAndNotify(
  runtime: AppRuntime,
  input: {
    channelId: string;
    authorType: "human" | "agent";
    authorId: string;
    content: string;
    threadRootId?: string | null;
    reason?: InboxReason;
  },
): { message: ChannelMessage; recipients: string[] } {
  runtime.inboxStore.ensureReady();
  const target = channelTarget(input.channelId);
  const recipients = resolveRecipients(runtime, target, input.authorType, input.authorId);
  const reason = input.reason ?? (input.threadRootId ? "thread" : "joined-channel");
  const onCommitted = (conn: import("better-sqlite3").Database, created: ChannelMessage) => {
    for (const agentId of recipients) {
      runtime.inboxStore.notifyWithConn(conn, {
        agentId,
        target,
        messageId: created.id,
        reason,
      });
    }
  };
  const message = input.authorType === "agent"
    ? runtime.channelStore.appendAgentMessage({
      channelId: input.channelId,
      authorId: input.authorId,
      content: input.content,
      threadRootId: input.threadRootId,
      onCommitted,
    })
    : runtime.channelStore.appendMessage({
      channelId: input.channelId,
      authorId: input.authorId,
      content: input.content,
      threadRootId: input.threadRootId,
      onCommitted,
    });
  wakeRecipients(runtime, recipients);
  return { message, recipients };
}

export function dispatchSharedMessage(
  runtime: AppRuntime,
  input: {
    target: ChatTarget;
    messageId: string;
    authorType: "human" | "agent" | "system";
    authorId: string;
    reason?: InboxReason;
  },
): void {
  const recipients = resolveRecipients(runtime, input.target, input.authorType, input.authorId);
  const reason = input.reason ?? (input.target.kind === "direct-message" ? "dm" : "joined-channel");
  for (const agentId of recipients) {
    runtime.inboxStore.notify({
      agentId,
      target: input.target,
      messageId: input.messageId,
      reason,
    });
  }
  wakeRecipients(runtime, recipients);
}

export function humanDmTarget(runtime: AppRuntime, agentId: string): ChatTarget {
  const dm = runtime.messageStore.requireHumanAgentDm(agentId);
  return directMessageTarget(dm.id);
}

export function channelChatTarget(channelId: string): ChatTarget {
  return channelTarget(channelId);
}
