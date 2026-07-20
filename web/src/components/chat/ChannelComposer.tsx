/**
 * ChannelComposer — Channel 输入框（含 @Agent 自动补全）。
 */
import { Loader2, Send } from 'lucide-react';
import { useAgentStore } from '../../stores/agentStore';

/** Channel 的消息输入区。 */
export function ChannelComposer({
  draft,
  setDraft,
  submit,
  placeholder,
  sending,
  label,
}: {
  draft: string;
  setDraft: (value: string) => void;
  submit: () => Promise<void>;
  placeholder: string;
  sending: boolean;
  label: string;
}) {
  const agents = useAgentStore((state) => state.agents);
  const match = draft.match(/(?:^|\s)@([\w-]*)$/);
  const query = match?.[1]?.toLowerCase() ?? null;
  const suggestions = query === null ? [] : agents.filter((agent) => (
    agent.id.toLowerCase().includes(query) || agent.name.toLowerCase().includes(query)
  )).slice(0, 6);

  function mention(agentId: string) {
    if (!match || match.index === undefined) return;
    const prefixLength = match[0].startsWith(' ') ? 1 : 0;
    const start = match.index + prefixLength;
    setDraft(`${draft.slice(0, start)}@${agentId} `);
  }

  return (
    <div className="channel-composer-shell">
      {suggestions.length ? (
        <div className="channel-mention-picker">
          {suggestions.map((agent) => (
            <button key={agent.id} onClick={() => mention(agent.id)} type="button">
              <strong>@{agent.id}</strong><span>{agent.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="session-compose">
        <textarea
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !suggestions.length) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          rows={3}
          value={draft}
        />
        <div className="session-compose-actions">
          <button
            aria-label={label}
            className="shell-button primary lg session-submit"
            disabled={!draft.trim() || sending}
            onClick={() => void submit()}
            type="button"
          >
            {sending ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
            <span className="session-submit-label">{label}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
