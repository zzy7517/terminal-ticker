/**
 * ChannelMessageItem — 单条 Channel 消息行（reaction）。
 */
import type { ChannelMessage } from '../../types';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { MessageReactions } from './MessageReactions';

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
  const authorLabel = isHuman && message.authorId === 'owner'
    ? 'You'
    : (agents.find((agent) => agent.id === message.authorId)?.name ?? message.authorId);

  return (
    <article className={`session-message channel-message${isHuman ? ' user' : ''}${deleted ? ' deleted' : ''}`}>
      <div className="session-message-head">
        <span>{authorLabel}</span>
        <time>{new Date(message.createdAtMs).toLocaleTimeString()}</time>
      </div>
      <div className="session-message-text">
        <p>{deleted ? 'Message deleted' : message.content}</p>
      </div>
      {!deleted ? (
        <MessageReactions
          reactions={message.reactions}
          onToggle={(emoji) => void toggleReaction(message, emoji)}
        />
      ) : null}
    </article>
  );
}
