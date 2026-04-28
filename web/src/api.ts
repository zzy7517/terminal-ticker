import type { MarketState, SecuritySearchResult } from './types';

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

export async function addLongbridgeSymbol(result: SecuritySearchResult): Promise<MarketState> {
  const response = await fetch('/api/watchlist/longbridge', {
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

export async function removeLongbridgeSymbol(symbol: string): Promise<MarketState> {
  const response = await fetch(`/api/watchlist/longbridge/${encodeURIComponent(symbol)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`remove failed: ${response.status}`);
  }
  const payload = await response.json();
  return payload.state;
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
