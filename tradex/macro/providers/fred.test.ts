import { afterEach, describe, expect, it, vi } from "vitest";
import { FredProvider } from "./fred.js";
import { findSeries } from "../registry.js";
import type { MacroSeriesMeta } from "../domain.js";

const US10Y = findSeries("us10y") as MacroSeriesMeta;
const CPI = findSeries("cpi") as MacroSeriesMeta;

const START = new Date(Date.UTC(2024, 0, 1));

function stubFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn(async (_url: string) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: "OK",
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FredProvider", () => {
  it("reports unavailable without an API key", async () => {
    const provider = new FredProvider("  ");
    expect(provider.available).toBe(false);
    await expect(provider.fetchSeries(US10Y, START)).rejects.toThrow(/not configured/);
  });

  it("anchors observation dates to UTC midnight", async () => {
    stubFetch({ observations: [{ date: "2026-02-12", value: "4.21" }] });
    const [point] = await new FredProvider("k").fetchSeries(US10Y, START);

    // A local-timezone parse would shift this and, for vintaged series, could
    // move a publication across a day boundary.
    expect(point.ts).toBe(Date.UTC(2026, 1, 12));
    expect(point.value).toBe(4.21);
  });

  it("maps FRED's '.' placeholder to a missing value", async () => {
    stubFetch({
      observations: [
        { date: "2026-02-12", value: "." },
        { date: "2026-02-13", value: "" },
        { date: "2026-02-14", value: "4.25" },
      ],
    });
    const points = await new FredProvider("k").fetchSeries(US10Y, START);
    expect(points.map((p) => p.value)).toEqual([null, null, 4.25]);
  });

  it("leaves vintage null for non-revised series", async () => {
    stubFetch({ observations: [{ date: "2026-02-12", value: "4.21", realtime_start: "2026-02-12" }] });
    const [point] = await new FredProvider("k").fetchSeries(US10Y, START);
    expect(point.vintageTs).toBeNull();
  });

  it("requests full revision history for vintaged series", async () => {
    const spy = stubFetch({ observations: [] });
    await new FredProvider("k").fetchSeries(CPI, START);

    const url = new URL(spy.mock.calls[0]![0]);
    expect(url.searchParams.get("series_id")).toBe("CPIAUCSL");
    expect(url.searchParams.get("realtime_start")).toBe("1776-07-04");
    expect(url.searchParams.get("output_type")).toBe("2");
    expect(url.searchParams.get("observation_start")).toBe("2024-01-01");
  });

  it("does not request vintages for non-revised series", async () => {
    const spy = stubFetch({ observations: [] });
    await new FredProvider("k").fetchSeries(US10Y, START);

    const url = new URL(spy.mock.calls[0]![0]);
    expect(url.searchParams.has("realtime_start")).toBe(false);
  });

  it("captures the publication date of a vintaged observation", async () => {
    stubFetch({
      observations: [
        { date: "2026-01-31", value: "310.5", realtime_start: "2026-02-12" },
        { date: "2026-01-31", value: "311.2", realtime_start: "2026-03-12" },
      ],
    });
    const points = await new FredProvider("k").fetchSeries(CPI, START);

    expect(points).toEqual([
      { seriesId: "cpi", ts: Date.UTC(2026, 0, 31), value: 310.5, vintageTs: Date.UTC(2026, 1, 12) },
      { seriesId: "cpi", ts: Date.UTC(2026, 0, 31), value: 311.2, vintageTs: Date.UTC(2026, 2, 12) },
    ]);
  });

  it("surfaces FRED's error message on a failed request", async () => {
    stubFetch({ error_message: "Bad Request. The value for variable api_key is not registered." },
      { ok: false, status: 400 });
    await expect(new FredProvider("bad").fetchSeries(US10Y, START))
      .rejects.toThrow(/not registered/);
  });

  it("surfaces an error returned with a 200 body", async () => {
    stubFetch({ error_message: "series does not exist" });
    await expect(new FredProvider("k").fetchSeries(US10Y, START))
      .rejects.toThrow(/series does not exist/);
  });

  it("drops rows with an unparseable date rather than emitting NaN", async () => {
    stubFetch({ observations: [{ date: "not-a-date", value: "1" }, { date: "2026-02-12", value: "2" }] });
    const points = await new FredProvider("k").fetchSeries(US10Y, START);
    expect(points).toHaveLength(1);
    expect(points[0].value).toBe(2);
  });
});
