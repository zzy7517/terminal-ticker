import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  ANTHROPIC_PROVIDER,
  CODEX_PROVIDER,
  OPENAI_PROVIDER,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENAI_MODEL,
  defaultProviderApi,
  normalizeApiMode,
  normalizeModel,
  normalizeProvider,
  normalizeReasoningEffort,
} from "./agent-models.js";
import { DEFAULT_JIN10_URL } from "../jin10/types.js";
import { parseMacroConfig } from "../macro/config.js";
import { parseOptionsConfig } from "../options/config.js";
import { asRecord, coerceFloat, coerceInt, coerceMinInt, expandEnvRefs, normalizeBool, parseSecretField } from "./parsing.js";
import { secretsFilePath } from "./secrets.js";

export const BITGET_SOURCE = "bitget";
export const SUPPORTED_SOURCES = new Set([BITGET_SOURCE]);
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
  /** Pi wire-format API identifier, e.g. "openai-completions". */
  api: string;
  displayName: string;
  requiresAuth: boolean;
  models: string[];
  modelEfforts: Array<[string, string]>;
  apiKey: string;
  /** Original TOML value (may be `${ENV}`); preserved on save so secrets stay as placeholders. */
  apiKeyRaw: string;
  baseUrl: string;
  /** Legacy custom model IDs without metadata. */
  customModels: string[];
  customModelDefinitions: CustomModelDefinition[];
}

export interface CustomModelDefinition {
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
}

export type CandleContextMode = "raw" | "with_indicators";

export interface AgentConfig {
  enabled: boolean;
  provider: string;
  apiMode: string;
  model: string;
  systemPrompt: string;
  maxCandles: number;
  candleContextMode: CandleContextMode;
  reasoningEffort: string;
  providerProfiles: Record<string, ProviderProfile>;
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

/** Per-exchange trading mode: off = no orders, demo = paper/simulated, live = real money */
export type ExchangeTradingMode = "off" | "demo" | "live";

export interface TradingConfig {
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
  useMainPrompt: boolean;
  enabled: boolean;
  symbols: string[];
  model: string | null;
  userMessage: string;
  maxIterations: number | null;
  maxCandles: number | null;
  tradingEnabled: boolean;
  timezone: string | null;
}

export interface McpAppConfig {
  enabled: boolean;
  configPath: string | null;
}

export interface Jin10Config {
  enabled: boolean;
  /** Jin10 MCP endpoint. Defaults to the hosted server; override for a proxy or mock. */
  url: string;
  token: string;
  /** Original TOML value (may be `${VAR}`); persisted on save so the secret stays in the vault. */
  tokenRaw: string;
  flashEnabled: boolean;
  flashPollIntervalSeconds: number;
  calendarEnabled: boolean;
  calendarPollIntervalSeconds: number;
  quotesEnabled: boolean;
  quotesPollIntervalSeconds: number;
  quotesCodes: string[];
  /** Whether Jin10 instruments are included in agent analysis context (mention, candles). Default: false */
  agentAnalysis: boolean;
}

export interface BrowserConfig {
  enabled: boolean;
  /** Path to the OBU socket. null = auto-discover from /tmp/open-browser-use/active.json */
  socketPath: string | null;
  /** Default timeout for browser operations in ms */
  timeoutMs: number;
}

export interface ChannelsConfig {
  maxActiveAgents: number;
  maxAgents: number;
  maxActivationHops: number;
  activationDebounceMs: number;
  retryMaxSeconds: number;
}

export type ProxyType = "http" | "https" | "socks5";

export interface ProxyConfig {
  /** When true, route all outbound fetch() through the proxy. */
  enabled: boolean;
  type: ProxyType;
  /** Proxy host/IP, e.g. 127.0.0.1. Blank disables the proxy even when enabled. */
  host: string;
  port: number;
  /** Optional basic-auth username. */
  username: string;
  /** Optional basic-auth password. */
  password: string;
  /** Original TOML value of `password` (may be `${VAR}`); persisted on save. */
  passwordRaw: string;
}

export interface AppConfig {
  instruments: InstrumentConfig[];
  display: DisplayConfig;
  sourcePath: string | null;
  analysis: AnalysisConfig;
  cache: CacheConfig;
  agent: AgentConfig;
  news: NewsConfig;
  trading: TradingConfig;
  mcp: McpAppConfig;
  jin10: Jin10Config;
  browser: BrowserConfig;
  channels: ChannelsConfig;
  proxy: ProxyConfig;
  options: import("../options/domain.js").OptionsConfig;
  macro: import("../macro/domain.js").MacroConfig;
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
      api: defaultProviderApi(CODEX_PROVIDER),
      displayName: "OpenAI Codex",
      requiresAuth: true,
      models: [DEFAULT_CODEX_MODEL],
      modelEfforts: [],
      apiKey: "",
      apiKeyRaw: "",
      baseUrl: "",
      customModels: [],
      customModelDefinitions: [],
    },
    [ANTHROPIC_PROVIDER]: {
      enabled: false,
      api: defaultProviderApi(ANTHROPIC_PROVIDER),
      displayName: "Anthropic",
      requiresAuth: true,
      models: [DEFAULT_ANTHROPIC_MODEL],
      modelEfforts: [],
      apiKey: "",
      apiKeyRaw: "",
      baseUrl: "",
      customModels: [],
      customModelDefinitions: [],
    },
    [OPENAI_PROVIDER]: {
      enabled: false,
      api: defaultProviderApi(OPENAI_PROVIDER),
      displayName: "OpenAI",
      requiresAuth: true,
      models: [DEFAULT_OPENAI_MODEL],
      modelEfforts: [],
      apiKey: "",
      apiKeyRaw: "",
      baseUrl: "",
      customModels: [],
      customModelDefinitions: [],
    },
  };
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
  return source === BITGET_SOURCE ? "crypto" : DEFAULT_GROUP;
}

function normalizeGroup(rawValue: unknown, source: string): string {
  if (rawValue === null || rawValue === undefined) return defaultGroup(source);
  if (typeof rawValue !== "string") throw new Error("group must be a string");
  const group = rawValue.trim().toLowerCase().replace(/[- ]/g, "_");
  if (!group) return defaultGroup(source);
  return GROUP_ALIASES[group] ?? group;
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

export function normalizeSymbolForSource(symbol: string, _source: string): string {
  const value = symbol.trim();
  if (!value) return "";
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
      const rawSource =
        entry.source === null || entry.source === undefined
          ? BITGET_SOURCE
          : String(entry.source).trim().toLowerCase() || BITGET_SOURCE;
      if (!SUPPORTED_SOURCES.has(rawSource)) {
        console.warn(
          `[config] skipping unsupported watchlist source "${rawSource}" for symbol ${String(entry.symbol ?? "")}`,
        );
        continue;
      }
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

function parseProviderSecretRaw(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string") return "";
  return value.trim();
}

function parseProviderSecret(raw: Record<string, unknown>, field: string): string {
  const value = parseProviderSecretRaw(raw, field);
  if (!value) return "";
  return expandEnvRefs(value, `agent.providers.*.${field}`);
}

function parseModelsField(name: string, raw: Record<string, unknown>): string[] {
  if (Array.isArray(raw.models)) return raw.models.filter(Boolean).map((model) => normalizeModel(name, model));
  if (raw.model !== undefined && raw.model !== null) return [normalizeModel(name, raw.model)];
  const fallback = normalizeModel(name, null);
  return fallback ? [fallback] : [];
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

function parseCustomModelDefinitions(
  raw: Record<string, unknown>,
  providerApi: string,
  field: string,
): CustomModelDefinition[] {
  const values = [
    ...(Array.isArray(raw.custom_model_definitions) ? raw.custom_model_definitions : []),
    ...(Array.isArray(raw.custom_models)
      ? raw.custom_models.filter((value) => value !== null && typeof value === "object" && !Array.isArray(value))
      : []),
  ];
  if (values.length === 0) return [];
  const definitions = new Map<string, CustomModelDefinition>();
  for (const [index, value] of values.entries()) {
    const item = asRecord(value, `${field}.custom_model_definitions[${index}]`);
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) throw new Error(`${field}.custom_model_definitions[${index}].id is required`);
    const api = typeof item.api === "string" && item.api.trim() ? item.api.trim() : providerApi;
    const input = Array.isArray(item.input)
      ? item.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
      : ["text" as const];
    const contextWindow = Number(item.context_window ?? item.contextWindow);
    const maxTokens = Number(item.max_tokens ?? item.maxTokens);
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      throw new Error(`${field}.custom_model_definitions[${index}].context_window must be a positive integer`);
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new Error(`${field}.custom_model_definitions[${index}].max_tokens must be a positive integer`);
    }
    definitions.set(id, {
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : id,
      api,
      reasoning: normalizeBool(item.reasoning, `${field}.custom_model_definitions[${index}].reasoning`, false),
      input: input.length > 0 ? input : ["text"],
      contextWindow,
      maxTokens,
    });
  }
  return [...definitions.values()];
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
    for (const [rawName, rawValue] of Object.entries(providers)) {
      const name = normalizeProvider(rawName);
      if (profiles[name]) throw new Error(`duplicate agent provider: ${name}`);
      const field = `agent.providers.${name}`;
      const raw = asRecord(rawValue, field);
      const api = typeof raw.api === "string" && raw.api.trim()
        ? raw.api.trim()
        : defaultProviderApi(name);
      profiles[name] = {
        enabled: normalizeBool(raw.enabled, `${field}.enabled`, false),
        api,
        displayName: typeof raw.display_name === "string" && raw.display_name.trim()
          ? raw.display_name.trim()
          : name,
        requiresAuth: normalizeBool(raw.requires_auth, `${field}.requires_auth`, true),
        models: parseModelsField(name, raw),
        modelEfforts: parseModelEfforts(name, raw),
        apiKey: parseProviderSecret(raw, "api_key"),
        apiKeyRaw: parseProviderSecretRaw(raw, "api_key"),
        baseUrl: parseProviderSecret(raw, "base_url"),
        customModels: parseCustomModelsField(raw),
        customModelDefinitions: parseCustomModelDefinitions(raw, api, field),
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
          ? { ...defaults[name], enabled: true, models: [model], modelEfforts: [[model, effort]] }
          : { ...defaults[name], enabled: false, models: [normalizeModel(name, null)], modelEfforts: [] };
    }
  }
  return defaults;
}

function primaryFromProfiles(profiles: Record<string, ProviderProfile>): [string, string, string] {
  const ordered = [
    CODEX_PROVIDER,
    ANTHROPIC_PROVIDER,
    OPENAI_PROVIDER,
    ...Object.keys(profiles).filter((name) => name !== CODEX_PROVIDER && name !== ANTHROPIC_PROVIDER && name !== OPENAI_PROVIDER),
  ];
  for (const name of ordered) {
    const profile = profiles[name];
    if (profile?.enabled && profile.models.length > 0) {
      return [name, profile.models[0], effortFor(profile, profile.models[0])];
    }
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
  const [fallbackProvider, fallbackModel, fallbackEffort] = primaryFromProfiles(profiles);
  const requestedProvider = typeof rawAgent.default_provider === "string"
    ? normalizeProvider(rawAgent.default_provider)
    : fallbackProvider;
  const provider = profiles[requestedProvider] ? requestedProvider : fallbackProvider;
  const profile = profiles[provider];
  const model = typeof rawAgent.default_model === "string" && rawAgent.default_model.trim()
    ? normalizeModel(provider, rawAgent.default_model)
    : provider === fallbackProvider
      ? fallbackModel
      : profile.models[0] ?? fallbackModel;
  const reasoningEffort = profile
    ? effortFor(profile, model)
    : fallbackEffort;
  return {
    enabled: normalizeBool(rawAgent.enabled, "agent.enabled", true),
    provider,
    apiMode: normalizeApiMode(
      provider,
      provider === CODEX_PROVIDER || provider === ANTHROPIC_PROVIDER || provider === OPENAI_PROVIDER
        ? undefined
        : profiles[provider]?.api,
    ),
    model,
    systemPrompt: typeof rawAgent.system_prompt === "string" ? rawAgent.system_prompt.trim() : "",
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

const VALID_TRADING_MODES: ExchangeTradingMode[] = ["off", "demo", "live"];

function parseExchangeMode(raw: Record<string, unknown>, key: string, defaultMode: ExchangeTradingMode): ExchangeTradingMode {
  const value = raw[key];
  if (value === undefined || value === null) return defaultMode;
  const str = String(value).toLowerCase().trim();
  if (VALID_TRADING_MODES.includes(str as ExchangeTradingMode)) return str as ExchangeTradingMode;
  // Legacy boolean compat: true → "demo" for bitget; false → "off"
  if (str === "true") return "demo";
  if (str === "false") return "off";
  console.warn(`[config] invalid trading mode "${value}" for ${key}, using "${defaultMode}"`);
  return defaultMode;
}

export function parseTradingConfig(rawTradingValue: unknown): TradingConfig {
  const raw = asRecord(rawTradingValue, "trading");
  if (raw.hyperliquid_mode !== undefined) {
    console.warn('[config] trading.hyperliquid_mode is no longer supported and will be ignored');
  }
  return {
    bitgetMode: parseExchangeMode(raw, "bitget_mode", "off"),
  };
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

const DEFAULT_JIN10_QUOTE_CODES = ["XAUUSD", "XAGUSD", "USOIL", "EURUSD", "USDJPY", "USDCNH"];

export function parseJin10Config(rawJin10Value: unknown): Jin10Config {
  const raw = asRecord(rawJin10Value, "jin10");
  const quotesCodes = Array.isArray(raw.quotes_codes)
    ? raw.quotes_codes.map((c: unknown) => String(c).trim().toUpperCase()).filter(Boolean)
    : DEFAULT_JIN10_QUOTE_CODES;
  const token = parseSecretField(raw.token, "jin10.token");
  return {
    enabled: normalizeBool(raw.enabled, "jin10.enabled", true),
    url: typeof raw.url === "string" && raw.url.trim() ? raw.url.trim() : DEFAULT_JIN10_URL,
    token: token.value,
    tokenRaw: token.raw,
    flashEnabled: normalizeBool(raw.flash_enabled, "jin10.flash_enabled", true),
    flashPollIntervalSeconds: coerceMinInt(raw.flash_poll_interval_seconds, "jin10.flash_poll_interval_seconds", 60, 10),
    calendarEnabled: normalizeBool(raw.calendar_enabled, "jin10.calendar_enabled", true),
    calendarPollIntervalSeconds: coerceMinInt(raw.calendar_poll_interval_seconds, "jin10.calendar_poll_interval_seconds", 300, 30),
    quotesEnabled: normalizeBool(raw.quotes_enabled, "jin10.quotes_enabled", true),
    quotesPollIntervalSeconds: coerceMinInt(raw.quotes_poll_interval_seconds, "jin10.quotes_poll_interval_seconds", 30, 10),
    quotesCodes,
    agentAnalysis: normalizeBool(raw.agent_analysis, "jin10.agent_analysis", false),
  };
}

export function parseBrowserConfig(rawBrowserValue: unknown): BrowserConfig {
  const raw = asRecord(rawBrowserValue, "browser");
  const socketPath = typeof raw.socket_path === "string" && raw.socket_path.trim() ? raw.socket_path.trim() : null;
  return {
    enabled: normalizeBool(raw.enabled, "browser.enabled", false),
    socketPath,
    timeoutMs: coerceInt(raw.timeout_ms, "browser.timeout_ms", 15_000),
  };
}

export function parseChannelsConfig(rawChannelsValue: unknown): ChannelsConfig {
  const raw = asRecord(rawChannelsValue ?? {}, "channels");
  return {
    maxActiveAgents: coerceInt(raw.max_active_agents, "channels.max_active_agents", 3),
    maxAgents: coerceInt(raw.max_agents, "channels.max_agents", 20),
    maxActivationHops: coerceInt(raw.max_activation_hops, "channels.max_activation_hops", 16),
    activationDebounceMs: coerceInt(raw.activation_debounce_ms, "channels.activation_debounce_ms", 500),
    retryMaxSeconds: coerceInt(raw.retry_max_seconds, "channels.retry_max_seconds", 300),
  };
}

const VALID_PROXY_TYPES: ProxyType[] = ["http", "https", "socks5"];

function parseProxyType(rawValue: unknown): ProxyType {
  if (rawValue === null || rawValue === undefined) return "http";
  const value = String(rawValue).trim().toLowerCase();
  if (value === "socks" || value === "socks5h") return "socks5";
  if (VALID_PROXY_TYPES.includes(value as ProxyType)) return value as ProxyType;
  console.warn(`[config] invalid proxy.type "${rawValue}", using "http"`);
  return "http";
}

function parseProxyPort(rawValue: unknown): number {
  if (rawValue === null || rawValue === undefined || rawValue === "") return 8080;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error("proxy.port must be an integer between 1 and 65535");
  }
  return value;
}

export function parseProxyConfig(rawProxyValue: unknown): ProxyConfig {
  const raw = asRecord(rawProxyValue, "proxy");
  const asStr = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const password = parseSecretField(raw.password, "proxy.password");
  return {
    enabled: normalizeBool(raw.enabled, "proxy.enabled", false),
    type: parseProxyType(raw.type),
    host: asStr(raw.host),
    port: parseProxyPort(raw.port),
    username: typeof raw.username === "string" ? raw.username : "",
    password: password.value,
    passwordRaw: password.raw,
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
    news: parseNewsConfig(data.news),
    trading: parseTradingConfig(data.trading),
    mcp: parseMcpConfig(data.mcp),
    jin10: parseJin10Config(data.jin10),
    browser: parseBrowserConfig(data.browser),
    channels: parseChannelsConfig(data.channels),
    proxy: parseProxyConfig(data.proxy),
    options: parseOptionsConfig(data.options),
    macro: parseMacroConfig(data.macro),

    sourcePath,
  };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const sourcePath = path.resolve(expandUserPath(configPath));
  let text = await readFile(sourcePath, "utf8");
  const stripped = stripUnsupportedWatchlistEntries(text);
  if (stripped.text !== text) {
    await writeFile(sourcePath, stripped.text);
    for (const note of stripped.removed) {
      console.warn(`[config] removed unsupported watchlist entry ${note} from ${sourcePath}`);
    }
    text = stripped.text;
  }
  const config = parseConfig(parseToml(text) as Record<string, unknown>, sourcePath);
  warnPlaintextSecrets(config, sourcePath);
  return config;
}

/** Drop inline symbol rows whose source is no longer supported (e.g. legacy hyperliquid). */
function stripUnsupportedWatchlistEntries(text: string): { text: string; removed: string[] } {
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim().startsWith("symbols") && line.includes("["));
  if (startIndex < 0) return { text, removed: [] };
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === "]");
  if (endIndex < 0) return { text, removed: [] };

  const removed: string[] = [];
  const next = [...lines];
  for (let index = endIndex - 1; index > startIndex; index -= 1) {
    const stripped = next[index].trim();
    if (!stripped.startsWith("{")) continue;
    const candidate = stripped.replace(/,\s*$/, "");
    try {
      const parsed = parseToml(`symbols = [${candidate}]\n`) as { symbols?: unknown };
      const entry =
        Array.isArray(parsed.symbols) && parsed.symbols.length === 1 && typeof parsed.symbols[0] === "object"
          ? (parsed.symbols[0] as Record<string, unknown>)
          : null;
      if (!entry) continue;
      const source = String(entry.source || BITGET_SOURCE).trim().toLowerCase() || BITGET_SOURCE;
      if (SUPPORTED_SOURCES.has(source)) continue;
      removed.push(`${source}:${String(entry.symbol ?? "")}`);
      next.splice(index, 1);
    } catch {
      // Keep unparsable lines; normalizeInstruments will still skip bad sources.
    }
  }
  if (removed.length === 0) return { text, removed };
  return { text: `${next.join("\n").replace(/\n*$/, "")}\n`, removed };
}

/**
 * Flag secrets stored as literals in the config file. Any save through the
 * settings API migrates them into the vault automatically (see
 * config/secrets.ts); the warning covers installs that never touch the UI.
 */
function warnPlaintextSecrets(config: AppConfig, sourcePath: string): void {
  const plaintext = (raw: string | undefined): boolean => Boolean(raw && raw.trim() && !raw.includes("${"));
  const fields: Array<[string, string | undefined]> = [
    ["jin10.token", config.jin10.tokenRaw],
    ["macro.fred_api_key", config.macro.fredApiKeyRaw],
    ["macro.twelve_data_api_key", config.macro.twelveDataApiKeyRaw],
    ["proxy.password", config.proxy.passwordRaw],
    ["options.tradier.api_key", config.options.tradier?.apiKeyRaw],
    ["options.marketdata.api_key", config.options.marketdata?.apiKeyRaw],
    ...Object.entries(config.agent.providerProfiles).map(
      ([name, profile]): [string, string | undefined] => [`agent.providers.${name}.api_key`, profile.apiKeyRaw],
    ),
  ];
  const leaked = fields.filter(([, raw]) => plaintext(raw)).map(([field]) => field);
  if (leaked.length > 0) {
    console.warn(
      `[config] ${sourcePath} 中以下字段是明文密钥：${leaked.join("、")}。` +
        `通过设置界面重新保存即可自动迁移到 ${secretsFilePath()}，` +
        "或手动将值移入该文件并把配置改为 ${VAR} 引用。",
    );
  }
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
      news: parseNewsConfig({}),
      trading: parseTradingConfig({}),
      mcp: parseMcpConfig({}),
      jin10: parseJin10Config({}),
      browser: parseBrowserConfig({}),
      channels: parseChannelsConfig({}),
      proxy: parseProxyConfig({}),
      options: parseOptionsConfig(undefined),
      macro: parseMacroConfig(undefined),

      sourcePath: null,
    } satisfies AppConfig);
  const instruments = cliSymbols && cliSymbols.length > 0 ? normalizeInstruments(cliSymbols) : base.instruments;
  if (instruments.length === 0) throw new Error("no symbols configured; use a config file or --symbols");
  return { ...base, instruments };
}
