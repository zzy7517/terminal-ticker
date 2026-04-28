"""文件用途：terminal_ticker/candle_cache.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .market_data.candle_cache import *  # noqa: F401,F403
from .market_data import candle_cache as _module

_sys.modules[__name__] = _module
