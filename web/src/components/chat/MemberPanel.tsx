/**
 * MemberPanel — Channel 成员弹层（Human Owner）。
 * 可加/移成员，并查看/丢弃超时 Held Draft。
 */
import { useEffect, useState } from 'react';
import { User, UserPlus, Users, X } from 'lucide-react';
import {
  addChannelMember,
  discardChannelDraft,
  fetchChannelDrafts,
  fetchChannelMembers,
  removeChannelMember,
} from '../../api';
import { AgentAvatar, avatarSeedSource } from '../../avatar';
import { agentPresenceView } from '../../chat/presenceDisplay';
import { useChatPresence } from '../../chat/presenceStore';
import { useAgentStore } from '../../stores/agentStore';
import type { ChannelHeldDraft, ChannelMember } from '../../types';

/** Channel 成员与 Held Draft 管理弹层。 */
export function MemberPanel({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const agents = useAgentStore((state) => state.agents);
  const presenceByAgentId = useChatPresence();
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [drafts, setDrafts] = useState<ChannelHeldDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [addingId, setAddingId] = useState('');

  async function reload() {
    try {
      const [memberPayload, draftPayload] = await Promise.all([
        fetchChannelMembers(channelId),
        fetchChannelDrafts(channelId),
      ]);
      setMembers(memberPayload.members);
      setDrafts(draftPayload.drafts);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members');
    }
  }

  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 4_000);
    return () => clearInterval(timer);
  }, [channelId]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const agentMembers = members.filter((member) => member.subjectType === 'agent');
  const humanMembers = members.filter((member) => member.subjectType === 'human');
  const memberAgentIds = new Set(agentMembers.map((member) => member.subjectId));
  const availableAgents = agents.filter((agent) => !memberAgentIds.has(agent.id));

  return (
    <div className="member-popover-root">
      <button aria-label="Close members" className="member-popover-backdrop" onClick={onClose} type="button" />
      <div
        aria-label={`Members (${members.length})`}
        className="member-popover"
        role="dialog"
      >
        <header>
          <Users size={15} />
          <strong>Members ({members.length})</strong>
          <button aria-label="Close" className="shell-button ghost sm" onClick={onClose} type="button">
            <X size={14} />
          </button>
        </header>

        {error && <div className="channel-error">{error}</div>}

        <div className="member-popover-body">
          <section className="member-section">
            <h4>Agents</h4>
            {agentMembers.length === 0 && <p className="member-empty">No agents yet.</p>}
            <ul className="member-list">
              {agentMembers.map((member) => {
                const agent = agents.find((entry) => entry.id === member.subjectId);
                const { label: statusLabel, tone } = agentPresenceView(presenceByAgentId[member.subjectId]);
                return (
                  <li key={`${member.subjectType}:${member.subjectId}`}>
                    <span className="member-avatar agent" aria-hidden>
                      <AgentAvatar agent={avatarSeedSource(member.subjectId, agent)} size="md" />
                    </span>
                    <div>
                      <strong>{agent?.name ?? member.subjectId}</strong>
                      <small>
                        <span className={`member-presence ${tone}`} />
                        {statusLabel}
                      </small>
                    </div>
                    <div className="member-actions">
                      <button
                        className="shell-button ghost sm"
                        onClick={() => void removeChannelMember(channelId, {
                          subjectType: 'agent',
                          subjectId: member.subjectId,
                        }).then(reload)}
                        title="Remove"
                        type="button"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="member-section">
            <h4>Humans</h4>
            {humanMembers.length === 0 && <p className="member-empty">No humans.</p>}
            <ul className="member-list">
              {humanMembers.map((member) => (
                <li key={`${member.subjectType}:${member.subjectId}`}>
                  <span className="member-avatar human" aria-hidden>
                    <User size={14} />
                  </span>
                  <div>
                    <strong>Human Owner</strong>
                    <small>Owner</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {drafts.length > 0 && (
            <section className="held-drafts">
              <header>Held drafts <span>{drafts.length}</span></header>
              {drafts.map((draft) => {
                const ageMs = Date.now() - draft.createdAtMs;
                const canDiscard = ageMs >= 5 * 60_000;
                return (
                  <div className="held-draft-row" key={draft.id}>
                    <strong>{draft.agentId}</strong>
                    <small>v{draft.observedVersion}</small>
                    <p>{draft.contentVisible === false || draft.content == null
                      ? "Held draft (Agent-only for 5 minutes)"
                      : draft.content}</p>
                    <button
                      className="shell-button ghost sm"
                      disabled={!canDiscard}
                      onClick={() => {
                        void discardChannelDraft(channelId, draft.id)
                          .then(reload)
                          .catch((err) => setError(err instanceof Error ? err.message : 'Discard failed'));
                      }}
                      title={canDiscard ? 'Discard stale draft' : 'Available after 5 minutes'}
                      type="button"
                    >
                      {canDiscard ? 'Discard' : 'Agent-only'}
                    </button>
                  </div>
                );
              })}
            </section>
          )}
        </div>

        <div className="member-add-row">
          <select
            onChange={(event) => setAddingId(event.target.value)}
            value={addingId}
          >
            <option value="">Add Agent…</option>
            {availableAgents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
          <button
            className="shell-button sm member-add-button"
            disabled={!addingId}
            onClick={() => {
              if (!addingId) return;
              void addChannelMember(channelId, {
                subjectType: 'agent',
                subjectId: addingId,
              }).then(() => {
                setAddingId('');
                return reload();
              });
            }}
            type="button"
          >
            <UserPlus size={13} /> Add Member
          </button>
        </div>
      </div>
    </div>
  );
}
