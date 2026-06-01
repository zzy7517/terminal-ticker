import { ToolRegistry, jsonOutput } from "./registry.js";
import type { Jin10Service } from "../../jin10/service.js";

export function buildJin10Tools(jin10Service: Jin10Service | null): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: "get_economic_calendar",
    description:
      "Get today's economic calendar events (e.g. non-farm payrolls, CPI, rate decisions). " +
      "Returns upcoming and published events with previous/consensus/actual values. " +
      "Use this to check if important data releases are upcoming that could affect trading decisions.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      if (!jin10Service || !jin10Service.available) {
        return jsonOutput({ disabled: true, events: [], reason: "Jin10 not configured" });
      }
      let events = jin10Service.getCalendar();
      if (events.length === 0) {
        await jin10Service.refreshCalendar();
        events = jin10Service.getCalendar();
      }
      // Only return important events (4+ stars) to save context budget
      const important = events.filter((e) => e.star >= 4);
      return jsonOutput({ events: important });
    },
  });

  registry.register({
    name: "get_jin10_quote",
    description:
      "Get a real-time SNAPSHOT quote from Jin10 for commodities, forex, and indices " +
      "(e.g. XAUUSD for gold, USOIL for oil, EURUSD for EUR/USD). " +
      "Returns current price, today's OHLC, change, and change%. " +
      "NOTE: This is a point-in-time snapshot only — no historical kline/candle data is available from this source. " +
      "Use get_candles for multi-timeframe analysis on Bitget/Hyperliquid instruments instead.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Jin10 instrument code (e.g. XAUUSD, XAGUSD, USOIL, EURUSD, USDJPY, USDCNH)",
        },
      },
      required: ["code"],
    },
    execute: async ({ code }) => {
      if (!jin10Service || !jin10Service.available) {
        return jsonOutput({ disabled: true, quote: null, reason: "Jin10 not configured" });
      }
      const codeStr = String(code || "").trim().toUpperCase();
      if (!codeStr) return jsonOutput({ error: "code is required" });

      // Check cached quotes first
      const cached = jin10Service.getQuote(codeStr);
      if (cached) return jsonOutput({ quote: cached });

      // Try fresh fetch via refresh
      await jin10Service.refreshQuotes();
      const fresh = jin10Service.getQuote(codeStr);
      return jsonOutput({ quote: fresh ?? null, note: fresh ? undefined : `${codeStr} not in subscribed codes` });
    },
  });

  return registry;
}
