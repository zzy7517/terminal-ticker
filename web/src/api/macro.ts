/** 宏观数据层（FRED 序列 / 加密持仓结构 / 财经日历 / 事件窗口）的 HTTP 客户端。 */

import { responseError } from './http';

export type MacroCategory =
  | 'rates'
  | 'inflation'
  | 'dollar'
  | 'employment'
  | 'energy'
  | 'metals'
  | 'risk';

export interface MacroSeriesStats {
  seriesId: string;
  label: string;
  category: MacroCategory;
  unit: string | null;
  latest: number | null;
  latestTs: number | null;
  changeAbs: number | null;
  windowChangeAbs: number | null;
  zScore: number | null;
  percentile: number | null;
  windowMin: number | null;
  windowMax: number | null;
  sampleCount: number;
  ageMs: number | null;
}

export interface MacroSnapshot {
  atMs: number;
  series: MacroSeriesStats[];
  derived: {
    curveSteepness: number | null;
    realYield10y: number | null;
    cryptoVolPremium: number | null;
  };
}

export interface MacroStatus {
  enabled: boolean;
  fredConfigured: boolean;
  series: Array<{
    seriesId: string;
    label: string;
    source: string;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    latestTs: number | null;
    latestValue: number | null;
    pointCount: number;
  }>;
  calendar: {
    enabled: boolean;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    eventCount: number;
    providers: string[];
    fresh: boolean;
  };
}

export interface MacroEvent {
  key: string;
  pubTimeMs: number;
  title: string;
  country: string | null;
  impact: 'high' | 'medium' | 'low';
  star: number | null;
  previous: string | null;
  consensus: string | null;
  actual: string | null;
  revised: string | null;
  note: string | null;
  provider: string;
}

export interface MacroEventWindow {
  atMs: number;
  inWindow: boolean;
  unknown: boolean;
  blocked: boolean;
  reason: string | null;
  event: MacroEvent | null;
}

export type MacroRefreshSource = 'all' | 'fred' | 'calendar' | 'crypto' | 'quotes';

export async function fetchMacroStatus(): Promise<MacroStatus> {
  const response = await fetch('/api/macro/status');
  if (!response.ok) throw await responseError(response, 'fetch macro status failed');
  return response.json();
}

export async function fetchMacroSnapshot(windowDays?: number): Promise<MacroSnapshot> {
  const query = windowDays ? `?window_days=${windowDays}` : '';
  const response = await fetch(`/api/macro/snapshot${query}`);
  if (!response.ok) throw await responseError(response, 'fetch macro snapshot failed');
  return response.json();
}

export async function fetchMacroEvents(params: { hoursBack?: number; hoursAhead?: number } = {}): Promise<{
  events: MacroEvent[];
  count: number;
  fresh: boolean;
}> {
  const now = Date.now();
  const from = now - (params.hoursBack ?? 12) * 3600_000;
  const to = now + (params.hoursAhead ?? 72) * 3600_000;
  const response = await fetch(`/api/macro/events?from=${from}&to=${to}`);
  if (!response.ok) throw await responseError(response, 'fetch macro events failed');
  return response.json();
}

export async function fetchMacroEventWindow(): Promise<MacroEventWindow> {
  const response = await fetch('/api/macro/event-window');
  if (!response.ok) throw await responseError(response, 'fetch macro event window failed');
  return response.json();
}

export async function refreshMacro(source: MacroRefreshSource = 'all'): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/macro/refresh?source=${source}`, { method: 'POST' });
  if (!response.ok) throw await responseError(response, 'macro refresh failed');
  return response.json();
}
