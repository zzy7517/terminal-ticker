/**
 * ChannelMessageItem — 单条 Channel 消息行（Agent 头像 + reaction）。
 * Human 消息不展示头像，仅 Agent 展示。
 */
import { AgentAvatar, avatarSeedSource } from '../../avatar';
import type { ChannelMessage } from '../../types';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { MessageReactions } from './MessageReactions';
import { SessionMessageRow } from './SessionMessageRow';

/** 渲染一条 Channel 共享消息及其 reaction 操作。 */
export function ChannelMessageItem({
  message,
}: {
  message: ChannelMessage;
}) {
  const agents = useAgentStore((state) => state.agents);
  const toggleReaction = useChatStore((state) => state.toggleReaction);
  const deleted = message.deletedAtMs !== null;
  const isHuman = message.authorType === 'human';
  const agent = !isHuman
    ? agents.find((entry) => entry.id === message.authorId) ?? null
    : null;
  const authorLabel = isHuman && message.authorId === 'owner'
    ? 'You'
    : (agent?.name ?? message.authorId);

  return (
    <SessionMessageRow
      as="article"
      className={`channel-message${deleted ? ' deleted' : ''}`}
      content={deleted ? 'Message deleted' : message.content}
      createdAt={message.createdAtMs}
      footer={!deleted ? (
        <MessageReactions
          reactions={message.reactions}
          onToggle={(emoji) => void toggleReaction(message, emoji)}
        />
      ) : null}
      label={authorLabel}
      leading={!isHuman ? (
        <span className="channel-message-avatar" aria-hidden="true">
          <AgentAvatar agent={avatarSeedSource(message.authorId, agent)} size="md" />
        </span>
      ) : null}
      role={isHuman ? 'user' : 'agent'}
    />
  );
}
