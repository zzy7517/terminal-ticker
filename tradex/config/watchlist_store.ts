import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  AgentConfig,
  AnalysisConfig,
  BITGET_SOURCE,
  GROUP_ALIASES,
  HYPERLIQUID_SOURCE,
  Jin10Config,
  NewsConfig,
  ProxyConfig,
  SUPPORTED_INST_TYPES,
  TradingConfig,
  expandUserPath,
  loadConfig,
  normalizeSymbolForSource,
} from "./index.js";
import type { OptionsConfig } from "../options/domain.js";

function tomlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")}"`;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlCustomModelDefinition(
  definition: AgentConfig["providerProfiles"][string]["customModelDefinitions"][number],
): string {
  return `{ id = ${tomlString(definition.id)}, name = ${tomlString(definition.name)}, api = ${tomlString(definition.api)}, reasoning = ${definition.reasoning ? "true" : "false"}, input = [${definition.input.map(tomlString).join(", ")}], context_window = ${definition.contextWindow}, max_tokens = ${definition.maxTokens} }`;
}

/**
 * Serializes all watchlist read-modify-write operations. Concurrent config
 * POSTs from the UI would otherwise interleave their read/write phases and
 * silently lose the earlier update.
 */
let watchlistWriteQueue: Promise<unknown> = Promise.resolve();

function withWatchlistLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = watchlistWriteQueue.then(fn, fn);
  watchlistWriteQueue = run.catch(() => undefined);
  return run;
}

function normalizeBitgetSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) throw new Error("symbol entries cannot be blank");
  return normalized;
}

function normalizeHyperliquidSymbol(symbol: string): string {
  const value = symbol.trim();
  const normalized = value.includes(":")
    ? (() => {
        const [dex, coin] = value.split(":", 2);
        return `${dex.trim().toLowerCase()}:${coin.trim().toUpperCase()}`;
      })()
    : value.toUpperCase();
  if (!normalized) throw new Error("symbol entries cannot be blank");
  return normalized;
}

function normalizeSymbolForSourceStrict(source: string, symbol: string): string {
  return source.trim().toLowerCase() === HYPERLIQUID_SOURCE
    ? normalizeHyperliquidSymbol(symbol)
    : normalizeBitgetSymbol(symbol);
}

function normalizeBitgetInstType(instType: string | null | undefined): string {
  const normalized = String(instType || "").trim().toUpperCase();
  if (!SUPPORTED_INST_TYPES.has(normalized)) {
    throw new Error(`inst_type must be one of: ${[...SUPPORTED_INST_TYPES].sort().join(", ")}`);
  }
  return normalized;
}

function normalizeGroup(group: string | null | undefined): string {
  if (group === null || group === undefined) return "stocks";
  const normalized = group.trim().toLowerCase().replace(/[- ]/g, "_");
  if (!normalized) return "stocks";
  return GROUP_ALIASES[normalized] ?? normalized;
}

function formatBitgetEntry(input: {
  symbol: string;
  instType: string;
  label?: string | null;
  group: string;
  showCollapsed: boolean;
}): string {
  const label = input.label || input.symbol;
  return `  { symbol = ${tomlString(input.symbol)}, source = "bitget", inst_type = ${tomlString(input.instType)}, label = ${tomlString(label)}, group = ${tomlString(input.group)}, show_collapsed = ${input.showCollapsed ? "true" : "false"} },`;
}

function formatHyperliquidEntry(input: {
  symbol: string;
  label?: string | null;
  group: string;
  showCollapsed: boolean;
}): string {
  const label = input.label || `${input.symbol} Perp`;
  return `  { symbol = ${tomlString(input.symbol)}, source = ${tomlString(HYPERLIQUID_SOURCE)}, label = ${tomlString(label)}, group = ${tomlString(input.group)}, show_collapsed = ${input.showCollapsed ? "true" : "false"} },`;
}

function parseInlineSymbolEntry(line: string): Record<string, unknown> | null {
  const stripped = line.trim();
  if (!stripped.startsWith("{")) return null;
  const candidate = stripped.replace(/,\s*$/, "");
  try {
    const parsed = parseToml(`symbols = [${candidate}]\n`) as { symbols?: unknown };
    return Array.isArray(parsed.symbols) && parsed.symbols.length === 1 && typeof parsed.symbols[0] === "object"
      ? (parsed.symbols[0] as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function entrySource(entry: Record<string, unknown>): string {
  return String(entry.source || BITGET_SOURCE).trim().toLowerCase() || BITGET_SOURCE;
}

function entryInstType(entry: Record<string, unknown>): string | null {
  const raw = String(entry.inst_type || "").trim().toUpperCase();
  return raw || null;
}

function isSymbolEntry(line: string, input: { source: string; symbol: string; instType: string | null }): boolean {
  const entry = parseInlineSymbolEntry(line);
  if (entry === null) return false;
  const source = entrySource(entry);
  const rawSymbol = String(entry.symbol || "");
  let normalizedSymbol = "";
  try {
    normalizedSymbol = normalizeSymbolForSourceStrict(source, rawSymbol);
  } catch {
    return false;
  }
  return source === input.source && normalizedSymbol === input.symbol && entryInstType(entry) === input.instType;
}

async function appendEntryToSymbolsArray(sourcePath: string, entry: string): Promise<void> {
  return withWatchlistLock(async () => {
    const text = await readFile(sourcePath, "utf8");
    const lines = text.split(/\r?\n/);
    const startIndex = lines.findIndex((line) => line.trim().startsWith("symbols") && line.includes("["));
    if (startIndex < 0) {
      const prefix = text && !text.endsWith("\n") ? `${text}\n` : text;
      await writeFile(sourcePath, `${prefix}\nsymbols = [\n${entry}\n]\n`);
      return;
    }
    const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === "]");
    if (endIndex < 0) throw new Error("symbols array is not closed");
    lines.splice(endIndex, 0, entry);
    await writeFile(sourcePath, `${lines.join("\n").replace(/\n*$/, "")}\n`);
  });
}

export async function appendBitgetSymbolToWatchlist(
  watchlistPath: string,
  input: { symbol: string; instType: string; label?: string | null; group?: string; showCollapsed?: boolean },
): Promise<boolean> {
  const sourcePath = path.resolve(expandUserPath(watchlistPath));
  const symbol = normalizeBitgetSymbol(input.symbol);
  const instType = normalizeBitgetInstType(input.instType);
  const group = normalizeGroup(input.group ?? "crypto");
  const config = await loadConfig(sourcePath);
  if (config.instruments.some((instrument) => instrument.source === BITGET_SOURCE && instrument.symbol === symbol && instrument.instType === instType)) {
    return false;
  }
  await appendEntryToSymbolsArray(
    sourcePath,
    formatBitgetEntry({
      symbol,
      instType,
      label: input.label,
      group,
      showCollapsed: input.showCollapsed ?? true,
    }),
  );
  return true;
}

export async function appendHyperliquidSymbolToWatchlist(
  watchlistPath: string,
  input: { symbol: string; label?: string | null; group?: string; showCollapsed?: boolean },
): Promise<boolean> {
  const sourcePath = path.resolve(expandUserPath(watchlistPath));
  const symbol = normalizeHyperliquidSymbol(input.symbol);
  const group = normalizeGroup(input.group ?? "crypto");
  const config = await loadConfig(sourcePath);
  if (config.instruments.some((instrument) => instrument.source === HYPERLIQUID_SOURCE && instrument.symbol === symbol)) {
    return false;
  }
  await appendEntryToSymbolsArray(
    sourcePath,
    formatHyperliquidEntry({
      symbol,
      label: input.label,
      group,
      showCollapsed: input.showCollapsed ?? true,
    }),
  );
  return true;
}

export async function removeSymbolFromWatchlist(
  watchlistPath: string,
  input: { source: string; symbol: string; instType?: string | null },
): Promise<boolean> {
  const sourcePath = path.resolve(expandUserPath(watchlistPath));
  const source = input.source.trim().toLowerCase();
  const symbol = normalizeSymbolForSourceStrict(source, input.symbol);
  const instType = input.instType ? input.instType.trim().toUpperCase() : null;
  const config = await loadConfig(sourcePath);
  const exists = config.instruments.some(
    (instrument) => instrument.source === source && instrument.symbol === symbol && instrument.instType === instType,
  );
  if (!exists) return false;
  if (config.instruments.length <= 1) throw new Error("cannot remove the last watchlist symbol");
  return withWatchlistLock(async () => {
    const lines = (await readFile(sourcePath, "utf8")).split(/\r?\n/);
    const index = lines.findIndex((line) => isSymbolEntry(line, { source, symbol, instType }));
    if (index < 0) throw new Error(`${source}:${symbol} exists but is not an inline symbol entry`);
    lines.splice(index, 1);
    await writeFile(sourcePath, `${lines.join("\n").replace(/\n*$/, "")}\n`);
    return true;
  });
}

function setInlineAnalysisInterval(line: string, interval: string): string {
  if (parseInlineSymbolEntry(line) === null) throw new Error("symbol entry is not an inline TOML table");
  const replacement = `analysis_interval = ${tomlString(interval)}`;
  if (line.includes("analysis_interval")) {
    return line.replace(/analysis_interval\s*=\s*[^,}]+/, replacement);
  }
  const stripped = line.trimEnd();
  const hasTrailingComma = stripped.endsWith(",");
  const body = hasTrailingComma ? stripped.slice(0, -1).trimEnd() : stripped;
  const closeIndex = body.lastIndexOf("}");
  if (closeIndex < 0) throw new Error("symbol entry is not an inline TOML table");
  const prefix = body.slice(0, closeIndex).trimEnd();
  const suffix = body.slice(closeIndex);
  const separator = prefix.endsWith("{") ? "" : ",";
  const updated = `${prefix}${separator} ${replacement} ${suffix}`;
  return hasTrailingComma ? `${updated},` : updated;
}

export async function reorderSymbolsInWatchlist(
  watchlistPath: string,
  orderedKeys: string[],
): Promise<boolean> {
  return withWatchlistLock(() => reorderSymbolsUnlocked(watchlistPath, orderedKeys));
}

async function reorderSymbolsUnlocked(
  watchlistPath: string,
  orderedKeys: string[],
): Promise<boolean> {
  const sourcePath = path.resolve(expandUserPath(watchlistPath));
  const text = await readFile(sourcePath, "utf8");
  const lines = text.split(/\r?\n/);

  // Find the symbols array bounds
  const startIndex = lines.findIndex((line) => line.trim().startsWith("symbols") && line.includes("["));
  if (startIndex < 0) return false;
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.trim() === "]");
  if (endIndex < 0) return false;

  // Extract all symbol entry lines (between `symbols = [` and `]`)
  const entryLines: Array<{ line: string; key: string }> = [];
  const nonEntryLines: string[] = [];
  for (let i = startIndex + 1; i < endIndex; i++) {
    const entry = parseInlineSymbolEntry(lines[i]);
    if (entry) {
      const source = entrySource(entry);
      const rawSymbol = String(entry.symbol || "");
      let normalizedSymbol = "";
      try {
        normalizedSymbol = normalizeSymbolForSourceStrict(source, rawSymbol);
      } catch {
        // If we can't normalize, keep the line in place
        nonEntryLines.push(lines[i]);
        continue;
      }
      const instType = entryInstType(entry);
      // Build key matching the MarketInstrument.key format
      let key: string;
      if (source === "hyperliquid") {
        key = `hyperliquid:${normalizedSymbol}`;
      } else {
        // Bitget key format: "INST_TYPE:SYMBOL"
        key = instType ? `${instType}:${normalizedSymbol}` : normalizedSymbol;
      }
      entryLines.push({ line: lines[i], key });
    } else if (lines[i].trim()) {
      // Non-entry lines (comments etc.) — keep at end
      nonEntryLines.push(lines[i]);
    }
  }

  // Reorder entry lines based on orderedKeys
  const entryMap = new Map<string, string>();
  for (const { line, key } of entryLines) {
    entryMap.set(key, line);
  }

  const reordered: string[] = [];
  const usedKeys = new Set<string>();

  // First, place entries in the requested order
  for (const key of orderedKeys) {
    const line = entryMap.get(key);
    if (line) {
      reordered.push(line);
      usedKeys.add(key);
    }
  }

  // Then append any entries not in the requested order (maintain their relative order)
  for (const { line, key } of entryLines) {
    if (!usedKeys.has(key)) {
      reordered.push(line);
    }
  }

  // Reconstruct the file
  const newLines = [
    ...lines.slice(0, startIndex + 1),
    ...nonEntryLines,
    ...reordered,
    ...lines.slice(endIndex),
  ];

  const result = `${newLines.join("\n").replace(/\n*$/, "")}\n`;
  if (result === text) return false;
  await writeFile(sourcePath, result);
  return true;
}

export async function updateInstrumentAnalysisIntervalInWatchlist(
  watchlistPath: string,
  input: { source: string; symbol: string; instType?: string | null; interval: string },
): Promise<boolean> {
  return withWatchlistLock(async () => {
    const sourcePath = path.resolve(expandUserPath(watchlistPath));
    const source = input.source.trim().toLowerCase();
    const symbol = normalizeSymbolForSource(source, input.symbol);
    const instType = input.instType ? input.instType.trim().toUpperCase() : null;
    const lines = (await readFile(sourcePath, "utf8")).split(/\r?\n/);
    const index = lines.findIndex((line) => isSymbolEntry(line, { source, symbol, instType }));
    if (index < 0) throw new Error(`${source}:${symbol} exists but is not an inline symbol entry`);
    const nextLine = setInlineAnalysisInterval(lines[index], input.interval);
    if (nextLine === lines[index]) return false;
    lines[index] = nextLine;
    await writeFile(sourcePath, `${lines.join("\n").replace(/\n*$/, "")}\n`);
    return true;
  });
}

function replaceTopLevelTable(text: string, tableName: string, nextLines: string[]): string {
  const lines = text.split(/\r?\n/);
  const header = `[${tableName}]`;
  const subPrefix = `[${tableName}.`;
  const startIndex = lines.findIndex((line) => line.trim() === header);
  if (startIndex < 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim()) lines.push("");
    lines.push(...nextLines);
    return `${lines.join("\n").replace(/\n*$/, "")}\n`;
  }
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const stripped = lines[index].trim();
    if (stripped.startsWith("[") && stripped.endsWith("]") && !stripped.startsWith(subPrefix)) {
      endIndex = index;
      break;
    }
  }
  lines.splice(startIndex, endIndex - startIndex, ...nextLines);
  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

export async function updateAgentConfigInWatchlist(watchlistPath: string, config: AgentConfig): Promise<boolean> {
  const lines = [
    "[agent]",
    `enabled = ${config.enabled ? "true" : "false"}`,
    `default_provider = ${tomlString(config.provider)}`,
    `default_model = ${tomlString(config.model)}`,
    `system_prompt = ${tomlString(config.systemPrompt)}`,
    `max_candles = ${config.maxCandles}`,
    `candle_context_mode = ${tomlString(config.candleContextMode)}`,
  ];
  for (const [name, profile] of Object.entries(config.providerProfiles)) {
    lines.push("", `[agent.providers.${tomlKey(name)}]`, `enabled = ${profile.enabled ? "true" : "false"}`);
    lines.push(`api = ${tomlString(profile.api)}`);
    if (profile.displayName) lines.push(`display_name = ${tomlString(profile.displayName)}`);
    lines.push(`requires_auth = ${profile.requiresAuth ? "true" : "false"}`);
    // Only the original source value may be persisted. apiKey can contain an
    // expanded environment secret and must never be used as a serialization fallback.
    if (profile.apiKeyRaw) lines.push(`api_key = ${tomlString(profile.apiKeyRaw)}`);
    if (profile.baseUrl) lines.push(`base_url = ${tomlString(profile.baseUrl)}`);
    lines.push(`models = [${profile.models.map(tomlString).join(", ")}]`);
    if (profile.modelEfforts.length > 0) {
      lines.push(`model_efforts = {${profile.modelEfforts.map(([slug, effort]) => `${tomlString(slug)} = ${tomlString(effort)}`).join(", ")}}`);
    }
    if (profile.customModels.length > 0) {
      lines.push(`custom_models = [${profile.customModels.map(tomlString).join(", ")}]`);
    }
    if (profile.customModelDefinitions.length > 0) {
      lines.push(`custom_model_definitions = [${profile.customModelDefinitions.map(tomlCustomModelDefinition).join(", ")}]`);
    }
  }
  return replaceTable(watchlistPath, "agent", lines);
}

export function formatAnalysisConfig(config: AnalysisConfig): string[] {
  return [
    "[analysis]",
    `enabled = ${config.enabled ? "true" : "false"}`,
    `interval = ${tomlString(config.interval)}`,
    `lookback = ${config.lookback}`,
    `poll_interval_seconds = ${config.pollIntervalSeconds}`,
    `stale_after_seconds = ${config.staleAfterSeconds}`,
  ];
}

export async function updateAnalysisConfigInWatchlist(watchlistPath: string, config: AnalysisConfig): Promise<boolean> {
  return replaceTable(watchlistPath, "analysis", formatAnalysisConfig(config));
}

export async function updateNewsConfigInWatchlist(watchlistPath: string, config: NewsConfig): Promise<boolean> {
  return replaceTable(watchlistPath, "news", [
    "[news]",
    `enabled = ${config.enabled ? "true" : "false"}`,
    `poll_interval_seconds = ${config.pollIntervalSeconds}`,
    `max_interval_seconds = ${config.maxIntervalSeconds}`,
    `reuters_url = ${tomlString(config.reutersUrl)}`,
    `request_timeout_seconds = ${config.requestTimeoutSeconds}`,
    `retention_days = ${config.retentionDays}`,
    `recent_limit = ${config.recentLimit}`,
  ]);
}

export async function updateTradingConfigInWatchlist(watchlistPath: string, config: TradingConfig): Promise<boolean> {
  return replaceTable(watchlistPath, "trading", [
    "[trading]",
    `hyperliquid_mode = "${config.hyperliquidMode}"`,
    `bitget_mode = "${config.bitgetMode}"`,
  ]);
}

export async function updateJin10ConfigInWatchlist(watchlistPath: string, config: Jin10Config): Promise<boolean> {
  const lines = [
    "[jin10]",
    `enabled = ${config.enabled ? "true" : "false"}`,
    `token = ${tomlString(config.token)}`,
    `flash_enabled = ${config.flashEnabled ? "true" : "false"}`,
    `flash_poll_interval_seconds = ${config.flashPollIntervalSeconds}`,
    `calendar_enabled = ${config.calendarEnabled ? "true" : "false"}`,
    `calendar_poll_interval_seconds = ${config.calendarPollIntervalSeconds}`,
    `quotes_enabled = ${config.quotesEnabled ? "true" : "false"}`,
    `quotes_poll_interval_seconds = ${config.quotesPollIntervalSeconds}`,
    `quotes_codes = [${config.quotesCodes.map(tomlString).join(", ")}]`,
    `agent_analysis = ${config.agentAnalysis ? "true" : "false"}`,
  ];
  return replaceTable(watchlistPath, "jin10", lines);
}

export async function updateProxyConfigInWatchlist(watchlistPath: string, config: ProxyConfig): Promise<boolean> {
  const lines = [
    "[proxy]",
    `enabled = ${config.enabled ? "true" : "false"}`,
    `type = ${tomlString(config.type)}`,
    `host = ${tomlString(config.host)}`,
    `port = ${config.port}`,
    `username = ${tomlString(config.username)}`,
    `password = ${tomlString(config.password)}`,
  ];
  return replaceTable(watchlistPath, "proxy", lines);
}

export async function updateOptionsConfigInWatchlist(watchlistPath: string, config: OptionsConfig): Promise<boolean> {
  const lines = [
    "[options]",
    `enabled = ${config.enabled ? "true" : "false"}`,
    `provider = ${tomlString(config.provider)}`,
    `symbols = [${config.symbols.map(tomlString).join(", ")}]`,
    `poll_interval_seconds = ${config.pollIntervalSeconds}`,
    `strike_range_percent = ${config.strikeRangePercent}`,
    `risk_free_rate = ${config.riskFreeRate}`,
    `dividend_yield = ${config.dividendYield}`,
  ];
  if (config.tradier) {
    lines.push("", "[options.tradier]", `api_key = ${tomlString(config.tradier.apiKey)}`, `base_url = ${tomlString(config.tradier.baseUrl)}`);
  }
  if (config.marketdata && config.marketdata.apiKey) {
    // Prefer the raw "${ENV}" reference so we never write a resolved secret to disk.
    const mdKey = config.marketdata.apiKeyRaw || config.marketdata.apiKey;
    lines.push("", "[options.marketdata]", `api_key = ${tomlString(mdKey)}`, `base_url = ${tomlString(config.marketdata.baseUrl)}`);
    if (config.marketdata.strikeLimit != null) lines.push(`strike_limit = ${config.marketdata.strikeLimit}`);
    if (config.marketdata.dte != null) lines.push(`dte = ${config.marketdata.dte}`);
    if (config.marketdata.callsPerMinute != null) lines.push(`calls_per_minute = ${config.marketdata.callsPerMinute}`);
  }
  if (config.deribit) {
    lines.push("", "[options.deribit]", `enabled = ${config.deribit.enabled ? "true" : "false"}`, `currencies = [${config.deribit.currencies.map(tomlString).join(", ")}]`);
  }
  lines.push(
    "",
    "[options.alerts]",
    `min_oi_change = ${config.alerts.minOiChange}`,
    `min_volume_oi_ratio = ${config.alerts.minVolumeOiRatio}`,
    `min_premium = ${config.alerts.minPremium}`,
  );
  return replaceTable(watchlistPath, "options", lines);
}

async function replaceTable(watchlistPath: string, tableName: string, lines: string[]): Promise<boolean> {
  return withWatchlistLock(async () => {
    const sourcePath = path.resolve(expandUserPath(watchlistPath));
    const text = await readFile(sourcePath, "utf8");
    const rendered = replaceTopLevelTable(text, tableName, lines);
    if (rendered === text) return false;
    await writeFile(sourcePath, rendered);
    return true;
  });
}
