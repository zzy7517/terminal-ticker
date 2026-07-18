import { Bookmark, Hash, Pin } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import type { ChatMessageReference } from '../../types';

export function ChatReferencePanel() {
  const collection = useChatStore((state) => state.activeCollection);
  const references = useChatStore((state) => collection === 'saved' ? state.saved : state.pinned);
  const channels = useChatStore((state) => state.channels);
  const messagesByChannelId = useChatStore((state) => state.messagesByChannelId);
  const selectChannel = useChatStore((state) => state.selectChannel);
  const selectDirectChat = useChatStore((state) => state.selectDirectChat);
  const agents = useAgentStore((state) => state.agents);
  const sessions = useAgentStore((state) => state.agentSessionById);
  const selectAgentChat = useAgentStore((state) => state.selectAgentChat);

  if (!collection) return null;

  async function open(reference: ChatMessageReference) {
    if (reference.target.kind === 'channel') {
      await selectChannel(reference.target.channelId);
      return;
    }
    await selectAgentChat(reference.target.chatId);
    selectDirectChat(reference.target.agentId, reference.target.chatId);
  }

  return (
    <section className="chat-reference-panel">
      <header>
        {collection === 'saved' ? <Bookmark size={16} /> : <Pin size={16} />}
        <div><strong>{collection === 'saved' ? 'Saved' : 'Pinned'}</strong><small>Messages across Direct Chats and Channels</small></div>
      </header>
      <div className="chat-reference-list">
        {!references.length ? <div className="empty-state row">No {collection} messages.</div> : null}
        {references.map((reference) => {
          const projection = resolveReference(reference, channels, messagesByChannelId, agents, sessions);
          return (
            <button key={`${JSON.stringify(reference.target)}:${reference.messageId}`} onClick={() => void open(reference)} type="button">
              <span>{reference.target.kind === 'channel' ? <Hash size={13} /> : projection.label.slice(0, 1)}</span>
              <span><strong>{projection.label}</strong><small>{projection.content}</small></span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function resolveReference(
  reference: ChatMessageReference,
  channels: ReturnType<typeof useChatStore.getState>['channels'],
  messagesByChannelId: ReturnType<typeof useChatStore.getState>['messagesByChannelId'],
  agents: ReturnType<typeof useAgentStore.getState>['agents'],
  sessions: ReturnType<typeof useAgentStore.getState>['agentSessionById'],
): { label: string; content: string } {
  if (reference.target.kind === 'channel') {
    const channelId = reference.target.channelId;
    const channel = channels.find((entry) => entry.id === channelId);
    const message = messagesByChannelId[channelId]?.find((entry) => entry.id === reference.messageId);
    return { label: `#${channel?.name ?? 'Channel'}`, content: message?.content || 'Open Channel to load this message' };
  }
  const separator = reference.messageId.lastIndexOf(':');
  const sessionId = separator > 0 ? reference.messageId.slice(0, separator) : '';
  const messageId = separator > 0 ? reference.messageId.slice(separator + 1) : '';
  const message = sessions[sessionId]?.messages.find((entry) => String(entry.id) === messageId);
  const agentId = reference.target.agentId;
  const agent = agents.find((entry) => entry.id === agentId);
  return { label: agent?.name ?? agentId, content: message?.content || 'Open Direct Chat to load this message' };
}
