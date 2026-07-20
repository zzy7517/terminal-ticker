/**
 * Channel 领域类型与 ChatTarget 辅助函数。
 *
 * ChatTarget 是事件流与未来 Tasks 使用的内部可信引用。
 * Agent 工具使用字符串 Message Target，并在工具边界转换（见 message-target.ts）。
 */

/** 内部可信消息目标：Channel 或 Direct Message（不含 Runtime Session）。 */
export type ChatTarget =
  | { kind: "direct-message"; directMessageId: string }
  | { kind: "channel"; channelId: string };

/** 构造 Channel ChatTarget。 */
export function channelTarget(channelId: string): ChatTarget {
  return { kind: "channel", channelId };
}

/** 构造 Direct Message ChatTarget。 */
export function directMessageTarget(directMessageId: string): ChatTarget {
  return { kind: "direct-message", directMessageId };
}

/** 从 API/JSON 解析结构化 ChatTarget；拒绝已退役的 direct-chat。 */
export function parseChatTarget(value: unknown): ChatTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ChatTarget");
  const input = value as Record<string, unknown>;
  if (input.kind === "channel" && typeof input.channelId === "string" && input.channelId) {
    return channelTarget(input.channelId);
  }
  if (input.kind === "direct-message" && typeof input.directMessageId === "string" && input.directMessageId) {
    return directMessageTarget(input.directMessageId);
  }
  // 遗留 Phase 1 使用 direct-chat + agentId/chatId。拒绝伪造；
  // 调用方写入新 ChatTarget 前须经 MessageStore 迁移。
  if (input.kind === "direct-chat") {
    throw new Error("direct-chat ChatTarget is retired; use direct-message");
  }
  throw new Error("Invalid ChatTarget");
}

/** ChatTarget 的稳定 SQLite 引用载荷（用于 inbox / chat events）。 */
export function chatTargetRef(target: ChatTarget): string {
  return target.kind === "channel"
    ? JSON.stringify([target.channelId])
    : JSON.stringify([target.directMessageId]);
}

/** 从存储的 kind+ref 还原 ChatTarget。遗留 direct-chat 必须先经 migrateLegacyDirectChatTargets 改写。 */
export function chatTargetFromRow(kind: string, ref: string): ChatTarget {
  const values = JSON.parse(ref) as unknown;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error("Invalid ChatTarget reference");
  }
  if (kind === "channel" && values.length === 1) return channelTarget(values[0]);
  if (kind === "direct-message" && values.length === 1) return directMessageTarget(values[0]);
  if (kind === "direct-chat") {
    throw new Error("unmigrated direct-chat ChatTarget; run migrateLegacyDirectChatTargets");
  }
  throw new Error("Invalid ChatTarget reference");
}

/** Held Draft 状态：暂存 / 已发布 / 已丢弃。 */
export type HeldDraftStatus = "held" | "published" | "discarded";

/** Agent 基于过期 channel.version 发送时暂存的回复（对应 Raft held draft）。 */
export interface HeldDraft {
  id: string;
  agentId: string;
  channelId: string;
  observedVersion: number;
  content: string;
  status: HeldDraftStatus;
  createdAtMs: number;
}

/** Reminder 状态：已排程 / 已触发 / 已取消。 */
export type ReminderStatus = "scheduled" | "triggered" | "cancelled";

/** Channel 一次性提醒（对应 Raft agent reminders）。 */
export interface ChannelReminder {
  id: string;
  agentId: string;
  channelId: string;
  dueAtMs: number;
  note: string;
  status: ReminderStatus;
}

/** Channel 元数据；version 用于 Held Draft 并发检测。 */
export interface Channel {
  id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  version: number;
  createdAtMs: number;
  archivedAtMs: number | null;
}

/** Channel 共享消息（权威正文在 ChannelStore，不进 Runtime Session）。 */
export interface ChannelMessage {
  id: string;
  channelId: string;
  channelSeq: number;
  authorType: "human" | "agent" | "system";
  authorId: string;
  kind: string;
  content: string;
  createdAtMs: number;
  editedAtMs: number | null;
  deletedAtMs: number | null;
  reactions: ChannelReactionSummary[];
}

/** 单条消息上的 reaction 汇总。 */
export interface ChannelReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}
