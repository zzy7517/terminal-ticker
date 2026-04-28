"""文件用途：terminal_ticker/price_action.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .domain.price_action import *  # noqa: F401,F403
from .domain import price_action as _module

_sys.modules[__name__] = _module
