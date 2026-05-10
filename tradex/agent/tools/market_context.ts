import { Candle } from "../../domain/price_action.js";

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

export function buildMarketContext(input: { instrumentKey: string; candles?: Candle[]; multiTimeframeCandles?: Record<string, Candle[]> }): Record<string, unknown> {
  return {
    instrumentKey: input.instrumentKey,
    candles: (input.candles ?? []).map(shortCandle),
    multiTimeframeCandles: Object.fromEntries(Object.entries(input.multiTimeframeCandles ?? {}).map(([interval, candles]) => [interval, candles.map(shortCandle)])),
  };
}
