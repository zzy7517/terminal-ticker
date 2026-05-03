import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bot,
  CircleDot,
  History,
  Loader2,
  Minus,
  Moon,
  MousePointer2,
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
  connectStateSocket,
  fetchAgentSession,
  fetchAgentModels,
  fetchState,
  loadOlderCandles,
  removeWatchlistInstrument,
  resetAgentSession,
  saveAgentConfig,
  saveInstrumentAnalysisInterval,
  searchInstruments,
  sendAgentMessage,
} from './api';
import type {
  AgentAnalysis,
  AgentConfigUpdate,
  AgentMessage,
  AgentModelOption,
  AgentSessionResponse,
  CandlePoint,
  Instrument,
  InstrumentSearchResult,
  MarketState,
  Quote,
} from './types';
import { svgPoint, useChartDrawings } from './chartDrawings';

const GROUP_LABELS: Record<string, string> = {
  stocks: '美股',
  crypto: 'Crypto',
  metals: 'Metals',
  indices: 'Indices',
  watchlist: 'Watchlist',
  other: 'Other',
};

const REASONING_OPTIONS = ['low', 'medium', 'high', 'xhigh'];
const PROVIDERS_HASH = '#/settings/providers';
const WATCHLIST_HASH = '#/settings/watchlist';
const THEME_STORAGE_KEY = 'terminal-ticker-theme';
const ANALYSIS_INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];
type SettingsSection = 'providers' | 'watchlist';
type SearchSource = 'bitget' | 'alpaca';
type SourceHint = SearchSource | 'longbridge';
type ThemeName = 'light' | 'tokyo-night';

type AppRoute =
  | { view: 'workspace' }
  | { view: 'settings'; section: SettingsSection };

const THEME_LABELS: Record<ThemeName, string> = {
  light: 'Light',
  'tokyo-night': 'Tokyo Night',
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
  'tokyo-night': {
    chart: {
      layout: {
        background: { type: ColorType.Solid, color: '#11121a' },
        textColor: 'rgba(192, 202, 245, 0.72)',
        fontFamily: 'Aptos, "Avenir Next", "Segoe UI", sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(122, 162, 247, 0.10)' },
        horzLines: { color: 'rgba(122, 162, 247, 0.12)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(122, 162, 247, 0.22)',
        scaleMargins: { top: 0.12, bottom: 0.14 },
      },
      timeScale: {
        borderColor: 'rgba(122, 162, 247, 0.22)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(125, 207, 255, 0.42)' },
        horzLine: { color: 'rgba(125, 207, 255, 0.42)' },
      },
    },
    series: {
      upColor: '#9ece6a',
      downColor: '#f7768e',
      wickUpColor: '#9ece6a',
      wickDownColor: '#f7768e',
      borderVisible: false,
    },
  },
};

function readInitialTheme(): ThemeName {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'tokyo-night' ? 'tokyo-night' : 'light';
  } catch {
    return 'light';
  }
}

function nextTheme(theme: ThemeName): ThemeName {
  return theme === 'tokyo-night' ? 'light' : 'tokyo-night';
}

// Converts the browser hash into the app's internal route shape.
function readRouteFromHash(): AppRoute {
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
    window.location.hash = route.section === 'watchlist' ? WATCHLIST_HASH : PROVIDERS_HASH;
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
  const preferred = ['stocks', 'crypto', 'metals', 'indices', 'watchlist', 'other'];
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

// Maps local strategy side to the visual tone used by badges and rows.
function signalTone(quote: Quote | undefined) {
  const side = quote?.strategySignal?.side;
  if (side === 'long') return 'up';
  if (side === 'short') return 'down';
  return 'neutral';
}

// Maps agent bias to the same visual tone vocabulary as market signals.
function agentTone(analysis: AgentAnalysis | undefined) {
  const bias = analysis?.bias;
  if (bias === 'bullish') return 'up';
  if (bias === 'bearish') return 'down';
  if (bias === 'mixed') return 'mixed';
  return 'neutral';
}

// Normalizes provider confidence values that may arrive as either 0-1 or 0-100.
function agentConfidencePercent(analysis: AgentAnalysis | null | undefined) {
  if (!analysis?.available) return 0;
  const value = Number(analysis.confidence);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value <= 1 ? value * 100 : value);
}

// Returns the short source label shown beside an instrument.
function sourceLabel(instrument: Instrument | undefined) {
  if (!instrument) return '-';
  if (instrument.source === 'alpaca') return 'Alpaca';
  if (instrument.source === 'longbridge') return 'Longbridge';
  return instrument.source.toUpperCase();
}

// Formats a raw provider source identifier for settings and watchlist text.
function sourceName(source: string) {
  if (source === 'alpaca') return 'Alpaca';
  if (source === 'longbridge') return 'Longbridge';
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
  if (source === 'alpaca') return '美股';
  if (source === 'longbridge') return '美股';
  if (source === 'bitget') return 'Crypto';
  return sourceName(source);
}

// Builds provider sections while preserving a useful default source order.
function watchlistSections(instruments: Instrument[]) {
  const preferred = ['alpaca', 'longbridge', 'bitget'];
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
  const sourceMatch = body.match(/^(bitget|alpaca|longbridge)[:/](.+)$/i);
  if (sourceMatch) {
    sourceHint = sourceMatch[1].toLowerCase() as SourceHint;
    body = sourceMatch[2];
  }

  const upperBody = body.toUpperCase();
  let source: SearchSource;
  let symbol: string;
  let instType: string | null = null;

  if (sourceHint === 'alpaca' || sourceHint === 'longbridge' || (!sourceHint && upperBody.endsWith('.US'))) {
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

  const label = explicitLabel || (source === 'alpaca' ? symbol : defaultBitgetLabel(symbol));
  const key = source === 'alpaca' ? `alpaca:${symbol}` : `${instType}:${symbol}`;
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
    displayText: entry.source === 'bitget' ? `${entry.instType} · ${entry.symbol}` : entry.symbol,
    exists: entry.exists,
  };
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

// Aggregates watchlist quotes into the sidebar's market-bias summary.
function marketPulse(state: MarketState | null) {
  const quotes = state ? Object.values(state.quotes) : [];
  return quotes.reduce(
    (acc, quote) => {
      acc.total += 1;
      if (quote.stale || quote.status === 'stale') acc.stale += 1;
      if ((quote.changePercent ?? 0) > 0) acc.up += 1;
      if ((quote.changePercent ?? 0) < 0) acc.down += 1;
      if (quote.strategySignal?.available && quote.strategySignal.side !== 'flat') acc.signals += 1;
      return acc;
    },
    { total: 0, up: 0, down: 0, stale: 0, signals: 0 },
  );
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

// Projects recent closes into a compact SVG sparkline polyline.
function sparklinePoints(candles: CandlePoint[], width = 112, height = 34) {
  const closes = candles.slice(-60).map((item) => item.close).filter(Number.isFinite);
  if (closes.length < 2) return '';
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = Math.max(max - min, Math.abs(max) * 0.002, 0.0001);
  return closes
    .map((close, index) => {
      const x = (index / (closes.length - 1)) * width;
      const y = height - ((close - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

// Owns the main K-line chart instance, incremental data updates, and drawing overlay.
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
  const redrawFrameRef = useRef<number | null>(null);
  const canLoadOlderRef = useRef(canLoadOlder);
  const olderLoadingRef = useRef(olderLoading);
  const onLoadOlderRef = useRef(onLoadOlder);
  const initialThemeRef = useRef(CHART_THEMES[theme]);
  const [, setRenderTick] = useState(0);
  const {
    activeTool,
    clearDrawings,
    hasDrawings,
    setDrawingTool,
    visibleTrendDrawings,
  } = useChartDrawings({
    chart: chartApi,
    series: seriesApi,
    chartKey,
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

  // Schedules a lightweight React render so SVG drawings follow chart movement.
  const requestOverlayRender = () => {
    if (redrawFrameRef.current !== null) return;
    redrawFrameRef.current = window.requestAnimationFrame(() => {
      redrawFrameRef.current = null;
      setRenderTick((value) => value + 1);
    });
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
      requestOverlayRender();
    };
    container.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    container.addEventListener('pointermove', requestOverlayRender);
    container.addEventListener('pointerup', requestOverlayRender);
    container.addEventListener('dblclick', requestOverlayRender);
    // Keeps overlays and historical pagination in sync with visible time changes.
    const handleLogicalRange = (range: { from: number; to: number } | null) => {
      requestOverlayRender();
      maybeLoadOlder(range);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleLogicalRange);
    chart.timeScale().subscribeSizeChange(requestOverlayRender);

    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true });
      container.removeEventListener('pointermove', requestOverlayRender);
      container.removeEventListener('pointerup', requestOverlayRender);
      container.removeEventListener('dblclick', requestOverlayRender);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleLogicalRange);
      chart.timeScale().unsubscribeSizeChange(requestOverlayRender);
      if (redrawFrameRef.current !== null) {
        window.cancelAnimationFrame(redrawFrameRef.current);
        redrawFrameRef.current = null;
      }
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const visualTheme = CHART_THEMES[theme];
    chart?.applyOptions(visualTheme.chart);
    series?.applyOptions(visualTheme.series);
    requestOverlayRender();
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
    requestOverlayRender();
  }, [candles, chartKey]);

  return (
    <div className={`chart-shell ${activeTool !== 'cursor' ? 'drawing-active' : ''}`}>
      <div ref={containerRef} className="chart-canvas" />
      <div className="drawing-toolbar" aria-label="Chart drawing tools">
        <button
          aria-label="Cursor"
          className={`drawing-tool ${activeTool === 'cursor' ? 'active' : ''}`}
          onClick={() => setDrawingTool('cursor')}
          title="Cursor"
          type="button"
        >
          <MousePointer2 size={15} />
        </button>
        <button
          aria-label="Horizontal line"
          className={`drawing-tool ${activeTool === 'horizontal' ? 'active' : ''}`}
          onClick={() => setDrawingTool('horizontal')}
          title="Horizontal line"
          type="button"
        >
          <Minus size={16} />
        </button>
        <button
          aria-label="Trend line"
          className={`drawing-tool ${activeTool === 'trend' ? 'active' : ''}`}
          onClick={() => setDrawingTool('trend')}
          title="Trend line"
          type="button"
        >
          <TrendingUp size={15} />
        </button>
        <button
          aria-label="Clear drawings"
          className="drawing-tool danger"
          disabled={!hasDrawings}
          onClick={clearDrawings}
          title="Clear drawings"
          type="button"
        >
          <Trash2 size={15} />
        </button>
        <button
          aria-label="Load older candles"
          className="drawing-tool"
          disabled={!canLoadOlder || olderLoading}
          onClick={onLoadOlder}
          title="Load older candles"
          type="button"
        >
          {olderLoading ? <Loader2 className="spin" size={15} /> : <History size={15} />}
        </button>
      </div>
      <svg aria-hidden="true" className="drawing-layer">
        {visibleTrendDrawings.map((drawing) => {
          const start = svgPoint(drawing.start, chartRef.current, seriesRef.current);
          const end = svgPoint(drawing.end, chartRef.current, seriesRef.current);
          if (!start || !end) return null;
          return (
            <line
              className={`drawing-line trend ${drawing.id === 'preview' ? 'preview' : ''}`}
              key={drawing.id}
              x1={start.x}
              x2={end.x}
              y1={start.y}
              y2={end.y}
            />
          );
        })}
      </svg>
      {candles.length === 0 && (
        <div className="chart-empty">
          <BarChart3 size={28} />
          <span>等待 K 线数据</span>
        </div>
      )}
    </div>
  );
}

// Renders a tiny trend preview for each watchlist row.
function Sparkline({ candles, tone }: { candles: CandlePoint[]; tone: string }) {
  const points = sparklinePoints(candles);
  return (
    <svg className={`sparkline ${tone}`} viewBox="0 0 112 34" aria-hidden="true">
      {points ? (
        <>
          <polygon className="sparkline-area" points={`0,34 ${points} 112,34`} />
          <polyline className="sparkline-line" points={points} />
        </>
      ) : (
        <line className="sparkline-empty-line" x1="8" x2="104" y1="17" y2="17" />
      )}
    </svg>
  );
}

// Renders one selectable symbol row with quote, signal, and sparkline state.
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
  const tone = signalTone(quote);
  const signal = quote?.strategySignal;
  return (
    <button className={`watch-row ${selected ? 'selected' : ''}`} onClick={onSelect} type="button">
      <div className="watch-main">
        <div>
          <div className="symbol-line">
            <span>{instrument.label}</span>
            <small>{sourceLabel(instrument)}</small>
          </div>
          <div className="reason-line">
            {signal?.available ? `${signal.side.toUpperCase()} · ${signal.regime}` : '等待 K 线'}
          </div>
        </div>
        <div className="price-stack">
          <strong>{quote?.priceLabel ?? '-'}</strong>
          <span className={changeClass(quote)}>{quote?.percentLabel ?? '-'}</span>
        </div>
      </div>
      <Sparkline candles={quote?.thumbnailCandles ?? quote?.candles ?? []} tone={changeClass(quote)} />
      <div className="watch-meta">
        <span className={`marker ${tone}`}>{signal?.available ? signal.side.toUpperCase() : '--'}</span>
        <span>{quote?.ageLabel ?? 'waiting'}</span>
      </div>
    </button>
  );
}

// Renders the watchlist-wide risk-on/risk-off summary.
function SidebarCompass({ state }: { state: MarketState | null }) {
  const pulse = marketPulse(state);
  const total = pulse.total || 1;
  return (
    <div className="sidebar-compass">
      <div
        className="compass-ring"
        style={{ '--share': `${(pulse.up / total) * 100}%` } as CSSProperties}
        aria-hidden="true"
      />
      <div>
        <span className="panel-label">Market Bias</span>
        <strong>{pulse.up >= pulse.down ? 'Risk-on scan' : 'Defensive scan'}</strong>
        <small>{pulse.up} advancing · {pulse.down} declining</small>
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
            <div className="settings-window-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
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
      const nextState = result.source === 'bitget'
        ? await addBitgetSymbol(result)
        : await addAlpacaSymbol(result);
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
        const nextState = entry.source === 'bitget'
          ? await addBitgetSymbol(result)
          : await addAlpacaSymbol(result);
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
              placeholder={'BTCUSDT\nSPOT:ETHUSDT\nAAPL.US'}
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
            </div>
            <div className="settings-search">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runSearch();
                }}
                placeholder={searchSource === 'bitget' ? 'BTC / BTCUSDT' : 'AAPL / Apple'}
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

// Renders the structured fields returned by the chart-agent provider.
function AgentAnalysisBlock({ analysis }: { analysis: AgentAnalysis }) {
  const confidence = agentConfidencePercent(analysis);
  return (
    <>
      <p>{analysis.available ? analysis.summary : analysis.error || 'Agent response unavailable.'}</p>
      {analysis.available && (
        <>
          <div className="confidence-meter">
            <div>
              <span>Confidence</span>
              <strong>{confidence}%</strong>
            </div>
            <div className="confidence-track">
              <span style={{ width: `${Math.max(4, Math.min(100, confidence))}%` }} />
            </div>
          </div>
          <div className="agent-levels">
            {analysis.keyLevels.slice(0, 3).map((level, index) => (
              <div className="agent-level" key={`${level.label}-${index}`}>
                <span>{level.label || 'Level'}</span>
                <strong>{formatLevelPrice(level.price)}</strong>
                <small>{level.reason}</small>
              </div>
            ))}
          </div>
          <div className="agent-plan">
            {analysis.watchPlan.slice(0, 3).map((item, index) => (
              <div key={`${item}-${index}`}>{item}</div>
            ))}
          </div>
          {analysis.invalidation && (
            <div className="agent-invalidation">
              <span>Invalidation</span>
              <strong>{analysis.invalidation}</strong>
            </div>
          )}
          {analysis.riskNotes.length > 0 && (
            <div className="risk-notes">
              <span>Risk notes</span>
              {analysis.riskNotes.slice(0, 2).map((item, index) => (
                <small key={`${item}-${index}`}>{item}</small>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

// Renders one persisted chat turn in the chart-agent transcript.
function AgentTranscriptMessage({ message }: { message: AgentMessage }) {
  const analysis = message.analysis;
  const tone = agentTone(analysis ?? undefined);
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Agent' : 'System';
  return (
    <div className={`session-message ${message.role}`}>
      <div className="session-message-head">
        <span>{label}</span>
        <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
      </div>
      {message.role === 'assistant' && analysis ? (
        <>
          <div className="session-analysis-head">
            <span className={`agent-bias ${tone}`}>{analysis.bias}</span>
            <small>{analysis.model}</small>
          </div>
          <AgentAnalysisBlock analysis={analysis} />
        </>
      ) : (
        <p>{message.content || message.error || 'No content.'}</p>
      )}
    </div>
  );
}

// Renders the active per-instrument chart-agent session and compose box.
function AgentSessionPanel({
  analysis,
  session,
  prompt,
  sessionLoading,
  busy,
  disabled,
  onPromptChange,
  onSend,
  onReset,
}: {
  analysis: AgentAnalysis | undefined;
  session: AgentSessionResponse | null;
  prompt: string;
  sessionLoading: boolean;
  busy: boolean;
  disabled: boolean;
  onPromptChange: (value: string) => void;
  onSend: () => Promise<void>;
  onReset: () => Promise<void>;
}) {
  const messages = session?.messages ?? [];
  const latestAnalysis =
    [...messages].reverse().find((message) => message.analysis)?.analysis ?? analysis;
  const tone = agentTone(latestAnalysis ?? undefined);
  const canSend = !disabled && !busy && !sessionLoading;
  const sessionTime = session?.session
    ? new Date(session.session.updatedAt).toLocaleTimeString()
    : 'No session';

  return (
    <div className="agent-card agent-readout agent-session-card">
      <div className="agent-card-head">
        <span className="panel-label with-icon">
          <Sparkles size={14} /> Chart Session
        </span>
        <span className={`agent-bias ${tone}`}>{latestAnalysis?.bias ?? 'idle'}</span>
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
  agentPrompt,
  agentBusyKey,
  agentSessionLoading,
  analysisIntervalBusy,
  olderBusyKey,
  exhaustedHistoryKeys,
  setActiveGroup,
  setSelectedKey,
  setState,
  setAgentPrompt,
  updateAnalysisInterval,
  loadOlderForSelected,
  runAgentAnalysis,
  resetAgentConversation,
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
  agentPrompt: string;
  agentBusyKey: string | null;
  agentSessionLoading: boolean;
  analysisIntervalBusy: boolean;
  olderBusyKey: string | null;
  exhaustedHistoryKeys: Set<string>;
  setActiveGroup: (value: string) => void;
  setSelectedKey: (value: string) => void;
  setState: (state: MarketState) => void;
  setAgentPrompt: (value: string) => void;
  updateAnalysisInterval: (value: string) => void;
  loadOlderForSelected: () => void;
  runAgentAnalysis: () => Promise<void>;
  resetAgentConversation: () => Promise<void>;
  onThemeToggle: () => void;
  openSettings: () => void;
  openWatchlistSettings: () => void;
}) {
  const activeKeys = activeGroup && state ? state.groups[activeGroup] ?? [] : [];
  const currentInterval = selectedInstrument?.analysisInterval ?? state?.config.analysis.interval ?? '5m';
  const candleDelta = closeDeltaPercent(selectedQuote?.candles ?? []);
  const signal = selectedQuote?.strategySignal;
  const tone = signalTone(selectedQuote);
  const historyKey = selectedKey ? `${selectedKey}:${currentInterval}` : null;
  const canLoadOlder =
    Boolean(selectedInstrument && ['alpaca', 'bitget'].includes(selectedInstrument.source)) &&
    Boolean(historyKey && !exhaustedHistoryKeys.has(historyKey));
  const nextThemeName = nextTheme(theme);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <Zap size={21} />
          </div>
          <div>
            <div className="eyebrow">Local Price Action Agent</div>
            <h1>Terminal Ticker</h1>
          </div>
        </div>
        <div className="topbar-right">
          <ConnectionBadge socketStatus={socketStatus} streamStatus={state?.streamStatus ?? 'idle'} />
          <button
            aria-label={`Switch to ${THEME_LABELS[nextThemeName]} skin`}
            aria-pressed={theme === 'tokyo-night'}
            className="shell-button theme-toggle"
            onClick={onThemeToggle}
            title={`Switch to ${THEME_LABELS[nextThemeName]}`}
            type="button"
          >
            {theme === 'tokyo-night' ? <Sun size={16} /> : <Moon size={16} />}
            <span>{THEME_LABELS[nextThemeName]}</span>
          </button>
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
          <button className="shell-button" type="button" onClick={openSettings}>
            <Settings size={16} />
            Settings
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-head">
            <div>
              <span>Watchlist</span>
              <small>{state?.instruments.length ?? 0} symbols under watch</small>
            </div>
            <button
              aria-label="Manage watchlist"
              className="sidebar-manage-button"
              onClick={openWatchlistSettings}
              type="button"
            >
              <Settings size={16} />
            </button>
          </div>
          <SidebarCompass state={state} />
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
        </aside>

        <section className="chart-panel">
          <div className="chart-header">
            <div>
              <div className="instrument-kicker">
                <span>{sourceLabel(selectedInstrument)}</span>
                <span>{selectedInstrument?.symbol ?? '-'}</span>
                <span>{currentInterval}</span>
              </div>
              <h2>{selectedInstrument?.label ?? '选择标的'}</h2>
              <div className="instrument-meta-row">
                <span>{selectedQuote?.exchange || selectedQuote?.currency || 'local feed'}</span>
                <span>{selectedQuote?.candles.length ?? 0} candles</span>
                <span>{selectedQuote?.status ?? 'waiting'}</span>
              </div>
            </div>
            <div className="price-readout">
              <span className="readout-label">Last</span>
              <strong>{selectedQuote?.priceLabel ?? '-'}</strong>
              <span className={changeClass(selectedQuote)}>
                {selectedQuote?.changeLabel ?? '-'} · {selectedQuote?.percentLabel ?? '-'}
              </span>
            </div>
          </div>

          <div className="analysis-strip">
            <div className={`analysis-marker ${tone}`}>
              {signal?.available ? signal.side.toUpperCase() : '--'}
            </div>
            <div>
              <strong>
                {signal?.available
                  ? `${signal.regime} · confidence ${Math.round(signal.confidence * 100)}%`
                  : '等待 strategy context'}
              </strong>
              <span>
                {signal?.available
                  ? signal.reason
                  : '需要足够 K 线后才生成 long / short / flat 研究信号'}
              </span>
            </div>
            <Activity className={signal?.available ? 'analysis-check' : 'analysis-waiting'} size={18} />
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
        </section>

        <aside className="agent-panel">
          <AgentSessionPanel
            analysis={selectedAgent}
            session={agentSession}
            prompt={agentPrompt}
            sessionLoading={agentSessionLoading}
            busy={agentBusyKey === selectedKey}
            disabled={!selectedKey || !selectedQuote?.candles.length || !state?.config.agent.enabled}
            onPromptChange={setAgentPrompt}
            onSend={runAgentAnalysis}
            onReset={resetAgentConversation}
          />
          <div className="agent-card dense">
            <span className="panel-label">Feed</span>
            <div className="kv-row">
              <span>Status</span>
              <strong>{state?.streamStatus ?? 'idle'}</strong>
            </div>
            <div className="kv-row">
              <span>Updated</span>
              <strong>{state ? new Date(state.updatedAt).toLocaleTimeString() : '-'}</strong>
            </div>
            <div className="kv-row">
              <span>Source</span>
              <strong>{sourceLabel(selectedInstrument)}</strong>
            </div>
          </div>
          <div className="agent-card dense">
            <span className="panel-label">Provider</span>
            <div className="kv-row">
              <span>Current</span>
              <strong>{state?.config.agent.provider ?? 'codex'}</strong>
            </div>
            <div className="kv-row">
              <span>Model</span>
              <strong>{state?.config.agent.model ?? '-'}</strong>
            </div>
            <div className="kv-row">
              <span>Status</span>
              <strong>{state?.config.agent.enabled ? 'enabled' : 'disabled'}</strong>
            </div>
          </div>
          <div className="agent-card dense">
            <span className="panel-label">Boundary</span>
            <p>本地监控和解释层，不下单、不管理仓位、不生成买卖按钮。</p>
          </div>
          <button className="refresh-button" type="button" onClick={() => fetchState().then(setState)}>
            <RefreshCw size={16} />
            Refresh snapshot
          </button>
        </aside>
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
      provider: 'codex',
      apiMode: config.apiMode,
      model: config.model,
      timeoutSeconds: config.timeoutSeconds,
      maxCandles: config.maxCandles,
      reasoningEffort: config.reasoningEffort,
    });
  }, [configSignature]);

  // Refreshes the provider model catalog and updates the draft selection if needed.
  async function refreshModels() {
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
      const nextState = await saveAgentConfig({ ...draft, provider: 'codex' });
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

  const providerVisible = 'codex'.includes(providerSearch.trim().toLowerCase());
  const modelOptions = models.some((model) => model.slug === draft.model)
    ? models
    : [
        {
          slug: draft.model,
          displayName: draft.model,
          description: '',
          visibility: 'active',
          supportedInApi: true,
          defaultReasoningEffort: draft.reasoningEffort,
          supportedReasoningEfforts: REASONING_OPTIONS,
          contextWindow: null,
          preferWebsockets: true,
        },
        ...models,
      ];
  const visibleModels = modelOptions.filter((model) => {
    const keyword = modelSearch.trim().toLowerCase();
    if (!keyword) return true;
    return `${model.displayName} ${model.slug} ${model.description}`.toLowerCase().includes(keyword);
  });
  const selectedModel = modelOptions.find((model) => model.slug === draft.model);
  const reasoningOptions = selectedModel?.supportedReasoningEfforts.length
    ? selectedModel.supportedReasoningEfforts
    : REASONING_OPTIONS;

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
                {providerVisible ? (
                  <button className="provider-item selected" type="button">
                    <div className="provider-item-icon">
                      <Bot size={18} />
                    </div>
                    <div className="provider-item-copy">
                      <strong>Codex</strong>
                      <small>Responses adapter for chart analysis</small>
                    </div>
                    <span className="provider-item-dot" />
                  </button>
                ) : (
                  <div className="provider-empty">No providers match this search.</div>
                )}
              </div>
            </section>

            <section className="provider-detail">
              <div className="provider-hero">
                <div>
                  <div className="provider-hero-title">
                    <h3>Codex</h3>
                    <span className={`provider-state-badge ${draft.enabled ? 'active' : 'inactive'}`}>
                      {draft.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </div>
                  <p>Codex Responses adapter used by the chart agent for structured commentary and watch-plan output.</p>
                </div>
                <label className="switch-row">
                  <span>Enabled</span>
                  <input
                    checked={draft.enabled}
                    onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                    type="checkbox"
                  />
                  <span className="switch-slider" />
                </label>
              </div>

              <div className="provider-section">
                <div className="provider-section-card">
                  <div className="provider-section-head">
                    <strong>Provider</strong>
                    <span className="provider-inline-badge">Locked</span>
                  </div>
                  <div className="provider-fixed-field">codex</div>
                </div>
                <div className="provider-section-card">
                  <div className="provider-section-head">
                    <strong>API Mode</strong>
                    <span className="provider-inline-badge">Readonly</span>
                  </div>
                  <div className="provider-fixed-field">{draft.apiMode}</div>
                </div>
              </div>

              <div className="provider-form-grid">
                <label>
                  <span>Reasoning Effort</span>
                  <select
                    value={draft.reasoningEffort}
                    onChange={(event) => setDraft({ ...draft, reasoningEffort: event.target.value })}
                  >
                    {reasoningOptions.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
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
  const [agentSession, setAgentSession] = useState<AgentSessionResponse | null>(null);
  const [agentPrompt, setAgentPrompt] = useState('');
  const [analysisIntervalBusy, setAnalysisIntervalBusy] = useState(false);
  const [olderBusyKey, setOlderBusyKey] = useState<string | null>(null);
  const [exhaustedHistoryKeys, setExhaustedHistoryKeys] = useState<Set<string>>(() => new Set());
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

  useEffect(() => {
    if (!selectedKey) {
      setAgentSession(null);
      setAgentPrompt('');
      return;
    }
    let disposed = false;
    const key = selectedKey;
    setAgentSessionLoadingKey(key);
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
      !['alpaca', 'bitget'].includes(selectedInstrument.source)
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
      const payload = await sendAgentMessage(selectedKey, agentPrompt);
      setState(payload.state);
      setAgentSession(payload.session);
      setAgentPrompt('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'agent analysis failed';
      const fallback: AgentAnalysis = {
        available: false,
        provider: state?.config.agent.provider ?? 'codex',
        model: state?.config.agent.model ?? '-',
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
      agentPrompt={agentPrompt}
      agentBusyKey={agentBusyKey}
      agentSessionLoading={agentSessionLoadingKey === selectedKey}
      analysisIntervalBusy={analysisIntervalBusy}
      olderBusyKey={olderBusyKey}
      exhaustedHistoryKeys={exhaustedHistoryKeys}
      setActiveGroup={setActiveGroup}
      setSelectedKey={setSelectedKey}
      setState={setState}
      setAgentPrompt={setAgentPrompt}
      updateAnalysisInterval={updateAnalysisInterval}
      loadOlderForSelected={loadOlderForSelected}
      runAgentAnalysis={runAgentAnalysis}
      resetAgentConversation={resetAgentConversation}
      onThemeToggle={() => setTheme((current) => nextTheme(current))}
      openSettings={() => navigateToRoute({ view: 'settings', section: 'providers' })}
      openWatchlistSettings={() => navigateToRoute({ view: 'settings', section: 'watchlist' })}
    />
  );
}
