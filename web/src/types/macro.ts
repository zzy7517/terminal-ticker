/** 宏观数据层（FRED 序列 / 加密持仓结构 / 财经日历 / 事件窗口）DTO。 */

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
  /** 非 null 表示该序列是水平值，统计前已转成变化率（CPI 同比、非农月度新增）。 */
  transform: 'yoyPercent' | 'periodDiff' | null;
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
