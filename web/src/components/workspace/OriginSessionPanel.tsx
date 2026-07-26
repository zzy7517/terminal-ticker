/** OriginSessionPanel renders an in-memory draft or a persisted identity-free Runtime Session. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Atom, Loader2, Trash2 } from 'lucide-react';
import { deleteOriginEntry } from '../../chat/originWorkspace';
import { originRuntimeLabel } from '../../chat/originCatalog';
import { useOriginStore } from '../../stores/originStore';
import type {
  AgentMessage,
  ImageAttachment,
  OriginSession,
  OriginSessionSummary,
} from '../../types';
import { OriginComposer } from './OriginComposer';
import './OriginSessionPanel.css';

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

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
              <span className="origin-draft-mark" aria-hidden="true"><Atom size={23} /></span>
              <h1>New Origin</h1>
            </div>
            <OriginComposer />
            {error ? <div className="origin-inline-error" role="alert">{error}</div> : null}
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
            transcriptRef={transcriptRef}
          />
          <div className="origin-session-dock">
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
        <span className="origin-session-avatar" aria-hidden="true"><Atom size={18} /></span>
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
  transcriptRef,
}: {
  loading: boolean;
  messages: AgentMessage[];
  onPreviewImage(image: ImageAttachment): void;
  streaming: string | undefined;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="session-transcript origin-session-timeline" ref={transcriptRef}>
      {loading ? (
        <div className="origin-timeline-status" role="status">
          <Loader2 className="spin" size={18} />
          <span>Loading Origin</span>
        </div>
      ) : null}
      {!loading && messages.length === 0 && streaming === undefined ? (
        <div className="origin-timeline-status"><Atom size={22} /><span>Origin</span></div>
      ) : null}
      {messages.map((message) => (
        <OriginMessageRow key={message.id} message={message} onPreviewImage={onPreviewImage} />
      ))}
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
    </div>
  );
}

function OriginMessageRow({
  message,
  onPreviewImage,
}: {
  message: AgentMessage;
  onPreviewImage(image: ImageAttachment): void;
}) {
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Origin' : 'Tool';
  const content = message.error || message.content;
  const images = messageImages(message);
  if (!content && images.length === 0 && message.role === 'toolResult') return null;
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
      {images.length > 0 ? (
        <div className="session-message-images">
          {images.map((image, index) => (
            <button
              aria-label={`Preview attachment ${index + 1}`}
              className="message-image-thumb"
              key={`${image.mimeType}:${index}`}
              onClick={() => onPreviewImage(image)}
              type="button"
            >
              <img alt={`Message attachment ${index + 1}`} src={`data:${image.mimeType};base64,${image.data}`} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
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
