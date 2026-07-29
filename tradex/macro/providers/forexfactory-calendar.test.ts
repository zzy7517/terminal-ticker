import { describe, expect, it } from "vitest";
import { mapForexFactoryCalendarRows } from "./forexfactory-calendar.js";

describe("mapForexFactoryCalendarRows", () => {
  it("maps ISO timestamps and impact grades into MacroEvent", () => {
    const events = mapForexFactoryCalendarRows(
      [
        {
          title: "CB Consumer Confidence",
          country: "USD",
          date: "2026-07-28T09:00:00-04:00",
          impact: "High",
          forecast: "92.4",
          previous: "92.2",
          actual: "90.8",
        },
        {
          title: "German Buba Monthly Report",
          country: "EUR",
          date: "2026-07-28T05:00:00-04:00",
          impact: "Low",
          forecast: "",
          previous: "",
        },
        {
          title: "",
          country: "USD",
          date: "2026-07-28T09:00:00-04:00",
          impact: "High",
        },
      ],
      1_700_000_000_000,
    );

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      title: "CB Consumer Confidence",
      country: "USD",
      impact: "high",
      star: null,
      consensus: "92.4",
      previous: "92.2",
      actual: "90.8",
      provider: "forexfactory",
      pubTimeMs: Date.parse("2026-07-28T09:00:00-04:00"),
    });
    expect(events[1].impact).toBe("low");
    expect(events[1].star).toBeNull();
    expect(events[1].consensus).toBeNull();
  });
});
