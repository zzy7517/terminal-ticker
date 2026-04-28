"""文件用途：terminal_ticker/watchlist_store.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .config.watchlist_store import *  # noqa: F401,F403
from .config import watchlist_store as _module

_sys.modules[__name__] = _module
