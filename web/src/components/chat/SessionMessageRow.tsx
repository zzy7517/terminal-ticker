/**
 * Shared session message row — Markdown body used by Origin, Agent DM, and Channel.
 * Streaming / timeline assembly stay in each panel; this only paints one finished (or frozen) row.
 */
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImageAttachment } from '../../types';

export function SessionMessageRow({
  role,
  label,
  createdAt,
  content,
  error,
  images,
  onPreviewImage,
  leading,
  footer,
  className,
  as: Component = 'div',
  headAccessory,
  streaming,
}: {
  role: string;
  label: string;
  createdAt?: string | number | Date | null;
  content?: string | null;
  error?: string | null;
  images?: ImageAttachment[];
  onPreviewImage?: (image: ImageAttachment) => void;
  leading?: ReactNode;
  footer?: ReactNode;
  className?: string;
  as?: 'div' | 'article';
  headAccessory?: ReactNode;
  streaming?: boolean;
}) {
  const timeLabel = createdAt == null ? null : formatMessageTime(createdAt);
  const body = (
    <>
      <div className="session-message-head">
        <span className="session-message-author">
          <span>{label}</span>
          {headAccessory}
        </span>
        {timeLabel ? <time>{timeLabel}</time> : null}
      </div>
      {content ? (
        <div className="session-message-text markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : streaming ? (
        <span className="streaming-cursor" />
      ) : null}
      {error ? (
        <div className="session-message-error" role="note">{error}</div>
      ) : null}
      {images && images.length > 0 ? (
        <div className="session-message-images">
          {images.map((image, index) => (
            <button
              aria-label={`Preview attachment ${index + 1}`}
              className="message-image-thumb"
              key={`${image.mimeType}:${index}`}
              onClick={() => onPreviewImage?.(image)}
              type="button"
            >
              <img
                alt={`Message attachment ${index + 1}`}
                src={`data:${image.mimeType};base64,${image.data}`}
              />
            </button>
          ))}
        </div>
      ) : null}
      {footer}
    </>
  );

  return (
    <Component className={['session-message', role, className].filter(Boolean).join(' ')}>
      {leading ? (
        <>
          {leading}
          <div className="session-message-body">{body}</div>
        </>
      ) : (
        body
      )}
    </Component>
  );
}

function formatMessageTime(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString();
}
