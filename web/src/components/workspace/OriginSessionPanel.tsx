/** OriginSessionPanel — direct Runtime timeline without Agent identity or Chat fabric. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Atom, Box, Loader2, Square, Trash2 } from 'lucide-react';
import { fetchAgentSkills } from '../../api';
import {
  containsSkillReference,
  insertSkillReference,
  matchingSkills,
  skillSlashQuery,
  type SkillSlashQuery,
} from '../../chat/skillCompletion';
import { deleteOriginEntry } from '../../chat/originWorkspace';
import { useOriginStore } from '../../stores/originStore';
import type { AgentMessage, AgentSkillSummary } from '../../types';

export function OriginSessionPanel() {
  const activeOriginId = useOriginStore((state) => state.activeOriginId);
  const session = useOriginStore((state) => (
    state.activeOriginId ? state.sessionById[state.activeOriginId] ?? null : null
  ));
  const summary = useOriginStore((state) => (
    state.origins.find((item) => item.id === state.activeOriginId) ?? null
  ));
  const draft = useOriginStore((state) => (
    state.activeOriginId ? state.draftById[state.activeOriginId] ?? '' : ''
  ));
  const streaming = useOriginStore((state) => (
    state.activeOriginId ? state.streamingById[state.activeOriginId] : undefined
  ));
  const running = useOriginStore((state) => (
    state.activeOriginId ? state.runningIds.has(state.activeOriginId) : false
  ));
  const loading = useOriginStore((state) => state.loading);
  const error = useOriginStore((state) => state.error);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const [skillCatalog, setSkillCatalog] = useState<AgentSkillSummary[]>([]);
  const [slashQuery, setSlashQuery] = useState<SkillSlashQuery | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [selectedSkillsByOrigin, setSelectedSkillsByOrigin] = useState<Record<string, string[]>>({});
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);
  const skillCandidates = useMemo(
    () => slashQuery ? matchingSkills(skillCatalog, slashQuery.query) : [],
    [skillCatalog, slashQuery],
  );
  const selectedSkillNames = activeOriginId ? selectedSkillsByOrigin[activeOriginId] ?? [] : [];

  useEffect(() => {
    let disposed = false;
    void fetchAgentSkills()
      .then((skills) => { if (!disposed) setSkillCatalog(skills); })
      .catch((loadError) => console.error('Origin skills fetch failed:', loadError));
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (activeOriginId && !session && !loading) void useOriginStore.getState().select(activeOriginId);
  }, [activeOriginId, loading, session]);

  useEffect(() => {
    setSlashQuery(null);
    setActiveSkillIndex(0);
  }, [activeOriginId]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages.length, streaming]);

  useEffect(() => {
    if (draft || !activeOriginId) return;
    setSlashQuery(null);
    setSelectedSkillsByOrigin((current) => (
      current[activeOriginId]?.length ? { ...current, [activeOriginId]: [] } : current
    ));
  }, [activeOriginId, draft]);

  useLayoutEffect(() => {
    const menu = skillMenuRef.current;
    const activeOption = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !activeOption) return;
    if (activeOption.offsetTop < menu.scrollTop) menu.scrollTop = activeOption.offsetTop;
    else if (activeOption.offsetTop + activeOption.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = activeOption.offsetTop + activeOption.offsetHeight - menu.clientHeight;
    }
  }, [activeSkillIndex, skillCandidates]);

  const updateSlashQuery = useCallback((value: string, caret: number | null) => {
    setSlashQuery(skillSlashQuery(value, caret ?? value.length));
    setActiveSkillIndex(0);
  }, []);

  const chooseSkill = useCallback((skill: AgentSkillSummary) => {
    if (!slashQuery || !activeOriginId) return;
    const insertion = insertSkillReference(draft, slashQuery, skill.name);
    useOriginStore.getState().setDraft(insertion.value);
    setSelectedSkillsByOrigin((current) => ({
      ...current,
      [activeOriginId]: [...new Set([...(current[activeOriginId] ?? []), skill.name])],
    }));
    setSlashQuery(null);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(insertion.caret, insertion.caret);
    });
  }, [activeOriginId, draft, slashQuery]);

  if (!activeOriginId) return null;
  const projected = session?.session ?? summary;
  const title = projected?.title || 'New Origin';
  const model = projected?.model || 'Default model';

  return (
    <div className="agent-card agent-readout agent-session-card origin-session-card">
      <header className="dm-conversation-header">
        <div className="dm-conversation-identity origin-conversation-identity">
          <span className="dm-conversation-avatar dm-conversation-avatar--icon" aria-hidden="true">
            <Atom size={18} />
          </span>
          <span className="dm-conversation-copy">
            <strong>{title}</strong>
            <small className={`dm-presence-label ${running ? 'working' : 'idle'}`}>
              {running ? 'Running' : 'Origin Session'}
            </small>
          </span>
        </div>
        <div className="dm-conversation-meta">
          <span className="session-model-trigger subtle" title={model}>{model}</span>
          {running ? (
            <button
              className="shell-button ghost sm"
              onClick={() => void useOriginStore.getState().stop(activeOriginId)}
              type="button"
            >
              <Square size={12} /> Stop
            </button>
          ) : null}
          <button
            aria-label="Delete Origin"
            className="shell-button ghost sm"
            disabled={loading || running}
            onClick={() => void deleteOriginEntry(activeOriginId)}
            title="Delete Origin permanently"
            type="button"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </header>

      <div className="session-transcript" ref={transcriptRef}>
        {loading && !session ? (
          <div className="dm-beginning"><Loader2 className="spin" size={18} /><span>Loading Origin</span></div>
        ) : null}
        {!loading && messages.length === 0 && streaming === undefined ? (
          <div className="dm-beginning origin-beginning">
            <strong>Begin at the origin</strong>
            <span>This Session talks directly to the runtime. No DM, Channel, or fixed identity.</span>
          </div>
        ) : null}
        {messages.map((message) => <OriginMessageRow key={message.id} message={message} />)}
        {streaming !== undefined ? (
          <div className="session-message assistant streaming">
            <div className="session-message-head"><span>Origin</span><Loader2 className="spin" size={12} /></div>
            {streaming ? (
              <div className="session-message-text markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streaming}</ReactMarkdown>
              </div>
            ) : <span className="streaming-cursor" />}
          </div>
        ) : null}
        {error ? <div className="origin-session-error">{error}</div> : null}
      </div>

      <div className={`session-compose${slashQuery && skillCandidates.length > 0 ? ' has-skill-menu' : ''}`}>
        {slashQuery && skillCandidates.length > 0 ? (
          <div className="skill-command-menu" id="origin-skill-menu" ref={skillMenuRef} role="listbox">
            {skillCandidates.map((skill, index) => (
              <button
                aria-selected={index === activeSkillIndex}
                className={`skill-command-option${index === activeSkillIndex ? ' active' : ''}`}
                id={`origin-skill-option-${skill.name}`}
                key={skill.name}
                onClick={() => chooseSkill(skill)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveSkillIndex(index)}
                role="option"
                type="button"
              >
                <Box aria-hidden="true" size={17} strokeWidth={1.8} />
                <span className="skill-command-name">{skill.displayName}</span>
                <span className="skill-command-description">{skill.description}</span>
                {index === activeSkillIndex ? <kbd>↑↓</kbd> : null}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={promptRef}
          aria-activedescendant={slashQuery && skillCandidates[activeSkillIndex]
            ? `origin-skill-option-${skillCandidates[activeSkillIndex].name}`
            : undefined}
          aria-controls={slashQuery && skillCandidates.length > 0 ? 'origin-skill-menu' : undefined}
          aria-expanded={Boolean(slashQuery && skillCandidates.length > 0)}
          aria-haspopup="listbox"
          disabled={loading || running}
          onBlur={() => setSlashQuery(null)}
          onChange={(event) => {
            const value = event.target.value;
            useOriginStore.getState().setDraft(value);
            if (activeOriginId) {
              setSelectedSkillsByOrigin((current) => ({
                ...current,
                [activeOriginId]: (current[activeOriginId] ?? [])
                  .filter((name) => containsSkillReference(value, name)),
              }));
            }
            updateSlashQuery(value, event.target.selectionStart);
          }}
          onClick={(event) => updateSlashQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (slashQuery) {
              if (event.key === 'ArrowDown' && skillCandidates.length > 0) {
                event.preventDefault();
                setActiveSkillIndex((index) => (index + 1) % skillCandidates.length);
                return;
              }
              if (event.key === 'ArrowUp' && skillCandidates.length > 0) {
                event.preventDefault();
                setActiveSkillIndex((index) => (index - 1 + skillCandidates.length) % skillCandidates.length);
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && skillCandidates[activeSkillIndex]) {
                event.preventDefault();
                chooseSkill(skillCandidates[activeSkillIndex]);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setSlashQuery(null);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (draft.trim()) void useOriginStore.getState().send(selectedSkillNames);
            }
          }}
          placeholder={running ? 'Origin is running…' : 'Message this Origin directly'}
          rows={3}
          value={draft}
        />
        <div className="session-compose-actions">
          <span className="origin-compose-note">Direct Runtime Session</span>
          <button
            aria-label="Send message"
            className="shell-button primary lg session-submit"
            disabled={!draft.trim() || loading || running}
            onClick={() => void useOriginStore.getState().send(selectedSkillNames)}
            type="button"
          >
            <ArrowUp size={16} /><span className="session-submit-label">Send</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function OriginMessageRow({ message }: { message: AgentMessage }) {
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Origin' : 'Tool';
  const content = message.error || message.content;
  if (!content && message.role === 'toolResult') return null;
  return (
    <div className={`session-message ${message.role}`}>
      <div className="session-message-head">
        <span>{label}</span>
        <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
      </div>
      {content ? (
        <div className="session-message-text markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
}
