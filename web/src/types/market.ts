/** 行情快照、观察列表、交易、新闻与 Jin10 DTO。 */
import type { AgentResponse } from './agent';
import type { AgentConfig, ProxyConfigPayload } from './config';

export interface Quote {
  symbol: string;
  displayName: string;
  price: number | null;
  priceLabel: string;
  change: number | null;
  changePercent: number | null;
  changeLabel: string;
  percentLabel: string;
  previousClose: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  volumeLabel: string;
  currency: string;
  exchange: string;
  status: string;
  ageLabel: string;
  stale: boolean;
  lastError: string | null;
  updateCount: number;
}

export interface Instrument {
  key: string;
  symbol: string;
  label: string;
  source: string;
  instType: string | null;
  group: string;
  analysisInterval: string;
  /** Whether the instrument supports agent analysis (candles, multi-timeframe). False for quote-only sources like Jin10. */
  analysable: boolean;
}

export interface NewsItem {
  url: string;
  source: string;
  title: string;
  summary: string;
  publishedAt: string;
  publishedAtMs: number;
  fetchedAtMs: number;
  keywords: string[];
}

export interface NewsStatus {
  enabled: boolean;
  lastStatus?: string;
  lastError?: string | null;
  lastFetchedAtMs?: number | null;
}

// ── Jin10 types ──────────────────────────────────────────────────────────────

export interface Jin10CalendarEvent {
  pubTime: string;
  star: number;
  title: string;
  country?: string;
  previous: string;
  consensus: string;
  actual: string;
  revised: string;
  affectTxt: string;
}

export interface Jin10Quote {
  code: string;
  name: string;
  time: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  change: number;
  changePercent: number;
}

export interface Jin10Status {
  available: boolean;
  connected: boolean;
  enabled: boolean;
  tokenConfigured: boolean;
  flash: {
    enabled: boolean;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    itemCount: number;
  };
  calendar: {
    enabled: boolean;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    eventCount: number;
  };
  quotes: {
    enabled: boolean;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    codes: string[];
  };
}

export interface Jin10StatePayload {
  status: Jin10Status;
  calendar: Jin10CalendarEvent[];
  quotes: Jin10Quote[];
}

export interface Jin10ConfigPayload {
  enabled: boolean;
  tokenConfigured: boolean;
  flashEnabled: boolean;
  calendarEnabled: boolean;
  quotesEnabled: boolean;
  quotesCodes: string[];
}

// ── Options / GEX wire payload (from AppRuntime state.options) ────────────────

export interface OptionsStrikeGex {
  strike: number;
  callGex: number;
  putGex: number;
  netGex: number;
  callOi: number;
  putOi: number;
}

export interface OptionsRegimeParams {
  atmIV: number;
  regime: 'calm' | 'normal' | 'stressed' | 'crisis';
  impliedSpotVolCorr: number;
  impliedVolOfVol: number;
  expectedDailySpotMove: number;
}

export interface OptionsHedgeImpulse {
  regime: 'pinned' | 'expansion' | 'squeeze-up' | 'squeeze-down' | 'neutral';
  impulseAtSpot: number;
  nearestAttractorAbove: number | null;
  nearestAttractorBelow: number | null;
  asymmetry: {
    upside: number;
    downside: number;
    bias: 'up' | 'down' | 'neutral';
    asymmetryRatio: number;
  };
  curve: Array<{ price: number; impulse: number }>;
}

export interface OptionsPressureZone {
  center: number;
  lower: number;
  upper: number;
  strength: number;
  side: 'above-spot' | 'below-spot';
  tradeType: 'long' | 'short';
  hedgeType: 'passive' | 'aggressive';
}

export interface OptionsPressureCloud {
  stabilityZones: OptionsPressureZone[];
  accelerationZones: OptionsPressureZone[];
  regimeEdges: Array<{ price: number; transitionType: string }>;
}

export interface OptionsIvSurface {
  expiration: string;
  strikes: number[];
  smoothedIVs: number[];
}

export interface OptionsExposureRow {
  expiration: string;
  tte: number;
  totalGammaExposure: number;
  totalDeltaExposure: number;
  totalVannaExposure: number;
  totalCharmExposure: number;
}

/** Flattened GEX snapshot as broadcast on the market websocket state. */
export interface OptionsSnapshot {
  symbol: string;
  spotPrice: number;
  netGexBillions: number;
  regime: 'long_gamma' | 'short_gamma' | 'neutral';
  regimeDescription: string;
  zeroGammaLevel: number;
  callWall: number;
  putWall: number;
  maxGammaStrike: number;
  dominantStrike: number;
  charmFlow: number | null;
  vannaFlow: number | null;
  gexByStrike: OptionsStrikeGex[];
  provider: string;
  timestamp: number;
  regimeParams: OptionsRegimeParams | null;
  ivSurface: OptionsIvSurface | null;
  hedgeImpulse: OptionsHedgeImpulse | null;
  pressureCloud: OptionsPressureCloud | null;
  exposure: OptionsExposureRow[] | null;
}

export interface OptionsStatePayload {
  snapshots: Record<string, OptionsSnapshot>;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface MarketState {
  type: 'state';
  updatedAt: string;
  streamStatus: string;
  config: {
    analysis: {
      enabled: boolean;
      interval: string;
      lookback: number;
      pollIntervalSeconds: number;
      staleAfterSeconds: number;
    };
    agent: AgentConfig;
    display: {
      refreshIntervalMs: number;
      staleAfterSeconds: number;
      stockPollIntervalSeconds: number;
    };
    news: {
      enabled: boolean;
      pollIntervalSeconds: number;
      maxIntervalSeconds: number;
      recentLimit: number;
      reutersUrl: string;
      forexfactoryEnabled: boolean;
      requestTimeoutSeconds: number;
      retentionDays: number;
    };
    trading: {
      bitgetMode: "off" | "demo" | "live";
    };
    mcp: {
      enabled: boolean;
      configPath: string | null;
    };
    jin10: Jin10ConfigPayload;
    options: {
      enabled: boolean;
      provider: 'yfinance' | 'tradier' | 'deribit' | 'marketdata';
      symbols: string[];
      pollIntervalSeconds: number;
      strikeRangePercent: number;
      tradier?: {
        apiKeyConfigured: boolean;
        baseUrl: string;
      };
      marketdata?: {
        apiKeyConfigured: boolean;
        baseUrl: string;
        strikeLimit: number | null;
        dte: number | null;
        callsPerMinute: number | null;
      };
      deribit?: {
        enabled: boolean;
        currencies: string[];
      };
    };
    proxy: ProxyConfigPayload;
    sourcePath: string | null;
  };
  instruments: Instrument[];
  groups: Record<string, string[]>;
  quotes: Record<string, Quote>;
  agentAnalyses: Record<string, AgentResponse>;
  openTrades: Trade[];
  exchangePositions: ExchangePosition[];
  exchangeOrders: ExchangeOrder[];
  recentNews: NewsItem[];
  newsStatus: NewsStatus;
  jin10: Jin10StatePayload | null;
  /** Null when the options service is disabled. */
  options: OptionsStatePayload | null;
}

export type TradeDirection = 'long' | 'short';
export type TradeStatus = 'planned' | 'open' | 'closed' | 'cancelled';
export type FillKind = 'entry' | 'exit' | 'stop' | 'target';

export interface TradeFill {
  id: number;
  tradeId: number;
  kind: FillKind;
  price: number;
  quantity: number;
  filledAtMs: number;
  triggerReason: string;
  fillSource: string;
  fees: number;
  externalOrderId: string | null;
}

export interface Trade {
  id: number;
  instrumentKey: string;
  direction: TradeDirection;
  status: TradeStatus;
  size: number;
  intentPrice: number | null;
  stopPrice: number | null;
  targetPrices: number[];
  openedAtMs: number | null;
  closedAtMs: number | null;
  realizedPnl: number;
  reasoningText: string;
  sessionId: string | null;
  snapshotId: number | null;
  marketKind: string;
  fillSource: string;
  externalOrderId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  fills: TradeFill[];
}

export interface TradeSnapshot {
  id: number;
  instrumentKey: string;
  capturedAtMs: number;
  payload: Record<string, unknown>;
}

export interface Lesson {
  id: number;
  tradeId: number | null;
  instrumentKey: string;
  createdAtMs: number;
  category: string;
  text: string;
  tags: string[];
}

export interface TradeDetailResponse {
  trade: Trade;
  snapshot: TradeSnapshot | null;
  lessons: Lesson[];
}

export interface InstrumentSearchResult {
  source: string;
  symbol: string;
  label: string;
  instType: string | null;
  group?: string | null;
  key: string;
  displayText: string;
  exists: boolean;
}

export type InstrumentCatalogItem = InstrumentSearchResult;

export interface InstrumentCatalogResponse {
  loadedAt: string | null;
  errors: Record<string, string>;
  items: InstrumentCatalogItem[];
}

export interface ExchangePosition {
  exchange: string;
  symbol: string;
  instrumentKey: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number | null;
  margin: number | null;
  liquidationPrice: number | null;
}

export interface ExchangeOrder {
  exchange: string;
  symbol: string;
  instrumentKey: string;
  orderId: string;
  side: string;
  orderType: string;
  size: number;
  price: number | null;
  filledSize: number;
  status: string;
  createdAtMs: number;
}
