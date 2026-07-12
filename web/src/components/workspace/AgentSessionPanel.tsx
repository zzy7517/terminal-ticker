/** 展示聊天 Session、Runtime 能力、附件和流式控制。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import './AgentSessionPanel.css';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  History,
  ImageIcon,
  Loader2,
  Paperclip,
  Search,
  Sparkles,
  Square,
  X,
  Zap,
} from 'lucide-react';
import { ProviderIcon } from '../ProviderIcon';
import { forkSession, cloneSession } from '../../api';
import type { AgentMessage, AgentToolCall } from '../../types';
import { parseSlashCommand, getAutocompleteSuggestions, applyCompletion, type SlashCommand, type AutocompleteSuggestion, type CommandContext } from '../../slash-commands';
import { useAgentStore } from '../../stores/agentStore';
import { useMarketStore } from '../../stores/marketStore';
import { contextUsagePercent, formatContextPercent, resolveContextWindow } from '../../utils/contextUsage';
import { processImageForUpload } from '../../utils/imageResize';

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

function AgentToolStep({
  call,
  isPending,
  result,
}: {
  call: AgentToolCall;
  isPending: boolean;
  result: AgentMessage | undefined;
}) {
  const hasError = !!result?.metadata?.error;
  // Auto-expand if: pending (in-progress), or has error
  const [expanded, setExpanded] = useState(isPending || hasError);

  // Auto-expand when error arrives
  useEffect(() => {
    if (hasError) setExpanded(true);
  }, [hasError]);

  const hasArgs = Object.keys(call.arguments ?? {}).length > 0;
  const hasDetail = hasArgs || !!result;

  const toggle = useCallback(() => {
    if (hasDetail) setExpanded((v) => !v);
  }, [hasDetail]);

  return (
    <div key={call.id} className={`agent-tool-step${expanded ? ' expanded' : ''}`}>
      <div
        className={`tool-step-summary${hasDetail ? ' clickable' : ''}`}
        onClick={toggle}
      >
        {isPending ? <Loader2 className="spin" size={12} /> : <Zap size={12} />}
        <span className="tool-name">{call.name}</span>
        {!isPending && result && !hasError && <Check size={12} className="tool-done-icon" />}
        {hasError && <span className="badge sm danger">error</span>}
        {hasDetail && (
          <span className={`tool-step-chevron${expanded ? ' open' : ''}`}>
            <ChevronRight size={12} />
          </span>
        )}
      </div>
      {expanded && hasDetail && (
        <div className="tool-step-detail">
          {hasArgs && (
            <div className="tool-args">
              <small>Arguments</small>
              <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
            </div>
          )}
          {result && (
            <div className={`tool-output ${hasError ? 'error' : ''}`}>
              <small>Output</small>
              <pre>{result.content}</pre>
              {(result.metadata?.images as Array<{ data: string; mimeType: string }> | undefined)?.length ? (
                <MessageImages images={result.metadata!.images as Array<{ data: string; mimeType: string }>} />
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AgentToolCalls({
  pendingToolCalls,
  toolCalls,
  toolResultsById,
}: {
  pendingToolCalls: Set<string>;
  toolCalls: AgentToolCall[];
  toolResultsById: Map<string, AgentMessage>;
}) {
  return (
    <div className="agent-tool-steps">
      {toolCalls.map((call) => {
        const result = toolResultsById.get(call.id);
        const isPending = pendingToolCalls.has(call.id) && !result;
        return (
          <AgentToolStep
            key={call.id}
            call={call}
            isPending={isPending}
            result={result}
          />
        );
      })}
    </div>
  );
}

function MessageImages({ images }: { images: Array<{ data: string; mimeType: string }> }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  if (!images || images.length === 0) return null;
  return (
    <div className="session-message-images">
      {images.map((img, idx) => (
        <div key={idx} className="message-image-thumb" onClick={() => setExpanded(expanded === idx ? null : idx)}>
          <img src={`data:${img.mimeType};base64,${img.data}`} alt={`Image ${idx + 1}`} />
        </div>
      ))}
      {expanded !== null && images[expanded] && (
        <div className="message-image-lightbox" onClick={() => setExpanded(null)}>
          <img src={`data:${images[expanded].mimeType};base64,${images[expanded].data}`} alt="Full size" />
        </div>
      )}
    </div>
  );
}

function AgentTranscriptMessage({
  message,
  pendingToolCalls,
  toolResultsById,
}: {
  message: AgentMessage;
  pendingToolCalls: Set<string>;
  toolResultsById: Map<string, AgentMessage>;
}) {
  if (message.role === 'toolResult') return null;
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'System';
  const content = message.error || message.content || (message.role === 'assistant' ? '' : 'No content.');
  const toolCalls = message.role === 'assistant' ? message.metadata?.toolCalls ?? [] : [];
  // Extract images from user message metadata (sent via the images attachment)
  const messageImages = (message.metadata?.images ?? []) as Array<{ data: string; mimeType: string }>;
  return (
    <div className={`session-message ${message.role}`}>
      <div className="session-message-head">
        <span>{label}</span>
        {messageImages.length > 0 && <ImageIcon size={12} className="message-has-images-icon" />}
        <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
      </div>
      {messageImages.length > 0 && <MessageImages images={messageImages} />}
      {toolCalls.length > 0 && (
        <AgentToolCalls
          pendingToolCalls={pendingToolCalls}
          toolCalls={toolCalls}
          toolResultsById={toolResultsById}
        />
      )}
      {content && (
        <div className="session-message-text markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

export function AgentSessionPanel({
  providerProfiles: _providerProfiles,
  disabled,
  onNewSession,
}: {
  providerProfiles: Record<string, { enabled: boolean; models: string[]; modelEfforts: Record<string, string> }>;
  disabled: boolean;
  onNewSession: () => void;
}) {
  const agentSession = useAgentStore((s) => s.agentSession);
  const agentPrompt = useAgentStore((s) => s.agentPrompt);
  const agentProvider = useAgentStore((s) => s.agentProvider);
  const agentModel = useAgentStore((s) => s.agentModel);
  const agentBusyKey = useAgentStore((s) => s.agentBusyKey);
  const agentSessionActionKey = useAgentStore((s) => s.agentSessionActionKey);
  const agentSessionLoadingKey = useAgentStore((s) => s.agentSessionLoadingKey);
  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls);
  const modelRegistry = useAgentStore((s) => s.modelRegistry);
  const contextUsage = useAgentStore((s) => s.contextUsage);
  const sessionStats = useAgentStore((s) => s.sessionStats);
  const streamingMessage = useAgentStore((s) => s.streamingMessage);
  const queuedSteering = useAgentStore((s) => s.queuedSteering);

  const pendingImages = useAgentStore((s) => s.pendingImages);
  const addPendingImage = useAgentStore((s) => s.addPendingImage);
  const removePendingImage = useAgentStore((s) => s.removePendingImage);

  const setAgentPrompt = useAgentStore((s) => s.setAgentPrompt);
  const setAgentSession = useAgentStore((s) => s.setAgentSession);
  const setAgentSessionHistory = useAgentStore((s) => s.setAgentSessionHistory);
  const changeProviderModel = useAgentStore((s) => s.changeProviderModel);
  const runAgentAnalysis = useAgentStore((s) => s.runAgentAnalysis);
  const steerAgent = useAgentStore((s) => s.steerAgent);
  const abortAgent = useAgentStore((s) => s.abortAgent);

  const instruments = useMarketStore((s) => s.state?.instruments) ?? [];

  const busy = agentBusyKey !== null;
  const sessionLoading = agentSessionLoadingKey !== null;
  const sessionActionKey = agentSessionActionKey;

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerSearch, setModelPickerSearch] = useState('');
  const [forkSelectorOpen, setForkSelectorOpen] = useState(false);
  const [autocomplete, setAutocomplete] = useState<AutocompleteSuggestion | null>(null);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptScrollBySessionRef = useRef<Map<string, number>>(new Map());
  const shouldFollowTranscriptRef = useRef(true);
  const messages = agentSession?.messages ?? [];
  const sessionId = agentSession?.session?.id ?? null;
  const isClaudeSession = agentSession?.session?.runtime === 'claude-code';
  const sessionCapabilities = agentSession?.session?.capabilities;
  const lastMessage = messages[messages.length - 1] ?? null;
  const lastMessageToolCallCount = (lastMessage?.metadata?.toolCalls as AgentToolCall[] | undefined)?.length ?? 0;

  const toolResultsById = useMemo(() => {
    const results = new Map<string, AgentMessage>();
    for (const message of messages) {
      if (message.role !== 'toolResult') continue;
      const callId = message.metadata?.toolCallId;
      if (typeof callId === 'string' && callId) {
        results.set(callId, message);
      }
    }
    return results;
  }, [messages]);
  const canSend = !disabled && !busy && !sessionLoading && !sessionActionKey;
  const canSteer = sessionCapabilities?.steer === true && !disabled && busy && !!agentPrompt.trim();
  const sessionTime = agentSession?.session
    ? new Date(agentSession.session.updatedAt).toLocaleTimeString()
    : 'No session';

  // Command context for slash command argument completions
  // Only include analysable instruments in agent mention autocomplete
  const commandContext = useMemo<CommandContext>(() => ({
    instruments: instruments
      .filter((i) => i.analysable !== false)
      .map((i) => ({ key: i.key, label: i.label, symbol: i.symbol })),
  }), [instruments]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelPickerOpen]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !sessionId) return;
    const savedScroll = transcriptScrollBySessionRef.current.get(sessionId);
    if (savedScroll !== undefined) {
      transcript.scrollTop = savedScroll;
      shouldFollowTranscriptRef.current = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 48;
    } else {
      // First time opening this session — scroll to bottom
      transcript.scrollTop = transcript.scrollHeight;
      shouldFollowTranscriptRef.current = true;
    }
  }, [sessionId, sessionLoading]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !sessionId || sessionLoading || !shouldFollowTranscriptRef.current) return;
    transcript.scrollTop = transcript.scrollHeight;
    transcriptScrollBySessionRef.current.set(sessionId, transcript.scrollTop);
  }, [
    sessionId,
    sessionLoading,
    messages.length,
    lastMessage?.id,
    lastMessage?.content,
    lastMessage?.error,
    lastMessageToolCallCount,
    pendingToolCalls.size,
    streamingMessage?.content,
    queuedSteering.length,
  ]);

  const enabledProviders = (modelRegistry?.providers ?? []).filter((provider) =>
    modelRegistry?.models.some((model) => (
      model.providerId === provider.providerId && model.selected && model.runnable
    )),
  );
  const kw = modelPickerSearch.trim().toLowerCase();

  function selectPickerModel(provider: string, model: string) {
    changeProviderModel(provider, model);
    setModelPickerOpen(false);
    setModelPickerSearch('');
  }

  const currentProviderOption = modelRegistry?.providers.find((provider) => provider.providerId === agentProvider);

  // === Unified autocomplete system (slash commands + instrument mentions) ===

  /**
   * Update autocomplete suggestions based on current input.
   * Triggers on: `/` prefix (slash commands) or `@` shortcut (→ /mention).
   */
  function updateAutocomplete(value: string, cursor: number | null) {
    if (cursor === null || cursor === undefined) {
      setAutocomplete(null);
      return;
    }
    const beforeCursor = value.slice(0, cursor);

    // Check for @mention shortcut: transform to /mention query internally
    const atMatch = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
    if (atMatch) {
      const query = atMatch[2] ?? '';
      const suggestion = getAutocompleteSuggestions(`/mention ${query}`, commandContext);
      if (suggestion) {
        setAutocomplete(suggestion);
        setAutocompleteIndex(0);
      } else {
        setAutocomplete(null);
      }
      return;
    }

    // Check for /command prefix (only when the entire line is a slash command)
    const lineStart = beforeCursor.lastIndexOf('\n') + 1;
    const currentLine = beforeCursor.slice(lineStart);
    if (currentLine.startsWith('/')) {
      const suggestion = getAutocompleteSuggestions(currentLine, commandContext);
      setAutocomplete(suggestion);
      setAutocompleteIndex(0);
    } else {
      setAutocomplete(null);
    }
  }

  /**
   * Apply the selected autocomplete item.
   */
  function applyAutocompleteSelection(item: typeof autocomplete extends null ? never : NonNullable<typeof autocomplete>['items'][number]) {
    if (!autocomplete) return;
    const result = applyCompletion(autocomplete, item);

    // For @mention shortcut: replace the @query portion in the original text
    const beforeCursor = agentPrompt.slice(0, promptTextareaRef.current?.selectionStart ?? agentPrompt.length);
    const atMatch = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
    if (atMatch && autocomplete.command?.name === 'mention') {
      const atStart = beforeCursor.lastIndexOf('@');
      const afterCursor = agentPrompt.slice(promptTextareaRef.current?.selectionStart ?? agentPrompt.length);
      const newText = agentPrompt.slice(0, atStart) + result + afterCursor;
      setAgentPrompt(newText);
      setAutocomplete(null);
      const nextCursor = atStart + result.length;
      window.setTimeout(() => {
        promptTextareaRef.current?.focus();
        promptTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
      }, 0);
      return;
    }

    // For slash commands: replace the entire input
    setAgentPrompt(result);
    setAutocomplete(null);
    window.setTimeout(() => {
      promptTextareaRef.current?.focus();
      const len = result.length;
      promptTextareaRef.current?.setSelectionRange(len, len);
    }, 0);
  }

  // Slash command dispatcher — extensible handler for all /commands
  const dispatchSlashCommand = useCallback((command: SlashCommand, _args: string) => {
    setAgentPrompt('');
    setAutocomplete(null);
    switch (command.name) {
      case 'fork':
        if (sessionCapabilities?.forkFromMessage !== true) break;
        setForkSelectorOpen(true);
        break;
      case 'clone':
        if (sessionCapabilities?.cloneFromMessage !== true) break;
        if (sessionId) {
          void (async () => {
            try {
              const resp = await cloneSession(sessionId);
              setAgentSession(resp);
              if (resp.history?.sessions) {
                setAgentSessionHistory(resp.history.sessions);
              }
            } catch (err) {
              console.error('Clone failed:', err);
            }
          })();
        }
        break;
      case 'new':
        onNewSession();
        break;
      case 'compact':
        // TODO: trigger context compaction
        break;
      case 'mention':
        // /mention is handled by autocomplete → inserts @KEY directly
        // If someone types "/mention BTC" and presses Enter, insert it
        if (_args) {
          const existing = agentPrompt.replace(/\/mention\s+\S*/, '').trim();
          setAgentPrompt(`${existing}${existing ? ' ' : ''}@${_args} `);
        }
        break;
    }
  }, [setAgentPrompt, setAgentSession, setAgentSessionHistory, onNewSession, agentPrompt, sessionId, sessionCapabilities]);

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

  const contextProvider = agentSession?.session?.provider ?? agentProvider;
  const contextModel = agentSession?.session?.model ?? agentModel;
  const contextWindow = isClaudeSession ? null : resolveContextWindow(contextProvider, contextModel, modelRegistry);
  const rawContextPercent = contextUsagePercent(contextUsage, contextWindow);
  const contextPercentLabel = formatContextPercent(rawContextPercent);
  const contextPercentLevel = rawContextPercent ?? 0;

  // Token stats for footer display
  const statsTokens = sessionStats?.tokens ?? null;

  return (
    <div className="agent-card agent-readout agent-session-card">
      <div className="agent-card-head">
        <span className="panel-label with-icon">
          <Sparkles size={14} /> Agent Session
        </span>
        {agentSession?.session && <span className="badge mono">{isClaudeSession ? 'Claude Code' : 'Pi SDK'}</span>}
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
      </div>
      <div className="session-toolbar">
        <small>{sessionLoading ? 'Loading' : sessionTime}</small>
        {statsTokens && (
          <span className="session-token-stats">
            {statsTokens.input > 0 && <span className="stat-item">↑{formatTokenCount(statsTokens.input)}</span>}
            {statsTokens.output > 0 && <span className="stat-item">↓{formatTokenCount(statsTokens.output)}</span>}
            {statsTokens.cacheRead > 0 && <span className="stat-item">R{formatTokenCount(statsTokens.cacheRead)}</span>}
            {statsTokens.cacheWrite > 0 && <span className="stat-item">W{formatTokenCount(statsTokens.cacheWrite)}</span>}
            {(sessionStats?.cost ?? 0) > 0 && <span className="stat-item">${sessionStats!.cost.toFixed(3)}</span>}
          </span>
        )}
      </div>
      <div className="session-pickers-row">
        {isClaudeSession ? (
          <div className="session-model-picker">
            <button className="session-model-trigger" type="button" disabled>
              <span>{agentSession?.session?.model || 'Local Claude default'}</span>
            </button>
          </div>
        ) : <div className="session-model-picker" ref={pickerRef}>
          <button
            className="session-model-trigger"
            type="button"
            disabled={busy}
            onClick={() => setModelPickerOpen(!modelPickerOpen)}
          >
            {currentProviderOption && (
              <span className="session-model-provider-icon">
                <ProviderIcon provider={currentProviderOption.providerId} size={14} />
              </span>
            )}
            <span>{agentModel}</span>
            <ChevronDown size={14} />
          </button>
          {modelPickerOpen && (
            <div className="session-model-dropdown">
              <div className="session-model-dropdown-search">
                <Search size={14} />
                <input
                  autoFocus
                  value={modelPickerSearch}
                  onChange={(e) => setModelPickerSearch(e.target.value)}
                  placeholder="Search models..."
                />
              </div>
              <div className="session-model-dropdown-list">
                {enabledProviders.map((opt) => {
                  const providerModels = (modelRegistry?.models ?? []).filter((model) =>
                    model.providerId === opt.providerId
                    && model.selected
                    && model.runnable
                    && (!kw || model.id.toLowerCase().includes(kw) || model.name.toLowerCase().includes(kw) || opt.name.toLowerCase().includes(kw)),
                  );
                  if (providerModels.length === 0) return null;
                  return (
                    <div key={opt.providerId} className="session-model-group">
                      <div className="session-model-group-head">
                        <ProviderIcon provider={opt.providerId} size={15} />
                        <span>{opt.name}</span>
                      </div>
                      {providerModels.map((model) => {
                        const active = agentProvider === opt.providerId && agentModel === model.id;
                        return (
                          <button
                            key={`${opt.providerId}:${model.id}`}
                            className={`session-model-option ${active ? 'active' : ''}`}
                            type="button"
                            onClick={() => selectPickerModel(opt.providerId, model.id)}
                          >
                            {active && <Check size={14} />}
                            <span>{model.name || model.id}</span>
                            {model.reasoning && <span className="session-model-effort">reasoning</span>}
                            <span className="session-model-effort">{formatTokenCount(model.contextWindow)}</span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {enabledProviders.every((opt) => {
                  return (modelRegistry?.models ?? []).filter((model) =>
                    model.providerId === opt.providerId
                    && model.selected
                    && model.runnable
                    && (!kw || model.id.toLowerCase().includes(kw) || model.name.toLowerCase().includes(kw) || opt.name.toLowerCase().includes(kw)),
                  ).length === 0;
                }) && (
                  <div className="empty-state sm">无匹配模型</div>
                )}
              </div>
            </div>
          )}
        </div>}
      </div>
      {/* Fork selector: replaces transcript when open */}
      {forkSelectorOpen && sessionId ? (() => {
        const userMsgs = (agentSession?.messages ?? []).filter(m => m.role === 'user');
        return (
          <div className="fork-selector-panel">
            <div className="fork-selector-header">
              <span>Fork from message</span>
              <button type="button" onClick={() => setForkSelectorOpen(false)} className="fork-selector-close">✕</button>
            </div>
            <div className="fork-selector-list">
              {userMsgs.length === 0 && <div className="empty-state sm">No user messages</div>}
              {userMsgs.map((msg) => (
                <button
                  key={String(msg.id)}
                  type="button"
                  className="fork-selector-item"
                  onClick={() => {
                    setForkSelectorOpen(false);
                    void (async () => {
                      try {
                        const resp = await forkSession(sessionId, String(msg.id));
                        setAgentSession(resp);
                        if (resp.history?.sessions) {
                          setAgentSessionHistory(resp.history.sessions);
                        }
                        if (resp.prompt) {
                          setAgentPrompt(resp.prompt);
                        }
                      } catch (err) {
                        console.error('Fork failed:', err);
                      }
                    })();
                  }}
                >
                  <span className="fork-selector-preview">
                    {msg.content.length > 80 ? msg.content.slice(0, 80) + '…' : msg.content}
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })() : <div
        className="session-transcript"
        ref={transcriptRef}
        onScroll={(event) => {
          if (!sessionId) return;
          const transcript = event.currentTarget;
          shouldFollowTranscriptRef.current = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 48;
          transcriptScrollBySessionRef.current.set(sessionId, transcript.scrollTop);
        }}
      >
        {sessionLoading && (
          <div className="empty-state row">
            <Loader2 className="spin" size={16} />
            <span>Loading session</span>
          </div>
        )}
        {!sessionLoading && messages.map((message) => (
          <AgentTranscriptMessage
            key={message.id}
            message={message}
            pendingToolCalls={pendingToolCalls}
            toolResultsById={toolResultsById}
          />
        ))}
        {!sessionLoading && streamingMessage && (
          <div className="session-message assistant streaming">
            <div className="session-message-head">
              <span>Agent</span>
              <Loader2 className="spin" size={12} />
            </div>
            {streamingMessage.content && (
              <div className="session-message-text markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingMessage.content}</ReactMarkdown>
              </div>
            )}
            {!streamingMessage.content && (
              <span className="streaming-cursor" />
            )}
          </div>
        )}
        {!sessionLoading && queuedSteering.length > 0 && (
          <div className="session-steering-queue">
            {queuedSteering.map((item) => (
              <div key={item.id} className="session-steering-item">
                <span className="badge sm warning">queued</span>
                <span className="session-steering-text">{item.content}</span>
              </div>
            ))}
          </div>
        )}
        {!sessionLoading && messages.length === 0 && !streamingMessage && (
          <div className="empty-state row">
            <History size={16} />
            <span>No turns in this agent session.</span>
          </div>
        )}
      </div>}
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
          onChange={(event) => {
            setAgentPrompt(event.target.value);
            updateAutocomplete(event.target.value, event.target.selectionStart);
          }}
          onClick={(event) => updateAutocomplete(event.currentTarget.value, event.currentTarget.selectionStart)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            // Unified autocomplete navigation
            if (autocomplete && autocomplete.items.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setAutocompleteIndex((i) => (i + 1) % autocomplete.items.length);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setAutocompleteIndex((i) => (i - 1 + autocomplete.items.length) % autocomplete.items.length);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setAutocomplete(null);
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
                event.preventDefault();
                const selected = autocomplete.items[autocompleteIndex];
                if (selected) applyAutocompleteSelection(selected);
                return;
              }
            }
            if (event.key === 'Escape' && busy) {
              event.preventDefault();
              void abortAgent();
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              // Dispatch slash commands
              const parsed = parseSlashCommand(agentPrompt);
              if (parsed) {
                dispatchSlashCommand(parsed.command, parsed.args);
                return;
              }
              if (canSteer) void steerAgent();
              else if (canSend) void runAgentAnalysis();
            }
          }}
          onKeyUp={(event) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
            updateAutocomplete(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          placeholder={
            busy
              ? isClaudeSession ? "Claude Code is running. Esc to abort." : "Type to steer agent. Esc to abort."
              : pendingImages.length > 0
                ? "Add a question, or send the image alone. / for commands, @ for instruments."
                : "Ask the agent. / for commands, @ for instruments."
          }
          rows={3}
          value={agentPrompt}
        />
        {autocomplete && autocomplete.items.length > 0 && (
          <div className="slash-command-picker">
            <div className="slash-command-head">
              {autocomplete.mode === 'argument' && autocomplete.command
                ? `/${autocomplete.command.name}`
                : 'Commands'}
            </div>
            <div className="slash-command-list">
              {autocomplete.items.map((item, index) => (
                <button
                  key={item.value}
                  className={`slash-command-option ${index === autocompleteIndex ? 'active' : ''}`}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyAutocompleteSelection(item);
                  }}
                >
                  <span className="slash-command-name">{item.label}</span>
                  {item.description && <span className="slash-command-desc">{item.description}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
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
            aria-label={busy ? (canSteer ? 'Steer Agent' : 'Analyzing') : 'Ask Agent'}
            className="shell-button primary lg session-submit"
            type="button"
            onClick={() => {
              if (canSteer) void steerAgent();
              else void runAgentAnalysis();
            }}
            disabled={!canSend && !canSteer}
          >
            {busy && !canSteer ? <Loader2 className="spin" size={16} /> : busy ? <Zap size={16} /> : <Bot size={16} />}
            <span className="session-submit-label">
              {busy ? (canSteer ? 'Steer Agent' : 'Analyzing') : 'Ask Agent'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
