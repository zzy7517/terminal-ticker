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
  title: string;
  provider: string | null;
  model: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  apiMode: string | null;
  reasoningEffort: string | null;
  agentId: string;
  agentName: string;
  runtime: 'pi' | 'claude-code';
  capabilities: AgentRuntimeStatus['capabilities'];
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string | null;
  runtime: 'pi' | 'claude-code';
  provider: string | null;
  model: string | null;
  reasoningEffort: string | null;
  builtIn: boolean;
}

export type AgentDefinitionInput = Omit<AgentDefinition, 'builtIn'>;

export interface AgentRuntimeStatus {
  id: 'pi' | 'claude-code';
  available: boolean;
  executablePath?: string;
  version: string | null;
  error: string | null;
  capabilities: {
    streaming: boolean;
    abort: boolean;
    steer: boolean;
    resume: boolean;
    forkFromMessage: boolean;
    cloneFromMessage: boolean;
    imageInput: boolean;
  };
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
  promptTokens?: number;
  totalTokens?: number;
  /** Estimated context tokens from last assistant response, or null if unknown. */
  tokens?: number | null;
  contextWindow?: number | null;
  percent?: number | null;
}

/**
 * Cumulative session token and cost statistics.
 */
export interface AgentSessionStats {
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

export interface AgentSessionSummary extends AgentSession {
  messageCount: number;
  preview: string;
  contextUsage?: AgentContextUsage | null;
  sessionStats?: AgentSessionStats | null;
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

/**
 * A steering message that has been sent to a running agent but not yet
 * confirmed (injected into the transcript) by the backend. These are rendered
 * in a fixed pending region below the transcript — never spliced into the
 * `messages` array — so their position stays stable while the agent streams.
 */
export interface QueuedSteeringMessage {
  /** Stable client-side id for React keys. */
  id: string;
  content: string;
  createdAt: string;
}

export interface AgentSessionResponse {
  session: AgentSession | null;
  messages: AgentMessage[];
  contextUsage?: AgentContextUsage | null;
  sessionStats?: AgentSessionStats | null;
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
  | { type: 'agent_end'; error: string | null; totalTokens?: number; promptTokens?: number; sessionStats?: AgentSessionStats | null }
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
  api: string;
  displayName: string;
  requiresAuth: boolean;
  models: string[];
  modelEfforts: Record<string, string>;
  baseUrl?: string;
  apiKeyConfigured?: boolean;
  apiKeyFromEnv?: boolean;
  customModels?: string[];
  customModelDefinitions?: CustomModelDefinition[];
}

export interface CustomModelDefinition {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  contextWindow: number;
  maxTokens: number;
}

export interface AgentConfig {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  systemPrompt: string;
  maxCandles: number;
  candleContextMode: "raw" | "with_indicators";
  reasoningEffort: string;
  providerProfiles: Record<string, ProviderProfileState>;
}

export interface AgentConfigUpdate {
  enabled: boolean;
  systemPrompt: string;
  maxCandles: number;
  candleContextMode: "raw" | "with_indicators";
}

export interface ProviderProfileUpdate {
  enabled?: boolean;
  api?: string;
  displayName?: string;
  requiresAuth?: boolean;
  models?: string[];
  toggleModel?: string;
  modelEffort?: { model: string; effort: string };
  reasoningEffort?: string;
  apiKey?: string;
  baseUrl?: string;
  clearApiKey?: boolean;
  addCustomModel?: string;
  removeCustomModel?: string;
  customModelDefinitions?: CustomModelDefinition[];
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

export interface MemoryConfig {
  enabled: boolean;
  useMemories: boolean;
  generateMemories: boolean;
  disableOnExternalContext: boolean;
  storagePath: string | null;
  extractModel: string | null;
  consolidationModel: string | null;
  maxRawMemories: number;
  maxUnusedDays: number;
  maxSourceAgeDays: number;
  maxRolloutsPerStartup: number;
  minSessionIdleHours: number;
  extensionRetentionDays: number;
}

export interface MemoryConfigUpdate {
  enabled?: boolean;
  useMemories?: boolean;
  generateMemories?: boolean;
  disableOnExternalContext?: boolean;
  storagePath?: string | null;
  extractModel?: string | null;
  consolidationModel?: string | null;
  maxRawMemories?: number;
  maxUnusedDays?: number;
  maxSourceAgeDays?: number;
  maxRolloutsPerStartup?: number;
  minSessionIdleHours?: number;
  extensionRetentionDays?: number;
}

export interface MemoryStatus {
  enabled: boolean;
  pipelineAvailable: boolean;
  pipelineRunning: boolean;
  sourceCount: number;
  outputCount: number;
  phase2Status: string;
  config: MemoryConfig;
}

export interface MemoryEntry {
  path: string;
  entryType: 'file' | 'directory';
}

export interface MemoryBrowseListResult {
  path: string | null;
  entries: MemoryEntry[];
  nextCursor: string | null;
  truncated: boolean;
}

export interface MemoryBrowseReadResult {
  path: string;
  startLineNumber: number;
  content: string;
  truncated: boolean;
}

export interface MemorySearchMatch {
  path: string;
  matchLineNumber: number;
  contentStartLineNumber: number;
  content: string;
  matchedQueries: string[];
}

export interface MemoryBrowseSearchResult {
  queries: string[];
  matches: MemorySearchMatch[];
  nextCursor: string | null;
  truncated: boolean;
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

export type ProxyType = 'http' | 'https' | 'socks5';

export interface ProxyConfigPayload {
  enabled: boolean;
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  passwordConfigured: boolean;
}

export interface ProxyConfigUpdate {
  enabled?: boolean;
  type?: ProxyType;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  clearPassword?: boolean;
}

export interface ProxyTestResult {
  ok: boolean;
  url?: string | null;
  status?: number;
  latencyMs?: number;
  error?: string;
}

export interface SocialAuthStatus {
  hasSavedAuth: boolean;
  savedAtMs: number | null;
  envAvailable: boolean;
  configured?: boolean;
  path?: string;
  error?: string | null;
}

export interface SocialAuthImportResult {
  ok: boolean;
  status: SocialAuthStatus;
  error: string | null;
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
  custom?: boolean;
}

export interface AgentModelsResponse {
  provider: string;
  apiMode: string;
  activeModel: string;
  models: AgentModelOption[];
}

export interface AgentModelRegistryProvider {
  providerId: string;
  configProviderId: string;
  name: string;
  enabled: boolean;
  api: string;
  requiresAuth: boolean;
  baseUrlConfigured: boolean;
  authConfigured: boolean;
  discoverable: boolean;
  runnable: boolean;
}

export interface AgentModelRegistryModel {
  providerId: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  selected: boolean;
  source: 'pi' | 'custom' | 'legacy';
  runnable: boolean;
}

export interface AgentModelRegistry {
  generation: number;
  providers: AgentModelRegistryProvider[];
  models: AgentModelRegistryModel[];
}

export interface AgentModelRegistryResolveResponse {
  generation: number;
  model: AgentModelRegistryModel;
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
      requestTimeoutSeconds: number;
      retentionDays: number;
    };
    memory: MemoryConfig;
    socialFeed: SocialFeedConfig;
    trading: {
      hyperliquidMode: "off" | "demo" | "live";
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

// ── Cron Jobs ─────────────────────────────────────────────────────────────

export interface CronJobStatus {
  name: string;
  cron: string;
  enabled: boolean;
  running: boolean;
  nextRun: string | null;
  lastRunAt: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastError: string | null;
  systemPrompt: string;
  useMainPrompt: boolean;
  model: string | null;
  userMessage: string;
  maxIterations: number | null;
  maxCandles: number | null;
  tradingEnabled: boolean;
  socialEnabled: boolean;
  timezone: string | null;
}

export interface CronRunRecord {
  jobName: string;
  sessionId: string;
  filePath: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'ok' | 'error';
  error: string | null;
  preview: string;
}

export interface CronSessionEntry {
  type: string;
  id?: string;
  timestamp?: string;
  role?: string;
  content?: string;
  metadata?: Record<string, unknown> | null;
  error?: string | null;
  customType?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CronJobCreate {
  name: string;
  cron: string;
  systemPrompt?: string;
  useMainPrompt?: boolean;
  userMessage?: string;
  model?: string | null;
  symbols?: string[];
  enabled?: boolean;
  maxIterations?: number | null;
  maxCandles?: number | null;
  tradingEnabled?: boolean;
  socialEnabled?: boolean;
  timezone?: string | null;
}

export interface CronJobUpdate {
  name?: string;
  cron?: string;
  systemPrompt?: string;
  useMainPrompt?: boolean;
  userMessage?: string;
  model?: string | null;
  symbols?: string[];
  enabled?: boolean;
  maxIterations?: number | null;
  maxCandles?: number | null;
  tradingEnabled?: boolean;
  socialEnabled?: boolean;
  timezone?: string | null;
}

export interface CronStoragePaths {
  config: string;
  sessions: string;
}

export interface CronJobsResponse {
  jobs: CronJobStatus[];
  storagePaths: CronStoragePaths;
}

// ── MCP Types ────────────────────────────────────────────────────────────────

export type McpServerStatus = 'idle' | 'connecting' | 'connected' | 'failed';

export interface McpServerInfo {
  name: string;
  status: McpServerStatus;
  type: 'stdio' | 'http';
  toolCount: number;
  command: string | null;
  url: string | null;
  args: string[];
  env: string[];
  cwd: string | null;
  idleTimeout: number | null;
}

export interface McpSettings {
  toolPrefix?: 'server' | 'none' | 'short';
  idleTimeout?: number;
}

export interface McpStatusResponse {
  enabled: boolean;
  configured: boolean;
  servers: McpServerInfo[];
  settings: McpSettings | null;
}

export interface McpToolInfo {
  name: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerToolsResponse {
  server: string;
  status: McpServerStatus;
  tools: McpToolInfo[];
}

export interface McpResourceInfo {
  server?: string;
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpResourceTemplateInfo {
  server?: string;
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface McpServerResourcesResponse {
  server: string;
  status: McpServerStatus;
  resources: McpResourceInfo[];
  nextCursor: string | null;
}

export interface McpAllResourcesResponse {
  resources: McpResourceInfo[];
  errors: { serverName: string; error: string }[];
}

export interface McpServerResourceTemplatesResponse {
  server: string;
  status: McpServerStatus;
  resourceTemplates: McpResourceTemplateInfo[];
  nextCursor: string | null;
}

export interface McpAllResourceTemplatesResponse {
  resourceTemplates: McpResourceTemplateInfo[];
  errors: { serverName: string; error: string }[];
}

export interface McpReadResourceResponse {
  server: string;
  uri: string;
  contents: McpResourceContent[];
}

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  idleTimeout?: number;
}
