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

import type { MacroCategory, MacroPoint, MacroStatSpec } from "./domain.js";

/** Descriptive statistics for one series over a trailing window. */
export interface SeriesStats {
  seriesId: string;
  label: string;
  category: MacroCategory;
  unit: string | null;
  /**
   * The transform applied before any statistic was computed, or null when the
   * series is measured as published. Surfaced so a reader can tell "CPI 2.7"
   * (year-over-year percent) from an index level — see {@link MacroStatSpec}.
   */
  transform: MacroStatSpec["transform"] | null;
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
   *
   * Prefers FRED's own `curve_2s10s` (T10Y2Y), falling back to `us10y - us2y`
   * so the metric still works when only the two legs are available. The
   * fallback requires both legs to share an observation date: FRED publishes
   * DGS10 and DGS2 independently, so a sweep that lands between the two would
   * otherwise splice different days into a spread that never existed.
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
 * Convert a level series into its rate of change.
 *
 * Operates on already-filtered observations so `lag` counts real prints: if a
 * month is missing, comparing "12 rows back" against "12 months back" would
 * quietly change the meaning of the number.
 *
 * Input and output are both newest-first. The oldest `lag` observations have no
 * predecessor and drop out, which is why callers must over-fetch by
 * {@link MacroStatSpec.lookbackDays}.
 */
function applyStatTransform(
  observed: Array<MacroPoint & { value: number }>,
  spec: MacroStatSpec,
): Array<MacroPoint & { value: number }> {
  const out: Array<MacroPoint & { value: number }> = [];
  for (let i = 0; i + spec.lag < observed.length; i++) {
    const current = observed[i]!;
    const previous = observed[i + spec.lag]!;
    if (spec.transform === "periodDiff") {
      out.push({ ...current, value: current.value - previous.value });
      continue;
    }
    // yoyPercent: a zero base has no percent change to express.
    if (previous.value === 0) continue;
    out.push({ ...current, value: ((current.value - previous.value) / previous.value) * 100 });
  }
  return out;
}

/**
 * Compute statistics for one series.
 *
 * `points` must be ordered newest-first, as returned by `MacroStore.getSeries`.
 *
 * When `meta.stat` is set, `points` is expected to reach further back than the
 * reporting window — the transform consumes that margin, and `windowFromMs`
 * then trims the result to the window the caller actually asked for. Omitting
 * `windowFromMs` keeps every transformed point, which is what tests and
 * single-series callers want.
 */
export function computeSeriesStats(
  meta: {
    seriesId: string;
    label: string;
    category: MacroCategory;
    unit: string | null;
    stat?: MacroStatSpec;
  },
  points: MacroPoint[],
  atMs: number,
  windowFromMs?: number,
): SeriesStats {
  const { stat, ...identity } = meta;
  // The transform renames the quantity: "CPI（季调）" in index points becomes
  // "CPI 同比" in percent, and reporting the raw label would misdescribe it.
  const described = stat ? { ...identity, label: stat.label, unit: stat.unit } : identity;
  const head = { ...described, transform: stat?.transform ?? null };

  let observed = points.filter((p): p is MacroPoint & { value: number } => p.value !== null);
  if (stat) observed = applyStatTransform(observed, stat);
  if (windowFromMs !== undefined) observed = observed.filter((p) => p.ts >= windowFromMs);

  if (observed.length === 0) {
    return { ...head, ...MISSING_STATS };
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
    ...head,
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
  const find = (seriesId: string): SeriesStats | undefined =>
    stats.find((s) => s.seriesId === seriesId);
  const latestOf = (seriesId: string): number | null => find(seriesId)?.latest ?? null;

  const us10y = latestOf("us10y");
  const us2y = latestOf("us2y");
  const breakeven = latestOf("breakeven_10y");
  const dvolBtc = latestOf("dvol_btc");
  const vix = latestOf("vix");

  return {
    curveSteepness: resolveCurveSteepness(find),
    realYield10y: us10y !== null && breakeven !== null ? round(us10y - breakeven, 3) : null,
    cryptoVolPremium: dvolBtc !== null && vix !== null ? round(dvolBtc - vix, 2) : null,
  };
}

/**
 * 2s10s spread: FRED's published series first, the two legs second.
 *
 * The leg fallback is date-guarded on purpose. `latest` is whatever each series
 * most recently has, and the legs are separate FRED series — mixing a Tuesday
 * 10Y with a Monday 2Y yields a spread that was never observed, which is worse
 * than reporting nothing.
 */
function resolveCurveSteepness(
  find: (seriesId: string) => SeriesStats | undefined,
): number | null {
  const published = find("curve_2s10s")?.latest;
  if (published !== null && published !== undefined) return round(published, 3);

  const long = find("us10y");
  const short = find("us2y");
  if (!long || !short) return null;
  if (long.latest === null || short.latest === null) return null;
  if (long.latestTs === null || long.latestTs !== short.latestTs) return null;
  return round(long.latest - short.latest, 3);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
