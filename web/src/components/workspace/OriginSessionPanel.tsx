/** OriginSessionPanel renders an in-memory draft or a persisted identity-free Runtime Session. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { OriginAvatar } from '../../avatar';
import { deleteOriginEntry } from '../../chat/originWorkspace';
import { originRuntimeLabel } from '../../chat/originCatalog';
import { buildOriginTimeline, type OriginToolActivity } from '../../chat/originTimeline';
import { useOriginStore } from '../../stores/originStore';
import type {
  AgentMessage,
  ImageAttachment,
  OriginSession,
  OriginSessionSummary,
} from '../../types';
import { SessionMessageRow } from '../chat/SessionMessageRow';
import { ToolCallGroup, ToolCallRow } from '../chat/ToolCallRow';
import { OriginComposer } from './OriginComposer';
import './OriginSessionPanel.css';

const EMPTY_ACTIVITY: OriginToolActivity[] = [];

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Openers that show what an Origin is good for without pretending to be smart. */
const DRAFT_SUGGESTIONS = [
  'Summarise today’s news for my watchlist',
  'Review my open positions and flag the risky ones',
  'Sketch a momentum rule for BTC and backtest it',
];

export function OriginSessionPanel() {
  const selection = useOriginStore((state) => state.selection);
  const sessionId = selection?.kind === 'session' ? selection.sessionId : null;
  const draft = selection?.kind === 'draft' ? selection.draft : null;
  const session = useOriginStore((state) => (
    sessionId ? state.sessionById[sessionId] ?? null : null
  ));
  const summary = useOriginStore((state) => (
    sessionId ? state.origins.find((item) => item.id === sessionId) ?? null : null
  ));
  const streaming = useOriginStore((state) => (
    sessionId ? state.streamingById[sessionId] : undefined
  ));
  const toolActivity = useOriginStore((state) => (
    sessionId ? state.toolActivityById[sessionId] ?? EMPTY_ACTIVITY : EMPTY_ACTIVITY
  ));
  const running = useOriginStore((state) => (
    sessionId ? state.runningIds.has(sessionId) : false
  ));
  const loading = useOriginStore((state) => state.loading);
  const error = useOriginStore((state) => state.error);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const [previewImage, setPreviewImage] = useState<ImageAttachment | null>(null);

  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);

  useEffect(() => {
    setPreviewImage(null);
  }, [draft?.materializationId, sessionId]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages.length, sessionId, streaming]);

  if (!selection) return null;

  return (
    <div className={`origin-session-panel${draft ? ' origin-session-panel--draft' : ''}`}>
      {draft ? (
        <main className="origin-draft-stage">
          <div className="origin-draft-content">
            <div className="origin-draft-heading">
              <span className="origin-draft-mark" aria-hidden="true"><OriginAvatar size="xl" /></span>
              <h1>What should Origin work on?</h1>
              <p>
                Every Origin is a throwaway agent: no memory, no identity, its own
                working directory. Nothing carries over from your Agents or from
                earlier Origins.
              </p>
            </div>
            <OriginComposer />
            {error ? <div className="origin-inline-error" role="alert">{error}</div> : null}
            <div className="origin-draft-suggestions">
              <span className="origin-draft-suggestions-label">Try</span>
              {DRAFT_SUGGESTIONS.map((suggestion) => (
                <button
                  className="origin-suggestion"
                  key={suggestion}
                  onClick={() => {
                    useOriginStore.getState().setMessage(suggestion);
                    requestAnimationFrame(() => {
                      document.querySelector<HTMLTextAreaElement>('.origin-draft-content .composer-input')?.focus();
                    });
                  }}
                  type="button"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        </main>
      ) : sessionId ? (
        <>
          <OriginHeader
            loading={loading && !session}
            onDelete={() => void deleteOriginEntry(sessionId)}
            projected={session?.session ?? summary}
            running={running}
          />
          <OriginTimeline
            loading={loading && !session}
            messages={messages}
            onPreviewImage={setPreviewImage}
            streaming={streaming}
            toolActivity={toolActivity}
            transcriptRef={transcriptRef}
            workspace={session?.session?.workspace ?? null}
          />
          <div className="composer-dock origin-session-dock">
            <OriginComposer />
            {error ? <div className="origin-inline-error" role="alert">{error}</div> : null}
          </div>
        </>
      ) : null}

      {previewImage ? (
        <button
          aria-label="Close image preview"
          className="origin-image-lightbox"
          onClick={() => setPreviewImage(null)}
          type="button"
        >
          <img
            alt="Message attachment preview"
            src={`data:${previewImage.mimeType};base64,${previewImage.data}`}
          />
        </button>
      ) : null}
    </div>
  );
}

function OriginHeader({
  loading,
  onDelete,
  projected,
  running,
}: {
  loading: boolean;
  onDelete(): void;
  projected: OriginSession | OriginSessionSummary | null;
  running: boolean;
}) {
  const model = projected?.model || originRuntimeLabel(projected?.runtime ?? 'pi');
  const deleteTitle = projected?.runtime === 'cursor'
    ? 'Delete Origin data; Cursor native chat will remain'
    : 'Delete Origin permanently';
  return (
    <header className="origin-session-header">
      <div className="origin-session-identity">
        <span className="origin-session-avatar" aria-hidden="true">
          <OriginAvatar seed={projected?.id} size="lg" />
        </span>
        <span className="origin-session-copy">
          <strong>{projected?.title || 'Origin'}</strong>
          <small className={running ? 'working' : ''}>
            {loading ? 'Loading' : running ? 'Running' : 'Ready'}
          </small>
        </span>
      </div>
      <div className="origin-session-meta">
        <span className="origin-session-model" title={model}>{model}</span>
        <button
          aria-label="Delete Origin"
          className="origin-icon-button origin-delete-button"
          disabled={loading || running}
          onClick={onDelete}
          title={deleteTitle}
          type="button"
        >
          <Trash2 size={15} />
        </button>
      </div>
    </header>
  );
}

function OriginTimeline({
  loading,
  messages,
  onPreviewImage,
  streaming,
  toolActivity,
  transcriptRef,
  workspace,
}: {
  loading: boolean;
  messages: AgentMessage[];
  onPreviewImage(image: ImageAttachment): void;
  streaming: string | undefined;
  toolActivity: OriginToolActivity[];
  transcriptRef: React.RefObject<HTMLDivElement | null>;
  workspace: string | null;
}) {
  const items = useMemo(
    () => buildOriginTimeline({ messages, activity: toolActivity, workspace }),
    [messages, toolActivity, workspace],
  );
  return (
    <div className="session-transcript origin-session-timeline" ref={transcriptRef}>
      {loading ? (
        <div className="origin-timeline-status" role="status">
          <Loader2 className="spin" size={18} />
          <span>Loading Origin</span>
        </div>
      ) : null}
      {!loading && messages.length === 0 && streaming === undefined ? (
        <div className="origin-timeline-status">
          <OriginAvatar size="lg" />
          <span>No messages yet</span>
        </div>
      ) : null}
      {items.map((item) => (item.kind === 'message' ? (
        <OriginMessageRow key={item.key} message={item.message} onPreviewImage={onPreviewImage} />
      ) : (
        <ToolCallGroup key={item.key}>
          {item.calls.map(({ key, ...call }) => <ToolCallRow call={call} key={key} />)}
        </ToolCallGroup>
      )))}
      {streaming !== undefined ? (
        <SessionMessageRow
          className="streaming"
          content={streaming || null}
          headAccessory={<Loader2 className="spin" size={12} />}
          label="Origin"
          role="assistant"
          streaming
        />
      ) : null}
    </div>
  );
}

export function OriginMessageRow({
  message,
  onPreviewImage,
}: {
  message: AgentMessage;
  onPreviewImage(image: ImageAttachment): void;
}) {
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Origin' : 'Tool';
  const images = messageImages(message);
  if (!message.content && !message.error && images.length === 0 && message.role === 'toolResult') {
    return null;
  }
  return (
    <SessionMessageRow
      content={message.content || null}
      createdAt={message.createdAt}
      error={message.error}
      images={images}
      label={label}
      onPreviewImage={onPreviewImage}
      role={message.role}
    />
  );
}

function messageImages(message: AgentMessage): ImageAttachment[] {
  const images = message.metadata?.images;
  if (!Array.isArray(images)) return [];
  return images.filter((image): image is ImageAttachment => {
    if (!image || typeof image !== 'object') return false;
    const candidate = image as Record<string, unknown>;
    return typeof candidate.data === 'string'
      && typeof candidate.mimeType === 'string'
      && SUPPORTED_IMAGE_TYPES.has(candidate.mimeType);
  });
}
