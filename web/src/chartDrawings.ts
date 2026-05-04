import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MismatchDirection,
  type CandlestickData,
  type IChartApi,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesPrimitive,
  type Logical,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

export type DrawingTool = 'cursor' | 'horizontal' | 'trend' | 'fibonacci';
type DrawingTheme = 'light' | 'dark';
type DragPart = 'body' | 'price' | 'start' | 'end';

export type DrawingPoint = {
  time: UTCTimestamp;
  price: number;
};

export type HorizontalDrawing = {
  id: string;
  kind: 'horizontal';
  price: number;
};

export type TwoPointDrawing = {
  id: string;
  kind: 'trend' | 'fibonacci';
  start: DrawingPoint;
  end: DrawingPoint;
};

export type ChartDrawing = HorizontalDrawing | TwoPointDrawing;

type ChartDrawingSnapshot = {
  drawings: ChartDrawing[];
  preview: ChartDrawing | null;
  selectedId: string | null;
  theme: DrawingTheme;
};

type ScreenPoint = {
  x: number;
  y: number;
};

type ChartPointer = ScreenPoint & {
  logical: number | null;
  point: DrawingPoint;
};

type DrawingHit = {
  id: string;
  part: DragPart;
  distance: number;
};

type DragState = {
  id: string;
  part: DragPart;
  original: ChartDrawing;
  startLogical: number | null;
  startPoint: DrawingPoint;
};

const STORAGE_KEY = 'terminal-ticker-chart-drawings:v1';
const EMPTY_DRAWINGS: ChartDrawing[] = [];
const HIT_TOLERANCE = 8;
const HANDLE_RADIUS = 5;
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

const DRAWING_COLORS: Record<DrawingTheme, {
  fill: string;
  handleFill: string;
  handleStroke: string;
  labelText: string;
  preview: string;
  selected: string;
  stroke: string;
}> = {
  light: {
    fill: 'rgba(15, 124, 144, 0.08)',
    handleFill: '#fbfcfb',
    handleStroke: '#0f7c90',
    labelText: 'rgba(39, 49, 49, 0.64)',
    preview: 'rgba(15, 124, 144, 0.52)',
    selected: '#0f7c90',
    stroke: 'rgba(15, 124, 144, 0.82)',
  },
  dark: {
    fill: 'rgba(79, 140, 255, 0.09)',
    handleFill: '#0e0f11',
    handleStroke: '#4f8cff',
    labelText: 'rgba(186, 193, 204, 0.68)',
    preview: 'rgba(79, 140, 255, 0.56)',
    selected: '#4f8cff',
    stroke: 'rgba(79, 140, 255, 0.82)',
  },
};

function createDrawingId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isDrawingPoint(value: unknown): value is DrawingPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as DrawingPoint;
  return typeof point.time === 'number' && typeof point.price === 'number';
}

function isChartDrawing(value: unknown): value is ChartDrawing {
  if (!value || typeof value !== 'object') return false;
  const drawing = value as ChartDrawing;
  if (typeof drawing.id !== 'string') return false;
  if (drawing.kind === 'horizontal') return typeof drawing.price === 'number';
  if (drawing.kind === 'trend' || drawing.kind === 'fibonacci') {
    return isDrawingPoint(drawing.start) && isDrawingPoint(drawing.end);
  }
  return false;
}

function loadStoredDrawings() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.filter(isChartDrawing) : [],
      ]),
    );
  } catch {
    return {};
  }
}

function storeDrawings(drawingsByChart: Record<string, ChartDrawing[]>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drawingsByChart));
  } catch {
    // Drawing persistence should never break live chart interaction.
  }
}

function cloneDrawing(drawing: ChartDrawing): ChartDrawing {
  if (drawing.kind === 'horizontal') {
    return { ...drawing };
  }
  return {
    ...drawing,
    start: { ...drawing.start },
    end: { ...drawing.end },
  };
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

function chartPointerFromClient(
  event: PointerEvent,
  container: HTMLElement,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
): ChartPointer | null {
  const bounds = container.getBoundingClientRect();
  const x = event.clientX - bounds.left;
  const y = event.clientY - bounds.top;
  const time = chart.timeScale().coordinateToTime(x);
  const logical = chart.timeScale().coordinateToLogical(x);
  const price = series.coordinateToPrice(y);
  if (typeof time !== 'number' || typeof price !== 'number') return null;
  return {
    x,
    y,
    logical: typeof logical === 'number' ? logical : null,
    point: {
      time: time as UTCTimestamp,
      price,
    },
  };
}

function projectPoint(
  point: DrawingPoint,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
): ScreenPoint | null {
  const x = chart.timeScale().timeToCoordinate(point.time);
  const y = series.priceToCoordinate(point.price);
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { x, y };
}

function distanceToPoint(x: number, y: number, point: ScreenPoint) {
  return Math.hypot(x - point.x, y - point.y);
}

function distanceToSegment(x: number, y: number, start: ScreenPoint, end: ScreenPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return distanceToPoint(x, y, start);
  const t = Math.max(0, Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (start.x + t * dx), y - (start.y + t * dy));
}

function fibonacciPrice(start: DrawingPoint, end: DrawingPoint, level: number) {
  return start.price + (end.price - start.price) * level;
}

function hitTestDrawing(
  drawing: ChartDrawing,
  x: number,
  y: number,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
): DrawingHit | null {
  const paneWidth = chart.timeScale().width();
  if (x < 0 || x > paneWidth) return null;

  if (drawing.kind === 'horizontal') {
    const lineY = series.priceToCoordinate(drawing.price);
    if (typeof lineY !== 'number') return null;
    const distance = Math.abs(y - lineY);
    return distance <= HIT_TOLERANCE ? { id: drawing.id, part: 'price', distance } : null;
  }

  const start = projectPoint(drawing.start, chart, series);
  const end = projectPoint(drawing.end, chart, series);
  if (!start || !end) return null;

  const startDistance = distanceToPoint(x, y, start);
  if (startDistance <= HIT_TOLERANCE) return { id: drawing.id, part: 'start', distance: startDistance };
  const endDistance = distanceToPoint(x, y, end);
  if (endDistance <= HIT_TOLERANCE) return { id: drawing.id, part: 'end', distance: endDistance };

  if (drawing.kind === 'trend') {
    const distance = distanceToSegment(x, y, start, end);
    return distance <= HIT_TOLERANCE ? { id: drawing.id, part: 'body', distance } : null;
  }

  const minX = Math.min(start.x, end.x) - HIT_TOLERANCE;
  const maxX = Math.max(start.x, end.x) + HIT_TOLERANCE;
  if (x < minX || x > maxX) return null;

  let best: DrawingHit | null = null;
  for (const level of FIB_LEVELS) {
    const lineY = series.priceToCoordinate(fibonacciPrice(drawing.start, drawing.end, level));
    if (typeof lineY !== 'number') continue;
    const distance = Math.abs(y - lineY);
    if (distance <= HIT_TOLERANCE && (!best || distance < best.distance)) {
      best = { id: drawing.id, part: 'body', distance };
    }
  }
  return best;
}

function hitTestDrawings(
  drawings: readonly ChartDrawing[],
  x: number,
  y: number,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
) {
  for (let index = drawings.length - 1; index >= 0; index -= 1) {
    const hit = hitTestDrawing(drawings[index], x, y, chart, series);
    if (hit) return hit;
  }
  return null;
}

function barTimeAtLogical(series: ISeriesApi<'Candlestick'>, logical: number): UTCTimestamp | null {
  const index = Math.round(logical) as Logical;
  const left = series.dataByIndex(index, MismatchDirection.NearestLeft) as CandlestickData<Time> | null;
  if (left && typeof left.time === 'number') return left.time as UTCTimestamp;
  const right = series.dataByIndex(index, MismatchDirection.NearestRight) as CandlestickData<Time> | null;
  if (right && typeof right.time === 'number') return right.time as UTCTimestamp;
  return null;
}

function shiftTime(
  point: DrawingPoint,
  logicalDelta: number,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
) {
  if (logicalDelta === 0) return point.time;
  const x = chart.timeScale().timeToCoordinate(point.time);
  if (typeof x !== 'number') return point.time;
  const logical = chart.timeScale().coordinateToLogical(x);
  if (typeof logical !== 'number') return point.time;
  return barTimeAtLogical(series, logical + logicalDelta) ?? point.time;
}

function dragDrawing(
  drawing: ChartDrawing,
  drag: DragState,
  next: ChartPointer,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
): ChartDrawing {
  const priceDelta = next.point.price - drag.startPoint.price;
  const logicalDelta =
    drag.startLogical !== null && next.logical !== null
      ? Math.round(next.logical - drag.startLogical)
      : 0;

  if (drawing.kind === 'horizontal') {
    return { ...drawing, price: next.point.price };
  }

  if (drag.part === 'start') {
    return { ...drawing, start: next.point };
  }
  if (drag.part === 'end') {
    return { ...drawing, end: next.point };
  }
  if (drag.original.kind === 'horizontal') {
    return drawing;
  }

  return {
    ...drawing,
    start: {
      time: shiftTime(drag.original.start, logicalDelta, chart, series),
      price: drag.original.start.price + priceDelta,
    },
    end: {
      time: shiftTime(drag.original.end, logicalDelta, chart, series),
      price: drag.original.end.price + priceDelta,
    },
  };
}

class ChartDrawingPrimitive implements ISeriesPrimitive {
  private _chart: IChartApi;
  private _series: ISeriesApi<'Candlestick'>;
  private _snapshot: ChartDrawingSnapshot;
  private _requestUpdate: (() => void) | null = null;
  private _view: DrawingPaneView;

  constructor(chart: IChartApi, series: ISeriesApi<'Candlestick'>, snapshot: ChartDrawingSnapshot) {
    this._chart = chart;
    this._series = series;
    this._snapshot = snapshot;
    this._view = new DrawingPaneView(this);
  }

  attached(param: { requestUpdate: () => void }) {
    this._requestUpdate = param.requestUpdate;
  }

  detached() {
    this._requestUpdate = null;
  }

  paneViews() {
    return [this._view];
  }

  hitTest(x: number, y: number) {
    const hit = hitTestDrawings(this.visibleDrawings(), x, y, this._chart, this._series);
    if (!hit) return null;
    return {
      cursorStyle: hit.part === 'body' ? 'move' : 'pointer',
      distance: hit.distance,
      externalId: hit.id,
      hitTestPriority: hit.part === 'body' ? 1 : 2,
      itemType: 'primitive' as const,
      zOrder: 'top' as const,
    };
  }

  setSnapshot(snapshot: ChartDrawingSnapshot) {
    this._snapshot = snapshot;
    this._requestUpdate?.();
  }

  snapshot() {
    return this._snapshot;
  }

  chart() {
    return this._chart;
  }

  series() {
    return this._series;
  }

  private visibleDrawings() {
    return this._snapshot.preview
      ? [...this._snapshot.drawings, this._snapshot.preview]
      : this._snapshot.drawings;
  }
}

class DrawingPaneView implements IPrimitivePaneView {
  private _primitive: ChartDrawingPrimitive;

  constructor(primitive: ChartDrawingPrimitive) {
    this._primitive = primitive;
  }

  zOrder() {
    return 'top' as const;
  }

  renderer() {
    return new DrawingPaneRenderer(
      this._primitive.snapshot(),
      this._primitive.chart(),
      this._primitive.series(),
    );
  }
}

class DrawingPaneRenderer implements IPrimitivePaneRenderer {
  private _snapshot: ChartDrawingSnapshot;
  private _chart: IChartApi;
  private _series: ISeriesApi<'Candlestick'>;

  constructor(snapshot: ChartDrawingSnapshot, chart: IChartApi, series: ISeriesApi<'Candlestick'>) {
    this._snapshot = snapshot;
    this._chart = chart;
    this._series = series;
  }

  draw(target: Parameters<IPrimitivePaneRenderer['draw']>[0]) {
    const { chart, series } = this;
    const colors = DRAWING_COLORS[this._snapshot.theme];
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save();
      context.font = '12px Aptos, "Avenir Next", "Segoe UI", sans-serif';
      context.lineCap = 'round';
      context.lineJoin = 'round';

      for (const drawing of this.visibleDrawings()) {
        const selected = drawing.id === this._snapshot.selectedId;
        const preview = drawing.id === 'preview';
        const stroke = preview ? colors.preview : selected ? colors.selected : colors.stroke;
        context.strokeStyle = stroke;
        context.fillStyle = stroke;
        context.lineWidth = selected ? 2 : 1.5;
        context.setLineDash(preview ? [6, 5] : []);

        if (drawing.kind === 'horizontal') {
          this.drawHorizontal(context, drawing, mediaSize.width, colors, selected);
        } else if (drawing.kind === 'trend') {
          this.drawTrend(context, drawing, colors, selected);
        } else {
          this.drawFibonacci(context, drawing, colors, selected, preview, mediaSize.width);
        }
      }

      context.restore();
    });
  }

  private get chart() {
    return this._chart;
  }

  private get series() {
    return this._series;
  }

  private visibleDrawings() {
    return this._snapshot.preview
      ? [...this._snapshot.drawings, this._snapshot.preview]
      : this._snapshot.drawings;
  }

  private drawHorizontal(
    context: CanvasRenderingContext2D,
    drawing: HorizontalDrawing,
    width: number,
    colors: typeof DRAWING_COLORS[DrawingTheme],
    selected: boolean,
  ) {
    const y = this.series.priceToCoordinate(drawing.price);
    if (typeof y !== 'number') return;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
    if (selected) {
      this.drawHandle(context, { x: Math.min(width - 20, width * 0.72), y }, colors);
    }
  }

  private drawTrend(
    context: CanvasRenderingContext2D,
    drawing: TwoPointDrawing,
    colors: typeof DRAWING_COLORS[DrawingTheme],
    selected: boolean,
  ) {
    const start = projectPoint(drawing.start, this.chart, this.series);
    const end = projectPoint(drawing.end, this.chart, this.series);
    if (!start || !end) return;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    if (selected) {
      this.drawHandle(context, start, colors);
      this.drawHandle(context, end, colors);
    }
  }

  private drawFibonacci(
    context: CanvasRenderingContext2D,
    drawing: TwoPointDrawing,
    colors: typeof DRAWING_COLORS[DrawingTheme],
    selected: boolean,
    preview: boolean,
    width: number,
  ) {
    const start = projectPoint(drawing.start, this.chart, this.series);
    const end = projectPoint(drawing.end, this.chart, this.series);
    if (!start || !end) return;
    const x1 = Math.max(0, Math.min(start.x, end.x));
    const x2 = Math.min(width, Math.max(start.x, end.x));
    if (x2 - x1 < 2) return;

    context.save();
    context.fillStyle = colors.fill;
    context.setLineDash([]);
    context.fillRect(x1, Math.min(start.y, end.y), x2 - x1, Math.abs(end.y - start.y));
    context.restore();

    context.setLineDash(preview ? [6, 5] : [4, 4]);
    context.textBaseline = 'bottom';
    for (const level of FIB_LEVELS) {
      const price = fibonacciPrice(drawing.start, drawing.end, level);
      const y = this.series.priceToCoordinate(price);
      if (typeof y !== 'number') continue;
      context.beginPath();
      context.moveTo(x1, y);
      context.lineTo(x2, y);
      context.stroke();
      context.fillStyle = colors.labelText;
      context.fillText(
        `${(level * 100).toFixed(level === 0 || level === 1 ? 0 : 1)}%`,
        Math.min(x2 + 6, width - 44),
        y - 2,
      );
      context.fillStyle = context.strokeStyle;
    }
    context.setLineDash([]);
    if (selected) {
      this.drawHandle(context, start, colors);
      this.drawHandle(context, end, colors);
    }
  }

  private drawHandle(
    context: CanvasRenderingContext2D,
    point: ScreenPoint,
    colors: typeof DRAWING_COLORS[DrawingTheme],
  ) {
    context.save();
    context.setLineDash([]);
    context.fillStyle = colors.handleFill;
    context.strokeStyle = colors.handleStroke;
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.restore();
  }
}

export function useChartDrawings({
  chart,
  chartKey,
  containerRef,
  series,
  theme,
}: {
  chart: IChartApi | null;
  chartKey: string;
  containerRef: { current: HTMLDivElement | null };
  series: ISeriesApi<'Candlestick'> | null;
  theme: DrawingTheme;
}) {
  const [drawingsByChart, setDrawingsByChart] = useState<Record<string, ChartDrawing[]>>(loadStoredDrawings);
  const [activeTool, setActiveToolState] = useState<DrawingTool>('cursor');
  const [anchorPoint, setAnchorPoint] = useState<DrawingPoint | null>(null);
  const [hoverPoint, setHoverPoint] = useState<DrawingPoint | null>(null);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const activeToolRef = useRef(activeTool);
  const anchorPointRef = useRef(anchorPoint);
  const chartKeyRef = useRef(chartKey);
  const drawingsRef = useRef<ChartDrawing[]>(EMPTY_DRAWINGS);
  const selectedDrawingIdRef = useRef<string | null>(selectedDrawingId);
  const dragStateRef = useRef<DragState | null>(null);
  const primitiveRef = useRef<ChartDrawingPrimitive | null>(null);

  const drawings = drawingsByChart[chartKey] ?? EMPTY_DRAWINGS;
  const preview = useMemo<ChartDrawing | null>(() => {
    if (!anchorPoint || !hoverPoint) return null;
    if (activeTool === 'trend') {
      return { id: 'preview', kind: 'trend', start: anchorPoint, end: hoverPoint };
    }
    if (activeTool === 'fibonacci') {
      return { id: 'preview', kind: 'fibonacci', start: anchorPoint, end: hoverPoint };
    }
    return null;
  }, [activeTool, anchorPoint, hoverPoint]);

  const updateDrawingsForCurrent = useCallback((updater: (current: ChartDrawing[]) => ChartDrawing[]) => {
    setDrawingsByChart((current) => {
      const key = chartKeyRef.current;
      const nextDrawings = updater(current[key] ?? EMPTY_DRAWINGS);
      return { ...current, [key]: nextDrawings };
    });
  }, []);

  useEffect(() => {
    storeDrawings(drawingsByChart);
  }, [drawingsByChart]);

  useEffect(() => {
    activeToolRef.current = activeTool;
  }, [activeTool]);

  useEffect(() => {
    anchorPointRef.current = anchorPoint;
  }, [anchorPoint]);

  useEffect(() => {
    drawingsRef.current = drawings;
  }, [drawings]);

  useEffect(() => {
    selectedDrawingIdRef.current = selectedDrawingId;
  }, [selectedDrawingId]);

  useEffect(() => {
    chartKeyRef.current = chartKey;
    dragStateRef.current = null;
    setAnchorPoint(null);
    setHoverPoint(null);
    setSelectedDrawingId(null);
  }, [chartKey]);

  useEffect(() => {
    if (!chart || !series) return;
    const snapshot: ChartDrawingSnapshot = {
      drawings,
      preview,
      selectedId: selectedDrawingId,
      theme,
    };
    const primitive = new ChartDrawingPrimitive(chart, series, snapshot);
    primitiveRef.current = primitive;
    series.attachPrimitive(primitive);
    return () => {
      series.detachPrimitive(primitive);
      primitiveRef.current = null;
    };
  }, [chart, series]);

  useEffect(() => {
    primitiveRef.current?.setSnapshot({
      drawings,
      preview,
      selectedId: selectedDrawingId,
      theme,
    });
  }, [drawings, preview, selectedDrawingId, theme]);

  const setDrawingTool = useCallback((tool: DrawingTool) => {
    activeToolRef.current = tool;
    setActiveToolState(tool);
    setAnchorPoint(null);
    setHoverPoint(null);
  }, []);

  const clearDrawings = useCallback(() => {
    updateDrawingsForCurrent(() => []);
    setAnchorPoint(null);
    setHoverPoint(null);
    setSelectedDrawingId(null);
  }, [updateDrawingsForCurrent]);

  const deleteSelectedDrawing = useCallback(() => {
    const id = selectedDrawingIdRef.current;
    if (!id) return;
    updateDrawingsForCurrent((current) => current.filter((drawing) => drawing.id !== id));
    setSelectedDrawingId(null);
  }, [updateDrawingsForCurrent]);

  useEffect(() => {
    if (!chart || !series) return;

    const handleClick = (param: MouseEventParams) => {
      const tool = activeToolRef.current;
      if (tool === 'cursor') {
        const id = param.hoveredInfo?.objectId ?? param.hoveredObjectId;
        setSelectedDrawingId(typeof id === 'string' ? id : null);
        return;
      }

      const point = chartPointFromParam(param, series);
      if (!point) return;

      if (tool === 'horizontal') {
        const id = createDrawingId();
        updateDrawingsForCurrent((current) => [
          ...current,
          { id, kind: 'horizontal', price: point.price },
        ]);
        setSelectedDrawingId(id);
        return;
      }

      const start = anchorPointRef.current;
      if (!start) {
        setAnchorPoint(point);
        setHoverPoint(point);
        return;
      }

      const id = createDrawingId();
      updateDrawingsForCurrent((current) => [
        ...current,
        { id, kind: tool, start, end: point },
      ]);
      setSelectedDrawingId(id);
      setAnchorPoint(null);
      setHoverPoint(null);
    };

    const handleMove = (param: MouseEventParams) => {
      const tool = activeToolRef.current;
      if ((tool !== 'trend' && tool !== 'fibonacci') || !anchorPointRef.current) return;
      setHoverPoint(chartPointFromParam(param, series));
    };

    chart.subscribeClick(handleClick);
    chart.subscribeCrosshairMove(handleMove);
    return () => {
      chart.unsubscribeClick(handleClick);
      chart.unsubscribeCrosshairMove(handleMove);
    };
  }, [chart, series, updateDrawingsForCurrent]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !chart || !series) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || activeToolRef.current !== 'cursor') return;
      if ((event.target as HTMLElement | null)?.closest('.chart-overlay-toolbar')) return;
      const pointer = chartPointerFromClient(event, container, chart, series);
      if (!pointer) return;
      const hit = hitTestDrawings(drawingsRef.current, pointer.x, pointer.y, chart, series);
      if (!hit) {
        setSelectedDrawingId(null);
        return;
      }
      const original = drawingsRef.current.find((drawing) => drawing.id === hit.id);
      if (!original) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedDrawingId(hit.id);
      dragStateRef.current = {
        id: hit.id,
        part: hit.part,
        original: cloneDrawing(original),
        startLogical: pointer.logical,
        startPoint: pointer.point,
      };
      container.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const pointer = chartPointerFromClient(event, container, chart, series);
      if (!pointer) return;
      event.preventDefault();
      event.stopPropagation();
      updateDrawingsForCurrent((current) =>
        current.map((drawing) =>
          drawing.id === drag.id ? dragDrawing(drawing, drag, pointer, chart, series) : drawing,
        ),
      );
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!dragStateRef.current) return;
      dragStateRef.current = null;
      if (container.hasPointerCapture(event.pointerId)) {
        container.releasePointerCapture(event.pointerId);
      }
    };

    container.addEventListener('pointerdown', handlePointerDown, { capture: true });
    container.addEventListener('pointermove', handlePointerMove, { capture: true });
    container.addEventListener('pointerup', handlePointerUp, { capture: true });
    container.addEventListener('pointercancel', handlePointerUp, { capture: true });
    return () => {
      container.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      container.removeEventListener('pointermove', handlePointerMove, { capture: true });
      container.removeEventListener('pointerup', handlePointerUp, { capture: true });
      container.removeEventListener('pointercancel', handlePointerUp, { capture: true });
    };
  }, [chart, containerRef, series, updateDrawingsForCurrent]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (!selectedDrawingIdRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT'
      ) {
        return;
      }
      event.preventDefault();
      deleteSelectedDrawing();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelectedDrawing]);

  return {
    activeTool,
    clearDrawings,
    deleteSelectedDrawing,
    hasDrawings: drawings.length > 0 || anchorPoint !== null,
    hasSelectedDrawing: selectedDrawingId !== null,
    setDrawingTool,
  };
}
