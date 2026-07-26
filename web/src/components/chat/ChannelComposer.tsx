/**
 * ChannelComposer — Channel 输入框（含 @Agent 自动补全）。
 */
import { ArrowUp, AtSign, Loader2 } from 'lucide-react';
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
    <div className="composer-dock">
      <div className="composer">
        {suggestions.length ? (
          <div className="composer-menu" role="listbox">
            {suggestions.map((agent) => (
              <button
                className="composer-menu-option"
                key={agent.id}
                onClick={() => mention(agent.id)}
                onMouseDown={(event) => event.preventDefault()}
                role="option"
                type="button"
              >
                <AtSign aria-hidden="true" size={15} strokeWidth={1.8} />
                <span className="composer-menu-name mono">{agent.id}</span>
                <span className="composer-menu-description">{agent.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          className="composer-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !suggestions.length) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          rows={2}
          value={draft}
        />
        <div className="composer-bar">
          <div className="composer-bar-lead" />
          <div className="composer-bar-actions">
            <button
              aria-label={label}
              className="composer-action is-primary"
              disabled={!draft.trim() || sending}
              onClick={() => void submit()}
              title={label}
              type="button"
            >
              {sending ? <Loader2 className="spin" size={16} /> : <ArrowUp size={17} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
