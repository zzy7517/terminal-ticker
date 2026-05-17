import { TradingConfig } from "../../config/index.js";
import { ExchangeRouter } from "../../trading/exchange_router.js";
import { FillKind, TradeDirection, TradeStatus, tradeToPayload, snapshotToPayload } from "../../trading/models.js";
import type { Fill } from "../../trading/models.js";
import { TradeStore } from "../../trading/store.js";
import { orderToPayload, positionToPayload, syncResultToPayload } from "../../trading/exchange_models.js";
import { ToolRegistry, jsonOutput } from "./registry.js";

export function buildTradingTools(input: {
  tradeStore: TradeStore;
  exchangeRouter?: ExchangeRouter | null;
  tradingConfig?: TradingConfig | null;
  resolveSessionId?: () => string | null;
  captureSnapshot?: ((instrumentKey: string) => number | null) | null;
}): ToolRegistry {
  const registry = new ToolRegistry();
  const router = input.exchangeRouter;
  const config = input.tradingConfig;
  const tradingEnabled = config ? (config.hyperliquidMode !== "off" || config.bitgetMode !== "off") : Boolean(router);

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

  if (tradingEnabled) {
    registry.register({
      name: "open_exchange_trade",
      description:
        "在交易所提交开仓订单并记录到本地交易表。开仓必须同时设置 take_profit_price 和 stop_loss_price。" +
        "direction 为 long 或 short。reasoning 记录开仓理由。",
      parameters: {
        type: "object",
        properties: {
          instrument_key: { type: "string", description: "标的唯一标识，如 hyperliquid:BTC 或 USDT-FUTURES:BTCUSDT" },
          direction: { type: "string", enum: ["long", "short"] },
          size: { type: "number", description: "合约数量，必须 > 0" },
          reasoning: { type: "string", description: "开仓理由，写入本地 trade 记录" },
          order_type: { type: "string", enum: ["market", "limit"], default: "market" },
          limit_price: { type: ["number", "null"], description: "limit 单必填" },
          take_profit_price: { type: ["number", "null"], description: "止盈价" },
          stop_loss_price: { type: ["number", "null"], description: "止损价" },
        },
        required: ["instrument_key", "direction", "size", "reasoning", "take_profit_price", "stop_loss_price"],
      },
      handler: async (args) => {
        if (!router) return jsonOutput({ error: "exchange router unavailable" });
        const instrumentKey = String(args.instrument_key);
        const directionStr = String(args.direction || "long").toLowerCase();
        if (directionStr !== "long" && directionStr !== "short") return jsonOutput({ error: `invalid direction: ${directionStr}` });
        const direction = directionStr === "long" ? TradeDirection.LONG : TradeDirection.SHORT;
        const isBuy = direction === TradeDirection.LONG;
        const size = Number(args.size);
        if (!size || size <= 0) return jsonOutput({ error: "size must be > 0" });
        const orderType = String(args.order_type || "market").toLowerCase();
        if (orderType !== "market" && orderType !== "limit") return jsonOutput({ error: `invalid order_type: ${orderType}` });
        const limitPrice = args.limit_price == null ? null : Number(args.limit_price);
        if (orderType === "limit" && limitPrice == null) return jsonOutput({ error: "limit order requires limit_price" });
        const takeProfitPrice = args.take_profit_price == null ? null : Number(args.take_profit_price);
        const stopLossPrice = args.stop_loss_price == null ? null : Number(args.stop_loss_price);
        if (takeProfitPrice == null || stopLossPrice == null) return jsonOutput({ error: "take_profit_price and stop_loss_price are required" });

        const snapshotId = input.captureSnapshot ? input.captureSnapshot(instrumentKey) : null;

        const result = await router.placeOrder({
          instrumentKey,
          isBuy,
          size,
          orderType,
          limitPrice,
          takeProfitPrice,
          stopLossPrice,
        });
        if (result.error) return jsonOutput({ error: result.error, raw: result.raw });

        const status = result.filledSize ? TradeStatus.OPEN : TradeStatus.PLANNED;
        const intentPrice = result.averagePrice ?? limitPrice;
        const trade = input.tradeStore.createTrade({
          instrumentKey,
          direction,
          size,
          intentPrice,
          stopPrice: stopLossPrice,
          targetPrices: [takeProfitPrice],
          reasoningText: String(args.reasoning || ""),
          sessionId: input.resolveSessionId?.() ?? null,
          snapshotId,
          marketKind: result.exchange ? `${result.exchange}-perp` : "",
          fillSource: result.exchange || "",
          status,
          externalOrderId: result.orderId,
        });

        let fill: Fill | null = null;
        if (result.filledSize && result.averagePrice != null) {
          fill = input.tradeStore.recordFill({
            tradeId: trade.id,
            kind: FillKind.ENTRY,
            price: result.averagePrice,
            quantity: result.filledSize,
            fillSource: result.exchange || "",
            externalOrderId: result.orderId,
          });
        }

        return jsonOutput({ trade: tradeToPayload(trade), fill, orderResult: { orderId: result.orderId, averagePrice: result.averagePrice, filledSize: result.filledSize } });
      },
    });

    registry.register({
      name: "modify_tpsl",
      description:
        "为已有交易所仓位设置或调整止盈止损。调用前应先用 get_exchange_positions 确认仓位方向和数量。",
      parameters: {
        type: "object",
        properties: {
          instrument_key: { type: "string", description: "标的唯一标识" },
          direction: { type: ["string", "null"], enum: ["long", "short", null], description: "仓位方向；不传时需明确" },
          take_profit_price: { type: ["number", "null"], description: "新止盈价" },
          stop_loss_price: { type: ["number", "null"], description: "新止损价" },
          size: { type: ["number", "null"], description: "仓位数量" },
        },
        required: ["instrument_key"],
      },
      handler: async (args) => {
        if (!router) return jsonOutput({ error: "exchange router unavailable" });
        const instrumentKey = String(args.instrument_key);
        const takeProfitPrice = args.take_profit_price == null ? null : Number(args.take_profit_price);
        const stopLossPrice = args.stop_loss_price == null ? null : Number(args.stop_loss_price);
        if (takeProfitPrice == null && stopLossPrice == null) return jsonOutput({ error: "take_profit_price or stop_loss_price is required" });

        let directionStr = args.direction ? String(args.direction).toLowerCase() : null;
        if (!directionStr) {
          const positions = await router.getPositions(instrumentKey);
          if (positions.length === 1) directionStr = positions[0].side;
          else return jsonOutput({ error: "direction is required when it cannot be inferred from one matching exchange position" });
        }
        const isBuy = directionStr === "long";
        const size = args.size != null ? Number(args.size) : undefined;
        if (size === undefined) {
          const positions = await router.getPositions(instrumentKey);
          const match = positions.find((p) => p.side === directionStr);
          if (!match) return jsonOutput({ error: `no ${directionStr} position found for ${instrumentKey}` });
          return jsonOutput(await router.modifyTpsl({ instrumentKey, isBuy, size: match.size, takeProfitPrice, stopLossPrice }));
        }
        return jsonOutput(await router.modifyTpsl({ instrumentKey, isBuy, size, takeProfitPrice, stopLossPrice }));
      },
    });
  }

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

  registry.register({
    name: "get_exchange_fills",
    description: "从交易所拉取某笔交易相关的真实成交记录。",
    parameters: { type: "object", properties: { trade_id: { type: "integer" }, limit: { type: "integer" } }, required: ["trade_id"] },
    handler: async ({ trade_id, limit }) => {
      if (!router) return jsonOutput({ error: "exchange router unavailable" });
      const trade = input.tradeStore.getTrade(Number(trade_id));
      if (!trade) return jsonOutput({ error: "trade not found" });
      const fills = await router.getTradeFillsFromExchange(trade, Math.max(1, Math.min(Number(limit) || 50, 100)));
      return jsonOutput({ fills, count: fills.length });
    },
  });

  return registry;
}

export function buildTradeReviewTools(input: {
  tradeStore: TradeStore;
  exchangeRouter?: ExchangeRouter | null;
  tradeId?: number | null;
}): ToolRegistry {
  const registry = new ToolRegistry();
  const router = input.exchangeRouter;

  registry.register({
    name: "get_trade_review_context",
    description: "读取当前待复盘交易的完整上下文，包括本地 trade/fills、开仓快照和同标的最近 lessons。",
    parameters: { type: "object", properties: {} },
    handler: () => {
      const trade = input.tradeId ? input.tradeStore.getTrade(input.tradeId) : null;
      if (!trade) return jsonOutput({ trade: null });
      let snapshotAtOpen: Record<string, unknown> | null = null;
      if (trade.snapshotId != null) {
        const snap = input.tradeStore.getSnapshot(trade.snapshotId);
        if (snap) snapshotAtOpen = snapshotToPayload(snap);
      }
      const recentLessons = input.tradeStore.listLessons({ instrumentKey: trade.instrumentKey, limit: 10 });
      return jsonOutput({ trade: tradeToPayload(trade), snapshotAtOpen, recentLessons });
    },
  });

  registry.register({
    name: "check_trade_status",
    description: "Synchronize the review trade with exchange state.",
    parameters: { type: "object", properties: {} },
    handler: async () => {
      if (!router) return jsonOutput({ error: "exchange router unavailable" });
      const trade = input.tradeId ? input.tradeStore.getTrade(input.tradeId) : null;
      if (!trade) return jsonOutput({ error: "trade not found" });
      return jsonOutput(syncResultToPayload(await router.syncTradeStatus(trade)));
    },
  });

  registry.register({
    name: "get_exchange_fills",
    description: "Fetch the actual historical fills for this trade from the exchange.",
    parameters: { type: "object", properties: { limit: { type: "integer" } } },
    handler: async ({ limit }) => {
      if (!router) return jsonOutput({ error: "exchange router unavailable" });
      const trade = input.tradeId ? input.tradeStore.getTrade(input.tradeId) : null;
      if (!trade) return jsonOutput({ error: "trade not found" });
      const fills = await router.getTradeFillsFromExchange(trade, Math.max(1, Math.min(Number(limit) || 50, 100)));
      return jsonOutput({ fills, count: fills.length });
    },
  });

  return registry;
}
