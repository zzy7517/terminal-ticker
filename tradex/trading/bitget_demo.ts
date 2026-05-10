import crypto from "node:crypto";

export const BITGET_API_BASE = "https://api.bitget.com";
export const BITGET_DEMO_FILL_SOURCE = "bitget-demo";
export const BITGET_FUTURES_TYPES = new Set(["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"]);

const FUTURES_ORDER_PATH = "/api/v2/mix/order/place-order";
const ORDER_TYPES = new Set(["market", "limit"]);
const FORCE_TYPES = new Set(["gtc", "ioc", "fok", "post_only"]);
const MARGIN_MODES = new Set(["crossed", "isolated"]);

export class BitgetDemoTradingError extends Error {}

export interface BitgetDemoOrderResult {
  raw: Record<string, unknown>;
  externalOrderId: string | null;
  clientOrderId: string | null;
}

function optionalEnv(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function bitgetDemoCredentialsAvailable(): boolean {
  return Boolean(
    optionalEnv("BITGET_DEMO_API_KEY") &&
      optionalEnv("BITGET_DEMO_API_SECRET", "BITGET_DEMO_SECRET_KEY") &&
      optionalEnv("BITGET_DEMO_PASSPHRASE", "BITGET_DEMO_API_PASSPHRASE"),
  );
}

function credentials(): { apiKey: string; apiSecret: string; passphrase: string } {
  const apiKey = optionalEnv("BITGET_DEMO_API_KEY");
  const apiSecret = optionalEnv("BITGET_DEMO_API_SECRET", "BITGET_DEMO_SECRET_KEY");
  const passphrase = optionalEnv("BITGET_DEMO_PASSPHRASE", "BITGET_DEMO_API_PASSPHRASE");
  const missing = [
    apiKey ? "" : "BITGET_DEMO_API_KEY",
    apiSecret ? "" : "BITGET_DEMO_API_SECRET",
    passphrase ? "" : "BITGET_DEMO_PASSPHRASE",
  ].filter(Boolean);
  if (!apiKey || !apiSecret || !passphrase) throw new BitgetDemoTradingError(`Bitget demo trading requires ${missing.join(", ")}.`);
  return { apiKey, apiSecret, passphrase };
}

function jsonBody(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

function sign(input: { timestampMs: string; method: string; requestPath: string; body: string; secret: string; queryString?: string }): string {
  const query = input.queryString ? `?${input.queryString}` : "";
  const preHash = `${input.timestampMs}${input.method.toUpperCase()}${input.requestPath}${query}${input.body}`;
  return crypto.createHmac("sha256", input.secret).update(preHash).digest("base64");
}

async function signedPost(requestPath: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const creds = credentials();
  const body = jsonBody(payload);
  const timestamp = String(Date.now());
  const response = await fetch(`${BITGET_API_BASE}${requestPath}`, {
    method: "POST",
    headers: {
      "ACCESS-KEY": creds.apiKey,
      "ACCESS-SIGN": sign({ timestampMs: timestamp, method: "POST", requestPath, body, secret: creds.apiSecret }),
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": creds.passphrase,
      "Content-Type": "application/json",
      locale: "en-US",
      paptrading: "1",
      "User-Agent": "tradex/0.1",
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new BitgetDemoTradingError(`Bitget demo request failed: HTTP ${response.status} ${text}`);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BitgetDemoTradingError("Bitget demo returned unexpected payload.");
  return parsed as Record<string, unknown>;
}

function expectSuccess(payload: Record<string, unknown>): BitgetDemoOrderResult {
  if (payload.code !== "00000") throw new BitgetDemoTradingError(`Bitget demo order failed: ${String(payload.msg || payload.message || JSON.stringify(payload))}`);
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? (payload.data as Record<string, unknown>) : null;
  if (data === null) throw new BitgetDemoTradingError("Bitget demo order returned unexpected payload.");
  return {
    raw: payload,
    externalOrderId: data.orderId ? String(data.orderId) : null,
    clientOrderId: data.clientOid ? String(data.clientOid) : null,
  };
}

function clientOid(): string {
  return `tradex-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

function normalizeInstType(instType: string): string {
  const normalized = instType.trim().toUpperCase();
  if (!BITGET_FUTURES_TYPES.has(normalized)) throw new BitgetDemoTradingError(`unsupported Bitget demo inst_type: ${instType}`);
  return normalized;
}

function normalizeOrderType(orderType: string): string {
  const normalized = (orderType || "market").trim().toLowerCase();
  if (!ORDER_TYPES.has(normalized)) throw new BitgetDemoTradingError("order_type must be market or limit");
  return normalized;
}

function normalizeForce(force: string): string {
  const normalized = (force || "gtc").trim().toLowerCase();
  if (!FORCE_TYPES.has(normalized)) throw new BitgetDemoTradingError("force must be one of: gtc, ioc, fok, post_only");
  return normalized;
}

function normalizeMarginMode(marginMode: string): string {
  const normalized = (marginMode || "crossed").trim().toLowerCase();
  if (!MARGIN_MODES.has(normalized)) throw new BitgetDemoTradingError("margin_mode must be crossed or isolated");
  return normalized;
}

export async function openDemoPosition(input: {
  symbol: string;
  instType: string;
  isBuy: boolean;
  size: number;
  orderType: string;
  limitPrice?: number | null;
  marginMode?: string;
  marginCoin?: string;
  force?: string;
  clientOid?: string | null;
}): Promise<BitgetDemoOrderResult> {
  const symbol = input.symbol.trim().toUpperCase();
  if (!symbol) throw new BitgetDemoTradingError("symbol is required");
  const instType = normalizeInstType(input.instType);
  const orderType = normalizeOrderType(input.orderType);
  if (input.size <= 0) throw new BitgetDemoTradingError("size must be positive");
  if (orderType === "limit" && input.limitPrice === undefined) throw new BitgetDemoTradingError("limit order requires limit_price");
  const oid = input.clientOid?.trim() || clientOid();
  if (oid.length > 32) throw new BitgetDemoTradingError("client_oid must be 32 characters or fewer");
  const body: Record<string, unknown> = {
    symbol,
    productType: instType,
    marginMode: normalizeMarginMode(input.marginMode ?? "crossed"),
    marginCoin: (input.marginCoin ?? "USDT").trim().toUpperCase() || "USDT",
    size: String(input.size),
    side: input.isBuy ? "buy" : "sell",
    tradeSide: "open",
    orderType,
    clientOid: oid,
  };
  if (orderType === "limit") {
    body.force = normalizeForce(input.force ?? "gtc");
    body.price = String(input.limitPrice);
  }
  return expectSuccess(await signedPost(FUTURES_ORDER_PATH, body));
}
