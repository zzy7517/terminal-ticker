"""文件用途：MarketRuntime — 维护实时行情状态、后台 feed 和 WebSocket 客户端。"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import suppress
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi import HTTPException, WebSocket, WebSocketDisconnect

from ..agent import (
    AgentRuntime,
    AgentRuntimeServices,
    AgentSessionRuntime,
    AgentSessionStore,
    LLMProviderError,
    LLMProviderUnavailable,
    ToolPack,
    TradingAgentRuntime,
    TradingAgentRuntimeServices,
    build_market_tools,
    build_trade_review_tools,
    build_web_tools,
    create_llm_provider,
    list_available_agent_models,
    merge_registries,
)
from ..agent.tools.market_context import build_market_context
from ..config import (
    AgentConfig,
    AppConfig,
    BITGET_SOURCE,
    HYPERLIQUID_SOURCE,
    NewsConfig,
    ProviderProfile,
    SocialFeedConfig,
    load_config,
)
from ..config.agent_models import (
    SUPPORTED_AGENT_PROVIDERS,
    normalize_api_mode,
    normalize_model,
    normalize_reasoning_effort,
)
from ..domain.price_action import Candle
from ..domain.quotes import QuoteState
from ..market_data.bitget import (
    FUTURES_PRODUCT_TYPES,
    load_instrument_catalog as load_bitget_instrument_catalog,
)
from ..market_data.hyperliquid import load_instrument_catalog as load_hyperliquid_instrument_catalog
from ..market_data.router import MarketInstrument, resolve_instruments
from ..memory import MemoryPipeline, MemoryRuntimePolicy, parse_memory_citations
from ..memory.backend import LocalMemoryBackend, MemoryAccessError
from ..news import NewsService, NewsStore
from ..news.providers.reuters import ReutersSitemapProvider
from ..runtime.controller import TickerController
from ..social_feed import SocialFeedService, SocialFeedStore, XAuthStore
from ..trading import Trade, TradeStatus, TradeStore, ExchangeRouter
from ..trading.bitget_demo import (
    BITGET_DEMO_FILL_SOURCE,
    BitgetDemoTradingError,
    open_demo_position as open_bitget_demo_position,
)
from ..trading.hyperliquid import (
    HYPERLIQUID_FILL_SOURCE,
    HyperliquidTradingError,
    open_position as open_hyperliquid_position,
)
from ..trading.models import FillKind, TradeDirection
from ..config.watchlist_store import (
    append_bitget_symbol_to_watchlist,
    append_hyperliquid_symbol_to_watchlist,
    remove_symbol_from_watchlist,
    update_agent_config_in_watchlist,
    update_analysis_config_in_watchlist,
    update_instrument_analysis_interval_in_watchlist,
    update_memory_config_in_watchlist,
    update_news_config_in_watchlist,
    update_social_feed_config_in_watchlist,
    update_trading_config_in_watchlist,
)
from .helpers import (
    agent_config_from_payload,
    agent_tool_audit_hook,
    analysis_config_from_payload,
    effective_agent_config,
    news_config_from_payload,
    memory_config_from_payload,
    normalize_agent_prompt,
    request_float,
    social_feed_config_from_payload,
)
from .agent_runs import AgentRunChannel, AgentSessionRunRegistry
from .serializers import (
    DEFAULT_AGENT_USER_PROMPT,
    agent_session_config_kwargs,
    agent_session_title,
    instrument_catalog_item_payload,
    serialize_market_state,
    sse_event,
    utc_now_iso,
)

LOGGER = logging.getLogger(__name__)
BITGET_CATALOG_PRODUCT_ORDER = {
    product_type: index for index, product_type in enumerate(FUTURES_PRODUCT_TYPES)
}
MANUAL_MEMORY_TRIGGERS = (
    "帮我记住",
    "请记住",
    "记住:",
    "记住：",
    "remember this",
    "please remember",
    "save this to memory",
    "add this to memory",
)
MANUAL_MEMORY_NEGATIONS = ("不要记住", "别记住", "do not remember", "don't remember")
TRADE_LIFECYCLE_INTERVAL_SECONDS = 5 * 60
TRADE_LIFECYCLE_BATCH_SIZE = 5
_INTERVAL_MINUTES = {
    "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
    "1H": 60, "4H": 240, "6H": 360, "12H": 720,
    "1D": 1440, "3D": 4320, "1W": 10080, "1M": 43200,
}
_DAILY_THRESHOLD_MINUTES = 1440
_TRADE_LIFECYCLE_SYSTEM_PROMPT = """你是后台运行的交易复盘审计员。你的任务是查一笔已开仓的交易现在到底什么状态，已经结束的话基于真实数据做一次结构化复盘，产出一条未来同标的开仓时会被注入到 prompt 的 lesson。

## 你不是在写日记，是在给未来的自己留可执行情报

未来另一个 agent 在同一标的开仓前会读到你写的 lesson（最近 5 条）。这条 lesson 的唯一价值是让那个 agent 在相似结构出现时能识别风险或机会。所以：
- 写「在 X 周期出现 Y 结构时，Z 容易发生」这类**带场景前提的可识别规律**，而不是「这次亏了，要小心」
- 写**这笔交易暴露的具体问题**，而不是教科书原则
- 不要复述行情走势，那些 K 线 agent 自己会看；要写**你看到了什么模式 / 什么误判 / 什么本可以避免**

## 工作流（严格按顺序，跳步会污染结论）

**Step 1 — 确认状态**
调用 `check_trade_status`。
- `closed=false`：仓位还在交易所。立即输出 `{"closed": false}`，结束。不要做任何复盘动作，不要调其他工具。
- `closed=true`：进入 Step 2。

**Step 2 — 拉真实成交（绝不允许猜出场价）**
调用 `get_exchange_fills` 拿到这笔交易的全部 fills。出场价、盈亏、是否分批、是否被强平，全部以 fills 为准。如果 fills 缺失或不完整，`exit_price` 字段填 null、`close_reason` 填 `"unknown"`，不要用开仓 thesis 里的目标价回填。

**Step 3 — 拉上下文**
调用 `get_trade_review_context`：开仓时的 thesis、snapshot、同标的历史 lessons。重点看开仓那一刻 agent 说服自己进场的理由是什么。

**Step 4 — 拉 K 线还原现场**
调用 `get_candles`，至少 15m / 1H / 4H 三个周期，时间范围必须完整覆盖**开仓前若干根到平仓后若干根**。看止损是不是被流动性扫荡扫掉、止盈前是不是有明显减仓信号、入场点是不是踩在 order block 或 FVG 上。

**Step 5（条件触发）— 拉宏观背景**
仅当输入参数 `webSearchAllowed=true`（说明这是日线或更高周期的交易）才调用 `web_search`，查持仓期间的宏观事件、链上数据、相关公告。日内交易不要调，浪费上下文。

## 复盘分析框架（思考用，不要把这部分写进 JSON）

逐条评估，每条得出「OK / 问题 / 不确定」：

1. **入场逻辑** — thesis 里的市场结构判断，K 线复现后是否成立？入场价相对当时的 order block / FVG / 流动性池位置合不合理？是不是追高/抄底？
2. **止损位置** — 止损放在结构外还是结构内？是不是放在了显眼的流动性聚集区导致被扫？止损距离 vs ATR 合不合理？
3. **止盈与减仓** — 止盈位有没有结构依据？有没有在合理位置部分止盈？是吃满了还是回吐了大段利润？
4. **仓位与风险** — 单笔风险占账户比例是否过大？是不是因为信号弱还硬上了重仓？
5. **过程纪律** — 中途有没有移止损、加仓、提前平仓？这些动作是基于新信号还是情绪？

## 输出（严格 JSON，不要 markdown 代码块）

```
{
  "closed": true,
  "exit_price": number | null,
  "close_reason": "stop_hit" | "target_hit" | "liquidated" | "manual_close" | "unknown",
  "lesson": string,
  "category": "entry" | "exit" | "risk" | "patience" | "bias",
  "tags": string[]
}
```

### lesson 字段写作要求

- **长度**：2-4 句话，每句承载独立信息，不要凑字数
- **结构**：第一句陈述本次发生的具体事实（什么周期、什么结构、什么动作、什么结果）；后续句子提炼可在未来复用的判断或警示
- **必须区分事实与推断**：观察到的用陈述句（"止损放在 4H swing low 下方 0.3%，被一根扫盘 K 线击穿后立即收回"），推断用「可能 / 倾向于 / 推测」（"该位置可能是流动性聚集区，下次类似结构应放在 swing low 下方更远"）
- **禁止内容**：
  - 空泛感慨（"要严格止损"、"控制情绪"、"敬畏市场"）
  - 教科书原则（"顺势交易"、"轻仓试错"）
  - 单次结果泛化成定律（"BTC 在 4H FVG 一定会回踩" → 错；"本次 BTC 在 4H FVG 未回踩直接破位，未来该结构需配合 OI 变化二次确认" → 对）
  - 重复 thesis 已有内容
- **写给 agent 也写给人**：行文清晰可读，但优先保证 agent 在相似场景下能匹配出关键词（周期、结构类型、信号特征）

### category 选择
- `entry`：入场点、入场触发信号有问题
- `exit`：止损/止盈位置或离场时机有问题
- `risk`：仓位管理、风险敞口、R:R 设置有问题
- `patience`：过早进场、追单、扛单等纪律问题
- `bias`：方向判断本身错误（结构误读、周期错配）

如有多类问题，选**最主要**的那一类。

### tags
3-6 个英文/中文短词，覆盖：周期（如 `4h`、`daily`）、结构类型（如 `order-block`、`fvg`、`liquidity-sweep`、`bos`）、问题特征（如 `stop-hunted`、`overleveraged`、`countertrend`）。这些 tags 是未来检索同类教训的关键词，宁精勿滥。

## 硬约束

- 不能调用任何下单、平仓、改止盈止损的工具。你只读不写。
- 输出必须是单个 JSON object，不要前后加解释文字，不要套 markdown 代码块。
- 数据不足以判断时，相关字段宁可填 `null` 或 `"unknown"`，不要编造。"""


class MarketContextProvider:
    """为 agent tools 提供行情数据访问的适配器。"""

    def __init__(self, runtime: MarketRuntime) -> None:
        self._runtime = runtime

    def get_quote(self, instrument_key: str) -> QuoteState | None:
        return self._runtime.controller.quotes.get(self._resolve_instrument_key(instrument_key))

    def get_candles(
        self,
        instrument_key: str,
        *,
        interval: str | None = None,
    ) -> tuple[Candle, ...]:
        resolved_key = self._resolve_instrument_key(instrument_key)
        quote = self._runtime.controller.quotes.get(resolved_key)
        if quote is None:
            return tuple()
        if interval:
            return tuple(quote.multi_timeframe_candles.get(interval, tuple()))
        instrument = self._runtime._instrument_by_key(resolved_key)
        current_interval = instrument.analysis_interval or self._runtime.config.analysis.interval
        return tuple(quote.multi_timeframe_candles.get(current_interval, quote.candles))

    def list_instruments(self) -> tuple[MarketInstrument, ...]:
        return self._runtime.instruments

    def get_market_context(
        self,
        instrument_key: str,
        *,
        max_candles: int = 40,
    ) -> dict[str, Any]:
        resolved_key = self._resolve_instrument_key(instrument_key)
        instrument = self._runtime._instrument_by_key(resolved_key)
        quote = self._runtime.controller.quotes.get(resolved_key)
        if quote is None:
            return {}
        return build_market_context(
            instrument=instrument,
            quote=quote,
            interval=instrument.analysis_interval or self._runtime.config.analysis.interval,
            max_candles=max_candles,
        )

    def resolve_instrument_key(self, instrument_key: str) -> str:
        return self._resolve_instrument_key(instrument_key)

    def _resolve_instrument_key(self, instrument_key: str) -> str:
        if instrument_key in self._runtime.controller.quotes:
            return instrument_key
        parts = [part.strip() for part in instrument_key.split(":") if part.strip()]
        if len(parts) == 3 and parts[0].lower() == BITGET_SOURCE:
            candidate = f"{parts[2].upper()}:{parts[1].upper()}"
            if candidate in self._runtime.controller.quotes:
                return candidate
        return instrument_key


class MarketRuntime:
    """维护实时行情状态、后台 feed 和 WebSocket 客户端。"""

    def __init__(
        self,
        *,
        config: AppConfig,
        instruments: tuple[MarketInstrument, ...],
        controller_factory: Callable[..., Any] = TickerController,
        agent_session_store: AgentSessionStore | None = None,
        trade_store: TradeStore | None = None,
    ) -> None:
        self.config = config
        self.instruments = instruments
        self.controller_factory = controller_factory
        self.trade_store = trade_store or TradeStore()
        self.exchange_router = ExchangeRouter(
            trade_store=self.trade_store,
            trading_config=config.trading,
        )
        self.controller = controller_factory(
            config=config,
            instruments=instruments,
        )
        self.clients: set[WebSocket] = set()
        self.pump_task: asyncio.Task[None] | None = None
        self.trade_lifecycle_task: asyncio.Task[None] | None = None
        self.running = False
        self.agent_analyses: dict[str, dict[str, Any]] = {}
        self.instrument_catalog: tuple[MarketInstrument, ...] = tuple()
        self.instrument_catalog_loaded_at: str | None = None
        self.instrument_catalog_errors: dict[str, str] = {}
        self.agent_session_store = agent_session_store or AgentSessionStore()
        self.agent_runs = AgentSessionRunRegistry()
        self._active_session_for_tools: str | None = None
        self.x_auth_store = XAuthStore()
        self.social_feed_service: SocialFeedService | None = None
        if config.social_feed.enabled:
            self.social_feed_service = self._create_social_feed_service(config.social_feed)
        self._flush_handle: asyncio.TimerHandle | None = None
        self._flush_delay: float = 2.0
        self.memory_policy = _memory_policy_from_config(config)
        self.memory_pipeline: MemoryPipeline | None = None
        if self.memory_policy.generate_memories:
            self.memory_pipeline = self._create_memory_pipeline()
        else:
            self.memory_pipeline = None
        self.news_service: NewsService | None = None
        if config.news.enabled:
            news_store = NewsStore()
            news_provider = ReutersSitemapProvider(
                url=config.news.reuters_url,
                timeout_seconds=config.news.request_timeout_seconds,
            )
            self.news_service = NewsService(
                store=news_store,
                provider=news_provider,
                poll_interval_seconds=config.news.poll_interval_seconds,
                max_interval_seconds=config.news.max_interval_seconds,
                retention_days=config.news.retention_days,
                recent_limit=config.news.recent_limit,
            )

    def _create_memory_pipeline(self) -> MemoryPipeline | None:
        """说明：按当前运行策略和 MemoryConfig 创建写入流水线；失败时降级为不可用。"""
        cfg = self.config.memory
        try:
            return MemoryPipeline(
                root=cfg.storage_path,
                agent_session_store=self.agent_session_store,
                trade_store=self.trade_store,
                agent_config_provider=lambda: _memory_agent_config(self.config, phase="extract"),
                phase2_config_provider=lambda: _memory_agent_config(self.config, phase="consolidation"),
                policy=self.memory_policy,
                startup_scan_limit=cfg.max_rollouts_per_startup,
                max_source_age_days=cfg.max_source_age_days,
                min_agent_session_idle_hours=cfg.min_session_idle_hours,
                max_unused_days=cfg.max_unused_days,
                extension_retention_days=cfg.extension_retention_days,
            )
        except OSError as exc:
            LOGGER.warning("memory pipeline disabled: %s", exc)
            return None

    async def _apply_memory_config(self, config: AppConfig) -> None:
        """说明：热加载配置时同步 memory 读写策略和后台流水线。"""
        next_policy = _memory_policy_from_config(config)
        if next_policy == self.memory_policy:
            return
        self.memory_policy = next_policy
        if self.memory_pipeline is not None:
            self.memory_pipeline.policy = next_policy
        if not next_policy.generate_memories:
            if self.memory_pipeline is not None:
                await self.memory_pipeline.shutdown()
            self.memory_pipeline = None
            return
        if self.memory_pipeline is None:
            self.memory_pipeline = self._create_memory_pipeline()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        if self.running:
            return
        self.running = True
        await self.refresh_instrument_catalog()
        self.controller.start()
        self.pump_task = asyncio.create_task(self._pump())
        self.trade_lifecycle_task = asyncio.create_task(self._run_trade_lifecycle_loop())
        self._kickoff_memory_pipeline_if_ready()
        if self.news_service is not None:
            await self.news_service.start()

    async def stop(self) -> None:
        self.running = False
        await self.agent_runs.shutdown()
        if self.pump_task is not None:
            self.pump_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.pump_task
            self.pump_task = None
        if self.trade_lifecycle_task is not None:
            self.trade_lifecycle_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.trade_lifecycle_task
            self.trade_lifecycle_task = None
        if self.news_service is not None:
            await self.news_service.stop()
        if self.memory_pipeline is not None:
            await self.memory_pipeline.shutdown()
        self.controller.stop()
        for websocket in tuple(self.clients):
            with suppress(Exception):
                await websocket.close()
        self.clients.clear()

    # ------------------------------------------------------------------
    # Snapshot & broadcast
    # ------------------------------------------------------------------

    async def create_memory_note(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        """说明：把显式手动记忆请求写入 memory pipeline。"""
        if not self.memory_policy.generate_memories:
            raise HTTPException(status_code=409, detail="memory generation is disabled")
        if self.memory_pipeline is None:
            raise HTTPException(status_code=503, detail="memory pipeline is unavailable")
        source = dict(payload or {})
        raw_text = source.get("text", source.get("note", source.get("message")))
        text = str(raw_text or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text is required")
        note_id = str(source.get("id") or source.get("noteId") or f"manual-{uuid.uuid4().hex[:12]}")
        note_key = await self.memory_pipeline.enqueue_manual_note(
            note_id=note_id,
            payload={
                "text": text,
                "source": str(source.get("source") or "api"),
                "createdAt": utc_now_iso(),
                "metadata": {
                    key: value
                    for key, value in source.items()
                    if key not in {"id", "noteId", "text", "note", "message", "source"}
                },
            },
        )
        self._kickoff_memory_pipeline_if_ready()
        return {"ok": True, "noteId": note_key, "queued": True}

    async def update_memory_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        """说明：更新 memory 配置并持久化到 TOML。"""
        self._require_source_path()
        try:
            next_config = memory_config_from_payload(self.config.memory, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, memory=next_config)
        self.memory_policy = _memory_policy_from_config(self.config)
        self._schedule_flush()
        await self._rebuild_memory_pipeline()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    def memory_status(self) -> dict[str, Any]:
        """说明：返回 memory pipeline 的运行状态。"""
        cfg = self.config.memory
        pipeline_running = (
            self.memory_pipeline is not None
            and self.memory_pipeline._startup_task is not None
            and not self.memory_pipeline._startup_task.done()
        )
        source_count = 0
        output_count = 0
        phase2_status = "unknown"
        if self.memory_pipeline is not None:
            try:
                with self.memory_pipeline.state_store._get_conn() as conn:
                    row = conn.execute("SELECT COUNT(*) AS cnt FROM memory_sources").fetchone()
                    source_count = int(row["cnt"]) if row else 0
                    row = conn.execute("SELECT COUNT(*) AS cnt FROM stage1_outputs").fetchone()
                    output_count = int(row["cnt"]) if row else 0
                    row = conn.execute("SELECT status FROM phase2_jobs WHERE id = 1").fetchone()
                    phase2_status = str(row["status"]) if row else "pending"
            except Exception:
                pass
        return {
            "enabled": cfg.enabled,
            "pipelineAvailable": self.memory_pipeline is not None,
            "pipelineRunning": pipeline_running,
            "sourceCount": source_count,
            "outputCount": output_count,
            "phase2Status": phase2_status,
            "config": {
                "enabled": cfg.enabled,
                "useMemories": cfg.use_memories,
                "generateMemories": cfg.generate_memories,
                "storagePath": cfg.storage_path,
                "extractModel": cfg.extract_model,
                "consolidationModel": cfg.consolidation_model,
                "maxRawMemories": cfg.max_raw_memories_for_consolidation,
                "maxUnusedDays": cfg.max_unused_days,
                "maxSourceAgeDays": cfg.max_source_age_days,
                "maxRolloutsPerStartup": cfg.max_rollouts_per_startup,
                "minSessionIdleHours": cfg.min_session_idle_hours,
                "extensionRetentionDays": cfg.extension_retention_days,
            },
        }

    async def memory_browse(self, action: str, params: dict[str, Any]) -> dict[str, Any]:
        """说明：前端用的记忆文件浏览 API，支持 list / read / search。"""
        backend = LocalMemoryBackend(self.config.memory.storage_path)
        try:
            if action == "list":
                return backend.list(
                    path=params.get("path"),
                    cursor=params.get("cursor"),
                    max_results=_safe_int(params.get("maxResults"), 2000),
                )
            if action == "read":
                path = params.get("path")
                if not path:
                    raise MemoryAccessError("path is required")
                return backend.read(
                    path=path,
                    line_offset=_safe_int(params.get("lineOffset"), 1),
                    max_lines=_safe_int(params.get("maxLines"), None),
                    max_tokens=_safe_int(params.get("maxTokens"), 20000),
                )
            if action == "search":
                queries = params.get("queries")
                if not queries or not isinstance(queries, list):
                    raise MemoryAccessError("queries must be a non-empty array")
                return backend.search(
                    queries=queries,
                    path=params.get("path"),
                    match_mode=params.get("matchMode", "any"),
                    case_sensitive=bool(params.get("caseSensitive", False)),
                    max_results=_safe_int(params.get("maxResults"), 200),
                )
            raise HTTPException(status_code=400, detail=f"unknown memory action: {action}")
        except MemoryAccessError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def _rebuild_memory_pipeline(self) -> None:
        """说明：用最新 MemoryConfig 重建 pipeline 实例，先关闭旧实例。"""
        if self.memory_pipeline is not None:
            await self.memory_pipeline.shutdown()
            self.memory_pipeline = None
        cfg = self.config.memory
        if not cfg.enabled:
            return
        try:
            self.memory_pipeline = MemoryPipeline(
                root=cfg.storage_path,
                agent_session_store=self.agent_session_store,
                trade_store=self.trade_store,
                agent_config_provider=lambda: _memory_agent_config(self.config, phase="extract"),
                phase2_config_provider=lambda: _memory_agent_config(self.config, phase="consolidation"),
                policy=self.memory_policy,
                startup_scan_limit=cfg.max_rollouts_per_startup,
                max_source_age_days=cfg.max_source_age_days,
                min_agent_session_idle_hours=cfg.min_session_idle_hours,
                max_unused_days=cfg.max_unused_days,
                extension_retention_days=cfg.extension_retention_days,
            )
        except OSError as exc:
            LOGGER.warning("memory pipeline rebuild failed: %s", exc)
            self.memory_pipeline = None

    def snapshot(self) -> dict[str, Any]:
        open_trades = [
            trade.to_payload()
            for trade in self.trade_store.list_trades(
                statuses=[TradeStatus.PLANNED, TradeStatus.OPEN],
            )
        ]
        exchange_positions: list[dict[str, Any]] = []
        exchange_orders: list[dict[str, Any]] = []
        try:
            exchange_positions = [p.to_payload() for p in self.exchange_router.get_all_positions()]
        except Exception:
            LOGGER.debug("Failed to fetch exchange positions for snapshot", exc_info=True)
        try:
            exchange_orders = [o.to_payload() for o in self.exchange_router.get_all_orders()]
        except Exception:
            LOGGER.debug("Failed to fetch exchange orders for snapshot", exc_info=True)
        recent_news: list[dict[str, Any]] = []
        news_status: dict[str, Any] = {"enabled": self.config.news.enabled}
        if self.news_service is not None:
            recent_news = [item.to_payload() for item in self.news_service.recent()]
            news_status.update({
                "lastStatus": self.news_service.last_status,
                "lastError": self.news_service.last_error,
                "lastFetchedAtMs": self.news_service.last_fetched_at_ms,
            })
        return serialize_market_state(
            config=self.config,
            instruments=self.instruments,
            quotes=self.controller.quotes,
            stream_status=self.controller.stream_status,
            agent_analyses=self.agent_analyses,
            open_trades=open_trades,
            exchange_positions=exchange_positions,
            exchange_orders=exchange_orders,
            recent_news=recent_news,
            news_status=news_status,
        )

    async def broadcast(self) -> None:
        if not self.clients:
            return
        payload = self.snapshot()
        stale_clients: list[WebSocket] = []
        for websocket in tuple(self.clients):
            try:
                await websocket.send_json(payload)
            except Exception:
                stale_clients.append(websocket)
        for websocket in stale_clients:
            self.clients.discard(websocket)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.clients.add(websocket)
        client_host = websocket.client.host if websocket.client else "-"
        LOGGER.info("websocket connected: client=%s clients=%d", client_host, len(self.clients))
        await websocket.send_json(self.snapshot())
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            self.clients.discard(websocket)
            LOGGER.info("websocket disconnected: client=%s clients=%d", client_host, len(self.clients))

    # ------------------------------------------------------------------
    # Instrument catalog
    # ------------------------------------------------------------------

    async def refresh_instrument_catalog(self) -> None:
        """说明：启动时预加载可添加标的目录，前端只做本地搜索。"""
        catalog: list[MarketInstrument] = []
        errors: dict[str, str] = {}

        try:
            bitget_catalog = await asyncio.to_thread(load_bitget_instrument_catalog)
            catalog.extend(
                sorted(
                    bitget_catalog.values(),
                    key=lambda item: (
                        BITGET_CATALOG_PRODUCT_ORDER.get(item.inst_type, 99),
                        item.symbol,
                    ),
                )
            )
        except Exception as exc:
            LOGGER.warning("Bitget catalog preload failed", exc_info=True)
            errors[BITGET_SOURCE] = str(exc)

        try:
            hyperliquid_catalog = await asyncio.to_thread(load_hyperliquid_instrument_catalog)
            catalog.extend(
                sorted(
                    hyperliquid_catalog.values(),
                    key=lambda item: item.symbol.upper(),
                )
            )
        except Exception as exc:
            LOGGER.warning("Hyperliquid catalog preload failed", exc_info=True)
            errors[HYPERLIQUID_SOURCE] = str(exc)

        self.instrument_catalog = tuple(catalog)
        self.instrument_catalog_loaded_at = utc_now_iso()
        self.instrument_catalog_errors = errors

    def instrument_catalog_payload(self) -> dict[str, Any]:
        active_keys = {instrument.key for instrument in self.instruments}
        return {
            "loadedAt": self.instrument_catalog_loaded_at,
            "errors": self.instrument_catalog_errors,
            "items": [
                instrument_catalog_item_payload(item, active_keys=active_keys)
                for item in self.instrument_catalog
            ],
        }

    # ------------------------------------------------------------------
    # Watchlist management
    # ------------------------------------------------------------------

    async def add_bitget(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_path = self._require_source_path()
        symbol = str(payload.get("symbol") or "")
        inst_type = str(payload.get("instType") or payload.get("inst_type") or "")
        label = str(payload.get("label") or "").strip() or None
        try:
            changed = await asyncio.to_thread(
                append_bitget_symbol_to_watchlist,
                source_path,
                symbol=symbol,
                inst_type=inst_type,
                label=label,
                group="crypto",
                show_collapsed=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    async def add_hyperliquid(self, payload: dict[str, Any]) -> dict[str, Any]:
        source_path = self._require_source_path()
        symbol = str(payload.get("symbol") or "")
        label = str(payload.get("label") or "").strip() or None
        group = str(payload.get("group") or payload.get("category") or "").strip() or None
        if group is None:
            for item in self.instrument_catalog:
                if item.source == HYPERLIQUID_SOURCE and item.symbol == symbol:
                    group = item.group
                    break
        try:
            changed = await asyncio.to_thread(
                append_hyperliquid_symbol_to_watchlist,
                source_path,
                symbol=symbol,
                label=label,
                group=group or "crypto",
                show_collapsed=True,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    async def remove_instrument(self, instrument_key: str) -> dict[str, Any]:
        source_path = self._require_source_path()
        instrument = self._instrument_by_key(instrument_key)
        try:
            changed = await asyncio.to_thread(
                remove_symbol_from_watchlist,
                source_path,
                source=instrument.source,
                symbol=instrument.symbol,
                inst_type=getattr(instrument, "inst_type", None),
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        self.agent_analyses.pop(instrument.key, None)
        if not changed:
            LOGGER.error(
                "watchlist remove failed after runtime match: instrument_key=%s source=%s symbol=%s inst_type=%s path=%s",
                instrument.key,
                instrument.source,
                instrument.symbol,
                getattr(instrument, "inst_type", None),
                source_path,
            )
            raise HTTPException(status_code=500, detail="Watchlist remove failed.")
        if changed:
            await self.reload_from_source()
        return {"changed": changed, "state": self.snapshot()}

    # ------------------------------------------------------------------
    # Config updates
    # ------------------------------------------------------------------

    async def list_agent_models(self, provider: str | None = None) -> dict[str, Any]:
        try:
            models = await list_available_agent_models(
                self.config.agent, provider_override=provider,
            )
        except (LLMProviderUnavailable, LLMProviderError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        resolved_provider = provider or self.config.agent.provider
        return {
            "provider": resolved_provider,
            "apiMode": normalize_api_mode(resolved_provider),
            "activeModel": self.config.agent.model,
            "models": models,
        }

    async def update_agent_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_source_path()
        try:
            next_config = agent_config_from_payload(self.config.agent, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, agent=next_config)
        self.agent_analyses = {}
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_provider_profile(
        self, provider_name: str, payload: dict[str, Any],
    ) -> dict[str, Any]:
        self._require_source_path()
        if provider_name not in SUPPORTED_AGENT_PROVIDERS:
            raise HTTPException(status_code=400, detail=f"Unknown provider: {provider_name}")
        current = self.config.agent
        profiles = dict(current.provider_profiles)
        old = profiles.get(provider_name, ProviderProfile())
        new_models = old.models
        if "models" in payload:
            raw = payload["models"]
            new_models = tuple(normalize_model(provider_name, m) for m in raw if m)
        elif "toggleModel" in payload:
            slug = normalize_model(provider_name, payload["toggleModel"])
            if slug in old.models:
                new_models = tuple(m for m in old.models if m != slug)
            else:
                new_models = (*old.models, slug)
        new_efforts = dict(old.model_efforts)
        if "modelEffort" in payload:
            me = payload["modelEffort"]
            if isinstance(me, dict) and "model" in me and "effort" in me:
                effort_model = normalize_model(provider_name, me["model"])
                new_efforts[effort_model] = normalize_reasoning_effort(me["effort"])
        new_efforts = {
            model: effort
            for model, effort in new_efforts.items()
            if model in new_models
        }
        new_api_key = old.api_key
        if payload.get("clearApiKey"):
            new_api_key = ""
        elif "apiKey" in payload or "api_key" in payload:
            raw_api_key = payload.get("apiKey", payload.get("api_key"))
            new_api_key = raw_api_key.strip() if isinstance(raw_api_key, str) else ""
        new_base_url = old.base_url
        if "baseUrl" in payload or "base_url" in payload:
            raw_base_url = payload.get("baseUrl", payload.get("base_url"))
            new_base_url = raw_base_url.strip() if isinstance(raw_base_url, str) else ""
        from ..config import _primary_from_profiles
        profiles[provider_name] = ProviderProfile(
            enabled=payload.get("enabled", old.enabled),
            models=new_models,
            model_efforts=tuple(new_efforts.items()),
            api_key=new_api_key,
            base_url=new_base_url,
        )
        primary_provider, primary_model, primary_effort = _primary_from_profiles(profiles)
        next_config = AgentConfig(
            enabled=current.enabled,
            provider=primary_provider,
            api_mode=normalize_api_mode(primary_provider),
            model=primary_model,
            max_candles=current.max_candles,
            reasoning_effort=primary_effort,
            provider_profiles=profiles,
        )
        self.config = replace(self.config, agent=next_config)
        self.agent_analyses = {}
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_analysis_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_source_path()
        try:
            next_config = analysis_config_from_payload(self.config.analysis, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, analysis=next_config)
        self.agent_analyses = {}
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_news_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_source_path()
        try:
            next_config = news_config_from_payload(self.config.news, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, news=next_config)
        await self._apply_news_service_state(next_config)
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_social_feed_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require_source_path()
        try:
            next_config = social_feed_config_from_payload(self.config.social_feed, payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        self.config = replace(self.config, social_feed=next_config)
        self._apply_social_feed_service_state(next_config)
        self._schedule_flush()
        await self.broadcast()
        return {"changed": True, "state": self.snapshot()}

    async def update_instrument_analysis_interval(
        self,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        source_path = self._require_source_path()
        instrument = self._instrument_by_key(instrument_key)
        if "interval" not in payload:
            raise HTTPException(status_code=400, detail="interval is required.")
        try:
            next_config = analysis_config_from_payload(
                self.config.analysis,
                {"interval": payload["interval"]},
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            changed = await asyncio.to_thread(
                update_instrument_analysis_interval_in_watchlist,
                source_path,
                source=instrument.source,
                symbol=instrument.symbol,
                inst_type=getattr(instrument, "inst_type", None),
                interval=next_config.interval,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        self.agent_analyses.pop(instrument.key, None)
        if changed:
            await self.reload_from_source(clear_candle_keys={instrument.key})
        else:
            await self.broadcast()
        return {"changed": changed, "state": self.snapshot()}

    # ------------------------------------------------------------------
    # Agent sessions
    # ------------------------------------------------------------------

    async def get_agent_session(self, instrument_key: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        payload = await asyncio.to_thread(
            self.agent_session_store.active_session_payload,
            instrument.key,
        )
        if not payload:
            return {"session": None, "messages": []}
        session = payload.get("session")
        if isinstance(session, dict):
            payload["run"] = await self.agent_runs.payload_for_session(str(session.get("id") or ""))
        return payload

    async def list_agent_sessions(self, *, limit: int = 20, preload: int = 10) -> dict[str, Any]:
        return await self._agent_session_history_payload(limit=limit, preload_limit=preload)

    async def create_agent_session(self, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        agent_cfg = self._effective_agent_config(payload.get("provider"), payload.get("model"))
        title = str(payload.get("title") or "New Agent Session")
        session = await asyncio.to_thread(
            self.agent_session_store.create_global_session,
            title=title,
            provider=agent_cfg.provider,
            model=agent_cfg.model,
            **agent_session_config_kwargs(agent_cfg),
        )
        await self.broadcast()
        return {
            **(await self._agent_session_payload(session.id)),
            "history": await self._agent_session_history_payload(),
        }

    async def get_agent_session_resource(self, identifier: str) -> dict[str, Any]:
        payload = await self._agent_session_payload(identifier)
        if payload["session"] is not None:
            return payload
        return await self.get_agent_session(identifier)

    async def update_agent_session(self, session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        title = str(payload.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="title is required.")
        try:
            session = await asyncio.to_thread(
                self.agent_session_store.rename_session,
                session_id,
                title,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        await self.broadcast()
        return {
            "session": await self._agent_session_payload(session.id),
            "history": await self._agent_session_history_payload(),
            "state": self.snapshot(),
        }

    async def delete_agent_session_by_id(self, session_id: str) -> dict[str, Any]:
        if await self.agent_runs.is_running(session_id):
            raise HTTPException(status_code=409, detail="cannot delete a running agent session")
        try:
            deleted = await asyncio.to_thread(
                self.agent_session_store.delete_session_by_id,
                session_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        await self.broadcast()
        return {
            "deleted": deleted,
            "session": {"session": None, "messages": []},
            "history": await self._agent_session_history_payload(),
            "state": self.snapshot(),
        }

    async def reset_agent_session(self, instrument_key: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        session = await asyncio.to_thread(
            self.agent_session_store.create_session,
            instrument_key=instrument.key,
            title=agent_session_title(instrument),
            provider=self.config.agent.provider,
            model=self.config.agent.model,
            **agent_session_config_kwargs(self.config.agent),
        )
        self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return {
            **(await self._agent_session_payload(session.id)),
            "history": await self._agent_session_history_payload(instrument.key),
        }

    async def list_agent_session_history(self, instrument_key: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        return await self._agent_session_history_payload(instrument.key)

    async def resume_agent_session(self, instrument_key: str, session_id: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        try:
            session = await asyncio.to_thread(
                self.agent_session_store.activate_session,
                instrument_key=instrument.key,
                session_id=session_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        session_payload = await self._agent_session_payload(session.id)
        self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return {
            "session": session_payload,
            "history": await self._agent_session_history_payload(instrument.key),
            "state": self.snapshot(),
        }

    async def delete_agent_session(self, instrument_key: str, session_id: str) -> dict[str, Any]:
        instrument = self._instrument_by_key(instrument_key)
        if await self.agent_runs.is_running(session_id):
            raise HTTPException(status_code=409, detail="cannot delete a running agent session")
        try:
            next_session = await asyncio.to_thread(
                self.agent_session_store.delete_session,
                instrument_key=instrument.key,
                session_id=session_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        if next_session is None:
            session_payload = {"session": None, "messages": []}
        else:
            session_payload = await self._agent_session_payload(next_session.id)
        self.agent_analyses.pop(instrument.key, None)
        await self.broadcast()
        return {
            "deleted": True,
            "session": session_payload,
            "history": await self._agent_session_history_payload(instrument.key),
            "state": self.snapshot(),
        }

    # ------------------------------------------------------------------
    # Trading
    # ------------------------------------------------------------------

    async def open_bitget_demo_trade(
        self,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if not self.config.trading.bitget_demo_enabled:
            raise HTTPException(status_code=409, detail="Bitget demo trading is disabled by config.")
        instrument = self._instrument_by_key(instrument_key)
        if instrument.source != BITGET_SOURCE:
            raise HTTPException(
                status_code=400,
                detail="Bitget demo trading only supports bitget instruments.",
            )
        inst_type = getattr(instrument, "inst_type", None)
        if inst_type is None:
            raise HTTPException(status_code=400, detail="Bitget instrument is missing inst_type.")
        try:
            direction = TradeDirection(str(payload.get("direction") or "").lower())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="direction must be long or short") from exc
        size = request_float(payload.get("size"), "size")
        if size <= 0:
            raise HTTPException(status_code=400, detail="size must be positive")
        order_type = str(payload.get("orderType") or payload.get("order_type") or "market").lower()
        if order_type not in {"market", "limit"}:
            raise HTTPException(status_code=400, detail="orderType must be market or limit")
        limit_price = payload.get("limitPrice", payload.get("limit_price"))
        resolved_limit = None if limit_price in (None, "") else request_float(limit_price, "limitPrice")
        if order_type == "limit" and resolved_limit is None:
            raise HTTPException(status_code=400, detail="limitPrice is required for limit orders")
        if resolved_limit is not None and resolved_limit <= 0:
            raise HTTPException(status_code=400, detail="limitPrice must be positive")
        reasoning = str(payload.get("reasoning") or "Manual Bitget demo trade")
        try:
            result = await asyncio.to_thread(
                open_bitget_demo_position,
                symbol=instrument.symbol,
                inst_type=inst_type,
                is_buy=direction is TradeDirection.LONG,
                size=size,
                order_type=order_type,
                limit_price=resolved_limit,
                margin_mode=str(payload.get("marginMode") or payload.get("margin_mode") or "crossed"),
                margin_coin=str(payload.get("marginCoin") or payload.get("margin_coin") or "USDT"),
                force=str(payload.get("force") or "gtc"),
                client_oid=(
                    None
                    if payload.get("clientOid", payload.get("client_oid")) in (None, "")
                    else str(payload.get("clientOid", payload.get("client_oid")))
                ),
            )
        except BitgetDemoTradingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        snapshot_payload = self._trading_snapshot_payload(instrument.key)
        snapshot_id = await asyncio.to_thread(
            lambda: self.trade_store.save_snapshot(
                instrument_key=instrument.key,
                payload=snapshot_payload,
            ).id
            if snapshot_payload
            else None
        )
        trade = await asyncio.to_thread(
            self.trade_store.create_trade,
            instrument_key=instrument.key,
            direction=direction,
            size=size,
            intent_price=resolved_limit,
            stop_price=None,
            target_prices=tuple(),
            reasoning_text=reasoning,
            session_id=None,
            snapshot_id=snapshot_id,
            market_kind=f"bitget-demo-{inst_type.lower()}",
            fill_source=BITGET_DEMO_FILL_SOURCE,
            status=TradeStatus.PLANNED,
            external_order_id=result.external_order_id,
        )
        await self.broadcast()
        return {
            "ok": True,
            "demo": True,
            "exchange": "bitget",
            "trade": trade.to_payload(),
            "fill": None,
            "order": result.raw,
            "state": self.snapshot(),
        }

    async def open_hyperliquid_trade(
        self,
        instrument_key: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if not self.config.trading.hyperliquid_enabled:
            raise HTTPException(status_code=409, detail="Hyperliquid trading is disabled by config.")
        instrument = self._instrument_by_key(instrument_key)
        if instrument.source != HYPERLIQUID_SOURCE:
            raise HTTPException(
                status_code=400,
                detail="Hyperliquid trading only supports hyperliquid instruments.",
            )
        try:
            direction = TradeDirection(str(payload.get("direction") or "").lower())
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="direction must be long or short") from exc
        size = request_float(payload.get("size"), "size")
        if size <= 0:
            raise HTTPException(status_code=400, detail="size must be positive")
        order_type = str(payload.get("orderType") or payload.get("order_type") or "market").strip().lower()
        if order_type not in {"market", "limit"}:
            raise HTTPException(status_code=400, detail="orderType must be market or limit")
        limit_price = payload.get("limitPrice", payload.get("limit_price"))
        resolved_limit = None if limit_price in (None, "") else request_float(limit_price, "limitPrice")
        if order_type == "limit" and resolved_limit is None:
            raise HTTPException(status_code=400, detail="limitPrice is required for limit orders")
        if resolved_limit is not None and resolved_limit <= 0:
            raise HTTPException(status_code=400, detail="limitPrice must be positive")
        slippage = request_float(payload.get("slippage", 0.05), "slippage")
        if slippage < 0:
            raise HTTPException(status_code=400, detail="slippage must be non-negative")
        reasoning = str(payload.get("reasoning") or "Manual Hyperliquid trade")
        try:
            result = await asyncio.to_thread(
                open_hyperliquid_position,
                coin=instrument.symbol,
                is_buy=direction is TradeDirection.LONG,
                size=size,
                order_type=order_type,
                limit_price=resolved_limit,
                slippage=slippage,
            )
        except HyperliquidTradingError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        status = TradeStatus.OPEN if result.filled_size else TradeStatus.PLANNED
        intent_price = result.average_price if result.average_price is not None else resolved_limit
        snapshot_payload = self._trading_snapshot_payload(instrument.key)
        snapshot_id = await asyncio.to_thread(
            lambda: self.trade_store.save_snapshot(
                instrument_key=instrument.key,
                payload=snapshot_payload,
            ).id
            if snapshot_payload
            else None
        )
        trade = await asyncio.to_thread(
            self.trade_store.create_trade,
            instrument_key=instrument.key,
            direction=direction,
            size=size,
            intent_price=None if intent_price is None else float(intent_price),
            stop_price=None,
            target_prices=tuple(),
            reasoning_text=reasoning,
            session_id=None,
            snapshot_id=snapshot_id,
            market_kind="hyperliquid-perp",
            fill_source=HYPERLIQUID_FILL_SOURCE,
            status=status,
            external_order_id=result.external_order_id,
        )
        fill_payload = None
        if result.filled_size and result.average_price is not None:
            fill = await asyncio.to_thread(
                self.trade_store.record_fill,
                trade_id=trade.id,
                kind=FillKind.ENTRY,
                price=float(result.average_price),
                quantity=float(result.filled_size),
                trigger_reason="hyperliquid order filled",
                fill_source=HYPERLIQUID_FILL_SOURCE,
                external_order_id=result.external_order_id,
            )
            fill_payload = fill.to_payload()
            trade = await asyncio.to_thread(self.trade_store.get_trade, trade.id) or trade
        await self.broadcast()
        return {
            "ok": True,
            "live": True,
            "trade": trade.to_payload(),
            "fill": fill_payload,
            "order": result.raw,
            "state": self.snapshot(),
        }

    # ------------------------------------------------------------------
    # Agent analysis
    # ------------------------------------------------------------------

    async def analyze_instrument(
        self,
        instrument_key: str,
        prompt: str | None = None,
        override_provider: str | None = None,
        override_model: str | None = None,
    ) -> dict[str, Any]:
        agent_cfg = self._effective_agent_config(override_provider, override_model)
        instrument = self._instrument_by_key(instrument_key)
        provider = create_llm_provider(agent_cfg)
        session_runtime = await AgentSessionRuntime.get_or_create_active(
            store=self.agent_session_store,
            instrument_key=instrument.key,
            title=agent_session_title(instrument),
            config=agent_cfg,
            provider=provider,
            runtime_services=AgentRuntimeServices(
                after_tool_hooks=(agent_tool_audit_hook,),
            ),
        )
        user_prompt = normalize_agent_prompt(prompt, DEFAULT_AGENT_USER_PROMPT)
        await session_runtime.append_user_message(user_prompt)
        await self._capture_manual_memory_request(user_prompt, session_id=session_runtime.session.id)
        history = await session_runtime.history_for_context(limit=8)
        return await self._run_agent_loop(
            session_runtime=session_runtime,
            user_prompt=user_prompt,
            history=history,
            agent_cfg=agent_cfg,
            candidate_instrument_keys=(instrument.key,),
            history_instrument_key=instrument.key,
        )

    async def analyze_agent_session(
        self,
        session_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        message = payload.get("message", payload.get("prompt"))
        agent_cfg = self._effective_agent_config(payload.get("provider"), payload.get("model"))
        session_runtime = await self._session_runtime_by_id(session_id, agent_cfg)
        user_prompt = normalize_agent_prompt(str(message) if message is not None else None, DEFAULT_AGENT_USER_PROMPT)
        await session_runtime.append_user_message(user_prompt)
        await self._capture_manual_memory_request(user_prompt, session_id=session_runtime.session.id)
        history = await session_runtime.history_for_context(limit=8)
        return await self._run_agent_loop(
            session_runtime=session_runtime,
            user_prompt=user_prompt,
            history=history,
            agent_cfg=agent_cfg,
            candidate_instrument_keys=self._candidate_instrument_keys(payload),
        )

    async def _run_agent_loop(
        self,
        *,
        session_runtime: AgentSessionRuntime,
        user_prompt: str,
        history: tuple[dict[str, Any], ...],
        agent_cfg: AgentConfig | None = None,
        candidate_instrument_keys: tuple[str, ...] = tuple(),
        history_instrument_key: str | None = None,
        event_handler: Callable[[dict[str, Any]], Any] | None = None,
    ) -> dict[str, Any]:
        cfg = agent_cfg or self.config.agent
        runtime = TradingAgentRuntime(
            provider=session_runtime.provider,
            config=cfg,
            services=TradingAgentRuntimeServices(
                context_provider=MarketContextProvider(self),
                trade_store=self.trade_store,
                snapshot_provider=lambda key: self._trading_snapshot_payload(key),
                exchange_router=self.exchange_router,
                news_service=self.news_service,
                social_feed_service=self.social_feed_service,
                trading_config=self.config.trading,
                memory_policy=self.memory_pipeline.policy
                if self.memory_pipeline is not None
                else self.memory_policy,
                runtime_services=session_runtime.runtime_services,
            ),
        )
        previous_tool_session = self._active_session_for_tools
        self._active_session_for_tools = session_runtime.session.id
        try:
            turn_result = await runtime.run_turn(
                session_id=session_runtime.session.id,
                user_prompt=user_prompt,
                history=history,
                candidate_instrument_keys=candidate_instrument_keys,
                event_handler=event_handler,
            )
        finally:
            self._active_session_for_tools = previous_tool_session
        payload = turn_result.to_payload()
        self._record_memory_citations_from_messages(
            [message.to_payload() for message in turn_result.loop_result.messages]
        )
        await session_runtime.append_transcript_messages(
            [message.to_payload() for message in turn_result.loop_result.messages],
            context=turn_result.context if turn_result.context else None,
        )
        for key in candidate_instrument_keys:
            self.agent_analyses.pop(key, None)
        await self.broadcast()
        return {
            "result": payload,
            "session": await session_runtime.payload(),
            "history": await self._agent_session_history_payload(history_instrument_key),
            "state": self.snapshot(),
        }

    async def stream_agent_message(
        self,
        identifier: str,
        payload: dict[str, Any],
    ) -> AsyncIterator[str]:
        message = payload.get("message", payload.get("prompt"))
        agent_cfg = self._effective_agent_config(payload.get("provider"), payload.get("model"))
        session_runtime, legacy_key = await self._session_runtime_for_identifier(identifier, agent_cfg)
        session_id = session_runtime.session.id
        try:
            channel = await self.agent_runs.start(session_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        LOGGER.info(
            "agent stream started: identifier=%s session=%s run=%s provider=%s model=%s",
            identifier,
            session_id,
            channel.run_id,
            agent_cfg.provider,
            agent_cfg.model,
        )
        after_seq = _request_int(payload.get("afterSeq", payload.get("after_seq")), default=0)
        task = asyncio.create_task(
            self._run_streaming_agent_session(
                channel=channel,
                session_runtime=session_runtime,
                payload=payload,
                message=message,
                agent_cfg=agent_cfg,
                legacy_key=legacy_key,
            )
        )
        await self.agent_runs.attach_task(session_id, channel.run_id, task)
        queue = await self.agent_runs.subscribe(session_id, channel.run_id, after_seq=after_seq)

        async def event_stream() -> AsyncIterator[str]:
            try:
                while True:
                    event = await queue.get()
                    if event is None:
                        break
                    yield sse_event(event)
            finally:
                await self.agent_runs.unsubscribe(session_id, channel.run_id, queue)
                LOGGER.info(
                    "agent stream detached: identifier=%s session=%s run=%s",
                    identifier,
                    session_id,
                    channel.run_id,
                )

        return event_stream()

    async def _run_streaming_agent_session(
        self,
        *,
        channel: AgentRunChannel,
        session_runtime: AgentSessionRuntime,
        payload: dict[str, Any],
        message: Any,
        agent_cfg: AgentConfig,
        legacy_key: str | None,
    ) -> None:
        session_id = channel.session_id
        run_id = channel.run_id

        async def emit(event: dict[str, Any]) -> None:
            await self.agent_runs.publish(session_id, run_id, event)

        error_message: str | None = None
        try:
            await emit({"type": "agent_start"})
            user_prompt = normalize_agent_prompt(
                str(message) if message is not None else None,
                DEFAULT_AGENT_USER_PROMPT,
            )
            user_message = await session_runtime.append_user_message(user_prompt)
            await self._capture_manual_memory_request(user_prompt, session_id=session_runtime.session.id)
            await emit({"type": "message_end", "message": user_message})
            history = await session_runtime.history_for_context(limit=8)
            await self._run_agent_loop(
                session_runtime=session_runtime,
                user_prompt=user_prompt,
                history=history,
                agent_cfg=agent_cfg,
                candidate_instrument_keys=self._candidate_instrument_keys(payload, legacy_key=legacy_key),
                history_instrument_key=legacy_key,
                event_handler=emit,
            )
        except asyncio.CancelledError:
            error_message = "Agent run interrupted."
            with suppress(Exception):
                await session_runtime.append_transcript_message({
                    "role": "assistant",
                    "content": error_message,
                    "error": error_message,
                })
                await emit({"type": "error", "error": error_message})
            raise
        except HTTPException as exc:
            error_message = str(exc.detail)
            await session_runtime.append_transcript_message({
                "role": "assistant",
                "content": error_message,
                "error": error_message,
            })
            await emit({"type": "error", "error": error_message})
        except Exception as exc:
            LOGGER.exception("agent stream failed")
            error_message = str(exc) or exc.__class__.__name__
            await session_runtime.append_transcript_message({
                "role": "assistant",
                "content": error_message,
                "error": error_message,
            })
            await emit({"type": "error", "error": error_message})
        finally:
            with suppress(Exception):
                await emit({
                    "type": "session_update",
                    "session": await self._agent_session_payload(session_runtime.session.id),
                    "history": await self._agent_session_history_payload(legacy_key),
                    "state": self.snapshot(),
                })
            await self.agent_runs.finish(session_id, run_id, error=error_message)
            LOGGER.info(
                "agent stream finished: session=%s run=%s error=%s",
                session_id,
                run_id,
                bool(error_message),
            )

    async def _capture_manual_memory_request(self, user_prompt: str, *, session_id: str) -> None:
        if (
            self.memory_pipeline is None
            or not self.memory_policy.generate_memories
            or not _looks_like_manual_memory_request(user_prompt)
        ):
            return
        digest = hashlib.sha1(user_prompt.encode("utf-8")).hexdigest()[:12]
        note_id = f"agent-{session_id[:12]}-{digest}"
        with suppress(Exception):
            await self.memory_pipeline.enqueue_manual_note(
                note_id=note_id,
                payload={
                    "text": user_prompt,
                    "source": "agent_session",
                    "sessionId": session_id,
                    "createdAt": utc_now_iso(),
                },
            )
            self._kickoff_memory_pipeline_if_ready()

    def _kickoff_memory_pipeline_if_ready(self) -> None:
        if (
            self.memory_pipeline is None
            or not self.memory_policy.generate_memories
            or not self.config.agent.enabled
        ):
            return
        self.memory_pipeline.kickoff_startup()

    def _record_memory_citations_from_messages(self, messages: list[dict[str, Any]]) -> None:
        if self.memory_pipeline is None or not self.memory_policy.generate_memories:
            return
        for message in messages:
            if str(message.get("role") or "") != "assistant":
                continue
            citations = parse_memory_citations(str(message.get("content") or ""))
            if citations is None:
                continue
            for entry in citations.entries:
                with suppress(Exception):
                    self.memory_pipeline.state_store.record_usage(
                        file_path=entry.file_path,
                        usage_kind="citation",
                    )

    def _create_social_feed_service(self, config: SocialFeedConfig) -> SocialFeedService:
        from ..social_feed.providers import XInternalClient

        return SocialFeedService(
            store=SocialFeedStore(),
            client_factory=lambda: XInternalClient(self.x_auth_store.load()),
            recent_limit=config.recent_limit,
            retention_days=config.retention_days,
            max_items=config.max_items,
        )

    def _apply_social_feed_service_state(self, next_config: SocialFeedConfig) -> None:
        if not next_config.enabled:
            self.social_feed_service = None
            return
        self.social_feed_service = self._create_social_feed_service(next_config)

    async def _apply_news_service_state(self, next_config: NewsConfig) -> None:
        if not next_config.enabled:
            if self.news_service is not None:
                await self.news_service.stop()
                self.news_service = None
            return
        if self.news_service is not None:
            await self.news_service.stop()
            self.news_service = None
        store = NewsStore()
        provider = ReutersSitemapProvider(
            url=next_config.reuters_url,
            timeout_seconds=next_config.request_timeout_seconds,
        )
        service = NewsService(
            store=store,
            provider=provider,
            poll_interval_seconds=next_config.poll_interval_seconds,
            max_interval_seconds=next_config.max_interval_seconds,
            retention_days=next_config.retention_days,
            recent_limit=next_config.recent_limit,
        )
        self.news_service = service
        if self.running:
            await service.start()

    async def _agent_session_payload(self, session_id: str) -> dict[str, Any]:
        payload = await asyncio.to_thread(self.agent_session_store.session_payload, session_id)
        if not payload:
            return {"session": None, "messages": []}
        session = payload.get("session")
        if isinstance(session, dict):
            payload["run"] = await self.agent_runs.payload_for_session(str(session.get("id") or session_id))
        return payload

    async def _agent_session_history_payload(
        self,
        instrument_key: str | None = None,
        *,
        limit: int = 20,
        preload_limit: int = 0,
    ) -> dict[str, Any]:
        sessions = await asyncio.to_thread(
            self.agent_session_store.list_sessions,
            instrument_key,
            limit=limit,
        )
        payloads = [session.to_payload() for session in sessions]
        run_payloads = await self.agent_runs.payloads_for_sessions([
            str(payload["id"]) for payload in payloads
        ])
        for payload in payloads:
            payload["run"] = run_payloads.get(str(payload["id"]))
        result: dict[str, Any] = {"sessions": payloads}
        clean_preload_limit = max(0, min(int(preload_limit), 10, len(payloads)))
        if clean_preload_limit:
            preloaded = await asyncio.to_thread(
                self.agent_session_store.session_payloads,
                [str(payload["id"]) for payload in payloads[:clean_preload_limit]],
            )
            preloaded_payloads = list(preloaded)
            for payload in preloaded_payloads:
                session = payload.get("session")
                if isinstance(session, dict):
                    payload["run"] = run_payloads.get(str(session.get("id") or ""))
            result["preloadedSessions"] = preloaded_payloads
        return result

    async def _session_runtime_by_id(
        self,
        session_id: str,
        agent_cfg: AgentConfig,
    ) -> AgentSessionRuntime:
        session = await asyncio.to_thread(self.agent_session_store.get_session, session_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"agent session not found: {session_id}")
        provider = create_llm_provider(agent_cfg)
        if (
            session.provider != agent_cfg.provider
            or session.model != agent_cfg.model
            or session.api_mode != agent_cfg.api_mode
            or session.reasoning_effort != agent_cfg.reasoning_effort
        ):
            session = await asyncio.to_thread(
                self.agent_session_store.update_session_metadata,
                session.id,
                provider=agent_cfg.provider,
                model=agent_cfg.model,
                api_mode=agent_cfg.api_mode,
                reasoning_effort=agent_cfg.reasoning_effort,
            )
        return AgentSessionRuntime(
            session=session,
            store=self.agent_session_store,
            config=agent_cfg,
            provider=provider,
            runtime_services=AgentRuntimeServices(
                after_tool_hooks=(agent_tool_audit_hook,),
            ),
        )

    async def _session_runtime_for_identifier(
        self,
        identifier: str,
        agent_cfg: AgentConfig,
    ) -> tuple[AgentSessionRuntime, str | None]:
        session = await asyncio.to_thread(self.agent_session_store.get_session, identifier)
        if session is not None:
            return await self._session_runtime_by_id(identifier, agent_cfg), None
        instrument = self._instrument_by_key(identifier)
        provider = create_llm_provider(agent_cfg)
        runtime = await AgentSessionRuntime.get_or_create_active(
            store=self.agent_session_store,
            instrument_key=instrument.key,
            title=agent_session_title(instrument),
            config=agent_cfg,
            provider=provider,
            runtime_services=AgentRuntimeServices(
                after_tool_hooks=(agent_tool_audit_hook,),
            ),
        )
        return runtime, instrument.key

    def _candidate_instrument_keys(
        self,
        payload: dict[str, Any],
        *,
        legacy_key: str | None = None,
    ) -> tuple[str, ...]:
        raw = payload.get("candidateInstrumentKeys")
        if raw is None:
            return (legacy_key,) if legacy_key else tuple()
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="candidateInstrumentKeys must be an array.")
        provider = MarketContextProvider(self)
        keys: list[str] = []
        for item in raw[:12]:
            key = provider.resolve_instrument_key(str(item))
            self._instrument_by_key(key)
            if key not in keys:
                keys.append(key)
        return tuple(keys)

    def _effective_agent_config(
        self,
        override_provider: str | None = None,
        override_model: str | None = None,
    ) -> AgentConfig:
        return effective_agent_config(self.config.agent, override_provider, override_model)

    def _require_source_path(self) -> Path:
        if self.config.source_path is None:
            raise HTTPException(status_code=409, detail="Cannot edit watchlist without a file.")
        return self.config.source_path

    def _instrument_by_key(self, instrument_key: str) -> MarketInstrument:
        for instrument in self.instruments:
            if instrument.key == instrument_key:
                return instrument
        raise HTTPException(status_code=404, detail="Instrument not found.")

    def _schedule_flush(self) -> None:
        if self._flush_handle is not None:
            self._flush_handle.cancel()
        loop = asyncio.get_event_loop()
        self._flush_handle = loop.call_later(
            self._flush_delay,
            lambda: asyncio.ensure_future(self._flush_to_disk()),
        )

    async def _flush_to_disk(self) -> None:
        self._flush_handle = None
        source_path = self.config.source_path
        if source_path is None:
            return
        try:
            await asyncio.to_thread(
                update_agent_config_in_watchlist, source_path, self.config.agent,
            )
            await asyncio.to_thread(
                update_analysis_config_in_watchlist, source_path, self.config.analysis,
            )
            await asyncio.to_thread(
                update_news_config_in_watchlist, source_path, self.config.news,
            )
            await asyncio.to_thread(
                update_social_feed_config_in_watchlist, source_path, self.config.social_feed,
            )
            await asyncio.to_thread(
                update_trading_config_in_watchlist, source_path, self.config.trading,
            )
            await asyncio.to_thread(
                update_memory_config_in_watchlist, source_path, self.config.memory,
            )
        except Exception:
            LOGGER.warning("Config flush to disk failed", exc_info=True)

    async def reload_from_source(self, *, clear_candle_keys: set[str] | None = None) -> None:
        if self.config.source_path is None:
            raise HTTPException(status_code=409, detail="No watchlist file is active.")
        config = await asyncio.to_thread(load_config, self.config.source_path)
        instruments = await asyncio.to_thread(resolve_instruments, config.instruments)
        previous_quotes = self.controller.quotes
        self.controller.stop()
        self.config = config
        self.exchange_router.trading_config = config.trading
        await self._apply_memory_config(config)
        self.instruments = instruments
        self.controller = self.controller_factory(config=config, instruments=instruments)
        active_keys = {instrument.key for instrument in instruments}
        for key in active_keys & previous_quotes.keys():
            self.controller.quotes[key] = previous_quotes[key]
        for key in clear_candle_keys or set():
            quote = self.controller.quotes.get(key)
            if quote is not None:
                quote.candles = tuple()
        self.agent_analyses = {
            key: value for key, value in self.agent_analyses.items() if key in active_keys
        }
        if self.running:
            self.controller.start()
            self._kickoff_memory_pipeline_if_ready()
        await self.broadcast()

    async def _run_trade_lifecycle_loop(self) -> None:
        while self.running:
            try:
                await asyncio.sleep(TRADE_LIFECYCLE_INTERVAL_SECONDS)
            except asyncio.CancelledError:
                break
            try:
                changed = await self._run_trade_lifecycle_once(limit=TRADE_LIFECYCLE_BATCH_SIZE)
            except Exception:
                LOGGER.warning("trade lifecycle pass failed", exc_info=True)
                continue
            if changed:
                await self.broadcast()

    async def _run_trade_lifecycle_once(self, *, limit: int = TRADE_LIFECYCLE_BATCH_SIZE) -> bool:
        if not self.config.agent.enabled:
            LOGGER.debug("trade lifecycle: skipped — agent is disabled")
            return False
        open_trades = await asyncio.to_thread(
            self.trade_store.list_trades,
            statuses=[TradeStatus.OPEN],
            limit=max(1, int(limit)),
        )
        if not open_trades:
            LOGGER.debug("trade lifecycle: no open trades, skipping")
            return False
        LOGGER.info("trade lifecycle: scanning %d open trade(s)", len(open_trades))
        changed = False
        for trade in open_trades:
            result = await self._run_lifecycle_agent_for_trade(trade)
            if result:
                changed = True
        return changed

    async def _run_lifecycle_agent_for_trade(self, trade: Trade) -> bool:
        t0 = _monotonic()
        trade_label = f"trade#{trade.id} {trade.instrument_key} {trade.direction.value}"
        LOGGER.info("trade lifecycle: checking %s", trade_label)
        try:
            provider = create_llm_provider(self.config.agent)
        except (LLMProviderUnavailable, LLMProviderError):
            LOGGER.warning("trade lifecycle: skipped %s — agent provider unavailable", trade_label)
            return False
        snapshot_payload = self._snapshot_payload_for_trade(trade)
        can_use_web = self._trade_review_can_use_web(trade.instrument_key)
        runtime = AgentRuntime(
            provider=provider,
            tool_packs=self._lifecycle_tool_packs(trade, snapshot_payload, can_use_web),
            system_prompt=_TRADE_LIFECYCLE_SYSTEM_PROMPT,
            max_iterations=8,
        )
        prompt = json.dumps({
            "trade_id": trade.id,
            "instrument_key": trade.instrument_key,
            "direction": trade.direction.value,
            "status": trade.status.value,
            "webSearchAllowed": can_use_web,
        }, ensure_ascii=False, separators=(",", ":"))
        result = await runtime.run(user_message=prompt)
        elapsed_ms = int((_monotonic() - t0) * 1000)
        if result.error:
            LOGGER.warning(
                "trade lifecycle: %s failed in %dms (%d iterations, %d tokens) — %s",
                trade_label, elapsed_ms, result.iterations, result.total_tokens, result.error,
            )
            return False
        parsed = _parse_review_agent_output(result.content)
        if not parsed.get("closed"):
            LOGGER.info(
                "trade lifecycle: %s still open — %dms, %d iterations, %d tokens",
                trade_label, elapsed_ms, result.iterations, result.total_tokens,
            )
            return False
        refreshed = self.trade_store.get_trade(trade.id)
        if refreshed is None:
            LOGGER.warning("trade lifecycle: %s disappeared from store after agent run", trade_label)
            return False
        if refreshed.status is not TradeStatus.CLOSED:
            self._close_trade_from_agent(refreshed, parsed)
        refreshed = self.trade_store.get_trade(trade.id)
        if refreshed is None:
            LOGGER.warning("trade lifecycle: %s disappeared from store after close", trade_label)
            return False
        lesson = str(parsed.get("lesson") or "").strip()
        if lesson and not self.trade_store.list_lessons(trade_id=trade.id, limit=1):
            tags = parsed.get("tags")
            self.trade_store.save_lesson(
                trade_id=trade.id,
                instrument_key=trade.instrument_key,
                text=lesson,
                category=str(parsed.get("category") or ""),
                tags=[str(tag) for tag in tags] if isinstance(tags, list) else [],
            )
        self._enqueue_trade_memory_event(refreshed)
        close_reason = parsed.get("close_reason", "unknown")
        lesson_preview = (lesson[:80] + "...") if len(lesson) > 80 else lesson
        LOGGER.info(
            "trade lifecycle: %s CLOSED reason=%s pnl=%.4f — %dms, %d iterations, %d tokens — lesson: %s",
            trade_label, close_reason,
            refreshed.realized_pnl, elapsed_ms, result.iterations, result.total_tokens,
            lesson_preview or "(none)",
        )
        return True

    def _lifecycle_tool_packs(
        self,
        trade: Trade,
        snapshot_payload: dict[str, Any] | None,
        can_use_web: bool,
    ) -> tuple[ToolPack, ...]:
        return (
            ToolPack(
                "trade-review",
                lambda: build_trade_review_tools(
                    store=self.trade_store,
                    trade_id=trade.id,
                    snapshot_payload=snapshot_payload,
                    exchange_router=self.exchange_router,
                ),
            ),
            ToolPack(
                "market",
                lambda: build_market_tools(
                    MarketContextProvider(self),
                    candidate_instrument_keys=(trade.instrument_key,),
                ),
            ),
            ToolPack("web", build_web_tools, enabled=can_use_web),
        )

    def _snapshot_payload_for_trade(self, trade: Trade) -> dict[str, Any] | None:
        if trade.snapshot_id is None:
            return None
        snapshot = self.trade_store.get_snapshot(trade.snapshot_id)
        return snapshot.payload if snapshot is not None else None

    def _close_trade_from_agent(self, trade: Trade, agent_output: dict[str, Any]) -> None:
        if any(fill.kind in (FillKind.EXIT, FillKind.STOP, FillKind.TARGET) for fill in trade.fills):
            LOGGER.info("trade lifecycle: trade#%d already has exit fill, marking closed with existing pnl", trade.id)
            self.trade_store.mark_closed(trade.id, realized_pnl=trade.realized_pnl)
            return
        raw_exit_price = agent_output.get("exit_price")
        if raw_exit_price is None or float(raw_exit_price) <= 0:
            LOGGER.warning(
                "trade lifecycle: closing trade#%d without exit fill — agent did not provide a valid exit_price",
                trade.id,
            )
            self.trade_store.mark_closed(trade.id, realized_pnl=0.0)
            return
        exit_price = float(raw_exit_price)
        quantity = _closed_quantity(trade)
        close_reason = str(agent_output.get("close_reason") or "unknown")
        fill_kind = _fill_kind_from_close_reason(close_reason)
        self.trade_store.record_fill(
            trade_id=trade.id,
            kind=fill_kind,
            price=exit_price,
            quantity=float(quantity),
            trigger_reason=close_reason,
            fill_source=trade.fill_source,
            external_order_id=trade.external_order_id,
        )
        entry_price = trade.average_entry_price or trade.intent_price or 0.0
        realized_pnl = trade.direction.sign * (exit_price - float(entry_price)) * float(quantity)
        self.trade_store.mark_closed(trade.id, realized_pnl=realized_pnl)

    def _enqueue_trade_memory_event(self, trade: Trade) -> None:
        if self.memory_pipeline is None:
            LOGGER.debug("trade lifecycle: skipped memory enqueue for trade#%d — pipeline unavailable", trade.id)
            return
        self.memory_pipeline.enqueue_trade_event(trade_id=trade.id, updated_at=trade.updated_at_ms)
        self._kickoff_memory_pipeline_if_ready()

    def _trade_review_can_use_web(self, instrument_key: str) -> bool:
        try:
            instrument = self._instrument_by_key(instrument_key)
        except HTTPException:
            return False
        interval = instrument.analysis_interval or self.config.analysis.interval
        return _INTERVAL_MINUTES.get(interval, 0) >= _DAILY_THRESHOLD_MINUTES

    async def _pump(self) -> None:
        refresh_seconds = max(0.25, self.config.display.refresh_interval_ms / 1000)
        while self.running:
            result = self.controller.drain_events()
            if result.dirty:
                await self.broadcast()
            await asyncio.sleep(refresh_seconds)
            if not result.dirty:
                await self.broadcast()

    def _trading_snapshot_payload(self, instrument_key: str) -> dict[str, Any]:
        instrument = None
        for candidate in self.instruments:
            if candidate.key == instrument_key:
                instrument = candidate
                break
        if instrument is None:
            return {}
        quote = self.controller.quotes.get(instrument_key)
        if quote is None:
            return {}
        try:
            context = build_market_context(
                instrument=instrument,
                quote=quote,
                interval=instrument.analysis_interval or self.config.analysis.interval,
                max_candles=self.config.agent.max_candles,
            )
        except Exception:
            context = {}
        current_analysis = self.agent_analyses.get(instrument_key)
        return {
            "capturedAt": utc_now_iso(),
            "instrument": {
                "key": instrument.key,
                "label": instrument.label,
                "source": instrument.source,
                "group": instrument.group,
            },
            "context": context,
            "currentAnalysis": current_analysis,
            "openingThesis": self._opening_thesis_payload(),
        }

    def _opening_thesis_payload(self) -> dict[str, Any] | None:
        session_id = self._active_session_for_tools
        if not session_id:
            return None
        try:
            messages = self.agent_session_store.list_messages(session_id, limit=8)
        except Exception:
            return {"sessionId": session_id}
        last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
        last_assistant = next((m.content for m in reversed(messages) if m.role == "assistant"), "")
        return {
            "sessionId": session_id,
            "lastUserMessage": last_user,
            "lastAssistantMessage": last_assistant,
        }


def _safe_int(value: Any, default: int | None) -> int | None:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _request_int(value: Any, *, default: int = 0) -> int:
    """Parse an optional integer request value."""
    if value in (None, ""):
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


_monotonic = time.monotonic


def _closed_quantity(trade: Trade) -> float:
    entry_quantity = sum(fill.quantity for fill in trade.fills if fill.kind is FillKind.ENTRY)
    exit_quantity = sum(
        fill.quantity
        for fill in trade.fills
        if fill.kind in (FillKind.EXIT, FillKind.STOP, FillKind.TARGET)
    )
    remaining = entry_quantity - exit_quantity
    return remaining if remaining > 0 else trade.size


_CLOSE_REASON_TO_FILL_KIND = {
    "stop_hit": FillKind.STOP,
    "target_hit": FillKind.TARGET,
    "liquidated": FillKind.EXIT,
    "manual_close": FillKind.EXIT,
}


def _fill_kind_from_close_reason(close_reason: str) -> FillKind:
    return _CLOSE_REASON_TO_FILL_KIND.get(close_reason, FillKind.EXIT)


def _parse_review_agent_output(content: str) -> dict[str, Any]:
    text = (content or "").strip()
    if text.startswith("```"):
        text = text.strip("`").strip()
        if "\n" in text:
            first_line, rest = text.split("\n", 1)
            text = rest if first_line.strip().lower() in {"json", "javascript"} else text
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        LOGGER.warning("trade lifecycle: agent output is not valid JSON, treating as raw lesson — %.120s", text)
        return {"lesson": content.strip(), "category": "general", "tags": []}
    if not isinstance(parsed, dict):
        LOGGER.warning("trade lifecycle: agent output is not a JSON object — %s", type(parsed).__name__)
        return {"lesson": str(parsed), "category": "general", "tags": []}
    return parsed


def _memory_policy_from_config(config: AppConfig) -> MemoryRuntimePolicy:
    """说明：把用户配置转换成本轮 runtime 的 memory 读写策略。"""
    memory = config.memory
    if not memory.enabled:
        return MemoryRuntimePolicy.disabled()
    return MemoryRuntimePolicy(
        generate_memories=memory.generate_memories,
        use_memories=memory.use_memories,
    )


def _memory_agent_config(config: AppConfig, *, phase: str = "extract") -> AgentConfig:
    """说明：构造 memory pipeline 使用的 AgentConfig，支持按阶段覆盖模型。

    格式为 "provider:model" 或纯 model slug；未设置时 fallback 到全局 agent config。
    """
    mem_cfg = config.memory
    model_spec = mem_cfg.consolidation_model if phase == "consolidation" else mem_cfg.extract_model
    if not model_spec:
        if phase == "consolidation" and mem_cfg.extract_model:
            model_spec = mem_cfg.extract_model
        else:
            return config.agent
    if ":" in model_spec:
        provider, model = model_spec.split(":", 1)
    else:
        provider = config.agent.provider
        model = model_spec
    return replace(
        config.agent,
        provider=provider,
        api_mode=normalize_api_mode(provider),
        model=normalize_model(provider, model),
    )


def _looks_like_manual_memory_request(text: str) -> bool:
    compact = " ".join(text.strip().split()).lower()
    if not compact:
        return False
    if any(term in compact for term in MANUAL_MEMORY_NEGATIONS):
        return False
    return any(term in compact for term in MANUAL_MEMORY_TRIGGERS)
