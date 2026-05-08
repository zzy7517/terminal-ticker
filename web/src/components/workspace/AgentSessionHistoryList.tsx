import { useEffect, useState } from 'react';
import { History, Loader2, SquarePen, Trash2 } from 'lucide-react';
import type { AgentContextUsage } from '../../types';
import { useAgentStore } from '../../stores/agentStore';

export function AgentSessionHistoryList() {
  const agentSession = useAgentStore((s) => s.agentSession);
  const history = useAgentStore((s) => s.agentSessionHistory);
  const runStateBySessionId = useAgentStore((s) => s.runStateBySessionId);
  const modelCache = useAgentStore((s) => s.modelCache);
  const busyActionKey = useAgentStore((s) => s.agentSessionActionKey);
  const loading = useAgentStore((s) => s.agentSessionHistoryLoadingKey) !== null;
  const resetAgentConversation = useAgentStore((s) => s.resetAgentConversation);
  const resumeAgentConversation = useAgentStore((s) => s.resumeAgentConversation);
  const deleteAgentConversation = useAgentStore((s) => s.deleteAgentConversation);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const activeSessionId = agentSession?.session?.id ?? null;
  const visibleHistory = history;

  useEffect(() => {
    if (confirmingDeleteId && !visibleHistory.some((item) => item.id === confirmingDeleteId)) {
      setConfirmingDeleteId(null);
    }
  }, [confirmingDeleteId, visibleHistory]);

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

  function contextPercentLabel(
    usage: AgentContextUsage | null | undefined,
    provider: string,
    model: string,
  ): string | null {
    const contextWindow = (modelCache[provider] ?? []).find((item) => item.slug === model)?.contextWindow ?? null;
    if (!usage || !contextWindow || contextWindow <= 0) return null;
    const rawPercent = (usage.promptTokens / contextWindow) * 100;
    const value = rawPercent > 0 && rawPercent < 1 ? '<1' : String(Math.round(rawPercent));
    return `${value}% ctx`;
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
          onClick={() => {
            setConfirmingDeleteId(null);
            void resetAgentConversation();
          }}
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
          const isActive = item.id === activeSessionId;
          const deleteKey = `delete:${item.id}`;
          const run = runStateBySessionId[item.id] ?? item.run;
          const isRunning = run?.status === 'running';
          const hasError = run?.status === 'error';
          const isDeleteBusy = busyActionKey === deleteKey;
          const isConfirmingDelete = confirmingDeleteId === item.id;
          const title = item.preview || item.title || item.id;
          const contextUsage = runStateBySessionId[item.id]?.contextUsage ?? item.contextUsage;
          const contextLabel = contextPercentLabel(contextUsage, item.provider, item.model);
          const deleteButtonTitle = isRunning
            ? 'Session is running'
            : isConfirmingDelete
              ? 'Confirm delete session'
              : 'Delete session';
          const deleteButtonClass = [
            'session-history-delete',
            isConfirmingDelete ? 'confirming' : '',
            isDeleteBusy ? 'deleting' : '',
          ].filter(Boolean).join(' ');
          return (
            <div className={`session-history-row ${isActive ? 'active' : ''}`} key={item.id}>
              <button
                className="session-history-main"
                disabled={isActive || Boolean(busyActionKey)}
                onClick={() => {
                  setConfirmingDeleteId(null);
                  void resumeAgentConversation(item.id);
                }}
                title={isActive ? 'Active session' : 'Open session'}
                type="button"
              >
                <span>{title}</span>
                <small>
                  {item.model} · {relativeTime(item.updatedAt)}
                  {contextLabel ? ` · ${contextLabel}` : ''}
                  {isRunning ? ' · running' : hasError ? ' · error' : ''}
                </small>
              </button>
              {isRunning && <Loader2 className="session-history-status spin" size={13} />}
              {hasError && !isRunning && <span className="session-history-status error">!</span>}
              <button
                aria-label={isConfirmingDelete ? 'Confirm delete session' : 'Delete session'}
                className={deleteButtonClass}
                disabled={Boolean(busyActionKey) || isRunning}
                onClick={() => {
                  if (!isConfirmingDelete) {
                    setConfirmingDeleteId(item.id);
                    return;
                  }
                  setConfirmingDeleteId(null);
                  void deleteAgentConversation(item.id);
                }}
                title={deleteButtonTitle}
                type="button"
              >
                {isDeleteBusy ? (
                  <Loader2 className="spin" size={13} />
                ) : isConfirmingDelete ? (
                  <span className="session-history-delete-label">Confirm</span>
                ) : (
                  <Trash2 size={13} />
                )}
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
