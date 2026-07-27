export interface ExchangePosition {
  exchange: string;
  symbol: string;
  instrumentKey: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage?: number | null;
  margin?: number | null;
  liquidationPrice?: number | null;
}

export interface ExchangeOrder {
  exchange: string;
  symbol: string;
  instrumentKey: string;
  orderId: string;
  side: string;
  orderType: string;
  size: number;
  price: number | null;
  filledSize: number;
  status: string;
  createdAtMs: number;
  reduceOnly?: boolean | null;
  triggerPrice?: number | null;
  tpsl?: string | null;
}

export interface TradeSyncResult {
  exchange: string;
  status: string;
  closed: boolean;
  reason: string;
  position: ExchangePosition | null;
  activeOrders: ExchangeOrder[];
  error: string | null;
}

export interface OrderResult {
  exchange: string;
  orderId: string | null;
  averagePrice: number | null;
  filledSize: number | null;
  resting: boolean;
  error: string | null;
  raw: Record<string, unknown>;
}

export function orderOk(result: OrderResult): boolean {
  return result.error === null;
}

export function orderResult(input: Partial<OrderResult> & { exchange: string }): OrderResult {
  return {
    exchange: input.exchange,
    orderId: input.orderId ?? null,
    averagePrice: input.averagePrice ?? null,
    filledSize: input.filledSize ?? null,
    resting: input.resting ?? false,
    error: input.error ?? null,
    raw: input.raw ?? {},
  };
}

export function positionToPayload(position: ExchangePosition): Record<string, unknown> {
  return {
    exchange: position.exchange,
    symbol: position.symbol,
    instrumentKey: position.instrumentKey,
    side: position.side,
    size: position.size,
    entryPrice: position.entryPrice,
    markPrice: position.markPrice,
    unrealizedPnl: position.unrealizedPnl,
    leverage: position.leverage ?? null,
    margin: position.margin ?? null,
    liquidationPrice: position.liquidationPrice ?? null,
  };
}

export function orderToPayload(order: ExchangeOrder): Record<string, unknown> {
  return {
    exchange: order.exchange,
    symbol: order.symbol,
    instrumentKey: order.instrumentKey,
    orderId: order.orderId,
    side: order.side,
    orderType: order.orderType,
    size: order.size,
    price: order.price,
    filledSize: order.filledSize,
    status: order.status,
    createdAtMs: order.createdAtMs,
    ...(order.reduceOnly !== undefined ? { reduceOnly: order.reduceOnly } : {}),
    ...(order.triggerPrice !== undefined ? { triggerPrice: order.triggerPrice } : {}),
    ...(order.tpsl !== undefined ? { tpsl: order.tpsl } : {}),
  };
}

export function syncResultToPayload(result: TradeSyncResult): Record<string, unknown> {
  return {
    exchange: result.exchange,
    status: result.status,
    closed: result.closed,
    reason: result.reason,
    position: result.position ? positionToPayload(result.position) : null,
    activeOrders: result.activeOrders.map(orderToPayload),
    error: result.error,
  };
}
