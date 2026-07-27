import { ExchangeTradingMode, TradingConfig } from "../config/index.js";
import * as bitget from "./bitget.js";
import { ExchangeOrder, ExchangePosition, OrderResult, TradeSyncResult, orderResult } from "./exchange-models.js";
import * as hyperliquid from "./hyperliquid.js";
import { FillKind, Trade, TradeStatus } from "./models.js";

export const EXCHANGE_HYPERLIQUID = "hyperliquid";
export const EXCHANGE_BITGET = "bitget-demo";
const BITGET_FUTURES_PREFIXES = ["USDT-FUTURES:", "USDC-FUTURES:", "COIN-FUTURES:"];

function hasEntryFill(trade: Trade): boolean {
  return trade.fills.some((fill) => fill.kind === FillKind.ENTRY && fill.quantity > 0);
}

export class ExchangeRouter {
  tradingConfig: TradingConfig;

  constructor(input: { tradingConfig?: TradingConfig | null } = {}) {
    this.tradingConfig = input.tradingConfig ?? { hyperliquidMode: "off", bitgetMode: "off" };
  }

  private get bitgetLive(): boolean {
    return this.tradingConfig.bitgetMode === "live";
  }

  async getAllPositions(): Promise<ExchangePosition[]> {
    const labels = ["hyperliquid", "bitget"];
    const results = await Promise.allSettled([hyperliquid.getPositions(), bitget.getPositions("USDT-FUTURES", { live: this.bitgetLive })]);
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn(`[ExchangeRouter] getPositions failed for ${labels[i]}:`, (results[i] as PromiseRejectedResult).reason);
      }
    }
    return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  }

  async getAllOrders(): Promise<ExchangeOrder[]> {
    const labels = ["hyperliquid", "bitget"];
    const results = await Promise.allSettled([hyperliquid.getOpenOrders(), bitget.getOpenOrders("USDT-FUTURES", { live: this.bitgetLive })]);
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.warn(`[ExchangeRouter] getOpenOrders failed for ${labels[i]}:`, (results[i] as PromiseRejectedResult).reason);
      }
    }
    return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  }

  async getPositions(instrumentKey?: string | null): Promise<ExchangePosition[]> {
    const positions = await this.getAllPositions();
    return instrumentKey ? positions.filter((position) => position.instrumentKey === instrumentKey) : positions;
  }

  async getOrders(instrumentKey?: string | null): Promise<ExchangeOrder[]> {
    const orders = await this.getAllOrders();
    return instrumentKey ? orders.filter((order) => order.instrumentKey === instrumentKey) : orders;
  }

  async getTradeFillsFromExchange(trade: Trade, limit = 50): Promise<Array<Record<string, unknown>>> {
    const exchange = this.exchangeForKey(trade.instrumentKey);
    if (exchange === EXCHANGE_HYPERLIQUID) {
      const coin = hyperliquidCoinFromKey(trade.instrumentKey);
      return hyperliquid.getUserFills({ coin, startTimeMs: trade.openedAtMs ?? trade.createdAtMs, limit });
    }
    if (exchange === EXCHANGE_BITGET) {
      const [productType, symbol] = this.splitBitgetKey(trade.instrumentKey);
      return bitget.getOrderFills({ symbol, productType, orderId: trade.externalOrderId, limit, live: this.bitgetLive });
    }
    return [];
  }

  async syncTradeStatus(trade: Trade): Promise<TradeSyncResult> {
    const exchange = this.exchangeForKey(trade.instrumentKey);
    if (trade.status !== TradeStatus.OPEN) {
      return { exchange, status: trade.status, closed: false, reason: "local trade is not open", position: null, activeOrders: [], error: null };
    }
    if (exchange === EXCHANGE_HYPERLIQUID && !hyperliquid.hyperliquidCredentialsAvailable()) {
      return { exchange, status: "unknown", closed: false, reason: "", position: null, activeOrders: [], error: "hyperliquid credentials are not configured" };
    }
    if (exchange === EXCHANGE_BITGET && !bitget.bitgetCredentialsAvailable()) {
      return { exchange, status: "unknown", closed: false, reason: "", position: null, activeOrders: [], error: "bitget credentials are not configured" };
    }
    if (exchange === "unknown") return { exchange, status: "unknown", closed: false, reason: "", position: null, activeOrders: [], error: `unsupported exchange for ${trade.instrumentKey}` };
    try {
      const [positions, orders] = await Promise.all([this.getPositions(trade.instrumentKey), this.getOrders(trade.instrumentKey)]);
      const matchingPosition = positions.find((position) => position.side === trade.direction && position.size > 0) ?? null;
      const activeOrders = orders.filter(
        (order) =>
          order.reduceOnly !== true &&
          (!trade.externalOrderId || order.orderId === trade.externalOrderId || order.instrumentKey === trade.instrumentKey),
      );
      if (matchingPosition) return { exchange, status: "open", closed: false, reason: "matching exchange position is still open", position: matchingPosition, activeOrders, error: null };
      if (activeOrders.length > 0 && !hasEntryFill(trade)) return { exchange, status: "open", closed: false, reason: "opening order is still active", position: null, activeOrders, error: null };
      if (!hasEntryFill(trade)) return { exchange, status: "unknown", closed: false, reason: "", position: null, activeOrders, error: "local trade has no entry fill; cannot infer closure safely" };
      return { exchange, status: "closed", closed: true, reason: "no matching exchange position remains", position: null, activeOrders, error: null };
    } catch (error) {
      return { exchange, status: "unknown", closed: false, reason: "", position: null, activeOrders: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async placeOrder(input: { instrumentKey: string; [key: string]: unknown }): Promise<OrderResult> {
    const exchange = this.exchangeForKey(input.instrumentKey);
    const mode = this.modeForExchange(exchange);
    if (mode === "off") return orderResult({ exchange, error: `${exchange} trading is disabled by config` });
    if (exchange === EXCHANGE_HYPERLIQUID) {
      if (mode === "demo") return orderResult({ exchange, error: "Hyperliquid does not support demo/paper trading" });
      return this.placeHyperliquid(input);
    }
    if (exchange === EXCHANGE_BITGET) return this.placeBitget(input);
    return orderResult({ exchange: "unknown", error: `No trading support for ${input.instrumentKey}` });
  }

  async closePosition(input: { instrumentKey: string; size?: number | null; holdSide?: string | null; slippage?: number }): Promise<OrderResult> {
    const exchange = this.exchangeForKey(input.instrumentKey);
    const mode = this.modeForExchange(exchange);
    if (mode === "off") return orderResult({ exchange, error: `${exchange} trading is disabled by config` });
    if (exchange === EXCHANGE_HYPERLIQUID) {
      if (mode === "demo") return orderResult({ exchange, error: "Hyperliquid does not support demo/paper trading" });
      try {
        const result = await hyperliquid.closePosition({ coin: hyperliquidCoinFromKey(input.instrumentKey), size: input.size, slippage: input.slippage });
        return orderResult({ exchange, orderId: result.externalOrderId, averagePrice: result.averagePrice, filledSize: result.filledSize, resting: result.resting, raw: result.raw });
      } catch (error) {
        return orderResult({ exchange, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (exchange === EXCHANGE_BITGET) {
      const [productType, symbol] = this.splitBitgetKey(input.instrumentKey);
      return bitget.closePosition({ symbol, productType, holdSide: input.holdSide, live: this.bitgetLive });
    }
    return orderResult({ exchange: "unknown", error: `No close support for ${input.instrumentKey}` });
  }

  async modifyTpsl(input: {
    instrumentKey: string;
    isBuy: boolean;
    size: number;
    takeProfitPrice?: number | null;
    stopLossPrice?: number | null;
  }): Promise<OrderResult> {
    const exchange = this.exchangeForKey(input.instrumentKey);
    const mode = this.modeForExchange(exchange);
    if (mode === "off") return orderResult({ exchange, error: `${exchange} trading is disabled by config` });
    if (exchange === EXCHANGE_HYPERLIQUID) {
      if (mode === "demo") return orderResult({ exchange, error: "Hyperliquid does not support demo/paper trading" });
      const coin = hyperliquidCoinFromKey(input.instrumentKey);
      const results: OrderResult[] = [];
      if (input.takeProfitPrice != null) {
        try {
          const r = await hyperliquid.placeTriggerOrder({ coin, isBuy: !input.isBuy, size: input.size, triggerPrice: input.takeProfitPrice, tpsl: "tp" });
          results.push(orderResult({ exchange, orderId: r.externalOrderId, raw: r.raw }));
        } catch (error) {
          results.push(orderResult({ exchange, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (input.stopLossPrice != null) {
        try {
          const r = await hyperliquid.placeTriggerOrder({ coin, isBuy: !input.isBuy, size: input.size, triggerPrice: input.stopLossPrice, tpsl: "sl" });
          results.push(orderResult({ exchange, orderId: r.externalOrderId, raw: r.raw }));
        } catch (error) {
          results.push(orderResult({ exchange, error: error instanceof Error ? error.message : String(error) }));
        }
      }
      const firstError = results.find((r) => r.error);
      if (firstError) return firstError;
      return results[0] ?? orderResult({ exchange, error: "no TP or SL specified" });
    }
    if (exchange === EXCHANGE_BITGET) {
      const [productType, symbol] = this.splitBitgetKey(input.instrumentKey);
      return bitget.modifyPositionTpsl({
        symbol,
        productType,
        holdSide: input.isBuy ? "long" : "short",
        takeProfitPrice: input.takeProfitPrice,
        stopLossPrice: input.stopLossPrice,
        size: input.size,
        live: this.bitgetLive,
      });
    }
    return orderResult({ exchange: "unknown", error: `No TPSL support for ${input.instrumentKey}` });
  }

  async cancelOrder(input: { exchange: string; orderId: string; symbol?: string; coin?: string; productType?: string }): Promise<boolean> {
    if (!this.mutationEnabled(input.exchange)) return false;
    if (input.exchange === EXCHANGE_HYPERLIQUID) return hyperliquid.cancelOrder({ orderId: input.orderId, coin: input.coin || input.symbol || "" });
    if (input.exchange === EXCHANGE_BITGET) return bitget.cancelOrder({ orderId: input.orderId, symbol: input.symbol || "", productType: input.productType, live: this.bitgetLive });
    return false;
  }

  private async placeHyperliquid(input: { instrumentKey: string; [key: string]: unknown }): Promise<OrderResult> {
    try {
      const result = await hyperliquid.openPosition({
        coin: hyperliquidCoinFromKey(input.instrumentKey),
        isBuy: Boolean(input.isBuy ?? input.is_buy),
        size: Number(input.size),
        orderType: String(input.orderType ?? input.order_type ?? "market"),
        limitPrice: input.limitPrice === undefined ? null : Number(input.limitPrice),
        takeProfitPrice: input.takeProfitPrice === undefined ? null : Number(input.takeProfitPrice),
        stopLossPrice: input.stopLossPrice === undefined ? null : Number(input.stopLossPrice),
      });
      return orderResult({ exchange: EXCHANGE_HYPERLIQUID, orderId: result.externalOrderId, averagePrice: result.averagePrice, filledSize: result.filledSize, resting: result.resting, raw: result.raw });
    } catch (error) {
      return orderResult({ exchange: EXCHANGE_HYPERLIQUID, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async placeBitget(input: { instrumentKey: string; [key: string]: unknown }): Promise<OrderResult> {
    const [productType, symbol] = this.splitBitgetKey(input.instrumentKey);
    return bitget.placeOrder({
      symbol,
      productType,
      side: Boolean(input.isBuy ?? input.is_buy) ? "buy" : "sell",
      orderType: String(input.orderType ?? input.order_type ?? "market"),
      size: Number(input.size),
      price: input.limitPrice === undefined || input.limitPrice === null ? null : Number(input.limitPrice),
      live: this.bitgetLive,
    });
  }

  private exchangeForKey(instrumentKey: string): string {
    if (instrumentKey.startsWith("hyperliquid:")) return EXCHANGE_HYPERLIQUID;
    if (BITGET_FUTURES_PREFIXES.some((prefix) => instrumentKey.startsWith(prefix))) return EXCHANGE_BITGET;
    return "unknown";
  }

  private splitBitgetKey(instrumentKey: string): [string, string] {
    const index = instrumentKey.indexOf(":");
    if (index < 0) throw new Error(`invalid Bitget instrument key: ${instrumentKey}`);
    return [instrumentKey.slice(0, index), instrumentKey.slice(index + 1)];
  }

  modeForExchange(exchange: string): ExchangeTradingMode {
    if (exchange === EXCHANGE_HYPERLIQUID) return this.tradingConfig.hyperliquidMode;
    if (exchange === EXCHANGE_BITGET) return this.tradingConfig.bitgetMode;
    return "off";
  }

  private mutationEnabled(exchange: string): boolean {
    return this.modeForExchange(exchange) !== "off";
  }
}

function hyperliquidCoinFromKey(instrumentKey: string): string {
  const prefix = "hyperliquid:";
  return instrumentKey.startsWith(prefix) ? instrumentKey.slice(prefix.length) : instrumentKey;
}
