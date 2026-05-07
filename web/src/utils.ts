import type {
  AgentMessage,
  AgentStreamPayload,
  CandlePoint,
  Instrument,
  InstrumentSearchResult,
  MarketState,
  Quote,
} from './types';
import {
  AGENT_CONTEXT_HASH,
  GROUP_LABELS,
  NEWS_HASH,
  PROVIDERS_HASH,
  SOCIAL_HASH,
  THEME_STORAGE_KEY,
  WATCHLIST_HASH,
  type AppRoute,
  type SearchSource,
  type SourceHint,
  type ThemeName,
} from './constants';
import {
  addAlpacaSymbol,
  addBitgetSymbol,
  addHyperliquidTestnetSymbol,
} from './api';

export function readInitialTheme(): ThemeName {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function nextTheme(theme: ThemeName): ThemeName {
  return theme === 'dark' ? 'light' : 'dark';
}

export function readRouteFromHash(): AppRoute {
  if (window.location.hash.startsWith(SOCIAL_HASH)) {
    return { view: 'settings', section: 'social' };
  }
  if (window.location.hash.startsWith(AGENT_CONTEXT_HASH)) {
    return { view: 'settings', section: 'agent-context' };
  }
  if (window.location.hash.startsWith(NEWS_HASH)) {
    return { view: 'settings', section: 'news' };
  }
  if (window.location.hash.startsWith(WATCHLIST_HASH)) {
    return { view: 'settings', section: 'watchlist' };
  }
  if (window.location.hash.startsWith(PROVIDERS_HASH)) {
    return { view: 'settings', section: 'providers' };
  }
  return { view: 'workspace' };
}

export function navigateToRoute(route: AppRoute) {
  if (route.view === 'settings') {
    const hash =
      route.section === 'social'
        ? SOCIAL_HASH
        : route.section === 'agent-context'
        ? AGENT_CONTEXT_HASH
        : route.section === 'news'
        ? NEWS_HASH
        : route.section === 'watchlist'
          ? WATCHLIST_HASH
          : PROVIDERS_HASH;
    window.location.hash = hash;
    return;
  }
  if (window.location.hash) {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    window.dispatchEvent(new Event('hashchange'));
  }
}

export function orderedGroups(state: MarketState | null) {
  if (!state) return [];
  const preferred = ['alpaca', 'bitget', 'hyperliquid-testnet'];
  const present = Object.keys(state.groups);
  return [
    ...preferred.filter((group) => present.includes(group)),
    ...present.filter((group) => !preferred.includes(group)).sort(),
  ];
}

export function changeClass(quote: Quote | undefined) {
  if (!quote || quote.change == null) return 'neutral';
  if (quote.change > 0) return 'up';
  if (quote.change < 0) return 'down';
  return 'neutral';
}

export function sourceLabel(instrument: Instrument | undefined) {
  if (!instrument) return '-';
  if (instrument.source === 'alpaca') return 'Alpaca';
  return instrument.source.toUpperCase();
}

export function sourceName(source: string) {
  if (source === 'alpaca') return 'Alpaca';
  if (source === 'hyperliquid-testnet') return 'Hyperliquid Testnet';
  return source.toUpperCase();
}

export function instrumentVenue(instrument: Instrument) {
  if (instrument.source === 'bitget') {
    return instrument.instType ?? instrument.key.split(':', 1)[0] ?? 'Bitget';
  }
  return sourceName(instrument.source);
}

export function watchlistSectionLabel(source: string) {
  return GROUP_LABELS[source] ?? sourceName(source);
}

export function watchlistSections(instruments: Instrument[]) {
  const preferred = ['alpaca', 'bitget', 'hyperliquid-testnet'];
  const sources = [
    ...preferred.filter((source) => instruments.some((instrument) => instrument.source === source)),
    ...Array.from(new Set(instruments.map((instrument) => instrument.source)))
      .filter((source) => !preferred.includes(source))
      .sort(),
  ];
  return sources.map((source) => ({
    source,
    label: watchlistSectionLabel(source),
    instruments: instruments.filter((instrument) => instrument.source === source),
  }));
}

export type BulkEntry = {
  raw: string;
  source: SearchSource;
  symbol: string;
  label: string;
  instType: string | null;
  key: string;
  valid: boolean;
  exists: boolean;
  inputDuplicate: boolean;
  error: string | null;
};

function defaultBitgetLabel(symbol: string) {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) || symbol : symbol;
}

function parseBulkLine(raw: string, activeKeys: Set<string>): Omit<BulkEntry, 'inputDuplicate'> | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const [token = '', ...labelParts] = trimmed.split(/\s+/);
  const explicitLabel = labelParts.join(' ').trim();
  let sourceHint: SourceHint | null = null;
  let body = token.trim();
  const sourceMatch = body.match(/^(bitget|alpaca|hyperliquid-testnet|hyperliquid)[:/](.+)$/i);
  if (sourceMatch) {
    const hint = sourceMatch[1].toLowerCase();
    sourceHint = (hint === 'hyperliquid' ? 'hyperliquid-testnet' : hint) as SourceHint;
    body = sourceMatch[2];
  }

  const upperBody = body.toUpperCase();
  let source: SearchSource;
  let symbol: string;
  let instType: string | null = null;

  if (sourceHint === 'hyperliquid-testnet') {
    source = 'hyperliquid-testnet';
    symbol = upperBody;
    if (!symbol) {
      return {
        raw: trimmed, source, symbol, label: explicitLabel || upperBody, instType,
        key: `hyperliquid-testnet:${symbol}`, valid: false, exists: false,
        error: 'Hyperliquid coin cannot be blank.',
      };
    }
  } else if (sourceHint === 'alpaca' || (!sourceHint && upperBody.endsWith('.US'))) {
    source = 'alpaca';
    symbol = upperBody.endsWith('.US') ? upperBody.slice(0, -3) : upperBody;
    if (!symbol) {
      return {
        raw: trimmed, source, symbol, label: explicitLabel || upperBody, instType,
        key: `alpaca:${symbol}`, valid: false, exists: false,
        error: 'Alpaca symbol cannot be blank.',
      };
    }
  } else {
    source = 'bitget';
    const parts = upperBody.split(':');
    if (parts.length === 2) {
      instType = parts[0];
      symbol = parts[1];
    } else {
      instType = 'USDT-FUTURES';
      symbol = upperBody;
    }
    if (!['SPOT', 'USDT-FUTURES'].includes(instType) || !symbol) {
      return {
        raw: trimmed, source, symbol, label: explicitLabel || defaultBitgetLabel(symbol), instType,
        key: `${instType}:${symbol}`, valid: false, exists: false,
        error: 'Unsupported Bitget market.',
      };
    }
  }

  let label = explicitLabel || defaultBitgetLabel(symbol);
  if (!explicitLabel && source === 'alpaca') label = symbol;
  if (!explicitLabel && source === 'hyperliquid-testnet') label = `${symbol} Perp`;
  const key =
    source === 'alpaca'
      ? `alpaca:${symbol}`
      : source === 'hyperliquid-testnet'
        ? `hyperliquid-testnet:${symbol}`
        : `${instType}:${symbol}`;
  return { raw: trimmed, source, symbol, label, instType, key, valid: true, exists: activeKeys.has(key), error: null };
}

export function parseBulkEntries(text: string, state: MarketState | null): BulkEntry[] {
  const activeKeys = new Set((state?.instruments ?? []).map((instrument) => instrument.key));
  const seen = new Set<string>();
  const entries: BulkEntry[] = [];
  for (const raw of text.split(/[\n,]+/)) {
    const parsed = parseBulkLine(raw, activeKeys);
    if (!parsed) continue;
    const inputDuplicate = parsed.valid && seen.has(parsed.key);
    if (parsed.valid) seen.add(parsed.key);
    entries.push({ ...parsed, inputDuplicate });
  }
  return entries;
}

export function resultFromBulkEntry(entry: BulkEntry): InstrumentSearchResult {
  return {
    source: entry.source,
    symbol: entry.symbol,
    label: entry.label,
    instType: entry.instType,
    key: entry.key,
    nameCn: '', nameHk: '', nameEn: '',
    displayText:
      entry.source === 'bitget'
        ? `${entry.instType} · ${entry.symbol}`
        : entry.source === 'hyperliquid-testnet'
          ? `Testnet perp · ${entry.symbol}/USDC`
          : entry.symbol,
    exists: entry.exists,
  };
}

export function addInstrumentBySource(result: InstrumentSearchResult) {
  if (result.source === 'bitget') return addBitgetSymbol(result);
  if (result.source === 'hyperliquid-testnet') return addHyperliquidTestnetSymbol(result);
  return addAlpacaSymbol(result);
}

export function formatLevelPrice(price: number | null) {
  if (price == null) return '-';
  return price.toFixed(price > 1000 ? 1 : 2);
}

export function formatContextWindow(size: number | null) {
  if (size == null) return '-';
  if (size >= 1000) return `${Math.round(size / 1000)}K`;
  return String(size);
}

export function formatSignedNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}`;
}

export function candleRangeLabel(candles: CandlePoint[]) {
  if (candles.length === 0) return '-';
  const low = Math.min(...candles.map((item) => item.low));
  const high = Math.max(...candles.map((item) => item.high));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return '-';
  return `${formatLevelPrice(low)} / ${formatLevelPrice(high)}`;
}

export function closeDeltaPercent(candles: CandlePoint[]) {
  if (candles.length < 2) return null;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  if (!Number.isFinite(first) || first === 0 || !Number.isFinite(last)) return null;
  return ((last - first) / Math.abs(first)) * 100;
}

export function upsertAgentMessage(messages: AgentMessage[], message: AgentMessage) {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  const next = messages.slice();
  next[index] = { ...next[index], ...message };
  return next;
}

export function streamMessageToAgentMessage(
  raw: Extract<AgentStreamPayload, { message: unknown }>['message'],
  fallback: { id: number; sessionId: string; createdAt: string },
): AgentMessage {
  return {
    id: typeof raw.id === 'number' ? raw.id : fallback.id,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : fallback.sessionId,
    role: raw.role,
    content: raw.content,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : fallback.createdAt,
    metadata: raw.metadata ?? null,
    error: raw.error ?? null,
  };
}
