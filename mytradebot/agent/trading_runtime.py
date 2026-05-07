"""Trading domain runtime built on the generic agent runtime."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from ..config import AgentConfig
from ..domain.quotes import QuoteState
from ..market_data.router import MarketInstrument
from ..trading import TradeStore
from .loop import AgentEventHandler, AgentLLMProvider, LoopResult
from .provider import build_agent_context
from .runtime import AgentRuntime, AgentRuntimeServices, ToolPack
from .tools import (
    build_market_tools,
    build_news_tools,
    build_social_feed_tools,
    build_trading_tools,
)
from .web_tools import build_web_tools


@dataclass(frozen=True)
class TradingAgentRuntimeServices:
    """External services needed by the trading domain tool packs."""

    context_provider: Any
    trade_store: TradeStore
    snapshot_provider: Callable[[str], dict[str, Any]]
    news_service: Any = None
    social_feed_service: Any = None
    runtime_services: AgentRuntimeServices = field(default_factory=AgentRuntimeServices)


@dataclass(frozen=True)
class TradingAgentTurnResult:
    """Result of one trading-domain agent turn."""

    loop_result: LoopResult
    context: dict[str, Any]
    provider: AgentLLMProvider

    def to_payload(self) -> dict[str, Any]:
        """Return the API payload shape used by the frontend."""
        return {
            "available": self.loop_result.finished,
            "provider": str(getattr(self.provider, "name", "")),
            "model": str(getattr(self.provider, "model", "")),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "content": self.loop_result.content,
            "error": self.loop_result.error,
            "loopResult": self.loop_result.to_payload(),
        }


class TradingAgentRuntime:
    """Composes trading context, lessons, tools, and the generic agent runtime."""

    def __init__(
        self,
        *,
        provider: AgentLLMProvider,
        config: AgentConfig,
        services: TradingAgentRuntimeServices,
    ) -> None:
        self.provider = provider
        self.config = config
        self.services = services

    async def run_turn(
        self,
        *,
        instrument: MarketInstrument,
        quote: QuoteState,
        session_id: str,
        user_prompt: str,
        history: tuple[dict[str, Any], ...],
        analysis_interval: str,
        event_handler: AgentEventHandler | None = None,
    ) -> TradingAgentTurnResult:
        """Run one trading analysis turn with the current market snapshot."""
        context = build_agent_context(
            instrument=instrument,
            quote=quote,
            interval=analysis_interval,
            max_candles=self.config.max_candles,
            session_history=tuple(),
        )
        runtime = AgentRuntime(
            provider=self.provider,
            tool_packs=self._tool_packs(session_id),
            services=self.services.runtime_services,
        )
        loop_result = await runtime.run(
            user_message=self._build_prompt(
                instrument=instrument,
                context=context,
                user_prompt=user_prompt,
            ),
            conversation_history=_history_without_current_turn(
                history,
                current_user_prompt=user_prompt,
            ),
            event_handler=event_handler,
        )
        return TradingAgentTurnResult(
            loop_result=loop_result,
            context=context,
            provider=self.provider,
        )

    def _tool_packs(self, session_id: str) -> tuple[ToolPack, ...]:
        services = self.services
        return (
            ToolPack("market", lambda: build_market_tools(services.context_provider)),
            ToolPack(
                "trading",
                lambda: build_trading_tools(
                    store=services.trade_store,
                    snapshot_provider=services.snapshot_provider,
                    session_id_provider=lambda: session_id,
                ),
            ),
            ToolPack("news", lambda: build_news_tools(services.news_service)),
            ToolPack("social-feed", lambda: build_social_feed_tools(services.social_feed_service)),
            ToolPack("web", build_web_tools),
        )

    def _build_prompt(
        self,
        *,
        instrument: MarketInstrument,
        context: dict[str, Any],
        user_prompt: str,
    ) -> str:
        lessons_block = self._lessons_block(instrument.key)
        return (
            f"当前分析标的: {instrument.label} ({instrument.key})\n\n"
            "当前行情上下文(JSON，工具返回值优先于这里的快照):\n"
            f"{json.dumps(context, ensure_ascii=False, separators=(',', ':'))}"
            f"{lessons_block}\n\n"
            f"{user_prompt}"
        )

    def _lessons_block(self, instrument_key: str) -> str:
        lessons = self.services.trade_store.list_lessons(
            instrument_key=instrument_key,
            limit=5,
        )
        if not lessons:
            return ""
        bullets = "\n".join(
            f"- [{lesson['category'] or 'general'}] {lesson['text']}"
            for lesson in lessons
        )
        return (
            "\n\n过去同标的交易复盘 (最多 5 条，时间倒序):\n"
            f"{bullets}\n"
            "在给出计划和开单前请参考上述教训，避免重复错误。\n"
        )


def _history_without_current_turn(
    history: tuple[dict[str, Any], ...],
    *,
    current_user_prompt: str,
) -> list[dict[str, str]] | None:
    """Return prior chat history without the user turn already represented by the prompt."""
    history_items = list(history)
    if history_items:
        latest = history_items[-1]
        if latest.get("role") == "user" and str(latest.get("content", "")) == current_user_prompt:
            history_items = history_items[:-1]
    messages = [
        {"role": str(msg["role"]), "content": str(msg["content"])}
        for msg in history_items
        if msg.get("role") in ("user", "assistant")
    ]
    return messages or None
