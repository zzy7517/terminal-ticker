import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bot,
  ChevronsLeft,
  ChevronsRight,
  ChartNoAxesCombined,
  CircleDot,
  EyeOff,
  Eraser,
  History,
  KeyRound,
  Loader2,
  LockKeyhole,
  Minus,
  Moon,
  MousePointer2,
  Newspaper,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sparkles,
  Sun,
  Trash2,
  TrendingUp,
  Wifi,
  WifiOff,
  Zap,
} from 'lucide-react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  addAlpacaSymbol,
  addBitgetSymbol,
  addHyperliquidTestnetSymbol,
  cancelExchangeOrder,
  connectStateSocket,
  deleteAgentSession,
  fetchAgentSession,
  fetchAgentSessionHistory,
  fetchRecentSocialFeed,
  fetchSocialAuthStatus,
  fetchAgentModels,
  fetchState,
  getTradeDetail,
  listLessons,
  listTrades,
  loadOlderCandles,
  removeWatchlistInstrument,
  resetAgentSession,
  resumeAgentSession,
  saveAgentConfig,
  saveInstrumentAnalysisInterval,
  saveNewsConfig,
  saveSocialAuth,
  saveSocialFeedConfig,
  searchInstruments,
  sendAgentMessage,
  clearSocialAuth,
  triggerNewsRefresh,
  triggerXFollowingRefresh,
  triggerTradeReview,
} from './api';
import type {
  AgentAnalysis,
  AgentConfigUpdate,
  AgentMessage,
  AgentModelOption,
  AgentSessionResponse,
  AgentSessionSummary,
  CandlePoint,
  ExchangeOrder,
  ExchangePosition,
  Instrument,
  InstrumentSearchResult,
  Lesson,
  LoopStep,
  MarketState,
  NewsConfigUpdate,
  NewsDecision,
  NewsItem,
  Quote,
  SocialAuthStatus,
  SocialFeedItem,
  Trade,
  TradeDetailResponse,
} from './types';
import { useChartDrawings } from './chartDrawings';

const GROUP_LABELS: Record<string, string> = {
  alpaca: 'Alpaca',
  bitget: 'Bitget',
  'hyperliquid-testnet': 'Hyperliquid Testnet',
};

const REASONING_OPTIONS = ['low', 'medium', 'high', 'xhigh'];
const DEFAULT_ANTHROPIC_MODEL = 'global.anthropic.claude-opus-4-6-v1';
const AGENT_PROVIDER_OPTIONS = [
  {
    provider: 'codex',
    label: 'Codex',
    apiMode: 'codex_responses',
    defaultModel: 'gpt-5.4-mini',
    description: 'Responses adapter for chart analysis',
    detail: 'Codex Responses adapter used by the chart agent for structured commentary and watch-plan output.',
    supportsReasoning: true,
  },
  {
    provider: 'anthropic',
    label: 'Anthropic',
    apiMode: 'anthropic_messages',
    defaultModel: DEFAULT_ANTHROPIC_MODEL,
    description: 'Messages adapter via x-api-key',
    detail: 'Anthropic Messages adapter used by the chart agent through the configured Claude proxy endpoint.',
    supportsReasoning: false,
  },
] as const;
const PROVIDERS_HASH = '#/settings/providers';
const WATCHLIST_HASH = '#/settings/watchlist';
const NEWS_HASH = '#/settings/news';
const SOCIAL_HASH = '#/settings/social';
const THEME_STORAGE_KEY = 'mytradebot-theme';
const ANALYSIS_INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];
type SettingsSection = 'providers' | 'watchlist' | 'news' | 'social';
type SearchSource = 'bitget' | 'alpaca' | 'hyperliquid-testnet';
type SourceHint = SearchSource;
type ThemeName = 'light' | 'dark';

type AppRoute =
  | { view: 'workspace' }
  | { view: 'settings'; section: SettingsSection };

const THEME_LABELS: Record<ThemeName, string> = {
  light: 'Light',
  dark: 'Dark',
};

const CHART_THEMES = {
  light: {
    chart: {
      layout: {
        background: { type: ColorType.Solid, color: '#fbfcfb' },
        textColor: 'rgba(39, 49, 49, 0.64)',
        fontFamily: 'Aptos, "Avenir Next", "Segoe UI", sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(42, 66, 70, 0.07)' },
        horzLines: { color: 'rgba(42, 66, 70, 0.09)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(42, 66, 70, 0.14)',
        scaleMargins: { top: 0.12, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(42, 66, 70, 0.14)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(15, 124, 144, 0.38)' },
        horzLine: { color: 'rgba(15, 124, 144, 0.38)' },
      },
    },
    series: {
      upColor: '#2e9a66',
      downColor: '#c65047',
      wickUpColor: '#25885b',
      wickDownColor: '#b3433d',
      borderVisible: false,
    },
  },
  dark: {
    chart: {
      layout: {
        background: { type: ColorType.Solid, color: '#0e0f11' },
        textColor: 'rgba(186, 193, 204, 0.72)',
        fontFamily: 'Aptos, "Avenir Next", "Segoe UI", sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.06)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        scaleMargins: { top: 0.12, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(79, 140, 255, 0.42)' },
        horzLine: { color: 'rgba(79, 140, 255, 0.42)' },
      },
    },
    series: {
      upColor: '#00b076',
      downColor: '#ff4466',
      wickUpColor: '#00b076',
      wickDownColor: '#ff4466',
      borderVisible: false,
    },
  },
};

function readInitialTheme(): ThemeName {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function nextTheme(theme: ThemeName): ThemeName {
  return theme === 'dark' ? 'light' : 'dark';
}

// Converts the browser hash into the app's internal route shape.
function readRouteFromHash(): AppRoute {
  if (window.location.hash.startsWith(SOCIAL_HASH)) {
    return { view: 'settings', section: 'social' };
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

// Updates the browser hash while keeping the workspace route hash-free.
function navigateToRoute(route: AppRoute) {
  if (route.view === 'settings') {
    const hash =
      route.section === 'social'
        ? SOCIAL_HASH
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
    // replaceState does not emit hashchange, so notify the route listener explicitly.
    window.dispatchEvent(new Event('hashchange'));
  }
}

// Orders watchlist groups so common asset classes stay in predictable positions.
function orderedGroups(state: MarketState | null) {
  if (!state) return [];
  const preferred = ['alpaca', 'bitget', 'hyperliquid-testnet'];
  const present = Object.keys(state.groups);
  return [
    ...preferred.filter((group) => present.includes(group)),
    ...present.filter((group) => !preferred.includes(group)).sort(),
  ];
}

// Maps quote change direction to the CSS tone used across the UI.
function changeClass(quote: Quote | undefined) {
  if (!quote || quote.change == null) return 'neutral';
  if (quote.change > 0) return 'up';
  if (quote.change < 0) return 'down';
  return 'neutral';
}

// Returns the short source label shown beside an instrument.
function sourceLabel(instrument: Instrument | undefined) {
  if (!instrument) return '-';
  if (instrument.source === 'alpaca') return 'Alpaca';
  return instrument.source.toUpperCase();
}

// Formats a raw provider source identifier for settings and watchlist text.
function sourceName(source: string) {
  if (source === 'alpaca') return 'Alpaca';
  if (source === 'hyperliquid-testnet') return 'Hyperliquid Testnet';
  return source.toUpperCase();
}

// Returns the exchange or contract venue label for a watchlist instrument.
function instrumentVenue(instrument: Instrument) {
  if (instrument.source === 'bitget') {
    return instrument.instType ?? instrument.key.split(':', 1)[0] ?? 'Bitget';
  }
  return sourceName(instrument.source);
}

// Groups provider sources into the higher-level labels used in settings.
function watchlistSectionLabel(source: string) {
  return GROUP_LABELS[source] ?? sourceName(source);
}

// Builds provider sections while preserving a useful default source order.
function watchlistSections(instruments: Instrument[]) {
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

type BulkEntry = {
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

// Derives a compact default label from a Bitget symbol.
function defaultBitgetLabel(symbol: string) {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) || symbol : symbol;
}

// Parses one batch-import line into a normalized addable instrument candidate.
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
        raw: trimmed,
        source,
        symbol,
        label: explicitLabel || upperBody,
        instType,
        key: `hyperliquid-testnet:${symbol}`,
        valid: false,
        exists: false,
        error: 'Hyperliquid coin cannot be blank.',
      };
    }
  } else if (sourceHint === 'alpaca' || (!sourceHint && upperBody.endsWith('.US'))) {
    source = 'alpaca';
    symbol = upperBody.endsWith('.US') ? upperBody.slice(0, -3) : upperBody;
    if (!symbol) {
      return {
        raw: trimmed,
        source,
        symbol,
        label: explicitLabel || upperBody,
        instType,
        key: `alpaca:${symbol}`,
        valid: false,
        exists: false,
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
        raw: trimmed,
        source,
        symbol,
        label: explicitLabel || defaultBitgetLabel(symbol),
        instType,
        key: `${instType}:${symbol}`,
        valid: false,
        exists: false,
        error: 'Unsupported Bitget market.',
      };
    }
  }

  let label = explicitLabel || defaultBitgetLabel(symbol);
  if (!explicitLabel && source === 'alpaca') {
    label = symbol;
  }
  if (!explicitLabel && source === 'hyperliquid-testnet') {
    label = `${symbol} Perp`;
  }
  const key =
    source === 'alpaca'
      ? `alpaca:${symbol}`
      : source === 'hyperliquid-testnet'
        ? `hyperliquid-testnet:${symbol}`
        : `${instType}:${symbol}`;
  return {
    raw: trimmed,
    source,
    symbol,
    label,
    instType,
    key,
    valid: true,
    exists: activeKeys.has(key),
    error: null,
  };
}

// Parses the whole batch-import textbox and marks duplicates in the user's input.
function parseBulkEntries(text: string, state: MarketState | null): BulkEntry[] {
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

// Converts a validated batch row into the same shape returned by search.
function resultFromBulkEntry(entry: BulkEntry): InstrumentSearchResult {
  return {
    source: entry.source,
    symbol: entry.symbol,
    label: entry.label,
    instType: entry.instType,
    key: entry.key,
    nameCn: '',
    nameHk: '',
    nameEn: '',
    displayText:
      entry.source === 'bitget'
        ? `${entry.instType} · ${entry.symbol}`
        : entry.source === 'hyperliquid-testnet'
          ? `Testnet perp · ${entry.symbol}/USDC`
          : entry.symbol,
    exists: entry.exists,
  };
}

function addInstrumentBySource(result: InstrumentSearchResult) {
  if (result.source === 'bitget') return addBitgetSymbol(result);
  if (result.source === 'hyperliquid-testnet') return addHyperliquidTestnetSymbol(result);
  return addAlpacaSymbol(result);
}

// Formats support/resistance prices with compact precision.
function formatLevelPrice(price: number | null) {
  if (price == null) return '-';
  return price.toFixed(price > 1000 ? 1 : 2);
}

// Formats model context-window sizes for the provider settings table.
function formatContextWindow(size: number | null) {
  if (size == null) return '-';
  if (size >= 1000) return `${Math.round(size / 1000)}K`;
  return String(size);
}

// Formats signed percentage and delta values with a visible plus sign.
function formatSignedNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}`;
}

// Summarizes the visible candle window as low/high text.
function candleRangeLabel(candles: CandlePoint[]) {
  if (candles.length === 0) return '-';
  const low = Math.min(...candles.map((item) => item.low));
  const high = Math.max(...candles.map((item) => item.high));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return '-';
  return `${formatLevelPrice(low)} / ${formatLevelPrice(high)}`;
}

// Computes the percent move across the currently loaded candle window.
function closeDeltaPercent(candles: CandlePoint[]) {
  if (candles.length < 2) return null;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  if (!Number.isFinite(first) || first === 0 || !Number.isFinite(last)) return null;
  return ((last - first) / Math.abs(first)) * 100;
}


// Renders the live/offline connection state for the top bar.
function ConnectionBadge({ socketStatus, streamStatus }: { socketStatus: string; streamStatus: string }) {
  const connected = socketStatus === 'connected';
  return (
    <div className={`connection-badge ${connected ? 'live' : 'offline'}`}>
      {connected ? <Wifi size={15} /> : <WifiOff size={15} />}
      <span>{connected ? streamStatus : socketStatus}</span>
    </div>
  );
}

type ChartCandle = CandlestickData<UTCTimestamp>;

// Converts API candle payloads into the shape expected by Lightweight Charts.
function toChartCandles(candles: CandlePoint[]): ChartCandle[] {
  return candles.map((item) => ({
    time: item.time as UTCTimestamp,
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close,
  }));
}

// Compares two chart candles so incremental updates can avoid full redraws.
function sameChartCandle(left: ChartCandle, right: ChartCandle) {
  return (
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close
  );
}

// Detects whether the new dataset can be applied as a latest-candle update.
function canUpdateLatestCandle(previous: ChartCandle[], next: ChartCandle[]) {
  if (previous.length === 0 || next.length === 0) return false;
  if (next.length === previous.length) {
    for (let index = 0; index < previous.length - 1; index += 1) {
      if (!sameChartCandle(previous[index], next[index])) return false;
    }
    return next[next.length - 1].time >= previous[previous.length - 1].time;
  }
  if (next.length === previous.length + 1) {
    for (let index = 0; index < previous.length; index += 1) {
      if (!sameChartCandle(previous[index], next[index])) return false;
    }
    return next[next.length - 1].time > previous[previous.length - 1].time;
  }
  return false;
}

// Counts newly prepended historical candles while preserving the existing suffix.
function prependedCandleCount(previous: ChartCandle[], next: ChartCandle[]) {
  if (previous.length === 0 || next.length <= previous.length) return 0;
  const offset = next.length - previous.length;
  for (let index = 0; index < previous.length; index += 1) {
    if (!sameChartCandle(previous[index], next[index + offset])) return 0;
  }
  return offset;
}

// Builds a cheap data signature for avoiding duplicate chart writes.
function candleSignature(data: ChartCandle[]) {
  if (data.length === 0) return 'empty';
  return data
    .map((item) => [item.time, item.open, item.high, item.low, item.close].join(':'))
    .join('|');
}

// Computes a padded price range used as a fallback for manual axis zooming.
function priceRangeFromCandles(data: ChartCandle[]) {
  if (data.length === 0) return null;
  const low = Math.min(...data.map((item) => item.low));
  const high = Math.max(...data.map((item) => item.high));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const range = Math.max(high - low, Math.abs(high) * 0.01, 0.01);
  return {
    from: low - range * 0.12,
    to: high + range * 0.12,
  };
}

// Ensures the current interval stays selectable even if it is not in defaults.
function intervalOptions(currentInterval: string) {
  if (ANALYSIS_INTERVAL_OPTIONS.includes(currentInterval)) {
    return ANALYSIS_INTERVAL_OPTIONS;
  }
  return [currentInterval, ...ANALYSIS_INTERVAL_OPTIONS];
}


// Owns the main K-line chart instance and incremental data updates.
function CandlestickPane({
  candles,
  chartKey,
  theme,
  canLoadOlder,
  olderLoading,
  onLoadOlder,
}: {
  candles: CandlePoint[];
  chartKey: string;
  theme: ThemeName;
  canLoadOlder: boolean;
  olderLoading: boolean;
  onLoadOlder: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [chartApi, setChartApi] = useState<IChartApi | null>(null);
  const [seriesApi, setSeriesApi] = useState<ISeriesApi<'Candlestick'> | null>(null);
  const dataRef = useRef<ChartCandle[]>([]);
  const signatureRef = useRef('');
  const chartKeyRef = useRef('');
  const canLoadOlderRef = useRef(canLoadOlder);
  const olderLoadingRef = useRef(olderLoading);
  const onLoadOlderRef = useRef(onLoadOlder);
  const initialThemeRef = useRef(CHART_THEMES[theme]);
  const {
    activeTool,
    clearDrawings,
    deleteSelectedDrawing,
    hasDrawings,
    hasSelectedDrawing,
    setDrawingTool,
  } = useChartDrawings({
    chart: chartApi,
    chartKey,
    containerRef,
    series: seriesApi,
    theme,
  });

  useEffect(() => {
    canLoadOlderRef.current = canLoadOlder;
    olderLoadingRef.current = olderLoading;
    onLoadOlderRef.current = onLoadOlder;
  }, [canLoadOlder, olderLoading, onLoadOlder]);

  // Triggers historical pagination when the visible range nears the left edge.
  const maybeLoadOlder = (range: { from: number; to: number } | null) => {
    const logicalFrom = range?.from;
    const visibleSpan = range ? range.to - range.from : null;
    const dataLength = dataRef.current.length;
    if (
      logicalFrom == null ||
      logicalFrom > 8 ||
      visibleSpan == null ||
      dataLength === 0 ||
      visibleSpan >= dataLength - 1 ||
      !canLoadOlderRef.current ||
      olderLoadingRef.current
    ) {
      return;
    }
    onLoadOlderRef.current();
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const visualTheme = initialThemeRef.current;

    const chart = createChart(container, {
      autoSize: true,
      ...visualTheme.chart,
      rightPriceScale: {
        ...visualTheme.chart.rightPriceScale,
        autoScale: true,
      },
      localization: {
        priceFormatter: (price: number) => price.toFixed(price > 1000 ? 1 : 2),
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
      },
    });

    const series = chart.addSeries(CandlestickSeries, visualTheme.series);
    chartRef.current = chart;
    seriesRef.current = series;
    setChartApi(chart);
    setSeriesApi(series);

    // Implements price-axis zooming while leaving normal chart scrolling intact.
    const handleWheel = (event: WheelEvent) => {
      const chart = chartRef.current;
      const series = seriesRef.current;
      const container = containerRef.current;
      if (!chart || !series || !container) return;

      const bounds = container.getBoundingClientRect();
      const priceScaleWidth = chart.priceScale('right').width();
      const isPriceAxisWheel = event.clientX >= bounds.right - priceScaleWidth - 8;
      if (!event.shiftKey && !isPriceAxisWheel) return;

      const visibleRange = chart.priceScale('right').getVisibleRange() ?? priceRangeFromCandles(dataRef.current);
      if (!visibleRange) return;

      event.preventDefault();
      event.stopPropagation();
      const localY = event.clientY - bounds.top;
      const coordinatePrice = series.coordinateToPrice(localY);
      const anchorPrice =
        typeof coordinatePrice === 'number'
          ? coordinatePrice
          : (visibleRange.from + visibleRange.to) / 2;
      const zoomFactor = event.deltaY > 0 ? 1.12 : 0.88;
      const nextFrom = anchorPrice - (anchorPrice - visibleRange.from) * zoomFactor;
      const nextTo = anchorPrice + (visibleRange.to - anchorPrice) * zoomFactor;
      if (!Number.isFinite(nextFrom) || !Number.isFinite(nextTo) || nextTo - nextFrom <= 0) return;

      chart.priceScale('right').setAutoScale(false);
      chart.priceScale('right').setVisibleRange({ from: nextFrom, to: nextTo });
    };
    container.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    // Triggers historical pagination in sync with visible time changes.
    const handleLogicalRange = (range: { from: number; to: number } | null) => {
      maybeLoadOlder(range);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleLogicalRange);

    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true });
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleLogicalRange);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      setChartApi(null);
      setSeriesApi(null);
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const visualTheme = CHART_THEMES[theme];
    chart?.applyOptions(visualTheme.chart);
    series?.applyOptions(visualTheme.series);
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;

    const data = toChartCandles(candles);
    const nextSignature = `${chartKey}:${candleSignature(data)}`;
    if (nextSignature === signatureRef.current) return;

    const previous = dataRef.current;
    const resetSeries = chartKeyRef.current !== chartKey;
    const wasFollowingRealtime = previous.length === 0 || Math.abs(chart.timeScale().scrollPosition()) < 2;
    const prependedCount = prependedCandleCount(previous, data);
    const visibleLogicalRange =
      !resetSeries && prependedCount > 0 ? chart.timeScale().getVisibleLogicalRange() : null;

    if (resetSeries || data.length === 0 || !canUpdateLatestCandle(previous, data)) {
      series.setData(data);
      if (visibleLogicalRange) {
        chart.timeScale().setVisibleLogicalRange({
          from: visibleLogicalRange.from + prependedCount,
          to: visibleLogicalRange.to + prependedCount,
        });
      }
      if (data.length > 0 && (resetSeries || previous.length === 0)) {
        chart.priceScale('right').setAutoScale(true);
        chart.timeScale().fitContent();
      }
    } else {
      series.update(data[data.length - 1]);
      if (wasFollowingRealtime) {
        chart.timeScale().scrollToRealTime();
      }
    }

    dataRef.current = data;
    signatureRef.current = nextSignature;
    chartKeyRef.current = chartKey;
  }, [candles, chartKey]);

  return (
    <div className={`chart-shell ${activeTool !== 'cursor' ? 'drawing-active' : ''}`}>
      <div ref={containerRef} className="chart-canvas" />
      <div className="chart-overlay-toolbar" aria-label="Chart tools">
        <button
          aria-label="Cursor"
          className={`chart-action-button ${activeTool === 'cursor' ? 'active' : ''}`}
          onClick={() => setDrawingTool('cursor')}
          title="Cursor"
          type="button"
        >
          <MousePointer2 size={15} />
        </button>
        <button
          aria-label="Horizontal line"
          className={`chart-action-button ${activeTool === 'horizontal' ? 'active' : ''}`}
          onClick={() => setDrawingTool('horizontal')}
          title="Horizontal line"
          type="button"
        >
          <Minus size={16} />
        </button>
        <button
          aria-label="Trend line"
          className={`chart-action-button ${activeTool === 'trend' ? 'active' : ''}`}
          onClick={() => setDrawingTool('trend')}
          title="Trend line"
          type="button"
        >
          <TrendingUp size={15} />
        </button>
        <button
          aria-label="Fibonacci retracement"
          className={`chart-action-button ${activeTool === 'fibonacci' ? 'active' : ''}`}
          onClick={() => setDrawingTool('fibonacci')}
          title="Fibonacci retracement"
          type="button"
        >
          <ChartNoAxesCombined size={15} />
        </button>
        <span aria-hidden="true" className="chart-tool-divider" />
        <button
          aria-label="Delete selected drawing"
          className="chart-action-button danger"
          disabled={!hasSelectedDrawing}
          onClick={deleteSelectedDrawing}
          title="Delete selected drawing"
          type="button"
        >
          <Eraser size={15} />
        </button>
        <button
          aria-label="Clear drawings"
          className="chart-action-button danger"
          disabled={!hasDrawings}
          onClick={clearDrawings}
          title="Clear drawings"
          type="button"
        >
          <Trash2 size={15} />
        </button>
        <span aria-hidden="true" className="chart-tool-divider" />
        <button
          aria-label="Load older candles"
          className="chart-action-button"
          disabled={!canLoadOlder || olderLoading}
          onClick={onLoadOlder}
          title="Load older candles"
          type="button"
        >
          {olderLoading ? <Loader2 className="spin" size={15} /> : <History size={15} />}
        </button>
      </div>
      {candles.length === 0 && (
        <div className="chart-empty">
          <BarChart3 size={28} />
          <span>等待 K 线数据</span>
        </div>
      )}
    </div>
  );
}


// Renders one compact watchlist row: name/code, price, and 24h change.
function WatchlistRow({
  instrument,
  quote,
  selected,
  onSelect,
}: {
  instrument: Instrument;
  quote: Quote | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button className={`watch-row ${selected ? 'selected' : ''}`} onClick={onSelect} type="button">
      <div className="watch-left">
        <span className="watch-label">{instrument.label}</span>
        <small className="watch-code">{instrument.symbol}</small>
      </div>
      <div className="watch-right">
        <span className="watch-price">{quote?.priceLabel ?? '-'}</span>
        <span className={`watch-change ${changeClass(quote)}`}>{quote?.percentLabel ?? '-'}</span>
      </div>
    </button>
  );
}

function formatRelativeTime(iso: string): string {
  const publishedAt = new Date(iso).getTime();
  if (Number.isNaN(publishedAt)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - publishedAt) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

type LocalNewsItems = {
  items: NewsItem[];
  upstreamSignature: string;
};

function newsItemsSignature(items: NewsItem[]): string {
  return items.map((item) => `${item.url}|${item.publishedAtMs}|${item.title}`).join('\n');
}

// 把 news_url → 该新闻的所有决策（按品种）建索引，避免每条 item 都遍历整个列表。
function indexDecisionsByUrl(
  decisions: NewsDecision[] | undefined,
): Map<string, NewsDecision[]> {
  const map = new Map<string, NewsDecision[]>();
  if (!decisions) return map;
  for (const d of decisions) {
    const arr = map.get(d.news_url) ?? [];
    arr.push(d);
    map.set(d.news_url, arr);
  }
  return map;
}

// 单条决策的紧凑 badge：颜色 + step 标签 + (可选) 品种 + 方向。
function DecisionBadge({ decision }: { decision: NewsDecision }) {
  const stepLabels: Record<NewsDecision['step'], string> = {
    opened: '已下单',
    cooldown: '冷却中',
    low_confidence: '置信度低',
    entry_too_far: '价偏离',
    gated: '规则拦',
    llm_error: 'LLM 错',
    filter_miss: '未命中',
  };
  // 品种 key 只取尾段更短，alpaca:SPY → SPY
  const symbol = decision.instrument_key.split(':').pop() ?? decision.instrument_key;
  const dir = decision.direction;
  const className = `news-decision-badge news-decision-badge--${decision.step}${
    dir === 'long' ? ' news-decision-badge--long'
      : dir === 'short' ? ' news-decision-badge--short' : ''
  }`;
  const tooltip = decision.reason || stepLabels[decision.step];
  return (
    <span className={className} title={tooltip}>
      {symbol} · {stepLabels[decision.step]}
      {decision.step === 'opened' && dir && (
        <span className="news-decision-badge__dir">
          {' '}{dir === 'long' ? '↑' : '↓'}
        </span>
      )}
    </span>
  );
}

function NewsPanel({
  items,
  decisions,
  lastStatus,
  lastError,
}: {
  items: NewsItem[];
  decisions?: NewsDecision[];
  lastStatus?: string;
  lastError?: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [localItems, setLocalItems] = useState<LocalNewsItems | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const upstreamSignature = useMemo(() => newsItemsSignature(items), [items]);
  const displayItems = localItems?.items ?? items;
  const decisionIndex = useMemo(() => indexDecisionsByUrl(decisions), [decisions]);

  useEffect(() => {
    if (localItems && upstreamSignature !== localItems.upstreamSignature) {
      setLocalItems(null);
    }
  }, [localItems, upstreamSignature]);

  const handleRefresh = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setFeedback(null);
    try {
      const result = await triggerNewsRefresh();
      setLocalItems({
        items: result.news,
        upstreamSignature,
      });
      if (result.error) {
        setFeedback(`${result.status}: ${result.error}`);
      } else if (result.stale) {
        setFeedback('refresh timed out; showing cached items');
      } else if (result.inserted > 0) {
        setFeedback(`added ${result.inserted} new items`);
      } else {
        setFeedback('no new items');
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'refresh failed');
    } finally {
      setLoading(false);
    }
  }, [loading, upstreamSignature]);

  return (
    <div className="news-panel">
      <div className="news-panel__head">
        <span className="news-panel__title">Reuters</span>
        <button
          className="news-refresh-btn"
          onClick={handleRefresh}
          disabled={loading}
          type="button"
        >
          {loading ? '刷新中…' : '立即刷新'}
        </button>
      </div>
      {feedback && <div className="news-panel__feedback">{feedback}</div>}
      {!feedback && lastStatus && lastStatus !== 'ok' && lastStatus !== 'not_modified' && (
        <div className="news-panel__feedback">{lastStatus}{lastError ? `: ${lastError}` : ''}</div>
      )}
      <div className="news-panel__list">
        {displayItems.length === 0 && (
          <div className="news-panel__empty">暂无新闻，点击"立即刷新"拉取。</div>
        )}
        {displayItems.map((item) => {
          const itemDecisions = decisionIndex.get(item.url) ?? [];
          return (
            <a
              className="news-item"
              href={item.url}
              key={item.url}
              target="_blank"
              rel="noreferrer"
              title={item.title}
            >
              <div className="news-item__title">{item.title}</div>
              {item.summary && (
                <div className="news-item__summary">{item.summary}</div>
              )}
              <div className="news-item__meta">
                <span>{formatRelativeTime(item.publishedAt)}</span>
                {item.keywords.length > 0 && (
                  <span className="news-item__keywords">· {item.keywords.slice(0, 3).join(' · ')}</span>
                )}
              </div>
              {itemDecisions.length > 0 && (
                <div className="news-item__decisions">
                  {itemDecisions.map((d) => (
                    <DecisionBadge key={d.id} decision={d} />
                  ))}
                </div>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}


const SOCIAL_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

function SocialFeedPanel({ state }: { state: MarketState | null }) {
  const enabled = state?.config.socialFeed?.enabled ?? false;
  const [items, setItems] = useState<SocialFeedItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);

  const loadFeed = useCallback(async () => {
    setLoading(true);
    try {
      const feed = await fetchRecentSocialFeed(40);
      setItems(feed);
      setFeedback(null);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to load feed');
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshFeed = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setFeedback(null);
    try {
      const result = await triggerXFollowingRefresh(20);
      const feed = await fetchRecentSocialFeed(40);
      setItems(feed);
      setLastRefreshed(Date.now());
      if (result.status === 'ok') {
        setFeedback(result.inserted > 0 ? `${result.inserted} new items` : 'no new items');
      } else {
        setFeedback(`${result.status}: ${result.error ?? 'unknown'}`);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  useEffect(() => {
    if (!enabled) return;
    void loadFeed();
  }, [enabled, loadFeed]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => void refreshFeed(), SOCIAL_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, refreshFeed]);

  if (!enabled) {
    return (
      <div className="social-tab-panel">
        <div className="social-tab-panel__empty">
          Social feed is disabled. Enable it in <strong>Settings → Social</strong>.
        </div>
      </div>
    );
  }

  return (
    <div className="social-tab-panel">
      <div className="social-tab-panel__head">
        <span className="social-tab-panel__title">X Following</span>
        <div className="social-tab-panel__actions">
          {lastRefreshed && (
            <span className="social-tab-panel__last-refresh">
              Last: {new Date(lastRefreshed).toLocaleTimeString()}
            </span>
          )}
          <button
            className="news-refresh-btn"
            onClick={() => void refreshFeed()}
            disabled={refreshing || loading}
            type="button"
          >
            {refreshing ? '刷新中…' : '立即刷新'}
          </button>
        </div>
      </div>
      {feedback && <div className="social-tab-panel__feedback">{feedback}</div>}
      {loading && items.length === 0 && (
        <div className="social-tab-panel__empty">
          <Loader2 className="spin" size={16} /> Loading feed…
        </div>
      )}
      <div className="social-tab-panel__list">
        {items.map((item) => (
          <a
            className="social-feed-item"
            href={item.url}
            key={`${item.source}:${item.externalId}`}
            target="_blank"
            rel="noreferrer"
          >
            <div className="social-feed-item__header">
              {item.author.profileImageUrl && (
                <img
                  className="social-feed-item__avatar"
                  src={item.author.profileImageUrl}
                  alt=""
                  loading="lazy"
                />
              )}
              <strong className="social-feed-item__handle">
                @{item.author.handle}
                {item.author.verified && <Sparkles size={12} className="social-feed-item__verified" />}
              </strong>
              <span className="social-feed-item__name">{item.author.name}</span>
              <time className="social-feed-item__time">{formatRelativeTime(item.createdAt)}</time>
            </div>
            <div className="social-feed-item__text">{item.text}</div>
          </a>
        ))}
        {!loading && items.length === 0 && (
          <div className="social-tab-panel__empty">暂无推文，点击"立即刷新"拉取。</div>
        )}
      </div>
    </div>
  );
}

// Renders one compact chart statistic tile.
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// Provides the shared navigation shell for all settings sections.
function SettingsFrame({
  state,
  section,
  onSection,
  onBack,
  children,
}: {
  state: MarketState | null;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <main className="app-shell settings-shell-page">
      <section className="settings-frame">
        <aside className="settings-nav">
          <div className="settings-nav-top">
            <div>
              <div className="eyebrow">System Settings</div>
              <h3>Settings</h3>
            </div>
          </div>

          <div className="settings-nav-group">
            <button
              className={`settings-nav-item ${section === 'providers' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('providers')}
            >
              <Settings size={18} />
              <span>Providers</span>
            </button>
            <button
              className={`settings-nav-item ${section === 'watchlist' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('watchlist')}
            >
              <CircleDot size={18} />
              <span>Watchlist</span>
            </button>
            <button
              className={`settings-nav-item ${section === 'news' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('news')}
            >
              <Newspaper size={18} />
              <span>News</span>
            </button>
            <button
              className={`settings-nav-item ${section === 'social' ? 'active' : ''}`}
              type="button"
              onClick={() => onSection('social')}
            >
              <KeyRound size={18} />
              <span>Social</span>
            </button>
          </div>

          <div className="settings-nav-meta">
            <span className="panel-label">Source</span>
            <strong>{state?.config.sourcePath ?? 'Runtime only'}</strong>
          </div>

          <button className="settings-back" type="button" onClick={onBack}>
            <ArrowLeft size={16} />
            Back to workspace
          </button>
        </aside>

        <section className="settings-stage">{children}</section>
      </section>
    </main>
  );
}

// Handles watchlist search, batch add, removal, and persistence feedback.
function WatchlistSettingsPanel({
  state,
  onState,
}: {
  state: MarketState | null;
  onState: (state: MarketState) => void;
}) {
  const [searchSource, setSearchSource] = useState<SearchSource>('bitget');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<InstrumentSearchResult[]>([]);
  const [status, setStatus] = useState('Watchlist changes are saved to the local TOML file.');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkText, setBulkText] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const entries = useMemo(() => parseBulkEntries(bulkText, state), [bulkText, state]);
  const addableEntries = entries.filter((entry) => entry.valid && !entry.exists && !entry.inputDuplicate);
  const editable = Boolean(state?.config.sourcePath);
  const sections = useMemo(() => watchlistSections(state?.instruments ?? []), [state?.instruments]);

  async function addWatchlistResult(result: InstrumentSearchResult) {
    if (result.source === 'bitget') return addBitgetSymbol(result);
    if (result.source === 'hyperliquid-testnet') return addHyperliquidTestnetSymbol(result);
    return addAlpacaSymbol(result);
  }

  // Adds one search result to the local watchlist configuration.
  async function addResult(result: InstrumentSearchResult) {
    if (result.exists || busyKey) return;
    if (result.source === 'bitget' && !result.instType) {
      setStatus('Bitget result is missing instType.');
      return;
    }
    setBusyKey(result.key);
    setStatus(`Adding ${result.symbol}...`);
    try {
      const nextState = await addWatchlistResult(result);
      onState(nextState);
      setResults((items) =>
        items.map((item) => (item.key === result.key ? { ...item, exists: true } : item)),
      );
      setStatus(`Added ${result.symbol}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Add failed.');
    } finally {
      setBusyKey(null);
    }
  }

  // Removes one active instrument while preserving the one-symbol minimum.
  async function removeInstrument(instrument: Instrument) {
    if (!editable || busyKey) return;
    if ((state?.instruments.length ?? 0) <= 1) {
      setStatus('At least one symbol must stay in the watchlist.');
      return;
    }
    setBusyKey(instrument.key);
    setStatus(`Removing ${instrument.symbol}...`);
    try {
      const nextState = await removeWatchlistInstrument(instrument.key);
      onState(nextState);
      setResults((items) =>
        items.map((item) => (item.key === instrument.key ? { ...item, exists: false } : item)),
      );
      setStatus(`Removed ${instrument.symbol}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Remove failed.');
    } finally {
      setBusyKey(null);
    }
  }

  // Runs provider search from the single-symbol add form.
  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setStatus('Searching...');
    try {
      const next = await searchInstruments(searchSource, trimmed);
      setResults(next);
      setStatus(next.length ? `${next.length} matches.` : 'No matches.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Search failed.');
    }
  }

  // Adds all currently valid batch-import rows in sequence.
  async function addBulkEntries() {
    if (!editable || bulkBusy || addableEntries.length === 0) return;
    setBulkBusy(true);
    setStatus(`Adding ${addableEntries.length} symbols...`);
    try {
      let added = 0;
      for (const entry of addableEntries) {
        const result = resultFromBulkEntry(entry);
        const nextState = await addWatchlistResult(result);
        added += 1;
        onState(nextState);
      }
      setStatus(`Added ${added} symbols.`);
      setBulkText('');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Batch add failed.');
    } finally {
      setBulkBusy(false);
    }
  }

  if (!state) {
    return <div className="settings-loading">Loading watchlist...</div>;
  }

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Symbols</div>
          <h2>Watchlist</h2>
        </div>
        <div className="settings-stage-actions">
          <span className="models-count">{state.instruments.length} active</span>
        </div>
      </header>

      <div className="watchlist-settings-layout">
        <section className="watchlist-current">
          <div className="provider-section-head">
            <strong>Active Symbols</strong>
            {!editable && <span className="provider-inline-badge">Readonly</span>}
          </div>
          <div className="watchlist-table">
            {sections.map((section) => (
              <div className="watchlist-source-section" key={section.source}>
                <div className="watchlist-source-head">
                  <div>
                    <span>{section.label}</span>
                    <small>{sourceName(section.source)}</small>
                  </div>
                  <span className="source-count">{section.instruments.length}</span>
                </div>
                {section.instruments.map((instrument) => (
                  <div className="watchlist-table-row" key={instrument.key}>
                    <div>
                      <strong>{instrument.label}</strong>
                      <small>{instrument.symbol}</small>
                    </div>
                    <span>{sourceName(instrument.source)}</span>
                    <span>{instrumentVenue(instrument)}</span>
                    <span>{instrument.analysisInterval}</span>
                    <button
                      aria-label={`Remove ${instrument.symbol}`}
                      className="danger-icon-button"
                      disabled={!editable || state.instruments.length <= 1 || busyKey === instrument.key}
                      onClick={() => removeInstrument(instrument)}
                      type="button"
                    >
                      {busyKey === instrument.key ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="watchlist-editor">
          <div className="bulk-import-panel">
            <div className="provider-section-head">
              <strong>Batch Add</strong>
              <span className="provider-inline-badge">{addableEntries.length} ready</span>
            </div>
            <textarea
              value={bulkText}
              onChange={(event) => setBulkText(event.target.value)}
              placeholder={'BTCUSDT\nSPOT:ETHUSDT\nAAPL.US\nhyperliquid:BTC'}
              spellCheck={false}
            />
            {entries.length > 0 && (
              <div className="bulk-preview">
                {entries.slice(0, 8).map((entry) => (
                  <div className={`bulk-preview-row ${entry.valid && !entry.exists ? 'ready' : ''}`} key={`${entry.raw}-${entry.key}`}>
                    <span>{entry.raw}</span>
                    <small>
                      {entry.error
                        || (entry.inputDuplicate ? 'duplicate input' : entry.exists ? 'already active' : `${sourceName(entry.source)} · ${entry.key}`)}
                    </small>
                  </div>
                ))}
                {entries.length > 8 && <div className="bulk-preview-more">+{entries.length - 8} more</div>}
              </div>
            )}
            <button
              className="shell-button primary"
              disabled={!editable || bulkBusy || addableEntries.length === 0}
              onClick={addBulkEntries}
              type="button"
            >
              {bulkBusy ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
              Add batch
            </button>
          </div>

          <div className="single-add-panel">
            <div className="provider-section-head">
              <strong>Search Add</strong>
              <span className="provider-inline-badge">{sourceName(searchSource)}</span>
            </div>
            <div className="source-toggle">
              <button
                className={searchSource === 'bitget' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setSearchSource('bitget');
                  setResults([]);
                }}
              >
                Bitget
              </button>
              <button
                className={searchSource === 'alpaca' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setSearchSource('alpaca');
                  setResults([]);
                }}
              >
                Alpaca
              </button>
              <button
                className={searchSource === 'hyperliquid-testnet' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setSearchSource('hyperliquid-testnet');
                  setResults([]);
                }}
              >
                Hyperliquid Testnet
              </button>
            </div>
            <div className="settings-search">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runSearch();
                }}
                placeholder={
                  searchSource === 'bitget'
                    ? 'BTC / BTCUSDT'
                    : searchSource === 'hyperliquid-testnet'
                      ? 'BTC / ETH'
                      : 'AAPL / Apple'
                }
              />
              <button className="inline-search-button" type="button" onClick={runSearch}>
                Search
              </button>
            </div>
            <div className="search-results settings-results">
              {results.map((result) => (
                <button
                  className="search-result"
                  key={result.key}
                  onClick={() => addResult(result)}
                  type="button"
                  disabled={!editable || result.exists || busyKey === result.key}
                >
                  <span>
                    <strong>{result.symbol}</strong>
                    <small>{result.nameCn || result.nameEn || result.nameHk || result.displayText}</small>
                  </span>
                  <span className={result.exists ? 'remove-action' : 'add-action'}>
                    {busyKey === result.key ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
                    {result.exists ? 'Active' : 'Add'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>

      <div className="provider-status-bar">{status}</div>
    </>
  );
}

// Renders agent text without depending on the provider's structured fields.
function AgentAnalysisBlock({ analysis }: { analysis: AgentAnalysis }) {
  const text = analysis.summary || analysis.error || analysis.rawText || 'Agent response unavailable.';
  return (
    <>
      {analysis.loopResult && <AgentLoopSteps steps={analysis.loopResult.steps} />}
      <p className="session-message-text">{text}</p>
    </>
  );
}

// Renders every visible step from an agent loop iteration.
function AgentLoopSteps({ steps }: { steps: LoopStep[] }) {
  if (steps.length === 0) return null;

  return (
    <div className="agent-tool-steps">
      {steps.map((step, index) => (
        <div key={index} className="agent-tool-step">
          <div className="tool-step-summary">
            <Zap size={12} />
            <span className="tool-name">{loopStepLabel(step)}</span>
            {step.toolResult?.error && <span className="tool-error-badge">error</span>}
          </div>
          <div className="tool-step-detail">
            {step.toolCall?.arguments && Object.keys(step.toolCall.arguments).length > 0 && (
              <div className="tool-args">
                <small>Arguments</small>
                <pre>{JSON.stringify(step.toolCall.arguments, null, 2)}</pre>
              </div>
            )}
            {step.toolResult && (
              <div className={`tool-output ${step.toolResult.error ? 'error' : ''}`}>
                <small>Output</small>
                <pre>{step.toolResult.output}</pre>
              </div>
            )}
            {step.stepType === 'assistant' && step.content && (
              <div className="tool-output">
                <small>Assistant response</small>
                <pre>{step.content}</pre>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function loopStepLabel(step: LoopStep) {
  if (step.stepType === 'tool_call') return `call ${step.toolCall?.name ?? 'tool'}`;
  if (step.stepType === 'tool_result') return `result ${step.toolResult?.name ?? 'tool'}`;
  return 'assistant response';
}

// Renders one persisted chat turn in the chart-agent transcript.
function AgentTranscriptMessage({ message }: { message: AgentMessage }) {
  const analysis = message.analysis;
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'System';
  const content = analysis?.summary || message.error || analysis?.error || message.content || analysis?.rawText || 'No content.';
  return (
    <div className={`session-message ${message.role}`}>
      <div className="session-message-head">
        <span>{label}</span>
        <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
      </div>
      {message.role === 'assistant' && analysis ? (
        <>
          {analysis.loopResult && <AgentLoopSteps steps={analysis.loopResult.steps} />}
          <p className="session-message-text">{content}</p>
        </>
      ) : (
        <p className="session-message-text">{content}</p>
      )}
    </div>
  );
}

// Renders persisted chart-agent session rows with restore/delete actions.
function AgentSessionHistoryList({
  activeSessionId,
  busyActionKey,
  history,
  loading,
  onDelete,
  onResume,
}: {
  activeSessionId: string | null;
  busyActionKey: string | null;
  history: AgentSessionSummary[];
  loading: boolean;
  onDelete: (sessionId: string) => Promise<void>;
  onResume: (sessionId: string) => Promise<void>;
}) {
  const visibleHistory = history.slice(0, 8);

  return (
    <div className="session-history">
      <div className="session-history-head">
        <span>
          <History size={13} /> History
        </span>
        <small>{loading ? 'Loading' : `${history.length} saved`}</small>
      </div>
      <div className="session-history-list">
        {loading && (
          <div className="session-history-empty">
            <Loader2 className="spin" size={14} />
            <span>Loading saved sessions</span>
          </div>
        )}
        {!loading && visibleHistory.map((item) => {
          const isActive = item.id === activeSessionId || item.active;
          const resumeKey = `resume:${item.id}`;
          const deleteKey = `delete:${item.id}`;
          const title = item.preview || item.title || item.id;
          return (
            <div className={`session-history-row ${isActive ? 'active' : ''}`} key={item.id}>
              <button
                className="session-history-main"
                disabled={isActive || Boolean(busyActionKey)}
                onClick={() => void onResume(item.id)}
                title={isActive ? 'Active session' : 'Resume session'}
                type="button"
              >
                <span>{title}</span>
                <small>
                  {item.model} · {item.messageCount} msg · {new Date(item.updatedAt).toLocaleDateString()}
                </small>
              </button>
              <div className="session-history-actions">
                <span className={`session-history-badge ${isActive ? 'active' : ''}`}>
                  {isActive ? 'active' : item.reasoningEffort ?? '-'}
                </span>
                <button
                  aria-label="Resume saved agent session"
                  className="session-icon-action"
                  disabled={isActive || Boolean(busyActionKey)}
                  onClick={() => void onResume(item.id)}
                  title="Resume session"
                  type="button"
                >
                  {busyActionKey === resumeKey ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
                </button>
                <button
                  aria-label="Delete saved agent session"
                  className="session-icon-action danger"
                  disabled={Boolean(busyActionKey)}
                  onClick={() => void onDelete(item.id)}
                  title="Delete session"
                  type="button"
                >
                  {busyActionKey === deleteKey ? <Loader2 className="spin" size={13} /> : <Trash2 size={13} />}
                </button>
              </div>
            </div>
          );
        })}
        {!loading && visibleHistory.length === 0 && (
          <div className="session-history-empty">
            <History size={14} />
            <span>No saved sessions yet.</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Renders the active per-instrument chart-agent session and compose box.
function AgentSessionPanel({
  analysis,
  session,
  prompt,
  sessionActionKey,
  sessionLoading,
  busy,
  disabled,
  selectedProvider,
  selectedModel,
  onProviderChange,
  onModelChange,
  onPromptChange,
  onSend,
  onReset,
}: {
  analysis: AgentAnalysis | undefined;
  session: AgentSessionResponse | null;
  prompt: string;
  sessionActionKey: string | null;
  sessionLoading: boolean;
  busy: boolean;
  disabled: boolean;
  selectedProvider: string;
  selectedModel: string;
  onProviderChange: (provider: string, defaultModel: string) => void;
  onModelChange: (model: string) => void;
  onPromptChange: (value: string) => void;
  onSend: () => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const messages = session?.messages ?? [];
  const canSend = !disabled && !busy && !sessionLoading && !sessionActionKey;
  const sessionTime = session?.session
    ? new Date(session.session.updatedAt).toLocaleTimeString()
    : 'No session';

  return (
    <div className="agent-card agent-readout agent-session-card">
      <div className="agent-card-head">
        <span className="panel-label with-icon">
          <Sparkles size={14} /> Chart Session
        </span>
        <span className="agent-bias neutral">{busy ? 'running' : 'idle'}</span>
      </div>
      <div className="session-toolbar">
        <span>{session?.session?.model ?? analysis?.model ?? '-'}</span>
        <small>{sessionLoading ? 'Loading' : sessionTime}</small>
        <button
          aria-label="Start new agent session"
          className="session-icon-action"
          disabled={busy || sessionLoading || !session?.session}
          onClick={onReset}
          type="button"
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="session-provider-bar">
        <select
          className="session-provider-select"
          value={selectedProvider}
          onChange={(event) => {
            const option = AGENT_PROVIDER_OPTIONS.find((o) => o.provider === event.target.value);
            if (option) onProviderChange(option.provider, option.defaultModel);
          }}
          disabled={busy}
        >
          {AGENT_PROVIDER_OPTIONS.map((option) => (
            <option key={option.provider} value={option.provider}>{option.label}</option>
          ))}
        </select>
        <input
          className="session-model-input"
          type="text"
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={busy}
          placeholder="Model name"
        />
      </div>
      <div className="session-transcript">
        {sessionLoading && (
          <div className="session-empty">
            <Loader2 className="spin" size={16} />
            <span>Loading session</span>
          </div>
        )}
        {!sessionLoading && messages.map((message) => (
          <AgentTranscriptMessage key={message.id} message={message} />
        ))}
        {!sessionLoading && messages.length === 0 && analysis && (
          <div className="session-message assistant">
            <div className="session-message-head">
              <span>Latest</span>
              <time>{new Date(analysis.updatedAt).toLocaleTimeString()}</time>
            </div>
            <AgentAnalysisBlock analysis={analysis} />
          </div>
        )}
        {!sessionLoading && messages.length === 0 && !analysis && (
          <div className="session-empty">
            <History size={16} />
            <span>No turns in this chart session.</span>
          </div>
        )}
      </div>
      <div className="session-compose">
        <textarea
          disabled={disabled || busy || sessionLoading}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              if (canSend) void onSend();
            }
          }}
          placeholder="Ask about this chart"
          rows={3}
          value={prompt}
        />
        <button className="agent-action" type="button" onClick={onSend} disabled={!canSend}>
          {busy ? <Loader2 className="spin" size={16} /> : <Bot size={16} />}
          {busy ? 'Analyzing' : 'Ask Agent'}
        </button>
      </div>
    </div>
  );
}

// Renders the main trading workspace across watchlist, chart, and agent panels.
function WorkspaceView({
  state,
  socketStatus,
  groups,
  activeGroup,
  selectedKey,
  selectedInstrument,
  selectedQuote,
  selectedAgent,
  theme,
  agentSession,
  agentSessionHistory,
  agentPrompt,
  agentProvider,
  agentModel,
  agentBusyKey,
  agentSessionActionKey,
  agentSessionHistoryLoading,
  agentSessionLoading,
  analysisIntervalBusy,
  olderBusyKey,
  exhaustedHistoryKeys,
  sidebarCollapsed,
  setSidebarCollapsed,
  setActiveGroup,
  setSelectedKey,
  setState,
  setAgentPrompt,
  onAgentProviderChange,
  onAgentModelChange,
  updateAnalysisInterval,
  loadOlderForSelected,
  runAgentAnalysis,
  resumeAgentConversation,
  resetAgentConversation,
  deleteAgentConversation,
  onThemeToggle,
  openSettings,
  openWatchlistSettings,
}: {
  state: MarketState | null;
  socketStatus: string;
  groups: string[];
  activeGroup: string | null;
  selectedKey: string | null;
  selectedInstrument: Instrument | undefined;
  selectedQuote: Quote | undefined;
  selectedAgent: AgentAnalysis | undefined;
  theme: ThemeName;
  agentSession: AgentSessionResponse | null;
  agentSessionHistory: AgentSessionSummary[];
  agentPrompt: string;
  agentProvider: string;
  agentModel: string;
  agentBusyKey: string | null;
  agentSessionActionKey: string | null;
  agentSessionHistoryLoading: boolean;
  agentSessionLoading: boolean;
  analysisIntervalBusy: boolean;
  olderBusyKey: string | null;
  exhaustedHistoryKeys: Set<string>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (value: boolean) => void;
  setActiveGroup: (value: string) => void;
  setSelectedKey: (value: string) => void;
  setState: (state: MarketState) => void;
  setAgentPrompt: (value: string) => void;
  onAgentProviderChange: (provider: string, defaultModel: string) => void;
  onAgentModelChange: (model: string) => void;
  updateAnalysisInterval: (value: string) => void;
  loadOlderForSelected: () => void;
  runAgentAnalysis: () => Promise<void>;
  resumeAgentConversation: (sessionId: string) => Promise<void>;
  resetAgentConversation: () => Promise<void>;
  deleteAgentConversation: (sessionId: string) => Promise<void>;
  onThemeToggle: () => void;
  openSettings: () => void;
  openWatchlistSettings: () => void;
}) {
  const activeKeys = activeGroup && state ? state.groups[activeGroup] ?? [] : [];
  const collapsedKeys = state?.instruments.map((instrument) => instrument.key) ?? [];
  const currentInterval = selectedInstrument?.analysisInterval ?? state?.config.analysis.interval ?? '5m';
  const candleDelta = closeDeltaPercent(selectedQuote?.candles ?? []);
  const historyKey = selectedKey ? `${selectedKey}:${currentInterval}` : null;
  const canLoadOlder =
    Boolean(
      selectedInstrument &&
        ['alpaca', 'bitget', 'hyperliquid-testnet'].includes(selectedInstrument.source),
    ) &&
    Boolean(historyKey && !exhaustedHistoryKeys.has(historyKey));
  const nextThemeName = nextTheme(theme);
  const [activeTab, setActiveTab] = useState<'chart' | 'agent' | 'news' | 'social' | 'positions'>('chart');

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="sidebar-toggle-button"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            type="button"
          >
            {sidebarCollapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
          </button>
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <Zap size={21} />
            </div>
            <div>
              <div className="eyebrow">Local Price Action Agent</div>
              <h1>mytradebot</h1>
            </div>
          </div>
        </div>
        <div className="topbar-right">
          <ConnectionBadge socketStatus={socketStatus} streamStatus={state?.streamStatus ?? 'idle'} />
          <button
            aria-label={`Switch to ${THEME_LABELS[nextThemeName]} mode`}
            aria-pressed={theme === 'dark'}
            className="shell-button theme-toggle"
            onClick={onThemeToggle}
            title={`Switch to ${THEME_LABELS[nextThemeName]}`}
            type="button"
          >
            {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            <span>{THEME_LABELS[nextThemeName]}</span>
          </button>
          <button className="shell-button" type="button" onClick={openSettings}>
            <Settings size={16} />
            Settings
          </button>
        </div>
      </header>

      <section className={`workspace ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
          {!sidebarCollapsed && (
            <>
              <div className="sidebar-head">
                <span className="sidebar-title">自选列表</span>
                <button
                  aria-label="Manage watchlist"
                  className="sidebar-manage-button"
                  onClick={openWatchlistSettings}
                  type="button"
                >
                  <Settings size={14} />
                </button>
              </div>
              <div className="group-tabs">
                {groups.map((group) => (
                  <button
                    className={group === activeGroup ? 'active' : ''}
                    key={group}
                    type="button"
                    onClick={() => setActiveGroup(group)}
                  >
                    {GROUP_LABELS[group] ?? group}
                  </button>
                ))}
              </div>
              <div className="watchlist-header">
                <span>名称/代码</span>
                <span>最新价</span>
                <span>涨跌幅</span>
              </div>
              <div className="watchlist">
                {state &&
                  activeKeys.map((key) => {
                    const instrument = state.instruments.find((item) => item.key === key);
                    if (!instrument) return null;
                    return (
                      <WatchlistRow
                        key={key}
                        instrument={instrument}
                        quote={state.quotes[key]}
                        selected={selectedKey === key}
                        onSelect={() => setSelectedKey(key)}
                      />
                    );
                  })}
              </div>
            </>
          )}
          {sidebarCollapsed && (
            <div className="sidebar-collapsed-content">
              <div className="sidebar-collapsed-icons">
                <button
                  aria-label="Manage watchlist"
                  className="sidebar-manage-button"
                  onClick={openWatchlistSettings}
                  type="button"
                  title="Manage watchlist"
                >
                  <Settings size={16} />
                </button>
              </div>
              <div className="sidebar-collapsed-symbols">
                {state &&
                  collapsedKeys.map((key) => {
                    const instrument = state.instruments.find((item) => item.key === key);
                    if (!instrument) return null;
                    return (
                      <button
                        key={key}
                        className={`sidebar-collapsed-symbol ${selectedKey === key ? 'selected' : ''}`}
                        onClick={() => setSelectedKey(key)}
                        type="button"
                        title={`${instrument.label} (${instrument.symbol})`}
                      >
                        <span className="collapsed-symbol-label">{instrument.label}</span>
                        <span className={`collapsed-symbol-price ${changeClass(state.quotes[key])}`}>
                          {state.quotes[key]?.percentLabel ?? '-'}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
          )}
        </aside>

        <section className="main-content">
          <div className="workspace-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'chart'}
              className={`workspace-tab ${activeTab === 'chart' ? 'active' : ''}`}
              onClick={() => setActiveTab('chart')}
            >
              Chart
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'agent'}
              className={`workspace-tab ${activeTab === 'agent' ? 'active' : ''}`}
              onClick={() => setActiveTab('agent')}
            >
              Agent
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'news'}
              className={`workspace-tab ${activeTab === 'news' ? 'active' : ''}`}
              onClick={() => setActiveTab('news')}
            >
              News
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'social'}
              className={`workspace-tab ${activeTab === 'social' ? 'active' : ''}`}
              onClick={() => setActiveTab('social')}
            >
              Social
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'positions'}
              className={`workspace-tab ${activeTab === 'positions' ? 'active' : ''}`}
              onClick={() => setActiveTab('positions')}
            >
              Positions
            </button>
          </div>

          {activeTab === 'chart' && (
            <div className="chart-section">
              <div className="chart-panel-inner">
                <div className="chart-header">
                  <h2>{selectedInstrument?.label ?? '选择标的'}</h2>
                  <div className="chart-header-right">
                    <label className="interval-pill interval-control">
                      <Activity size={15} />
                      <select
                        className="interval-select"
                        disabled={!state || !state.config.sourcePath || !selectedKey || analysisIntervalBusy}
                        onChange={(event) => updateAnalysisInterval(event.target.value)}
                        value={currentInterval}
                      >
                        {intervalOptions(currentInterval).map((interval) => (
                          <option key={interval} value={interval}>
                            {interval}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="price-readout">
                      <span className="readout-label">Last</span>
                      <strong>{selectedQuote?.priceLabel ?? '-'}</strong>
                      <span className={changeClass(selectedQuote)}>
                        {selectedQuote?.changeLabel ?? '-'} · {selectedQuote?.percentLabel ?? '-'}
                      </span>
                    </div>
                  </div>
                </div>

                <CandlestickPane
                  candles={selectedQuote?.candles ?? []}
                  canLoadOlder={canLoadOlder}
                  chartKey={`${selectedKey ?? 'none'}:${currentInterval}`}
                  theme={theme}
                  olderLoading={Boolean(historyKey && olderBusyKey === historyKey)}
                  onLoadOlder={loadOlderForSelected}
                />

                <div className="stat-grid">
                  <StatTile label="High" value={selectedQuote?.dayHigh?.toFixed(2) ?? '-'} />
                  <StatTile label="Low" value={selectedQuote?.dayLow?.toFixed(2) ?? '-'} />
                  <StatTile label="Volume" value={selectedQuote?.volumeLabel ?? '-'} />
                  <StatTile label="Range" value={candleRangeLabel(selectedQuote?.candles ?? [])} />
                  <StatTile label="Window" value={candleDelta == null ? '-' : `${formatSignedNumber(candleDelta)}%`} />
                  <StatTile label="Age" value={selectedQuote?.ageLabel ?? 'waiting'} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'agent' && (
            <div className="agent-tab-layout">
              <AgentSessionPanel
                analysis={selectedAgent}
                session={agentSession}
                prompt={agentPrompt}
                sessionActionKey={agentSessionActionKey}
                sessionLoading={agentSessionLoading}
                busy={agentBusyKey === selectedKey}
                disabled={!selectedKey || !selectedQuote?.candles.length}
                selectedProvider={agentProvider}
                selectedModel={agentModel}
                onProviderChange={onAgentProviderChange}
                onModelChange={onAgentModelChange}
                onPromptChange={setAgentPrompt}
                onSend={runAgentAnalysis}
                onReset={resetAgentConversation}
              />
              <AgentSessionHistoryList
                activeSessionId={agentSession?.session?.id ?? null}
                busyActionKey={agentSessionActionKey}
                history={agentSessionHistory}
                loading={agentSessionHistoryLoading}
                onDelete={deleteAgentConversation}
                onResume={resumeAgentConversation}
              />
            </div>
          )}

          {activeTab === 'news' && (
            <div className="news-tab-panel">
              <NewsPanel
                items={state?.recentNews ?? []}
                decisions={state?.recentNewsDecisions ?? []}
                lastStatus={state?.newsStatus?.lastStatus}
                lastError={state?.newsStatus?.lastError ?? null}
              />
            </div>
          )}

          {activeTab === 'social' && (
            <SocialFeedPanel state={state} />
          )}

          {activeTab === 'positions' && (
            <PositionsPanel state={state} />
          )}
        </section>
      </section>
    </main>
  );
}

// Handles model discovery and persistence for the configured LLM provider adapter.
function ProviderSettingsPanel({
  state,
  onState,
}: {
  state: MarketState | null;
  onState: (state: MarketState) => void;
}) {
  const config = state?.config.agent;
  const configSignature = config ? JSON.stringify(config) : '';
  const [draft, setDraft] = useState<AgentConfigUpdate | null>(null);
  const [models, setModels] = useState<AgentModelOption[]>([]);
  const [providerSearch, setProviderSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Changes are local until saved.');

  useEffect(() => {
    if (!config) return;
    setDraft({
      enabled: config.enabled,
      provider: config.provider,
      apiMode: config.apiMode,
      model: config.model,
      timeoutSeconds: config.timeoutSeconds,
      maxCandles: config.maxCandles,
      reasoningEffort: config.reasoningEffort,
      maxIterations: config.maxIterations,
      useTools: config.useTools,
    });
  }, [configSignature]);

  // Refreshes the provider model catalog and updates the draft selection if needed.
  async function refreshModels() {
    if (draft && config && draft.provider !== config.provider) {
      setStatus('Save the provider switch before fetching that provider model list.');
      return;
    }
    setRefreshing(true);
    setStatus('Refreshing model catalog...');
    try {
      const payload = await fetchAgentModels();
      const visible = payload.models.filter((model) => model.supportedInApi && model.visibility !== 'hide');
      setModels(visible);
      setStatus(`${visible.length} models ready.`);
      setDraft((current) => {
        if (!current) return current;
        if (visible.some((model) => model.slug === current.model) || !visible[0]) {
          return current;
        }
        return {
          ...current,
          model: visible[0].slug,
          reasoningEffort: visible[0].defaultReasoningEffort || current.reasoningEffort,
        };
      });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }

  // Writes the current provider-settings draft to the local TOML file.
  async function persistConfig() {
    if (!draft) return;
    setSaving(true);
    setStatus('Saving provider settings...');
    try {
      const nextState = await saveAgentConfig(draft);
      onState(nextState);
      setStatus('All changes saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  if (!draft) {
    return <div className="settings-loading">Loading settings...</div>;
  }

  const currentProvider =
    AGENT_PROVIDER_OPTIONS.find((option) => option.provider === draft.provider) ?? AGENT_PROVIDER_OPTIONS[0];
  const providerOptions = AGENT_PROVIDER_OPTIONS.filter((option) =>
    `${option.provider} ${option.label} ${option.description}`.toLowerCase().includes(
      providerSearch.trim().toLowerCase(),
    ),
  );
  const modelOptions = models.some((model) => model.slug === draft.model)
    ? models
    : [
        {
          slug: draft.model,
          displayName: draft.model,
          description: '',
          visibility: 'active',
          supportedInApi: true,
          defaultReasoningEffort: currentProvider.supportsReasoning ? draft.reasoningEffort : '',
          supportedReasoningEfforts: currentProvider.supportsReasoning ? REASONING_OPTIONS : [],
          contextWindow: null,
          preferWebsockets: currentProvider.provider === 'codex',
        },
        ...models,
      ];
  const visibleModels = modelOptions.filter((model) => {
    const keyword = modelSearch.trim().toLowerCase();
    if (!keyword) return true;
    return `${model.displayName} ${model.slug} ${model.description}`.toLowerCase().includes(keyword);
  });
  const selectedModel = modelOptions.find((model) => model.slug === draft.model);
  const reasoningOptions = currentProvider.supportsReasoning && selectedModel?.supportedReasoningEfforts.length
    ? selectedModel.supportedReasoningEfforts
    : REASONING_OPTIONS;

  function selectProvider(option: (typeof AGENT_PROVIDER_OPTIONS)[number]) {
    setModels([]);
    setModelSearch('');
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        provider: option.provider,
        apiMode: option.apiMode,
        model: option.defaultModel,
        reasoningEffort: option.supportsReasoning ? current.reasoningEffort : 'medium',
      };
    });
    setStatus(`Save to switch the active provider to ${option.label}.`);
  }

  return (
    <>
          <header className="settings-stage-head">
            <div>
              <div className="eyebrow">Configuration</div>
              <h2>Providers</h2>
            </div>
            <div className="settings-stage-actions">
              <button className="shell-button muted" type="button" onClick={refreshModels} disabled={refreshing}>
                {refreshing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
                Fetch models
              </button>
              <button className="shell-button primary" type="button" onClick={persistConfig} disabled={saving}>
                {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                Save
              </button>
            </div>
          </header>

          <div className="provider-layout">
            <section className="provider-catalog">
              <div className="provider-toolbar">
                <div className="settings-search">
                  <Search size={17} />
                  <input
                    value={providerSearch}
                    onChange={(event) => setProviderSearch(event.target.value)}
                    placeholder="Search providers..."
                  />
                </div>
              </div>

              <div className="provider-list">
                {providerOptions.length ? (
                  providerOptions.map((option) => {
                    const selected = draft.provider === option.provider;
                    return (
                      <button
                        className={`provider-item ${selected ? 'selected' : ''}`}
                        key={option.provider}
                        type="button"
                        onClick={() => selectProvider(option)}
                      >
                        <div className="provider-item-icon">
                          {option.provider === 'anthropic' ? <Sparkles size={18} /> : <Bot size={18} />}
                        </div>
                        <div className="provider-item-copy">
                          <strong>{option.label}</strong>
                          <small>{option.description}</small>
                        </div>
                        {selected && <span className="provider-item-dot" />}
                      </button>
                    );
                  })
                ) : (
                  <div className="provider-empty">No providers match this search.</div>
                )}
              </div>
            </section>

            <section className="provider-detail">
              <div className="provider-hero">
                <div>
                  <div className="provider-hero-title">
                    <h3>{currentProvider.label}</h3>
                    <span className={`provider-state-badge ${draft.provider === currentProvider.provider ? 'active' : 'inactive'}`}>
                      {draft.provider === currentProvider.provider ? 'Default' : ''}
                    </span>
                  </div>
                  <p>{currentProvider.detail}</p>
                </div>
              </div>

              <div className="provider-section">
                <div className="provider-section-card">
                  <div className="provider-section-head">
                    <strong>Provider</strong>
                    <span className="provider-inline-badge">Selected</span>
                  </div>
                  <div className="provider-fixed-field">{draft.provider}</div>
                </div>
                <div className="provider-section-card">
                  <div className="provider-section-head">
                    <strong>API Mode</strong>
                    <span className="provider-inline-badge">Auto</span>
                  </div>
                  <div className="provider-fixed-field">{draft.apiMode}</div>
                </div>
              </div>

              <div className="provider-form-grid">
                <label>
                  <span>Reasoning Effort</span>
                  {currentProvider.supportsReasoning ? (
                    <select
                      value={draft.reasoningEffort}
                      onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}
                    >
                      {reasoningOptions.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <div className="provider-fixed-field">Not used</div>
                  )}
                </label>
                <label>
                  <span>Timeout Seconds</span>
                  <input
                    min={5}
                    step={5}
                    type="number"
                    value={draft.timeoutSeconds}
                    onChange={(event) =>
                      setDraft({ ...draft, timeoutSeconds: Math.max(5, Number(event.target.value) || 5) })
                    }
                  />
                </label>
                <label>
                  <span>Max Candles</span>
                  <input
                    min={10}
                    step={5}
                    type="number"
                    value={draft.maxCandles}
                    onChange={(event) =>
                      setDraft({ ...draft, maxCandles: Math.max(10, Number(event.target.value) || 10) })
                    }
                  />
                </label>
                <label>
                  <span>Max Iterations</span>
                  <input
                    min={1}
                    step={1}
                    type="number"
                    value={draft.maxIterations}
                    onChange={(event) =>
                      setDraft({ ...draft, maxIterations: Math.max(1, Number(event.target.value) || 1) })
                    }
                  />
                </label>
                <label className="switch-row provider-form-switch">
                  <span>Use Tools</span>
                  <input
                    checked={draft.useTools}
                    onChange={(event) => setDraft({ ...draft, useTools: event.target.checked })}
                    type="checkbox"
                  />
                  <span className="switch-slider" />
                </label>
              </div>

              <div className="models-panel">
                <div className="models-panel-head">
                  <div>
                    <strong>Models</strong>
                    <small>选择当前 provider 使用的活动模型。</small>
                  </div>
                  <span className="models-count">{visibleModels.length} shown</span>
                </div>

                <div className="settings-search models-search">
                  <Search size={17} />
                  <input
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder="Search models..."
                  />
                </div>

                <div className="model-list">
                  {visibleModels.map((model) => {
                    const selected = draft.model === model.slug;
                    return (
                      <button
                        className={`model-row ${selected ? 'selected' : ''}`}
                        key={model.slug}
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            model: model.slug,
                            reasoningEffort: model.defaultReasoningEffort || draft.reasoningEffort,
                          })
                        }
                      >
                        <div className="model-copy">
                          <div className="model-title-row">
                            <strong>{model.displayName || model.slug}</strong>
                            {selected && <span className="provider-inline-badge">Selected</span>}
                          </div>
                          <div className="model-meta-row">
                            <span>{model.slug}</span>
                            <span>{formatContextWindow(model.contextWindow)}</span>
                            <span>{model.defaultReasoningEffort || '-'}</span>
                          </div>
                          {model.description && <small>{model.description}</small>}
                        </div>
                      </button>
                    );
                  })}
                  {visibleModels.length === 0 && (
                    <div className="provider-empty">No models match this search.</div>
                  )}
                </div>
              </div>

              <div className="provider-status-bar">{status}</div>
            </section>
          </div>
    </>
  );
}

// Settings panel for the news-ingestion module. Shows module state plus the writable enabled toggle.
function NewsSettingsPanel({
  state,
  onState,
}: {
  state: MarketState | null;
  onState: (state: MarketState) => void;
}) {
  const config = state?.config.news;
  const configSignature = config ? JSON.stringify(config) : '';
  const [draft, setDraft] = useState<NewsConfigUpdate | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('Toggle news ingestion on to start polling Reuters.');

  useEffect(() => {
    if (!config) return;
    setDraft({ enabled: config.enabled });
  }, [configSignature]);

  async function persistConfig(nextEnabled: boolean) {
    setSaving(true);
    setStatus(nextEnabled ? 'Starting news service...' : 'Stopping news service...');
    try {
      const nextState = await saveNewsConfig({ enabled: nextEnabled });
      onState(nextState);
      setDraft({ enabled: nextEnabled });
      setStatus(nextEnabled ? 'News ingestion enabled.' : 'News ingestion disabled.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
      // Revert the toggle on failure so the UI mirrors backend truth.
      if (config) setDraft({ enabled: config.enabled });
    } finally {
      setSaving(false);
    }
  }

  if (!config || !draft) {
    return <div className="settings-loading">Loading settings...</div>;
  }

  const newsStatus = state?.newsStatus;
  const lastFetched = newsStatus?.lastFetchedAtMs
    ? new Date(newsStatus.lastFetchedAtMs).toLocaleString()
    : '—';

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Configuration</div>
          <h2>News</h2>
        </div>
        <div className="settings-stage-actions">
          <span className="provider-inline-badge">{config.enabled ? 'Active' : 'Disabled'}</span>
        </div>
      </header>

      <div className="provider-layout">
        <section className="provider-catalog">
          <div className="provider-section-head">
            <strong>Sources</strong>
            <span className="provider-inline-badge">1 active</span>
          </div>
          <div className="provider-list">
            <button className="provider-item selected" type="button" disabled>
              <div className="provider-item-icon">
                <Newspaper size={18} />
              </div>
              <div className="provider-item-body">
                <strong>Reuters</strong>
                <small>Sitemap poller — news.reuters.com</small>
              </div>
              <span className={`provider-inline-badge ${config.enabled ? 'positive' : ''}`}>
                {config.enabled ? 'On' : 'Off'}
              </span>
            </button>
            <div className="provider-item" aria-disabled>
              <div className="provider-item-icon">
                <Plus size={16} />
              </div>
              <div className="provider-item-body">
                <strong>Add source</strong>
                <small>More providers coming soon.</small>
              </div>
            </div>
          </div>
        </section>

        <div className="news-settings-detail-stack">
        <section className="provider-detail">
          <div className="provider-section-head">
            <strong>Module</strong>
          </div>

          <label className="settings-toggle-row">
            <div>
              <strong>Enable news ingestion</strong>
              <small>
                Controls the [news] block in watchlist.toml and start/stops the background poller.
              </small>
            </div>
            <button
              className={`settings-toggle ${draft.enabled ? 'on' : ''}`}
              type="button"
              disabled={saving}
              onClick={() => persistConfig(!draft.enabled)}
              aria-pressed={!!draft.enabled}
            >
              <span />
            </button>
          </label>

          <div className="settings-readonly-grid">
            <div>
              <span className="panel-label">Source URL</span>
              <strong>{config.reutersUrl}</strong>
            </div>
            <div>
              <span className="panel-label">Poll interval</span>
              <strong>{config.pollIntervalSeconds}s (max {config.maxIntervalSeconds}s)</strong>
            </div>
            <div>
              <span className="panel-label">Request timeout</span>
              <strong>{config.requestTimeoutSeconds}s</strong>
            </div>
            <div>
              <span className="panel-label">Retention</span>
              <strong>{config.retentionDays} days</strong>
            </div>
            <div>
              <span className="panel-label">Recent limit</span>
              <strong>{config.recentLimit}</strong>
            </div>
            <div>
              <span className="panel-label">Last fetch status</span>
              <strong>{newsStatus?.lastStatus ?? 'idle'}</strong>
            </div>
            <div>
              <span className="panel-label">Last fetched at</span>
              <strong>{lastFetched}</strong>
            </div>
            {newsStatus?.lastError && (
              <div>
                <span className="panel-label">Last error</span>
                <strong>{newsStatus.lastError}</strong>
              </div>
            )}
          </div>
          <div className="settings-hint">
            Tip: polling/retention/url are read-only here. Edit watchlist.toml and restart the
            backend to change them.
          </div>

          <div className="provider-status-bar">{status}</div>
        </section>

        <NewsAnalystSettingsSection state={state} />
        </div>
      </div>
    </>
  );
}

// Settings panel for X/Twitter social-feed auth and local module switch.
function SocialSettingsPanel({
  state,
  onState,
}: {
  state: MarketState | null;
  onState: (state: MarketState) => void;
}) {
  const config = state?.config.socialFeed;
  const configSignature = config ? JSON.stringify(config) : '';
  const [authStatus, setAuthStatus] = useState<SocialAuthStatus | null>(null);
  const [authToken, setAuthToken] = useState('');
  const [ct0, setCt0] = useState('');
  const [savingAuth, setSavingAuth] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedPreview, setFeedPreview] = useState<SocialFeedItem[]>([]);
  const [recentLimitInput, setRecentLimitInput] = useState('');
  const [retentionDaysInput, setRetentionDaysInput] = useState('');
  const [maxItemsInput, setMaxItemsInput] = useState('');
  const [refreshCountInput, setRefreshCountInput] = useState('20');
  const [status, setStatus] = useState('Save X cookies locally, then enable the social feed reader.');

  useEffect(() => {
    let cancelled = false;
    fetchSocialAuthStatus()
      .then((nextStatus) => {
        if (!cancelled) setAuthStatus(nextStatus);
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : 'Could not load social auth status.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!config) return;
    setRecentLimitInput(String(config.recentLimit));
    setRetentionDaysInput(String(config.retentionDays));
    setMaxItemsInput(String(config.maxItems));
    setStatus(config.enabled ? 'Social feed reader is enabled.' : 'Social feed reader is disabled.');
  }, [configSignature]);

  async function persistSocialEnabled(nextEnabled: boolean) {
    if (!config) return;
    setSavingConfig(true);
    setStatus(nextEnabled ? 'Enabling social feed reader...' : 'Disabling social feed reader...');
    try {
      const nextState = await saveSocialFeedConfig({ enabled: nextEnabled });
      onState(nextState);
      setStatus(nextEnabled ? 'Social feed reader enabled.' : 'Social feed reader disabled.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setSavingConfig(false);
    }
  }

  async function persistCacheSettings() {
    if (!config) return;
    const recentLimit = Number.parseInt(recentLimitInput, 10);
    const retentionDays = Number.parseInt(retentionDaysInput, 10);
    const maxItems = Number.parseInt(maxItemsInput, 10);
    if (!Number.isFinite(recentLimit) || recentLimit < 1 || recentLimit > 200) {
      setStatus('Recent limit must be between 1 and 200.');
      return;
    }
    if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 365) {
      setStatus('Retention must be between 1 and 365 days.');
      return;
    }
    if (!Number.isFinite(maxItems) || maxItems < 100) {
      setStatus('Max cached items must be at least 100.');
      return;
    }
    setSavingConfig(true);
    setStatus('Saving social cache settings...');
    try {
      const nextState = await saveSocialFeedConfig({ recentLimit, retentionDays, maxItems });
      onState(nextState);
      setStatus('Social cache settings saved.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed.');
    } finally {
      setSavingConfig(false);
    }
  }

  async function persistAuth() {
    setSavingAuth(true);
    setStatus('Saving X auth locally...');
    try {
      const nextStatus = await saveSocialAuth({ authToken, ct0 });
      setAuthStatus(nextStatus);
      setAuthToken('');
      setCt0('');
      setStatus('X auth saved. Values are not shown again after saving.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Auth save failed.');
    } finally {
      setSavingAuth(false);
    }
  }

  async function clearAuth() {
    setSavingAuth(true);
    setStatus('Clearing saved X auth...');
    try {
      const nextStatus = await clearSocialAuth();
      setAuthStatus(nextStatus);
      setStatus('Saved X auth cleared.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Clear failed.');
    } finally {
      setSavingAuth(false);
    }
  }

  async function testRefresh() {
    const refreshCount = Number.parseInt(refreshCountInput, 10);
    if (!Number.isFinite(refreshCount) || refreshCount < 1 || refreshCount > 100) {
      setStatus('Refresh count must be between 1 and 100.');
      return;
    }
    setTesting(true);
    setStatus(`Testing X Following refresh with ${refreshCount} item(s)...`);
    try {
      const result = await triggerXFollowingRefresh(refreshCount);
      const items = await fetchRecentSocialFeed(Math.min(refreshCount, 20));
      setFeedPreview(items);
      setStatus(
        result.status === 'ok'
          ? `Refresh ok. New ${result.inserted}, cached ${result.totalRecent}, showing ${items.length}.`
          : `Refresh ${result.status}: ${result.error ?? 'unknown error'}`,
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Refresh failed.');
    } finally {
      setTesting(false);
    }
  }

  async function loadCachedFeed() {
    const refreshCount = Number.parseInt(refreshCountInput, 10);
    if (!Number.isFinite(refreshCount) || refreshCount < 1 || refreshCount > 100) {
      setStatus('Refresh count must be between 1 and 100.');
      return;
    }
    setTesting(true);
    setStatus('Loading cached social feed sample...');
    try {
      const items = await fetchRecentSocialFeed(Math.min(refreshCount, 20));
      setFeedPreview(items);
      setStatus(items.length ? `Loaded ${items.length} cached item(s).` : 'No cached feed items yet.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Cached feed load failed.');
    } finally {
      setTesting(false);
    }
  }

  if (!config) {
    return <div className="settings-loading">Loading settings...</div>;
  }

  const hasUsableAuth = Boolean(authStatus?.hasSavedAuth || authStatus?.envAvailable);
  const savedAt = authStatus?.savedAtMs ? new Date(authStatus.savedAtMs).toLocaleString() : '—';
  const canSaveAuth = authToken.trim().length > 0 && ct0.trim().length > 0 && !savingAuth;
  const parsedRecentLimit = Number.parseInt(recentLimitInput, 10);
  const parsedRetentionDays = Number.parseInt(retentionDaysInput, 10);
  const parsedMaxItems = Number.parseInt(maxItemsInput, 10);
  const cacheSettingsValid =
    Number.isFinite(parsedRecentLimit) &&
    parsedRecentLimit >= 1 &&
    parsedRecentLimit <= 200 &&
    Number.isFinite(parsedRetentionDays) &&
    parsedRetentionDays >= 1 &&
    parsedRetentionDays <= 365 &&
    Number.isFinite(parsedMaxItems) &&
    parsedMaxItems >= 100;
  const cacheSettingsChanged =
    parsedRecentLimit !== config.recentLimit ||
    parsedRetentionDays !== config.retentionDays ||
    parsedMaxItems !== config.maxItems;
  const parsedRefreshCount = Number.parseInt(refreshCountInput, 10);
  const refreshCountValid =
    Number.isFinite(parsedRefreshCount) && parsedRefreshCount >= 1 && parsedRefreshCount <= 100;

  return (
    <>
      <header className="settings-stage-head">
        <div>
          <div className="eyebrow">Local X Feed</div>
          <h2>Social</h2>
        </div>
        <div className="settings-stage-actions">
          <span className={`provider-inline-badge ${config.enabled ? 'positive' : ''}`}>
            {config.enabled ? 'Reader On' : 'Reader Off'}
          </span>
          <span className={`provider-inline-badge ${hasUsableAuth ? 'positive' : ''}`}>
            {hasUsableAuth ? 'Auth Ready' : 'Auth Missing'}
          </span>
        </div>
      </header>

      <div className="social-settings-layout">
        <section className="provider-detail social-vault-card">
          <div className="provider-section-head">
            <strong>X Auth Vault</strong>
            <span className="provider-inline-badge">local only</span>
          </div>
          <p className="settings-hint" style={{ marginTop: 0 }}>
            Paste the two x.com cookies here once. They are stored on this machine and never echoed back
            into the UI.
          </p>

          <div className="social-auth-state">
            <div className="social-auth-state__icon">
              <LockKeyhole size={20} />
            </div>
            <div>
              <strong>{authStatus?.hasSavedAuth ? 'Saved auth is available' : 'No saved auth yet'}</strong>
              <span>
                {authStatus?.hasSavedAuth
                  ? `Saved at ${savedAt}`
                  : authStatus?.envAvailable
                    ? 'Environment variables are available as fallback.'
                    : 'Paste auth_token and ct0 to enable X refresh.'}
              </span>
            </div>
          </div>

          <div className="social-auth-form">
            <label>
              <span className="panel-label">auth_token</span>
              <input
                value={authToken}
                onChange={(event) => setAuthToken(event.target.value)}
                placeholder="Paste auth_token value"
                type="password"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              <span className="panel-label">ct0</span>
              <input
                value={ct0}
                onChange={(event) => setCt0(event.target.value)}
                placeholder="Paste ct0 value"
                type="password"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          </div>

          <div className="settings-action-row">
            <button className="shell-button primary" type="button" disabled={!canSaveAuth} onClick={persistAuth}>
              {savingAuth ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              Save auth
            </button>
            <button
              className="shell-button danger"
              type="button"
              disabled={savingAuth || !authStatus?.hasSavedAuth}
              onClick={clearAuth}
            >
              <Trash2 size={15} />
              Clear saved auth
            </button>
          </div>

          <div className="settings-hint social-secret-note">
            <EyeOff size={14} />
            Values are written to the backend local cache with file permissions tightened to owner-only.
          </div>

          <div className="social-test-panel">
            <div className="provider-section-head">
              <strong>Quick Tests</strong>
              <span className="provider-inline-badge">manual</span>
            </div>
            <label className="social-test-count">
              <span className="panel-label">Refresh count</span>
              <input
                value={refreshCountInput}
                onChange={(event) => setRefreshCountInput(event.target.value)}
                type="number"
                min={1}
                max={100}
                step={1}
              />
              <small>Controls the POST /api/social/x/refresh payload count. Preview shows up to 20 items.</small>
            </label>
            <div className="settings-action-row">
              <button
                className="shell-button"
                type="button"
                disabled={!config.enabled || !hasUsableAuth || testing || !refreshCountValid}
                onClick={testRefresh}
              >
                {testing ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                Refresh + cache
              </button>
              <button
                className="shell-button"
                type="button"
                disabled={!config.enabled || testing || !refreshCountValid}
                onClick={loadCachedFeed}
              >
                <Search size={15} />
                Read cache
              </button>
            </div>
            {feedPreview.length > 0 && (
              <div className="social-test-preview">
                {feedPreview.map((item) => (
                  <div key={`${item.source}:${item.externalId}`} className="social-test-preview__item">
                    <strong>@{item.author.handle}</strong>
                    <span>{item.text.slice(0, 160) || '(empty tweet)'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="provider-detail">
          <div className="provider-section-head">
            <strong>Reader</strong>
          </div>

          <label className="settings-toggle-row">
            <div>
              <strong>Enable X Following reader</strong>
              <small>
                Controls the [social_feed] block in watchlist.toml. Agent tools stay disabled while this is off.
              </small>
            </div>
            <button
              className={`settings-toggle ${config.enabled ? 'on' : ''}`}
              type="button"
              disabled={savingConfig}
              onClick={() => persistSocialEnabled(!config.enabled)}
              aria-pressed={config.enabled}
            >
              <span />
            </button>
          </label>

          <div className="social-cache-form">
            <label>
              <span className="panel-label">Recent limit</span>
              <input
                value={recentLimitInput}
                onChange={(event) => setRecentLimitInput(event.target.value)}
                type="number"
                min={1}
                max={200}
                step={1}
              />
              <small>Default number of cached items returned for recent-feed reads.</small>
            </label>
            <label>
              <span className="panel-label">Retention</span>
              <input
                value={retentionDaysInput}
                onChange={(event) => setRetentionDaysInput(event.target.value)}
                type="number"
                min={1}
                max={365}
                step={1}
              />
              <small>Deletes cached tweets older than this many days after each refresh.</small>
            </label>
            <label>
              <span className="panel-label">Max cached items</span>
              <input
                value={maxItemsInput}
                onChange={(event) => setMaxItemsInput(event.target.value)}
                type="number"
                min={100}
                step={100}
              />
              <small>Caps total local SQLite feed rows after each refresh.</small>
            </label>
          </div>

          <div className="settings-action-row">
            <button
              className="shell-button primary"
              type="button"
              disabled={savingConfig || !cacheSettingsValid || !cacheSettingsChanged}
              onClick={persistCacheSettings}
            >
              {savingConfig ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              Save cache settings
            </button>
          </div>

          <div className="settings-readonly-grid compact">
            <div>
              <span className="panel-label">Auth source</span>
              <strong>
                {authStatus?.hasSavedAuth ? 'Saved local auth' : authStatus?.envAvailable ? 'Environment' : 'Missing'}
              </strong>
            </div>
          </div>

          <div className="provider-status-bar">{status}</div>
        </section>
      </div>
    </>
  );
}

// 只读展示 [news_analyst] section: enabled / universe (5 个品种各自 alias 列表) /
// gating 阈值 / cooldown。修改入口仍是 watchlist.toml + 重启 (跟 News module 一致)。
function NewsAnalystSettingsSection({ state }: { state: MarketState | null }) {
  const analystConfig = state?.config.newsAnalyst;
  if (!analystConfig) {
    return null;
  }

  return (
    <section className="provider-detail">
        <div className="provider-section-head">
          <strong>News Analyst (auto paper trading)</strong>
          <span className={`provider-inline-badge ${analystConfig.enabled ? 'positive' : ''}`}>
            {analystConfig.enabled ? 'On' : 'Off'}
          </span>
        </div>

        <p className="settings-hint" style={{ marginTop: 0 }}>
          New Reuters headlines whose title or summary matches a universe alias trigger an LLM
          decision (direction / confidence / entry / stop / target). Confident, well-aligned
          signals open a paper trade automatically. Cooldown prevents repeat entries.
        </p>

        <div className="settings-readonly-grid">
          <div>
            <span className="panel-label">Min confidence</span>
            <strong>{analystConfig.minConfidence.toFixed(2)}</strong>
          </div>
          <div>
            <span className="panel-label">Max entry distance</span>
            <strong>{analystConfig.maxEntryDistancePct.toFixed(2)}%</strong>
          </div>
          <div>
            <span className="panel-label">Default size</span>
            <strong>{analystConfig.defaultSize}</strong>
          </div>
          <div>
            <span className="panel-label">Cooldown</span>
            <strong>{analystConfig.cooldownMinutes} min</strong>
          </div>
        </div>

        <div className="news-analyst-universe">
          <div className="panel-label" style={{ marginBottom: 8 }}>
            Universe ({analystConfig.universe.length} instrument
            {analystConfig.universe.length === 1 ? '' : 's'})
          </div>
          {analystConfig.universe.length === 0 ? (
            <div className="news-panel__empty">No universe entries configured.</div>
          ) : (
            <ul className="news-analyst-universe__list">
              {analystConfig.universe.map((entry) => {
                const symbol = entry.instrumentKey.split(':').pop() ?? entry.instrumentKey;
                return (
                  <li key={entry.instrumentKey} className="news-analyst-universe__item">
                    <strong className="news-analyst-universe__symbol">{symbol}</strong>
                    <span className="news-analyst-universe__key">{entry.instrumentKey}</span>
                    <div className="news-analyst-universe__aliases">
                      {entry.aliases.map((alias) => (
                        <span key={alias} className="news-analyst-universe__alias">{alias}</span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="settings-hint">
          Universe and gating thresholds are read-only here. Edit the [news_analyst] block in
          watchlist.toml and restart the backend to change them.
        </div>
    </section>
  );
}

// Coordinates top-level routing, live state hydration, and workspace actions.
export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => readRouteFromHash());
  const [theme, setTheme] = useState<ThemeName>(() => readInitialTheme());
  const [state, setState] = useState<MarketState | null>(null);
  const [socketStatus, setSocketStatus] = useState('connecting');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [agentBusyKey, setAgentBusyKey] = useState<string | null>(null);
  const [agentSessionLoadingKey, setAgentSessionLoadingKey] = useState<string | null>(null);
  const [agentSessionHistoryLoadingKey, setAgentSessionHistoryLoadingKey] = useState<string | null>(null);
  const [agentSessionActionKey, setAgentSessionActionKey] = useState<string | null>(null);
  const [agentSession, setAgentSession] = useState<AgentSessionResponse | null>(null);
  const [agentSessionHistory, setAgentSessionHistory] = useState<AgentSessionSummary[]>([]);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentProvider, setAgentProvider] = useState<string>(
    () => state?.config.agent.provider ?? AGENT_PROVIDER_OPTIONS[0].provider,
  );
  const [agentModel, setAgentModel] = useState<string>(
    () => state?.config.agent.model ?? AGENT_PROVIDER_OPTIONS[0].defaultModel,
  );
  const [analysisIntervalBusy, setAnalysisIntervalBusy] = useState(false);
  const [olderBusyKey, setOlderBusyKey] = useState<string | null>(null);
  const [exhaustedHistoryKeys, setExhaustedHistoryKeys] = useState<Set<string>>(() => new Set());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const olderBusyRef = useRef<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is optional; the UI still switches for this session.
    }
  }, [theme]);

  useEffect(() => {
    // Mirrors browser hash changes into React state.
    const syncRoute = () => setRoute(readRouteFromHash());
    window.addEventListener('hashchange', syncRoute);
    syncRoute();
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;

    // Schedules a bounded-delay WebSocket reconnect after transient disconnects.
    const scheduleReconnect = () => {
      if (disposed || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        openSocket();
      }, 1500);
    };

    // Opens the market-state socket and wires status changes into reconnect logic.
    const openSocket = () => {
      if (disposed) return;
      setSocketStatus('connecting');
      socket = connectStateSocket(setState, (status) => {
        setSocketStatus(status);
        if (status === 'disconnected' || status === 'error') {
          scheduleReconnect();
        }
      });
    };

    fetchState().then(setState).catch(() => setSocketStatus('error'));
    openSocket();
    return () => {
      disposed = true;
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer);
      }
      socket?.close();
    };
  }, []);

  const groups = useMemo(() => orderedGroups(state), [state]);

  useEffect(() => {
    if (!state) return;
    if (!activeGroup || !state.groups[activeGroup]) {
      setActiveGroup(groups[0] ?? null);
    }
    if (!selectedKey || !state.quotes[selectedKey]) {
      const firstKey = groups.flatMap((group) => state.groups[group] ?? [])[0];
      setSelectedKey(firstKey ?? null);
    }
  }, [activeGroup, groups, selectedKey, state]);

  const selectedInstrument = state?.instruments.find((instrument) => instrument.key === selectedKey);
  const selectedQuote = selectedKey ? state?.quotes[selectedKey] : undefined;
  const selectedAgent = selectedKey ? state?.agentAnalyses[selectedKey] : undefined;
  const currentInterval = selectedInstrument?.analysisInterval ?? state?.config.analysis.interval ?? '5m';
  const historyKey = selectedKey ? `${selectedKey}:${currentInterval}` : null;
  const selectedAgentSession =
    agentSession?.session?.instrumentKey === selectedKey || (!agentSession?.session && selectedKey)
      ? agentSession
      : null;
  const selectedAgentSessionHistory = selectedKey
    ? agentSessionHistory.filter((item) => item.instrumentKey === selectedKey)
    : [];

  useEffect(() => {
    if (!selectedKey) {
      setAgentSession(null);
      setAgentSessionHistory([]);
      setAgentSessionActionKey(null);
      setAgentPrompt('');
      return;
    }
    let disposed = false;
    const key = selectedKey;
    setAgentSessionLoadingKey(key);
    setAgentSessionHistoryLoadingKey(key);
    setAgentPrompt('');
    fetchAgentSession(key)
      .then((payload) => {
        if (!disposed) {
          setAgentSession(payload);
        }
      })
      .catch((error) => {
        console.error(error);
        if (!disposed) {
          setAgentSession(null);
        }
      })
      .finally(() => {
        if (!disposed) {
          setAgentSessionLoadingKey(null);
        }
      });
    fetchAgentSessionHistory(key)
      .then((payload) => {
        if (!disposed) {
          setAgentSessionHistory(payload.sessions);
        }
      })
      .catch((error) => {
        console.error(error);
        if (!disposed) {
          setAgentSessionHistory([]);
        }
      })
      .finally(() => {
        if (!disposed) {
          setAgentSessionHistoryLoadingKey(null);
        }
      });
    return () => {
      disposed = true;
    };
  }, [selectedKey]);

  // Saves a per-instrument K-line interval change from the top-bar selector.
  async function updateAnalysisInterval(interval: string) {
    if (!state || !selectedKey || interval === selectedInstrument?.analysisInterval || analysisIntervalBusy) return;
    setAnalysisIntervalBusy(true);
    try {
      const nextState = await saveInstrumentAnalysisInterval(selectedKey, interval);
      setState(nextState);
    } catch (error) {
      console.error(error);
    } finally {
      setAnalysisIntervalBusy(false);
    }
  }

  // Requests older candles for the selected chart while preventing duplicate loads.
  async function loadOlderForSelected() {
    if (
      !selectedKey ||
      !selectedInstrument ||
      !historyKey ||
      olderBusyRef.current === historyKey ||
      exhaustedHistoryKeys.has(historyKey) ||
      !['alpaca', 'bitget', 'hyperliquid-testnet'].includes(selectedInstrument.source)
    ) {
      return;
    }
    olderBusyRef.current = historyKey;
    setOlderBusyKey(historyKey);
    try {
      const payload = await loadOlderCandles(selectedKey);
      setState(payload.state);
      setExhaustedHistoryKeys((current) => {
        const next = new Set(current);
        if (payload.added === 0) {
          next.add(historyKey);
        } else {
          next.delete(historyKey);
        }
        return next;
      });
    } catch (error) {
      console.error(error);
    } finally {
      olderBusyRef.current = null;
      setOlderBusyKey(null);
    }
  }

  // Sends the current prompt to the selected instrument's active agent session.
  async function runAgentAnalysis() {
    if (!selectedKey) return;
    setAgentBusyKey(selectedKey);
    try {
      const payload = await sendAgentMessage(selectedKey, agentPrompt, {
        provider: agentProvider,
        model: agentModel,
      });
      setState(payload.state);
      setAgentSession(payload.session);
      setAgentSessionHistory(payload.history.sessions);
      setAgentPrompt('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent analysis failed';
      const fallback: AgentAnalysis = {
        available: false,
        provider: agentProvider,
        model: agentModel,
        updatedAt: new Date().toISOString(),
        summary: '',
        bias: 'neutral',
        confidence: 0,
        keyLevels: [],
        watchPlan: [],
        invalidation: '',
        riskNotes: [],
        error: message,
        rawText: null,
      };
      setState((current) =>
        current && selectedKey
          ? {
              ...current,
              agentAnalyses: {
                ...current.agentAnalyses,
                [selectedKey]: fallback,
              },
            }
          : current,
      );
    } finally {
      setAgentBusyKey(null);
    }
  }

  // Starts a fresh active agent session and clears the cached readout for this symbol.
  async function resetAgentConversation() {
    if (!selectedKey) return;
    const key = selectedKey;
    setAgentBusyKey(key);
    try {
      const payload = await resetAgentSession(key);
      setAgentSession(payload);
      setAgentSessionHistory(payload.history.sessions);
      setAgentPrompt('');
      setState((current) => {
        if (!current) return current;
        const { [key]: _removed, ...agentAnalyses } = current.agentAnalyses;
        return { ...current, agentAnalyses };
      });
    } catch (error) {
      console.error(error);
    } finally {
      setAgentBusyKey(null);
    }
  }

  // Restores a saved agent session for the selected symbol.
  async function resumeAgentConversation(sessionId: string) {
    if (!selectedKey || agentSessionActionKey) return;
    const key = selectedKey;
    const actionKey = `resume:${sessionId}`;
    setAgentSessionActionKey(actionKey);
    try {
      const payload = await resumeAgentSession(key, sessionId);
      setState(payload.state);
      setAgentSession(payload.session);
      setAgentSessionHistory(payload.history.sessions);
      setAgentPrompt('');
    } catch (error) {
      console.error(error);
    } finally {
      setAgentSessionActionKey((current) => (current === actionKey ? null : current));
    }
  }

  // Deletes a saved agent session after explicit user confirmation.
  async function deleteAgentConversation(sessionId: string) {
    if (!selectedKey || agentSessionActionKey) return;
    const confirmed = window.confirm('Delete this saved agent session?');
    if (!confirmed) return;
    const key = selectedKey;
    const actionKey = `delete:${sessionId}`;
    setAgentSessionActionKey(actionKey);
    try {
      const payload = await deleteAgentSession(key, sessionId);
      setState(payload.state);
      setAgentSession(payload.session);
      setAgentSessionHistory(payload.history.sessions);
      setAgentPrompt('');
    } catch (error) {
      console.error(error);
    } finally {
      setAgentSessionActionKey((current) => (current === actionKey ? null : current));
    }
  }

  if (route.view === 'settings') {
    return (
      <SettingsFrame
        state={state}
        section={route.section}
        onSection={(section) => navigateToRoute({ view: 'settings', section })}
        onBack={() => navigateToRoute({ view: 'workspace' })}
      >
        {route.section === 'providers' ? (
          <ProviderSettingsPanel state={state} onState={setState} />
        ) : route.section === 'news' ? (
          <NewsSettingsPanel state={state} onState={setState} />
        ) : route.section === 'social' ? (
          <SocialSettingsPanel state={state} onState={setState} />
        ) : (
          <WatchlistSettingsPanel state={state} onState={setState} />
        )}
      </SettingsFrame>
    );
  }

  return (
    <WorkspaceView
      state={state}
      socketStatus={socketStatus}
      groups={groups}
      activeGroup={activeGroup}
      selectedKey={selectedKey}
      selectedInstrument={selectedInstrument}
      selectedQuote={selectedQuote}
      selectedAgent={selectedAgent}
      theme={theme}
      agentSession={selectedAgentSession}
      agentSessionHistory={selectedAgentSessionHistory}
      agentPrompt={agentPrompt}
      agentProvider={agentProvider}
      agentModel={agentModel}
      agentBusyKey={agentBusyKey}
      agentSessionActionKey={agentSessionActionKey}
      agentSessionHistoryLoading={agentSessionHistoryLoadingKey === selectedKey}
      agentSessionLoading={agentSessionLoadingKey === selectedKey}
      analysisIntervalBusy={analysisIntervalBusy}
      olderBusyKey={olderBusyKey}
      exhaustedHistoryKeys={exhaustedHistoryKeys}
      sidebarCollapsed={sidebarCollapsed}
      setSidebarCollapsed={setSidebarCollapsed}
      setActiveGroup={setActiveGroup}
      setSelectedKey={setSelectedKey}
      setState={setState}
      setAgentPrompt={setAgentPrompt}
      onAgentProviderChange={(provider, defaultModel) => {
        setAgentProvider(provider);
        setAgentModel(defaultModel);
      }}
      onAgentModelChange={setAgentModel}
      updateAnalysisInterval={updateAnalysisInterval}
      loadOlderForSelected={loadOlderForSelected}
      runAgentAnalysis={runAgentAnalysis}
      resumeAgentConversation={resumeAgentConversation}
      resetAgentConversation={resetAgentConversation}
      deleteAgentConversation={deleteAgentConversation}
      onThemeToggle={() => setTheme((current) => nextTheme(current))}
      openSettings={() => navigateToRoute({ view: 'settings', section: 'providers' })}
      openWatchlistSettings={() => navigateToRoute({ view: 'settings', section: 'watchlist' })}
    />
  );
}

function PositionsPanel({ state }: { state: MarketState | null }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyReview, setBusyReview] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const positions = state?.exchangePositions ?? [];
  const orders = state?.exchangeOrders ?? [];

  const refreshLessons = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const l = await listLessons(undefined, 50);
      setLessons(l);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshLessons();
  }, [refreshLessons]);

  const runReview = async () => {
    setBusyReview(true);
    setError(null);
    try {
      await triggerTradeReview(5);
      await refreshLessons();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'review failed');
    } finally {
      setBusyReview(false);
    }
  };

  const handleCancel = async (exchange: string, orderId: string, symbol: string) => {
    setCancelling(orderId);
    try {
      await cancelExchangeOrder(exchange, orderId, symbol);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : 'cancel failed');
    } finally {
      setCancelling(null);
    }
  };

  const totalUnrealized = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const groupedPositions: Record<string, ExchangePosition[]> = {};
  for (const p of positions) {
    (groupedPositions[p.exchange] ??= []).push(p);
  }
  const groupedOrders: Record<string, ExchangeOrder[]> = {};
  for (const o of orders) {
    (groupedOrders[o.exchange] ??= []).push(o);
  }

  const EXCHANGE_LABELS: Record<string, string> = {
    'hyperliquid-testnet': 'Hyperliquid Testnet',
    'bitget-demo': 'Bitget Demo',
    'alpaca-paper': 'Alpaca Paper',
  };

  return (
    <div className="agent-main-panel" style={{ gap: 16, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 16 }}>
          <div><strong>持仓</strong> {positions.length}</div>
          <div><strong>挂单</strong> {orders.length}</div>
          <div>
            <strong>未实现盈亏</strong>{' '}
            <span style={{ color: totalUnrealized >= 0 ? '#26a69a' : '#ef5350' }}>
              {totalUnrealized >= 0 ? '+' : ''}{totalUnrealized.toFixed(2)}
            </span>
          </div>
          <div><strong>Lessons</strong> {lessons.length}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={runReview} disabled={busyReview}>
            {busyReview ? '复盘中…' : '触发复盘'}
          </button>
        </div>
      </div>

      {error && <div style={{ color: '#e06c75' }}>{error}</div>}

      <section>
        <h3 style={{ margin: '4px 0' }}>实时持仓</h3>
        {positions.length === 0 && <div style={{ opacity: 0.6, padding: 6 }}>无持仓</div>}
        {Object.entries(groupedPositions).map(([exchange, items]) => (
          <div key={exchange} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
              {EXCHANGE_LABELS[exchange] ?? exchange}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>标的</th>
                  <th style={{ textAlign: 'left' }}>方向</th>
                  <th style={{ textAlign: 'right' }}>数量</th>
                  <th style={{ textAlign: 'right' }}>开仓均价</th>
                  <th style={{ textAlign: 'right' }}>标记价</th>
                  <th style={{ textAlign: 'right' }}>未实现盈亏</th>
                  <th style={{ textAlign: 'right' }}>杠杆</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={`${p.exchange}:${p.symbol}:${p.side}`}>
                    <td>{p.symbol}</td>
                    <td style={{ color: p.side === 'long' ? '#26a69a' : '#ef5350' }}>
                      {p.side === 'long' ? '多' : '空'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{p.size}</td>
                    <td style={{ textAlign: 'right' }}>{p.entryPrice.toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{p.markPrice.toFixed(2)}</td>
                    <td style={{
                      textAlign: 'right',
                      color: p.unrealizedPnl >= 0 ? '#26a69a' : '#ef5350',
                    }}>
                      {p.unrealizedPnl >= 0 ? '+' : ''}{p.unrealizedPnl.toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'right' }}>{p.leverage != null ? `${p.leverage}x` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section>
        <h3 style={{ margin: '4px 0' }}>活跃订单</h3>
        {orders.length === 0 && <div style={{ opacity: 0.6, padding: 6 }}>无挂单</div>}
        {Object.entries(groupedOrders).map(([exchange, items]) => (
          <div key={exchange} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 4 }}>
              {EXCHANGE_LABELS[exchange] ?? exchange}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>标的</th>
                  <th style={{ textAlign: 'left' }}>方向</th>
                  <th style={{ textAlign: 'left' }}>类型</th>
                  <th style={{ textAlign: 'right' }}>数量</th>
                  <th style={{ textAlign: 'right' }}>价格</th>
                  <th style={{ textAlign: 'right' }}>已成交</th>
                  <th style={{ textAlign: 'left' }}>状态</th>
                  <th style={{ textAlign: 'center' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={`${o.exchange}:${o.orderId}`}>
                    <td>{o.symbol}</td>
                    <td style={{ color: o.side === 'buy' ? '#26a69a' : '#ef5350' }}>
                      {o.side}
                    </td>
                    <td>{o.orderType}</td>
                    <td style={{ textAlign: 'right' }}>{o.size}</td>
                    <td style={{ textAlign: 'right' }}>{o.price?.toFixed(2) ?? 'market'}</td>
                    <td style={{ textAlign: 'right' }}>{o.filledSize}</td>
                    <td>{o.status}</td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        style={{ fontSize: 11, padding: '2px 8px' }}
                        disabled={cancelling === o.orderId}
                        onClick={() => void handleCancel(o.exchange, o.orderId, o.symbol)}
                      >
                        {cancelling === o.orderId ? '撤销中…' : '撤单'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      <section>
        <h3 style={{ margin: '4px 0' }}>Recent Lessons</h3>
        {loading && <div style={{ opacity: 0.6 }}>加载中…</div>}
        {!loading && lessons.length === 0 && <div style={{ opacity: 0.6 }}>尚未生成 lesson。完成一笔交易并触发复盘后会出现。</div>}
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {lessons.slice(0, 20).map((l) => (
            <li key={l.id}>
              <span style={{ opacity: 0.6 }}>{l.instrumentKey}</span> · [{l.category || 'general'}] {l.text}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
