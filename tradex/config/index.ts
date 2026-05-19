import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CODEX_MODEL,
  normalizeApiMode,
  normalizeModel,
  normalizeProvider,
  normalizeReasoningEffort,
} from "./agent_models.js";

export const BITGET_SOURCE = "bitget";
export const HYPERLIQUID_SOURCE = "hyperliquid";
export const SUPPORTED_SOURCES = new Set([BITGET_SOURCE, HYPERLIQUID_SOURCE]);
export const SUPPORTED_INST_TYPES = new Set(["USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"]);
export const DEFAULT_REUTERS_URL = "https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml";
const DEPRECATED_REUTERS_URLS = new Set([
  "https://www.reuters.com/sitemap_news.xml",
  "http://www.reuters.com/sitemap_news.xml",
]);
const SUPPORTED_ANALYSIS_INTERVALS = new Set([
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1H",
  "4H",
  "6H",
  "12H",
  "1D",
  "3D",
  "1W",
  "1M",
]);
export const DEFAULT_GROUP = "other";
export const GROUP_ALIASES: Record<string, string> = {
  crypto: "crypto",
  cryptos: "crypto",
  coin: "crypto",
  coins: "crypto",
  stock: "stocks",
  stocks: "stocks",
  equity: "stocks",
  equities: "stocks",
  metal: "commodities",
  metals: "commodities",
  commodity: "commodities",
  commodities: "commodities",
  fx: "fx",
  forex: "fx",
  preipo: "preipo",
  pre_ipo: "preipo",
  index: "indices",
  indices: "indices",
  watch: "watchlist",
  watchlist: "watchlist",
  custom: "watchlist",
  other: DEFAULT_GROUP,
};

export interface DisplayConfig {
  refreshIntervalMs: number;
  staleAfterSeconds: number;
  reconnectDelaySeconds: number;
  stockPollIntervalSeconds: number;
}

export interface AnalysisConfig {
  enabled: boolean;
  interval: string;
  lookback: number;
  pollIntervalSeconds: number;
  staleAfterSeconds: number;
}

export interface CacheConfig {
  enabled: boolean;
  path: string | null;
  candleRetentionSeconds: number;
}

export interface ProviderProfile {
  enabled: boolean;
  models: string[];
  modelEfforts: Array<[string, string]>;
  apiKey: string;
  baseUrl: string;
  customModels: string[];
}

export type CandleContextMode = "raw" | "with_indicators";

export interface AgentConfig {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  maxCandles: number;
  candleContextMode: CandleContextMode;
  reasoningEffort: string;
  providerProfiles: Record<string, ProviderProfile>;
}

export interface MemoryConfig {
  enabled: boolean;
  useMemories: boolean;
  generateMemories: boolean;
  storagePath: string | null;
  extractModel: string | null;
  consolidationModel: string | null;
  maxRawMemoriesForConsolidation: number;
  maxUnusedDays: number;
  maxSourceAgeDays: number;
  maxRolloutsPerStartup: number;
  minSessionIdleHours: number;
  extensionRetentionDays: number;
}

export interface NewsConfig {
  enabled: boolean;
  pollIntervalSeconds: number;
  maxIntervalSeconds: number;
  reutersUrl: string;
  requestTimeoutSeconds: number;
  retentionDays: number;
  recentLimit: number;
}

export interface SocialFeedConfig {
  enabled: boolean;
  recentLimit: number;
  retentionDays: number;
  maxItems: number;
}

/** Per-exchange trading mode: off = no orders, demo = paper/simulated, live = real money */
export type ExchangeTradingMode = "off" | "demo" | "live";

export interface TradingConfig {
  hyperliquidMode: ExchangeTradingMode;
  bitgetMode: ExchangeTradingMode;
}

export interface InstrumentConfig {
  symbol: string;
  source: string;
  instType: string | null;
  label: string | null;
  showCollapsed: boolean;
  group: string;
  analysisInterval: string | null;
}

export interface CronJobConfig {
  name: string;
  cron: string;
  systemPrompt: string;
  enabled: boolean;
  symbols: string[];
  model: string | null;
  userMessage: string;
  maxIterations: number | null;
  maxCandles: number | null;
  tradingEnabled: boolean;
  socialEnabled: boolean;
  timezone: string | null;
}

export interface McpAppConfig {
  enabled: boolean;
  configPath: string | null;
}

export interface AppConfig {
  instruments: InstrumentConfig[];
  display: DisplayConfig;
  sourcePath: string | null;
  analysis: AnalysisConfig;
  cache: CacheConfig;
  agent: AgentConfig;
  memory: MemoryConfig;
  news: NewsConfig;
  socialFeed: SocialFeedConfig;
  trading: TradingConfig;
  mcp: McpAppConfig;
  cronJobs: CronJobConfig[];
}

export function expandUserPath(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function providerProfilesDefault(): Record<string, ProviderProfile> {
  return {
    [CODEX_PROVIDER]: {
      enabled: true,
      models: [DEFAULT_CODEX_MODEL],
      modelEfforts: [],
      apiKey: "",
      baseUrl: "",
      customModels: [],
    },
    [ANTHROPIC_PROVIDER]: {
      enabled: false,
      models: [DEFAULT_ANTHROPIC_MODEL],
      modelEfforts: [],
      apiKey: "",
      baseUrl: "",
      customModels: [],
    },
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be a table`);
  return value as Record<string, unknown>;
}

function normalizeSource(rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) return BITGET_SOURCE;
  if (typeof rawValue !== "string") throw new Error("source must be a string");
  const source = rawValue.trim().toLowerCase();
  if (!source) return BITGET_SOURCE;
  if (!SUPPORTED_SOURCES.has(source)) throw new Error(`source must be one of: ${[...SUPPORTED_SOURCES].sort().join(", ")}`);
  return source;
}

function normalizeInstType(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue !== "string") throw new Error("inst_type must be a string");
  const instType = rawValue.trim().toUpperCase();
  if (!instType) return null;
  if (!SUPPORTED_INST_TYPES.has(instType)) {
    throw new Error(`inst_type must be one of: ${[...SUPPORTED_INST_TYPES].sort().join(", ")}`);
  }
  return instType;
}

function normalizeLabel(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue !== "string") throw new Error("label must be a string");
  return rawValue.trim() || null;
}

function defaultGroup(source: string): string {
  return source === BITGET_SOURCE || source === HYPERLIQUID_SOURCE ? "crypto" : DEFAULT_GROUP;
}

function normalizeGroup(rawValue: unknown, source: string): string {
  if (rawValue === null || rawValue === undefined) return defaultGroup(source);
  if (typeof rawValue !== "string") throw new Error("group must be a string");
  const group = rawValue.trim().toLowerCase().replace(/[- ]/g, "_");
  if (!group) return defaultGroup(source);
  return GROUP_ALIASES[group] ?? group;
}

function normalizeBool(rawValue: unknown, fieldName: string, defaultValue: boolean): boolean {
  if (rawValue === null || rawValue === undefined) return defaultValue;
  if (typeof rawValue === "boolean") return rawValue;
  if (typeof rawValue === "string") {
    const normalized = rawValue.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  throw new Error(`${fieldName} must be a boolean`);
}

function normalizeAnalysisInterval(rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) return "5m";
  if (typeof rawValue !== "string") throw new Error("analysis.interval must be a string");
  const aliases: Record<string, string> = {
    "1min": "1m",
    "3min": "3m",
    "5min": "5m",
    "15min": "15m",
    "30min": "30m",
    "1h": "1H",
    "4h": "4H",
    "6h": "6H",
    "12h": "12H",
    "1d": "1D",
    "3d": "3D",
    "1w": "1W",
    "1month": "1M",
  };
  const value = rawValue.trim();
  const normalized = aliases[value.toLowerCase()] ?? value;
  if (!SUPPORTED_ANALYSIS_INTERVALS.has(normalized)) {
    throw new Error(`analysis.interval must be one of: ${[...SUPPORTED_ANALYSIS_INTERVALS].sort().join(", ")}`);
  }
  return normalized;
}

function normalizeOptionalAnalysisInterval(rawValue: unknown): string | null {
  if (rawValue === null || rawValue === undefined || rawValue === "") return null;
  return normalizeAnalysisInterval(rawValue);
}

export function normalizeSymbolForSource(symbol: string, source: string): string {
  const value = symbol.trim();
  if (!value) return "";
  if (source === HYPERLIQUID_SOURCE && value.includes(":")) {
    const [dex, coin] = value.split(":", 2);
    const normalizedDex = dex.trim().toLowerCase();
    const normalizedCoin = coin.trim().toUpperCase();
    return normalizedDex && normalizedCoin ? `${normalizedDex}:${normalizedCoin}` : "";
  }
  return value.toUpperCase();
}

function parseSymbolString(rawSymbol: string, source = BITGET_SOURCE): InstrumentConfig {
  const candidate = rawSymbol.trim();
  if (!candidate) throw new Error("symbol entries cannot be blank");
  let instType: string | null = null;
  let symbol = candidate;
  if (source === BITGET_SOURCE && candidate.includes(":")) {
    const [maybeInstType, maybeSymbol] = candidate.split(":", 2);
    const normalizedInstType = normalizeInstType(maybeInstType);
    if (normalizedInstType !== null) {
      instType = normalizedInstType;
      symbol = maybeSymbol;
    }
  }
  const normalizedSymbol = normalizeSymbolForSource(symbol, source);
  if (!normalizedSymbol) throw new Error("symbol entries cannot be blank");
  return {
    symbol: normalizedSymbol,
    source,
    instType,
    label: null,
    showCollapsed: true,
    group: defaultGroup(source),
    analysisInterval: null,
  };
}

function dedupeKey(instrument: InstrumentConfig): string {
  return `${instrument.source}\0${instrument.instType ?? ""}\0${instrument.symbol}`;
}

function normalizeInstruments(symbols: unknown[]): InstrumentConfig[] {
  const normalized: InstrumentConfig[] = [];
  const seen = new Set<string>();
  for (const rawSymbol of symbols) {
    let instrument: InstrumentConfig;
    if (typeof rawSymbol === "string") {
      instrument = parseSymbolString(rawSymbol);
    } else if (rawSymbol && typeof rawSymbol === "object" && !Array.isArray(rawSymbol)) {
      const entry = rawSymbol as Record<string, unknown>;
      const source = normalizeSource(entry.source);
      if (entry.symbol === null || entry.symbol === undefined) throw new Error("symbol entries cannot be blank");
      const parsed = parseSymbolString(String(entry.symbol), source);
      instrument = {
        symbol: parsed.symbol,
        source,
        instType: source === BITGET_SOURCE ? normalizeInstType(entry.inst_type) : null,
        label: normalizeLabel(entry.label),
        showCollapsed: normalizeBool(entry.show_collapsed, "show_collapsed", true),
        group: normalizeGroup(entry.group, source),
        analysisInterval: normalizeOptionalAnalysisInterval(entry.analysis_interval ?? entry.interval),
      };
    } else {
      throw new Error("symbols entries must be strings or tables");
    }
    const key = dedupeKey(instrument);
    if (!seen.has(key)) {
      normalized.push(instrument);
      seen.add(key);
    }
  }
  if (normalized.length === 0) throw new Error("at least one symbol is required");
  return normalized;
}

function coerceInt(rawValue: unknown, fieldName: string, defaultValue: number): number {
  if (rawValue === null || rawValue === undefined) return defaultValue;
  let value: number;
  if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) throw new Error(`${fieldName} must be an integer`);
    value = Number.parseInt(trimmed, 10);
  } else if (typeof rawValue === "number") {
    if (!Number.isInteger(rawValue)) throw new Error(`${fieldName} must be an integer`);
    value = rawValue;
  } else {
    throw new Error(`${fieldName} must be an integer`);
  }
  if (value <= 0) throw new Error(`${fieldName} must be positive`);
  return value;
}

function coerceMinInt(rawValue: unknown, fieldName: string, defaultValue: number, minimum: number): number {
  const value = coerceInt(rawValue, fieldName, defaultValue);
  if (value < minimum) throw new Error(`${fieldName} must be at least ${minimum}`);
  return value;
}

function coerceFloat(rawValue: unknown, fieldName: string, defaultValue: number): number {
  if (rawValue === null || rawValue === undefined) return defaultValue;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) throw new Error(`${fieldName} must be a number`);
  if (value <= 0) throw new Error(`${fieldName} must be positive`);
  return value;
}

function parseProviderSecret(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  return typeof value === "string" ? value.trim() : "";
}

function parseModelsField(name: string, raw: Record<string, unknown>): string[] {
  if (Array.isArray(raw.models)) return raw.models.filter(Boolean).map((model) => normalizeModel(name, model));
  if (raw.model !== undefined && raw.model !== null) return [normalizeModel(name, raw.model)];
  return [normalizeModel(name, null)];
}

function parseCustomModelsField(raw: Record<string, unknown>): string[] {
  if (!Array.isArray(raw.custom_models)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw.custom_models) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function parseModelEfforts(name: string, raw: Record<string, unknown>): Array<[string, string]> {
  if (raw.model_efforts && typeof raw.model_efforts === "object" && !Array.isArray(raw.model_efforts)) {
    return Object.entries(raw.model_efforts as Record<string, unknown>)
      .filter(([key]) => Boolean(key))
      .map(([key, value]) => [key, normalizeReasoningEffort(value)]);
  }
  if (raw.reasoning_effort !== undefined && raw.reasoning_effort !== null) {
    const effort = normalizeReasoningEffort(raw.reasoning_effort);
    return parseModelsField(name, raw).map((model) => [model, effort]);
  }
  return [];
}

function parseProviderProfiles(rawAgent: Record<string, unknown>): Record<string, ProviderProfile> {
  const rawProviders = rawAgent.providers;
  if (rawProviders && typeof rawProviders === "object" && !Array.isArray(rawProviders)) {
    const providers = rawProviders as Record<string, unknown>;
    const profiles: Record<string, ProviderProfile> = {};
    for (const name of [CODEX_PROVIDER, ANTHROPIC_PROVIDER]) {
      const raw = asRecord(providers[name], `agent.providers.${name}`);
      profiles[name] = {
        enabled: normalizeBool(raw.enabled, `agent.providers.${name}.enabled`, false),
        models: parseModelsField(name, raw),
        modelEfforts: parseModelEfforts(name, raw),
        apiKey: parseProviderSecret(raw, "api_key"),
        baseUrl: parseProviderSecret(raw, "base_url"),
        customModels: parseCustomModelsField(raw),
      };
    }
    return profiles;
  }
  const defaults = providerProfilesDefault();
  if (rawAgent.provider !== undefined && rawAgent.provider !== null) {
    const provider = normalizeProvider(rawAgent.provider);
    const model = normalizeModel(provider, rawAgent.model);
    const effort = normalizeReasoningEffort(rawAgent.reasoning_effort);
    for (const name of Object.keys(defaults)) {
      defaults[name] =
        name === provider
          ? { enabled: true, models: [model], modelEfforts: [[model, effort]], apiKey: "", baseUrl: "", customModels: [] }
          : { enabled: false, models: [normalizeModel(name, null)], modelEfforts: [], apiKey: "", baseUrl: "", customModels: [] };
    }
  }
  return defaults;
}

function primaryFromProfiles(profiles: Record<string, ProviderProfile>): [string, string, string] {
  for (const name of [CODEX_PROVIDER, ANTHROPIC_PROVIDER]) {
    const profile = profiles[name];
    if (profile?.enabled) return [name, profile.models[0] ?? "", effortFor(profile, profile.models[0] ?? "")];
  }
  return [CODEX_PROVIDER, DEFAULT_CODEX_MODEL, "medium"];
}

export function effortFor(profile: ProviderProfile, model: string): string {
  return profile.modelEfforts.find(([slug]) => slug === model)?.[1] ?? "medium";
}

function parseCandleContextMode(rawValue: unknown): CandleContextMode {
  if (rawValue === undefined || rawValue === null || rawValue === "") return "raw";
  const value = String(rawValue).trim();
  if (value === "raw" || value === "with_indicators") return value;
  console.warn(`[config] invalid agent.candle_context_mode "${value}", using "raw"`);
  return "raw";
}

export function parseAgentConfig(rawAgentValue: unknown): AgentConfig {
  const rawAgent = asRecord(rawAgentValue, "agent");
  const profiles = parseProviderProfiles(rawAgent);
  const [provider, model, reasoningEffort] = primaryFromProfiles(profiles);
  return {
    enabled: normalizeBool(rawAgent.enabled, "agent.enabled", true),
    provider,
    apiMode: normalizeApiMode(provider),
    model,
    maxCandles: coerceMinInt(rawAgent.max_candles, "agent.max_candles", 40, 10),
    candleContextMode: parseCandleContextMode(rawAgent.candle_context_mode),
    reasoningEffort,
    providerProfiles: profiles,
  };
}

export function parseAnalysisConfig(rawAnalysisValue: unknown): AnalysisConfig {
  const raw = asRecord(rawAnalysisValue, "analysis");
  return {
    enabled: normalizeBool(raw.enabled, "analysis.enabled", true),
    interval: normalizeAnalysisInterval(raw.interval),
    lookback: coerceMinInt(raw.lookback, "analysis.lookback", 40, 10),
    pollIntervalSeconds: coerceInt(raw.poll_interval_seconds, "analysis.poll_interval_seconds", 30),
    staleAfterSeconds: coerceInt(raw.stale_after_seconds, "analysis.stale_after_seconds", 420),
  };
}

export function parseMemoryConfig(rawMemoryValue: unknown): MemoryConfig {
  const raw = asRecord(rawMemoryValue, "memory");
  const optionalString = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    enabled: normalizeBool(raw.enabled, "memory.enabled", false),
    useMemories: normalizeBool(raw.use_memories, "memory.use_memories", true),
    generateMemories: normalizeBool(raw.generate_memories, "memory.generate_memories", true),
    storagePath: optionalString(raw.storage_path),
    extractModel: optionalString(raw.extract_model),
    consolidationModel: optionalString(raw.consolidation_model),
    maxRawMemoriesForConsolidation: coerceMinInt(raw.max_raw_memories_for_consolidation, "memory.max_raw_memories_for_consolidation", 256, 1),
    maxUnusedDays: coerceMinInt(raw.max_unused_days, "memory.max_unused_days", 180, 1),
    maxSourceAgeDays: coerceMinInt(raw.max_source_age_days, "memory.max_source_age_days", 180, 1),
    maxRolloutsPerStartup: coerceMinInt(raw.max_rollouts_per_startup, "memory.max_rollouts_per_startup", 5000, 1),
    minSessionIdleHours: coerceMinInt(raw.min_session_idle_hours, "memory.min_session_idle_hours", 12, 0),
    extensionRetentionDays: coerceMinInt(raw.extension_retention_days, "memory.extension_retention_days", 7, 1),
  };
}

export function parseNewsConfig(rawNewsValue: unknown): NewsConfig {
  const raw = asRecord(rawNewsValue, "news");
  if (raw.reuters_url !== undefined && raw.reuters_url !== null && typeof raw.reuters_url !== "string") {
    throw new Error("news.reuters_url must be a string");
  }
  let reutersUrl = typeof raw.reuters_url === "string" && raw.reuters_url.trim() ? raw.reuters_url.trim() : DEFAULT_REUTERS_URL;
  if (DEPRECATED_REUTERS_URLS.has(reutersUrl)) reutersUrl = DEFAULT_REUTERS_URL;
  return {
    enabled: normalizeBool(raw.enabled, "news.enabled", false),
    pollIntervalSeconds: coerceMinInt(raw.poll_interval_seconds, "news.poll_interval_seconds", 30, 5),
    maxIntervalSeconds: coerceMinInt(raw.max_interval_seconds, "news.max_interval_seconds", 600, 30),
    reutersUrl,
    requestTimeoutSeconds: coerceFloat(raw.request_timeout_seconds, "news.request_timeout_seconds", 10),
    retentionDays: coerceMinInt(raw.retention_days, "news.retention_days", 30, 1),
    recentLimit: coerceMinInt(raw.recent_limit, "news.recent_limit", 50, 1),
  };
}

export function parseSocialFeedConfig(rawSocialValue: unknown): SocialFeedConfig {
  const raw = asRecord(rawSocialValue, "social_feed");
  return {
    enabled: normalizeBool(raw.enabled, "social_feed.enabled", false),
    recentLimit: coerceMinInt(raw.recent_limit, "social_feed.recent_limit", 100, 1),
    retentionDays: coerceMinInt(raw.retention_days, "social_feed.retention_days", 30, 1),
    maxItems: coerceMinInt(raw.max_items, "social_feed.max_items", 2000, 100),
  };
}

const VALID_TRADING_MODES: ExchangeTradingMode[] = ["off", "demo", "live"];

function parseExchangeMode(raw: Record<string, unknown>, key: string, defaultMode: ExchangeTradingMode): ExchangeTradingMode {
  const value = raw[key];
  if (value === undefined || value === null) return defaultMode;
  const str = String(value).toLowerCase().trim();
  if (VALID_TRADING_MODES.includes(str as ExchangeTradingMode)) return str as ExchangeTradingMode;
  // Legacy boolean compat: true → "live" for hyperliquid, "demo" for bitget; false → "off"
  if (str === "true") return key.includes("bitget") ? "demo" : "live";
  if (str === "false") return "off";
  console.warn(`[config] invalid trading mode "${value}" for ${key}, using "${defaultMode}"`);
  return defaultMode;
}

export function parseTradingConfig(rawTradingValue: unknown): TradingConfig {
  const raw = asRecord(rawTradingValue, "trading");
  return {
    hyperliquidMode: parseExchangeMode(raw, "hyperliquid_mode", "off"),
    bitgetMode: parseExchangeMode(raw, "bitget_mode", "off"),
  };
}

export function parseCronJobsConfig(rawCronJobs: unknown): CronJobConfig[] {
  if (rawCronJobs === undefined || rawCronJobs === null) return [];
  if (!Array.isArray(rawCronJobs)) throw new Error("cron_jobs must be an array of job entries");
  return rawCronJobs.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`cron_jobs[${i}] must be an object`);
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) throw new Error(`cron_jobs[${i}].name is required`);
    const cron = typeof entry.cron === "string" ? entry.cron.trim() : "";
    if (!cron) throw new Error(`cron_jobs[${i}].cron is required`);
    const systemPrompt = typeof entry.system_prompt === "string" ? entry.system_prompt : "";
    const enabled = entry.enabled !== undefined ? normalizeBool(entry.enabled, `cron_jobs[${i}].enabled`, true) : true;
    const symbols = Array.isArray(entry.symbols) ? entry.symbols.filter((s): s is string => typeof s === "string") : [];
    const model = typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : null;
    const userMessage = typeof entry.user_message === "string" ? entry.user_message : "开始定时看盘分析";
    const maxIterations = typeof entry.max_iterations === "number" && entry.max_iterations > 0 ? entry.max_iterations : null;
    const maxCandles = typeof entry.max_candles === "number" && entry.max_candles > 0 ? entry.max_candles : null;
    const tradingEnabled = entry.trading_enabled !== undefined ? normalizeBool(entry.trading_enabled, `cron_jobs[${i}].trading_enabled`, false) : false;
    const socialEnabled = entry.social_enabled !== undefined ? normalizeBool(entry.social_enabled, `cron_jobs[${i}].social_enabled`, false) : false;
    const timezone = typeof entry.timezone === "string" && entry.timezone.trim() ? entry.timezone.trim() : null;
    return { name, cron, systemPrompt, enabled, symbols, model, userMessage, maxIterations, maxCandles, tradingEnabled, socialEnabled, timezone };
  });
}

export function parseCacheConfig(rawCacheValue: unknown): CacheConfig {
  const raw = asRecord(rawCacheValue, "cache");
  if (raw.path !== undefined && raw.path !== null && raw.path !== "" && typeof raw.path !== "string") {
    throw new Error("cache.path must be a string");
  }
  return {
    enabled: normalizeBool(raw.enabled, "cache.enabled", true),
    path: typeof raw.path === "string" && raw.path.trim() ? expandUserPath(raw.path.trim()) : null,
    candleRetentionSeconds: coerceInt(raw.candle_retention_seconds, "cache.candle_retention_seconds", 86_400),
  };
}

export function parseMcpConfig(rawMcpValue: unknown): McpAppConfig {
  const raw = asRecord(rawMcpValue, "mcp");
  const configPath = typeof raw.config_path === "string" && raw.config_path.trim() ? raw.config_path.trim() : null;
  return {
    enabled: normalizeBool(raw.enabled, "mcp.enabled", true),
    configPath,
  };
}

export function parseConfig(data: Record<string, unknown>, sourcePath: string | null = null): AppConfig {
  const rawSymbols = data.symbols;
  if (!Array.isArray(rawSymbols)) throw new Error("symbols must be a list of symbol entries");
  const rawDisplay = asRecord(data.display, "display");
  return {
    instruments: normalizeInstruments(rawSymbols),
    display: {
      refreshIntervalMs: coerceInt(rawDisplay.refresh_interval_ms, "display.refresh_interval_ms", 1000),
      staleAfterSeconds: coerceInt(rawDisplay.stale_after_seconds, "display.stale_after_seconds", 20),
      reconnectDelaySeconds: coerceFloat(rawDisplay.reconnect_delay_seconds, "display.reconnect_delay_seconds", 3),
      stockPollIntervalSeconds: coerceInt(rawDisplay.stock_poll_interval_seconds, "display.stock_poll_interval_seconds", 5),
    },
    analysis: parseAnalysisConfig(data.analysis),
    cache: parseCacheConfig(data.cache),
    agent: parseAgentConfig(data.agent),
    memory: parseMemoryConfig(data.memory),
    news: parseNewsConfig(data.news),
    socialFeed: parseSocialFeedConfig(data.social_feed),
    trading: parseTradingConfig(data.trading),
    mcp: parseMcpConfig(data.mcp),
    cronJobs: parseCronJobsConfig(data.cron_jobs),
    sourcePath,
  };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const sourcePath = path.resolve(expandUserPath(configPath));
  const text = await readFile(sourcePath, "utf8");
  return parseConfig(parseToml(text) as Record<string, unknown>, sourcePath);
}

export function buildRuntimeConfig(fileConfig: AppConfig | null, cliSymbols?: string[]): AppConfig {
  const base =
    fileConfig ??
    ({
      instruments: [],
      display: {
        refreshIntervalMs: 1000,
        staleAfterSeconds: 20,
        reconnectDelaySeconds: 3,
        stockPollIntervalSeconds: 5,
      },
      analysis: parseAnalysisConfig({}),
      cache: parseCacheConfig({}),
      agent: parseAgentConfig({}),
      memory: parseMemoryConfig({}),
      news: parseNewsConfig({}),
      socialFeed: parseSocialFeedConfig({}),
      trading: parseTradingConfig({}),
      mcp: parseMcpConfig({}),
      cronJobs: [],
      sourcePath: null,
    } satisfies AppConfig);
  const instruments = cliSymbols && cliSymbols.length > 0 ? normalizeInstruments(cliSymbols) : base.instruments;
  if (instruments.length === 0) throw new Error("no symbols configured; use a config file or --symbols");
  return { ...base, instruments };
}
