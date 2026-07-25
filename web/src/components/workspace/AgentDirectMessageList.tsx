/**
 * AgentDirectMessageList — Chat 左侧导航：Direct Messages + Channels。
 * 对应 Raft Chat 壳的侧栏入口。
 */
import { useState } from 'react';
import { Hash, Loader2, Plus, X } from 'lucide-react';
import { AgentAvatar } from '../../avatar';
import { agentPresenceView } from '../../chat/presenceDisplay';
import { useChatPresence } from '../../chat/presenceStore';
import { createLiveChatShellController } from '../../chat/shellController';
import { channelTarget, directMessageTarget, unreadCountForTarget } from '../../chat/timeline';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { OriginSidebarSection } from './OriginSidebarSection';

const chatShell = createLiveChatShellController();

/** 左侧 DM / Channel 列表与创建 Channel。 */
export function AgentDirectMessageList() {
  const [creating, setCreating] = useState(false);
  const [channelName, setChannelName] = useState('');
  const presenceByAgentId = useChatPresence();
  const agents = useAgentStore((state) => state.agents);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const directMessageIdByAgentId = useAgentStore((state) => state.directMessageIdByAgentId);
  const loading = useAgentStore((state) => state.agentSessionHistoryLoadingKey) !== null;
  const channels = useChatStore((state) => state.channels);
  const activeTarget = useChatStore((state) => state.activeTarget);
  const createChannel = useChatStore((state) => state.createChannel);
  const unread = useChatStore((state) => state.unread);

  async function submitChannel() {
    if (!channelName.trim()) return;
    await createChannel(channelName);
    setChannelName('');
    setCreating(false);
  }

  return (
    <aside className="direct-message-list">
      <header className="chat-sidebar-title">Chat</header>
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
      {channels.map((channel) => {
        const count = unreadCountForTarget(unread, channelTarget(channel.id));
        return (
          <button
            className={`channel-sidebar-row ${activeTarget?.kind === 'channel' && activeTarget.channelId === channel.id ? 'active' : ''}`}
            key={channel.id}
            onClick={() => void chatShell.openChannel(channel.id)}
            type="button"
          >
            <Hash size={14} /> <span>{channel.name}</span>
            {count > 0 ? <em className="unread-badge">{count}</em> : null}
          </button>
        );
      })}
      <header>DIRECT MESSAGES <span>{agents.length}</span></header>
      {loading && !agents.length && (
        <div className="empty-state sm row"><Loader2 className="spin" size={14} /> Loading Agents</div>
      )}
      {agents.map((agent) => {
        const { label: statusLabel, tone } = agentPresenceView(presenceByAgentId[agent.id]);
        const directMessageId = directMessageIdByAgentId[agent.id];
        const count = directMessageId
          ? unreadCountForTarget(unread, directMessageTarget(directMessageId))
          : 0;
        return (
          <button
            className={`direct-message-row ${activeTarget?.kind === 'direct-message' && selectedAgentId === agent.id ? 'active' : ''}`}
            key={agent.id}
            onClick={() => void chatShell.openDirectMessage(agent.id)}
            type="button"
          >
            <span className="direct-message-avatar"><AgentAvatar agent={agent} size="md" /></span>
            <span className="direct-message-copy">
              <strong>{agent.name}</strong>
              <small>{statusLabel}</small>
            </span>
            {count > 0 && directMessageId ? <em className="unread-badge">{count}</em> : null}
            <span className={`direct-message-presence ${tone}`} />
          </button>
        );
      })}
      <OriginSidebarSection />
    </aside>
  );
}
