import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  CircleDot,
  History,
  Loader2,
  Search,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { AgentMessage, AgentToolCall } from '../../types';
import { AGENT_PROVIDER_OPTIONS } from '../../constants';
import { useAgentStore } from '../../stores/agentStore';
import { useMarketStore } from '../../stores/marketStore';

type InstrumentMentionOption = {
  key: string;
  label: string;
  symbol: string;
};

type MentionPickerState = {
  start: number;
  end: number;
  query: string;
  activeIndex: number;
};

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
        const hasArgs = Object.keys(call.arguments ?? {}).length > 0;
        const showDetail = hasArgs || !!result;
        return (
          <div key={call.id} className="agent-tool-step">
            <div className="tool-step-summary">
              {isPending ? <Loader2 className="spin" size={12} /> : <Zap size={12} />}
              <span className="tool-name">{call.name}</span>
              {!isPending && result && !result.metadata?.error && <Check size={12} className="tool-done-icon" />}
              {result?.metadata?.error && <span className="badge sm danger">error</span>}
            </div>
            {showDetail && (
              <div className="tool-step-detail">
                {hasArgs && (
                  <div className="tool-args">
                    <small>Arguments</small>
                    <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
                  </div>
                )}
                {result && (
                  <div className={`tool-output ${result.metadata?.error ? 'error' : ''}`}>
                    <small>Output</small>
                    <pre>{result.content}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
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
  return (
    <div className={`session-message ${message.role}`}>
      <div className="session-message-head">
        <span>{label}</span>
        <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
      </div>
      {toolCalls.length > 0 && (
        <AgentToolCalls
          pendingToolCalls={pendingToolCalls}
          toolCalls={toolCalls}
          toolResultsById={toolResultsById}
        />
      )}
      {content && <p className="session-message-text">{content}</p>}
    </div>
  );
}

export function AgentSessionPanel({
  providerProfiles,
  disabled,
}: {
  providerProfiles: Record<string, { enabled: boolean; models: string[]; modelEfforts: Record<string, string> }>;
  disabled: boolean;
}) {
  const agentSession = useAgentStore((s) => s.agentSession);
  const agentPrompt = useAgentStore((s) => s.agentPrompt);
  const agentProvider = useAgentStore((s) => s.agentProvider);
  const agentModel = useAgentStore((s) => s.agentModel);
  const agentBusyKey = useAgentStore((s) => s.agentBusyKey);
  const agentSessionActionKey = useAgentStore((s) => s.agentSessionActionKey);
  const agentSessionLoadingKey = useAgentStore((s) => s.agentSessionLoadingKey);
  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls);
  const modelCache = useAgentStore((s) => s.modelCache);
  const contextUsage = useAgentStore((s) => s.contextUsage);
  const streamFlushTick = useAgentStore((s) => s.streamFlushTick);

  const setAgentPrompt = useAgentStore((s) => s.setAgentPrompt);
  const changeProviderModel = useAgentStore((s) => s.changeProviderModel);
  const runAgentAnalysis = useAgentStore((s) => s.runAgentAnalysis);

  const instruments = useMarketStore((s) => s.state?.instruments) ?? [];

  const busy = agentBusyKey !== null;
  const sessionLoading = agentSessionLoadingKey !== null;
  const sessionActionKey = agentSessionActionKey;

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerSearch, setModelPickerSearch] = useState('');
  const [mentionPicker, setMentionPicker] = useState<MentionPickerState | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const transcriptScrollBySessionRef = useRef<Map<string, number>>(new Map());
  const shouldFollowTranscriptRef = useRef(true);
  const messages = agentSession?.messages ?? [];
  const sessionId = agentSession?.session?.id ?? null;
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
  const sessionTime = agentSession?.session
    ? new Date(agentSession.session.updatedAt).toLocaleTimeString()
    : 'No session';

  const mentionOptions = useMemo<InstrumentMentionOption[]>(() => {
    if (!mentionPicker) return [];
    const query = mentionPicker.query.trim().toLowerCase();
    return instruments
      .filter((instrument) => {
        if (!query) return true;
        return instrument.key.toLowerCase().includes(query)
          || instrument.label.toLowerCase().includes(query)
          || instrument.symbol.toLowerCase().includes(query);
      })
      .slice(0, 20)
      .map((instrument) => ({
        key: instrument.key,
        label: instrument.label,
        symbol: instrument.symbol,
      }));
  }, [instruments, mentionPicker]);

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

  useEffect(() => {
    if (!mentionPicker || mentionOptions.length === 0 || mentionPicker.activeIndex < mentionOptions.length) return;
    setMentionPicker({ ...mentionPicker, activeIndex: 0 });
  }, [mentionOptions.length, mentionPicker]);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || !sessionId) return;
    transcript.scrollTop = transcriptScrollBySessionRef.current.get(sessionId) ?? 0;
    shouldFollowTranscriptRef.current = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 48;
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
    streamFlushTick,
  ]);

  const enabledProviders = AGENT_PROVIDER_OPTIONS.filter(
    (o) => providerProfiles[o.provider]?.enabled,
  );
  const kw = modelPickerSearch.trim().toLowerCase();

  function selectPickerModel(provider: string, model: string) {
    changeProviderModel(provider, model);
    setModelPickerOpen(false);
    setModelPickerSearch('');
  }

  const currentProviderOption = AGENT_PROVIDER_OPTIONS.find((o) => o.provider === agentProvider);

  function updateMentionPicker(value: string, cursor: number | null) {
    if (cursor === null || cursor === undefined) {
      setMentionPicker(null);
      return;
    }
    const beforeCursor = value.slice(0, cursor);
    const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
    if (!match) {
      setMentionPicker(null);
      return;
    }
    const query = match[2] ?? '';
    setMentionPicker({
      start: cursor - query.length - 1,
      end: cursor,
      query,
      activeIndex: 0,
    });
  }

  function insertInstrumentMention(instrument: InstrumentMentionOption) {
    if (!mentionPicker) return;
    const mention = `@${instrument.key} `;
    const nextPrompt = `${agentPrompt.slice(0, mentionPicker.start)}${mention}${agentPrompt.slice(mentionPicker.end)}`;
    const nextCursor = mentionPicker.start + mention.length;
    setAgentPrompt(nextPrompt);
    setMentionPicker(null);
    window.setTimeout(() => {
      promptTextareaRef.current?.focus();
      promptTextareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 0);
  }

  function moveMentionSelection(delta: number) {
    if (!mentionPicker || mentionOptions.length === 0) return;
    const nextIndex = (mentionPicker.activeIndex + delta + mentionOptions.length) % mentionOptions.length;
    setMentionPicker({ ...mentionPicker, activeIndex: nextIndex });
  }

  const contextProvider = agentSession?.session?.provider ?? agentProvider;
  const contextModel = agentSession?.session?.model ?? agentModel;
  const cachedModel = (modelCache[contextProvider] ?? []).find((m) => m.slug === contextModel);
  const contextWindow = cachedModel?.contextWindow ?? null;
  const rawContextPercent = contextUsage && contextWindow && contextWindow > 0
    ? (contextUsage.promptTokens / contextWindow) * 100
    : null;
  const contextPercentLabel = rawContextPercent === null
    ? null
    : rawContextPercent > 0 && rawContextPercent < 1
      ? '<1'
      : String(Math.round(rawContextPercent));
  const contextPercentLevel = rawContextPercent ?? 0;

  return (
    <div className="agent-card agent-readout agent-session-card">
      <div className="agent-card-head">
        <span className="panel-label with-icon">
          <Sparkles size={14} /> Agent Session
        </span>
        {busy && <span className="agent-bias neutral">running</span>}
        {contextPercentLabel !== null && (
          <span className={`badge mono${contextPercentLevel > 90 ? ' danger' : contextPercentLevel > 70 ? ' warning' : ''}`}>
            <CircleDot size={10} /> {contextPercentLabel}% context
          </span>
        )}
      </div>
      <div className="session-toolbar">
        <small>{sessionLoading ? 'Loading' : sessionTime}</small>
      </div>
      <div className="session-pickers-row">
        <div className="session-model-picker" ref={pickerRef}>
          <button
            className="session-model-trigger"
            type="button"
            disabled={busy}
            onClick={() => setModelPickerOpen(!modelPickerOpen)}
          >
            {currentProviderOption && (
              <span className="session-model-provider-icon">
                {currentProviderOption.provider === 'anthropic' ? <Sparkles size={12} /> : <Bot size={12} />}
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
                  const profile = providerProfiles[opt.provider];
                  const providerModels = (profile?.models ?? []).filter((m) =>
                    !kw || m.toLowerCase().includes(kw) || opt.label.toLowerCase().includes(kw),
                  );
                  if (providerModels.length === 0) return null;
                  return (
                    <div key={opt.provider} className="session-model-group">
                      <div className="session-model-group-head">
                        {opt.provider === 'anthropic' ? <Sparkles size={13} /> : <Bot size={13} />}
                        <span>{opt.label}</span>
                      </div>
                      {providerModels.map((m) => {
                        const active = agentProvider === opt.provider && agentModel === m;
                        return (
                          <button
                            key={`${opt.provider}:${m}`}
                            className={`session-model-option ${active ? 'active' : ''}`}
                            type="button"
                            onClick={() => selectPickerModel(opt.provider, m)}
                          >
                            {active && <Check size={14} />}
                            <span>{m}</span>
                            {profile?.modelEfforts?.[m] && (
                              <span className="session-model-effort">{profile.modelEfforts[m]}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {enabledProviders.every((opt) => {
                  const profile = providerProfiles[opt.provider];
                  return (profile?.models ?? []).filter((m) =>
                    !kw || m.toLowerCase().includes(kw) || opt.label.toLowerCase().includes(kw),
                  ).length === 0;
                }) && (
                  <div className="empty-state sm">无匹配模型</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div
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
        {!sessionLoading && messages.length === 0 && (
          <div className="empty-state row">
            <History size={16} />
            <span>No turns in this agent session.</span>
          </div>
        )}
      </div>
      <div className="session-compose">
        <textarea
          ref={promptTextareaRef}
          disabled={disabled || busy || sessionLoading}
          onChange={(event) => {
            setAgentPrompt(event.target.value);
            updateMentionPicker(event.target.value, event.target.selectionStart);
          }}
          onClick={(event) => updateMentionPicker(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (mentionPicker) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveMentionSelection(1);
                return;
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveMentionSelection(-1);
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setMentionPicker(null);
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
                event.preventDefault();
                const selected = mentionOptions[mentionPicker.activeIndex];
                if (selected) insertInstrumentMention(selected);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (canSend) void runAgentAnalysis();
            }
          }}
          onKeyUp={(event) => {
            if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
            updateMentionPicker(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          placeholder="Ask the agent. Type @ to mention a configured instrument."
          rows={3}
          value={agentPrompt}
        />
        {mentionPicker && (
          <div className="instrument-mention-picker">
            <div className="instrument-mention-head">Configured instruments</div>
            <div className="instrument-mention-list">
              {mentionOptions.map((instrument, index) => (
                <button
                  key={instrument.key}
                  className={`instrument-mention-option ${index === mentionPicker.activeIndex ? 'active' : ''}`}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertInstrumentMention(instrument);
                  }}
                >
                  <span>{instrument.label}</span>
                  <small>{instrument.symbol}</small>
                  <code>{instrument.key}</code>
                </button>
              ))}
              {mentionOptions.length === 0 && (
                <div className="instrument-mention-empty">No matching instruments</div>
              )}
            </div>
          </div>
        )}
        <button
          className="shell-button primary lg full-width"
          type="button"
          onClick={() => void runAgentAnalysis()}
          disabled={!canSend}
        >
          {busy ? <Loader2 className="spin" size={16} /> : <Bot size={16} />}
          {busy ? 'Analyzing' : 'Ask Agent'}
        </button>
      </div>
    </div>
  );
}
