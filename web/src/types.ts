export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PriceAction {
  label: string;
  bias: Bias;
  marker: string;
  reason: string;
  strength: number;
  updatedAt: string;
  error: string | null;
  available: boolean;
  stale: boolean;
}

export interface AgentAnalysis {
  available: boolean;
  provider: string;
  model: string;
  updatedAt: string;
  summary: string;
  bias: 'bullish' | 'bearish' | 'neutral' | 'mixed';
  confidence: number;
  keyLevels: Array<{
    label: string;
    price: number | null;
    reason: string;
  }>;
  watchPlan: string[];
  invalidation: string;
  riskNotes: string[];
  error: string | null;
  rawText: string | null;
}

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
  priceAction: PriceAction | null;
  candles: CandlePoint[];
}

export interface Instrument {
  key: string;
  symbol: string;
  label: string;
  source: string;
  group: string;
}

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
    agent: {
      enabled: boolean;
      provider: string;
      model: string;
      maxCandles: number;
      reasoningEffort: string;
    };
    display: {
      refreshIntervalMs: number;
      staleAfterSeconds: number;
      longbridgePollIntervalSeconds: number;
    };
    sourcePath: string | null;
  };
  instruments: Instrument[];
  groups: Record<string, string[]>;
  quotes: Record<string, Quote>;
  agentAnalyses: Record<string, AgentAnalysis>;
}

export interface SecuritySearchResult {
  symbol: string;
  label: string;
  nameCn: string;
  nameHk: string;
  nameEn: string;
  displayText: string;
  exists: boolean;
}
