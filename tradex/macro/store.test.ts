import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MacroStore, impactsAtLeast } from "./store.js";
import type { MacroEvent, MacroPoint } from "./domain.js";
import { MACRO_SERIES } from "./registry.js";

const dirs: string[] = [];

function tempStore(): MacroStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tradex-macro-"));
  dirs.push(dir);
  return new MacroStore(path.join(dir, "macro.sqlite3"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const JAN_31 = Date.UTC(2026, 0, 31);
const FEB_12 = Date.UTC(2026, 1, 12);
const FEB_01 = Date.UTC(2026, 1, 1);
const MAR_12 = Date.UTC(2026, 2, 12);

function point(over: Partial<MacroPoint> = {}): MacroPoint {
  return { seriesId: "cpi", ts: JAN_31, value: 310.5, vintageTs: FEB_12, ...over };
}

function event(over: Partial<MacroEvent> = {}): MacroEvent {
  return {
    key: `${FEB_12}:cpi`,
    pubTimeMs: FEB_12,
    title: "美国1月CPI年率",
    normalizedTitle: "美国1月cpi年率",
    country: "美国",
    impact: "high",
    star: 5,
    previous: "3.1%",
    consensus: "3.0%",
    actual: null,
    revised: null,
    note: null,
    provider: "jin10",
    fetchedAtMs: FEB_01,
    ...over,
  };
}

describe("MacroStore vintage semantics", () => {
  it("hides a value from asOf reads until its publication date", () => {
    const store = tempStore();
    store.upsertPoints([point()]);

    // Feb 1: January CPI exists as a period but was not published until Feb 12.
    expect(store.getSeries("cpi", { asOfMs: FEB_01 })).toEqual([]);
    expect(store.getLatest("cpi", FEB_01)).toBeNull();

    // Feb 12 onwards it is visible.
    expect(store.getLatest("cpi", FEB_12)?.value).toBe(310.5);
  });

  it("returns the latest vintage available at asOf, not the newest overall", () => {
    const store = tempStore();
    store.upsertPoints([
      point({ value: 310.5, vintageTs: FEB_12 }),
      point({ value: 311.2, vintageTs: MAR_12 }), // revision
    ]);

    // Between the two publications only the first print is knowable.
    expect(store.getLatest("cpi", Date.UTC(2026, 1, 20))?.value).toBe(310.5);
    // After the revision the corrected value wins.
    expect(store.getLatest("cpi", MAR_12)?.value).toBe(311.2);
  });

  it("keeps both vintages rather than overwriting", () => {
    const store = tempStore();
    store.upsertPoints([
      point({ value: 310.5, vintageTs: FEB_12 }),
      point({ value: 311.2, vintageTs: MAR_12 }),
    ]);
    expect(store.countPoints("cpi")).toBe(2);
  });

  it("does not duplicate real-time points across repeated polls", () => {
    // Regression guard: a nullable vintage column in the primary key would let
    // SQLite treat every insert as distinct, since NULLs never compare equal.
    const store = tempStore();
    const daily: MacroPoint = { seriesId: "us10y", ts: JAN_31, value: 4.21, vintageTs: null };
    store.upsertPoints([daily]);
    store.upsertPoints([daily]);
    store.upsertPoints([{ ...daily, value: 4.25 }]);

    expect(store.countPoints("us10y")).toBe(1);
    expect(store.getLatest("us10y", MAR_12)?.value).toBe(4.25);
  });

  it("treats real-time points as published at their period", () => {
    const store = tempStore();
    store.upsertPoints([{ seriesId: "us10y", ts: FEB_12, value: 4.3, vintageTs: null }]);

    expect(store.getLatest("us10y", FEB_01)).toBeNull();
    expect(store.getLatest("us10y", FEB_12)?.value).toBe(4.3);
  });

  it("skips missing observations when reading the latest value", () => {
    const store = tempStore();
    store.upsertPoints([
      { seriesId: "us10y", ts: JAN_31, value: 4.21, vintageTs: null },
      { seriesId: "us10y", ts: FEB_01, value: null, vintageTs: null }, // holiday
    ]);
    expect(store.getLatest("us10y", MAR_12)?.ts).toBe(JAN_31);
  });
});

describe("MacroStore events", () => {
  it("fills in actual on a later poll without losing consensus", () => {
    const store = tempStore();
    store.upsertEvents([event()]);
    // Second poll after the release: actual known, consensus omitted.
    store.upsertEvents([event({ consensus: null, actual: "3.2%", fetchedAtMs: FEB_12 })]);

    const [stored] = store.getEvents({ fromMs: FEB_01, toMs: MAR_12 });
    expect(stored.actual).toBe("3.2%");
    expect(stored.consensus).toBe("3.0%");
    expect(store.countEvents()).toBe(1);
  });

  it("does not let a provider without star grading erase an existing one", () => {
    const store = tempStore();
    store.upsertEvents([event()]);
    store.upsertEvents([event({ star: null, provider: "finnhub" })]);

    const [stored] = store.getEvents({ fromMs: FEB_01, toMs: MAR_12 });
    expect(stored.star).toBe(5);
  });

  it("filters by minimum impact", () => {
    const store = tempStore();
    store.upsertEvents([
      event({ key: "a", impact: "high", normalizedTitle: "a" }),
      event({ key: "b", impact: "medium", normalizedTitle: "b" }),
      event({ key: "c", impact: "low", normalizedTitle: "c" }),
    ]);

    expect(store.getEvents({ fromMs: FEB_01, toMs: MAR_12, minImpact: "high" })).toHaveLength(1);
    expect(store.getEvents({ fromMs: FEB_01, toMs: MAR_12, minImpact: "medium" })).toHaveLength(2);
    expect(store.getEvents({ fromMs: FEB_01, toMs: MAR_12 })).toHaveLength(3);
  });

  it("prunes events older than the cutoff", () => {
    const store = tempStore();
    store.upsertEvents([
      event({ key: "old", pubTimeMs: JAN_31, normalizedTitle: "old" }),
      event({ key: "new", pubTimeMs: MAR_12, normalizedTitle: "new" }),
    ]);
    expect(store.pruneEvents(FEB_12)).toBe(1);
    expect(store.countEvents()).toBe(1);
  });

  it("registers every series in the registry", () => {
    const store = tempStore();
    store.upsertSeriesMeta(MACRO_SERIES);
    store.upsertSeriesMeta(MACRO_SERIES); // idempotent
    for (const meta of MACRO_SERIES) {
      expect(store.getFetchBookkeeping(meta.seriesId).lastError).toBeNull();
    }
  });

  it("records fetch errors against a single series", () => {
    const store = tempStore();
    store.upsertSeriesMeta(MACRO_SERIES);
    store.recordFetchResult("us10y", "429 rate limited");

    expect(store.getFetchBookkeeping("us10y").lastError).toBe("429 rate limited");
    expect(store.getFetchBookkeeping("us2y").lastError).toBeNull();
  });
});

describe("impactsAtLeast", () => {
  it("expands a minimum into the set of acceptable levels", () => {
    expect(impactsAtLeast("high")).toEqual(["high"]);
    expect(impactsAtLeast("medium")).toEqual(["medium", "high"]);
    expect(impactsAtLeast("low")).toEqual(["low", "medium", "high"]);
  });
});
