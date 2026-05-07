import { History, Loader2, SquarePen, Trash2 } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';

export function AgentSessionHistoryList() {
  const agentSession = useAgentStore((s) => s.agentSession);
  const history = useAgentStore((s) => s.agentSessionHistory);
  const busyActionKey = useAgentStore((s) => s.agentSessionActionKey);
  const loading = useAgentStore((s) => s.agentSessionHistoryLoadingKey) !== null;
  const resetAgentConversation = useAgentStore((s) => s.resetAgentConversation);
  const resumeAgentConversation = useAgentStore((s) => s.resumeAgentConversation);
  const deleteAgentConversation = useAgentStore((s) => s.deleteAgentConversation);

  const activeSessionId = agentSession?.session?.id ?? null;
  const visibleHistory = history;

  function relativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
  }

  return (
    <div className="session-history">
      <div className="session-history-head">
        <span>
          <History size={13} /> Chats
        </span>
        <button
          className="session-new-btn"
          disabled={Boolean(busyActionKey)}
          onClick={() => void resetAgentConversation()}
          title="New Chat"
          type="button"
        >
          <SquarePen size={14} />
        </button>
      </div>
      <div className="session-history-list">
        {loading && (
          <div className="session-history-empty">
            <Loader2 className="spin" size={14} />
            <span>Loading saved sessions</span>
          </div>
        )}
        {!loading && visibleHistory.map((item) => {
          const isActive = item.id === activeSessionId || item.active;
          const deleteKey = `delete:${item.id}`;
          const title = item.preview || item.title || item.id;
          return (
            <div className={`session-history-row ${isActive ? 'active' : ''}`} key={item.id}>
              <button
                className="session-history-main"
                disabled={isActive || Boolean(busyActionKey)}
                onClick={() => void resumeAgentConversation(item.id)}
                title={isActive ? 'Active session' : 'Open session'}
                type="button"
              >
                <span>{title}</span>
                <small>
                  {item.model} · {relativeTime(item.updatedAt)}
                </small>
              </button>
              <button
                aria-label="Delete session"
                className="session-history-delete"
                disabled={Boolean(busyActionKey)}
                onClick={() => void deleteAgentConversation(item.id)}
                title="Delete session"
                type="button"
              >
                {busyActionKey === deleteKey ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />}
              </button>
            </div>
          );
        })}
        {!loading && visibleHistory.length === 0 && (
          <div className="session-history-empty">
            <History size={14} />
            <span>No saved sessions yet.</span>
          </div>
        )}
      </div>
    </div>
  );
}
