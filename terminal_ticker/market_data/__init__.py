"""文件用途：terminal_ticker/market_data/__init__.py 对应的后端模块。"""
from __future__ import annotations

from .router import MarketInstrument, resolve_instruments

__all__ = ["MarketInstrument", "resolve_instruments"]
