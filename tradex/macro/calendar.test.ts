import { describe, expect, it } from "vitest";
import {
  evaluateEventWindow,
  eventKey,
  normalizeTitle,
  nullIfBlank,
  parseWallClock,
  starToImpact,
} from "./calendar.js";
import type { EventWindowConfig, MacroEvent } from "./domain.js";

const CONFIG: EventWindowConfig = {
  minImpact: "high",
  beforeMinutes: 15,
  afterMinutes: 15,
  blockTrades: true,
};

function event(over: Partial<MacroEvent> = {}): MacroEvent {
  const pubTimeMs = Date.UTC(2026, 1, 12, 13, 30);
  return {
    key: `${pubTimeMs}:cpi`,
    pubTimeMs,
    title: "美国1月CPI年率",
    normalizedTitle: "美国1月cpi年率",
    country: "美国",
    impact: "high",
    star: 5,
    previous: null,
    consensus: null,
    actual: null,
    revised: null,
    note: null,
    provider: "jin10",
    fetchedAtMs: 0,
    ...over,
  };
}

describe("parseWallClock", () => {
  it("interprets Jin10 timestamps as Beijing time", () => {
    // Jin10 lists the NZ June trade balance at 06:45; the release is 10:45 NZST
    // (UTC+12), i.e. 22:45 UTC the previous day.
    expect(parseWallClock("2026-07-20 06:45", 8)).toBe(Date.UTC(2026, 6, 19, 22, 45));
  });

  it("handles seconds and the T separator", () => {
    expect(parseWallClock("2026-07-20T06:45:30", 8)).toBe(Date.UTC(2026, 6, 19, 22, 45, 30));
  });

  it("returns null rather than guessing on unparseable input", () => {
    // Dropping the event is safer than anchoring a silence window to the wrong
    // instant, because callers can detect absence but not silent misplacement.
    expect(parseWallClock("", 8)).toBeNull();
    expect(parseWallClock("待定", 8)).toBeNull();
    expect(parseWallClock("2026-07-20", 8)).toBeNull();
  });

  it("shifts across day boundaries correctly", () => {
    expect(parseWallClock("2026-07-20 07:30", 8)).toBe(Date.UTC(2026, 6, 19, 23, 30));
    expect(parseWallClock("2026-07-20 09:00", 8)).toBe(Date.UTC(2026, 6, 20, 1, 0));
  });
});

describe("starToImpact", () => {
  it("maps five-star grading onto three levels", () => {
    expect(starToImpact(5)).toBe("high");
    expect(starToImpact(4)).toBe("high");
    expect(starToImpact(3)).toBe("medium");
    expect(starToImpact(2)).toBe("low");
    expect(starToImpact(1)).toBe("low");
  });

  it("degrades to low when the provider supplies no grading", () => {
    expect(starToImpact(null)).toBe("low");
    expect(starToImpact(Number.NaN)).toBe("low");
  });
});

describe("normalizeTitle / eventKey", () => {
  it("collapses punctuation and whitespace so repeated polls dedupe", () => {
    expect(normalizeTitle("新西兰6月贸易帐(亿纽元)")).toBe(normalizeTitle("新西兰6月贸易帐（亿纽元）"));
    expect(normalizeTitle("US CPI YoY")).toBe("uscpiyoy");
  });

  it("keys on instant plus title", () => {
    expect(eventKey("uscpiyoy", 123)).toBe("123:uscpiyoy");
  });
});

describe("nullIfBlank", () => {
  it("treats placeholder dashes as missing", () => {
    expect(nullIfBlank("-")).toBeNull();
    expect(nullIfBlank("--")).toBeNull();
    expect(nullIfBlank("  ")).toBeNull();
    expect(nullIfBlank(undefined)).toBeNull();
    expect(nullIfBlank(" 3.2% ")).toBe("3.2%");
  });
});

describe("evaluateEventWindow", () => {
  const at = Date.UTC(2026, 1, 12, 13, 30);

  it("fails closed when the calendar could not be consulted", () => {
    const verdict = evaluateEventWindow(null, at, CONFIG);
    expect(verdict).toEqual({ inWindow: true, event: null, unknown: true });
  });

  it("distinguishes 'nothing scheduled' from 'unknown'", () => {
    const verdict = evaluateEventWindow([], at, CONFIG);
    expect(verdict).toEqual({ inWindow: false, event: null, unknown: false });
  });

  it("covers the margin before and after a release", () => {
    const events = [event()];
    expect(evaluateEventWindow(events, at - 14 * 60_000, CONFIG).inWindow).toBe(true);
    expect(evaluateEventWindow(events, at + 14 * 60_000, CONFIG).inWindow).toBe(true);
    expect(evaluateEventWindow(events, at, CONFIG).inWindow).toBe(true);
  });

  it("clears outside the margin", () => {
    const events = [event()];
    expect(evaluateEventWindow(events, at - 16 * 60_000, CONFIG).inWindow).toBe(false);
    expect(evaluateEventWindow(events, at + 16 * 60_000, CONFIG).inWindow).toBe(false);
  });

  it("ignores releases below the configured impact", () => {
    const events = [event({ impact: "medium" })];
    expect(evaluateEventWindow(events, at, CONFIG).inWindow).toBe(false);
    expect(
      evaluateEventWindow(events, at, { ...CONFIG, minImpact: "medium" }).inWindow,
    ).toBe(true);
  });

  it("reports which release caused the silence", () => {
    const verdict = evaluateEventWindow([event()], at, CONFIG);
    expect(verdict.event?.title).toBe("美国1月CPI年率");
  });

  it("supports asymmetric margins", () => {
    const config = { ...CONFIG, beforeMinutes: 30, afterMinutes: 5 };
    expect(evaluateEventWindow([event()], at - 20 * 60_000, config).inWindow).toBe(true);
    expect(evaluateEventWindow([event()], at + 10 * 60_000, config).inWindow).toBe(false);
  });
});
