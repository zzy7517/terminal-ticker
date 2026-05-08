"""文件用途：交易记录 SQLite 存储层。"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Iterable

from ..db import BaseStore, default_cache_dir, json_dumps, json_loads, now_ms

from .models import (
    Fill,
    FillKind,
    Snapshot,
    Trade,
    TradeDirection,
    TradeStatus,
)

DEFAULT_TRADE_FILENAME = "trades.sqlite3"
DEFAULT_FILL_SOURCE = "simulated"


def default_trade_store_path() -> Path:
    """说明：返回默认的 trades SQLite 路径。"""
    return default_cache_dir() / DEFAULT_TRADE_FILENAME


class TradeStore(BaseStore):
    """说明：SQLite 支撑的本地订单、成交和快照存储。"""

    def __init__(self, path: str | Path | None = None) -> None:
        """说明：初始化存储路径。"""
        resolved = Path(path).expanduser() if path is not None else default_trade_store_path()
        super().__init__(resolved)

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                instrument_key TEXT NOT NULL,
                captured_at_ms INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
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
            )
            """
        )
        conn.execute(
            """
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
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_trades_status ON trades (status, opened_at_ms)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_trades_instrument ON trades (instrument_key, status)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_fills_trade ON fills (trade_id, filled_at_ms, id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_snapshots_instrument ON snapshots (instrument_key, captured_at_ms)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS lessons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trade_id INTEGER REFERENCES trades(id) ON DELETE CASCADE,
                instrument_key TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                category TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL,
                tags_json TEXT NOT NULL DEFAULT '[]'
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_lessons_instrument ON lessons (instrument_key, created_at_ms)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_lessons_trade ON lessons (trade_id)"
        )

    def save_snapshot(
        self,
        *,
        instrument_key: str,
        payload: dict[str, Any],
        captured_at_ms: int | None = None,
    ) -> Snapshot:
        """说明：冻结一份多周期上下文快照。"""
        at_ms = now_ms() if captured_at_ms is None else captured_at_ms
        payload_json = json_dumps(payload)
        with self._get_conn() as connection:
            cursor = connection.execute(
                """
                INSERT INTO snapshots (instrument_key, captured_at_ms, payload_json)
                VALUES (?, ?, ?)
                """,
                (instrument_key, at_ms, payload_json),
            )
            snapshot_id = int(cursor.lastrowid)
        return Snapshot(
            id=snapshot_id,
            instrument_key=instrument_key,
            captured_at_ms=at_ms,
            payload=payload,
        )

    def get_snapshot(self, snapshot_id: int) -> Snapshot | None:
        """说明：按 ID 读取快照。"""
        with self._get_conn() as connection:
            row = connection.execute(
                "SELECT * FROM snapshots WHERE id = ?",
                (snapshot_id,),
            ).fetchone()
        return _snapshot_from_row(row) if row else None

    def create_trade(
        self,
        *,
        instrument_key: str,
        direction: TradeDirection,
        size: float,
        intent_price: float | None,
        stop_price: float | None,
        target_prices: Iterable[float] = (),
        reasoning_text: str = "",
        session_id: str | None = None,
        snapshot_id: int | None = None,
        market_kind: str = "",
        fill_source: str = DEFAULT_FILL_SOURCE,
        status: TradeStatus = TradeStatus.PLANNED,
        external_order_id: str | None = None,
    ) -> Trade:
        """说明：新建本地订单记录，默认状态为 planned。"""
        if size <= 0:
            raise ValueError("trade size must be positive")
        now = now_ms()
        opened_at = now if status is TradeStatus.OPEN else None
        target_json = json_dumps([float(price) for price in target_prices])
        with self._get_conn() as connection:
            cursor = connection.execute(
                """
                INSERT INTO trades (
                    instrument_key, direction, status, size,
                    intent_price, stop_price, target_prices_json,
                    opened_at_ms, closed_at_ms, realized_pnl,
                    reasoning_text, session_id, snapshot_id,
                    market_kind, fill_source, external_order_id,
                    created_at_ms, updated_at_ms
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    instrument_key,
                    direction.value,
                    status.value,
                    float(size),
                    None if intent_price is None else float(intent_price),
                    None if stop_price is None else float(stop_price),
                    target_json,
                    opened_at,
                    reasoning_text,
                    session_id,
                    snapshot_id,
                    market_kind,
                    fill_source,
                    external_order_id,
                    now,
                    now,
                ),
            )
            trade_id = int(cursor.lastrowid)
        trade = self.get_trade(trade_id)
        assert trade is not None
        return trade

    def get_trade(self, trade_id: int) -> Trade | None:
        """说明：按 ID 读取订单，含成交。"""
        with self._get_conn() as connection:
            row = connection.execute(
                "SELECT * FROM trades WHERE id = ?",
                (trade_id,),
            ).fetchone()
            if row is None:
                return None
            fill_rows = connection.execute(
                "SELECT * FROM fills WHERE trade_id = ? ORDER BY filled_at_ms, id",
                (trade_id,),
            ).fetchall()
        return _trade_from_row(row, fill_rows)

    def list_trades(
        self,
        *,
        instrument_key: str | None = None,
        statuses: Iterable[TradeStatus] | None = None,
        limit: int | None = None,
    ) -> tuple[Trade, ...]:
        """说明：按过滤条件列出订单，按创建时间倒序。"""
        clauses: list[str] = []
        params: list[Any] = []
        if instrument_key is not None:
            clauses.append("instrument_key = ?")
            params.append(instrument_key)
        if statuses is not None:
            status_values = [status.value for status in statuses]
            if not status_values:
                return ()
            placeholders = ",".join("?" for _ in status_values)
            clauses.append(f"status IN ({placeholders})")
            params.extend(status_values)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        limit_sql = f"LIMIT {int(limit)}" if limit is not None else ""
        with self._get_conn() as connection:
            rows = connection.execute(
                f"SELECT * FROM trades {where} ORDER BY created_at_ms DESC, id DESC {limit_sql}",
                params,
            ).fetchall()
            if not rows:
                return ()
            trade_ids = [int(row["id"]) for row in rows]
            placeholders = ",".join("?" for _ in trade_ids)
            fill_rows = connection.execute(
                f"SELECT * FROM fills WHERE trade_id IN ({placeholders}) ORDER BY filled_at_ms, id",
                trade_ids,
            ).fetchall()
        fills_by_trade: dict[int, list[sqlite3.Row]] = {}
        for fill_row in fill_rows:
            fills_by_trade.setdefault(int(fill_row["trade_id"]), []).append(fill_row)
        return tuple(
            _trade_from_row(row, fills_by_trade.get(int(row["id"]), []))
            for row in rows
        )

    def record_fill(
        self,
        *,
        trade_id: int,
        kind: FillKind,
        price: float,
        quantity: float,
        trigger_reason: str = "",
        fill_source: str = DEFAULT_FILL_SOURCE,
        fees: float = 0.0,
        external_order_id: str | None = None,
        filled_at_ms: int | None = None,
    ) -> Fill:
        """说明：登记一次成交。调用方负责驱动订单状态转移。"""
        if quantity <= 0:
            raise ValueError("fill quantity must be positive")
        at_ms = now_ms() if filled_at_ms is None else filled_at_ms
        with self._get_conn() as connection:
            trade_row = connection.execute(
                "SELECT id FROM trades WHERE id = ?",
                (trade_id,),
            ).fetchone()
            if trade_row is None:
                raise ValueError(f"trade not found: {trade_id}")
            cursor = connection.execute(
                """
                INSERT INTO fills (
                    trade_id, kind, price, quantity, filled_at_ms,
                    trigger_reason, fill_source, fees, external_order_id
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trade_id,
                    kind.value,
                    float(price),
                    float(quantity),
                    at_ms,
                    trigger_reason,
                    fill_source,
                    float(fees),
                    external_order_id,
                ),
            )
            connection.execute(
                "UPDATE trades SET updated_at_ms = ? WHERE id = ?",
                (at_ms, trade_id),
            )
            fill_id = int(cursor.lastrowid)
        return Fill(
            id=fill_id,
            trade_id=trade_id,
            kind=kind,
            price=float(price),
            quantity=float(quantity),
            filled_at_ms=at_ms,
            trigger_reason=trigger_reason,
            fill_source=fill_source,
            fees=float(fees),
            external_order_id=external_order_id,
        )

    def mark_open(self, trade_id: int, *, opened_at_ms: int | None = None) -> Trade:
        """说明：把 planned 订单标记为 open。"""
        at_ms = now_ms() if opened_at_ms is None else opened_at_ms
        with self._get_conn() as connection:
            connection.execute(
                """
                UPDATE trades
                SET status = ?, opened_at_ms = COALESCE(opened_at_ms, ?), updated_at_ms = ?
                WHERE id = ?
                """,
                (TradeStatus.OPEN.value, at_ms, at_ms, trade_id),
            )
        trade = self.get_trade(trade_id)
        if trade is None:
            raise ValueError(f"trade not found: {trade_id}")
        return trade

    def mark_closed(
        self,
        trade_id: int,
        *,
        realized_pnl: float,
        closed_at_ms: int | None = None,
    ) -> Trade:
        """说明：把订单标记为 closed 并写入实现盈亏。"""
        at_ms = now_ms() if closed_at_ms is None else closed_at_ms
        with self._get_conn() as connection:
            connection.execute(
                """
                UPDATE trades
                SET status = ?, closed_at_ms = ?, realized_pnl = ?, updated_at_ms = ?
                WHERE id = ?
                """,
                (TradeStatus.CLOSED.value, at_ms, float(realized_pnl), at_ms, trade_id),
            )
        trade = self.get_trade(trade_id)
        if trade is None:
            raise ValueError(f"trade not found: {trade_id}")
        return trade

    def cancel_trade(self, trade_id: int) -> Trade:
        """说明：取消 planned 订单，已 open 的不允许取消。"""
        now = now_ms()
        with self._get_conn() as connection:
            row = connection.execute(
                "SELECT status FROM trades WHERE id = ?",
                (trade_id,),
            ).fetchone()
            if row is None:
                raise ValueError(f"trade not found: {trade_id}")
            if row["status"] != TradeStatus.PLANNED.value:
                raise ValueError(
                    f"cannot cancel trade in status {row['status']}; only planned trades can be cancelled"
                )
            connection.execute(
                """
                UPDATE trades
                SET status = ?, closed_at_ms = ?, updated_at_ms = ?
                WHERE id = ?
                """,
                (TradeStatus.CANCELLED.value, now, now, trade_id),
            )
        trade = self.get_trade(trade_id)
        assert trade is not None
        return trade

    def adjust_levels(
        self,
        trade_id: int,
        *,
        stop_price: float | None = None,
        target_prices: Iterable[float] | None = None,
    ) -> Trade:
        """说明：调整现有订单的止损和止盈价。传 None 表示不动。"""
        now = now_ms()
        sets: list[str] = ["updated_at_ms = ?"]
        params: list[Any] = [now]
        if stop_price is not None:
            sets.append("stop_price = ?")
            params.append(float(stop_price))
        if target_prices is not None:
            sets.append("target_prices_json = ?")
            params.append(json_dumps([float(price) for price in target_prices]))
        params.append(trade_id)
        with self._get_conn() as connection:
            cursor = connection.execute(
                f"UPDATE trades SET {', '.join(sets)} WHERE id = ?",
                params,
            )
            if cursor.rowcount == 0:
                raise ValueError(f"trade not found: {trade_id}")
        trade = self.get_trade(trade_id)
        assert trade is not None
        return trade


    def save_lesson(
        self,
        *,
        trade_id: int | None,
        instrument_key: str,
        text: str,
        category: str = "",
        tags: Iterable[str] = (),
        created_at_ms: int | None = None,
    ) -> int:
        """说明：保存一条复盘 lesson，返回新 lesson id。"""
        at_ms = now_ms() if created_at_ms is None else created_at_ms
        tag_list = [str(tag) for tag in tags]
        with self._get_conn() as connection:
            cursor = connection.execute(
                """
                INSERT INTO lessons (
                    trade_id, instrument_key, created_at_ms, category, text, tags_json
                )
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (trade_id, instrument_key, at_ms, category, text, json_dumps(tag_list)),
            )
            return int(cursor.lastrowid)

    def list_lessons(
        self,
        *,
        instrument_key: str | None = None,
        trade_id: int | None = None,
        limit: int = 20,
    ) -> tuple[dict[str, Any], ...]:
        """说明：读取 lesson 列表，按创建时间倒序。"""
        clauses: list[str] = []
        params: list[Any] = []
        if instrument_key is not None:
            clauses.append("instrument_key = ?")
            params.append(instrument_key)
        if trade_id is not None:
            clauses.append("trade_id = ?")
            params.append(int(trade_id))
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(int(limit))
        with self._get_conn() as connection:
            rows = connection.execute(
                f"SELECT * FROM lessons {where} ORDER BY created_at_ms DESC, id DESC LIMIT ?",
                params,
            ).fetchall()
        return tuple(_lesson_row_to_payload(row) for row in rows)

    def trade_ids_without_review(self, *, limit: int = 10) -> tuple[int, ...]:
        """说明：返回已 closed 且尚无 lesson 的 trade id，最早的优先。"""
        with self._get_conn() as connection:
            rows = connection.execute(
                """
                SELECT t.id
                FROM trades t
                LEFT JOIN lessons l ON l.trade_id = t.id
                WHERE t.status = ? AND l.id IS NULL
                ORDER BY t.closed_at_ms ASC, t.id ASC
                LIMIT ?
                """,
                (TradeStatus.CLOSED.value, int(limit)),
            ).fetchall()
        return tuple(int(row["id"]) for row in rows)


def _lesson_row_to_payload(row: sqlite3.Row) -> dict[str, Any]:
    """说明：lesson 记录转 payload。"""
    tags = json_loads(row["tags_json"])
    return {
        "id": int(row["id"]),
        "tradeId": int(row["trade_id"]) if row["trade_id"] is not None else None,
        "instrumentKey": str(row["instrument_key"]),
        "createdAtMs": int(row["created_at_ms"]),
        "category": str(row["category"]),
        "text": str(row["text"]),
        "tags": tags if isinstance(tags, list) else [],
    }


def _snapshot_from_row(row: sqlite3.Row) -> Snapshot:
    """说明：把 SQLite row 转成 Snapshot。"""
    payload = json_loads(row["payload_json"])
    return Snapshot(
        id=int(row["id"]),
        instrument_key=str(row["instrument_key"]),
        captured_at_ms=int(row["captured_at_ms"]),
        payload=payload if isinstance(payload, dict) else {},
    )


def _fill_from_row(row: sqlite3.Row) -> Fill:
    """说明：把 SQLite row 转成 Fill。"""
    return Fill(
        id=int(row["id"]),
        trade_id=int(row["trade_id"]),
        kind=FillKind(str(row["kind"])),
        price=float(row["price"]),
        quantity=float(row["quantity"]),
        filled_at_ms=int(row["filled_at_ms"]),
        trigger_reason=str(row["trigger_reason"]),
        fill_source=str(row["fill_source"]),
        fees=float(row["fees"]),
        external_order_id=(
            str(row["external_order_id"]) if row["external_order_id"] is not None else None
        ),
    )


def _trade_from_row(row: sqlite3.Row, fill_rows: list[sqlite3.Row]) -> Trade:
    """说明：把 SQLite row 转成 Trade，含对应 fills。"""
    targets_raw = json_loads(row["target_prices_json"])
    target_prices: tuple[float, ...]
    if isinstance(targets_raw, list):
        target_prices = tuple(float(value) for value in targets_raw)
    else:
        target_prices = ()
    return Trade(
        id=int(row["id"]),
        instrument_key=str(row["instrument_key"]),
        direction=TradeDirection(str(row["direction"])),
        status=TradeStatus(str(row["status"])),
        size=float(row["size"]),
        intent_price=(float(row["intent_price"]) if row["intent_price"] is not None else None),
        stop_price=(float(row["stop_price"]) if row["stop_price"] is not None else None),
        target_prices=target_prices,
        opened_at_ms=(int(row["opened_at_ms"]) if row["opened_at_ms"] is not None else None),
        closed_at_ms=(int(row["closed_at_ms"]) if row["closed_at_ms"] is not None else None),
        realized_pnl=float(row["realized_pnl"]),
        reasoning_text=str(row["reasoning_text"]),
        session_id=(str(row["session_id"]) if row["session_id"] is not None else None),
        snapshot_id=(int(row["snapshot_id"]) if row["snapshot_id"] is not None else None),
        market_kind=str(row["market_kind"]),
        fill_source=str(row["fill_source"]),
        external_order_id=(
            str(row["external_order_id"]) if row["external_order_id"] is not None else None
        ),
        created_at_ms=int(row["created_at_ms"]),
        updated_at_ms=int(row["updated_at_ms"]),
        fills=tuple(_fill_from_row(fill_row) for fill_row in fill_rows),
    )
