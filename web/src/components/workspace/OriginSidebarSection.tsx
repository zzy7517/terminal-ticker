import { Atom, Loader2, Plus } from 'lucide-react';
import { openNewOriginEntry, openOriginEntry } from '../../chat/originWorkspace';
import { useChatStore } from '../../stores/chatStore';
import { useOriginStore } from '../../stores/originStore';

/** Identity-free Origin history. New starts as an in-memory draft. */
export function OriginSidebarSection() {
  const activeTarget = useChatStore((state) => state.activeTarget);
  const origins = useOriginStore((state) => state.origins);
  const selection = useOriginStore((state) => state.selection);
  const loading = useOriginStore((state) => state.loading);
  const activeSessionId = activeTarget?.kind === 'origin' && selection?.kind === 'session'
    ? selection.sessionId
    : null;

  return <>
    <header>
      ORIGIN <span>{origins.length}</span>
      <button
        aria-label="New Origin"
        className="chat-sidebar-add origin-sidebar-add"
        disabled={loading}
        onClick={() => openNewOriginEntry()}
        title="New Origin"
        type="button"
      >
        {loading ? <Loader2 className="spin" size={13} /> : <Plus size={14} />}
      </button>
    </header>
    {origins.map((origin) => (
      <button
        aria-current={activeSessionId === origin.id ? 'page' : undefined}
        className={`channel-sidebar-row origin-sidebar-row${activeSessionId === origin.id ? ' active' : ''}`}
        key={origin.id}
        onClick={() => void openOriginEntry(origin.id)}
        type="button"
      >
        <Atom aria-hidden="true" size={14} />
        <span className="origin-sidebar-copy">
          <strong>{origin.title || 'Origin'}</strong>
          <small>{origin.preview === '(no messages)' ? 'Ready' : origin.preview}</small>
        </span>
        {origin.run?.status === 'running' ? <span className="direct-message-presence working" /> : null}
      </button>
    ))}
  </>;
}
