import { useEffect, useRef, useState } from 'react';
import {
  BarChart3,
  ChartNoAxesCombined,
  Eraser,
  History,
  Loader2,
  Minus,
  MousePointer2,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import {
  CandlestickSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useChartDrawings } from '../../chartDrawings';
import { ANALYSIS_INTERVAL_OPTIONS, CHART_THEMES, type ThemeName } from '../../constants';
import type { CandlePoint } from '../../types';

type ChartCandle = CandlestickData<UTCTimestamp>;

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

function prependedCandleCount(previous: ChartCandle[], next: ChartCandle[]) {
  if (previous.length === 0 || next.length <= previous.length) return 0;
  const offset = next.length - previous.length;
  for (let index = 0; index < previous.length; index += 1) {
    if (!sameChartCandle(previous[index], next[index + offset])) return 0;
  }
  return offset;
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

export function intervalOptions(currentInterval: string) {
  if (ANALYSIS_INTERVAL_OPTIONS.includes(currentInterval)) {
    return ANALYSIS_INTERVAL_OPTIONS;
  }
  return [currentInterval, ...ANALYSIS_INTERVAL_OPTIONS];
}

export function CandlestickPane({
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
