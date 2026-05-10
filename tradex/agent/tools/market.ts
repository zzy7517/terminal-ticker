import { QuoteState } from "../../domain/quotes.js";
import { ToolRegistry, jsonOutput } from "./registry.js";
import { shortCandle } from "./market_context.js";

export function buildMarketTools(input: { quotes: Record<string, QuoteState> }): ToolRegistry {
  const registry = new ToolRegistry();
  const resolveKey = (instrumentKey: string) => instrumentKey || Object.keys(input.quotes)[0] || "";

  registry.register({
    name: "get_quote",
    description: "Get the latest quote for an instrument.",
    parameters: { type: "object", properties: { instrument_key: { type: "string" } }, required: ["instrument_key"] },
    handler: ({ instrument_key }) => {
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
    description: "Get cached OHLCV candles for an instrument.",
    parameters: { type: "object", properties: { instrument_key: { type: "string" }, interval: { type: "string" }, limit: { type: "integer" } }, required: ["instrument_key"] },
    handler: ({ instrument_key, interval, limit }) => {
      const quote = input.quotes[resolveKey(String(instrument_key || ""))];
      if (!quote) return jsonOutput({ error: "unknown instrument" });
      const candles = interval ? quote.multiTimeframeCandles[String(interval)] ?? [] : quote.candles;
      return jsonOutput({ candles: candles.slice(-(Number(limit) || 80)).map(shortCandle) });
    },
  });

  registry.register({
    name: "list_instruments",
    description: "List instruments available to the agent.",
    parameters: { type: "object", properties: {} },
    handler: () => jsonOutput({ instruments: Object.keys(input.quotes) }),
  });

  return registry;
}
