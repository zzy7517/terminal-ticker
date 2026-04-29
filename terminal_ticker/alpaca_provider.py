"""文件用途：terminal_ticker/alpaca_provider.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .market_data.alpaca import *  # noqa: F401,F403
from .market_data import alpaca as _module

_sys.modules[__name__] = _module
