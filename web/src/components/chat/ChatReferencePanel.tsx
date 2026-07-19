/**
 * ChatReferencePanel — Saved / Pinned 列表面板；导航走 referenceResolver。
 */
import { Bookmark, Hash, Pin } from 'lucide-react';
import { openReference, projectReference } from '../../chat/referenceResolver';
import { useChatStore } from '../../stores/chatStore';

/** 展示当前 Saved 或 Pinned 集合。 */
export function ChatReferencePanel() {
  const collection = useChatStore((state) => state.activeCollection);
  const references = useChatStore((state) => (collection === 'saved' ? state.saved : state.pinned));

  if (!collection) return null;

  return (
    <section className="chat-reference-panel">
      <header>
        {collection === 'saved' ? <Bookmark size={16} /> : <Pin size={16} />}
        <div>
          <strong>{collection === 'saved' ? 'Saved' : 'Pinned'}</strong>
          <small>Messages across Direct Messages and Channels</small>
        </div>
      </header>
      <div className="chat-reference-list">
        {!references.length ? <div className="empty-state row">No {collection} messages.</div> : null}
        {references.map((reference) => {
          const projection = projectReference(reference);
          return (
            <button
              key={`${JSON.stringify(reference.target)}:${reference.messageId}`}
              onClick={() => void openReference(reference)}
              type="button"
            >
              <span>{reference.target.kind === 'channel' ? <Hash size={13} /> : projection.label.slice(0, 1)}</span>
              <span><strong>{projection.label}</strong><small>{projection.content}</small></span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
