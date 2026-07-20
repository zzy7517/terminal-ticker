/** 工作台配置客户端：News、Options、Browser、Proxy 与 Jin10。 */
import type {
  MarketState,
  NewsConfigUpdate,
  ProxyConfigUpdate,
  ProxyTestResult,
} from '../types';
import { responseError } from './http';

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

// ─── Jin10 ──────────────────────────────────────────────────────────────────

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
