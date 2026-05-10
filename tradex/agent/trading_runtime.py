"""Trading domain runtime built on the generic agent runtime."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from ..config import AgentConfig, TradingConfig
from ..memory.policy import MemoryRuntimePolicy
from ..memory.paths import memory_store_available
from ..memory.read.prompts import build_memory_developer_instructions
from ..memory.tools import build_memory_tools
from ..trading import TradeStore
from .loop import DEFAULT_SYSTEM_PROMPT, AgentEventHandler, AgentLLMProvider, LoopResult
from .runtime import AgentRuntime, AgentRuntimeServices, ToolPack
from .tools import (
    build_market_tools,
    build_news_tools,
    build_social_feed_tools,
    build_trading_tools,
    build_web_tools,
)


@dataclass(frozen=True)
class TradingAgentRuntimeServices:
    """External services needed by the trading domain tool packs."""

    context_provider: Any
    trade_store: TradeStore
    snapshot_provider: Callable[[str], dict[str, Any]]
    exchange_router: Any = None
    news_service: Any = None
    social_feed_service: Any = None
    trading_config: TradingConfig = field(default_factory=TradingConfig)
    memory_policy: MemoryRuntimePolicy = field(default_factory=MemoryRuntimePolicy.normal)
    runtime_services: AgentRuntimeServices = field(default_factory=AgentRuntimeServices)


@dataclass(frozen=True)
class TradingAgentTurnResult:
    """Result of one trading-domain agent turn."""

    loop_result: LoopResult
    context: dict[str, Any] | None
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
        """初始化交易领域 Agent 运行时，绑定 LLM 提供者、配置和外部服务。"""
        self.provider = provider
        self.config = config
        self.services = services

    async def run_turn(
        self,
        *,
        session_id: str,
        user_prompt: str,
        history: tuple[dict[str, Any], ...],
        candidate_instrument_keys: tuple[str, ...] = tuple(),
        event_handler: AgentEventHandler | None = None,
    ) -> TradingAgentTurnResult:
        """Run one trading analysis turn. Market data is available through tools."""
        runtime = AgentRuntime(
            provider=self.provider,
            tool_packs=self._tool_packs(session_id, candidate_instrument_keys=candidate_instrument_keys),
            services=self.services.runtime_services,
            system_prompt=self._build_system_prompt(),
        )
        loop_result = await runtime.run(
            user_message=self._build_prompt(
                user_prompt=user_prompt,
                candidate_instrument_keys=candidate_instrument_keys,
            ),
            conversation_history=_history_without_current_turn(
                history,
                current_user_prompt=user_prompt,
            ),
            event_handler=event_handler,
        )
        return TradingAgentTurnResult(
            loop_result=loop_result,
            context=None,
            provider=self.provider,
        )

    def _tool_packs(
        self,
        session_id: str,
        *,
        candidate_instrument_keys: tuple[str, ...],
    ) -> tuple[ToolPack, ...]:
        """组装当前会话可用的全部工具包。"""
        services = self.services
        return (
            ToolPack(
                "market",
                lambda: build_market_tools(
                    services.context_provider,
                    candidate_instrument_keys=candidate_instrument_keys,
                ),
            ),
            ToolPack(
                "trading",
                lambda: build_trading_tools(
                    store=services.trade_store,
                    snapshot_provider=services.snapshot_provider,
                    session_id_provider=lambda: session_id,
                    exchange_router=services.exchange_router,
                    trading_config=services.trading_config,
                ),
            ),
            ToolPack("news", lambda: build_news_tools(services.news_service)),
            ToolPack("social-feed", lambda: build_social_feed_tools(services.social_feed_service)),
            ToolPack("web", build_web_tools),
            ToolPack(
                "memory",
                build_memory_tools,
                enabled=services.memory_policy.use_memories and memory_store_available(),
            ),
        )

    def _build_system_prompt(self) -> str | None:
        """构建包含记忆指令的系统提示词，无记忆时返回 None。"""
        trading_instructions = _trading_permission_instructions(self.services.trading_config)
        if not self.services.memory_policy.use_memories:
            return f"{DEFAULT_SYSTEM_PROMPT}\n\n{trading_instructions}"
        memory_instructions = build_memory_developer_instructions()
        if not memory_instructions:
            return f"{DEFAULT_SYSTEM_PROMPT}\n\n{trading_instructions}"
        return f"{DEFAULT_SYSTEM_PROMPT}\n\n{trading_instructions}\n\n{memory_instructions}"

    def _build_prompt(
        self,
        *,
        user_prompt: str,
        candidate_instrument_keys: tuple[str, ...],
    ) -> str:
        """将用户消息与候选标的列表拼接为完整的用户提示词。"""
        candidates = (
            "\n".join(f"- {key}" for key in candidate_instrument_keys)
            if candidate_instrument_keys
            else "- 未指定；需要行情时先调用 list_instruments。"
        )
        return (
            "你是交易研究助手。Agent session 与图表选中标的完全解耦。\n"
            "不要假设当前对话天然绑定任何标的；如果用户问题没有涉及行情、K 线、价格、交易计划或下单理由，可以直接回答。\n"
            "如果问题涉及实时行情、K 线、多周期结构、标的对比、交易计划或下单理由，必须先调用 "
            "list_instruments 确定标的，再用 get_quote 和 get_candles 按需获取报价和各时间周期 K 线。\n"
            "下单工具必须使用明确的 instrument_key；用户没有明确目标时先追问或调用 list_instruments，不能使用隐式默认。\n\n"
            "本轮 UI 候选标的（仅用于缩小工具候选范围，不是会话绑定关系）:\n"
            f"{candidates}\n\n"
            f"{user_prompt}"
        )


def _trading_permission_instructions(config: TradingConfig) -> str:
    enabled: list[str] = []
    disabled: list[str] = []
    if config.hyperliquid_enabled:
        enabled.append("Hyperliquid")
    else:
        disabled.append("Hyperliquid")
    if config.bitget_demo_enabled:
        enabled.append("Bitget Demo")
    else:
        disabled.append("Bitget Demo")
    if not enabled:
        return (
            "当前配置未开放任何平台的下单、平仓或调整止盈止损权限。"
            "你只能给出交易计划、开单建议、风险条件和观察清单，不能声称已经执行交易。"
        )
    return (
        f"当前允许执行交易 mutation 的平台：{', '.join(enabled)}。"
        f"未开放的平台：{', '.join(disabled) if disabled else '无'}。"
        "对于未开放的平台，只能给出开单建议和风险计划，不能尝试下单、平仓或调整止盈止损。"
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
