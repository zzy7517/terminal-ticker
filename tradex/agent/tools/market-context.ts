import { Candle } from "../../domain/price-action.js";

export function shortCandle(candle: Candle): Record<string, unknown> {
  return {
    t: candle.openTimeMs,
    o: candle.open,
    h: candle.high,
    l: candle.low,
    c: candle.close,
    v: candle.volume,
  };
}

export function buildMarketContext(input: {
  instrumentKey: string;
  candles?: Candle[];
  multiTimeframeCandles?: Record<string, Candle[]>;
  quote?: {
    price: number | null;
    change: number | null;
    changePercent: number | null;
    dayHigh: number | null;
    dayLow: number | null;
    volume: number | null;
    status: string;
    ageLabel: string;
  } | null;
  instrument?: {
    symbol: string;
    label: string;
    source: string;
    group: string;
  } | null;
}): Record<string, unknown> {
  return {
    instrumentKey: input.instrumentKey,
    ...(input.instrument ? { instrument: input.instrument } : {}),
    ...(input.quote ? { quote: input.quote } : {}),
    candles: (input.candles ?? []).map(shortCandle),
    multiTimeframeCandles: Object.fromEntries(
      Object.entries(input.multiTimeframeCandles ?? {}).map(([interval, candles]) => [interval, candles.map(shortCandle)]),
    ),
  };
}
