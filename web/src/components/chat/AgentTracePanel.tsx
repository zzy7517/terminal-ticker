/**
 * AgentTracePanel — DM 侧 Agent 资料栏（对应 Raft Agent detail）。
 * Profile 展示身份/runtime；Activity 展示 Stop/Resume 切换与 reset。
 */
import { useEffect, useState } from 'react';
import { Bot, Play, Square, X } from 'lucide-react';
import {
  pauseChatAgent,
  resetChatAgent,
  resumeChatAgent,
} from '../../api';
import { agentPresenceView } from '../../chat/presenceDisplay';
import { useChatPresence, usePresenceStore } from '../../chat/presenceStore';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import type { AgentDirectMessage, AgentPresence } from '../../types';
import './AgentTracePanel.css';

const EMPTY_MESSAGES: AgentDirectMessage[] = [];

type ProfileTab = 'profile' | 'activity';

function runtimeLabel(runtime: string | undefined): string {
  if (runtime === 'claude-code') return 'Claude Code';
  if (runtime === 'cursor') return 'Cursor CLI';
  if (runtime === 'pi') return 'Pi SDK';
  return runtime || '—';
}

/** Agent 资料侧栏：Profile / Activity 与生命周期控制。 */
export function AgentTracePanel({ agentId }: { agentId: string }) {
  const agent = useAgentStore((state) => state.agents.find((entry) => entry.id === agentId) ?? null);
  const directMessages = useAgentStore((state) => state.directMessagesByAgentId[agentId] ?? EMPTY_MESSAGES);
  const closeAgentProfile = useChatStore((state) => state.closeAgentProfile);
  const [tab, setTab] = useState<ProfileTab>('profile');
  const presenceByAgentId = useChatPresence();
  const presence: AgentPresence | null = presenceByAgentId[agentId] ?? null;
  const [error, setError] = useState<string | null>(null);

  async function refreshPresence() {
    try {
      await usePresenceStore.getState().refresh();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Presence fetch failed');
    }
  }

  useEffect(() => {
    setTab('profile');
  }, [agentId]);

  const { label: statusLabel, tone: statusTone } = agentPresenceView(presence);
  const handle = `@${(agent?.id ?? agentId).replace(/^agent:/, '')}`;

  return (
    <aside className="agent-profile-panel">
      <header className="agent-profile-topbar">
        <div className="agent-profile-topbar-title">
          <span className="agent-profile-avatar sm" aria-hidden="true"><Bot size={14} /></span>
          <strong>{agent?.name ?? 'Agent'}</strong>
        </div>
        <button
          aria-label="Close agent profile"
          className="agent-profile-icon-btn"
          onClick={() => closeAgentProfile()}
          title="Close"
          type="button"
        >
          <X size={14} />
        </button>
      </header>

      <nav className="agent-profile-tabs" aria-label="Agent profile sections">
        <button
          className={tab === 'profile' ? 'active' : ''}
          onClick={() => setTab('profile')}
          type="button"
        >
          Profile
        </button>
        <button
          className={tab === 'activity' ? 'active' : ''}
          onClick={() => setTab('activity')}
          type="button"
        >
          Activity
        </button>
      </nav>

      {error && <div className="channel-error">{error}</div>}

      <div className="agent-profile-body">
        {tab === 'profile' ? (
          <>
            <section className="agent-profile-hero">
              <span className="agent-profile-avatar lg" aria-hidden="true"><Bot size={22} /></span>
              <div>
                <div className="agent-profile-name-row">
                  <strong>{agent?.name ?? 'Agent'}</strong>
                  <span className={`agent-profile-status ${statusTone}`}>
                    <i />
                    {statusLabel}
                  </span>
                </div>
                <code>{handle}</code>
              </div>
            </section>

            <section className="agent-profile-field">
              <header>Display name</header>
              <p>{agent?.name ?? '—'}</p>
            </section>

            <section className="agent-profile-field">
              <header>Description</header>
              <p className={!agent?.description ? 'muted' : undefined}>
                {agent?.description || 'No description'}
              </p>
            </section>

            <section className="agent-profile-block">
              <header>Info</header>
              <div className="agent-profile-info-row">
                <span>Role</span>
                <em className="agent-profile-tag">{agent?.builtIn ? 'Built-in' : 'Member'}</em>
              </div>
              <div className="agent-profile-info-row">
                <span>Shared DM</span>
                <strong>{directMessages.length}</strong>
              </div>
              <div className="agent-profile-info-row">
                <span>Status</span>
                <span className={`agent-profile-status ${statusTone}`}>
                  <i />
                  {statusLabel}
                </span>
              </div>
            </section>

            <section className="agent-profile-block">
              <header>Runtime config</header>
              <div className="agent-profile-runtime-grid">
                <div>
                  <span>Runtime</span>
                  <em className="agent-profile-tag runtime">{runtimeLabel(agent?.runtime)}</em>
                </div>
                <div>
                  <span>Model</span>
                  <em className="agent-profile-tag model">{agent?.model || 'default'}</em>
                </div>
              </div>
              {agent?.provider ? (
                <div className="agent-profile-info-row">
                  <span>Provider</span>
                  <code>{agent.provider}</code>
                </div>
              ) : null}
            </section>
          </>
        ) : (
          <>
            <section className="agent-profile-block">
              <header>Activation</header>
              <div className="agent-profile-info-row">
                <span>Last wake</span>
                <strong>
                  {presence?.lastActivationAtMs
                    ? new Date(presence.lastActivationAtMs).toLocaleString()
                    : '—'}
                </strong>
              </div>
              {presence?.lastError ? (
                <div className="agent-profile-info-row">
                  <span>Last error</span>
                  <code className="agent-profile-error">{presence.lastError}</code>
                </div>
              ) : null}
            </section>

            <section className="agent-profile-block">
              <header>Controls</header>
              <div className="agent-profile-controls">
                <button
                  className="shell-button sm"
                  onClick={() => void (presence?.paused
                    ? resumeChatAgent(agentId)
                    : pauseChatAgent(agentId)
                  ).then(refreshPresence)}
                  title={presence?.paused ? 'Resume this Agent' : 'Stop this Agent'}
                  type="button"
                >
                  {presence?.paused ? <Play size={12} /> : <Square size={12} />}
                  {presence?.paused ? 'Resume' : 'Stop'}
                </button>
              </div>
            </section>

            <section className="agent-profile-block">
              <header>Reset</header>
              <div className="agent-profile-controls">
                <button
                  className="shell-button sm"
                  onClick={() => void resetChatAgent(agentId, 'restart')
                    .then(() => useAgentStore.getState().refreshAgentDirectMessages(agentId))
                    .then(refreshPresence)
                    .catch((err) => setError(err instanceof Error ? err.message : 'Restart failed'))}
                  title="Restart this Agent and keep the same Runtime Session"
                  type="button"
                >
                  Restart
                </button>
                <button
                  className="shell-button sm"
                  onClick={() => void resetChatAgent(agentId, 'session-reset')
                    .then(() => useAgentStore.getState().refreshAgentDirectMessages(agentId))
                    .then(refreshPresence)
                    .catch((err) => setError(err instanceof Error ? err.message : 'Session reset failed'))}
                  title="Fresh Runtime Session; workspace and memory kept"
                  type="button"
                >
                  Session reset
                </button>
                <button
                  className="shell-button sm"
                  onClick={() => {
                    if (!window.confirm('Full reset clears this Agent\'s private workspace and MEMORY.md. Continue?')) return;
                    void resetChatAgent(agentId, 'full-reset')
                      .then(() => useAgentStore.getState().refreshAgentDirectMessages(agentId))
                      .then(refreshPresence)
                      .catch((err) => setError(err instanceof Error ? err.message : 'Full reset failed'));
                  }}
                  title="Fresh Runtime Session and wipe private workspace/memory"
                  type="button"
                >
                  Full reset
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
