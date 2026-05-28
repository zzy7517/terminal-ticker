/**
 * Data feed abstraction types.
 */

export interface DataFeed<T> {
  readonly name: string;
  readonly pollIntervalMs: number;
  start(): Promise<void>;
  stop(): void;
  getLatest(): T | null;
  getHistory(n: number): T[];
  getLastError(): string | null;
  subscribe(cb: (data: T) => void): () => void;
}

export interface FearGreedData {
  value: number;
  classification: string; // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  timestamp: string;
}

export interface FundingSnapshot {
  instrumentKey: string;
  rate: number;          // e.g. 0.0001 = 0.01%
  nextFundingTime: string;
  timestamp: string;
}

export interface LongShortRatioData {
  instrumentKey: string;
  ratio: number;         // > 1 = more longs
  longPct: number;       // 0-100
  shortPct: number;      // 0-100
  timestamp: string;
}

export interface OIDeltaData {
  instrumentKey: string;
  oi: number;            // current OI in USD
  delta1h: number;       // change in last 1h
  delta4h: number;       // change in last 4h
  delta24h: number;      // change in last 24h
  timestamp: string;
}

export interface DXYData {
  value: number;         // DXY index approximation
  eurusd: number;        // underlying EURUSD rate
  timestamp: string;
}

export interface RegimeDataPack {
  vix: number | null;
  fearGreed: FearGreedData | null;
  funding: Map<string, FundingSnapshot>;
  longShortRatio: Map<string, LongShortRatioData>;
  oiDelta: Map<string, OIDeltaData>;
  dxy: DXYData | null;
}

export interface FeedStatus {
  name: string;
  lastFetchedAt: string | null;
  lastError: string | null;
  dataAge: number | null; // seconds since last update
}
