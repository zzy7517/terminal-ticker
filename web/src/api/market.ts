/** 行情快照、观察列表、交易所与新闻刷新客户端。 */
import type {
  InstrumentCatalogResponse,
  InstrumentSearchResult,
  Lesson,
  MarketState,
  NewsItem,
} from '../types';
import { responseError, stateSocketUrl } from './http';

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
  sources?: Record<string, { status: string; inserted: number; error: string | null }>;
}

// Triggers a synchronous news refresh; falls back to cache on timeout.
export async function triggerNewsRefresh(): Promise<NewsRefreshResponse> {
  const response = await fetch('/api/news/refresh', { method: 'POST' });
  if (!response.ok) {
    throw await responseError(response, 'news refresh failed');
  }
  return response.json();
}
