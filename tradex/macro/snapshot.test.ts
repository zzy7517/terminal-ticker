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
});

function stat(seriesId: string, latest: number | null): SeriesStats {
  return {
    seriesId,
    label: seriesId,
    category: "rates",
    unit: null,
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

  it("returns nulls for an empty stat set", () => {
    expect(computeDerived([])).toEqual({
      curveSteepness: null,
      realYield10y: null,
      cryptoVolPremium: null,
    });
  });
});
