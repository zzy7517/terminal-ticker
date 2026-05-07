import type {
  AgentConfigUpdate,
  AgentModelsResponse,
  AgentStreamEvent,
  ProviderProfileUpdate,
  AgentSessionHistoryResponse,
  AgentSessionMutationResponse,
  AgentSessionResponse,
  AnalysisConfigUpdate,
  ExchangeOrder,
  ExchangePosition,
  InstrumentSearchResult,
  Lesson,
  MarketState,
  NewsConfigUpdate,
  NewsItem,
  SecuritySearchResult,
  SocialAuthStatus,
  SocialFeedItem,
  SocialFeedConfigUpdate,
  Trade,
  TradeDetailResponse,
} from './types';

export interface HyperliquidTestnetOrderRequest {
  direction: 'long' | 'short';
  size: number;
  reasoning?: string;
  orderType?: 'market' | 'limit';
  limitPrice?: number | null;
  slippage?: number;
}

export interface BitgetDemoOrderRequest {
  direction: 'long' | 'short';
  size: number;
  reasoning?: string;
  orderType?: 'market' | 'limit';
  limitPrice?: number | null;
  marginMode?: 'crossed' | 'isolated';
  marginCoin?: string;
  force?: 'gtc' | 'ioc' | 'fok' | 'post_only';
  clientOid?: string;
}

// Builds a user-facing error while preserving FastAPI's structured detail when available.
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

// Searches the legacy securities endpoint retained for compatibility.
export async function searchSecurities(query: string): Promise<SecuritySearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`/api/securities/search?${params}`);
  if (!response.ok) {
    throw new Error(`search failed: ${response.status}`);
  }
  const payload = await response.json();
  return payload.results;
}

// Searches addable instruments for a specific market-data source.
export async function searchInstruments(source: string, query: string): Promise<InstrumentSearchResult[]> {
  const params = new URLSearchParams({ source, q: query });
  const response = await fetch(`/api/instruments/search?${params}`);
  if (!response.ok) {
    throw await responseError(response, 'search failed');
  }
  const payload = await response.json();
  return payload.results;
}

// Persists an Alpaca symbol to the watchlist and returns the reloaded state.
export async function addAlpacaSymbol(result: InstrumentSearchResult): Promise<MarketState> {
  const response = await fetch('/api/watchlist/alpaca', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol: result.symbol, label: result.label }),
  });
  if (!response.ok) {
    throw new Error(`add failed: ${response.status}`);
  }
  const payload = await response.json();
  return payload.state;
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

// Persists a Hyperliquid testnet instrument to the watchlist and returns the reloaded state.
export async function addHyperliquidTestnetSymbol(result: InstrumentSearchResult): Promise<MarketState> {
  const response = await fetch('/api/watchlist/hyperliquid-testnet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: result.symbol,
      label: result.label,
    }),
  });
  if (!response.ok) {
    throw await responseError(response, 'add failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Removes an Alpaca symbol through the source-specific compatibility route.
export async function removeAlpacaSymbol(symbol: string): Promise<MarketState> {
  const response = await fetch(`/api/watchlist/alpaca/${encodeURIComponent(symbol)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`remove failed: ${response.status}`);
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

// Loads the active chart-agent session for one instrument.
export async function fetchAgentSession(key: string): Promise<AgentSessionResponse> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(key)}`);
  if (!response.ok) {
    throw await responseError(response, 'agent session fetch failed');
  }
  return response.json();
}

// Lists saved chart-agent sessions for one instrument.
export async function fetchAgentSessionHistory(key: string): Promise<AgentSessionHistoryResponse> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(key)}/history`);
  if (!response.ok) {
    throw await responseError(response, 'agent session history fetch failed');
  }
  return response.json();
}

// Restores a saved chart-agent session as the active session for one instrument.
export async function resumeAgentSession(key: string, sessionId: string): Promise<AgentSessionMutationResponse> {
  const response = await fetch(
    `/api/agent/sessions/${encodeURIComponent(key)}/history/${encodeURIComponent(sessionId)}/resume`,
    { method: 'POST' },
  );
  if (!response.ok) {
    throw await responseError(response, 'agent session resume failed');
  }
  return response.json();
}

// Deletes a saved chart-agent session and returns the next active session state.
export async function deleteAgentSession(key: string, sessionId: string): Promise<AgentSessionMutationResponse> {
  const response = await fetch(
    `/api/agent/sessions/${encodeURIComponent(key)}/history/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw await responseError(response, 'agent session delete failed');
  }
  return response.json();
}

export async function streamAgentMessage(
  key: string,
  message: string,
  options: { provider?: string; model?: string } | undefined,
  onEvent: (event: AgentStreamEvent) => void,
): Promise<void> {
  const body: Record<string, string> = { message };
  if (options?.provider) body.provider = options.provider;
  if (options?.model) body.model = options.model;
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
      if (data) onEvent(JSON.parse(data) as AgentStreamEvent);
    }
  }
  buffer += decoder.decode();
  const data = buffer
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (data) onEvent(JSON.parse(data) as AgentStreamEvent);
}

// Starts a clean active chart-agent session without deleting historical sessions.
export async function resetAgentSession(
  key: string,
): Promise<AgentSessionResponse & { history: AgentSessionHistoryResponse }> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(key)}/reset`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw await responseError(response, 'agent session reset failed');
  }
  return response.json();
}

// Fetches the currently configured provider's visible model catalog.
export async function fetchAgentModels(): Promise<AgentModelsResponse> {
  const response = await fetch('/api/agent/models');
  if (!response.ok) {
    throw await responseError(response, 'model refresh failed');
  }
  return response.json();
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

// Saves global local-analysis settings and returns the updated runtime state.
export async function saveAnalysisConfig(config: AnalysisConfigUpdate): Promise<MarketState> {
  const response = await fetch('/api/analysis/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw await responseError(response, 'analysis config save failed');
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

// Saves the selected K-line interval for a single watchlist instrument.
export async function saveInstrumentAnalysisInterval(key: string, interval: string): Promise<MarketState> {
  const response = await fetch(`/api/instruments/${encodeURIComponent(key)}/analysis-interval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interval }),
  });
  if (!response.ok) {
    throw await responseError(response, 'instrument interval save failed');
  }
  const payload = await response.json();
  return payload.state;
}

// Requests another historical candle page for the selected instrument.
export async function loadOlderCandles(key: string): Promise<{ added: number; state: MarketState }> {
  const response = await fetch(`/api/instruments/${encodeURIComponent(key)}/candles/older`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw await responseError(response, 'older candles request failed');
  }
  return response.json();
}

// Opens the live state WebSocket and normalizes connection-status callbacks.
export function connectStateSocket(onState: (state: MarketState) => void, onStatus: (status: string) => void) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
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

// Lists trades with optional filters.
export async function listTrades(params: {
  instrumentKey?: string;
  status?: string;
  limit?: number;
} = {}): Promise<Trade[]> {
  const search = new URLSearchParams();
  if (params.instrumentKey) search.set('instrument_key', params.instrumentKey);
  if (params.status) search.set('status', params.status);
  if (params.limit != null) search.set('limit', String(params.limit));
  const query = search.toString();
  const response = await fetch(`/api/trades${query ? `?${query}` : ''}`);
  if (!response.ok) {
    throw await responseError(response, 'list trades failed');
  }
  const payload = await response.json();
  return payload.trades;
}

// Fetches a single trade including the frozen snapshot and related lessons.
export async function getTradeDetail(tradeId: number): Promise<TradeDetailResponse> {
  const response = await fetch(`/api/trades/${tradeId}`);
  if (!response.ok) {
    throw await responseError(response, 'trade detail failed');
  }
  return response.json();
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

// Triggers a manual review pass for recently-closed trades without a lesson yet.
export async function triggerTradeReview(limit = 3): Promise<Array<{
  tradeId: number;
  lessonId: number | null;
  success: boolean;
  error: string | null;
}>> {
  const response = await fetch('/api/trades/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit }),
  });
  if (!response.ok) {
    throw await responseError(response, 'trade review failed');
  }
  const payload = await response.json();
  return payload.results;
}

// Places a real Hyperliquid testnet order and records it in the local trade store.
export async function openHyperliquidTestnetTrade(
  instrumentKey: string,
  request: HyperliquidTestnetOrderRequest,
): Promise<{
  ok: boolean;
  testnet: boolean;
  trade: Trade;
  fill: unknown;
  order: unknown;
  state: MarketState;
}> {
  const response = await fetch(`/api/hyperliquid-testnet/trades/${encodeURIComponent(instrumentKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await responseError(response, 'Hyperliquid testnet order failed');
  }
  return response.json();
}

export async function fetchExchangePositions(): Promise<ExchangePosition[]> {
  const response = await fetch('/api/exchange/positions');
  if (!response.ok) {
    throw await responseError(response, 'exchange positions fetch failed');
  }
  const payload = await response.json();
  return payload.positions as ExchangePosition[];
}

export async function fetchExchangeOrders(): Promise<ExchangeOrder[]> {
  const response = await fetch('/api/exchange/orders');
  if (!response.ok) {
    throw await responseError(response, 'exchange orders fetch failed');
  }
  const payload = await response.json();
  return payload.orders as ExchangeOrder[];
}

export async function placeExchangeOrder(params: {
  instrumentKey: string;
  direction: string;
  size: number;
  order_type?: string;
  limit_price?: number;
  reasoning?: string;
}): Promise<{ exchange: string; orderId: string | null; localTradeId: number }> {
  const response = await fetch('/api/exchange/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw await responseError(response, 'exchange order failed');
  }
  return response.json();
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

// Fetches the latest cached news items from the local store.
export async function fetchNews(limit = 50): Promise<NewsItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  const response = await fetch(`/api/news?${params}`);
  if (!response.ok) {
    throw await responseError(response, 'news fetch failed');
  }
  const payload = await response.json();
  return payload.news as NewsItem[];
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
