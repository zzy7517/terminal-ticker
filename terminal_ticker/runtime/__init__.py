"""文件用途：terminal_ticker/runtime/__init__.py 对应的后端模块。"""
from __future__ import annotations

from .controller import DrainResult, TickerController
from .feed import FeedEvent, FeedWorker

__all__ = ["DrainResult", "FeedEvent", "FeedWorker", "TickerController"]
