"""文件用途：数据源层，用 SQLite 缓存标准化 K 线并支持增量拉取。"""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import sqlite3
import time
from typing import Callable

from ..config import CacheConfig
from ..domain.price_action import Candle

DEFAULT_CACHE_SUBDIR = "terminal-ticker"
DEFAULT_CACHE_FILENAME = "candles.sqlite3"
INTERVAL_SECONDS = {
    "1m": 60,
    "3m": 3 * 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1H": 60 * 60,
    "4H": 4 * 60 * 60,
    "6H": 6 * 60 * 60,
    "12H": 12 * 60 * 60,
    "1D": 24 * 60 * 60,
    "3D": 3 * 24 * 60 * 60,
    "1W": 7 * 24 * 60 * 60,
    "1M": 31 * 24 * 60 * 60,
}


@dataclass(frozen=True)
class CandleFetchPlan:
    """说明：封装读取缓存后下一次 provider 请求的计划。"""
    after_open_time_ms: int | None
    limit: int


def default_cache_path() -> Path:
    """说明：返回平台本地默认 SQLite 缓存路径。"""
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / DEFAULT_CACHE_SUBDIR / DEFAULT_CACHE_FILENAME


class CandleCache:
    """说明：封装按标的和周期存取 K 线的 SQLite 缓存。"""

    def __init__(self, path: str | Path, *, retention_seconds: int = 86_400) -> None:
        """说明：初始化当前对象的运行状态。"""
        self.path = Path(path).expanduser()
        self.retention_seconds = retention_seconds

    @classmethod
    def from_config(cls, config: CacheConfig) -> "CandleCache":
        """说明：根据应用配置创建缓存实例。"""
        return cls(
            config.path or default_cache_path(),
            retention_seconds=config.candle_retention_seconds,
        )

    def _connect(self) -> sqlite3.Connection:
        """说明：打开连接并确保底层资源已经初始化。"""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path)
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS candles (
                symbol_key TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time_ms INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                fetched_at_ms INTEGER NOT NULL,
                PRIMARY KEY (symbol_key, interval, open_time_ms)
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_candles_lookup
            ON candles (symbol_key, interval, open_time_ms)
            """
        )
        return connection

    def prune(
        self,
        *,
        now_ms: int | None = None,
        retention_seconds: int | None = None,
    ) -> int:
        """说明：删除超过保留期的 K 线缓存。"""
        current_ms = _now_ms() if now_ms is None else now_ms
        cutoff_ms = current_ms - self._effective_retention(retention_seconds) * 1000
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM candles WHERE open_time_ms < ?",
                (cutoff_ms,),
            )
            return cursor.rowcount

    def upsert(
        self,
        candles: tuple[Candle, ...],
        *,
        interval: str,
        fetched_at_ms: int | None = None,
    ) -> int:
        """说明：把 K 线写入缓存，已存在时更新。"""
        if not candles:
            return 0
        current_ms = _now_ms() if fetched_at_ms is None else fetched_at_ms
        rows = [
            (
                candle.symbol_key,
                interval,
                candle.open_time_ms,
                candle.open,
                candle.high,
                candle.low,
                candle.close,
                candle.volume,
                current_ms,
            )
            for candle in candles
        ]
        with self._connect() as connection:
            connection.executemany(
                """
                INSERT INTO candles (
                    symbol_key, interval, open_time_ms, open, high, low, close, volume,
                    fetched_at_ms
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol_key, interval, open_time_ms) DO UPDATE SET
                    open = excluded.open,
                    high = excluded.high,
                    low = excluded.low,
                    close = excluded.close,
                    volume = excluded.volume,
                    fetched_at_ms = excluded.fetched_at_ms
                """,
                rows,
            )
        return len(rows)

    def latest_open_time_ms(
        self,
        symbol_key: str,
        interval: str,
        *,
        now_ms: int | None = None,
        retention_seconds: int | None = None,
    ) -> int | None:
        """说明：读取某个标的和周期最新的缓存 K 线开盘时间。"""
        current_ms = _now_ms() if now_ms is None else now_ms
        cutoff_ms = current_ms - self._effective_retention(retention_seconds) * 1000
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT MAX(open_time_ms)
                FROM candles
                WHERE symbol_key = ? AND interval = ? AND open_time_ms >= ?
                """,
                (symbol_key, interval, cutoff_ms),
            ).fetchone()
        value = row[0] if row else None
        return int(value) if value is not None else None

    def recent(
        self,
        symbol_key: str,
        interval: str,
        *,
        limit: int,
        now_ms: int | None = None,
        retention_seconds: int | None = None,
    ) -> tuple[Candle, ...]:
        """说明：读取某个标的和周期最近的缓存 K 线。"""
        current_ms = _now_ms() if now_ms is None else now_ms
        cutoff_ms = current_ms - self._effective_retention(retention_seconds) * 1000
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT symbol_key, open_time_ms, open, high, low, close, volume
                FROM candles
                WHERE symbol_key = ? AND interval = ? AND open_time_ms >= ?
                ORDER BY open_time_ms DESC
                LIMIT ?
                """,
                (symbol_key, interval, cutoff_ms, limit),
            ).fetchall()
        candles = tuple(
            Candle(
                symbol_key=str(row[0]),
                open_time_ms=int(row[1]),
                open=float(row[2]),
                high=float(row[3]),
                low=float(row[4]),
                close=float(row[5]),
                volume=float(row[6]),
            )
            for row in reversed(rows)
        )
        return candles

    def _effective_retention(self, requested_seconds: int | None) -> int:
        """说明：返回本次读取所需的缓存保留秒数。"""
        if requested_seconds is None:
            return self.retention_seconds
        return max(self.retention_seconds, requested_seconds)


def cached_fetch_candles(
    *,
    cache: CandleCache,
    symbol_key: str,
    interval: str,
    limit: int,
    fetcher: Callable[..., tuple[Candle, ...]],
    now_ms: int | None = None,
    minimum_retention_seconds: int | None = None,
) -> tuple[Candle, ...]:
    """说明：通过 SQLite 缓存拉取 K 线，并只向 provider 请求缺失区间。"""
    current_ms = _now_ms() if now_ms is None else now_ms
    cache.prune(now_ms=current_ms, retention_seconds=minimum_retention_seconds)
    latest_open_ms = cache.latest_open_time_ms(
        symbol_key,
        interval,
        now_ms=current_ms,
        retention_seconds=minimum_retention_seconds,
    )
    plan = _fetch_plan(latest_open_ms, interval=interval, limit=limit, now_ms=current_ms)
    try:
        fetched = fetcher(
            interval=interval,
            limit=plan.limit,
            after_open_time_ms=plan.after_open_time_ms,
        )
    except Exception:
        cached = cache.recent(
            symbol_key,
            interval,
            limit=limit,
            now_ms=current_ms,
            retention_seconds=minimum_retention_seconds,
        )
        if cached:
            return cached
        raise

    if fetched:
        cache.upsert(fetched, interval=interval, fetched_at_ms=current_ms)
    cached = cache.recent(
        symbol_key,
        interval,
        limit=limit,
        now_ms=current_ms,
        retention_seconds=minimum_retention_seconds,
    )
    return cached or fetched[-limit:]


def _fetch_plan(
    latest_open_ms: int | None,
    *,
    interval: str,
    limit: int,
    now_ms: int,
) -> CandleFetchPlan:
    """说明：根据缓存最新时间计算下一次 provider 请求计划。"""
    if latest_open_ms is None:
        return CandleFetchPlan(after_open_time_ms=None, limit=limit)
    interval_ms = INTERVAL_SECONDS.get(interval, 60) * 1000
    missing = max(1, ((now_ms - latest_open_ms) // interval_ms) + 2)
    if missing > 1000:
        return CandleFetchPlan(after_open_time_ms=None, limit=min(max(limit, 1000), missing))
    overlapped_after_open_ms = max(0, latest_open_ms - interval_ms)
    return CandleFetchPlan(
        after_open_time_ms=overlapped_after_open_ms,
        limit=max(limit, int(missing)),
    )


def _now_ms() -> int:
    """说明：返回当前 Unix 毫秒时间戳。"""
    return int(time.time() * 1000)
