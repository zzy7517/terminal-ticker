export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

export interface AgentSession {
  id: string;
  instrumentKey: string;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
}

export interface AgentMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  analysis: AgentAnalysis | null;
  error: string | null;
}

export interface AgentSessionResponse {
  session: AgentSession | null;
  messages: AgentMessage[];
}

export interface StrategySignal {
  available: boolean;
  side: 'long' | 'short' | 'flat';
  regime: 'trend' | 'range' | 'high_vol' | 'low_vol' | 'transition' | 'unclear';
  confidence: number;
  reason: string;
  features: {
    closeReturn: number;
    rangeEfficiency: number;
    atrPercent: number;
    realizedVolatility: number;
    trendScore: number;
    positionInRange: number;
    volumeRatio: number;
    latestClose: number;
    recentHigh: number;
    recentLow: number;
  } | null;
}

export interface AgentConfig {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  timeoutSeconds: number;
  maxCandles: number;
  reasoningEffort: string;
}

export interface AgentConfigUpdate {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  timeoutSeconds: number;
  maxCandles: number;
  reasoningEffort: string;
}

export interface AnalysisConfigUpdate {
  enabled?: boolean;
  interval?: string;
  lookback?: number;
  pollIntervalSeconds?: number;
  staleAfterSeconds?: number;
}

export interface AgentModelOption {
  slug: string;
  displayName: string;
  description: string;
  visibility: string;
  supportedInApi: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  contextWindow: number | null;
  preferWebsockets: boolean;
}

export interface AgentModelsResponse {
  provider: string;
  apiMode: string;
  activeModel: string;
  models: AgentModelOption[];
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
  strategySignal: StrategySignal;
  candles: CandlePoint[];
  thumbnailCandles: CandlePoint[];
}

export interface Instrument {
  key: string;
  symbol: string;
  label: string;
  source: string;
  instType: string | null;
  group: string;
  analysisInterval: string;
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
    agent: AgentConfig;
    display: {
      refreshIntervalMs: number;
      staleAfterSeconds: number;
      stockPollIntervalSeconds: number;
      longbridgePollIntervalSeconds: number;
    };
    sourcePath: string | null;
  };
  instruments: Instrument[];
  groups: Record<string, string[]>;
  quotes: Record<string, Quote>;
  agentAnalyses: Record<string, AgentAnalysis>;
}

export interface InstrumentSearchResult {
  source: string;
  symbol: string;
  label: string;
  instType: string | null;
  key: string;
  nameCn: string;
  nameHk: string;
  nameEn: string;
  displayText: string;
  exists: boolean;
}

export type SecuritySearchResult = InstrumentSearchResult;
