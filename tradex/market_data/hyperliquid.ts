import WebSocket from "ws";
import { HYPERLIQUID_SOURCE, InstrumentConfig } from "../config/index.js";
import { Candle } from "../domain/price_action.js";

export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";
export const HYPERLIQUID_WS_PUBLIC = "wss://api.hyperliquid.xyz/ws";
export const QUOTE_ASSET = "USDC";
const TRADEFI_GROUPS = new Set(["stocks", "indices", "commodities", "fx", "preipo"]);
const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1H": 3600,
  "4H": 14_400,
  "6H": 21_600,
  "12H": 43_200,
  "1D": 86_400,
  "3D": 259_200,
  "1W": 604_800,
  "1M": 2_592_000,
};

export class HyperliquidInstrument {
  readonly symbol: string;
  readonly label: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly marketKind: string;
  readonly szDecimals: number | null;
  readonly maxLeverage: number | null;
  readonly showCollapsed: boolean;
  readonly source = HYPERLIQUID_SOURCE;
  readonly group: string;
  readonly analysisInterval: string | null;
  readonly dex: string | null;
  readonly category: string | null;

  constructor(input: {
    symbol: string;
    label: string;
    baseAsset: string;
    quoteAsset?: string;
    marketKind?: string;
    szDecimals?: number | null;
    maxLeverage?: number | null;
    showCollapsed?: boolean;
    group?: string;
    analysisInterval?: string | null;
    dex?: string | null;
    category?: string | null;
  }) {
    this.symbol = input.symbol;
    this.label = input.label;
    this.baseAsset = input.baseAsset;
    this.quoteAsset = input.quoteAsset ?? QUOTE_ASSET;
    this.marketKind = input.marketKind ?? "perp";
    this.szDecimals = input.szDecimals ?? null;
    this.maxLeverage = input.maxLeverage ?? null;
    this.showCollapsed = input.showCollapsed ?? true;
    this.group = input.group ?? "crypto";
    this.analysisInterval = input.analysisInterval ?? null;
    this.dex = input.dex ?? null;
    this.category = input.category ?? null;
  }

  get key(): string {
    return `${this.source}:${this.symbol}`;
  }
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

function normalizeSymbol(symbol: string): string {
  const value = symbol.trim();
  if (value.includes(":")) {
    const [dex, coin] = value.split(":", 2);
    return dex.trim() && coin.trim() ? `${dex.trim().toLowerCase()}:${coin.trim().toUpperCase()}` : "";
  }
  return value.toUpperCase();
}

function apiSymbol(symbol: string): string {
  const value = symbol.trim();
  if (value.includes(":")) {
    const [dex, coin] = value.split(":", 2);
    return dex.trim() && coin.trim() ? `${dex.trim().toLowerCase()}:${coin.trim().toUpperCase()}` : "";
  }
  return value;
}

function baseAsset(symbol: string): string {
  return symbol.includes(":") ? symbol.split(":", 2)[1] : symbol;
}

function dexName(symbol: string): string | null {
  return symbol.includes(":") ? symbol.split(":", 2)[0] : null;
}

function groupForCategory(category: string | null): string {
  const normalized = (category || "crypto").trim().toLowerCase();
  return TRADEFI_GROUPS.has(normalized) ? normalized : "crypto";
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
  if (value === null) throw new Error(`Hyperliquid candle missing ${fieldName}`);
  return value;
}

function expectInt(rawValue: unknown, fieldName: string): number {
  const value = asInt(rawValue);
  if (value === null) throw new Error(`Hyperliquid candle missing ${fieldName}`);
  return value;
}

async function loadPerpCategories(): Promise<Map<string, string>> {
  try {
    const payload = await postInfo({ type: "perpCategories" });
    const categories = new Map<string, string>();
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (Array.isArray(item) && item.length >= 2 && typeof item[0] === "string" && typeof item[1] === "string") {
          categories.set(normalizeSymbol(item[0]), item[1].trim().toLowerCase());
        }
      }
    }
    return categories;
  } catch {
    return new Map();
  }
}

async function loadPerpDexNames(): Promise<Array<string | null>> {
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

async function metaAndContextsPayload(dex?: string | null): Promise<unknown> {
  return postInfo(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" });
}

export async function loadInstrumentCatalog(): Promise<Map<string, HyperliquidInstrument>> {
  const categories = await loadPerpCategories();
  const catalog = new Map<string, HyperliquidInstrument>();
  for (const dex of await loadPerpDexNames()) {
    try {
      const partial = catalogFromMetaPayload(await metaAndContextsPayload(dex), categories, dex);
      for (const [key, value] of partial) catalog.set(key, value);
    } catch {
      continue;
    }
  }
  return catalog;
}

function catalogFromMetaPayload(payload: unknown, categories: Map<string, string>, dex: string | null): Map<string, HyperliquidInstrument> {
  if (!Array.isArray(payload) || payload.length === 0) throw new Error("Hyperliquid meta returned unexpected payload");
  const meta = payload[0];
  const universe = meta && typeof meta === "object" ? (meta as Record<string, unknown>).universe : null;
  if (!Array.isArray(universe)) throw new Error("Hyperliquid meta missing universe");
  const catalog = new Map<string, HyperliquidInstrument>();
  for (const raw of universe) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    let symbol = apiSymbol(String(item.name || ""));
    if (dex && !symbol.includes(":")) symbol = `${dex}:${symbol.toUpperCase()}`;
    if (!symbol) continue;
    const asset = baseAsset(symbol);
    const symbolDex = dexName(symbol) || dex;
    const category = categories.get(symbol) ?? "crypto";
    catalog.set(
      normalizeSymbol(symbol),
      new HyperliquidInstrument({
        symbol,
        label: symbolDex ? `${asset} Perp (${symbolDex})` : `${asset} Perp`,
        baseAsset: asset,
        szDecimals: asInt(item.szDecimals),
        maxLeverage: asInt(item.maxLeverage),
        group: groupForCategory(category),
        dex: symbolDex,
        category,
      }),
    );
  }
  return catalog;
}

export async function resolveInstruments(configured: readonly InstrumentConfig[]): Promise<HyperliquidInstrument[]> {
  return configured.map((requested) => {
    const instrument = new HyperliquidInstrument({
      symbol: requested.symbol,
      label: requested.label || `${baseAsset(requested.symbol)} Perp`,
      baseAsset: baseAsset(requested.symbol),
      group: requested.group,
      analysisInterval: requested.analysisInterval,
      dex: dexName(requested.symbol),
      category: "crypto",
    });
    return new HyperliquidInstrument({
      symbol: instrument.symbol,
      label: requested.label || instrument.label,
      baseAsset: instrument.baseAsset,
      quoteAsset: instrument.quoteAsset,
      marketKind: instrument.marketKind,
      szDecimals: instrument.szDecimals,
      maxLeverage: instrument.maxLeverage,
      showCollapsed: requested.showCollapsed,
      group: requested.group === "crypto" ? instrument.group : requested.group,
      analysisInterval: requested.analysisInterval,
      dex: instrument.dex,
      category: instrument.category,
    });
  });
}

function apiInterval(interval: string): string {
  return ({ "1H": "1h", "4H": "4h", "6H": "6h", "12H": "12h", "1D": "1d", "3D": "3d", "1W": "1w" } as Record<string, string>)[interval] ?? interval;
}

function intervalMs(interval: string): number {
  const seconds = INTERVAL_SECONDS[interval];
  if (seconds === undefined) throw new Error(`unsupported Hyperliquid candle interval: ${interval}`);
  return seconds * 1000;
}

function normalizeCandleRow(symbolKey: string, row: Record<string, unknown>): Candle {
  return new Candle({
    symbolKey,
    openTimeMs: expectInt(row.t, "open time"),
    open: expectFloat(row.o, "open"),
    high: expectFloat(row.h, "high"),
    low: expectFloat(row.l, "low"),
    close: expectFloat(row.c, "close"),
    volume: expectFloat(row.v, "volume"),
  });
}

export async function fetchCandles(
  instrument: HyperliquidInstrument,
  input: { interval: string; limit: number; afterOpenTimeMs?: number | null; beforeOpenTimeMs?: number | null },
): Promise<Candle[]> {
  if (input.afterOpenTimeMs !== undefined && input.afterOpenTimeMs !== null && input.beforeOpenTimeMs !== undefined && input.beforeOpenTimeMs !== null) {
    throw new Error("after_open_time_ms and before_open_time_ms cannot both be set");
  }
  const stepMs = intervalMs(input.interval);
  const now = Date.now();
  const endTime = input.beforeOpenTimeMs !== undefined && input.beforeOpenTimeMs !== null ? Math.max(0, input.beforeOpenTimeMs - 1) : now;
  const startTime =
    input.afterOpenTimeMs !== undefined && input.afterOpenTimeMs !== null
      ? input.afterOpenTimeMs + 1
      : Math.max(0, endTime - stepMs * Math.max(input.limit * 2, input.limit + 10));
  const payload = await postInfo({
    type: "candleSnapshot",
    req: { coin: instrument.symbol, interval: apiInterval(input.interval), startTime, endTime },
  });
  if (!Array.isArray(payload)) throw new Error("Hyperliquid candles returned unexpected payload");
  let candles = payload
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .map((row) => normalizeCandleRow(instrument.key, row));
  if (input.afterOpenTimeMs !== undefined && input.afterOpenTimeMs !== null) candles = candles.filter((candle) => candle.openTimeMs > input.afterOpenTimeMs!);
  if (input.beforeOpenTimeMs !== undefined && input.beforeOpenTimeMs !== null) candles = candles.filter((candle) => candle.openTimeMs < input.beforeOpenTimeMs!);
  return candles.sort((left, right) => left.openTimeMs - right.openTimeMs).slice(-input.limit);
}

async function instrumentContextsBySymbol(dex: string | null): Promise<Map<string, Record<string, unknown>>> {
  const payload = await metaAndContextsPayload(dex);
  if (!Array.isArray(payload) || payload.length < 2) throw new Error("Hyperliquid asset contexts returned unexpected payload");
  const meta = payload[0];
  const contexts = payload[1];
  const universe = meta && typeof meta === "object" ? (meta as Record<string, unknown>).universe : null;
  if (!Array.isArray(universe) || !Array.isArray(contexts)) throw new Error("Hyperliquid asset contexts missing universe");
  const bySymbol = new Map<string, Record<string, unknown>>();
  for (let index = 0; index < universe.length; index += 1) {
    const item = universe[index];
    const context = contexts[index];
    if (!item || typeof item !== "object" || !context || typeof context !== "object" || Array.isArray(context)) continue;
    let symbol = apiSymbol(String((item as Record<string, unknown>).name || ""));
    if (dex && !symbol.includes(":")) symbol = `${dex}:${symbol.toUpperCase()}`;
    if (symbol) bySymbol.set(symbol, context as Record<string, unknown>);
  }
  return bySymbol;
}

function normalizeTickerPayload(context: Record<string, unknown>, instrument: HyperliquidInstrument): Record<string, unknown> {
  const price = asFloat(context.midPx || context.markPx || context.oraclePx);
  const previous = asFloat(context.prevDayPx);
  const change = price !== null && previous !== null ? price - previous : null;
  const changePercent = change !== null && previous ? (change / previous) * 100 : null;
  return {
    id: instrument.key,
    short_name: instrument.label,
    display_name: instrument.label,
    price,
    change,
    change_percent: changePercent,
    previous_close: previous,
    day_high: null,
    day_low: null,
    day_volume: asFloat(context.dayNtlVlm),
    volume: asFloat(context.dayNtlVlm),
    currency: instrument.quoteAsset,
    exchange: "Hyperliquid",
    status: instrument.category || instrument.marketKind,
    time: Date.now(),
    index_price: asFloat(context.oraclePx),
    mark_price: asFloat(context.markPx),
    funding: asFloat(context.funding),
    open_interest: asFloat(context.openInterest),
  };
}

function normalizeMidPayload(price: number, instrument: HyperliquidInstrument): Record<string, unknown> {
  return {
    id: instrument.key,
    short_name: instrument.label,
    display_name: instrument.label,
    price,
    change: null,
    change_percent: null,
    previous_close: null,
    day_high: null,
    day_low: null,
    day_volume: null,
    volume: null,
    currency: instrument.quoteAsset,
    exchange: "Hyperliquid",
    status: instrument.category || instrument.marketKind,
    time: Date.now(),
    mark_price: price,
  };
}

export async function fetchSnapshotPayloads(instruments: readonly HyperliquidInstrument[]): Promise<Record<string, Record<string, unknown>>> {
  const payloads: Record<string, Record<string, unknown>> = {};
  const byDex = new Map<string | null, HyperliquidInstrument[]>();
  for (const instrument of instruments) {
    const items = byDex.get(instrument.dex) ?? [];
    items.push(instrument);
    byDex.set(instrument.dex, items);
  }
  for (const [dex, dexInstruments] of byDex) {
    const contexts = await instrumentContextsBySymbol(dex);
    for (const instrument of dexInstruments) {
      const context = contexts.get(instrument.symbol);
      if (context) payloads[instrument.key] = normalizeTickerPayload(context, instrument);
    }
  }
  return payloads;
}

export class HyperliquidAllMidsWebSocket {
  readonly instruments: readonly HyperliquidInstrument[];
  private readonly byDex: Map<string, HyperliquidInstrument[]>;
  private sockets: WebSocket[] = [];

  constructor(instruments: readonly HyperliquidInstrument[]) {
    this.instruments = instruments;
    this.byDex = new Map();
    for (const instrument of instruments) {
      const dex = instrument.dex || "";
      this.byDex.set(dex, [...(this.byDex.get(dex) ?? []), instrument]);
    }
  }

  async subscribe(): Promise<void> {
    if (this.sockets.length > 0) return;
    for (const dex of this.byDex.keys()) {
      const socket = new WebSocket(HYPERLIQUID_WS_PUBLIC);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      socket.send(JSON.stringify({
        method: "subscribe",
        subscription: dex ? { type: "allMids", dex } : { type: "allMids" },
      }));
      this.sockets.push(socket);
    }
  }

  async listen(messageHandler: (payload: Record<string, unknown>) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
    await this.subscribe();
    await Promise.all([...this.byDex.entries()].map(([dex, instruments], index) => this.listenSocket(
      this.sockets[index],
      instruments,
      messageHandler,
      signal,
    )));
  }

  private async listenSocket(
    socket: WebSocket | undefined,
    instruments: HyperliquidInstrument[],
    messageHandler: (payload: Record<string, unknown>) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!socket) return;
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("message", onMessage);
        socket.off("error", onError);
        socket.off("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        void this.close().finally(() => {
          cleanup();
          resolve();
        });
      };
      const onMessage = (rawMessage: WebSocket.RawData) => {
        void (async () => {
          const message = JSON.parse(rawMessage.toString()) as Record<string, unknown>;
          if (message.channel !== "allMids") return;
          const data = message.data && typeof message.data === "object" && !Array.isArray(message.data)
            ? message.data as Record<string, unknown>
            : {};
          const mids = data.mids && typeof data.mids === "object" && !Array.isArray(data.mids)
            ? data.mids as Record<string, unknown>
            : {};
          for (const instrument of instruments) {
            const price = midForInstrument(mids, instrument);
            if (price !== null) await messageHandler(normalizeMidPayload(price, instrument));
          }
        })().catch(onError);
      };
      socket.on("message", onMessage);
      socket.once("error", onError);
      socket.once("close", onClose);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async close(): Promise<void> {
    const sockets = this.sockets;
    this.sockets = [];
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  }
}

function midForInstrument(mids: Record<string, unknown>, instrument: HyperliquidInstrument): number | null {
  const candidates = [
    instrument.symbol,
    normalizeSymbol(instrument.symbol),
    instrument.symbol.includes(":") ? instrument.symbol.split(":", 2)[1] : instrument.symbol,
  ];
  for (const key of candidates) {
    const value = asFloat(mids[key]);
    if (value !== null) return value;
  }
  return null;
}
