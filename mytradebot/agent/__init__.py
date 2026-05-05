"""文件用途：Agent 包入口，兼容旧导入并转发 provider 实现。"""
from __future__ import annotations

from . import provider as _provider
from .provider import (
    AgentAnalysisResult,
    LLMProvider,
    LLMProviderError,
    LLMProviderUnavailable,
    build_agent_context,
    create_llm_provider,
    list_available_agent_models,
    _result_from_text,
)
from .loop import AgentLoop, ChatResponse, LoopResult, LoopStep
from .tools import (
    ToolCall,
    ToolDefinition,
    ToolRegistry,
    ToolResult,
    build_market_tools,
    build_news_tools,
    build_trading_tools,
    merge_registries,
)
from .web_tools import build_web_tools
from .providers.codex import CodexProvider, _codex_request_headers, _read_codex_cli_credentials
from .session_store import (
    AgentMessage,
    AgentSession,
    AgentSessionSummary,
    AgentSessionStore,
    default_agent_session_path,
)

for _name in dir(_provider):
    if not _name.startswith("__"):
        globals().setdefault(_name, getattr(_provider, _name))

__all__ = [
    "AgentAnalysisResult",
    "AgentLoop",
    "ChatResponse",
    "CodexProvider",
    "LLMProvider",
    "LLMProviderError",
    "LLMProviderUnavailable",
    "LoopResult",
    "LoopStep",
    "ToolCall",
    "ToolDefinition",
    "ToolRegistry",
    "ToolResult",
    "build_agent_context",
    "build_market_tools",
    "build_news_tools",
    "build_trading_tools",
    "build_web_tools",
    "merge_registries",
    "create_llm_provider",
    "list_available_agent_models",
    "AgentMessage",
    "AgentSession",
    "AgentSessionSummary",
    "AgentSessionStore",
    "default_agent_session_path",
    "_codex_request_headers",
    "_read_codex_cli_credentials",
    "_result_from_text",
]
