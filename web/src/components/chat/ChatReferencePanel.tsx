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
  const directMessageIdByAgentId = useAgentStore((state) => state.directMessageIdByAgentId);
  const directMessagesByAgentId = useAgentStore((state) => state.directMessagesByAgentId);
  const selectAgent = useAgentStore((state) => state.selectAgent);

  if (!collection) return null;

  async function open(reference: ChatMessageReference) {
    if (reference.target.kind === 'channel') {
      await selectChannel(reference.target.channelId);
      return;
    }
    const agentId = Object.entries(directMessageIdByAgentId).find(
      ([, directMessageId]) => (
        reference.target.kind === 'direct-message'
        && directMessageId === reference.target.directMessageId
      ),
    )?.[0];
    if (agentId) await selectAgent(agentId);
    if (reference.target.kind === 'direct-message') {
      selectDirectChat(reference.target.directMessageId);
    }
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
          const projection = resolveReference(reference, channels, messagesByChannelId, agents, directMessageIdByAgentId, directMessagesByAgentId);
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
  directMessageIdByAgentId: ReturnType<typeof useAgentStore.getState>['directMessageIdByAgentId'],
  directMessagesByAgentId: ReturnType<typeof useAgentStore.getState>['directMessagesByAgentId'],
): { label: string; content: string } {
  if (reference.target.kind === 'channel') {
    const channelId = reference.target.channelId;
    const channel = channels.find((entry) => entry.id === channelId);
    const message = messagesByChannelId[channelId]?.find((entry) => entry.id === reference.messageId);
    return { label: `#${channel?.name ?? 'Channel'}`, content: message?.content || 'Open Channel to load this message' };
  }
  const directMessageId = reference.target.directMessageId;
  const agentId = Object.entries(directMessageIdByAgentId).find(
    ([, id]) => id === directMessageId,
  )?.[0] ?? 'Agent';
  const message = directMessagesByAgentId[agentId]?.find((entry) => entry.id === reference.messageId);
  const agent = agents.find((entry) => entry.id === agentId);
  return { label: agent?.name ?? agentId, content: message?.content || 'Open Direct Message to load this message' };
}
