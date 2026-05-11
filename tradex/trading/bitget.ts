import crypto from "node:crypto";
import { fetch as browserFetch } from "wreq-js";
import { ExchangeOrder, ExchangePosition, OrderResult, orderResult } from "./exchange_models.js";

export const BITGET_API_BASE = "https://api.bitget.com";
export const BITGET_DEMO_FILL_SOURCE = "bitget-demo";

export class BitgetTradingError extends Error {}

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

export function bitgetCredentialsAvailable(): boolean {
  return Boolean(env("BITGET_API_KEY") && env("BITGET_API_SECRET") && env("BITGET_API_PASSPHRASE"));
}

function sign(timestamp: string, method: string, requestPath: string, query: string, body: string, secret: string): string {
  const message = `${timestamp}${method.toUpperCase()}${requestPath}${query}${body}`;
  return crypto.createHmac("sha256", secret).update(message).digest("base64");
}

async function request(method: string, requestPath: string, input: { params?: Record<string, string>; body?: Record<string, unknown> } = {}): Promise<Record<string, unknown>> {
  const apiKey = env("BITGET_API_KEY");
  const apiSecret = env("BITGET_API_SECRET");
  const passphrase = env("BITGET_API_PASSPHRASE");
  if (!apiKey || !apiSecret || !passphrase) throw new BitgetTradingError("BITGET_API_KEY, BITGET_API_SECRET, BITGET_API_PASSPHRASE required.");
  const timestamp = String(Date.now());
  const url = new URL(`${BITGET_API_BASE}${requestPath}`);
  for (const [key, value] of Object.entries(input.params ?? {})) url.searchParams.set(key, value);
  const query = url.search ? url.search : "";
  const body = input.body ? JSON.stringify(input.body) : "";
  const response = await browserFetch(url.toString(), {
    method,
    profile: "chrome_133",
    operatingSystem: "macos",
    headers: {
      "ACCESS-KEY": apiKey,
      "ACCESS-SIGN": sign(timestamp, method, requestPath, query, body, apiSecret),
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": passphrase,
      "Content-Type": "application/json",
      "User-Agent": "tradex/0.1",
      PAPTRADING: "1",
    },
    body: body || undefined,
  } as never);
  const text = await response.text();
  if (!response.ok) throw new BitgetTradingError(`Bitget API ${method} ${requestPath} failed: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function toFloat(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function instrumentKey(symbol: string, productType: string): string {
  return `${productType}:${symbol}`;
}

export async function getPositions(productType = "USDT-FUTURES"): Promise<ExchangePosition[]> {
  if (!bitgetCredentialsAvailable()) return [];
  try {
    const resp = await request("GET", "/api/v2/mix/position/all-position", { params: { productType } });
    if (resp.code !== "00000" || !Array.isArray(resp.data)) return [];
    return resp.data
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        exchange: BITGET_DEMO_FILL_SOURCE,
        symbol: String(item.symbol || ""),
        instrumentKey: instrumentKey(String(item.symbol || ""), productType),
        side: String(item.holdSide || "long"),
        size: toFloat(item.total),
        entryPrice: toFloat(item.openPriceAvg),
        markPrice: toFloat(item.markPrice),
        unrealizedPnl: toFloat(item.unrealizedPL),
        leverage: toFloat(item.leverage) || null,
        margin: toFloat(item.margin) || null,
        liquidationPrice: toFloat(item.liquidationPrice) || null,
      }))
      .filter((position) => position.size !== 0);
  } catch {
    return [];
  }
}

export async function getOpenOrders(productType = "USDT-FUTURES"): Promise<ExchangeOrder[]> {
  if (!bitgetCredentialsAvailable()) return [];
  try {
    const resp = await request("GET", "/api/v2/mix/order/orders-pending", { params: { productType } });
    const data = resp.data && typeof resp.data === "object" && !Array.isArray(resp.data) ? (resp.data as Record<string, unknown>) : {};
    const orders = Array.isArray(data.entrustedList) ? data.entrustedList : [];
    return orders
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .map((item) => ({
        exchange: BITGET_DEMO_FILL_SOURCE,
        symbol: String(item.symbol || ""),
        instrumentKey: instrumentKey(String(item.symbol || ""), productType),
        orderId: String(item.orderId || ""),
        side: String(item.side || "buy"),
        orderType: String(item.orderType || "limit"),
        size: toFloat(item.size),
        price: toFloat(item.price) || null,
        filledSize: toFloat(item.baseVolume),
        status: "open",
        createdAtMs: Number(item.cTime || 0),
      }));
  } catch {
    return [];
  }
}

export async function placeOrder(input: {
  symbol: string;
  productType?: string;
  marginMode?: string;
  marginCoin?: string;
  side?: string;
  tradeSide?: string;
  orderType?: string;
  size: number;
  price?: number | null;
  presetStopSurplusPrice?: number | null;
  presetStopLossPrice?: number | null;
}): Promise<OrderResult> {
  const body: Record<string, unknown> = {
    symbol: input.symbol,
    productType: input.productType ?? "USDT-FUTURES",
    marginMode: input.marginMode ?? "crossed",
    marginCoin: input.marginCoin ?? "USDT",
    side: input.side ?? "buy",
    tradeSide: input.tradeSide ?? "open",
    orderType: input.orderType ?? "market",
    size: String(input.size),
  };
  if (input.price !== undefined && input.price !== null && body.orderType === "limit") body.price = String(input.price);
  if (input.presetStopSurplusPrice !== undefined && input.presetStopSurplusPrice !== null) body.presetStopSurplusPrice = String(input.presetStopSurplusPrice);
  if (input.presetStopLossPrice !== undefined && input.presetStopLossPrice !== null) body.presetStopLossPrice = String(input.presetStopLossPrice);
  try {
    const resp = await request("POST", "/api/v2/mix/order/place-order", { body });
    if (resp.code !== "00000") return orderResult({ exchange: BITGET_DEMO_FILL_SOURCE, error: String(resp.msg || "unknown error"), raw: resp });
    const data = resp.data && typeof resp.data === "object" && !Array.isArray(resp.data) ? (resp.data as Record<string, unknown>) : {};
    return orderResult({ exchange: BITGET_DEMO_FILL_SOURCE, orderId: data.orderId ? String(data.orderId) : null, raw: resp });
  } catch (error) {
    return orderResult({ exchange: BITGET_DEMO_FILL_SOURCE, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function closePosition(input: { symbol: string; productType?: string; holdSide?: string | null }): Promise<OrderResult> {
  const body: Record<string, unknown> = { symbol: input.symbol, productType: input.productType ?? "USDT-FUTURES" };
  if (input.holdSide) body.holdSide = input.holdSide;
  try {
    const resp = await request("POST", "/api/v2/mix/order/close-positions", { body });
    if (resp.code !== "00000") return orderResult({ exchange: BITGET_DEMO_FILL_SOURCE, error: String(resp.msg || "unknown error"), raw: resp });
    const data = resp.data && typeof resp.data === "object" && !Array.isArray(resp.data) ? (resp.data as Record<string, unknown>) : {};
    const successList = Array.isArray(data.successList) ? data.successList : [];
    const failureList = Array.isArray(data.failureList) ? data.failureList : [];
    if (successList.length === 0 && failureList.length > 0) {
      const firstFailure = failureList[0];
      const error = firstFailure && typeof firstFailure === "object" && !Array.isArray(firstFailure)
        ? String((firstFailure as Record<string, unknown>).errorMsg || "close position failed")
        : "close position failed";
      return orderResult({ exchange: BITGET_DEMO_FILL_SOURCE, error, raw: resp });
    }
    const firstSuccess = successList[0];
    const orderId = firstSuccess && typeof firstSuccess === "object" && !Array.isArray(firstSuccess)
      ? String((firstSuccess as Record<string, unknown>).orderId || "")
      : null;
    return orderResult({ exchange: BITGET_DEMO_FILL_SOURCE, orderId: orderId || null, raw: resp });
  } catch (error) {
    return orderResult({ exchange: BITGET_DEMO_FILL_SOURCE, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function getOrderFills(input: { symbol: string; productType?: string; orderId?: string | null; limit?: number }): Promise<Array<Record<string, unknown>>> {
  if (!bitgetCredentialsAvailable()) return [];
  const params: Record<string, string> = {
    symbol: input.symbol,
    productType: input.productType ?? "USDT-FUTURES",
    limit: String(Math.max(1, Math.min(input.limit ?? 20, 100))),
  };
  if (input.orderId) params.orderId = input.orderId;
  try {
    const resp = await request("GET", "/api/v2/mix/order/fills", { params });
    const data = resp.data && typeof resp.data === "object" && !Array.isArray(resp.data) ? (resp.data as Record<string, unknown>) : {};
    const fillList = Array.isArray(data.fillList) ? data.fillList : [];
    return fillList.slice(0, input.limit ?? 20).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  } catch {
    return [];
  }
}

export async function cancelOrder(input: { orderId: string; symbol: string; productType?: string }): Promise<boolean> {
  try {
    const resp = await request("POST", "/api/v2/mix/order/cancel-order", {
      body: { symbol: input.symbol, productType: input.productType ?? "USDT-FUTURES", orderId: input.orderId },
    });
    return resp.code === "00000";
  } catch {
    return false;
  }
}
