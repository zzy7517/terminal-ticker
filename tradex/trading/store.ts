import Database from "better-sqlite3";
import path from "node:path";
import { BaseStore, defaultCacheDir, jsonDumps, jsonLoads, nowMs } from "../db.js";
import { Fill, FillKind, Snapshot, Trade, TradeDirection, TradeStatus, averageEntryPrice } from "./models.js";

export const DEFAULT_TRADE_FILENAME = "trades.sqlite3";
export const DEFAULT_FILL_SOURCE = "simulated";

export function defaultTradeStorePath(): string {
  return path.join(defaultCacheDir(), DEFAULT_TRADE_FILENAME);
}

export type TradeClosedCallback = (tradeId: number) => void;

export class TradeStore extends BaseStore {
  private _onTradeClosedCallbacks: TradeClosedCallback[] = [];

  constructor(dbPath: string | null = null) {
    super(dbPath ?? defaultTradeStorePath());
  }

  /** Register a callback to be invoked whenever a trade is marked closed. */
  onTradeClosed(cb: TradeClosedCallback): void {
    this._onTradeClosedCallbacks.push(cb);
  }

  protected override initSchema(conn: Database.Database): void {
    conn.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument_key TEXT NOT NULL,
        captured_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instrument_key TEXT NOT NULL,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        size REAL NOT NULL,
        intent_price REAL,
        stop_price REAL,
        target_prices_json TEXT NOT NULL DEFAULT '[]',
        opened_at_ms INTEGER,
        closed_at_ms INTEGER,
        realized_pnl REAL NOT NULL DEFAULT 0,
        reasoning_text TEXT NOT NULL DEFAULT '',
        session_id TEXT,
        snapshot_id INTEGER REFERENCES snapshots(id) ON DELETE SET NULL,
        market_kind TEXT NOT NULL DEFAULT '',
        fill_source TEXT NOT NULL DEFAULT 'simulated',
        external_order_id TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id INTEGER NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        price REAL NOT NULL,
        quantity REAL NOT NULL,
        filled_at_ms INTEGER NOT NULL,
        trigger_reason TEXT NOT NULL DEFAULT '',
        fill_source TEXT NOT NULL DEFAULT 'simulated',
        fees REAL NOT NULL DEFAULT 0,
        external_order_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status, opened_at_ms);
      CREATE INDEX IF NOT EXISTS idx_trades_instrument ON trades (instrument_key, status);
      CREATE INDEX IF NOT EXISTS idx_fills_trade ON fills (trade_id, filled_at_ms, id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_instrument ON snapshots (instrument_key, captured_at_ms);
      CREATE TABLE IF NOT EXISTS lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
        instrument_key TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_lessons_instrument ON lessons (instrument_key, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_lessons_trade ON lessons (trade_id);
    `);
  }

  saveSnapshot(input: { instrumentKey: string; payload: Record<string, unknown>; capturedAtMs?: number | null }): Snapshot {
    const capturedAtMs = input.capturedAtMs ?? nowMs();
    const result = this.getConn()
      .prepare("INSERT INTO snapshots (instrument_key, captured_at_ms, payload_json) VALUES (?, ?, ?)")
      .run(input.instrumentKey, capturedAtMs, jsonDumps(input.payload));
    return { id: Number(result.lastInsertRowid), instrumentKey: input.instrumentKey, capturedAtMs, payload: input.payload };
  }

  getSnapshot(snapshotId: number): Snapshot | null {
    const row = this.getConn().prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId) as SnapshotRow | undefined;
    return row ? snapshotFromRow(row) : null;
  }

  createTrade(input: {
    instrumentKey: string;
    direction: TradeDirection;
    size: number;
    intentPrice?: number | null;
    stopPrice?: number | null;
    targetPrices?: Iterable<number>;
    reasoningText?: string;
    sessionId?: string | null;
    snapshotId?: number | null;
    marketKind?: string;
    fillSource?: string;
    status?: TradeStatus;
    externalOrderId?: string | null;
  }): Trade {
    if (input.size <= 0) throw new Error("trade size must be positive");
    const at = nowMs();
    const status = input.status ?? TradeStatus.PLANNED;
    const openedAt = status === TradeStatus.OPEN ? at : null;
    const result = this.getConn()
      .prepare(
        `INSERT INTO trades (
          instrument_key, direction, status, size, intent_price, stop_price,
          target_prices_json, opened_at_ms, closed_at_ms, realized_pnl,
          reasoning_text, session_id, snapshot_id, market_kind, fill_source,
          external_order_id, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.instrumentKey,
        input.direction,
        status,
        input.size,
        input.intentPrice ?? null,
        input.stopPrice ?? null,
        jsonDumps([...(input.targetPrices ?? [])].map(Number)),
        openedAt,
        input.reasoningText ?? "",
        input.sessionId ?? null,
        input.snapshotId ?? null,
        input.marketKind ?? "",
        input.fillSource ?? DEFAULT_FILL_SOURCE,
        input.externalOrderId ?? null,
        at,
        at,
      );
    const trade = this.getTrade(Number(result.lastInsertRowid));
    if (!trade) throw new Error("failed to create trade");
    return trade;
  }

  getTrade(tradeId: number): Trade | null {
    const row = this.getConn().prepare("SELECT * FROM trades WHERE id = ?").get(tradeId) as TradeRow | undefined;
    if (!row) return null;
    const fillRows = this.getConn().prepare("SELECT * FROM fills WHERE trade_id = ? ORDER BY filled_at_ms, id").all(tradeId) as FillRow[];
    return tradeFromRow(row, fillRows);
  }

  listTrades(input: { instrumentKey?: string | null; statuses?: TradeStatus[] | null; limit?: number | null } = {}): Trade[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.instrumentKey) {
      clauses.push("instrument_key = ?");
      params.push(input.instrumentKey);
    }
    if (input.statuses) {
      if (input.statuses.length === 0) return [];
      clauses.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
      params.push(...input.statuses);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = input.limit !== undefined && input.limit !== null ? `LIMIT ${Math.max(1, Math.floor(input.limit))}` : "";
    const rows = this.getConn().prepare(`SELECT * FROM trades ${where} ORDER BY created_at_ms DESC, id DESC ${limit}`).all(...params) as TradeRow[];
    if (rows.length === 0) return [];
    const tradeIds = rows.map((row) => row.id);
    const fillRows = this.getConn()
      .prepare(`SELECT * FROM fills WHERE trade_id IN (${tradeIds.map(() => "?").join(",")}) ORDER BY filled_at_ms, id`)
      .all(...tradeIds) as FillRow[];
    const fillsByTrade = new Map<number, FillRow[]>();
    for (const fill of fillRows) fillsByTrade.set(fill.trade_id, [...(fillsByTrade.get(fill.trade_id) ?? []), fill]);
    return rows.map((row) => tradeFromRow(row, fillsByTrade.get(row.id) ?? []));
  }

  recordFill(input: {
    tradeId: number;
    kind: FillKind;
    price: number;
    quantity: number;
    filledAtMs?: number | null;
    triggerReason?: string;
    fillSource?: string;
    fees?: number;
    externalOrderId?: string | null;
  }): Fill {
    if (input.quantity <= 0) throw new Error("fill quantity must be positive");
    const filledAtMs = input.filledAtMs ?? nowMs();
    const result = this.getConn()
      .prepare(
        `INSERT INTO fills (trade_id, kind, price, quantity, filled_at_ms, trigger_reason, fill_source, fees, external_order_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tradeId,
        input.kind,
        input.price,
        input.quantity,
        filledAtMs,
        input.triggerReason ?? "",
        input.fillSource ?? DEFAULT_FILL_SOURCE,
        input.fees ?? 0,
        input.externalOrderId ?? null,
      );
    this.getConn().prepare("UPDATE trades SET updated_at_ms = ? WHERE id = ?").run(nowMs(), input.tradeId);
    const row = this.getConn().prepare("SELECT * FROM fills WHERE id = ?").get(Number(result.lastInsertRowid)) as FillRow;
    return fillFromRow(row);
  }

  markOpen(tradeId: number, openedAtMs: number | null = null): Trade {
    const at = openedAtMs ?? nowMs();
    this.getConn().prepare("UPDATE trades SET status = ?, opened_at_ms = COALESCE(opened_at_ms, ?), updated_at_ms = ? WHERE id = ?").run(TradeStatus.OPEN, at, nowMs(), tradeId);
    return this.mustGetTrade(tradeId);
  }

  markClosed(tradeId: number, input: { closedAtMs?: number | null; realizedPnl?: number | null } = {}): Trade {
    const trade = this.mustGetTrade(tradeId);
    const pnl = input.realizedPnl ?? computeRealizedPnl(trade);
    const at = input.closedAtMs ?? nowMs();
    this.getConn().prepare("UPDATE trades SET status = ?, closed_at_ms = ?, realized_pnl = ?, updated_at_ms = ? WHERE id = ?").run(TradeStatus.CLOSED, at, pnl, nowMs(), tradeId);
    const closed = this.mustGetTrade(tradeId);
    for (const cb of this._onTradeClosedCallbacks) {
      try { cb(tradeId); } catch { /* best-effort */ }
    }
    return closed;
  }

  cancelTrade(tradeId: number): Trade {
    this.getConn().prepare("UPDATE trades SET status = ?, updated_at_ms = ? WHERE id = ?").run(TradeStatus.CANCELLED, nowMs(), tradeId);
    return this.mustGetTrade(tradeId);
  }

  adjustLevels(tradeId: number, input: { stopPrice?: number | null; targetPrices?: Iterable<number> | null }): Trade {
    this.getConn()
      .prepare("UPDATE trades SET stop_price = COALESCE(?, stop_price), target_prices_json = COALESCE(?, target_prices_json), updated_at_ms = ? WHERE id = ?")
      .run(input.stopPrice ?? null, input.targetPrices ? jsonDumps([...input.targetPrices].map(Number)) : null, nowMs(), tradeId);
    return this.mustGetTrade(tradeId);
  }

  listLessons(input: { instrumentKey?: string | null; tradeId?: number | null; limit?: number | null } = {}): Record<string, unknown>[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.instrumentKey) {
      clauses.push("instrument_key = ?");
      params.push(input.instrumentKey);
    }
    if (input.tradeId !== undefined && input.tradeId !== null) {
      clauses.push("trade_id = ?");
      params.push(input.tradeId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = input.limit !== undefined && input.limit !== null ? `LIMIT ${Math.max(1, Math.floor(input.limit))}` : "";
    const rows = this.getConn().prepare(`SELECT * FROM lessons ${where} ORDER BY created_at_ms DESC, id DESC ${limit}`).all(...params) as LessonRow[];
    return rows.map(lessonRowToPayload);
  }

  private mustGetTrade(tradeId: number): Trade {
    const trade = this.getTrade(tradeId);
    if (!trade) throw new Error(`trade not found: ${tradeId}`);
    return trade;
  }
}

interface SnapshotRow {
  id: number;
  instrument_key: string;
  captured_at_ms: number;
  payload_json: string;
}

interface FillRow {
  id: number;
  trade_id: number;
  kind: string;
  price: number;
  quantity: number;
  filled_at_ms: number;
  trigger_reason: string;
  fill_source: string;
  fees: number;
  external_order_id: string | null;
}

interface TradeRow {
  id: number;
  instrument_key: string;
  direction: string;
  status: string;
  size: number;
  intent_price: number | null;
  stop_price: number | null;
  target_prices_json: string;
  opened_at_ms: number | null;
  closed_at_ms: number | null;
  realized_pnl: number;
  reasoning_text: string;
  session_id: string | null;
  snapshot_id: number | null;
  market_kind: string;
  fill_source: string;
  external_order_id: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface LessonRow {
  id: number;
  trade_id: number | null;
  instrument_key: string;
  created_at_ms: number;
  category: string;
  text: string;
  tags_json: string;
}

function snapshotFromRow(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    instrumentKey: row.instrument_key,
    capturedAtMs: row.captured_at_ms,
    payload: (jsonLoads(row.payload_json) as Record<string, unknown>) ?? {},
  };
}

function fillFromRow(row: FillRow): Fill {
  return {
    id: row.id,
    tradeId: row.trade_id,
    kind: row.kind as FillKind,
    price: row.price,
    quantity: row.quantity,
    filledAtMs: row.filled_at_ms,
    triggerReason: row.trigger_reason,
    fillSource: row.fill_source,
    fees: row.fees,
    externalOrderId: row.external_order_id,
  };
}

function tradeFromRow(row: TradeRow, fillRows: FillRow[]): Trade {
  const targetPrices = jsonLoads(row.target_prices_json);
  return {
    id: row.id,
    instrumentKey: row.instrument_key,
    direction: row.direction as TradeDirection,
    status: row.status as TradeStatus,
    size: row.size,
    intentPrice: row.intent_price,
    stopPrice: row.stop_price,
    targetPrices: Array.isArray(targetPrices) ? targetPrices.map(Number) : [],
    openedAtMs: row.opened_at_ms,
    closedAtMs: row.closed_at_ms,
    realizedPnl: row.realized_pnl,
    reasoningText: row.reasoning_text,
    sessionId: row.session_id,
    snapshotId: row.snapshot_id,
    marketKind: row.market_kind,
    fillSource: row.fill_source,
    externalOrderId: row.external_order_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    fills: fillRows.map(fillFromRow),
  };
}

function lessonRowToPayload(row: LessonRow): Record<string, unknown> {
  const tags = jsonLoads(row.tags_json);
  return {
    id: row.id,
    tradeId: row.trade_id,
    instrumentKey: row.instrument_key,
    createdAtMs: row.created_at_ms,
    category: row.category,
    text: row.text,
    tags: Array.isArray(tags) ? tags : [],
  };
}

function computeRealizedPnl(trade: Trade): number {
  const entry = averageEntryPrice(trade);
  if (entry === null) return trade.realizedPnl;
  const exitFills = trade.fills.filter((fill) => [FillKind.EXIT, FillKind.STOP, FillKind.TARGET].includes(fill.kind));
  return exitFills.reduce((sum, fill) => {
    const sign = trade.direction === TradeDirection.LONG ? 1 : -1;
    return sum + (fill.price - entry) * fill.quantity * sign - fill.fees;
  }, 0);
}
