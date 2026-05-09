"""Agent 工具子包：注册表基础设施 + 各领域工具集。"""
from __future__ import annotations

from .registry import (
    AfterToolHook,
    BeforeToolHook,
    ToolCall,
    ToolDefinition,
    ToolHandler,
    ToolRegistry,
    ToolResult,
    merge_registries,
)
from .market import build_market_tools
from .trading import build_trading_tools
from .news import build_news_tools
from .social import build_social_feed_tools
from .web import build_web_tools
from .market_context import build_market_context, short_candle

__all__ = [
    "AfterToolHook",
    "BeforeToolHook",
    "ToolCall",
    "ToolDefinition",
    "ToolHandler",
    "ToolRegistry",
    "ToolResult",
    "merge_registries",
    "build_market_tools",
    "build_trading_tools",
    "build_news_tools",
    "build_social_feed_tools",
    "build_web_tools",
    "build_market_context",
    "short_candle",
]
