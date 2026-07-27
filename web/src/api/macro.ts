/** 宏观数据层（FRED 序列 / 加密持仓结构 / 财经日历 / 事件窗口）的 HTTP 客户端。 */

import type {
  MacroEvent,
  MacroEventWindow,
  MacroRefreshSource,
  MacroSnapshot,
  MacroStatus,
} from '../types';
import { responseError } from './http';

export type {
  MacroCategory,
  MacroEvent,
  MacroEventWindow,
  MacroRefreshSource,
  MacroSeriesStats,
  MacroSnapshot,
  MacroStatus,
} from '../types';

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
