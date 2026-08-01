/** Shared Message Fabric DTO：Direct Message、Channel、Chat 事件与在线状态。 */
import type { Channel, ChannelMessage, ChatTarget } from '../../../tradex/contracts';

export type {
  Channel,
  ChannelMessage,
  ChannelReactionSummary,
  ChatTarget,
} from '../../../tradex/contracts';
import type { ChannelReactionSummary } from '../../../tradex/contracts';

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
}

/** Frontend navigation target; Origin deliberately stays outside ChatTarget. */
export type ChatSurfaceTarget = ChatTarget | { kind: 'origin' };

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
