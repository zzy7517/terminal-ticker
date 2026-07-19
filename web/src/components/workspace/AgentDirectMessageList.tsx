import { useState } from 'react';
import { Bookmark, Bot, Hash, Loader2, Pin, Plus, X } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';

export function AgentDirectMessageList() {
  const [creating, setCreating] = useState(false);
  const [channelName, setChannelName] = useState('');
  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const history = useAgentStore((state) => state.agentSessionHistory);
  const runStateBySessionId = useAgentStore((state) => state.runStateBySessionId);
  const loading = useAgentStore((state) => state.agentSessionHistoryLoadingKey) !== null;
  const selectAgent = useAgentStore((state) => state.selectAgent);
  const channels = useChatStore((state) => state.channels);
  const activeTarget = useChatStore((state) => state.activeTarget);
  const selectChannel = useChatStore((state) => state.selectChannel);
  const createChannel = useChatStore((state) => state.createChannel);
  const selectDirectChat = useChatStore((state) => state.selectDirectChat);
  const savedCount = useChatStore((state) => state.saved.length);
  const pinnedCount = useChatStore((state) => state.pinned.length);
  const activeCollection = useChatStore((state) => state.activeCollection);
  const openCollection = useChatStore((state) => state.openCollection);

  async function submitChannel() {
    if (!channelName.trim()) return;
    await createChannel(channelName);
    setChannelName('');
    setCreating(false);
  }

  return (
    <aside className="direct-message-list">
      <button className={`chat-reference-summary ${activeCollection === 'saved' ? 'active' : ''}`} onClick={() => openCollection('saved')} type="button"><Bookmark size={13} /> Saved <span>{savedCount}</span></button>
      <button className={`chat-reference-summary ${activeCollection === 'pinned' ? 'active' : ''}`} onClick={() => openCollection('pinned')} type="button"><Pin size={13} /> Pinned <span>{pinnedCount}</span></button>
      <header>JOINT CHANNELS <span>0</span></header>
      <header>
        CHANNELS <span>{channels.length}</span>
        <button className="chat-sidebar-add" onClick={() => setCreating((value) => !value)} title="New Channel" type="button">
          {creating ? <X size={13} /> : <Plus size={13} />}
        </button>
      </header>
      {creating && (
        <div className="channel-create-row">
          <input
            autoFocus
            onChange={(event) => setChannelName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void submitChannel(); }}
            placeholder="channel-name"
            value={channelName}
          />
          <button className="shell-button sm" onClick={() => void submitChannel()} type="button">Create</button>
        </div>
      )}
      {channels.map((channel) => (
        <button
          className={`channel-sidebar-row ${activeTarget?.kind === 'channel' && activeTarget.channelId === channel.id ? 'active' : ''}`}
          key={channel.id}
          onClick={() => void selectChannel(channel.id)}
          type="button"
        >
          <Hash size={14} /> <span>{channel.name}</span>
        </button>
      ))}
      <header>DIRECT MESSAGES <span>{agents.length}</span></header>
      {loading && !agents.length && (
        <div className="empty-state sm row"><Loader2 className="spin" size={14} /> Loading Agents</div>
      )}
      {agents.map((agent) => {
        const sessions = history.filter((session) => session.agentId === agent.id);
        const running = sessions.some((session) => runStateBySessionId[session.id]?.status === 'running');
        const failed = sessions.some((session) => runStateBySessionId[session.id]?.status === 'error');
        return (
          <button
            className={`direct-message-row ${activeTarget?.kind === 'direct-message' && selectedAgentId === agent.id ? 'active' : ''}`}
            key={agent.id}
            onClick={() => {
              void selectAgent(agent.id).then(() => {
                const selected = useAgentStore.getState();
                const directMessageId = selected.directMessageIdByAgentId[agent.id];
                if (directMessageId) selectDirectChat(directMessageId);
              });
            }}
            type="button"
          >
            <span className="direct-message-avatar"><Bot size={16} /></span>
            <span className="direct-message-copy">
              <strong>{agent.name}</strong>
              <small>{agent.description || agent.runtime}</small>
            </span>
            <span className={`direct-message-presence ${running ? 'running' : failed ? 'error' : ''}`} />
          </button>
        );
      })}
    </aside>
  );
}
