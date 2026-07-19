/**
 * DirectMessageTimeline — 单个 Agent DM 的 Shared Message Fabric transcript UI。
 * Agent Context 流式输出 / composer 仍在 AgentSessionPanel。
 */
import type { RefObject, UIEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bookmark,
  Loader2,
  Pin,
  X,
} from 'lucide-react';
import type { AgentDirectMessage, ChatTarget } from '../../types';
import { useChatStore } from '../../stores/chatStore';
import { projectDirectMessageTimeline, type DirectMessageTimelineItem } from '../../chat/directMessageTimeline';

function DirectMessageRow({
  message,
  reference,
}: {
  message: DirectMessageTimelineItem;
  reference: { target: ChatTarget; messageId: string } | null;
}) {
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'System';
  const content = message.error || message.content || (message.role === 'assistant' ? '' : 'No content.');
  const toggleSaved = useChatStore((state) => state.toggleSaved);
  const togglePinned = useChatStore((state) => state.togglePinned);
  const saved = useChatStore((state) => reference ? state.saved.some((item) => (
    item.messageId === reference.messageId
    && item.target.kind === 'direct-message'
    && reference.target.kind === 'direct-message'
    && item.target.directMessageId === reference.target.directMessageId
  )) : false);
  const pinned = useChatStore((state) => reference ? state.pinned.some((item) => (
    item.messageId === reference.messageId
    && item.target.kind === 'direct-message'
    && reference.target.kind === 'direct-message'
    && item.target.directMessageId === reference.target.directMessageId
  )) : false);
  return (
    <div className={`session-message ${message.role}`}>
      <div className="session-message-head">
        <span>{label}</span>
        <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
        {reference ? (
          <span className="session-message-reference-actions">
            <button className={saved ? 'active' : ''} onClick={() => void toggleSaved(reference.target, reference.messageId)} title="Save message" type="button"><Bookmark size={11} /></button>
            <button className={pinned ? 'active' : ''} onClick={() => void togglePinned(reference.target, reference.messageId)} title="Pin message" type="button"><Pin size={11} /></button>
          </span>
        ) : null}
      </div>
      {content && (
        <div className="session-message-text markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export interface DirectMessageTimelineProps {
  directMessageId: string | null;
  directMessages: AgentDirectMessage[];
  sessionLoading: boolean;
  agentDisplayName: string;
  streamingContent: string | null;
  queuedFollowUps: Array<{ id: string; content: string; images: unknown[] }>;
  onClearFollowUps: () => void;
  onRemoveFollowUp: (id: string) => void;
  transcriptRef: RefObject<HTMLDivElement | null>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
}

/** DM Shared Message 时间线 UI（含 Saved/Pinned 快捷操作）。 */
export function DirectMessageTimeline({
  directMessageId,
  directMessages,
  sessionLoading,
  agentDisplayName,
  streamingContent,
  queuedFollowUps,
  onClearFollowUps,
  onRemoveFollowUp,
  transcriptRef,
  onScroll,
}: DirectMessageTimelineProps) {
  const messages = projectDirectMessageTimeline(directMessageId, directMessages);

  return (
    <div
      className="session-transcript"
      ref={transcriptRef}
      onScroll={onScroll}
    >
      {sessionLoading && (
        <div className="empty-state row">
          <Loader2 className="spin" size={16} />
          <span>Loading conversation</span>
        </div>
      )}
      {!sessionLoading && messages.length === 0 && !streamingContent && (
        <div className="dm-beginning">
          <strong>No messages yet</strong>
          <span>Start the conversation.</span>
        </div>
      )}
      {!sessionLoading && messages.map((message) => (
        <DirectMessageRow
          key={message.id}
          message={message}
          reference={directMessageId ? {
            target: { kind: 'direct-message', directMessageId },
            messageId: String(message.id),
          } : null}
        />
      ))}
      {!sessionLoading && streamingContent !== null && (
        <div className="session-message assistant streaming">
          <div className="session-message-head">
            <span>{agentDisplayName}</span>
            <Loader2 className="spin" size={12} />
          </div>
          {streamingContent && (
            <div className="session-message-text markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingContent}</ReactMarkdown>
            </div>
          )}
          {!streamingContent && (
            <span className="streaming-cursor" />
          )}
        </div>
      )}
      {!sessionLoading && queuedFollowUps.length > 0 && (
        <div className="session-follow-up-queue">
          <div className="session-follow-up-head">
            <span>{queuedFollowUps.length} follow-up{queuedFollowUps.length === 1 ? '' : 's'} queued</span>
            <button type="button" onClick={() => onClearFollowUps()} className="session-follow-up-clear">Clear</button>
          </div>
          {queuedFollowUps.map((item) => (
            <div key={item.id} className="session-follow-up-item">
              <span className="badge sm warning">queued</span>
              <span className="session-follow-up-text">{item.content || `${item.images.length} image${item.images.length === 1 ? '' : 's'}`}</span>
              <button type="button" onClick={() => onRemoveFollowUp(item.id)} className="session-follow-up-remove" title="Remove follow-up">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
