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
  stepType: 'tool_call' | 'tool_result';
  timestamp: number;
  toolCall?: LoopToolCall;
  toolResult?: LoopToolResult;
}

export interface LoopResult {
  content: string;
  steps: LoopStep[];
  messages: Array<{
    role: string;
    content: string;
    metadata: Record<string, unknown> | null;
    error: string | null;
  }>;
  iterations: number;
  totalTokens: number;
  promptTokens?: number;
  finished: boolean;
  error: string | null;
}

export interface AgentResponse {
  available: boolean;
  provider: string;
  model: string;
  updatedAt: string;
  content: string;
  error: string | null;
  loopResult: LoopResult | null;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentMessageMetadata {
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  toolName?: string;
  error?: boolean;
  [key: string]: unknown;
}

export interface AgentSession {
  id: string;
  instrumentKey: string | null;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  apiMode: string | null;
  reasoningEffort: string | null;
}

export interface AgentSessionRun {
  sessionId: string;
  runId: string | null;
  status: 'idle' | 'running' | 'error';
  activeFlags: string[];
  lastSeq: number;
  error: string | null;
}

export interface AgentContextUsage {
  promptTokens: number;
  totalTokens: number;
}

export interface AgentSessionSummary extends AgentSession {
  messageCount: number;
  preview: string;
  contextUsage?: AgentContextUsage | null;
  run?: AgentSessionRun;
}

export interface AgentMessage {
  id: number;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'toolResult';
  content: string;
  createdAt: string;
  metadata: AgentMessageMetadata | null;
  error: string | null;
}

export interface AgentSessionResponse {
  session: AgentSession | null;
  messages: AgentMessage[];
  contextUsage?: AgentContextUsage | null;
  run?: AgentSessionRun;
}

export interface AgentSessionHistoryResponse {
  sessions: AgentSessionSummary[];
  preloadedSessions?: AgentSessionResponse[];
}

export interface AgentSessionMutationResponse {
  session: AgentSessionResponse;
  history: AgentSessionHistoryResponse;
  state: MarketState;
}

export type AgentStreamPayload =
  | { type: 'agent_start' }
  | { type: 'turn_start'; iteration: number }
  | { type: 'turn_end'; iteration: number }
  | { type: 'message_start' | 'message_update' | 'message_end'; message: Partial<AgentMessage> & { clientId?: string; role: AgentMessage['role']; content: string; metadata?: AgentMessageMetadata | null; error?: string | null }; delta?: string }
  | { type: 'tool_execution_start'; toolCall: AgentToolCall }
  | { type: 'tool_execution_end'; toolCall: AgentToolCall; toolResult: LoopToolResult }
  | { type: 'agent_end'; error: string | null; totalTokens?: number; promptTokens?: number }
  | { type: 'error'; error: string }
  | { type: 'session_update'; session: AgentSessionResponse; history: AgentSessionHistoryResponse; state: MarketState };

export interface AgentStreamEvent {
  sessionId: string;
  runId: string;
  seq: number;
  event: AgentStreamPayload;
}

export interface ProviderProfileState {
  enabled: boolean;
  models: string[];
  modelEfforts: Record<string, string>;
}

export interface AgentConfig {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  maxCandles: number;
  reasoningEffort: string;
  providerProfiles: Record<string, ProviderProfileState>;
}

export interface AgentConfigUpdate {
  enabled: boolean;
  maxCandles: number;
}

export interface ProviderProfileUpdate {
  enabled?: boolean;
  models?: string[];
  toggleModel?: string;
  modelEffort?: { model: string; effort: string };
  reasoningEffort?: string;
}

export interface AnalysisConfigUpdate {
  enabled?: boolean;
  interval?: string;
  lookback?: number;
  pollIntervalSeconds?: number;
  staleAfterSeconds?: number;
}

export interface NewsConfigUpdate {
  enabled?: boolean;
  pollIntervalSeconds?: number;
  maxIntervalSeconds?: number;
  reutersUrl?: string;
  requestTimeoutSeconds?: number;
  retentionDays?: number;
  recentLimit?: number;
}

export interface SocialFeedConfig {
  enabled: boolean;
  recentLimit: number;
  retentionDays: number;
  maxItems: number;
}

export interface SocialFeedConfigUpdate {
  enabled?: boolean;
  recentLimit?: number;
  retentionDays?: number;
  maxItems?: number;
}

export interface SocialAuthStatus {
  hasSavedAuth: boolean;
  savedAtMs: number | null;
  envAvailable: boolean;
}

export interface SocialFeedItem {
  source: string;
  externalId: string;
  url: string;
  author: {
    id: string;
    name: string;
    handle: string;
    profileImageUrl: string;
    verified: boolean;
  };
  text: string;
  createdAt: string;
  createdAtMs: number;
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
      maxIntervalSeconds: number;
      recentLimit: number;
      reutersUrl: string;
      requestTimeoutSeconds: number;
      retentionDays: number;
    };
    socialFeed: SocialFeedConfig;
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
  category?: string | null;
  dex?: string | null;
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
