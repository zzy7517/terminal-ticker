import { ExchangeRouter } from "../../trading/exchange_router.js";
import { TradeStatus, tradeToPayload } from "../../trading/models.js";
import { TradeStore } from "../../trading/store.js";
import { orderToPayload, positionToPayload, syncResultToPayload } from "../../trading/exchange_models.js";
import { ToolRegistry, jsonOutput } from "./registry.js";

export function buildTradingTools(input: { tradeStore: TradeStore; exchangeRouter?: ExchangeRouter | null; resolveSessionId?: () => string | null; captureSnapshot?: (instrumentKey: string) => number | null }): ToolRegistry {
  const registry = new ToolRegistry();
  const router = input.exchangeRouter;

  registry.register({
    name: "get_exchange_positions",
    description: "List live exchange positions.",
    parameters: { type: "object", properties: { instrument_key: { type: ["string", "null"] } } },
    handler: async ({ instrument_key }) => jsonOutput({ positions: router ? (await router.getPositions(String(instrument_key || "") || null)).map(positionToPayload) : [] }),
  });

  registry.register({
    name: "list_open_trades",
    description: "List local open trades.",
    parameters: { type: "object", properties: { instrument_key: { type: ["string", "null"] } } },
    handler: ({ instrument_key }) =>
      jsonOutput({
        trades: input.tradeStore
          .listTrades({ instrumentKey: instrument_key ? String(instrument_key) : null, statuses: [TradeStatus.OPEN] })
          .map((trade) => tradeToPayload(trade)),
      }),
  });

  registry.register({
    name: "get_trade_history",
    description: "Get recent local trade history.",
    parameters: { type: "object", properties: { instrument_key: { type: ["string", "null"] }, limit: { type: "integer" } } },
    handler: ({ instrument_key, limit }) =>
      jsonOutput({
        trades: input.tradeStore
          .listTrades({ instrumentKey: instrument_key ? String(instrument_key) : null, limit: Number(limit) || 20 })
          .map((trade) => tradeToPayload(trade)),
      }),
  });

  registry.register({
    name: "open_exchange_trade",
    description: "Open a trade through the configured exchange router.",
    parameters: { type: "object", properties: { instrument_key: { type: "string" }, is_buy: { type: "boolean" }, size: { type: "number" }, order_type: { type: "string" }, limit_price: { type: ["number", "null"] } }, required: ["instrument_key", "is_buy", "size"] },
    handler: async (args) => {
      if (!router) return jsonOutput({ error: "exchange router unavailable" });
      const result = await router.placeOrder({
        instrumentKey: String(args.instrument_key),
        isBuy: Boolean(args.is_buy),
        size: Number(args.size),
        orderType: String(args.order_type || "market"),
        limitPrice: args.limit_price,
      });
      return jsonOutput(result);
    },
  });

  registry.register({
    name: "close_position",
    description: "Close an exchange position.",
    parameters: { type: "object", properties: { instrument_key: { type: "string" }, size: { type: ["number", "null"] } }, required: ["instrument_key"] },
    handler: async ({ instrument_key, size }) => jsonOutput(router ? await router.closePosition({ instrumentKey: String(instrument_key), size: size === null ? null : Number(size) }) : { error: "exchange router unavailable" }),
  });

  registry.register({
    name: "check_trade_status",
    description: "Synchronize a local trade with exchange state.",
    parameters: { type: "object", properties: { trade_id: { type: "integer" } }, required: ["trade_id"] },
    handler: async ({ trade_id }) => {
      if (!router) return jsonOutput({ error: "exchange router unavailable" });
      const trade = input.tradeStore.getTrade(Number(trade_id));
      if (!trade) return jsonOutput({ error: "trade not found" });
      return jsonOutput(syncResultToPayload(await router.syncTradeStatus(trade)));
    },
  });

  registry.register({
    name: "get_exchange_orders",
    description: "List live exchange orders.",
    parameters: { type: "object", properties: { instrument_key: { type: ["string", "null"] } } },
    handler: async ({ instrument_key }) => jsonOutput({ orders: router ? (await router.getOrders(String(instrument_key || "") || null)).map(orderToPayload) : [] }),
  });

  return registry;
}

export function buildTradeReviewTools(input: { tradeStore: TradeStore; exchangeRouter?: ExchangeRouter | null; tradeId?: number | null }): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "get_trade_review_context",
    description: "Get the local trade and fills for review.",
    parameters: { type: "object", properties: {} },
    handler: () => {
      const trade = input.tradeId ? input.tradeStore.getTrade(input.tradeId) : null;
      return jsonOutput({ trade: trade ? tradeToPayload(trade) : null });
    },
  });
  return registry;
}
