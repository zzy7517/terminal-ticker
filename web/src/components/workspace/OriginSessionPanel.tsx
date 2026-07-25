/** OriginSessionPanel — direct Runtime timeline without Agent identity or Chat fabric. */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, Atom, Loader2, Square, Trash2 } from 'lucide-react';
import { deleteOriginEntry } from '../../chat/originWorkspace';
import { useOriginStore } from '../../stores/originStore';
import type { AgentMessage } from '../../types';

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
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);

  useEffect(() => {
    if (activeOriginId && !session && !loading) void useOriginStore.getState().select(activeOriginId);
  }, [activeOriginId, loading, session]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages.length, streaming]);

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

      <div className="session-compose">
        <textarea
          disabled={loading || running}
          onChange={(event) => useOriginStore.getState().setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (draft.trim()) void useOriginStore.getState().send();
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
            onClick={() => void useOriginStore.getState().send()}
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
