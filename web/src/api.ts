import type {
  AgentConfigUpdate,
  AgentModelsResponse,
  AgentStreamEvent,
  AgentStreamPayload,
  ProviderProfileUpdate,
  AgentSessionHistoryResponse,
  AgentSessionMutationResponse,
  AgentSessionResponse,
  CronJobCreate,
  CronJobsResponse,
  CronJobStatus,
  CronJobUpdate,
  CronRunRecord,
  CronSessionEntry,
  InstrumentCatalogResponse,
  InstrumentSearchResult,
  Lesson,
  MarketState,
  MemoryBrowseListResult,
  MemoryBrowseReadResult,
  MemoryBrowseSearchResult,
  MemoryConfigUpdate,
  MemoryStatus,
  NewsConfigUpdate,
  NewsItem,
  SocialAuthStatus,
  SocialFeedItem,
  SocialFeedConfigUpdate,
  McpStatusResponse,
  McpServerToolsResponse,
  McpSettings,
  McpServerEntry,
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

// Injects a steering message into an actively-running agent session.
export async function steerAgentSession(sessionId: string, message: string): Promise<void> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/steer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) {
    throw await responseError(response, 'agent steer failed');
  }
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

export async function streamAgentMessage(
  key: string,
  message: string,
  options: { provider?: string; model?: string; afterSeq?: number } | undefined,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const body: Record<string, string | string[] | number> = { message };
  if (options?.provider) body.provider = options.provider;
  if (options?.model) body.model = options.model;
  if (typeof options?.afterSeq === 'number') body.afterSeq = options.afterSeq;
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(key)}/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
  while (true) {
    const { value, done } = await reader.read();
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
      if (data) onEvent(parseEvent(data));
    }
  }
  buffer += decoder.decode();
  const data = buffer
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data) onEvent(parseEvent(data));
}

// Fetches model catalog for a specific provider.
export async function fetchProviderModels(provider: string): Promise<AgentModelsResponse> {
  const response = await fetch(`/api/agent/providers/${encodeURIComponent(provider)}/models`);
  if (!response.ok) {
    throw await responseError(response, 'provider model refresh failed');
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

// Saves social feed settings and returns the updated runtime state.
export async function saveSocialFeedConfig(config: SocialFeedConfigUpdate): Promise<MarketState> {
  const response = await fetch('/api/social/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw await responseError(response, 'social feed config save failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Reads whether X auth cookies are saved locally without exposing their values.
export async function fetchSocialAuthStatus(): Promise<SocialAuthStatus> {
  const response = await fetch('/api/social/auth');
  if (!response.ok) {
    throw await responseError(response, 'social auth status failed');
  }
  return response.json();
}

// Saves X auth cookies to the backend's local auth store.
export async function saveSocialAuth(auth: { authToken: string; ct0: string }): Promise<SocialAuthStatus> {
  const response = await fetch('/api/social/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(auth),
  });
  if (!response.ok) {
    throw await responseError(response, 'social auth save failed');
  }
  return response.json();
}

// Clears the locally saved X auth cookies.
export async function clearSocialAuth(): Promise<SocialAuthStatus> {
  const response = await fetch('/api/social/auth', { method: 'DELETE' });
  if (!response.ok) {
    throw await responseError(response, 'social auth clear failed');
  }
  return response.json();
}

// Triggers a small X Following refresh to validate saved auth and connectivity.
export async function triggerXFollowingRefresh(count = 3): Promise<{
  status: string;
  inserted: number;
  totalRecent: number;
  error: string | null;
}> {
  const response = await fetch('/api/social/x/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ count }),
  });
  if (!response.ok) {
    throw await responseError(response, 'X refresh failed');
  }
  return response.json();
}

// Reads locally cached social feed items for settings-page smoke tests.
export async function fetchRecentSocialFeed(limit = 3): Promise<SocialFeedItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(`/api/social/feed?${params}`);
  if (!response.ok) {
    throw await responseError(response, 'social feed fetch failed');
  }
  const payload = await response.json();
  return payload.items ?? [];
}

// Fetches the current memory pipeline status and config.
export async function fetchMemoryStatus(): Promise<MemoryStatus> {
  const response = await fetch('/api/memory/status');
  if (!response.ok) {
    throw await responseError(response, 'memory status failed');
  }
  return response.json();
}

// Saves memory module settings (enabled, models, etc.) and returns the updated state.
export async function saveMemoryConfig(config: MemoryConfigUpdate): Promise<MarketState> {
  const response = await fetch('/api/memory/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw await responseError(response, 'memory config save failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Lists files in the memory directory.
export async function memoryList(path?: string): Promise<MemoryBrowseListResult> {
  const response = await fetch('/api/memory/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', params: { path: path || null } }),
  });
  if (!response.ok) {
    throw await responseError(response, 'memory list failed');
  }
  return response.json();
}

// Reads a memory file by relative path.
export async function memoryRead(path: string): Promise<MemoryBrowseReadResult> {
  const response = await fetch('/api/memory/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'read', params: { path } }),
  });
  if (!response.ok) {
    throw await responseError(response, 'memory read failed');
  }
  return response.json();
}

// Searches memory files by keywords.
export async function memorySearch(queries: string[], path?: string): Promise<MemoryBrowseSearchResult> {
  const response = await fetch('/api/memory/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'search', params: { queries, path: path || null } }),
  });
  if (!response.ok) {
    throw await responseError(response, 'memory search failed');
  }
  return response.json();
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
