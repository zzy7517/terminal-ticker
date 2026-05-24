import { fetch as browserFetch } from "wreq-js";
import { websocket as browserWebSocket } from "wreq-js";
import { BITGET_SOURCE, InstrumentConfig } from "../config/index.js";
import { Candle } from "../domain/price_action.js";

export const BITGET_API_BASE = "https://api.bitget.com";
export const BITGET_WS_PUBLIC = "wss://ws.bitget.com/v2/ws/public";
export const USDT_FUTURES = "USDT-FUTURES";
export const USDC_FUTURES = "USDC-FUTURES";
export const COIN_FUTURES = "COIN-FUTURES";
const FUTURES_PRODUCT_TYPES = [USDT_FUTURES, USDC_FUTURES, COIN_FUTURES] as const;

export class BitgetInstrument {
  readonly symbol: string;
  readonly instType: string;
  readonly label: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly marketKind: string;
  readonly showCollapsed: boolean;
  readonly source = BITGET_SOURCE;
  readonly group: string;
  readonly analysisInterval: string | null;

  constructor(input: {
    symbol: string;
    instType: string;
    label: string;
    baseAsset: string;
    quoteAsset: string;
    marketKind: string;
    showCollapsed?: boolean;
    group?: string;
    analysisInterval?: string | null;
  }) {
    this.symbol = input.symbol;
    this.instType = input.instType;
    this.label = input.label;
    this.baseAsset = input.baseAsset;
    this.quoteAsset = input.quoteAsset;
    this.marketKind = input.marketKind;
    this.showCollapsed = input.showCollapsed ?? true;
    this.group = input.group ?? "crypto";
    this.analysisInterval = input.analysisInterval ?? null;
  }

  get key(): string {
    return `${this.instType}:${this.symbol}`;
  }
}

async function fetchJson(apiPath: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`${BITGET_API_BASE}${apiPath}`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await browserFetch(url.toString(), {
        profile: "chrome_133",
        operatingSystem: "macos",
        headers: { "User-Agent": "tradex/0.1" },
      } as never);
      if (!response.ok) throw new Error(`Bitget HTTP ${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function expectSuccess(payload: Record<string, unknown>, context: string): unknown[] {
  if (payload.code !== "00000") throw new Error(`${context} failed: ${String(payload.msg || "unknown error")}`);
  if (!Array.isArray(payload.data)) throw new Error(`${context} returned unexpected payload`);
  return payload.data;
}

export async function loadInstrumentCatalog(): Promise<Map<string, BitgetInstrument>> {
  const catalog = new Map<string, BitgetInstrument>();
  for (const productType of FUTURES_PRODUCT_TYPES) {
    const payload = await fetchJson("/api/v2/mix/market/contracts", { productType });
    for (const raw of expectSuccess(payload, `Bitget ${productType} contracts`)) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const symbol = String(item.symbol || "").toUpperCase();
      if (!symbol) continue;
      catalog.set(
        `${productType}\0${symbol}`,
        new BitgetInstrument({
          symbol,
          instType: productType,
          label: symbol,
          baseAsset: String(item.baseCoin || symbol),
          quoteAsset: String(item.quoteCoin || productType.split("-", 1)[0]),
          marketKind: item.symbolType === "perpetual" ? "perp" : "futures",
        }),
      );
    }
  }
  return catalog;
}

export async function resolveInstruments(configured: readonly InstrumentConfig[]): Promise<BitgetInstrument[]> {
  const needsCatalog = configured.some((item) => item.instType === null);
  let catalog = new Map<string, BitgetInstrument>();
  if (needsCatalog) {
    try {
      catalog = await loadInstrumentCatalog();
    } catch {
      catalog = new Map();
    }
  }
  const resolved: BitgetInstrument[] = [];
  for (const requested of configured) {
    let instrument: BitgetInstrument | undefined;
    if (requested.instType !== null) {
      instrument = catalog.get(`${requested.instType}\0${requested.symbol}`);
      if (!instrument) {
        instrument = new BitgetInstrument({
          symbol: requested.symbol,
          instType: requested.instType,
          label: requested.label || requested.symbol,
          baseAsset: requested.symbol,
          quoteAsset: requested.instType.split("-", 1)[0],
          marketKind: "perp",
        });
      }
    } else {
      const matches = [...catalog.values()].filter((item) => item.symbol === requested.symbol);
      if (matches.length === 0) {
        instrument = new BitgetInstrument({
          symbol: requested.symbol,
          instType: "USDT-FUTURES",
          label: requested.label || requested.symbol,
          baseAsset: requested.symbol,
          quoteAsset: "USDT",
          marketKind: "perp",
        });
        resolved.push(instrument);
        continue;
      }
      if (matches.length > 1) {
        throw new Error(`Bitget symbol is ambiguous: ${requested.symbol}. Specify inst_type (${matches.map((item) => item.instType).sort().join(", ")}).`);
      }
      instrument = matches[0];
    }
    resolved.push(
      new BitgetInstrument({
        symbol: instrument.symbol,
        instType: instrument.instType,
        label: requested.label || instrument.symbol,
        baseAsset: instrument.baseAsset,
        quoteAsset: instrument.quoteAsset,
        marketKind: instrument.marketKind,
        showCollapsed: requested.showCollapsed,
        group: requested.group,
        analysisInterval: requested.analysisInterval,
      }),
    );
  }
  return resolved;
}

function asFloat(rawValue: unknown): number | null {
  if (rawValue === null || rawValue === undefined || rawValue === "") return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

function asInt(rawValue: unknown): number | null {
  if (rawValue === null || rawValue === undefined || rawValue === "") return null;
  const value = Number.parseInt(String(rawValue), 10);
  return Number.isFinite(value) ? value : null;
}

function expectFloat(rawValue: unknown, fieldName: string): number {
  const value = asFloat(rawValue);
  if (value === null) throw new Error(`Bitget candle missing ${fieldName}`);
  return value;
}

function expectInt(rawValue: unknown, fieldName: string): number {
  const value = asInt(rawValue);
  if (value === null) throw new Error(`Bitget candle missing ${fieldName}`);
  return value;
}

function normalizeCandleRow(symbolKey: string, row: unknown[]): Candle {
  if (row.length < 6) throw new Error("Bitget candle returned unexpected payload");
  return new Candle({
    symbolKey,
    openTimeMs: expectInt(row[0], "timestamp"),
    open: expectFloat(row[1], "open"),
    high: expectFloat(row[2], "high"),
    low: expectFloat(row[3], "low"),
    close: expectFloat(row[4], "close"),
    volume: expectFloat(row[5], "volume"),
  });
}

export async function fetchCandles(
  instrument: BitgetInstrument,
  input: { interval: string; limit: number; afterOpenTimeMs?: number | null; beforeOpenTimeMs?: number | null },
): Promise<Candle[]> {
  if (input.afterOpenTimeMs !== undefined && input.afterOpenTimeMs !== null && input.beforeOpenTimeMs !== undefined && input.beforeOpenTimeMs !== null) {
    throw new Error("after_open_time_ms and before_open_time_ms cannot both be set");
  }
  const params: Record<string, string> = {
    symbol: instrument.symbol,
    productType: instrument.instType,
    granularity: input.interval,
    limit: String(Math.min(input.limit, input.beforeOpenTimeMs !== undefined && input.beforeOpenTimeMs !== null ? 200 : 1000)),
  };
  if (input.afterOpenTimeMs !== undefined && input.afterOpenTimeMs !== null) {
    params.startTime = String(input.afterOpenTimeMs + 1);
    params.endTime = String(Date.now());
  }
  if (input.beforeOpenTimeMs !== undefined && input.beforeOpenTimeMs !== null) {
    params.endTime = String(input.beforeOpenTimeMs - 1);
  }
  const apiPath = input.beforeOpenTimeMs !== undefined && input.beforeOpenTimeMs !== null ? "/api/v2/mix/market/history-candles" : "/api/v2/mix/market/candles";
  const rows = expectSuccess(await fetchJson(apiPath, params), "Bitget futures candles");
  let candles = rows.filter(Array.isArray).map((row) => normalizeCandleRow(instrument.key, row));
  if (input.afterOpenTimeMs !== undefined && input.afterOpenTimeMs !== null) candles = candles.filter((candle) => candle.openTimeMs > input.afterOpenTimeMs!);
  if (input.beforeOpenTimeMs !== undefined && input.beforeOpenTimeMs !== null) candles = candles.filter((candle) => candle.openTimeMs < input.beforeOpenTimeMs!);
  return candles.sort((left, right) => left.openTimeMs - right.openTimeMs).slice(-input.limit);
}

function normalizeTickerPayload(item: Record<string, unknown>, instrument: BitgetInstrument): Record<string, unknown> {
  const price = asFloat(item.lastPr || item.lastPrice);
  const reference = asFloat(item.open24h || item.open || item.openPrice24h);
  const rawChangePercent = asFloat(item.change24h);
  const changePercent = rawChangePercent === null ? null : rawChangePercent * 100;
  const change = price !== null && reference !== null ? price - reference : null;
  return {
    id: instrument.key,
    short_name: instrument.label,
    display_name: instrument.label,
    price,
    change,
    change_percent: changePercent,
    previous_close: reference,
    day_high: asFloat(item.high24h),
    day_low: asFloat(item.low24h),
    day_volume: asFloat(item.baseVolume),
    volume: asFloat(item.baseVolume),
    currency: instrument.quoteAsset,
    exchange: "Bitget",
    status: instrument.marketKind,
    time: asInt(item.ts),
    index_price: asFloat(item.indexPrice),
    mark_price: asFloat(item.markPrice),
  };
}

export async function fetchSnapshotPayloads(instruments: readonly BitgetInstrument[]): Promise<Record<string, Record<string, unknown>>> {
  const payloads: Record<string, Record<string, unknown>> = {};
  const tickersByKey = new Map<string, Record<string, unknown>>();
  for (const productType of [...new Set(instruments.map((item) => item.instType))].sort()) {
    const symbols = new Set(instruments.filter((item) => item.instType === productType).map((item) => item.symbol));
    const payload = await fetchJson("/api/v2/mix/market/tickers", { productType });
    for (const raw of expectSuccess(payload, "Bitget futures tickers")) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const symbol = String(item.symbol || "").toUpperCase();
      if (symbols.has(symbol)) tickersByKey.set(`${productType}\0${symbol}`, item);
    }
  }
  for (const instrument of instruments) {
    const item = tickersByKey.get(`${instrument.instType}\0${instrument.symbol}`);
    if (item) payloads[instrument.key] = normalizeTickerPayload(item, instrument);
  }
  return payloads;
}

export class BitgetPublicWebSocket {
  readonly instruments: readonly BitgetInstrument[];
  private readonly lookup: Map<string, BitgetInstrument>;
  private socket: Awaited<ReturnType<typeof browserWebSocket>> | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(instruments: readonly BitgetInstrument[]) {
    this.instruments = instruments;
    this.lookup = new Map(instruments.map((instrument) => [`${instrument.instType}\0${instrument.symbol}`, instrument]));
  }

  async subscribe(): Promise<void> {
    if (this.socket !== null) return;
    this.socket = await browserWebSocket(BITGET_WS_PUBLIC, {
      browser: "chrome_133",
      os: "macos",
    } as never);
    await waitForSocketOpen(this.socket);
    const args = this.instruments.map((instrument) => ({
      instType: instrument.instType,
      channel: "ticker",
      instId: instrument.symbol,
    }));
    this.socket.send(JSON.stringify({ op: "subscribe", args }));
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === 1) this.socket.send("ping");
    }, 25_000);
  }

  async listen(messageHandler: (payload: Record<string, unknown>) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.subscribe();
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onAbort = () => {
        void this.close().finally(() => {
          cleanup();
          resolve();
        });
      };
      const onMessage = (event: { data: unknown }) => {
        void (async () => {
          const text = String(event.data);
          if (text === "pong") return;
          const message = JSON.parse(text) as Record<string, unknown>;
          if (message.event === "error") throw new Error(String(message.msg || "Bitget websocket error"));
          if (!Array.isArray(message.data) || !message.arg || typeof message.arg !== "object") return;
          const arg = message.arg as Record<string, unknown>;
          const instrument = this.lookup.get(`${String(arg.instType || "").toUpperCase()}\0${String(arg.instId || "").toUpperCase()}`);
          if (!instrument) return;
          for (const item of message.data) {
            if (item && typeof item === "object") await messageHandler(normalizeTickerPayload(item as Record<string, unknown>, instrument));
          }
        })().catch(onError);
      };
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async close(): Promise<void> {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.socket !== null) {
      const socket = this.socket;
      this.socket = null;
      if (socket.readyState === 0 || socket.readyState === 1) {
        socket.close();
      }
    }
  }
}

async function waitForSocketOpen(socket: Awaited<ReturnType<typeof browserWebSocket>>): Promise<void> {
  if (socket.readyState === 1) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}
