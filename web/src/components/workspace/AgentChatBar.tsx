import { History, Loader2, Plus } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';

export function AgentChatBar() {
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const agents = useAgentStore((state) => state.agents);
  const chats = useAgentStore((state) => state.agentChatsByAgentId[selectedAgentId] ?? []);
  const activeChatId = useAgentStore((state) => state.activeAgentChatId);
  const activeSessionId = useAgentStore((state) => state.activeAgentSessionId);
  const run = useAgentStore((state) => activeSessionId ? state.runStateBySessionId[activeSessionId] : null);
  const actionKey = useAgentStore((state) => state.agentChatActionKey);
  const selectAgentChat = useAgentStore((state) => state.selectAgentChat);
  const createNewChat = useAgentStore((state) => state.createNewChat);
  const selectDirectChat = useChatStore((state) => state.selectDirectChat);
  const agent = agents.find((entry) => entry.id === selectedAgentId);
  const selectedChat = chats.find((chat) => chat.id === activeChatId) ?? null;
  const busy = run?.status === 'running';

  return (
    <div className="agent-chat-bar">
      <div className="agent-chat-identity">
        <strong>{agent?.name ?? 'Agent'}</strong>
        <small>{selectedChat?.status === 'archived' ? 'Historical Chat · read only' : 'Active Chat'}</small>
      </div>
      <label className="agent-chat-history">
        <History size={13} />
        <select
          aria-label="Chat history"
          onChange={(event) => {
            const chatId = event.target.value;
            void selectAgentChat(chatId).then(() => selectDirectChat(selectedAgentId, chatId));
          }}
          value={selectedChat?.id ?? ''}
        >
          {!chats.length && <option value="">No Chats</option>}
          {chats.map((chat) => (
            <option key={chat.id} value={chat.id}>
              {chat.title || `Chat ${chat.ordinal}`} · {chat.status}
            </option>
          ))}
        </select>
      </label>
      <button
        className="shell-button sm"
        disabled={busy || Boolean(actionKey)}
        onClick={() => void createNewChat(selectedAgentId).then(() => {
          const chatId = useAgentStore.getState().activeAgentChatId;
          if (chatId) selectDirectChat(selectedAgentId, chatId);
        })}
        title={busy ? 'Wait for the current Agent run to finish' : 'Start a clean Chat'}
        type="button"
      >
        {actionKey === 'new-chat' ? <Loader2 className="spin" size={13} /> : <Plus size={13} />}
        New Chat
      </button>
    </div>
  );
}
