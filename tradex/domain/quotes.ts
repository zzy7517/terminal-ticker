import { Candle } from "./price-action.js";

function toFloat(rawValue: unknown): number | null {
  if (rawValue === null || rawValue === undefined || rawValue === "") return null;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : null;
}

function toInt(rawValue: unknown): number | null {
  if (rawValue === null || rawValue === undefined || rawValue === "") return null;
  const parsed = Number.parseInt(String(rawValue), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function coalesce<T>(newValue: T | null | undefined, oldValue: T | null): T | null {
  return newValue === null || newValue === undefined ? oldValue : newValue;
}

function compactNumber(value: number | null): string {
  if (value === null) return "-";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function formatSigned(value: number | null, suffix = ""): string {
  if (value === null) return "-";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}${suffix}`;
}

function statusLabel(rawMarketHours: unknown): string {
  const marketHours = toInt(rawMarketHours);
  if (marketHours === 0) return "pre";
  if (marketHours === 1) return "open";
  if (marketHours === 2) return "post";
  return "live";
}

function ageLabel(lastUpdateAt: Date | null, now = new Date()): string {
  if (lastUpdateAt === null) return "waiting";
  const elapsedMs = Math.max(0, now.getTime() - lastUpdateAt.getTime());
  if (elapsedMs < 1000) return `${elapsedMs}ms`;
  if (elapsedMs < 10_000) return `${(elapsedMs / 1000).toFixed(1)}s`;
  const elapsed = Math.floor(elapsedMs / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

export interface QuotePayload {
  [key: string]: unknown;
}

export class QuoteState {
  symbol: string;
  displayName: string;
  price: number | null = null;
  change: number | null = null;
  changePercent: number | null = null;
  previousClose: number | null = null;
  dayHigh: number | null = null;
  dayLow: number | null = null;
  volume: number | null = null;
  currency = "";
  exchange = "";
  status = "waiting";
  lastTradeEpoch: number | null = null;
  lastUpdateAt: Date | null = null;
  updateCount = 0;
  lastError: string | null = null;
  candles: Candle[] = [];
  multiTimeframeCandles: Record<string, Candle[]> = {};

  constructor(symbol: string, displayName = symbol) {
    this.symbol = symbol;
    this.displayName = displayName;
  }

  static placeholder(symbol: string): QuoteState {
    return new QuoteState(symbol, symbol);
  }

  applyPayload(payload: QuotePayload): void {
    this.displayName = String(payload.short_name || this.displayName || this.symbol);
    this.price = coalesce(toFloat(payload.price), this.price);
    this.change = toFloat(payload.change);
    this.changePercent = toFloat(payload.change_percent);
    this.previousClose = coalesce(toFloat(payload.previous_close), this.previousClose);
    this.dayHigh = coalesce(toFloat(payload.day_high), this.dayHigh);
    this.dayLow = coalesce(toFloat(payload.day_low), this.dayLow);
    this.volume = coalesce(toFloat(payload.day_volume), this.volume);
    this.currency = String(payload.currency || this.currency || "");
    this.exchange = String(payload.exchange || this.exchange || "");
    this.status =
      typeof payload.status === "string" && payload.status
        ? payload.status.toLowerCase()
        : statusLabel(payload.market_hours);
    this.lastTradeEpoch = coalesce(toInt(payload.time || payload.ts), this.lastTradeEpoch);
    this.lastUpdateAt = new Date();
    this.updateCount += 1;
    this.lastError = null;
  }

  applySnapshot(payload: QuotePayload): void {
    this.displayName = String(payload.display_name || this.displayName || this.symbol);
    this.price = coalesce(toFloat(payload.price), this.price);
    this.change = toFloat(payload.change);
    this.changePercent = toFloat(payload.change_percent);
    this.previousClose = coalesce(toFloat(payload.previous_close), this.previousClose);
    this.dayHigh = coalesce(toFloat(payload.day_high), this.dayHigh);
    this.dayLow = coalesce(toFloat(payload.day_low), this.dayLow);
    this.volume = coalesce(toFloat(payload.volume), this.volume);
    this.currency = String(payload.currency || this.currency || "");
    this.exchange = String(payload.exchange || this.exchange || "");
    this.status = this.status === "waiting" ? "snap" : this.status;
    this.lastUpdateAt = new Date();
    this.updateCount += 1;
    this.lastError = null;
  }

  markError(detail: string): void {
    this.lastError = detail;
  }

  applyCandles(input: { candles?: Candle[]; multiTimeframeCandles?: Record<string, Candle[]> }): void {
    this.candles = input.candles ?? [];
    if (input.multiTimeframeCandles !== undefined) {
      this.multiTimeframeCandles = { ...input.multiTimeframeCandles };
    }
  }

  isStale(staleAfterSeconds: number, now = new Date()): boolean {
    if (this.lastUpdateAt === null) return true;
    return (now.getTime() - this.lastUpdateAt.getTime()) / 1000 > staleAfterSeconds;
  }

  priceLabel(): string {
    return this.price === null ? "-" : this.price.toFixed(2);
  }

  changeLabel(): string {
    return formatSigned(this.change);
  }

  percentLabel(): string {
    return formatSigned(this.changePercent, "%");
  }

  volumeLabel(): string {
    return compactNumber(this.volume);
  }

  ageLabel(now = new Date()): string {
    return ageLabel(this.lastUpdateAt, now);
  }
}
