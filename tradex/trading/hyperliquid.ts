import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { ExchangeOrder, ExchangePosition } from "./exchange-models.js";

export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";
export const HYPERLIQUID_FILL_SOURCE = "hyperliquid";

export class HyperliquidTradingError extends Error {}

export interface HyperliquidOrderResult {
  raw: Record<string, unknown>;
  externalOrderId: string | null;
  averagePrice: number | null;
  filledSize: number | null;
  resting: boolean;
}

function optionalEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function hyperliquidCredentialsAvailable(): boolean {
  return optionalEnv("HYPERLIQUID_PRIVATE_KEY") !== null;
}

function userAddress(): string {
  const accountAddress = optionalEnv("HYPERLIQUID_ACCOUNT_ADDRESS");
  if (accountAddress) return accountAddress;
  const privateKey = optionalEnv("HYPERLIQUID_PRIVATE_KEY");
  if (!privateKey) throw new HyperliquidTradingError("Hyperliquid credentials not configured.");
  return privateKeyToAccount(privateKey as `0x${string}`).address;
}

function exchangeClient(): InstanceType<typeof ExchangeClient> {
  const privateKey = optionalEnv("HYPERLIQUID_PRIVATE_KEY");
  if (!privateKey) throw new HyperliquidTradingError("Hyperliquid trading requires HYPERLIQUID_PRIVATE_KEY.");
  const wallet = privateKeyToAccount(privateKey as `0x${string}`);
  const transport = new HttpTransport({ apiUrl: HYPERLIQUID_API_BASE });
  const config: Record<string, unknown> = { transport, wallet };
  const accountAddress = optionalEnv("HYPERLIQUID_ACCOUNT_ADDRESS");
  const vaultAddress = optionalEnv("HYPERLIQUID_VAULT_ADDRESS");
  if (accountAddress) config.accountAddress = accountAddress;
  if (vaultAddress) config.vaultAddress = vaultAddress;
  return new ExchangeClient(config as never);
}

function infoClient(): InstanceType<typeof InfoClient> {
  return new InfoClient({ transport: new HttpTransport({ apiUrl: HYPERLIQUID_API_BASE }) });
}

async function postInfo(payload: Record<string, unknown>): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${HYPERLIQUID_API_BASE}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "tradex/0.1" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Hyperliquid HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function perpDexNames(): Promise<Array<string | null>> {
  try {
    const payload = await postInfo({ type: "perpDexs" });
    if (!Array.isArray(payload)) return [null];
    const names: Array<string | null> = [null];
    for (const item of payload) {
      if (!item || typeof item !== "object") continue;
      const name = String((item as Record<string, unknown>).name || "").trim();
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  } catch {
    return [null];
  }
}

function dexPayload(base: Record<string, unknown>, dex: string | null): Record<string, unknown> {
  return dex ? { ...base, dex } : base;
}

function normalizeCoinForApi(coin: string): string {
  const value = coin.trim();
  if (value.includes(":")) {
    const [dex, asset] = value.split(":", 2);
    return dex.trim() && asset.trim() ? `${dex.trim().toLowerCase()}:${asset.trim().toUpperCase()}` : "";
  }
  return value;
}

function coinWithDex(coin: unknown, dex: string | null): string {
  const value = String(coin || "").trim();
  if (!value) return "";
  if (value.includes(":")) return normalizeCoinForApi(value);
  return dex ? `${dex.trim().toLowerCase()}:${value.toUpperCase()}` : value;
}

function toFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getPositions(): Promise<ExchangePosition[]> {
  if (!hyperliquidCredentialsAvailable()) return [];
  const address = userAddress();
  const positions: ExchangePosition[] = [];
  for (const dex of await perpDexNames()) {
    try {
      const state = await postInfo(dexPayload({ type: "clearinghouseState", user: address }, dex));
      positions.push(...positionsFromState(state, dex));
    } catch {
      continue;
    }
  }
  return positions;
}

function positionsFromState(state: unknown, dex: string | null): ExchangePosition[] {
  if (!state || typeof state !== "object" || Array.isArray(state)) return [];
  const assetPositions = (state as Record<string, unknown>).assetPositions;
  if (!Array.isArray(assetPositions)) return [];
  const positions: ExchangePosition[] = [];
  for (const item of assetPositions) {
    const p = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).position : null;
    if (!p || typeof p !== "object" || Array.isArray(p)) continue;
    const pos = p as Record<string, unknown>;
    const coin = coinWithDex(pos.coin, dex);
    const szi = toFloat(pos.szi) ?? 0;
    if (szi === 0) continue;
    const leverage = pos.leverage && typeof pos.leverage === "object" && !Array.isArray(pos.leverage) ? toFloat((pos.leverage as Record<string, unknown>).value) : null;
    positions.push({
      exchange: HYPERLIQUID_FILL_SOURCE,
      symbol: coin,
      instrumentKey: `hyperliquid:${coin}`,
      side: szi > 0 ? "long" : "short",
      size: Math.abs(szi),
      entryPrice: toFloat(pos.entryPx) ?? 0,
      markPrice: toFloat(pos.markPx) ?? toFloat(pos.entryPx) ?? 0,
      unrealizedPnl: toFloat(pos.unrealizedPnl) ?? 0,
      leverage,
      margin: toFloat(pos.marginUsed) ?? 0,
      liquidationPrice: toFloat(pos.liquidationPx),
    });
  }
  return positions;
}

export async function getOpenOrders(): Promise<ExchangeOrder[]> {
  if (!hyperliquidCredentialsAvailable()) return [];
  const address = userAddress();
  const orders: ExchangeOrder[] = [];
  for (const dex of await perpDexNames()) {
    try {
      const rawOrders = await postInfo(dexPayload({ type: "openOrders", user: address }, dex));
      orders.push(...ordersFromPayload(rawOrders, dex));
    } catch {
      continue;
    }
  }
  return orders;
}

function ordersFromPayload(rawOrders: unknown, dex: string | null): ExchangeOrder[] {
  if (!Array.isArray(rawOrders)) return [];
  return rawOrders
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((order) => {
      const coin = coinWithDex(order.coin, dex);
      const triggerPrice = toFloat(order.triggerPx);
      const reduceOnly = typeof order.reduceOnly === "string" ? order.reduceOnly.toLowerCase() === "true" : typeof order.reduceOnly === "boolean" ? order.reduceOnly : null;
      return {
        exchange: HYPERLIQUID_FILL_SOURCE,
        symbol: coin,
        instrumentKey: `hyperliquid:${coin}`,
        orderId: String(order.oid || ""),
        side: String(order.side || "").toUpperCase() === "B" ? "buy" : "sell",
        orderType: triggerPrice !== null ? "trigger" : "limit",
        size: toFloat(order.sz) ?? 0,
        price: toFloat(order.limitPx),
        filledSize: 0,
        status: "open",
        createdAtMs: Number(order.timestamp || 0),
        reduceOnly,
        triggerPrice,
        tpsl: order.tpsl ? String(order.tpsl) : null,
      };
    });
}

export async function getUserFills(input: { coin?: string | null; startTimeMs?: number | null; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
  if (!hyperliquidCredentialsAvailable()) return [];
  try {
    const info = infoClient() as never as { userFillsByTime: (params: Record<string, unknown>) => Promise<unknown[]> };
    const rawFills = await info.userFillsByTime({ user: userAddress(), startTime: input.startTimeMs ?? 0 });
    const results: Array<Record<string, unknown>> = [];
    for (const item of rawFills.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object" && !Array.isArray(x))) {
      const fillCoin = String(item.coin || "");
      if (input.coin && fillCoin !== input.coin) continue;
      results.push({
        oid: item.oid,
        coin: fillCoin,
        instrumentKey: `hyperliquid:${fillCoin}`,
        side: item.side,
        price: toFloat(item.px) ?? 0,
        size: toFloat(item.sz) ?? 0,
        fee: toFloat(item.fee) ?? 0,
        closedPnl: toFloat(item.closedPnl) ?? 0,
        filledAtMs: Number(item.time || 0),
        dir: item.dir,
        exchange: HYPERLIQUID_FILL_SOURCE,
      });
      if (results.length >= (input.limit ?? 50)) break;
    }
    return results;
  } catch {
    return [];
  }
}

export async function cancelOrder(input: { orderId: string; coin: string }): Promise<boolean> {
  const client = exchangeClient() as never as { cancel: (params: Record<string, unknown>) => Promise<Record<string, unknown>> };
  try {
    const result = await client.cancel({ cancels: [{ coin: normalizeCoinForApi(input.coin), oid: Number(input.orderId) }] });
    return result.status === "ok";
  } catch {
    return false;
  }
}

export async function openPosition(input: {
  coin: string;
  isBuy: boolean;
  size: number;
  orderType: string;
  limitPrice?: number | null;
  slippage?: number;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
}): Promise<HyperliquidOrderResult> {
  if (input.size <= 0) throw new HyperliquidTradingError("size must be positive");
  const coin = normalizeCoinForApi(input.coin);
  if (!coin) throw new HyperliquidTradingError("coin is required");
  const client = exchangeClient() as never as { order: (params: Record<string, unknown>) => Promise<Record<string, unknown>> };
  const normalizedType = (input.orderType || "market").trim().toLowerCase();
  const limitPx = normalizedType === "limit"
    ? input.limitPrice
    : await marketOrderLimitPx(coin, input.isBuy, input.slippage ?? 0.05);
  if (normalizedType === "limit" && input.limitPrice === undefined) throw new HyperliquidTradingError("limit order requires limit_price");
  if (limitPx === undefined || limitPx === null || limitPx <= 0) throw new HyperliquidTradingError("cannot resolve Hyperliquid order price");
  const order = {
    coin,
    is_buy: input.isBuy,
    sz: input.size,
    limit_px: limitPx,
    order_type: normalizedType === "limit" ? { limit: { tif: "Gtc" } } : { limit: { tif: "Ioc" } },
    reduce_only: false,
  };
  const orders = [
    order,
    ...tpslOrderSpecs({
      coin,
      isBuy: input.isBuy,
      size: input.size,
      takeProfitPrice: input.takeProfitPrice,
      stopLossPrice: input.stopLossPrice,
    }),
  ];
  const payload = await client.order({ orders, grouping: orders.length > 1 ? "normalTpsl" : "na" });
  return parseOrderResult(payload);
}

export async function placeTriggerOrder(input: {
  coin: string;
  isBuy: boolean;
  size: number;
  triggerPrice: number;
  tpsl: string;
  limitPrice?: number | null;
}): Promise<HyperliquidOrderResult> {
  if (input.size <= 0) throw new HyperliquidTradingError("size must be positive");
  const tpsl = input.tpsl.trim().toLowerCase();
  if (!["tp", "sl"].includes(tpsl)) throw new HyperliquidTradingError("tpsl must be tp or sl");
  const client = exchangeClient() as never as { order: (params: Record<string, unknown>) => Promise<Record<string, unknown>> };
  const payload = await client.order({
    orders: [
      {
        coin: normalizeCoinForApi(input.coin),
        is_buy: input.isBuy,
        sz: input.size,
        limit_px: input.limitPrice ?? input.triggerPrice,
        order_type: { trigger: { triggerPx: input.triggerPrice, isMarket: true, tpsl } },
        reduce_only: true,
      },
    ],
    grouping: "na",
  });
  return parseOrderResult(payload);
}

export async function closePosition(input: { coin: string; size?: number | null; slippage?: number }): Promise<HyperliquidOrderResult> {
  const position = (await getPositions()).find((item) => item.symbol === normalizeCoinForApi(input.coin));
  if (!position) throw new HyperliquidTradingError("no matching position to close");
  const coin = normalizeCoinForApi(input.coin);
  const isBuy = position.side === "short";
  const size = input.size ?? position.size;
  const client = exchangeClient() as never as { order: (params: Record<string, unknown>) => Promise<Record<string, unknown>> };
  const limitPx = await marketOrderLimitPx(coin, isBuy, input.slippage ?? 0.05);
  const payload = await client.order({
    orders: [{
      coin,
      is_buy: isBuy,
      sz: size,
      limit_px: limitPx,
      order_type: { limit: { tif: "Ioc" } },
      reduce_only: true,
    }],
    grouping: "na",
  });
  return parseOrderResult(payload);
}

async function marketOrderLimitPx(coin: string, isBuy: boolean, slippage: number): Promise<number> {
  const contexts = await postInfo({ type: "metaAndAssetCtxs", ...(coin.includes(":") ? { dex: coin.split(":", 2)[0] } : {}) });
  if (!Array.isArray(contexts) || contexts.length < 2 || !Array.isArray(contexts[0]?.universe) || !Array.isArray(contexts[1])) {
    throw new HyperliquidTradingError("Hyperliquid asset contexts returned unexpected payload");
  }
  const apiCoin = coin.includes(":") ? coin.split(":", 2)[1] : coin;
  const index = contexts[0].universe.findIndex((item: unknown) => item && typeof item === "object" && !Array.isArray(item) && String((item as Record<string, unknown>).name || "").toUpperCase() === apiCoin.toUpperCase());
  const ctx = index >= 0 ? contexts[1][index] as Record<string, unknown> : null;
  const mid = ctx ? toFloat(ctx.midPx || ctx.markPx || ctx.oraclePx) : null;
  if (mid === null || mid <= 0) throw new HyperliquidTradingError("cannot resolve Hyperliquid market price");
  const boundedSlippage = Math.max(0, Math.min(slippage, 0.5));
  return isBuy ? mid * (1 + boundedSlippage) : mid * (1 - boundedSlippage);
}

function tpslOrderSpecs(input: {
  coin: string;
  isBuy: boolean;
  size: number;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
}): Array<Record<string, unknown>> {
  const closeIsBuy = !input.isBuy;
  const orders: Array<Record<string, unknown>> = [];
  if (input.takeProfitPrice !== undefined && input.takeProfitPrice !== null) {
    orders.push({
      coin: input.coin,
      is_buy: closeIsBuy,
      sz: input.size,
      limit_px: input.takeProfitPrice,
      order_type: { trigger: { triggerPx: input.takeProfitPrice, isMarket: true, tpsl: "tp" } },
      reduce_only: true,
    });
  }
  if (input.stopLossPrice !== undefined && input.stopLossPrice !== null) {
    orders.push({
      coin: input.coin,
      is_buy: closeIsBuy,
      sz: input.size,
      limit_px: input.stopLossPrice,
      order_type: { trigger: { triggerPx: input.stopLossPrice, isMarket: true, tpsl: "sl" } },
      reduce_only: true,
    });
  }
  return orders;
}

function parseOrderResult(payload: Record<string, unknown>): HyperliquidOrderResult {
  if (payload.status !== "ok") throw new HyperliquidTradingError(String(payload.response || JSON.stringify(payload)));
  const response = payload.response && typeof payload.response === "object" && !Array.isArray(payload.response) ? (payload.response as Record<string, unknown>) : {};
  const data = response.data && typeof response.data === "object" && !Array.isArray(response.data) ? (response.data as Record<string, unknown>) : {};
  const statuses = Array.isArray(data.statuses) ? data.statuses : [];
  const first = statuses[0];
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const status = first as Record<string, unknown>;
    if (status.error) throw new HyperliquidTradingError(String(status.error));
    const filled = status.filled && typeof status.filled === "object" && !Array.isArray(status.filled) ? (status.filled as Record<string, unknown>) : null;
    if (filled) {
      return {
        raw: payload,
        externalOrderId: filled.oid !== undefined ? String(filled.oid) : null,
        averagePrice: toFloat(filled.avgPx),
        filledSize: toFloat(filled.totalSz),
        resting: false,
      };
    }
    const resting = status.resting && typeof status.resting === "object" && !Array.isArray(status.resting) ? (status.resting as Record<string, unknown>) : null;
    if (resting) return { raw: payload, externalOrderId: resting.oid !== undefined ? String(resting.oid) : null, averagePrice: null, filledSize: null, resting: true };
  }
  return { raw: payload, externalOrderId: null, averagePrice: null, filledSize: null, resting: false };
}
