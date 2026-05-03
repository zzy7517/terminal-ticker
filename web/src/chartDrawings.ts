import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';

export type DrawingTool = 'cursor' | 'horizontal' | 'trend';

export type DrawingPoint = {
  time: UTCTimestamp;
  price: number;
};

export type HorizontalDrawing = {
  id: string;
  kind: 'horizontal';
  price: number;
};

export type TrendDrawing = {
  id: string;
  kind: 'trend';
  start: DrawingPoint;
  end: DrawingPoint;
};

export type ChartDrawing = HorizontalDrawing | TrendDrawing;

const EMPTY_DRAWINGS: ChartDrawing[] = [];

// Creates a stable client-side identifier for one chart drawing.
function createDrawingId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Converts a chart mouse event into the time/price point used by drawing tools.
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

// Projects a drawing point into SVG overlay coordinates.
export function svgPoint(
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

// Owns drawing-tool state, persistence by chart key, and price-line side effects.
export function useChartDrawings({
  chart,
  series,
  chartKey,
}: {
  chart: IChartApi | null;
  series: ISeriesApi<'Candlestick'> | null;
  chartKey: string;
}) {
  const [drawingsByChart, setDrawingsByChart] = useState<Record<string, ChartDrawing[]>>({});
  const [activeTool, setActiveToolState] = useState<DrawingTool>('cursor');
  const [trendStart, setTrendStartState] = useState<DrawingPoint | null>(null);
  const [hoverPoint, setHoverPoint] = useState<DrawingPoint | null>(null);
  const activeToolRef = useRef(activeTool);
  const chartKeyRef = useRef(chartKey);
  const trendStartRef = useRef<DrawingPoint | null>(trendStart);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const drawings = drawingsByChart[chartKey] ?? EMPTY_DRAWINGS;
  const horizontalDrawings = useMemo(
    () => drawings.filter((drawing): drawing is HorizontalDrawing => drawing.kind === 'horizontal'),
    [drawings],
  );
  const trendDrawings = useMemo(
    () => drawings.filter((drawing): drawing is TrendDrawing => drawing.kind === 'trend'),
    [drawings],
  );
  const previewTrend = trendStart && hoverPoint
    ? { id: 'preview', kind: 'trend' as const, start: trendStart, end: hoverPoint }
    : null;
  const visibleTrendDrawings = useMemo(
    () => (previewTrend ? [...trendDrawings, previewTrend] : trendDrawings),
    [previewTrend, trendDrawings],
  );

  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  useEffect(() => {
    chartKeyRef.current = chartKey;
    setTrendStartState(null);
    trendStartRef.current = null;
    setHoverPoint(null);
  }, [chartKey]);

  // Keeps the pending trend-line anchor synchronized for event handlers.
  const setTrendStart = useCallback((point: DrawingPoint | null) => {
    trendStartRef.current = point;
    setTrendStartState(point);
  }, []);

  // Switches the active drawing mode and clears any incomplete preview.
  const setDrawingTool = useCallback((tool: DrawingTool) => {
    activeToolRef.current = tool;
    setActiveToolState(tool);
    setTrendStart(null);
    setHoverPoint(null);
  }, [setTrendStart]);

  // Clears all drawings for the current chart without touching other symbols.
  const clearDrawings = useCallback(() => {
    const key = chartKeyRef.current;
    setDrawingsByChart((current) => ({ ...current, [key]: [] }));
    setTrendStart(null);
    setHoverPoint(null);
  }, [setTrendStart]);

  useEffect(() => {
    if (!chart || !series) return;

    // Applies the active drawing tool to chart click events.
    const handleClick = (param: MouseEventParams) => {
      const point = chartPointFromParam(param, series);
      if (!point || activeToolRef.current === 'cursor') return;

      const key = chartKeyRef.current;
      if (activeToolRef.current === 'horizontal') {
        setDrawingsByChart((current) => ({
          ...current,
          [key]: [
            ...(current[key] ?? []),
            { id: createDrawingId(), kind: 'horizontal', price: point.price },
          ],
        }));
        return;
      }

      const start = trendStartRef.current;
      if (!start) {
        setTrendStart(point);
        setHoverPoint(point);
        return;
      }

      setDrawingsByChart((current) => ({
        ...current,
        [key]: [
          ...(current[key] ?? []),
          { id: createDrawingId(), kind: 'trend', start, end: point },
        ],
      }));
      setTrendStart(null);
      setHoverPoint(null);
    };

    // Updates the live trend-line preview while the crosshair moves.
    const handleMove = (param: MouseEventParams) => {
      if (activeToolRef.current !== 'trend' || !trendStartRef.current) return;
      setHoverPoint(chartPointFromParam(param, series));
    };

    chart.subscribeClick(handleClick);
    chart.subscribeCrosshairMove(handleMove);
    return () => {
      chart.unsubscribeClick(handleClick);
      chart.unsubscribeCrosshairMove(handleMove);
    };
  }, [chart, series, setTrendStart]);

  useEffect(() => {
    if (!series) return;

    priceLinesRef.current.forEach((line) => series.removePriceLine(line));
    priceLinesRef.current = horizontalDrawings.map((drawing) =>
      series.createPriceLine({
        price: drawing.price,
        color: 'rgba(15, 124, 144, 0.88)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        lineVisible: true,
        axisLabelVisible: false,
      }),
    );

    return () => {
      priceLinesRef.current.forEach((line) => series.removePriceLine(line));
      priceLinesRef.current = [];
    };
  }, [horizontalDrawings, series]);

  return {
    activeTool,
    clearDrawings,
    drawings,
    hasDrawings: drawings.length > 0 || trendStart !== null,
    setDrawingTool,
    visibleTrendDrawings,
  };
}
