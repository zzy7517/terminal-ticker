/**
 * DirectMessageTimeline — 单个 Agent DM 的 Shared Message Fabric transcript UI。
 * Agent Context 流式输出 / composer 仍在 AgentSessionPanel。
 */
import type { RefObject, UIEvent } from 'react';
import {
  Loader2,
  X,
} from 'lucide-react';
import type { AgentDirectMessage } from '../../types';
import { useAgentStore } from '../../stores/agentStore';
import { projectDirectMessageTimeline, type DirectMessageTimelineItem } from '../../chat/directMessageTimeline';
import { MessageReactions } from '../chat/MessageReactions';
import { SessionMessageRow } from '../chat/SessionMessageRow';

function DirectMessageRow({
  agentId,
  message,
  source,
  agentDisplayName,
}: {
  agentId: string;
  message: DirectMessageTimelineItem;
  source: AgentDirectMessage | undefined;
  agentDisplayName: string;
}) {
  const label = message.role === 'user'
    ? 'You'
    : message.role === 'assistant'
      ? agentDisplayName
      : 'System';
  const content = message.error || message.content || (message.role === 'assistant' ? '' : 'No content.');
  const toggleDirectMessageReaction = useAgentStore((state) => state.toggleDirectMessageReaction);
  const reactions = source?.reactions ?? [];

  return (
    <SessionMessageRow
      content={content || null}
      createdAt={message.createdAt}
      footer={source && !source.deletedAtMs ? (
        <MessageReactions
          reactions={reactions}
          onToggle={(emoji) => void toggleDirectMessageReaction(agentId, source.id, emoji)}
        />
      ) : null}
      label={label}
      role={message.role}
    />
  );
}

export interface DirectMessageTimelineProps {
  agentId: string;
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

/** DM Shared Message 时间线 UI（含 Raft-style reaction 快捷操作）。 */
export function DirectMessageTimeline({
  agentId,
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
  const byId = new Map(directMessages.map((entry) => [entry.id, entry]));

  return (
    <div
      className="session-transcript"
      ref={transcriptRef}
      onScroll={onScroll}
    >
      {sessionLoading && (
        <div className="transcript-skeleton" role="status" aria-label="Loading conversation">
          <div className="transcript-skeleton-group user">
            <span className="skeleton bubble" />
          </div>
          <div className="transcript-skeleton-group">
            <span className="skeleton w-25" />
            <span className="skeleton w-85" />
            <span className="skeleton w-65" />
            <span className="skeleton w-45" />
          </div>
          <div className="transcript-skeleton-group">
            <span className="skeleton w-25" />
            <span className="skeleton w-65" />
          </div>
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
          agentId={agentId}
          agentDisplayName={agentDisplayName}
          message={message}
          source={byId.get(String(message.id))}
        />
      ))}
      {!sessionLoading && streamingContent !== null && (
        <SessionMessageRow
          className="streaming"
          content={streamingContent || null}
          headAccessory={<Loader2 className="spin" size={12} />}
          label={agentDisplayName}
          role="assistant"
          streaming
        />
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
