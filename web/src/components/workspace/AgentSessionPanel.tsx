/**
 * AgentSessionPanel — Agent Context runner：头栏 + composer。
 * DM transcript 在 DirectMessageTimeline；本面板负责发消息与上下文用量展示。
 */
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import './AgentSessionPanel.css';

import {
  Bot,
  CircleDot,
  Paperclip,
  Square,
  X,
  Zap,
} from 'lucide-react';
import { ProviderIcon } from '../ProviderIcon';
import type { AgentDirectMessage } from '../../types';
import { useChatPresence } from '../../chat/presenceStore';
import { projectDirectMessageTimeline } from '../../chat/directMessageTimeline';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { contextUsagePercent, formatContextPercent, resolveContextWindow } from '../../utils/contextUsage';
import { processImageForUpload } from '../../utils/imageResize';
import { DirectMessageTimeline } from './DirectMessageTimeline';

const EMPTY_DIRECT_MESSAGES: AgentDirectMessage[] = [];

/**
 * Format token counts for compact display.
 */
function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Agent Context 头栏 + composer（选中 Agent 的 DM runner）。 */
export function AgentSessionPanel({
  providerProfiles: _providerProfiles,
  disabled,
}: {
  providerProfiles: Record<string, { enabled: boolean; models: string[]; modelEfforts: Record<string, string> }>;
  disabled: boolean;
}) {
  const selectedAgentId = useAgentStore((s) => s.selectedAgentId);
  const selectedAgent = useAgentStore((s) => s.agents.find((agent) => agent.id === s.selectedAgentId) ?? null);
  const agentSession = useAgentStore((s) => s.agentSession);
  const agentPrompt = useAgentStore((s) => s.agentPrompt);
  const agentBusyKey = useAgentStore((s) => s.agentBusyKey);
  const agentChatActionKey = useAgentStore((s) => s.agentChatActionKey);
  const agentSessionLoadingKey = useAgentStore((s) => s.agentSessionLoadingKey);
  const modelRegistry = useAgentStore((s) => s.modelRegistry);
  const contextUsage = useAgentStore((s) => s.contextUsage);
  const streamingMessage = useAgentStore((s) => s.streamingMessage);
  const queuedFollowUps = useAgentStore((s) => s.queuedFollowUps);
  const directMessageId = useAgentStore((s) => s.directMessageIdByAgentId[s.selectedAgentId] ?? null);
  const directMessages = useAgentStore((s) => {
    const messages = s.directMessagesByAgentId[s.selectedAgentId];
    return messages ?? EMPTY_DIRECT_MESSAGES;
  });
  const presenceByAgentId = useChatPresence();
  const presence = presenceByAgentId[selectedAgentId] ?? null;

  const pendingImages = useAgentStore((s) => s.pendingImages);
  const addPendingImage = useAgentStore((s) => s.addPendingImage);
  const removePendingImage = useAgentStore((s) => s.removePendingImage);

  const setAgentPrompt = useAgentStore((s) => s.setAgentPrompt);
  const runAgentAnalysis = useAgentStore((s) => s.runAgentAnalysis);
  const removeFollowUp = useAgentStore((s) => s.removeFollowUp);
  const clearFollowUps = useAgentStore((s) => s.clearFollowUps);
  const abortAgent = useAgentStore((s) => s.abortAgent);
  const agentProfileOpen = useChatStore((s) => s.agentProfileOpen);
  const toggleAgentProfile = useChatStore((s) => s.toggleAgentProfile);

  const busy = agentBusyKey !== null;
  const sessionLoading = agentSessionLoadingKey !== null;
  const chatActionKey = agentChatActionKey;
  const agentDisplayName = selectedAgent?.name ?? 'Agent';
  const presenceLabel = presence?.paused
    ? 'Paused'
    : presence?.running || busy
      ? 'Online'
      : presence?.status === 'error'
        ? 'Error'
        : presence?.status === 'idle'
          ? 'Online'
          : (presence?.status ?? 'Offline');

  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptScrollByTargetRef = useRef<Map<string, number>>(new Map());
  const shouldFollowTranscriptRef = useRef(true);
  const timelineKey = directMessageId;
  const messages = useMemo(
    () => projectDirectMessageTimeline(directMessageId, directMessages),
    [directMessageId, directMessages],
  );
  const isClaudeAgent = selectedAgent?.runtime === 'claude-code';
  // Agent definition is the source of truth after provider/model became create-time fixed.
  // Session/local leftovers must not override the bound Agent routing.
  const boundProvider = selectedAgent?.provider
    ?? agentSession?.session?.provider
    ?? null;
  const boundModel = selectedAgent?.model
    ?? agentSession?.session?.model
    ?? null;
  const boundProviderOption = modelRegistry?.providers.find((provider) => (
    provider.providerId === boundProvider || provider.configProviderId === boundProvider
  ));
  const boundModelOption = (modelRegistry?.models ?? []).find((model) => (
    model.id === boundModel
    && (
      !boundProvider
      || model.providerId === boundProvider
      || model.providerId === boundProviderOption?.providerId
    )
  ));
  const modelLabel = isClaudeAgent
    ? (boundModel || 'Local Claude default')
    : (boundModelOption?.name || boundModel || 'No model bound');
  const lastMessage = messages[messages.length - 1] ?? null;
  const lastMessageToolCallCount = 0;

  const canSend = !disabled && !sessionLoading && !chatActionKey
    && (!!agentPrompt.trim() || pendingImages.length > 0);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !timelineKey) return;
    const savedScroll = transcriptScrollByTargetRef.current.get(timelineKey);
    if (savedScroll !== undefined) {
      transcript.scrollTop = savedScroll;
      shouldFollowTranscriptRef.current = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 48;
    } else {
      transcript.scrollTop = transcript.scrollHeight;
      shouldFollowTranscriptRef.current = true;
    }
  }, [timelineKey, sessionLoading]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !timelineKey || sessionLoading || !shouldFollowTranscriptRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
    transcriptScrollByTargetRef.current.set(timelineKey, transcript.scrollTop);
  }, [
    timelineKey,
    sessionLoading,
    messages.length,
    lastMessage?.id,
    lastMessage?.content,
    lastMessage?.error,
    lastMessageToolCallCount,
    streamingMessage?.content,
    queuedFollowUps.length,
  ]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImageFiles = useCallback(async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      const resized = await processImageForUpload(file);
      if (resized) {
        addPendingImage(resized);
      }
    }
  }, [addPendingImage]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      void handleImageFiles(imageFiles);
    }
  }, [handleImageFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      void handleImageFiles(files);
    }
  }, [handleImageFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const contextWindow = isClaudeAgent || !boundProvider || !boundModel
    ? null
    : resolveContextWindow(boundProvider, boundModel, modelRegistry);
  const rawContextPercent = contextUsagePercent(contextUsage, contextWindow);
  const contextPercentLabel = formatContextPercent(rawContextPercent);
  const contextPercentLevel = rawContextPercent ?? 0;

  return (
    <div className="agent-card agent-readout agent-session-card">
      <header className="dm-conversation-header">
        <button
          aria-expanded={agentProfileOpen}
          aria-label={`Open ${agentDisplayName} profile`}
          className={`dm-conversation-identity${agentProfileOpen ? ' open' : ''}`}
          onClick={() => toggleAgentProfile()}
          type="button"
        >
          <span className="dm-conversation-avatar" aria-hidden="true">
            <Bot size={16} />
          </span>
          <span className="dm-conversation-copy">
            <strong>{agentDisplayName}</strong>
            <small className={`dm-presence-label ${presence?.running || busy ? 'online' : presence?.paused ? 'paused' : ''}`}>
              {presenceLabel}
            </small>
          </span>
        </button>
        <div className="dm-conversation-meta">
          {busy && <span className="agent-bias neutral">running</span>}
          {busy && (
            <button
              className="shell-button ghost sm"
              type="button"
              onClick={() => void abortAgent()}
              title="Abort (Esc)"
            >
              <Square size={12} />
            </button>
          )}
          {contextPercentLabel !== null && (
            <span className={`badge mono${contextPercentLevel > 90 ? ' danger' : contextPercentLevel > 70 ? ' warning' : ''}`}>
              <CircleDot size={10} /> {contextPercentLabel}%{contextWindow ? `/${formatTokenCount(contextWindow)}` : ''}
            </span>
          )}
          <button className="session-model-trigger subtle" type="button" disabled title="Provider and model are fixed for this Agent">
            {!isClaudeAgent && boundProviderOption && (
              <span className="session-model-provider-icon">
                <ProviderIcon provider={boundProviderOption.providerId} size={14} />
              </span>
            )}
            <span>{modelLabel}</span>
          </button>
        </div>
      </header>
      <DirectMessageTimeline
        agentDisplayName={agentDisplayName}
        directMessageId={directMessageId}
        directMessages={directMessages}
        onClearFollowUps={clearFollowUps}
        onRemoveFollowUp={removeFollowUp}
        onScroll={(event) => {
          if (!timelineKey) return;
          const transcript = event.currentTarget;
          shouldFollowTranscriptRef.current = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 48;
          transcriptScrollByTargetRef.current.set(timelineKey, transcript.scrollTop);
        }}
        queuedFollowUps={queuedFollowUps}
        sessionLoading={sessionLoading}
        streamingContent={streamingMessage ? streamingMessage.content : null}
        transcriptRef={transcriptRef}
      />
      <div className="session-compose" onDrop={handleDrop} onDragOver={handleDragOver}>
        {pendingImages.length > 0 && (
          <div className="session-pending-images">
            {pendingImages.map((img, idx) => (
              <div key={idx} className="pending-image-thumb">
                <img src={`data:${img.mimeType};base64,${img.data}`} alt={`Attachment ${idx + 1}`} />
                <button
                  type="button"
                  className="pending-image-remove"
                  onClick={() => removePendingImage(idx)}
                  title="Remove image"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={promptTextareaRef}
          disabled={disabled || sessionLoading}
          onChange={(event) => setAgentPrompt(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && busy) {
              event.preventDefault();
              void abortAgent();
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) void runAgentAnalysis();
            }
          }}
          placeholder={
            busy
              ? 'Queue a follow-up. Esc to abort the current run.'
              : pendingImages.length > 0
                ? `Add a note for @${agentDisplayName}, or send the image alone.`
                : `Message @${agentDisplayName}`
          }
          rows={3}
          value={agentPrompt}
        />
        <div className="session-compose-actions">
          <button
            className="shell-button sm"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || sessionLoading}
            title="Attach image (or paste/drop)"
          >
            <Paperclip size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files) void handleImageFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            aria-label={busy ? 'Queue Follow-up' : 'Send message'}
            className="shell-button primary lg session-submit"
            type="button"
            onClick={() => {
              void runAgentAnalysis();
            }}
            disabled={!canSend}
          >
            {busy ? <Zap size={16} /> : <Bot size={16} />}
            <span className="session-submit-label">
              {busy ? 'Queue' : 'Send'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
