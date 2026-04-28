"""文件用途：terminal_ticker/web.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .api.app import *  # noqa: F401,F403
from .api import app as _module

_sys.modules[__name__] = _module
