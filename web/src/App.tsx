import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Activity,
  ArrowLeft,
  BarChart3,
  Bot,
  Check,
  CircleDot,
  Cpu,
  Gauge,
  LineChart,
  Loader2,
  Minus,
  MousePointer2,
  Plus,
  Radar,
  Radio,
  RefreshCw,
  Save,
  ScanLine,
  Search,
  Settings,
  ShieldCheck,
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
  addLongbridgeSymbol,
  analyzeInstrument,
  connectStateSocket,
  fetchAgentModels,
  fetchState,
  removeLongbridgeSymbol,
  saveAgentConfig,
  saveInstrumentAnalysisInterval,
  searchSecurities,
} from './api';
import type {
  AgentAnalysis,
  AgentConfigUpdate,
  AgentModelOption,
  CandlePoint,
  Instrument,
  MarketState,
  Quote,
  SecuritySearchResult,
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
const SETTINGS_HASH = '#/settings/providers';
const ANALYSIS_INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];

type AppRoute =
  | { view: 'workspace' }
  | { view: 'settings'; section: 'providers' };

function readRouteFromHash(): AppRoute {
  if (window.location.hash.startsWith(SETTINGS_HASH)) {
    return { view: 'settings', section: 'providers' };
  }
  return { view: 'workspace' };
}

function navigateToRoute(route: AppRoute) {
  if (route.view === 'settings') {
    window.location.hash = SETTINGS_HASH;
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

function analysisTone(quote: Quote | undefined) {
  const bias = quote?.priceAction?.bias;
  if (bias === 'bullish') return 'up';
  if (bias === 'bearish') return 'down';
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
      if (quote.priceAction?.available) acc.signals += 1;
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

function PulseMetric({
  icon,
  label,
  value,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  tone?: 'neutral' | 'up' | 'down' | 'mixed';
}) {
  return (
    <div className={`pulse-metric ${tone}`}>
      <div className="pulse-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function MarketRail({
  state,
  socketStatus,
  selectedQuote,
}: {
  state: MarketState | null;
  socketStatus: string;
  selectedQuote: Quote | undefined;
}) {
  const pulse = marketPulse(state);
  const live = socketStatus === 'connected';
  const selectedDelta = selectedQuote?.changePercent ?? null;
  return (
    <section className="market-rail" aria-label="Market pulse">
      <PulseMetric
        icon={<Radio size={18} />}
        label="Feed"
        value={live ? 'Live' : socketStatus}
        tone={live ? 'up' : 'down'}
      />
      <PulseMetric
        icon={<LineChart size={18} />}
        label="Symbols"
        value={`${pulse.total}`}
      />
      <PulseMetric
        icon={<ScanLine size={18} />}
        label="Signals"
        value={`${pulse.signals}/${pulse.total || 0}`}
        tone="mixed"
      />
      <PulseMetric
        icon={<TrendingUp size={18} />}
        label="Advance / Decline"
        value={`${pulse.up} / ${pulse.down}`}
        tone={pulse.up >= pulse.down ? 'up' : 'down'}
      />
      <PulseMetric
        icon={<Gauge size={18} />}
        label="Selected Move"
        value={selectedDelta == null ? '-' : `${formatSignedNumber(selectedDelta)}%`}
        tone={selectedDelta == null ? 'neutral' : selectedDelta > 0 ? 'up' : selectedDelta < 0 ? 'down' : 'neutral'}
      />
      <PulseMetric
        icon={<ShieldCheck size={18} />}
        label="Stale"
        value={`${pulse.stale}`}
        tone={pulse.stale > 0 ? 'down' : 'neutral'}
      />
    </section>
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
  const closes = candles.slice(-36).map((item) => item.close).filter(Number.isFinite);
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
  const tone = analysisTone(quote);
  return (
    <button className={`watch-row ${selected ? 'selected' : ''}`} onClick={onSelect} type="button">
      <div className="watch-main">
        <div>
          <div className="symbol-line">
            <span>{instrument.label}</span>
            <small>{sourceLabel(instrument)}</small>
          </div>
          <div className="reason-line">{quote?.priceAction?.available ? quote.priceAction.reason : '等待分析'}</div>
        </div>
        <div className="price-stack">
          <strong>{quote?.priceLabel ?? '-'}</strong>
          <span className={changeClass(quote)}>{quote?.percentLabel ?? '-'}</span>
        </div>
      </div>
      <Sparkline candles={quote?.candles ?? []} tone={changeClass(quote)} />
      <div className="watch-meta">
        <span className={`marker ${tone}`}>{quote?.priceAction?.marker || '--'}</span>
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

function SearchPanel({
  onState,
}: {
  onState: (state: MarketState) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SecuritySearchResult[]>([]);
  const [status, setStatus] = useState('输入代码或名称');
  const [busySymbol, setBusySymbol] = useState<string | null>(null);

  async function runSearch() {
    const trimmed = query.trim();
    if (!trimmed) return;
    setStatus('搜索中...');
    try {
      const next = await searchSecurities(trimmed);
      setResults(next);
      setStatus(next.length ? `${next.length} 个结果` : '没有匹配结果');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '搜索失败');
    }
  }

  async function toggleResult(result: SecuritySearchResult) {
    setBusySymbol(result.symbol);
    try {
      const nextState = result.exists
        ? await removeLongbridgeSymbol(result.symbol)
        : await addLongbridgeSymbol(result);
      onState(nextState);
      setResults((items) =>
        items.map((item) =>
          item.symbol === result.symbol ? { ...item, exists: !result.exists } : item,
        ),
      );
      setStatus(result.exists ? `已移除 ${result.symbol}` : `已添加 ${result.symbol}`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '操作失败');
    } finally {
      setBusySymbol(null);
    }
  }

  return (
    <section className="search-panel" aria-label="Longbridge stock search">
      <div className="search-box">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') runSearch();
          }}
          placeholder="搜索美股代码 / 名称"
        />
        <button type="button" onClick={runSearch}>搜索</button>
      </div>
      <div className="search-status">{status}</div>
      {results.length > 0 && (
        <div className="search-results">
          {results.map((result) => (
            <button
              className="search-result"
              key={result.symbol}
              onClick={() => toggleResult(result)}
              type="button"
              disabled={busySymbol === result.symbol}
            >
              <span>
                <strong>{result.symbol}</strong>
                <small>{result.nameCn || result.nameEn || result.nameHk || result.displayText}</small>
              </span>
              <span className={result.exists ? 'remove-action' : 'add-action'}>
                {result.exists ? <Minus size={14} /> : <Plus size={14} />}
                {result.exists ? '移除' : '添加'}
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
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
          : analysis?.error || '把当前 quote、price action 和最近 OHLCV 交给 Codex provider 做一次结构化解读。'}
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
}) {
  const activeKeys = activeGroup && state ? state.groups[activeGroup] ?? [] : [];
  const tone = analysisTone(selectedQuote);
  const currentInterval = selectedInstrument?.analysisInterval ?? state?.config.analysis.interval ?? '5m';
  const candleDelta = closeDeltaPercent(selectedQuote?.candles ?? []);

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

      <MarketRail state={state} socketStatus={socketStatus} selectedQuote={selectedQuote} />

      <section className="workspace">
        <aside className="sidebar">
          <div className="sidebar-head">
            <div>
              <span>Watchlist</span>
              <small>{state?.instruments.length ?? 0} symbols under watch</small>
            </div>
            <CircleDot size={17} />
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
          <SearchPanel onState={setState} />
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
              {selectedQuote?.priceAction?.marker || '--'}
            </div>
            <div>
              <strong>
                {selectedQuote?.priceAction?.available
                  ? selectedQuote.priceAction.reason
                  : selectedQuote?.priceAction?.reason || '等待 price action 分析'}
              </strong>
              <span>
                {selectedQuote?.priceAction?.available
                  ? `${selectedQuote.priceAction.label} · strength ${selectedQuote.priceAction.strength}`
                  : '缺少新鲜 K 线时不会展示信号'}
              </span>
            </div>
            {selectedQuote?.priceAction?.available ? (
              <Check className="analysis-check" size={18} />
            ) : (
              <Radar className="analysis-waiting" size={18} />
            )}
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
          <div className="agent-card">
            <span className="panel-label with-icon"><Cpu size={14} /> Agent State</span>
            <h3>{selectedQuote?.priceAction?.label ?? 'unavailable'}</h3>
            <p>
              {selectedQuote?.priceAction?.available
                ? selectedQuote.priceAction.reason
                : '系统直接分析 OHLCV，不读取屏幕截图；数据缺失、过期或接口失败时保持不可用。'}
            </p>
          </div>
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

function ProviderSettingsView({
  state,
  onState,
  onBack,
}: {
  state: MarketState | null;
  onState: (state: MarketState) => void;
  onBack: () => void;
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
    return (
      <main className="app-shell settings-shell-page">
        <section className="settings-frame">
          <aside className="settings-nav">
            <button className="settings-back" type="button" onClick={onBack}>
              <ArrowLeft size={16} />
              Back to workspace
            </button>
          </aside>
          <section className="settings-stage">
            <div className="settings-loading">Loading settings...</div>
          </section>
        </section>
      </main>
    );
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
            <button className="settings-nav-item active" type="button">
              <Settings size={18} />
              <span>Providers</span>
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

        <section className="settings-stage">
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
        </section>
      </section>
    </main>
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
      <ProviderSettingsView
        state={state}
        onState={setState}
        onBack={() => navigateToRoute({ view: 'workspace' })}
      />
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
    />
  );
}
