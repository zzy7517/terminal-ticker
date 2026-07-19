/** 浏览器端 Tradex HTTP、SSE 和 Agent API 客户端。 */
import type {
  AgentConfigUpdate,
  AgentDirectMessage,
  AgentDirectMessageResponse,
  AgentModelRegistry,
  AgentModelRegistryResolveResponse,
  AgentModelsResponse,
  AgentStreamEvent,
  AgentStreamPayload,
  ProviderProfileUpdate,
  ProxyConfigUpdate,
  ProxyTestResult,
  AgentSessionHistoryResponse,
  AgentSessionMutationResponse,
  AgentSessionResponse,
  AgentSessionSummary,
  CronJobCreate,
  CronJobsResponse,
  CronJobStatus,
  CronJobUpdate,
  CronRunRecord,
  CronSessionEntry,
  InstrumentCatalogResponse,
  InstrumentSearchResult,
  Jin10CalendarEvent,
  Jin10Quote,
  Jin10Status,
  Lesson,
  MarketState,
  NewsConfigUpdate,
  NewsItem,
  McpAllResourcesResponse,
  McpAllResourceTemplatesResponse,
  McpReadResourceResponse,
  McpServerResourcesResponse,
  McpServerResourceTemplatesResponse,
  McpStatusResponse,
  McpServerToolsResponse,
  McpSettings,
  McpServerEntry,
  AgentDefinition,
  AgentDefinitionInput,
  AgentRuntimeStatus,
  ClaudeCodeModelsResponse,
  Channel,
  ChannelMessage,
  ChannelMessagesResponse,
  ChannelThreadResponse,
  ChatBootstrapResponse,
  ChatEvent,
  ChatMessageReference,
  ChatTarget,
} from './types';

const DEFAULT_DEV_BACKEND_ORIGIN = 'http://127.0.0.1:8765';

function stateSocketUrl(): string {
  const origin = import.meta.env.DEV
    ? import.meta.env.VITE_BACKEND_ORIGIN || DEFAULT_DEV_BACKEND_ORIGIN
    : window.location.origin;
  const url = new URL('/ws', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

// Builds a user-facing error while preserving structured backend detail when available.
async function responseError(response: Response, prefix: string): Promise<Error> {
  try {
    const payload = await response.json();
    if (payload && typeof payload.detail === 'string') {
      return new Error(`${prefix}: ${payload.detail}`);
    }
  } catch {
    // Keep the original status fallback when the body is not JSON.
  }
  return new Error(`${prefix}: ${response.status}`);
}

// Loads the complete market snapshot used to hydrate or refresh the workspace.
export async function fetchState(): Promise<MarketState> {
  const response = await fetch('/api/state');
  if (!response.ok) {
    throw new Error(`state request failed: ${response.status}`);
  }
  return response.json();
}

// Loads the pre-warmed provider instrument catalog for local UI search.
export async function fetchInstrumentCatalog(): Promise<InstrumentCatalogResponse> {
  const response = await fetch('/api/instruments/catalog');
  if (!response.ok) {
    throw await responseError(response, 'catalog failed');
  }
  return response.json();
}

// Persists a Bitget instrument to the watchlist and returns the reloaded state.
export async function addBitgetSymbol(result: InstrumentSearchResult): Promise<MarketState> {
  const response = await fetch('/api/watchlist/bitget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: result.symbol,
      instType: result.instType,
      label: result.label,
    }),
  });
  if (!response.ok) {
    throw await responseError(response, 'add failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Persists a Hyperliquid instrument to the watchlist and returns the reloaded state.
export async function addHyperliquidSymbol(result: InstrumentSearchResult): Promise<MarketState> {
  const response = await fetch('/api/watchlist/hyperliquid', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: result.symbol,
      label: result.label,
      group: result.group,
      category: result.category,
    }),
  });
  if (!response.ok) {
    throw await responseError(response, 'add failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Removes any watchlist instrument by its stable provider key.
export async function removeWatchlistInstrument(key: string): Promise<MarketState> {
  const response = await fetch(`/api/watchlist/instruments/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw await responseError(response, 'remove failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Reorders instruments in the watchlist TOML by providing the desired key order.
export async function reorderWatchlist(keys: string[]): Promise<MarketState> {
  const response = await fetch('/api/watchlist/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  });
  if (!response.ok) {
    throw await responseError(response, 'reorder failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Lists all saved agent sessions for the decoupled chat workspace.
export async function fetchAgentSessions(): Promise<AgentSessionHistoryResponse> {
  const response = await fetch('/api/agent/sessions');
  if (!response.ok) {
    throw await responseError(response, 'agent sessions fetch failed');
  }
  return response.json();
}

// Creates a new decoupled agent session.
export async function createAgentSession(options?: {
  title?: string;
  provider?: string;
  model?: string;
  agentId?: string;
  chatId?: string;
}): Promise<AgentSessionResponse & { history: AgentSessionHistoryResponse }> {
  const response = await fetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options ?? {}),
  });
  if (!response.ok) {
    throw await responseError(response, 'agent session create failed');
  }
  return response.json();
}

export async function fetchAgentDirectMessages(agentId: string): Promise<AgentDirectMessageResponse> {
  const response = await fetch(`/api/chat/agents/${encodeURIComponent(agentId)}/messages`);
  if (!response.ok) throw await responseError(response, 'Agent Direct Messages fetch failed');
  return response.json();
}

export async function sendAgentDirectMessage(
  agentId: string,
  content: string,
): Promise<{ message: AgentDirectMessage; target: { kind: 'direct-message'; directMessageId: string } }> {
  const response = await fetch(`/api/chat/agents/${encodeURIComponent(agentId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw await responseError(response, 'Agent Direct Message send failed');
  return response.json();
}

export async function fetchChannels(): Promise<{ channels: Channel[] }> {
  const response = await fetch('/api/channels');
  if (!response.ok) throw await responseError(response, 'Channels fetch failed');
  return response.json();
}

export async function fetchChatBootstrap(): Promise<ChatBootstrapResponse> {
  const response = await fetch('/api/chat/bootstrap');
  if (!response.ok) throw await responseError(response, 'Chat bootstrap failed');
  return response.json();
}

export function connectChatEvents(
  afterSeq: number,
  onEvent: (event: ChatEvent) => void,
  onStatus: (status: 'connected' | 'disconnected' | 'error') => void,
): () => void {
  const source = new EventSource(`/api/chat/events?after_seq=${Math.max(0, Math.floor(afterSeq))}`);
  source.addEventListener('open', () => onStatus('connected'));
  source.addEventListener('error', () => onStatus('error'));
  source.addEventListener('chat', (frame) => {
    try {
      onEvent(JSON.parse((frame as MessageEvent<string>).data) as ChatEvent);
    } catch {
      onStatus('error');
    }
  });
  return () => {
    source.close();
    onStatus('disconnected');
  };
}

export async function setChatReference(
  kind: 'saved' | 'pins',
  target: ChatTarget,
  messageId: string,
  active: boolean,
): Promise<{ saved: ChatMessageReference[]; pinned: ChatMessageReference[] }> {
  const response = await fetch(`/api/chat/${kind}`, {
    method: active ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, messageId }),
  });
  if (!response.ok) throw await responseError(response, `Chat ${kind} update failed`);
  return response.json();
}

export async function createChannel(input: { name: string; topic?: string }): Promise<{ channel: Channel; channels: Channel[] }> {
  const response = await fetch('/api/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Channel create failed');
  return response.json();
}

export async function fetchChannelMessages(channelId: string, beforeSeq?: number): Promise<ChannelMessagesResponse> {
  const query = beforeSeq ? `?before_seq=${encodeURIComponent(String(beforeSeq))}` : '';
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/messages${query}`);
  if (!response.ok) throw await responseError(response, 'Channel messages fetch failed');
  return response.json();
}

export async function sendChannelMessage(channelId: string, content: string, threadRootId?: string): Promise<{ message: ChannelMessage; channel: Channel }> {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, threadRootId }),
  });
  if (!response.ok) throw await responseError(response, 'Channel message send failed');
  return response.json();
}

export async function fetchChannelThread(messageId: string): Promise<ChannelThreadResponse> {
  const response = await fetch(`/api/channels/messages/${encodeURIComponent(messageId)}/thread`);
  if (!response.ok) throw await responseError(response, 'Channel thread fetch failed');
  return response.json();
}

export async function sendChannelThreadReply(messageId: string, content: string): Promise<{ message: ChannelMessage; thread: ChannelThreadResponse }> {
  const response = await fetch(`/api/channels/messages/${encodeURIComponent(messageId)}/thread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw await responseError(response, 'Thread reply failed');
  return response.json();
}

export async function editChannelMessage(messageId: string, content: string): Promise<{ message: ChannelMessage; channel: Channel }> {
  const response = await fetch(`/api/channels/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw await responseError(response, 'Channel message edit failed');
  return response.json();
}

export async function deleteChannelMessage(messageId: string): Promise<{ message: ChannelMessage; channel: Channel }> {
  const response = await fetch(`/api/channels/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'Channel message delete failed');
  return response.json();
}

export async function setChannelReaction(messageId: string, emoji: string, active: boolean): Promise<{ message: ChannelMessage; channel: Channel }> {
  const response = await fetch(`/api/channels/messages/${encodeURIComponent(messageId)}/reactions`, {
    method: active ? 'POST' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emoji }),
  });
  if (!response.ok) throw await responseError(response, 'Channel reaction failed');
  return response.json();
}

export async function fetchAgents(): Promise<{ agents: AgentDefinition[] }> {
  const response = await fetch('/api/agents');
  if (!response.ok) throw await responseError(response, 'agents fetch failed');
  return response.json();
}

export async function fetchAgentRuntimes(): Promise<{ runtimes: AgentRuntimeStatus[] }> {
  const response = await fetch('/api/agent/runtimes');
  if (!response.ok) throw await responseError(response, 'agent runtimes fetch failed');
  return response.json();
}

export async function fetchClaudeCodeModels(): Promise<ClaudeCodeModelsResponse> {
  const response = await fetch('/api/agent/runtimes/claude-code/models');
  if (!response.ok) throw await responseError(response, 'Claude models fetch failed');
  return response.json();
}

export async function createAgent(input: AgentDefinitionInput): Promise<{ agent: AgentDefinition; agents: AgentDefinition[] }> {
  const response = await fetch('/api/agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'agent create failed');
  return response.json();
}

export async function updateAgent(id: string, input: Partial<AgentDefinitionInput>): Promise<{ agent: AgentDefinition; agents: AgentDefinition[] }> {
  const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'agent update failed');
  return response.json();
}

export async function deleteAgent(id: string): Promise<{ agents: AgentDefinition[] }> {
  const response = await fetch(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'agent delete failed');
  return response.json();
}

// Loads an agent session by id.
export async function fetchAgentSession(key: string): Promise<AgentSessionResponse> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(key)}`);
  if (!response.ok) {
    throw await responseError(response, 'agent session fetch failed');
  }
  return response.json();
}

// Deletes a decoupled session by id.
export async function deleteAgentSessionById(sessionId: string): Promise<AgentSessionMutationResponse> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw await responseError(response, 'agent session delete failed');
  }
  return response.json();
}

// Aborts the currently-running agent for a session.
export async function abortAgentSession(sessionId: string): Promise<void> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/abort`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw await responseError(response, 'agent abort failed');
  }
}

export interface ImageAttachment {
  data: string;      // base64
  mimeType: string;  // image/png, image/jpeg, etc.
}

// 标识未收到终止帧的网络或 SSE 传输中断。
export class AgentStreamDisconnectError extends Error {
  // 构造可与后端业务错误区分的 Agent 流断线错误。
  constructor(message = 'agent stream disconnected before completion') {
    super(message);
    this.name = 'AgentStreamDisconnectError';
  }
}

export async function streamAgentMessage(
  key: string,
  message: string,
  options: { provider?: string; model?: string; afterSeq?: number; images?: ImageAttachment[] } | undefined,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const body: Record<string, unknown> = { message };
  if (options?.provider) body.provider = options.provider;
  if (options?.model) body.model = options.model;
  if (typeof options?.afterSeq === 'number') body.afterSeq = options.afterSeq;
  if (options?.images && options.images.length > 0) body.images = options.images;
  let response: Response;
  try {
    response = await fetch(`/api/agent/sessions/${encodeURIComponent(key)}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new AgentStreamDisconnectError(error instanceof Error ? error.message : undefined);
  }
  if (!response.ok) {
    throw await responseError(response, 'agent stream failed');
  }
  if (!response.body) {
    throw new Error('agent stream failed: response body is empty');
  }
  const parseEvent = (data: string) => {
    const parsed = JSON.parse(data) as AgentStreamEvent | AgentStreamPayload;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'event' in parsed &&
      parsed.event &&
      typeof parsed.event === 'object' &&
      'type' in parsed.event &&
      typeof parsed.event.type === 'string' &&
      typeof parsed.sessionId === 'string'
    ) {
      return parsed;
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      typeof parsed.type === 'string'
    ) {
      return {
        sessionId: key,
        runId: '',
        seq: 0,
        event: parsed as AgentStreamPayload,
      };
    }
    return {
      sessionId: key,
      runId: '',
      seq: 0,
      event: { type: 'error', error: 'Malformed agent stream event.' } satisfies AgentStreamPayload,
    };
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalFrameSeen = false;
  let errorFrameSeen = false;
  const emitEvent = (data: string) => {
    const event = parseEvent(data);
    if (event.event?.type === 'agent_end') terminalFrameSeen = true;
    if (event.event?.type === 'error') errorFrameSeen = true;
    onEvent(event);
  };
  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw new AgentStreamDisconnectError(error instanceof Error ? error.message : undefined);
    }
    const { value, done } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) emitEvent(data);
    }
  }
  buffer += decoder.decode();
  const data = buffer
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data) emitEvent(data);
  if (!terminalFrameSeen) {
    if (errorFrameSeen) throw new Error('agent stream ended after an error without a terminal frame');
    throw new AgentStreamDisconnectError();
  }
}

// Fetches model catalog for a specific provider.
export async function fetchProviderModels(provider: string): Promise<AgentModelsResponse> {
  const response = await fetch(`/api/agent/providers/${encodeURIComponent(provider)}/models`);
  if (!response.ok) {
    throw await responseError(response, 'provider model refresh failed');
  }
  return response.json();
}

export async function fetchAgentModelRegistry(): Promise<AgentModelRegistry> {
  const response = await fetch('/api/agent/model-registry');
  if (!response.ok) {
    throw await responseError(response, 'model registry fetch failed');
  }
  return response.json();
}

export async function resolveAgentModel(
  provider: string,
  id: string,
): Promise<AgentModelRegistryResolveResponse> {
  const response = await fetch('/api/agent/model-registry/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, id }),
  });
  if (!response.ok) {
    throw await responseError(response, 'model resolve failed');
  }
  return response.json();
}

// Updates a single provider profile (enabled, model, reasoning effort).
export async function saveProviderProfile(
  provider: string,
  update: ProviderProfileUpdate,
): Promise<MarketState> {
  const response = await fetch(`/api/agent/providers/${encodeURIComponent(provider)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!response.ok) {
    throw await responseError(response, 'provider profile save failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Saves shared agent settings to the local watchlist configuration.
export async function saveAgentConfig(config: AgentConfigUpdate): Promise<MarketState> {
  const response = await fetch('/api/agent/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw await responseError(response, 'agent config save failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Saves news-module settings (enabled flag, polling, etc.) and returns the updated state.
export async function saveNewsConfig(config: NewsConfigUpdate): Promise<MarketState> {
  const response = await fetch('/api/news/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw await responseError(response, 'news config save failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Saves options/GEX configuration and returns the updated runtime state.
export interface OptionsConfigUpdate {
  enabled?: boolean;
  provider?: 'yfinance' | 'tradier' | 'deribit' | 'marketdata';
  symbols?: string[];
  pollIntervalSeconds?: number;
  strikeRangePercent?: number;
  tradier?: { apiKey?: string; baseUrl?: string };
  marketdata?: { apiKey?: string; baseUrl?: string; strikeLimit?: number | null; dte?: number | null; callsPerMinute?: number | null };
  deribit?: { enabled?: boolean; currencies?: string[] };
}

export async function saveOptionsConfig(config: OptionsConfigUpdate): Promise<MarketState> {
  const response = await fetch('/api/options/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw await responseError(response, 'options config save failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Opens the live state WebSocket and normalizes connection-status callbacks.
export function connectStateSocket(onState: (state: MarketState) => void, onStatus: (status: string) => void) {
  const socket = new WebSocket(stateSocketUrl());
  socket.addEventListener('open', () => onStatus('connected'));
  socket.addEventListener('close', () => onStatus('disconnected'));
  socket.addEventListener('error', () => onStatus('error'));
  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'state') {
      onState(payload);
    }
  });
  return socket;
}

// Lists lessons generated from post-trade reviews.
export async function listLessons(instrumentKey?: string, limit?: number): Promise<Lesson[]> {
  const search = new URLSearchParams();
  if (instrumentKey) search.set('instrument_key', instrumentKey);
  if (limit != null) search.set('limit', String(limit));
  const query = search.toString();
  const response = await fetch(`/api/lessons${query ? `?${query}` : ''}`);
  if (!response.ok) {
    throw await responseError(response, 'list lessons failed');
  }
  const payload = await response.json();
  return payload.lessons;
}

export async function cancelExchangeOrder(
  exchange: string,
  orderId: string,
  symbol = '',
): Promise<void> {
  const params = symbol ? `?symbol=${encodeURIComponent(symbol)}` : '';
  const response = await fetch(
    `/api/exchange/orders/${encodeURIComponent(exchange)}/${encodeURIComponent(orderId)}${params}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw await responseError(response, 'cancel order failed');
  }
}

export interface NewsRefreshResponse {
  status: string;
  inserted: number;
  totalRecent: number;
  stale: boolean;
  error: string | null;
  news: NewsItem[];
}

// Triggers a synchronous news refresh; falls back to cache on timeout.
export async function triggerNewsRefresh(): Promise<NewsRefreshResponse> {
  const response = await fetch('/api/news/refresh', { method: 'POST' });
  if (!response.ok) {
    throw await responseError(response, 'news refresh failed');
  }
  return response.json();
}

// ── Cron Job API ──────────────────────────────────────────────────────────

// Lists all configured cron jobs with their runtime status.
export async function fetchCronJobs(): Promise<CronJobsResponse> {
  const response = await fetch('/api/cron/jobs');
  if (!response.ok) throw await responseError(response, 'cron jobs fetch failed');
  return await response.json();
}

// Lists run history for a specific job.
export async function fetchCronJobRuns(jobName: string): Promise<CronRunRecord[]> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(jobName)}/sessions`);
  if (!response.ok) throw await responseError(response, 'cron job runs fetch failed');
  const payload = await response.json();
  return payload.runs;
}

// Lists recent runs across all jobs.
export async function fetchCronRecentRuns(limit = 50): Promise<CronRunRecord[]> {
  const response = await fetch(`/api/cron/runs?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'cron recent runs fetch failed');
  const payload = await response.json();
  return payload.runs;
}

// Returns the full session entries for a single cron run.
export async function fetchCronSession(sessionId: string): Promise<{ jobName: string; entries: CronSessionEntry[] }> {
  const response = await fetch(`/api/cron/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw await responseError(response, 'cron session fetch failed');
  return response.json();
}

export async function deleteCronRun(sessionId: string): Promise<void> {
  const response = await fetch(`/api/cron/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'cron run delete failed');
}

export async function clearCronJobRuns(jobName: string): Promise<{ deleted: number }> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(jobName)}/sessions`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'cron job runs clear failed');
  return response.json();
}

// Manually triggers a cron job.
export async function triggerCronJob(jobName: string): Promise<{ ok: boolean; result?: unknown; detail?: string }> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(jobName)}/trigger`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'cron trigger failed');
  return response.json();
}

// Enables or disables a cron job at runtime.
export async function setCronJobEnabled(jobName: string, enabled: boolean): Promise<CronJobStatus[]> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(jobName)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw await responseError(response, 'cron job toggle failed');
  const payload = await response.json();
  return payload.jobs;
}

// Creates a new cron job. Persists to TOML and reloads the scheduler.
export async function createCronJob(job: CronJobCreate): Promise<CronJobStatus[]> {
  const response = await fetch('/api/cron/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
  if (!response.ok) throw await responseError(response, 'cron job create failed');
  const payload = await response.json();
  return payload.jobs;
}

// Updates an existing cron job. Persists to TOML and reloads the scheduler.
export async function updateCronJob(name: string, job: CronJobUpdate): Promise<CronJobStatus[]> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  });
  if (!response.ok) throw await responseError(response, 'cron job update failed');
  const payload = await response.json();
  return payload.jobs;
}

// Deletes a cron job. Persists to TOML and reloads the scheduler.
export async function deleteCronJob(name: string): Promise<CronJobStatus[]> {
  const response = await fetch(`/api/cron/jobs/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw await responseError(response, 'cron job delete failed');
  const payload = await response.json();
  return payload.jobs;
}

// ── MCP API ──────────────────────────────────────────────────────────────────

export async function fetchMcpStatus(): Promise<McpStatusResponse> {
  const response = await fetch('/api/mcp/status');
  if (!response.ok) throw await responseError(response, 'fetch MCP status failed');
  return response.json();
}

export async function connectMcpServer(name: string): Promise<{ server: string; status: string; toolCount?: number; tools?: { name: string; description: string }[]; error?: string }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/connect`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'MCP connect failed');
  return response.json();
}

export async function disconnectMcpServer(name: string): Promise<{ server: string; status: string }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/disconnect`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'MCP disconnect failed');
  return response.json();
}

export async function fetchMcpServerTools(name: string): Promise<McpServerToolsResponse> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/tools`);
  if (!response.ok) throw await responseError(response, 'fetch MCP tools failed');
  return response.json();
}

export async function fetchMcpResources(): Promise<McpAllResourcesResponse> {
  const response = await fetch('/api/mcp/resources');
  if (!response.ok) throw await responseError(response, 'fetch MCP resources failed');
  return response.json();
}

export async function fetchMcpServerResources(name: string, cursor?: string): Promise<McpServerResourcesResponse> {
  const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/resources${params}`);
  if (!response.ok) throw await responseError(response, 'fetch MCP server resources failed');
  return response.json();
}

export async function fetchMcpResourceTemplates(): Promise<McpAllResourceTemplatesResponse> {
  const response = await fetch('/api/mcp/resource-templates');
  if (!response.ok) throw await responseError(response, 'fetch MCP resource templates failed');
  return response.json();
}

export async function fetchMcpServerResourceTemplates(name: string, cursor?: string): Promise<McpServerResourceTemplatesResponse> {
  const params = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/resource-templates${params}`);
  if (!response.ok) throw await responseError(response, 'fetch MCP server resource templates failed');
  return response.json();
}

export async function readMcpResource(name: string, uri: string): Promise<McpReadResourceResponse> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/resources/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uri }),
  });
  if (!response.ok) throw await responseError(response, 'read MCP resource failed');
  return response.json();
}

export async function updateMcpSettings(settings: McpSettings): Promise<{ ok: boolean; settings: McpSettings }> {
  const response = await fetch('/api/mcp/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  });
  if (!response.ok) throw await responseError(response, 'update MCP settings failed');
  return response.json();
}

export async function addMcpServer(name: string, config: McpServerEntry): Promise<{ ok: boolean; server: string }> {
  const response = await fetch('/api/mcp/servers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, config }),
  });
  if (!response.ok) throw await responseError(response, 'add MCP server failed');
  return response.json();
}

export async function updateMcpServer(name: string, config: McpServerEntry): Promise<{ ok: boolean; server: string }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  if (!response.ok) throw await responseError(response, 'update MCP server failed');
  return response.json();
}

export async function deleteMcpServer(name: string): Promise<{ ok: boolean }> {
  const response = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, 'delete MCP server failed');
  return response.json();
}

// ─── Browser (Open Browser Use) ─────────────────────────────────────────────

export interface BrowserStatus {
  enabled: boolean;
  connected: boolean;
  socketPath: string | null;
  error: string | null;
}

export interface BrowserPingResult {
  ok: boolean;
  info?: unknown;
  error?: string;
}

export async function fetchBrowserStatus(): Promise<BrowserStatus> {
  const response = await fetch('/api/browser/status');
  if (!response.ok) throw await responseError(response, 'fetch browser status failed');
  return response.json();
}

export async function pingBrowser(): Promise<BrowserPingResult> {
  const response = await fetch('/api/browser/ping', { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'browser ping failed');
  return response.json();
}

export async function updateBrowserSettings(settings: {
  enabled?: boolean;
  socketPath?: string | null;
  timeoutMs?: number;
}): Promise<{ ok: boolean; browser: BrowserStatus }> {
  const response = await fetch('/api/browser/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw await responseError(response, 'update browser settings failed');
  return response.json();
}

// ─── Proxy ───────────────────────────────────────────────────────────────────

// Persists outbound proxy settings; backend reloads config and returns fresh state.
export async function saveProxyConfig(config: ProxyConfigUpdate): Promise<MarketState> {
  const response = await fetch('/api/proxy/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) throw await responseError(response, 'save proxy config failed');
  const data = (await response.json()) as { state: MarketState };
  return data.state;
}

// Probes the proxy without saving. Pass partial form values to test before committing.
export async function testProxy(config: ProxyConfigUpdate & { testUrl?: string }): Promise<ProxyTestResult> {
  const response = await fetch('/api/proxy/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) throw await responseError(response, 'proxy test failed');
  return response.json();
}

// ─── Jin10 API ──────────────────────────────────────────────────────────────────

export async function fetchJin10Status(): Promise<Jin10Status> {
  const response = await fetch('/api/jin10/status');
  if (!response.ok) throw await responseError(response, 'fetch jin10 status failed');
  return response.json();
}

export async function fetchJin10Calendar(): Promise<{ events: Jin10CalendarEvent[] }> {
  const response = await fetch('/api/jin10/calendar');
  if (!response.ok) throw await responseError(response, 'fetch jin10 calendar failed');
  return response.json();
}

export async function fetchJin10Quotes(): Promise<{ quotes: Jin10Quote[] }> {
  const response = await fetch('/api/jin10/quotes');
  if (!response.ok) throw await responseError(response, 'fetch jin10 quotes failed');
  return response.json();
}

export async function fetchJin10AvailableCodes(): Promise<{ codes: Array<{ code: string; name: string }>; error?: string }> {
  const response = await fetch('/api/jin10/available-codes');
  if (!response.ok) throw await responseError(response, 'fetch jin10 codes failed');
  return response.json();
}

export async function refreshJin10Flash(): Promise<{ inserted: number; error: string | null }> {
  const response = await fetch('/api/jin10/flash/refresh', { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'jin10 flash refresh failed');
  return response.json();
}

export async function refreshJin10Calendar(): Promise<{ count: number; error: string | null }> {
  const response = await fetch('/api/jin10/calendar/refresh', { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'jin10 calendar refresh failed');
  return response.json();
}

export async function saveJin10Config(config: {
  enabled?: boolean;
  token?: string;
  flash_enabled?: boolean;
  calendar_enabled?: boolean;
  quotes_enabled?: boolean;
  quotes_codes?: string[];
}): Promise<MarketState> {
  const response = await fetch('/api/jin10/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) throw await responseError(response, 'save jin10 config failed');
  const payload = await response.json();
  return payload.state;
}
