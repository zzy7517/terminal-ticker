"""文件用途：terminal_ticker/controller.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .runtime.controller import *  # noqa: F401,F403
from .runtime import controller as _module

_sys.modules[__name__] = _module
