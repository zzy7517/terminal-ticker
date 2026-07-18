export type ChatTarget =
  | { kind: "direct-chat"; agentId: string; chatId: string }
  | { kind: "channel"; channelId: string };

export function channelTarget(channelId: string): ChatTarget {
  return { kind: "channel", channelId };
}

export function directChatTarget(agentId: string, chatId: string): ChatTarget {
  return { kind: "direct-chat", agentId, chatId };
}

export function parseChatTarget(value: unknown): ChatTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ChatTarget");
  const input = value as Record<string, unknown>;
  if (input.kind === "channel" && typeof input.channelId === "string" && input.channelId) {
    return channelTarget(input.channelId);
  }
  if (
    input.kind === "direct-chat"
    && typeof input.agentId === "string" && input.agentId
    && typeof input.chatId === "string" && input.chatId
  ) {
    return directChatTarget(input.agentId, input.chatId);
  }
  throw new Error("Invalid ChatTarget");
}

export function chatTargetRef(target: ChatTarget): string {
  return target.kind === "channel"
    ? JSON.stringify([target.channelId])
    : JSON.stringify([target.agentId, target.chatId]);
}

export function chatTargetFromRow(kind: ChatTarget["kind"], ref: string): ChatTarget {
  const values = JSON.parse(ref) as unknown;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error("Invalid ChatTarget reference");
  }
  if (kind === "channel" && values.length === 1) return channelTarget(values[0]);
  if (kind === "direct-chat" && values.length === 2) return directChatTarget(values[0], values[1]);
  throw new Error("Invalid ChatTarget reference");
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  version: number;
  createdAtMs: number;
  archivedAtMs: number | null;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  channelSeq: number;
  authorType: "human" | "agent" | "system";
  authorId: string;
  kind: string;
  content: string;
  threadRootId: string | null;
  createdAtMs: number;
  editedAtMs: number | null;
  deletedAtMs: number | null;
  replyCount: number;
  reactions: ChannelReactionSummary[];
}

export interface ChannelReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}

export interface ChannelMessageRevision {
  messageId: string;
  revision: number;
  content: string;
  action: "edit" | "delete";
  editedBy: string;
  createdAtMs: number;
}
