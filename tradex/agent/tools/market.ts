import { QuoteState } from "../../domain/quotes.js";
import { calculateTechnicalIndicators } from "../../domain/indicators.js";
import type { CandleContextMode } from "../../config/index.js";
import { ToolRegistry, jsonOutput } from "./registry.js";
import { shortCandle } from "./market-context.js";

const INTERVAL_ALIASES: Record<string, string> = {
  "1h": "1H",
  "4h": "4H",
  "6h": "6H",
  "12h": "12H",
  "1d": "1D",
  "3d": "3D",
  "1w": "1W",
  "1mo": "1M",
};

export function buildMarketTools(input: { quotes: Record<string, QuoteState>; maxCandles?: number; candleContextMode?: CandleContextMode }): ToolRegistry {
  const registry = new ToolRegistry();
  const resolveKey = (instrumentKey: string) => instrumentKey || Object.keys(input.quotes)[0] || "";
  const maxCandles = Math.max(1, Math.floor(input.maxCandles ?? 80));
  const candleContextMode = input.candleContextMode ?? "raw";

  registry.register({
    name: "get_quote",
    description: "Get the latest quote for an instrument.",
    parameters: { type: "object", properties: { instrument_key: { type: "string" } }, required: ["instrument_key"] },
    execute: ({ instrument_key }) => {
      const key = resolveKey(String(instrument_key || ""));
      const quote = input.quotes[key];
      if (!quote) return jsonOutput({ error: `unknown instrument: ${key}` });
      return jsonOutput({
        instrumentKey: key,
        symbol: quote.symbol,
        displayName: quote.displayName,
        price: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
        status: quote.status,
        lastError: quote.lastError,
      });
    },
  });

  registry.register({
    name: "get_candles",
    description:
      candleContextMode === "with_indicators"
        ? `Get cached OHLCV candles plus derived RSI/MACD/EMA when enough samples exist. Limit is capped at ${maxCandles}.`
        : `Get cached OHLCV candles for an instrument. Limit is capped at ${maxCandles}.`,
    parameters: {
      type: "object",
      properties: {
        instrument_key: { type: "string" },
        interval: { type: "string", description: "Interval such as 1m, 5m, 15m, 1H, 4H, 1D. Lowercase aliases like 4h are accepted." },
        limit: { type: "integer", minimum: 1, maximum: maxCandles },
      },
      required: ["instrument_key"],
    },
    execute: ({ instrument_key, interval, limit }) => {
      const quote = input.quotes[resolveKey(String(instrument_key || ""))];
      if (!quote) return jsonOutput({ error: "unknown instrument" });
      const intervalKey = resolveIntervalKey(quote.multiTimeframeCandles, interval);
      const candles = intervalKey ? quote.multiTimeframeCandles[intervalKey] ?? [] : quote.candles;
      const requestedLimit = Math.floor(Number(limit));
      const effectiveLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, maxCandles) : maxCandles;
      const output: Record<string, unknown> = {
        candles: candles.slice(-effectiveLimit).map(shortCandle),
        interval: intervalKey ?? null,
        limit: effectiveLimit,
      };
      if (candleContextMode === "with_indicators") {
        const indicators = calculateTechnicalIndicators(candles);
        if (indicators !== null) output.indicators = indicators;
      }
      return jsonOutput(output);
    },
  });

  registry.register({
    name: "list_instruments",
    description: "List instruments available to the agent.",
    parameters: { type: "object", properties: {} },
    execute: () => jsonOutput({ instruments: Object.keys(input.quotes) }),
  });

  return registry;
}

function resolveIntervalKey(candlesByInterval: Record<string, unknown>, rawInterval: unknown): string | null {
  if (rawInterval === undefined || rawInterval === null || rawInterval === "") return null;
  const value = String(rawInterval).trim();
  const direct = candlesByInterval[value] !== undefined ? value : null;
  if (direct) return direct;
  const alias = INTERVAL_ALIASES[value] ?? INTERVAL_ALIASES[value.toLowerCase()];
  if (alias && candlesByInterval[alias] !== undefined) return alias;
  return Object.keys(candlesByInterval).find((key) => key.toLowerCase() === value.toLowerCase()) ?? value;
}
