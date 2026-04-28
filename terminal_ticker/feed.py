"""文件用途：terminal_ticker/feed.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .runtime.feed import *  # noqa: F401,F403
from .runtime import feed as _module

_sys.modules[__name__] = _module
