/** Shared Message Fabric DTO：Direct Message、Channel、Chat 事件与在线状态。 */

export interface AgentDirectMessage {
  id: string;
  directMessageId: string;
  dmSeq: number;
  authorType: 'human' | 'agent' | 'system';
  authorId: string;
  kind: string;
  content: string;
  createdAtMs: number;
  editedAtMs: number | null;
  deletedAtMs: number | null;
  importKey: string | null;
  reactions: ChannelReactionSummary[];
}

export interface AgentDirectMessageResponse {
  directMessage: { id: string };
  target: { kind: 'direct-message'; directMessageId: string };
  messages: AgentDirectMessage[];
  nextBeforeSeq: number | null;
  generations: Array<{
    generation: number;
    sessionId: string;
    runtime: 'pi' | 'claude-code' | 'cursor';
    createdAtMs: number;
    rotationReason: string;
  }>;
}

export interface Channel {
  id: string;
  name: string;
  topic: string;
  visibility: 'public' | 'private';
  version: number;
  createdAtMs: number;
  archivedAtMs: number | null;
}

export type ChatTarget =
  | { kind: 'direct-message'; directMessageId: string }
  | { kind: 'channel'; channelId: string };

export interface ChannelReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}

export interface ChannelMessage {
  id: string;
  channelId: string;
  channelSeq: number;
  authorType: 'human' | 'agent' | 'system';
  authorId: string;
  kind: string;
  content: string;
  createdAtMs: number;
  editedAtMs: number | null;
  deletedAtMs: number | null;
  reactions: ChannelReactionSummary[];
}

export interface ChannelMessagesResponse {
  messages: ChannelMessage[];
  nextBeforeSeq: number | null;
}

export interface ChatEvent {
  seq: number;
  type: string;
  actorType: 'human' | 'agent' | 'system';
  actorId: string;
  target: ChatTarget;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  createdAtMs: number;
}

export interface ChannelMember {
  subjectType: string;
  subjectId: string;
  joinedAtMs: number;
}

export interface ChannelHeldDraft {
  id: string;
  agentId: string;
  channelId: string;
  observedVersion: number;
  /** Null while still inside the 5-minute Agent-only window. */
  content: string | null;
  contentVisible?: boolean;
  status: string;
  createdAtMs: number;
}

export interface AgentPresence {
  agentId: string;
  status: string;
  paused: boolean;
  running: boolean;
  lastActivationAtMs?: number | null;
  lastError?: string | null;
}

export interface ChatUnreadEntry {
  target: ChatTarget;
  unreadCount: number;
  lastReadSeq: number;
}

export interface ChatBootstrapResponse {
  channels: Channel[];
  unread?: ChatUnreadEntry[];
  lastEventSeq: number;
}
