/**
 * directMessageTimeline — 单个 Agent DM 的 Shared Message Fabric 投影。
 *
 * 把权威 DM 消息映射为 transcript 行；Agent Context 流式输出 / composer
 * 仍在 AgentSessionPanel（runner）中。
 */
import type { AgentDirectMessage } from '../types';

/** UI transcript 行（由权威 DM 消息投影而来）。 */
export interface DirectMessageTimelineItem {
  id: string;
  directMessageId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  metadata: null;
  error: null;
}

/** 将权威 DM 消息投影为 transcript 行形状。 */
export function projectDirectMessageTimeline(
  directMessageId: string | null,
  messages: AgentDirectMessage[],
): DirectMessageTimelineItem[] {
  return messages.map((message) => ({
    id: message.id,
    directMessageId: directMessageId ?? '',
    role: message.authorType === 'human'
      ? 'user' as const
      : message.authorType === 'agent'
        ? 'assistant' as const
        : 'system' as const,
    content: message.content,
    createdAt: new Date(message.createdAtMs).toISOString(),
    metadata: null,
    error: null,
  }));
}
