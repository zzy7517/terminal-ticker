/**
 * dispatch — Shared Message Fabric 的统一写入 Interface。
 *
 * 对外主入口只有 appendTargetMessageAndNotify：
 *   追加权威消息 → 同事务 inbox fan-out → wake recipients。
 * 正文不进 wake prompt；作者不会自我通知。
 */
import type Database from "better-sqlite3";
import type { AppRuntime } from "../api/runtime.js";
import { channelTarget, directMessageTarget, type ChannelMessage, type ChatTarget } from "../channel/domain.js";
import type { InboxReason } from "./inbox-store.js";
import type { DirectMessage } from "./message-store.js";

/** inbox 落盘后再唤醒 coordinator；允许重复调用。 */
function wakeRecipients(runtime: AppRuntime, agentIds: string[]): void {
  for (const agentId of agentIds) {
    runtime.agentCoordinator?.notify(agentId);
  }
}

/**
 * 该目标上应被通知的 Agent 列表。
 * 作者是 Agent 时会排除自身。
 */
function resolveRecipients(
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

/**
 * 在当前 Channel 成员中解析 @agentId / @agentName。
 * 只有成员可被 mention；未知 handle 忽略。
 */
export function resolveMentionedAgentIds(
  runtime: AppRuntime,
  channelId: string,
  content: string,
): string[] {
  const handles = new Set(
    [...content.matchAll(/@([A-Za-z0-9_-]+)/g)].map((match) => match[1]!.toLowerCase()),
  );
  if (handles.size === 0) return [];
  const memberIds = runtime.channelStore.listAgentMemberIds(channelId);
  const mentioned: string[] = [];
  for (const agentId of memberIds) {
    const agent = runtime.agentStore.get(agentId);
    if (!agent) continue;
    if (
      handles.has(agentId.toLowerCase())
      || handles.has(agent.name.toLowerCase().replace(/\s+/g, "-"))
      || handles.has(agent.name.toLowerCase())
    ) {
      mentioned.push(agentId);
    }
  }
  return mentioned;
}

export type AppendedSharedMessage = DirectMessage | ChannelMessage;

/**
 * 统一 Target 写入：append → 同事务 inbox fan-out → wake。
 * Channel mention 会把对应 recipient 的 reason 设为 mention。
 */
export function appendTargetMessageAndNotify(
  runtime: AppRuntime,
  input: {
    target: ChatTarget;
    authorType: "human" | "agent";
    authorId: string;
    content: string;
    threadRootId?: string | null;
    reason?: InboxReason;
  },
): { message: AppendedSharedMessage; target: ChatTarget; recipients: string[] } {
  runtime.inboxStore.ensureReady();
  const { target } = input;
  if (input.authorType === "human") {
    runtime.agentCoordinator?.resetChain(target);
  }
  const recipients = resolveRecipients(runtime, target, input.authorType, input.authorId);

  if (target.kind === "direct-message") {
    const message = runtime.messageStore.appendMessage({
      directMessageId: target.directMessageId,
      authorType: input.authorType,
      authorId: input.authorId,
      content: input.content,
      threadRootId: input.threadRootId,
      withinTransaction: (conn, created) => {
        fanOutInbox(runtime, conn, recipients, target, created.id, "dm");
      },
    });
    wakeRecipients(runtime, recipients);
    return { message, target, recipients };
  }

  const mentioned = resolveMentionedAgentIds(runtime, target.channelId, input.content)
    .filter((agentId) => recipients.includes(agentId));
  const mentionedSet = new Set(mentioned);
  const defaultReason = input.reason ?? (input.threadRootId ? "thread" : "joined-channel");
  const withinTransaction = (conn: Database.Database, created: ChannelMessage) => {
    for (const agentId of recipients) {
      runtime.inboxStore.notifyWithConn(conn, {
        agentId,
        target,
        messageId: created.id,
        reason: mentionedSet.has(agentId) ? "mention" : defaultReason,
      });
    }
  };
  const message = input.authorType === "agent"
    ? runtime.channelStore.appendAgentMessage({
      channelId: target.channelId,
      authorId: input.authorId,
      content: input.content,
      threadRootId: input.threadRootId,
      withinTransaction,
    })
    : runtime.channelStore.appendMessage({
      channelId: target.channelId,
      authorId: input.authorId,
      content: input.content,
      threadRootId: input.threadRootId,
      withinTransaction,
    });
  wakeRecipients(runtime, recipients);
  return { message, target, recipients };
}

/** Human → Agent DM 的薄包装（解析 agentId → unique DM）。 */
export function appendHumanDmAndNotify(
  runtime: AppRuntime,
  input: {
    agentId: string;
    content: string;
    threadRootId?: string | null;
  },
): { message: DirectMessage; directMessageId: string; recipients: string[] } {
  const dm = runtime.messageStore.requireHumanAgentDm(input.agentId);
  const result = appendTargetMessageAndNotify(runtime, {
    target: directMessageTarget(dm.id),
    authorType: "human",
    authorId: "owner",
    content: input.content,
    threadRootId: input.threadRootId,
  });
  return {
    message: result.message as DirectMessage,
    directMessageId: dm.id,
    recipients: result.recipients,
  };
}

/** Agent/Human 向已解析的 DM id 发送。 */
export function appendDirectMessageAndNotify(
  runtime: AppRuntime,
  input: {
    directMessageId: string;
    authorType: "human" | "agent";
    authorId: string;
    content: string;
    threadRootId?: string | null;
  },
): { message: DirectMessage; directMessageId: string; recipients: string[] } {
  const result = appendTargetMessageAndNotify(runtime, {
    target: directMessageTarget(input.directMessageId),
    authorType: input.authorType,
    authorId: input.authorId,
    content: input.content,
    threadRootId: input.threadRootId,
  });
  return {
    message: result.message as DirectMessage,
    directMessageId: input.directMessageId,
    recipients: result.recipients,
  };
}

/** Channel 发送的薄包装。 */
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
  const result = appendTargetMessageAndNotify(runtime, {
    target: channelTarget(input.channelId),
    authorType: input.authorType,
    authorId: input.authorId,
    content: input.content,
    threadRootId: input.threadRootId,
    reason: input.reason,
  });
  return {
    message: result.message as ChannelMessage,
    recipients: result.recipients,
  };
}

/**
 * 对已在别处追加的消息做 fan-out（例如 held-draft 发布）。
 * 不会再次写入消息本体。
 */
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
  if (input.authorType === "human") {
    runtime.agentCoordinator?.resetChain(input.target);
  }
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

function fanOutInbox(
  runtime: AppRuntime,
  conn: Database.Database,
  recipients: string[],
  target: ChatTarget,
  messageId: string,
  reason: InboxReason,
): void {
  for (const agentId of recipients) {
    runtime.inboxStore.notifyWithConn(conn, {
      agentId,
      target,
      messageId,
      reason,
    });
  }
}
