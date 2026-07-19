export type ChatTarget =
  | { kind: "direct-message"; directMessageId: string }
  | { kind: "channel"; channelId: string };

export function channelTarget(channelId: string): ChatTarget {
  return { kind: "channel", channelId };
}

export function directMessageTarget(directMessageId: string): ChatTarget {
  return { kind: "direct-message", directMessageId };
}

export function parseChatTarget(value: unknown): ChatTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid ChatTarget");
  const input = value as Record<string, unknown>;
  if (input.kind === "channel" && typeof input.channelId === "string" && input.channelId) {
    return channelTarget(input.channelId);
  }
  if (input.kind === "direct-message" && typeof input.directMessageId === "string" && input.directMessageId) {
    return directMessageTarget(input.directMessageId);
  }
  // Legacy Phase 1 references used direct-chat + agentId/chatId. Reject forging;
  // callers must migrate through MessageStore before writing new overlays.
  if (input.kind === "direct-chat") {
    throw new Error("direct-chat ChatTarget is retired; use direct-message");
  }
  throw new Error("Invalid ChatTarget");
}

export function chatTargetRef(target: ChatTarget): string {
  return target.kind === "channel"
    ? JSON.stringify([target.channelId])
    : JSON.stringify([target.directMessageId]);
}

export function chatTargetFromRow(kind: string, ref: string): ChatTarget {
  const values = JSON.parse(ref) as unknown;
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error("Invalid ChatTarget reference");
  }
  if (kind === "channel" && values.length === 1) return channelTarget(values[0]);
  if (kind === "direct-message" && values.length === 1) return directMessageTarget(values[0]);
  // Legacy Phase 1 direct-chat rows: [agentId, chatId]. Readable until overlay migration rewrites them.
  if (kind === "direct-chat" && values.length === 2) {
    return directMessageTarget(`legacy:${values[0]}:${values[1]}`);
  }
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
