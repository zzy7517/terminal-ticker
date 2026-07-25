/**
 * AgentSessionPanel — Agent Context runner：头栏 + composer。
 * DM transcript 在 DirectMessageTimeline；本面板负责发消息。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import '../../styles/chat/index.css';

import {
  ArrowUp,
  Box,
  Paperclip,
  Play,
  Square,
  X,
  Zap,
} from 'lucide-react';
import { fetchAgentSkills, pauseChatAgent, resumeChatAgent } from '../../api';
import { AgentAvatar, avatarSeedSource } from '../../avatar';
import { ProviderIcon } from '../ProviderIcon';
import type { AgentDirectMessage, AgentSkillSummary } from '../../types';
import { agentPresenceView } from '../../chat/presenceDisplay';
import { useChatPresence, usePresenceStore } from '../../chat/presenceStore';
import { projectDirectMessageTimeline } from '../../chat/directMessageTimeline';
import {
  containsSkillReference,
  insertSkillReference,
  matchingSkills,
  skillSlashQuery,
  type SkillSlashQuery,
} from '../../chat/skillCompletion';
import { useAgentStore } from '../../stores/agentStore';
import { useChatStore } from '../../stores/chatStore';
import { processImageForUpload } from '../../utils/imageResize';
import { DirectMessageTimeline } from './DirectMessageTimeline';

const EMPTY_DIRECT_MESSAGES: AgentDirectMessage[] = [];

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
  const agentProfileOpen = useChatStore((s) => s.agentProfileOpen);
  const toggleAgentProfile = useChatStore((s) => s.toggleAgentProfile);

  const busy = agentBusyKey !== null;
  const sessionLoading = agentSessionLoadingKey !== null;
  const chatActionKey = agentChatActionKey;
  const agentDisplayName = selectedAgent?.name ?? 'Agent';
  const { label: presenceLabel, tone: presenceTone } = agentPresenceView(presence, { busy });

  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptScrollByTargetRef = useRef<Map<string, number>>(new Map());
  const shouldFollowTranscriptRef = useRef(true);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const [skillCatalog, setSkillCatalog] = useState<AgentSkillSummary[]>([]);
  const [slashQuery, setSlashQuery] = useState<SkillSlashQuery | null>(null);
  const [activeSkillIndex, setActiveSkillIndex] = useState(0);
  const [selectedSkillNamesByAgent, setSelectedSkillNamesByAgent] = useState<Record<string, string[]>>({});
  const timelineKey = directMessageId;
  const messages = useMemo(
    () => projectDirectMessageTimeline(directMessageId, directMessages),
    [directMessageId, directMessages],
  );
  const isClaudeAgent = selectedAgent?.runtime === 'claude-code';
  const isCursorAgent = selectedAgent?.runtime === 'cursor';
  const isExternalCliAgent = isClaudeAgent || isCursorAgent;
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
    : isCursorAgent
      ? (boundModel || 'Local Cursor default')
      : (boundModelOption?.name || boundModel || 'No model bound');
  // Path-style ids ("openrouter/anthropic/claude-…") would truncate at the
  // tail and hide the actual model; show the final segment, full id in title.
  const modelDisplayLabel = modelLabel.includes('/')
    ? modelLabel.slice(modelLabel.lastIndexOf('/') + 1)
    : modelLabel;
  const lastMessage = messages[messages.length - 1] ?? null;
  const lastMessageToolCallCount = 0;
  const skillCandidates = useMemo(
    () => slashQuery ? matchingSkills(skillCatalog, slashQuery.query) : [],
    [skillCatalog, slashQuery],
  );
  const selectedSkillNames = selectedSkillNamesByAgent[selectedAgentId] ?? [];

  const canSend = !disabled && !sessionLoading && !chatActionKey
    && (!!agentPrompt.trim() || pendingImages.length > 0);

  useEffect(() => {
    let disposed = false;
    void fetchAgentSkills()
      .then((skills) => { if (!disposed) setSkillCatalog(skills); })
      .catch((error) => console.error('Agent skills fetch failed:', error));
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (agentPrompt) return;
    setSlashQuery(null);
    setSelectedSkillNamesByAgent((current) => (
      current[selectedAgentId]?.length
        ? { ...current, [selectedAgentId]: [] }
        : current
    ));
  }, [agentPrompt, selectedAgentId]);

  useLayoutEffect(() => {
    const menu = skillMenuRef.current;
    const activeOption = menu?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!menu || !activeOption) return;
    const optionTop = activeOption.offsetTop;
    const optionBottom = optionTop + activeOption.offsetHeight;
    if (optionTop < menu.scrollTop) {
      menu.scrollTop = optionTop;
    } else if (optionBottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = optionBottom - menu.clientHeight;
    }
  }, [activeSkillIndex, skillCandidates]);

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

  const updateSlashQuery = useCallback((value: string, caret: number | null) => {
    const next = skillSlashQuery(value, caret ?? value.length);
    setSlashQuery(next);
    setActiveSkillIndex(0);
  }, []);

  const chooseSkill = useCallback((skill: AgentSkillSummary) => {
    if (!slashQuery) return;
    const insertion = insertSkillReference(agentPrompt, slashQuery, skill.name);
    setAgentPrompt(insertion.value);
    setSelectedSkillNamesByAgent((current) => ({
      ...current,
      [selectedAgentId]: [...new Set([...(current[selectedAgentId] ?? []), skill.name])],
    }));
    setSlashQuery(null);
    requestAnimationFrame(() => {
      promptTextareaRef.current?.focus();
      promptTextareaRef.current?.setSelectionRange(insertion.caret, insertion.caret);
    });
  }, [agentPrompt, selectedAgentId, setAgentPrompt, slashQuery]);

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
            <AgentAvatar agent={avatarSeedSource(selectedAgentId, selectedAgent)} size="lg" />
          </span>
          <span className="dm-conversation-copy">
            <strong>{agentDisplayName}</strong>
            <small className={`dm-presence-label ${presenceTone}`}>
              {presenceLabel}
            </small>
          </span>
        </button>
        <div className="dm-conversation-meta">
          {presenceTone === 'working' && <span className="agent-bias neutral">working</span>}
          {selectedAgentId ? (
            <button
              className="shell-button ghost sm"
              onClick={() => void (presence?.paused
                ? resumeChatAgent(selectedAgentId)
                : pauseChatAgent(selectedAgentId)
              ).then(() => usePresenceStore.getState().refresh())}
              title={presence?.paused ? 'Resume this Agent' : 'Stop this Agent'}
              type="button"
            >
              {presence?.paused ? <Play size={12} /> : <Square size={12} />}
              {presence?.paused ? 'Resume' : 'Stop'}
            </button>
          ) : null}
          <button
            className="session-model-trigger subtle"
            type="button"
            disabled
            title={`${modelLabel} — provider and model are fixed for this Agent`}
          >
            {!isExternalCliAgent && boundProviderOption && (
              <span className="session-model-provider-icon">
                <ProviderIcon provider={boundProviderOption.providerId} size={14} />
              </span>
            )}
            <span>{modelDisplayLabel}</span>
          </button>
        </div>
      </header>
      <DirectMessageTimeline
        agentId={selectedAgentId ?? ''}
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
      <div
        className={`session-compose${slashQuery && skillCandidates.length > 0 ? ' has-skill-menu' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {slashQuery && skillCandidates.length > 0 && (
          <div className="skill-command-menu" id="agent-skill-menu" ref={skillMenuRef} role="listbox">
            {skillCandidates.map((skill, index) => (
              <button
                aria-selected={index === activeSkillIndex}
                className={`skill-command-option${index === activeSkillIndex ? ' active' : ''}`}
                id={`agent-skill-option-${skill.name}`}
                key={skill.name}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveSkillIndex(index)}
                onClick={() => chooseSkill(skill)}
                role="option"
                type="button"
              >
                <Box aria-hidden="true" size={17} strokeWidth={1.8} />
                <span className="skill-command-name">{skill.displayName}</span>
                <span className="skill-command-description">{skill.description}</span>
                {index === activeSkillIndex && <kbd>↑↓</kbd>}
              </button>
            ))}
          </div>
        )}
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
          aria-activedescendant={
            slashQuery && skillCandidates[activeSkillIndex]
              ? `agent-skill-option-${skillCandidates[activeSkillIndex].name}`
              : undefined
          }
          aria-controls={slashQuery && skillCandidates.length > 0 ? 'agent-skill-menu' : undefined}
          aria-expanded={Boolean(slashQuery && skillCandidates.length > 0)}
          aria-haspopup="listbox"
          disabled={disabled || sessionLoading}
          onBlur={() => setSlashQuery(null)}
          onChange={(event) => {
            const value = event.target.value;
            setAgentPrompt(value);
            setSelectedSkillNamesByAgent((current) => ({
              ...current,
              [selectedAgentId]: (current[selectedAgentId] ?? [])
                .filter((name) => containsSkillReference(value, name)),
            }));
            updateSlashQuery(value, event.target.selectionStart);
          }}
          onClick={(event) => updateSlashQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
          onPaste={handlePaste}
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
              if (canSend) void runAgentAnalysis(undefined, { skillNames: selectedSkillNames });
            }
          }}
          placeholder={
            busy
              ? 'Queue a follow-up while the Agent is working.'
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
              void runAgentAnalysis(undefined, { skillNames: selectedSkillNames });
            }}
            disabled={!canSend}
          >
            {busy ? <Zap size={16} /> : <ArrowUp size={16} />}
            <span className="session-submit-label">
              {busy ? 'Queue' : 'Send'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
