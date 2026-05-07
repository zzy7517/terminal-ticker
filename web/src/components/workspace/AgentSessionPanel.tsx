import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  ChartNoAxesCombined,
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
          <div key={call.id} className="agent-tool-step">
            <div className="tool-step-summary">
              <Zap size={12} />
              <span className="tool-name">call {call.name}</span>
              {isPending && <span className="tool-pending-badge">running</span>}
              {result?.metadata?.error && <span className="tool-error-badge">error</span>}
            </div>
            <div className="tool-step-detail">
              {Object.keys(call.arguments ?? {}).length > 0 && (
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
      {content && <p className="session-message-text">{content}</p>}
      {toolCalls.length > 0 && (
        <AgentToolCalls
          pendingToolCalls={pendingToolCalls}
          toolCalls={toolCalls}
          toolResultsById={toolResultsById}
        />
      )}
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
  const agentCandidateKeys = useAgentStore((s) => s.agentCandidateKeys);
  const agentBusyKey = useAgentStore((s) => s.agentBusyKey);
  const agentSessionActionKey = useAgentStore((s) => s.agentSessionActionKey);
  const agentSessionLoadingKey = useAgentStore((s) => s.agentSessionLoadingKey);
  const pendingToolCalls = useAgentStore((s) => s.pendingToolCalls);
  const modelCache = useAgentStore((s) => s.modelCache);
  const contextUsage = useAgentStore((s) => s.contextUsage);

  const setAgentPrompt = useAgentStore((s) => s.setAgentPrompt);
  const changeProviderModel = useAgentStore((s) => s.changeProviderModel);
  const toggleAgentCandidate = useAgentStore((s) => s.toggleAgentCandidate);
  const clearAgentCandidates = useAgentStore((s) => s.clearAgentCandidates);
  const runAgentAnalysis = useAgentStore((s) => s.runAgentAnalysis);

  const instruments = useMarketStore((s) => s.state?.instruments) ?? [];

  const busy = agentBusyKey !== null;
  const sessionLoading = agentSessionLoadingKey !== null;
  const sessionActionKey = agentSessionActionKey;

  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerSearch, setModelPickerSearch] = useState('');
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const contextPickerRef = useRef<HTMLDivElement>(null);
  const messages = agentSession?.messages ?? [];
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

  useEffect(() => {
    if (!modelPickerOpen && !contextPickerOpen) return;
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setModelPickerOpen(false);
      }
      if (contextPickerRef.current && !contextPickerRef.current.contains(e.target as Node)) {
        setContextPickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextPickerOpen, modelPickerOpen]);

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
  const candidateLabels = agentCandidateKeys
    .map((key) => instruments.find((instrument) => instrument.key === key)?.label ?? key)
    .join(', ');

  const cachedModel = (modelCache[agentProvider] ?? []).find((m) => m.slug === agentModel);
  const contextWindow = cachedModel?.contextWindow ?? null;
  const contextPercent = contextUsage && contextWindow && contextWindow > 0
    ? Math.round((contextUsage.promptTokens / contextWindow) * 100)
    : null;

  return (
    <div className="agent-card agent-readout agent-session-card">
      <div className="agent-card-head">
        <span className="panel-label with-icon">
          <Sparkles size={14} /> Agent Session
        </span>
        {busy && <span className="agent-bias neutral">running</span>}
        {contextPercent !== null && (
          <span className={`context-badge${contextPercent > 90 ? ' danger' : contextPercent > 70 ? ' warning' : ''}`}>
            <CircleDot size={10} /> {contextPercent}% context
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
                <div className="session-model-empty">无匹配模型</div>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="session-context-picker" ref={contextPickerRef}>
        <button
          className="session-model-trigger"
          type="button"
          disabled={busy || instruments.length === 0}
          onClick={() => setContextPickerOpen(!contextPickerOpen)}
        >
          <ChartNoAxesCombined size={13} />
          <span>{agentCandidateKeys.length ? candidateLabels : 'All instruments available'}</span>
          <ChevronDown size={14} />
        </button>
        {contextPickerOpen && (
          <div className="session-model-dropdown session-context-dropdown">
            <div className="session-model-group-head">
              <span>Tool candidates only</span>
              {agentCandidateKeys.length > 0 && (
                <button className="context-clear-button" type="button" onClick={clearAgentCandidates}>
                  Clear
                </button>
              )}
            </div>
            <div className="session-model-dropdown-list">
              {instruments.map((instrument) => {
                const active = agentCandidateKeys.includes(instrument.key);
                return (
                  <button
                    key={instrument.key}
                    className={`session-model-option ${active ? 'active' : ''}`}
                    type="button"
                    onClick={() => toggleAgentCandidate(instrument.key)}
                  >
                    {active && <Check size={14} />}
                    <span>{instrument.label}</span>
                    <span className="session-model-effort">{instrument.symbol}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
      </div>
      <div className="session-transcript">
        {sessionLoading && (
          <div className="session-empty">
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
          <div className="session-empty">
            <History size={16} />
            <span>No turns in this agent session.</span>
          </div>
        )}
      </div>
      <div className="session-compose">
        <textarea
          disabled={disabled || busy || sessionLoading}
          onChange={(event) => setAgentPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              if (canSend) void runAgentAnalysis();
            }
          }}
          placeholder="Ask the agent. Use the instrument picker only when you want to narrow tool calls."
          rows={3}
          value={agentPrompt}
        />
        <button className="agent-action" type="button" onClick={() => void runAgentAnalysis()} disabled={!canSend}>
          {busy ? <Loader2 className="spin" size={16} /> : <Bot size={16} />}
          {busy ? 'Analyzing' : 'Ask Agent'}
        </button>
      </div>
    </div>
  );
}
