import type {
  AgentAnalysis,
  AgentConfigUpdate,
  AgentModelsResponse,
  AgentSessionResponse,
  AnalysisConfigUpdate,
  InstrumentSearchResult,
  MarketState,
  SecuritySearchResult,
} from './types';

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

// Appends a user turn to the active chart-agent session and waits for the provider result.
export async function sendAgentMessage(
  key: string,
  message: string,
): Promise<{ result: AgentAnalysis; session: AgentSessionResponse; state: MarketState }> {
  const response = await fetch(`/api/agent/sessions/${encodeURIComponent(key)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) {
    throw await responseError(response, 'agent message failed');
  }
  return response.json();
}

// Starts a clean active chart-agent session without deleting historical sessions.
export async function resetAgentSession(key: string): Promise<AgentSessionResponse> {
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

// Saves LLM provider settings to the local watchlist configuration.
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
