"""文件用途：terminal_ticker/api/__init__.py 对应的后端模块。"""
from __future__ import annotations

from .app import MarketRuntime, create_app, serialize_market_state

__all__ = ["MarketRuntime", "create_app", "serialize_market_state"]
