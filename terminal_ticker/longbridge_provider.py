"""文件用途：terminal_ticker/longbridge_provider.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .market_data.longbridge import *  # noqa: F401,F403
from .market_data import longbridge as _module

_sys.modules[__name__] = _module
