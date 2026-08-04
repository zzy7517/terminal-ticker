import { describe, expect, it } from "vitest";
import { computeDerived, computeSeriesStats, type SeriesStats } from "./snapshot.js";
import type { MacroPoint } from "./domain.js";

const META = { seriesId: "us10y", label: "10Y", category: "rates" as const, unit: "%" };
const AT = Date.UTC(2026, 1, 12);
const DAY = 86_400_000;

/** Newest-first, matching MacroStore.getSeries. */
function series(values: Array<number | null>): MacroPoint[] {
  return values.map((value, i) => ({
    seriesId: "us10y",
    ts: AT - i * DAY,
    value,
    vintageTs: null,
  }));
}

describe("computeSeriesStats", () => {
  it("reports nulls rather than zeros when no data exists", () => {
    const stats = computeSeriesStats(META, [], AT);
    expect(stats.latest).toBeNull();
    expect(stats.zScore).toBeNull();
    expect(stats.percentile).toBeNull();
    expect(stats.sampleCount).toBe(0);
  });

  it("ignores missing observations", () => {
    const stats = computeSeriesStats(META, series([null, null, 4.2, 4.1]), AT);
    expect(stats.latest).toBe(4.2);
    expect(stats.sampleCount).toBe(2);
    // Age is measured from the newest *observed* point, two days back.
    expect(stats.ageMs).toBe(2 * DAY);
  });

  it("computes change against the previous observation and the window edge", () => {
    const stats = computeSeriesStats(META, series([4.5, 4.4, 4.0]), AT);
    expect(stats.changeAbs).toBeCloseTo(0.1, 10);
    expect(stats.windowChangeAbs).toBeCloseTo(0.5, 10);
  });

  it("places the latest value within the window range", () => {
    const stats = computeSeriesStats(META, series([5, 3, 1]), AT);
    expect(stats.windowMin).toBe(1);
    expect(stats.windowMax).toBe(5);
    expect(stats.percentile).toBe(100);
  });

  it("returns null z-score for a flat series instead of implying 'average'", () => {
    // Reporting 0 here would read as "at the mean", when the truth is there is
    // no variation to compare against.
    const stats = computeSeriesStats(META, series([4.2, 4.2, 4.2]), AT);
    expect(stats.zScore).toBeNull();
    expect(stats.percentile).toBeNull();
  });

  it("computes a z-score against the window mean", () => {
    // values [3,1,2]: mean 2, population sd = sqrt(2/3) ≈ 0.8165
    const stats = computeSeriesStats(META, series([3, 1, 2]), AT);
    expect(stats.zScore).toBeCloseTo(1 / Math.sqrt(2 / 3), 6);
  });

  it("handles a single observation", () => {
    const stats = computeSeriesStats(META, series([4.2]), AT);
    expect(stats.latest).toBe(4.2);
    expect(stats.changeAbs).toBeNull();
    expect(stats.windowChangeAbs).toBeNull();
    expect(stats.zScore).toBeNull();
  });

  it("reports no transform for a series measured as published", () => {
    expect(computeSeriesStats(META, series([4.2, 4.1]), AT).transform).toBeNull();
  });
});

// ── Level series ──────────────────────────────────────────────────────────────

const MONTH = 30 * DAY;

/** Monthly observations, newest-first. */
function monthly(seriesId: string, values: number[]): MacroPoint[] {
  return values.map((value, i) => ({ seriesId, ts: AT - i * MONTH, value, vintageTs: null }));
}

const CPI_META = {
  seriesId: "cpi",
  label: "CPI（季调）",
  category: "inflation" as const,
  unit: "index",
  stat: {
    transform: "yoyPercent" as const,
    lag: 12,
    label: "CPI 同比",
    unit: "%",
    lookbackDays: 430,
  },
};

describe("computeSeriesStats with a level transform", () => {
  it("rescues the percentile a monotonic index would otherwise pin at 100", () => {
    // A price index climbing a steady 0.5/month.
    const climbing = Array.from({ length: 25 }, (_, i) => 300 - i * 0.5);

    // Raw: the newest reading is always the window maximum, so the percentile
    // is 100 no matter what the data does. That is the bug — a reader sees an
    // inflation extreme where the only fact is "the index rose again".
    const raw = computeSeriesStats({ ...CPI_META, stat: undefined }, monthly("cpi", climbing), AT);
    expect(raw.percentile).toBe(100);

    // Year-over-year: a fixed absolute increment on a growing base is a
    // *decelerating* rate, so the newest print sits at the bottom of its range.
    // Opposite conclusion from the same data, and the correct one.
    const yoy = computeSeriesStats(CPI_META, monthly("cpi", climbing), AT);
    expect(yoy.percentile).toBe(0);
    expect(yoy.zScore).toBeLessThan(0);
  });

  it("computes year-over-year percent against the 12th observation back", () => {
    // Newest 105, twelve months back 100 → +5%.
    const values = [105, ...Array.from({ length: 11 }, () => 102), 100, 99];
    const stats = computeSeriesStats(CPI_META, monthly("cpi", values), AT);
    expect(stats.latest).toBeCloseTo(5, 10);
  });

  it("relabels the quantity so a rate is not read as an index level", () => {
    const stats = computeSeriesStats(CPI_META, monthly("cpi", [105, 100]), AT);
    expect(stats.label).toBe("CPI 同比");
    expect(stats.unit).toBe("%");
    expect(stats.transform).toBe("yoyPercent");
  });

  it("differences an employment stock into the monthly change", () => {
    const meta = {
      seriesId: "payrolls",
      label: "非农就业人数",
      category: "employment" as const,
      unit: "千人",
      stat: {
        transform: "periodDiff" as const,
        lag: 1,
        label: "非农就业月度新增",
        unit: "千人",
        lookbackDays: 70,
      },
    };
    // 159_482 total, up from 159_335 → +147k, the figure quoted on release day.
    const stats = computeSeriesStats(meta, monthly("payrolls", [159_482, 159_335]), AT);
    expect(stats.latest).toBe(147);
    expect(stats.unit).toBe("千人");
  });

  it("counts lag in observations so a gap cannot shorten the comparison", () => {
    // A null in the middle must not make the 12th row back a 13-month lookback.
    const values: Array<number | null> = [105, null, ...Array.from({ length: 11 }, () => 102), 100];
    const points = values.map((value, i) => ({
      seriesId: "cpi",
      ts: AT - i * MONTH,
      value,
      vintageTs: null,
    }));
    const stats = computeSeriesStats(CPI_META, points, AT);
    expect(stats.latest).toBeCloseTo(5, 10);
  });

  it("drops transformed points outside the reporting window", () => {
    // 24 monthly prints; window covers only the last 6 months.
    const values = Array.from({ length: 24 }, (_, i) => 200 - i);
    const stats = computeSeriesStats(CPI_META, monthly("cpi", values), AT, AT - 6 * MONTH);
    // 24 raw − 12 for the lag = 12 transformed, of which 7 fall inside.
    expect(stats.sampleCount).toBe(7);
  });

  it("reports missing stats when history is too short to transform", () => {
    const stats = computeSeriesStats(CPI_META, monthly("cpi", [105, 104, 103]), AT);
    expect(stats.latest).toBeNull();
    expect(stats.sampleCount).toBe(0);
    // The label still describes what the series would have been.
    expect(stats.label).toBe("CPI 同比");
  });

  it("skips a zero base instead of dividing by it", () => {
    const values = [5, ...Array.from({ length: 11 }, () => 3), 0];
    const stats = computeSeriesStats(CPI_META, monthly("cpi", values), AT);
    expect(stats.latest).toBeNull();
  });
});

function stat(seriesId: string, latest: number | null): SeriesStats {
  return {
    seriesId,
    label: seriesId,
    category: "rates",
    unit: null,
    transform: null,
    latest,
    latestTs: AT,
    changeAbs: null,
    windowChangeAbs: null,
    zScore: null,
    percentile: null,
    windowMin: null,
    windowMax: null,
    sampleCount: 1,
    ageMs: 0,
  };
}

describe("computeDerived", () => {
  it("derives curve steepness, real yield and crypto vol premium", () => {
    const derived = computeDerived([
      stat("us10y", 4.25),
      stat("us2y", 4.67),
      stat("breakeven_10y", 2.3),
      stat("dvol_btc", 37.28),
      stat("vix", 18.58),
    ]);

    // Inverted curve: 2Y above 10Y.
    expect(derived.curveSteepness).toBe(-0.42);
    expect(derived.realYield10y).toBe(1.95);
    expect(derived.cryptoVolPremium).toBe(18.7);
  });

  it("returns null when a leg is missing rather than guessing", () => {
    const derived = computeDerived([stat("us10y", 4.25), stat("us2y", null)]);
    expect(derived.curveSteepness).toBeNull();
    expect(derived.realYield10y).toBeNull();
    expect(derived.cryptoVolPremium).toBeNull();
  });

  it("prefers FRED's published 2s10s over the two-leg subtraction", () => {
    // Legs would give -0.42; the published series wins so both paths cannot
    // drift apart.
    const derived = computeDerived([
      stat("curve_2s10s", -0.4),
      stat("us10y", 4.25),
      stat("us2y", 4.67),
    ]);
    expect(derived.curveSteepness).toBe(-0.4);
  });

  it("falls back to the legs when the published series has no value", () => {
    const derived = computeDerived([
      stat("curve_2s10s", null),
      stat("us10y", 4.25),
      stat("us2y", 4.67),
    ]);
    expect(derived.curveSteepness).toBe(-0.42);
  });

  it("refuses the leg fallback when the legs are from different dates", () => {
    // DGS10 updated, DGS2 has not yet — subtracting them would invent a spread
    // that was never observed on any single day.
    const long = stat("us10y", 4.25);
    const short = { ...stat("us2y", 4.67), latestTs: AT - DAY };
    expect(computeDerived([long, short]).curveSteepness).toBeNull();
  });

  it("returns nulls for an empty stat set", () => {
    expect(computeDerived([])).toEqual({
      curveSteepness: null,
      realYield10y: null,
      cryptoVolPremium: null,
    });
  });
});
