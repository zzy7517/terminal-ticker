"""文件用途：terminal_ticker/llm_models.py 对应的后端模块。"""
from __future__ import annotations

import sys as _sys

from .config.agent_models import *  # noqa: F401,F403
from .config import agent_models as _module

_sys.modules[__name__] = _module
