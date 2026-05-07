"""文件用途：SQLite 存储层公共基础设施。"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

DEFAULT_CACHE_SUBDIR = "mytradebot"


def default_cache_dir() -> Path:
    """说明：返回平台本地默认缓存目录。"""
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / DEFAULT_CACHE_SUBDIR


def now_ms() -> int:
    """说明：返回当前 Unix 毫秒时间戳。"""
    return int(time.time() * 1000)


def json_dumps(value: Any) -> str:
    """说明：稳定地序列化结构化字段。"""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def json_loads(value: Any) -> Any:
    """说明：读取结构化 JSON 字段，失败时返回 None。"""
    if not isinstance(value, str) or not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


class BaseStore:
    """说明：所有 SQLite store 的公共基类，提供惰性单连接和一次性 schema 初始化。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: sqlite3.Connection | None = None

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema(conn)
        self._conn = conn
        return conn

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        """说明：子类覆写，只在首次连接时执行一次。"""

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
