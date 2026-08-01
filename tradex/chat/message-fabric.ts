/**
 * message-fabric — Shared Message Fabric 读写门面（对应 Raft 统一消息系统）。
 *
 * Channel 与 Direct Message 共用同一套读写入口；message-tools / HTTP 应经此模块，
 * 避免在业务层重复 kind 分支。消息正文权威在 Store，不进入 Runtime Session。
 */
import type { AppRuntime } from "../api/runtime.js";
import { channelTarget, directMessageTarget, type ChatTarget } from "./target.js";
import { appendTargetMessageAndNotify, dispatchSharedMessage } from "./dispatch.js";
import { HUMAN_OWNER_ID } from "./message-store.js";

/** 校验 Agent 是否可读该 ChatTarget（Channel 成员或 DM 参与者）。 */
export function assertCanRead(runtime: AppRuntime, agentId: string, target: ChatTarget): void {
  if (target.kind === "channel") {
    if (!runtime.channelStore.listAgentMemberIds(target.channelId).includes(agentId)) {
      throw new Error("not a member of this Channel");
    }
    return;
  }
  const conversation = runtime.messageStore.getConversation(target.directMessageId);
  if (!conversation || !runtime.messageStore.otherParticipant(conversation, "agent", agentId)) {
    throw new Error("not a participant of this Direct Message");
  }
}

/** 校验 Agent 是否可写该 ChatTarget（与可读权限相同）。 */
export function assertCanWrite(runtime: AppRuntime, agentId: string, target: ChatTarget): void {
  assertCanRead(runtime, agentId, target);
}

/**
 * 按需读取目标时间线（对应 Raft message read）。
 * Channel 侧会顺带把 held draft 标为已审阅到当前 version。
 *
 * @param input.limit 条数上限
 * @param input.beforeSeq 按序号向前分页
 * @param input.afterSeq 按序号向后分页
 * @param input.aroundMessageId 以某条消息为中心取上下文
 */
export function readTimeline(
  runtime: AppRuntime,
  agentId: string,
  target: ChatTarget,
  input: {
    limit?: number;
    beforeSeq?: number | null;
    afterSeq?: number | null;
    aroundMessageId?: string | null;
  },
): {
  target: ChatTarget;
  aroundMessageId: string | null | undefined;
  /** Channel version 快照，供 Agent 后续 send 做 held-draft 冲突检测。 */
  channelVersion?: number | null;
  messages: unknown[];
  nextBeforeSeq: number | null;
} {
  assertCanRead(runtime, agentId, target);
  const limit = input.limit ?? 50;
  if (target.kind === "channel") {
    const page = runtime.channelStore.listMessages({
      channelId: target.channelId,
      beforeSeq: input.beforeSeq ?? null,
      afterSeq: input.afterSeq ?? null,
      aroundMessageId: input.aroundMessageId,
      limit,
    });
    const channel = runtime.channelStore.getChannel(target.channelId);
    if (channel) {
      runtime.channelStore.markHeldDraftsReviewed({
        agentId,
        channelId: target.channelId,
        reviewedVersion: channel.version,
      });
    }
    return {
      target,
      aroundMessageId: input.aroundMessageId,
      channelVersion: channel?.version ?? null,
      messages: page.messages,
      nextBeforeSeq: page.nextBeforeSeq,
    };
  }
  const page = runtime.messageStore.listMessages({
    directMessageId: target.directMessageId,
    beforeSeq: input.beforeSeq ?? null,
    afterSeq: input.afterSeq ?? null,
    aroundMessageId: input.aroundMessageId,
    limit,
    viewer: { type: "agent", id: agentId },
  });
  return {
    target,
    aroundMessageId: input.aroundMessageId,
    messages: page.messages,
    nextBeforeSeq: page.nextBeforeSeq,
  };
}

/**
 * Agent 发送消息。Channel 上若 observedVersion 落后则生成 Held Draft（对应 Raft held draft），
 * 否则写入权威消息并 fan-out inbox。
 */
export function sendAgentMessage(
  runtime: AppRuntime,
  agentId: string,
  target: ChatTarget,
  input: {
    content: string;
    observedVersion?: number | null;
  },
): unknown {
  const content = input.content.trim();
  if (!content) throw new Error("content is required");
  assertCanWrite(runtime, agentId, target);
  if (target.kind === "channel") {
    const channel = runtime.channelStore.getChannel(target.channelId);
    if (!channel) throw new Error("Channel not found");
    const observed = input.observedVersion ?? null;
    if (observed != null && observed < channel.version) {
      const draft = runtime.channelStore.createHeldDraft({
        agentId,
        channelId: target.channelId,
        observedVersion: observed,
        content,
      });
      runtime.inboxStore.notify({
        agentId,
        target,
        messageId: draft.id,
        reason: "held-draft",
      });
      return { heldDraft: draft, published: false };
    }
    const { message } = appendTargetMessageAndNotify(runtime, {
      target,
      authorType: "agent",
      authorId: agentId,
      content,
    });
    return {
      published: true,
      message,
      channelVersion: runtime.channelStore.getChannel(target.channelId)?.version,
    };
  }
  const { message } = appendTargetMessageAndNotify(runtime, {
    target,
    authorType: "agent",
    authorId: agentId,
    content,
  });
  return { published: true, message };
}

/** 给消息加 reaction（表情回应）。 */
export function addReaction(
  runtime: AppRuntime,
  agentId: string,
  target: ChatTarget,
  input: { messageId: string; emoji: string },
): unknown {
  assertCanWrite(runtime, agentId, target);
  if (target.kind === "channel") {
    return runtime.channelStore.addReaction({
      channelId: target.channelId,
      messageId: input.messageId,
      actorId: agentId,
      actorType: "agent",
      emoji: input.emoji,
    });
  }
  return runtime.messageStore.addReaction({
    directMessageId: target.directMessageId,
    messageId: input.messageId,
    actorType: "agent",
    actorId: agentId,
    emoji: input.emoji,
  });
}

/** 移除消息上的 reaction。 */
export function removeReaction(
  runtime: AppRuntime,
  agentId: string,
  target: ChatTarget,
  input: { messageId: string; emoji: string },
): unknown {
  assertCanWrite(runtime, agentId, target);
  if (target.kind === "channel") {
    return runtime.channelStore.removeReaction({
      channelId: target.channelId,
      messageId: input.messageId,
      actorId: agentId,
      actorType: "agent",
      emoji: input.emoji,
    });
  }
  return runtime.messageStore.removeReaction({
    directMessageId: target.directMessageId,
    messageId: input.messageId,
    actorType: "agent",
    actorId: agentId,
    emoji: input.emoji,
  });
}

/**
 * 在 Agent 可读的 Channel/DM 中搜索消息（对应 Raft message search）。
 * 返回命中列表，调用方再按需 readTimeline 拉上下文。
 */
export function searchReadable(
  runtime: AppRuntime,
  agentId: string,
  query: string,
  limit = 20,
): unknown {
  const readableDmIds = runtime.messageStore.listConversationsForAgent(agentId).map((dm) => dm.id);
  const q = query.toLowerCase();
  const channelHits = runtime.channelStore.listChannels()
    .filter((channel) => runtime.channelStore.listAgentMemberIds(channel.id).includes(agentId))
    .flatMap((channel) => {
      const page = runtime.channelStore.listMessages({ channelId: channel.id, limit: 100 });
      return page.messages
        .filter((message) => message.content.toLowerCase().includes(q))
        .map((message) => ({ target: channelTarget(channel.id), message }));
    });
  const dmHits = runtime.messageStore.search({
    directMessageIds: readableDmIds,
    query,
    limit,
  }).map((message) => ({ target: directMessageTarget(message.directMessageId), message }));
  return { results: [...dmHits, ...channelHits].slice(0, limit) };
}

/**
 * 列出 Agent 当前可读的目标（`#channel` / `dm:@handle`），
 * 供 tools 做路由，不含消息正文。
 */
export function listReadableTargets(runtime: AppRuntime, agentId: string): unknown {
  const channels = runtime.channelStore.listChannels()
    .filter((channel) => runtime.channelStore.listAgentMemberIds(channel.id).includes(agentId))
    .map((channel) => ({ target: `#${channel.name}`, channelId: channel.id, topic: channel.topic }));
  const directMessages = runtime.messageStore.listConversationsForAgent(agentId).map((conversation) => {
    const other = runtime.messageStore.otherParticipant(conversation, "agent", agentId);
    if (!other) return null;
    const handle = other.type === "human" ? "owner" : other.id;
    return {
      target: `dm:@${handle}`,
      directMessageId: conversation.id,
      other: { type: other.type, id: other.id },
    };
  }).filter((item): item is NonNullable<typeof item> => item != null);
  if (!directMessages.some((item) => item.other.type === "human")) {
    const humanDm = runtime.messageStore.ensureHumanAgentDm(agentId);
    directMessages.unshift({
      target: "dm:@owner",
      directMessageId: humanDm.id,
      other: { type: "human", id: HUMAN_OWNER_ID },
    });
  }
  return { channels, directMessages };
}

/**
 * 解决 Held Draft（retry / replace / discard）；
 * 若发布成功则走 dispatch 做 inbox fan-out。
 */
export function resolveHeldDraftAndFanOut(
  runtime: AppRuntime,
  agentId: string,
  input: {
    draftId: string;
    action: "retry" | "replace" | "discard";
    content?: string;
  },
): unknown {
  const result = runtime.channelStore.resolveHeldDraft({
    agentId,
    draftId: input.draftId,
    action: input.action,
    content: input.content,
  });
  if (result.publishedMessage) {
    dispatchSharedMessage(runtime, {
      target: channelTarget(result.draft.channelId),
      messageId: result.publishedMessage.id,
      authorType: "agent",
      authorId: agentId,
    });
  }
  return result;
}
