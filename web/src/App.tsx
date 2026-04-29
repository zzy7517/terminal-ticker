import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bot,
  CircleDot,
  Loader2,
  Minus,
  MousePointer2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sparkles,
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
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  addBitgetSymbol,
  addLongbridgeSymbol,
  analyzeInstrument,
  connectStateSocket,
  fetchAgentModels,
  fetchState,
  removeWatchlistInstrument,
  saveAgentConfig,
  saveInstrumentAnalysisInterval,
  searchInstruments,
} from './api';
import type {
  AgentAnalysis,
  AgentConfigUpdate,
  AgentModelOption,
  CandlePoint,
  Instrument,
  InstrumentSearchResult,
  MarketState,
  Quote,
} from './types';

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
const ANALYSIS_INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];
type SettingsSection = 'providers' | 'watchlist';
type SearchSource = 'bitget' | 'longbridge';

type AppRoute =
  | { view: 'workspace' }
  | { view: 'settings'; section: SettingsSection };

function readRouteFromHash(): AppRoute {
  if (window.location.hash.startsWith(WATCHLIST_HASH)) {
    return { view: 'settings', section: 'watchlist' };
  }
  if (window.location.hash.startsWith(PROVIDERS_HASH)) {
    return { view: 'settings', section: 'providers' };
  }
  return { view: 'workspace' };
}

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

function orderedGroups(state: MarketState | null) {
  if (!state) return [];
  const preferred = ['stocks', 'crypto', 'metals', 'indices', 'watchlist', 'other'];
  const present = Object.keys(state.groups);
  return [
    ...preferred.filter((group) => present.includes(group)),
    ...present.filter((group) => !preferred.includes(group)).sort(),
  ];
}

function changeClass(quote: Quote | undefined) {
  if (!quote || quote.change == null) return 'neutral';
  if (quote.change > 0) return 'up';
  if (quote.change < 0) return 'down';
  return 'neutral';
}

function signalTone(quote: Quote | undefined) {
  const side = quote?.strategySignal?.side;
  if (side === 'long') return 'up';
  if (side === 'short') return 'down';
  return 'neutral';
}

function agentTone(analysis: AgentAnalysis | undefined) {
  const bias = analysis?.bias;
  if (bias === 'bullish') return 'up';
  if (bias === 'bearish') return 'down';
  if (bias === 'mixed') return 'mixed';
  return 'neutral';
}

function sourceLabel(instrument: Instrument | undefined) {
  if (!instrument) return '-';
  return instrument.source === 'longbridge' ? 'Longbridge' : instrument.source.toUpperCase();
}

function sourceName(source: string) {
  return source === 'longbridge' ? 'Longbridge' : source.toUpperCase();
}

function instrumentVenue(instrument: Instrument) {
  if (instrument.source === 'bitget') {
    return instrument.instType ?? instrument.key.split(':', 1)[0] ?? 'Bitget';
  }
  return sourceName(instrument.source);
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

function defaultBitgetLabel(symbol: string) {
  return symbol.endsWith('USDT') ? symbol.slice(0, -4) || symbol : symbol;
}

function parseBulkLine(raw: string, activeKeys: Set<string>): Omit<BulkEntry, 'inputDuplicate'> | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const [token = '', ...labelParts] = trimmed.split(/\s+/);
  const explicitLabel = labelParts.join(' ').trim();
  let sourceHint: SearchSource | null = null;
  let body = token.trim();
  const sourceMatch = body.match(/^(bitget|longbridge)[:/](.+)$/i);
  if (sourceMatch) {
    sourceHint = sourceMatch[1].toLowerCase() as SearchSource;
    body = sourceMatch[2];
  }

  const upperBody = body.toUpperCase();
  let source: SearchSource;
  let symbol: string;
  let instType: string | null = null;

  if (sourceHint === 'longbridge' || (!sourceHint && upperBody.includes('.'))) {
    source = 'longbridge';
    symbol = upperBody;
    if (!symbol.includes('.')) {
      return {
        raw: trimmed,
        source,
        symbol,
        label: explicitLabel || symbol,
        instType,
        key: `longbridge:${symbol}`,
        valid: false,
        exists: false,
        error: 'Longbridge symbol needs a market suffix.',
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

  const label = explicitLabel || (source === 'longbridge' ? symbol.split('.', 1)[0] : defaultBitgetLabel(symbol));
  const key = source === 'longbridge' ? `longbridge:${symbol}` : `${instType}:${symbol}`;
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

function formatLevelPrice(price: number | null) {
  if (price == null) return '-';
  return price.toFixed(price > 1000 ? 1 : 2);
}

function formatContextWindow(size: number | null) {
  if (size == null) return '-';
  if (size >= 1000) return `${Math.round(size / 1000)}K`;
  return String(size);
}

function formatSignedNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toFixed(2)}`;
}

function candleRangeLabel(candles: CandlePoint[]) {
  if (candles.length === 0) return '-';
  const low = Math.min(...candles.map((item) => item.low));
  const high = Math.max(...candles.map((item) => item.high));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return '-';
  return `${formatLevelPrice(low)} / ${formatLevelPrice(high)}`;
}

function closeDeltaPercent(candles: CandlePoint[]) {
  if (candles.length < 2) return null;
  const first = candles[0].close;
  const last = candles[candles.length - 1].close;
  if (!Number.isFinite(first) || first === 0 || !Number.isFinite(last)) return null;
  return ((last - first) / Math.abs(first)) * 100;
}

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
type DrawingTool = 'cursor' | 'horizontal' | 'trend';
type DrawingPoint = {
  time: UTCTimestamp;
  price: number;
};
type ChartDrawing =
  | { id: string; kind: 'horizontal'; price: number }
  | { id: string; kind: 'trend'; start: DrawingPoint; end: DrawingPoint };

function toChartCandles(candles: CandlePoint[]): ChartCandle[] {
  return candles.map((item) => ({
    time: item.time as UTCTimestamp,
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close,
  }));
}

function sameChartCandle(left: ChartCandle, right: ChartCandle) {
  return (
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close
  );
}

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

function candleSignature(data: ChartCandle[]) {
  if (data.length === 0) return 'empty';
  return data
    .map((item) => [item.time, item.open, item.high, item.low, item.close].join(':'))
    .join('|');
}

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

function createDrawingId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function intervalOptions(currentInterval: string) {
  if (ANALYSIS_INTERVAL_OPTIONS.includes(currentInterval)) {
    return ANALYSIS_INTERVAL_OPTIONS;
  }
  return [currentInterval, ...ANALYSIS_INTERVAL_OPTIONS];
}

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

function svgPoint(
  point: DrawingPoint,
  chart: IChartApi | null,
  series: ISeriesApi<'Candlestick'> | null,
) {
  if (!chart || !series) return null;
  const x = chart.timeScale().timeToCoordinate(point.time);
  const y = series.priceToCoordinate(point.price);
  if (x == null || y == null) return null;
  return { x, y };
}

function chartPointFromParam(
  param: MouseEventParams,
  series: ISeriesApi<'Candlestick'> | null,
): DrawingPoint | null {
  if (!series || !param.point || typeof param.time !== 'number') return null;
  const price = series.coordinateToPrice(param.point.y);
  if (typeof price !== 'number') return null;
  return {
    time: param.time as UTCTimestamp,
    price,
  };
}

function CandlestickPane({ candles, chartKey }: { candles: CandlePoint[]; chartKey: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const dataRef = useRef<ChartCandle[]>([]);
  const signatureRef = useRef('');
  const chartKeyRef = useRef('');
  const redrawFrameRef = useRef<number | null>(null);
  const [drawingsByChart, setDrawingsByChart] = useState<Record<string, ChartDrawing[]>>({});
  const [activeTool, setActiveTool] = useState<DrawingTool>('cursor');
  const [trendStart, setTrendStart] = useState<DrawingPoint | null>(null);
  const [hoverPoint, setHoverPoint] = useState<DrawingPoint | null>(null);
  const [, setRenderTick] = useState(0);
  const drawings = drawingsByChart[chartKey] ?? [];

  const requestOverlayRender = () => {
    if (redrawFrameRef.current !== null) return;
    redrawFrameRef.current = window.requestAnimationFrame(() => {
      redrawFrameRef.current = null;
      setRenderTick((value) => value + 1);
    });
  };

  const setDrawingTool = (tool: DrawingTool) => {
    setActiveTool(tool);
    setTrendStart(null);
    setHoverPoint(null);
  };

  const clearDrawings = () => {
    setDrawingsByChart((current) => ({ ...current, [chartKey]: [] }));
    setTrendStart(null);
    setHoverPoint(null);
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      autoSize: true,
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
        autoScale: true,
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

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#2e9a66',
      downColor: '#c65047',
      wickUpColor: '#25885b',
      wickDownColor: '#b3433d',
      borderVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = series;

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
    chart.timeScale().subscribeVisibleLogicalRangeChange(requestOverlayRender);
    chart.timeScale().subscribeSizeChange(requestOverlayRender);

    return () => {
      container.removeEventListener('wheel', handleWheel, { capture: true });
      container.removeEventListener('pointermove', requestOverlayRender);
      container.removeEventListener('pointerup', requestOverlayRender);
      container.removeEventListener('dblclick', requestOverlayRender);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(requestOverlayRender);
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
    if (!chart || !series) return;

    const data = toChartCandles(candles);
    const nextSignature = `${chartKey}:${candleSignature(data)}`;
    if (nextSignature === signatureRef.current) return;

    const previous = dataRef.current;
    const resetSeries = chartKeyRef.current !== chartKey;
    const wasFollowingRealtime = previous.length === 0 || Math.abs(chart.timeScale().scrollPosition()) < 2;

    if (resetSeries || data.length === 0 || !canUpdateLatestCandle(previous, data)) {
      series.setData(data);
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

  useEffect(() => {
    setTrendStart(null);
    setHoverPoint(null);
  }, [chartKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const handleClick = (param: MouseEventParams) => {
      const point = chartPointFromParam(param, seriesRef.current);
      if (!point || activeTool === 'cursor') return;

      if (activeTool === 'horizontal') {
        setDrawingsByChart((current) => ({
          ...current,
          [chartKey]: [
            ...(current[chartKey] ?? []),
            { id: createDrawingId(), kind: 'horizontal', price: point.price },
          ],
        }));
        return;
      }

      if (!trendStart) {
        setTrendStart(point);
        setHoverPoint(point);
        return;
      }

      setDrawingsByChart((current) => ({
        ...current,
        [chartKey]: [
          ...(current[chartKey] ?? []),
          { id: createDrawingId(), kind: 'trend', start: trendStart, end: point },
        ],
      }));
      setTrendStart(null);
      setHoverPoint(null);
    };

    const handleMove = (param: MouseEventParams) => {
      if (activeTool !== 'trend' || !trendStart) return;
      setHoverPoint(chartPointFromParam(param, seriesRef.current));
    };

    chart.subscribeClick(handleClick);
    chart.subscribeCrosshairMove(handleMove);
    return () => {
      chart.unsubscribeClick(handleClick);
      chart.unsubscribeCrosshairMove(handleMove);
    };
  }, [activeTool, chartKey, trendStart]);

  const previewDrawing: ChartDrawing | null =
    trendStart && hoverPoint
      ? { id: 'preview', kind: 'trend', start: trendStart, end: hoverPoint }
      : null;
  const visibleDrawings = previewDrawing ? [...drawings, previewDrawing] : drawings;

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
          disabled={drawings.length === 0 && !trendStart}
          onClick={clearDrawings}
          title="Clear drawings"
          type="button"
        >
          <Trash2 size={15} />
        </button>
      </div>
      <svg aria-hidden="true" className="drawing-layer">
        {visibleDrawings.map((drawing) => {
          if (drawing.kind === 'horizontal') {
            const y = seriesRef.current?.priceToCoordinate(drawing.price);
            if (y == null) return null;
            return (
              <line
                className="drawing-line horizontal"
                key={drawing.id}
                x1="0"
                x2="100%"
                y1={y}
                y2={y}
              />
            );
          }
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

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

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

  async function addResult(result: InstrumentSearchResult) {
    if (result.exists || busyKey) return;
    if (result.source === 'bitget' && !result.instType) {
      setStatus('Bitget result is missing instType.');
      return;
    }
    setBusyKey(result.key);
    setStatus(`Adding ${result.symbol}...`);
    try {
      const nextState = result.source === 'longbridge'
        ? await addLongbridgeSymbol(result)
        : await addBitgetSymbol(result);
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

  async function addBulkEntries() {
    if (!editable || bulkBusy || addableEntries.length === 0) return;
    setBulkBusy(true);
    setStatus(`Adding ${addableEntries.length} symbols...`);
    try {
      let added = 0;
      for (const entry of addableEntries) {
        const result = resultFromBulkEntry(entry);
        const nextState = entry.source === 'longbridge'
          ? await addLongbridgeSymbol(result)
          : await addBitgetSymbol(result);
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
            {state.instruments.map((instrument) => (
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
                className={searchSource === 'longbridge' ? 'active' : ''}
                type="button"
                onClick={() => {
                  setSearchSource('longbridge');
                  setResults([]);
                }}
              >
                Longbridge
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
                placeholder={searchSource === 'bitget' ? 'BTC / BTCUSDT' : 'AAPL.US / Apple'}
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

function AgentReadout({
  analysis,
  busy,
  disabled,
  onAnalyze,
}: {
  analysis: AgentAnalysis | undefined;
  busy: boolean;
  disabled: boolean;
  onAnalyze: () => void;
}) {
  const tone = agentTone(analysis);
  const confidence = analysis?.available ? Math.round(analysis.confidence * 100) : 0;
  return (
    <div className="agent-card agent-readout">
      <div className="agent-card-head">
        <span className="panel-label with-icon"><Sparkles size={14} /> Codex Read</span>
        <span className={`agent-bias ${tone}`}>{analysis?.bias ?? 'idle'}</span>
      </div>
      <p>
        {analysis?.available
          ? analysis.summary
          : analysis?.error || '把当前 quote、OHLCV K 线和本地结构化特征交给 Codex provider 做一次解读。'}
      </p>
      {analysis?.available && (
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
      <button className="agent-action" type="button" onClick={onAnalyze} disabled={disabled || busy}>
        {busy ? <Loader2 className="spin" size={16} /> : <Bot size={16} />}
        {busy ? 'Analyzing' : 'Run Codex Read'}
      </button>
    </div>
  );
}

function WorkspaceView({
  state,
  socketStatus,
  groups,
  activeGroup,
  selectedKey,
  selectedInstrument,
  selectedQuote,
  selectedAgent,
  agentBusyKey,
  analysisIntervalBusy,
  setActiveGroup,
  setSelectedKey,
  setState,
  updateAnalysisInterval,
  runAgentAnalysis,
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
  agentBusyKey: string | null;
  analysisIntervalBusy: boolean;
  setActiveGroup: (value: string) => void;
  setSelectedKey: (value: string) => void;
  setState: (state: MarketState) => void;
  updateAnalysisInterval: (value: string) => void;
  runAgentAnalysis: () => Promise<void>;
  openSettings: () => void;
  openWatchlistSettings: () => void;
}) {
  const activeKeys = activeGroup && state ? state.groups[activeGroup] ?? [] : [];
  const currentInterval = selectedInstrument?.analysisInterval ?? state?.config.analysis.interval ?? '5m';
  const candleDelta = closeDeltaPercent(selectedQuote?.candles ?? []);
  const signal = selectedQuote?.strategySignal;
  const tone = signalTone(selectedQuote);

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
            chartKey={`${selectedKey ?? 'none'}:${currentInterval}`}
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
          <AgentReadout
            analysis={selectedAgent}
            busy={agentBusyKey === selectedKey}
            disabled={!selectedKey || !selectedQuote?.candles.length || !state?.config.agent.enabled}
            onAnalyze={runAgentAnalysis}
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
      baseUrl: config.baseUrl,
      timeoutSeconds: config.timeoutSeconds,
      maxCandles: config.maxCandles,
      reasoningEffort: config.reasoningEffort,
    });
  }, [configSignature]);

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
                      <small>Responses-backed coding provider</small>
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
                  <p>Codex Responses provider for structured chart commentary and watch-plan output.</p>
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
                  <span>Base URL</span>
                  <input
                    value={draft.baseUrl ?? ''}
                    onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value.trim() || null })}
                    placeholder="default"
                  />
                </label>
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

export default function App() {
  const [route, setRoute] = useState<AppRoute>(() => readRouteFromHash());
  const [state, setState] = useState<MarketState | null>(null);
  const [socketStatus, setSocketStatus] = useState('connecting');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [agentBusyKey, setAgentBusyKey] = useState<string | null>(null);
  const [analysisIntervalBusy, setAnalysisIntervalBusy] = useState(false);

  useEffect(() => {
    const syncRoute = () => setRoute(readRouteFromHash());
    window.addEventListener('hashchange', syncRoute);
    syncRoute();
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  useEffect(() => {
    let disposed = false;
    let retryTimer: number | undefined;
    let socket: WebSocket | undefined;

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== undefined) return;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        openSocket();
      }, 1500);
    };

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

  async function runAgentAnalysis() {
    if (!selectedKey) return;
    setAgentBusyKey(selectedKey);
    try {
      const payload = await analyzeInstrument(selectedKey);
      setState(payload.state);
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
      agentBusyKey={agentBusyKey}
      analysisIntervalBusy={analysisIntervalBusy}
      setActiveGroup={setActiveGroup}
      setSelectedKey={setSelectedKey}
      setState={setState}
      updateAnalysisInterval={updateAnalysisInterval}
      runAgentAnalysis={runAgentAnalysis}
      openSettings={() => navigateToRoute({ view: 'settings', section: 'providers' })}
      openWatchlistSettings={() => navigateToRoute({ view: 'settings', section: 'watchlist' })}
    />
  );
}
