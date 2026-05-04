export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface LoopToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LoopToolResult {
  callId: string;
  name: string;
  output: string;
  error: boolean;
}

export interface LoopStep {
  stepType: 'tool_call' | 'tool_result' | 'assistant';
  timestamp: number;
  toolCall?: LoopToolCall;
  toolResult?: LoopToolResult;
  content?: string;
}

export interface LoopResult {
  content: string;
  steps: LoopStep[];
  iterations: number;
  totalTokens: number;
  finished: boolean;
  error: string | null;
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
  loopResult?: LoopResult;
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

export interface AgentConfig {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  timeoutSeconds: number;
  maxCandles: number;
  reasoningEffort: string;
  maxIterations: number;
  useTools: boolean;
}

export interface AgentConfigUpdate {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  timeoutSeconds: number;
  maxCandles: number;
  reasoningEffort: string;
  maxIterations: number;
  useTools: boolean;
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
  multiTimeframeIntervals: string[];
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
      recentLimit: number;
      reutersUrl: string;
    };
    sourcePath: string | null;
  };
  instruments: Instrument[];
  groups: Record<string, string[]>;
  quotes: Record<string, Quote>;
  agentAnalyses: Record<string, AgentAnalysis>;
  openTrades: Trade[];
  recentNews: NewsItem[];
  newsStatus: NewsStatus;
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
  key: string;
  nameCn: string;
  nameHk: string;
  nameEn: string;
  displayText: string;
  exists: boolean;
}

export type SecuritySearchResult = InstrumentSearchResult;
