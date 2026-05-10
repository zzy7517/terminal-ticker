export enum TradeDirection {
  LONG = "long",
  SHORT = "short",
}

export function directionSign(direction: TradeDirection): number {
  return direction === TradeDirection.LONG ? 1 : -1;
}

export enum TradeStatus {
  PLANNED = "planned",
  OPEN = "open",
  CLOSED = "closed",
  CANCELLED = "cancelled",
}

export enum FillKind {
  ENTRY = "entry",
  EXIT = "exit",
  STOP = "stop",
  TARGET = "target",
}

export interface Snapshot {
  id: number;
  instrumentKey: string;
  capturedAtMs: number;
  payload: Record<string, unknown>;
}

export interface Fill {
  id: number;
  tradeId: number;
  kind: FillKind;
  price: number;
  quantity: number;
  filledAtMs: number;
  triggerReason: string;
  fillSource: string;
  fees: number;
  externalOrderId: string | null;
}

export interface Trade {
  id: number;
  instrumentKey: string;
  direction: TradeDirection;
  status: TradeStatus;
  size: number;
  intentPrice: number | null;
  stopPrice: number | null;
  targetPrices: number[];
  openedAtMs: number | null;
  closedAtMs: number | null;
  realizedPnl: number;
  reasoningText: string;
  sessionId: string | null;
  snapshotId: number | null;
  marketKind: string;
  fillSource: string;
  externalOrderId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  fills: Fill[];
}

export function snapshotToPayload(snapshot: Snapshot): Record<string, unknown> {
  return {
    id: snapshot.id,
    instrumentKey: snapshot.instrumentKey,
    capturedAtMs: snapshot.capturedAtMs,
    payload: snapshot.payload,
  };
}

export function fillToPayload(fill: Fill): Record<string, unknown> {
  return {
    id: fill.id,
    tradeId: fill.tradeId,
    kind: fill.kind,
    price: fill.price,
    quantity: fill.quantity,
    filledAtMs: fill.filledAtMs,
    triggerReason: fill.triggerReason,
    fillSource: fill.fillSource,
    fees: fill.fees,
    externalOrderId: fill.externalOrderId,
  };
}

export function tradeToPayload(trade: Trade, includeFills = true): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: trade.id,
    instrumentKey: trade.instrumentKey,
    direction: trade.direction,
    status: trade.status,
    size: trade.size,
    intentPrice: trade.intentPrice,
    stopPrice: trade.stopPrice,
    targetPrices: trade.targetPrices,
    openedAtMs: trade.openedAtMs,
    closedAtMs: trade.closedAtMs,
    realizedPnl: trade.realizedPnl,
    reasoningText: trade.reasoningText,
    sessionId: trade.sessionId,
    snapshotId: trade.snapshotId,
    marketKind: trade.marketKind,
    fillSource: trade.fillSource,
    externalOrderId: trade.externalOrderId,
    createdAtMs: trade.createdAtMs,
    updatedAtMs: trade.updatedAtMs,
  };
  if (includeFills) payload.fills = trade.fills.map(fillToPayload);
  return payload;
}

export function averageEntryPrice(trade: Trade): number | null {
  return weightedAverage(trade.fills.filter((fill) => fill.kind === FillKind.ENTRY));
}

export function averageExitPrice(trade: Trade): number | null {
  return weightedAverage(trade.fills.filter((fill) => [FillKind.EXIT, FillKind.STOP, FillKind.TARGET].includes(fill.kind)));
}

function weightedAverage(fills: Fill[]): number | null {
  const totalQty = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  if (totalQty <= 0) return null;
  return fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / totalQty;
}
