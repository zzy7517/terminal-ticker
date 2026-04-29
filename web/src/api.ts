import type {
  AgentAnalysis,
  AgentConfigUpdate,
  AgentModelsResponse,
  AnalysisConfigUpdate,
  InstrumentSearchResult,
  MarketState,
  SecuritySearchResult,
} from './types';

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

export async function fetchState(): Promise<MarketState> {
  const response = await fetch('/api/state');
  if (!response.ok) {
    throw new Error(`state request failed: ${response.status}`);
  }
  return response.json();
}

export async function searchSecurities(query: string): Promise<SecuritySearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const response = await fetch(`/api/securities/search?${params}`);
  if (!response.ok) {
    throw new Error(`search failed: ${response.status}`);
  }
  const payload = await response.json();
  return payload.results;
}

export async function searchInstruments(source: string, query: string): Promise<InstrumentSearchResult[]> {
  const params = new URLSearchParams({ source, q: query });
  const response = await fetch(`/api/instruments/search?${params}`);
  if (!response.ok) {
    throw await responseError(response, 'search failed');
  }
  const payload = await response.json();
  return payload.results;
}

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

export async function analyzeInstrument(key: string): Promise<{ result: AgentAnalysis; state: MarketState }> {
  const response = await fetch(`/api/agent/analyze/${encodeURIComponent(key)}`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(`agent analysis failed: ${response.status}`);
  }
  return response.json();
}

export async function fetchAgentModels(): Promise<AgentModelsResponse> {
  const response = await fetch('/api/agent/models');
  if (!response.ok) {
    throw await responseError(response, 'model refresh failed');
  }
  return response.json();
}

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

export async function loadOlderCandles(key: string): Promise<{ added: number; state: MarketState }> {
  const response = await fetch(`/api/instruments/${encodeURIComponent(key)}/candles/older`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw await responseError(response, 'older candles request failed');
  }
  return response.json();
}

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
