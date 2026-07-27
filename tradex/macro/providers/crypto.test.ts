import { afterEach, describe, expect, it, vi } from "vitest";
import { DeribitDvolProvider } from "./deribit-dvol.js";
import { BinanceFuturesProvider } from "./binance-futures.js";
import { IndexQuotesProvider, QUOTE_SERIES } from "./quotes.js";
import { QUOTES_SERIES } from "../registry.js";

function stubFetch(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn(async (_url: string, _init?: unknown) => ({
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

describe("DeribitDvolProvider", () => {
  it("takes the close from each OHLC bar", async () => {
    // Verified live shape: [[ts, open, high, low, close], ...]
    stubFetch({ result: { data: [[1785067200000, 37.32, 37.4, 37.28, 37.4]] } });
    const points = await new DeribitDvolProvider().fetchDvol("BTC", 0, 1);

    expect(points).toEqual([
      { seriesId: "dvol_btc", ts: 1785067200000, value: 37.4, vintageTs: null },
    ]);
  });

  it("derives the series id from the currency", () => {
    expect(DeribitDvolProvider.seriesId("BTC")).toBe("dvol_btc");
    expect(DeribitDvolProvider.seriesId("eth")).toBe("dvol_eth");
  });

  it("surfaces Deribit's JSON-RPC error", async () => {
    stubFetch({ error: { message: "invalid_currency", code: 11029 } });
    await expect(new DeribitDvolProvider().fetchDvol("XXX", 0, 1))
      .rejects.toThrow(/invalid_currency/);
  });

  it("skips malformed rows instead of emitting NaN", async () => {
    stubFetch({ result: { data: [[1, 2], ["bad"], [1785067200000, 1, 2, 3, 40]] } });
    const points = await new DeribitDvolProvider().fetchDvol("BTC", 0, 1);
    expect(points).toHaveLength(1);
    expect(points[0]!.value).toBe(40);
  });

  it("chunks a long backfill into multiple requests", async () => {
    const spy = stubFetch({ result: { data: [] } });
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;
    await new DeribitDvolProvider().fetchDvol("BTC", 0, ninetyDays);
    // 30-day windows, so 90 days must not be a single request.
    expect(spy.mock.calls.length).toBe(3);
  });
});

describe("BinanceFuturesProvider", () => {
  it("reads coin-denominated open interest", async () => {
    // Coin-denominated isolates positioning from price moves.
    stubFetch([{ symbol: "BTCUSDT", sumOpenInterest: "107625.22000000", timestamp: 1785073800000 }]);
    const points = await new BinanceFuturesProvider().fetchMetric("BTCUSDT", "oi");

    expect(points).toEqual([
      { seriesId: "binance_oi_btc", ts: 1785073800000, value: 107625.22, vintageTs: null },
    ]);
  });

  it("reads the long/short position ratio", async () => {
    stubFetch([{ symbol: "BTCUSDT", longShortRatio: "1.6158", timestamp: 1 }]);
    const [point] = await new BinanceFuturesProvider().fetchMetric("BTCUSDT", "ls_ratio");
    expect(point).toEqual({ seriesId: "binance_ls_ratio_btc", ts: 1, value: 1.6158, vintageTs: null });
  });

  it("reads the taker buy/sell ratio", async () => {
    stubFetch([{ buySellRatio: "0.7647", timestamp: 1 }]);
    const [point] = await new BinanceFuturesProvider().fetchMetric("BTCUSDT", "taker_ratio");
    expect(point).toEqual({ seriesId: "binance_taker_ratio_btc", ts: 1, value: 0.7647, vintageTs: null });
  });

  it("strips the quote asset when building series ids", () => {
    expect(BinanceFuturesProvider.seriesId("BTCUSDT", "oi")).toBe("binance_oi_btc");
    expect(BinanceFuturesProvider.seriesId("ETHUSDC", "oi")).toBe("binance_oi_eth");
    // No recognised suffix — keep the whole symbol rather than mangling it.
    expect(BinanceFuturesProvider.seriesId("WEIRD", "oi")).toBe("binance_oi_weird");
  });

  it("caps limit at Binance's maximum", async () => {
    const spy = stubFetch([]);
    await new BinanceFuturesProvider().fetchMetric("BTCUSDT", "oi", 99_999);
    expect(new URL(spy.mock.calls[0]![0]).searchParams.get("limit")).toBe("500");
  });

  it("rejects a non-array body", async () => {
    stubFetch({ code: -1121, msg: "Invalid symbol." });
    await expect(new BinanceFuturesProvider().fetchMetric("NOPE", "oi"))
      .rejects.toThrow(/non-array/);
  });

  it("surfaces an HTTP failure", async () => {
    stubFetch({ msg: "banned" }, { ok: false, status: 418 });
    await expect(new BinanceFuturesProvider().fetchMetric("BTCUSDT", "oi"))
      .rejects.toThrow(/418/);
  });
});

describe("IndexQuotesProvider", () => {
  const dxy = QUOTE_SERIES.find((s) => s.seriesId === "dxy")!;
  const gold = QUOTE_SERIES.find((s) => s.seriesId === "gold")!;

  it("covers exactly the series registered to the quotes source", () => {
    // Two lists (symbol mapping here, metadata in the registry) must agree or a
    // series silently never gets fetched — or gets fetched with no metadata row.
    expect(QUOTE_SERIES.map((s) => s.seriesId).sort())
      .toEqual(QUOTES_SERIES.map((s) => s.seriesId).sort());
  });

  it("selects Yahoo when no Twelve Data key is configured", () => {
    const provider = new IndexQuotesProvider("");
    expect(provider.name).toBe("yahoo");
    expect(provider.licensed).toBe(false);
  });

  it("selects Twelve Data when a key is configured", () => {
    const provider = new IndexQuotesProvider("k");
    expect(provider.name).toBe("twelvedata");
    expect(provider.licensed).toBe(true);
  });

  it("keeps DXY on Yahoo even when a Twelve Data key is configured", async () => {
    // Twelve Data has no ICE DXY; an empty twelveDataSymbol must not hit their API.
    const spy = stubFetch({
      chart: {
        result: [{
          timestamp: [1784924101],
          indicators: { quote: [{ close: [104.25] }] },
        }],
      },
    });
    const [point] = await new IndexQuotesProvider("k").fetchQuotes(dxy, 30);
    expect(point!.value).toBe(104.25);
    expect(String(spy.mock.calls[0]?.[0])).toContain("DX-Y.NYB");
    expect(String(spy.mock.calls[0]?.[0])).not.toContain("twelvedata");
  });

  it("strips float32 artifacts from Yahoo closes", async () => {
    // Yahoo serialises from 32-bit floats, so 18.58 arrives as 18.579999923706055.
    stubFetch({
      chart: {
        result: [{
          timestamp: [1784924101],
          indicators: { quote: [{ close: [18.579999923706055] }] },
        }],
      },
    });
    const [point] = await new IndexQuotesProvider("").fetchQuotes(dxy, 30);
    expect(point!.value).toBe(18.58);
  });

  it("floors Yahoo timestamps to UTC midnight", async () => {
    stubFetch({
      chart: { result: [{ timestamp: [1784924101], indicators: { quote: [{ close: [18.5] }] } }] },
    });
    const [point] = await new IndexQuotesProvider("").fetchQuotes(dxy, 30);
    expect(point!.ts % 86_400_000).toBe(0);
  });

  it("keeps gaps as null rather than dropping the bar", async () => {
    stubFetch({
      chart: {
        result: [{ timestamp: [86_400, 172_800], indicators: { quote: [{ close: [null, 19] }] } }],
      },
    });
    const points = await new IndexQuotesProvider("").fetchQuotes(dxy, 30);
    expect(points.map((p) => p.value)).toEqual([null, 19]);
  });

  it("surfaces a Yahoo chart error", async () => {
    stubFetch({ chart: { error: { description: "No data found, symbol may be delisted" } } });
    await expect(new IndexQuotesProvider("").fetchQuotes(dxy, 30))
      .rejects.toThrow(/delisted/);
  });

  it("surfaces a Twelve Data error returned with HTTP 200", async () => {
    stubFetch({ status: "error", message: "You have exceeded your API credits" });
    await expect(new IndexQuotesProvider("k").fetchQuotes(gold, 30))
      .rejects.toThrow(/exceeded your API credits/);
  });

  it("parses Twelve Data time series rows", async () => {
    stubFetch({ values: [{ datetime: "2026-02-12", close: "18.58" }] });
    const [point] = await new IndexQuotesProvider("k").fetchQuotes(gold, 30);
    expect(point).toEqual({ seriesId: "gold", ts: Date.UTC(2026, 1, 12), value: 18.58, vintageTs: null });
  });
});
