/**
 * Derived macro metrics.
 *
 * Everything here is **descriptive**, never directional. We report "10Y yield is
 * at the 95th percentile of the last 90 days"; we do not report "yields are high
 * so risk assets should fall". The transmission from macro to crypto price is
 * long and unstable, so hard-coding that mapping would almost certainly
 * overfit — the interpretation belongs to the Agent (see 决策 3).
 *
 * Pure functions over stored points. No I/O.
 */

import type { MacroCategory, MacroPoint } from "./domain.js";

/** Descriptive statistics for one series over a trailing window. */
export interface SeriesStats {
  seriesId: string;
  label: string;
  category: MacroCategory;
  unit: string | null;
  latest: number | null;
  latestTs: number | null;
  /** Change versus the previous observation. */
  changeAbs: number | null;
  /** Change over the trailing window, in absolute units. */
  windowChangeAbs: number | null;
  /** Standard deviations from the window mean. null when variance is zero. */
  zScore: number | null
  /** Position within the window's range, 0-100. */
  percentile: number | null;
  windowMin: number | null;
  windowMax: number | null;
  /** Number of non-null observations backing the statistics. */
  sampleCount: number;
  /** Age of the latest observation in ms; large values mean the feed is stale. */
  ageMs: number | null;
}

export interface MacroSnapshot {
  atMs: number;
  series: SeriesStats[];
  derived: DerivedMetrics;
}

export interface DerivedMetrics {
  /**
   * 10Y minus 2Y in percentage points. Negative means an inverted curve.
   * Computed from `us10y` / `us2y` rather than read from FRED's `T10Y2Y` so it
   * still works when only the two legs are available.
   */
  curveSteepness: number | null;
  /**
   * 10Y nominal yield minus 10Y breakeven inflation — the real yield. This is
   * the single most-cited macro input for risk-asset valuation.
   */
  realYield10y: number | null;
  /** DVOL minus VIX, i.e. how much crypto vol exceeds equity vol. */
  cryptoVolPremium: number | null;
}

const MISSING_STATS = {
  latest: null,
  latestTs: null,
  changeAbs: null,
  windowChangeAbs: null,
  zScore: null,
  percentile: null,
  windowMin: null,
  windowMax: null,
  sampleCount: 0,
  ageMs: null,
} as const;

/**
 * Compute statistics for one series.
 *
 * `points` must be ordered newest-first, as returned by `MacroStore.getSeries`.
 */
export function computeSeriesStats(
  meta: { seriesId: string; label: string; category: MacroCategory; unit: string | null },
  points: MacroPoint[],
  atMs: number,
): SeriesStats {
  const observed = points.filter((p): p is MacroPoint & { value: number } => p.value !== null);
  if (observed.length === 0) {
    return { ...meta, ...MISSING_STATS };
  }

  const values = observed.map((p) => p.value);
  const latest = values[0]!;
  const latestTs = observed[0]!.ts;
  const oldest = values[values.length - 1]!;

  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  const windowMin = Math.min(...values);
  const windowMax = Math.max(...values);
  const span = windowMax - windowMin;

  return {
    ...meta,
    latest,
    latestTs,
    changeAbs: values.length > 1 ? latest - values[1]! : null,
    windowChangeAbs: values.length > 1 ? latest - oldest : null,
    // A flat series has no meaningful z-score; reporting 0 would imply "average"
    // when the truth is "no variation to compare against".
    zScore: stdDev > 0 ? (latest - mean) / stdDev : null,
    percentile: span > 0 ? ((latest - windowMin) / span) * 100 : null,
    windowMin,
    windowMax,
    sampleCount: values.length,
    ageMs: atMs - latestTs,
  };
}

/** Derive cross-series metrics from a set of computed stats. */
export function computeDerived(stats: SeriesStats[]): DerivedMetrics {
  const latestOf = (seriesId: string): number | null =>
    stats.find((s) => s.seriesId === seriesId)?.latest ?? null;

  const us10y = latestOf("us10y");
  const us2y = latestOf("us2y");
  const breakeven = latestOf("breakeven_10y");
  const dvolBtc = latestOf("dvol_btc");
  const vix = latestOf("vix");

  return {
    curveSteepness: us10y !== null && us2y !== null ? round(us10y - us2y, 3) : null,
    realYield10y: us10y !== null && breakeven !== null ? round(us10y - breakeven, 3) : null,
    cryptoVolPremium: dvolBtc !== null && vix !== null ? round(dvolBtc - vix, 2) : null,
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
