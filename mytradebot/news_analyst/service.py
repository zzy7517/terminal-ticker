"""文件用途：news_analyst 服务（filter + verify + gate + 落库）一体。

# 已完成
# - [x] 多品种白名单 (TODO-A)：universe 中每个 entry 独立 filter+verify+gate
# - [x] Cooldown 表 (TODO-B)：(instrument_key, direction) → last_open_ms, 内存
# - [x] K 线印证 (TODO-C)：1H+15m candles 序列化进 prompt，LLM 据此印证或反驳

# 后续 TODO（按优先级）
# - [ ] Lessons 注入：verify prompt 头部塞 trade_store.list_lessons(instrument_key=...) 最近 5 条。
# - [ ] WebSocket 推 newsDecisions：让前端 News 卡片挂"已分析/已下单"badge。
# - [ ] OpenAI Chat provider 兼容：当前只走 codex provider.chat()。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

from ..config import NewsAnalystConfig, NewsUniverseEntry
from ..domain.price_action import Candle
from ..news.types import NewsItem
from ..trading.models import TradeDirection, TradeStatus
from ..trading.store import TradeStore

# K 线印证拉取参数：每个 timeframe 的最近条数。20 根足够 LLM 看 ~1.5 天 1H
# 趋势 + ~5 小时 15m 行为，token 占用小。
_VERIFY_CANDLE_LIMIT = 20
_VERIFY_TIMEFRAMES = ("1H", "15m")

# CandleCache.recent 的可调用签名：(symbol_key, interval, *, limit) → Candle 元组
CandleProvider = Callable[[str, str, int], "tuple[Candle, ...]"]

LOGGER = logging.getLogger(__name__)

# LLM 调用接口：messages → ChatResponse-like (with .content str)。
# 用 Protocol 形式而非具体 CodexProvider，方便测试注入 fake。
LLMChatFn = Callable[[list[dict[str, Any]]], Awaitable[Any]]


@dataclass(frozen=True)
class NewsDecision:
    """说明：一次决策的结构化结果，无论是否下单都落库。"""
    news_url: str
    news_title: str
    instrument_key: str
    step: str           # "filter_miss" | "llm_error" | "low_confidence" | "entry_too_far" | "opened"
    direction: str | None
    confidence: float | None
    entry_price: float | None
    stop_price: float | None
    target_price: float | None
    reason: str
    trade_id: int | None
    created_at_ms: int


_NEWS_DECISIONS_SCHEMA = """
CREATE TABLE IF NOT EXISTS news_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    news_url TEXT NOT NULL,
    news_title TEXT NOT NULL,
    instrument_key TEXT NOT NULL,
    step TEXT NOT NULL,
    direction TEXT,
    confidence REAL,
    entry_price REAL,
    stop_price REAL,
    target_price REAL,
    reason TEXT NOT NULL DEFAULT '',
    trade_id INTEGER,
    created_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_decisions_url ON news_decisions(news_url);
CREATE INDEX IF NOT EXISTS idx_news_decisions_created ON news_decisions(created_at_ms DESC);
"""


class NewsDecisionStore:
    """说明：news_decisions 表 CRUD。复用 TradeStore 的 SQLite 文件。"""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = str(db_path)
        with self._connect() as conn:
            conn.executescript(_NEWS_DECISIONS_SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def insert(self, decision: NewsDecision) -> int:
        with self._connect() as conn:
            cursor = conn.execute(
                """
                INSERT INTO news_decisions
                (news_url, news_title, instrument_key, step, direction, confidence,
                 entry_price, stop_price, target_price, reason, trade_id, created_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    decision.news_url, decision.news_title, decision.instrument_key,
                    decision.step, decision.direction, decision.confidence,
                    decision.entry_price, decision.stop_price, decision.target_price,
                    decision.reason, decision.trade_id, decision.created_at_ms,
                ),
            )
            return int(cursor.lastrowid)

    def recent(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM news_decisions ORDER BY created_at_ms DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]


# ── Filter ────────────────────────────────────────────────────────────────

def matches_aliases(item: NewsItem, aliases: tuple[str, ...]) -> bool:
    """说明：title + summary 子串检查（大小写不敏感），命中任一 alias 即返回 True。"""
    if not aliases:
        return False
    haystack = f"{item.title}\n{item.summary or ''}".lower()
    for alias in aliases:
        token = alias.strip().lower()
        if not token:
            continue
        # 用 word-boundary 减少误命中（"SPY" 不该被 "espy" 命中）。
        # 中文 alias 没有 word boundary 概念，对非 ASCII 直接子串匹配。
        if token.isascii() and any(c.isalnum() for c in token):
            pattern = r"(?<![A-Za-z0-9])" + re.escape(token) + r"(?![A-Za-z0-9])"
            if re.search(pattern, haystack):
                return True
        else:
            if token in haystack:
                return True
    return False


# ── Verify (LLM JSON output) ──────────────────────────────────────────────

_VERIFY_SYSTEM_PROMPT = """You are a quant analyst. Given a single Reuters news headline AND recent multi-timeframe OHLCV candles for a specific instrument, decide whether the news implies a tradable directional move over the next 1-4 hours, USING THE CANDLES TO CORROBORATE OR REJECT YOUR HYPOTHESIS.

Respond with STRICT JSON only, no prose, matching this schema:
{
  "direction": "long" | "short" | "none",
  "confidence": 0.0-1.0,
  "entry": <number or null>,    // null if direction="none"
  "stop": <number or null>,
  "target": <number or null>,
  "reason": "<one sentence: news implication + how candles agree/disagree>"
}

Rules:
- direction="none" if news has no clear directional implication, OR if candles strongly contradict the news (e.g. news bullish but instrument already gapped +5% in last hour — chasing here is bad)
- Use the most recent candle's close as guidance for entry / stop / target levels (entry near current price, stop at recent swing, target reasonable)
- confidence rubric:
    * 0.85+ : market-moving news (Fed surprise, geopolitical shock) AND candles support direction
    * 0.6-0.85 : clearly directional news AND candles neutral or supportive
    * 0.3-0.6 : ambiguous news OR candles contradict
    * <0.3 : weak signal
- confidence ≤ 0.5 if candles are missing or empty (you have no way to verify)
"""


@dataclass(frozen=True)
class _Verdict:
    direction: str
    confidence: float
    entry: float | None
    stop: float | None
    target: float | None
    reason: str


async def _verify(
    item: NewsItem,
    instrument_key: str,
    llm_chat: LLMChatFn,
    timeout_seconds: float,
    candles_by_tf: dict[str, tuple[Candle, ...]] | None = None,
) -> _Verdict | None:
    """说明：调 LLM，解析 JSON。失败/超时返回 None（service 把它当 llm_error）。"""
    candles_section = _format_candles_section(candles_by_tf or {})
    user_prompt = (
        f"Instrument: {instrument_key}\n"
        f"News title: {item.title}\n"
        f"News summary: {item.summary or '(none)'}\n"
        f"\n{candles_section}"
    )
    messages = [
        {"role": "system", "content": _VERIFY_SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]
    try:
        resp = await asyncio.wait_for(llm_chat(messages), timeout=timeout_seconds)
    except (asyncio.TimeoutError, Exception) as exc:  # noqa: BLE001
        LOGGER.warning("news_analyst: LLM call failed: %s", exc)
        return None

    text = getattr(resp, "content", None) or ""
    if not text:
        return None

    # 容错：LLM 可能用 ```json ... ``` 包起来，先剥离。
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        LOGGER.warning("news_analyst: LLM returned non-JSON: %r", text[:200])
        return None

    direction = str(data.get("direction", "")).lower()
    if direction not in {"long", "short", "none"}:
        return None
    try:
        confidence = float(data.get("confidence", 0.0))
    except (TypeError, ValueError):
        confidence = 0.0
    return _Verdict(
        direction=direction,
        confidence=max(0.0, min(1.0, confidence)),
        entry=_safe_float(data.get("entry")),
        stop=_safe_float(data.get("stop")),
        target=_safe_float(data.get("target")),
        reason=str(data.get("reason", ""))[:500],
    )


def _format_candles_section(candles_by_tf: dict[str, tuple[Candle, ...]]) -> str:
    """说明：把多 timeframe K 线序列化成紧凑可读文本喂给 LLM。"""
    if not candles_by_tf:
        return "Candles: (none available)"
    parts = ["Candles (oldest first, format: open_time_iso O/H/L/C V):"]
    for tf, candles in candles_by_tf.items():
        if not candles:
            parts.append(f"  [{tf}]: (no data)")
            continue
        parts.append(f"  [{tf}]:")
        # 按时间正序展示（cache 默认倒序）
        for candle in sorted(candles, key=lambda c: c.open_time_ms):
            from datetime import datetime, timezone
            t_iso = datetime.fromtimestamp(
                candle.open_time_ms / 1000, tz=timezone.utc,
            ).strftime("%Y-%m-%d %H:%M")
            parts.append(
                f"    {t_iso} {candle.open:.2f}/{candle.high:.2f}/"
                f"{candle.low:.2f}/{candle.close:.2f} V={candle.volume:.0f}"
            )
    return "\n".join(parts)


def _safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ── Gating ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _GateOutcome:
    pass_check: bool
    skip_reason: str  # "" if pass


def _gate(
    verdict: _Verdict,
    *,
    config: NewsAnalystConfig,
    current_price: float | None,
) -> _GateOutcome:
    """说明：纯函数规则门。verdict→是否放行下单。"""
    if verdict.direction == "none":
        return _GateOutcome(False, "direction=none")
    if verdict.confidence < config.min_confidence:
        return _GateOutcome(False, f"confidence {verdict.confidence:.2f} < {config.min_confidence}")
    if verdict.stop is None:
        return _GateOutcome(False, "missing stop")
    if verdict.entry is None:
        return _GateOutcome(False, "missing entry")
    # 距当前价过远，意味着 LLM 可能在乱编价格。
    if current_price is not None and current_price > 0:
        deviation_pct = abs(verdict.entry - current_price) / current_price * 100.0
        if deviation_pct > config.max_entry_distance_pct:
            return _GateOutcome(
                False, f"entry {verdict.entry} off mark by {deviation_pct:.2f}% > {config.max_entry_distance_pct}%",
            )
    return _GateOutcome(True, "")


# ── Service ──────────────────────────────────────────────────────────────

class NewsAnalyst:
    """说明：MVP 顶层服务。NewsService 顶部头条变化时调 on_top_changed。"""

    def __init__(
        self,
        *,
        config: NewsAnalystConfig,
        decision_store: NewsDecisionStore,
        trade_store: TradeStore,
        llm_chat: LLMChatFn,
        current_price_provider: Callable[[str], Optional[float]] | None = None,
        candle_provider: CandleProvider | None = None,
    ) -> None:
        self.config = config
        self.decision_store = decision_store
        self.trade_store = trade_store
        self.llm_chat = llm_chat
        self.current_price_provider = current_price_provider
        # candle_provider(instrument_key, interval, limit) → Candle 元组。
        # 可注入 None；缺失时 verify 仍能运行但 prompt 中 Candles=(none available)
        self.candle_provider = candle_provider
        # Cooldown: (instrument_key, direction) → last_open_ms
        # 内存即可，重启清零（重启后 N 分钟内偶尔重开同向单可以接受）。
        self._last_open_ms: dict[tuple[str, str], int] = {}

    async def on_top_changed(self, item: NewsItem) -> tuple[NewsDecision, ...]:
        """说明：顶部头条变了 → 对 universe 中所有命中的品种各跑一次决策流。

        返回值是这条新闻产生的所有决策（每个命中品种一条；全没命中也返回一条
        filter_miss 决策记到第一个品种上，便于事后看哪些新闻被丢了）。
        """
        now_ms = int(time.time() * 1000)
        # 找到所有命中的 universe entry
        hits = tuple(
            entry for entry in self.config.universe
            if matches_aliases(item, entry.aliases)
        )
        if not hits:
            decision = NewsDecision(
                news_url=item.url, news_title=item.title,
                instrument_key=self.config.universe[0].instrument_key if self.config.universe else "",
                step="filter_miss", direction=None, confidence=None,
                entry_price=None, stop_price=None, target_price=None,
                reason="no universe alias matched", trade_id=None, created_at_ms=now_ms,
            )
            self.decision_store.insert(decision)
            return (decision,)
        decisions: list[NewsDecision] = []
        for entry in hits:
            decision = await self._process_one(item, entry, now_ms)
            decisions.append(decision)
        return tuple(decisions)

    def _fetch_candles(self, instrument_key: str) -> dict[str, tuple[Candle, ...]]:
        """说明：从 candle_provider 拉多 timeframe K 线，失败时返回空 dict。"""
        if self.candle_provider is None:
            return {}
        result: dict[str, tuple[Candle, ...]] = {}
        for tf in _VERIFY_TIMEFRAMES:
            try:
                candles = self.candle_provider(instrument_key, tf, _VERIFY_CANDLE_LIMIT)
            except Exception:  # noqa: BLE001
                LOGGER.warning(
                    "news_analyst: candle fetch failed for %s %s",
                    instrument_key, tf, exc_info=True,
                )
                candles = ()
            result[tf] = tuple(candles or ())
        return result

    async def _process_one(
        self, item: NewsItem, entry: NewsUniverseEntry, now_ms: int,
    ) -> NewsDecision:
        """说明：对单个命中品种跑 verify → gate → 下单。"""
        instrument_key = entry.instrument_key
        candles_by_tf = self._fetch_candles(instrument_key)

        verdict = await _verify(
            item, instrument_key, self.llm_chat, self.config.llm_timeout_seconds,
            candles_by_tf=candles_by_tf,
        )
        if verdict is None:
            decision = NewsDecision(
                news_url=item.url, news_title=item.title, instrument_key=instrument_key,
                step="llm_error", direction=None, confidence=None,
                entry_price=None, stop_price=None, target_price=None,
                reason="LLM call failed or returned invalid JSON",
                trade_id=None, created_at_ms=now_ms,
            )
            self.decision_store.insert(decision)
            return decision

        current_price = (
            self.current_price_provider(instrument_key) if self.current_price_provider else None
        )
        gate = _gate(verdict, config=self.config, current_price=current_price)
        if not gate.pass_check:
            decision = NewsDecision(
                news_url=item.url, news_title=item.title, instrument_key=instrument_key,
                step="low_confidence" if "confidence" in gate.skip_reason
                     else ("entry_too_far" if "off mark" in gate.skip_reason else "gated"),
                direction=verdict.direction, confidence=verdict.confidence,
                entry_price=verdict.entry, stop_price=verdict.stop, target_price=verdict.target,
                reason=gate.skip_reason, trade_id=None, created_at_ms=now_ms,
            )
            self.decision_store.insert(decision)
            return decision

        # Cooldown 检查：同品种同方向 N 分钟内不重复开。
        cooldown_ms = self.config.cooldown_minutes * 60 * 1000
        cooldown_key = (instrument_key, verdict.direction)
        last_open_ms = self._last_open_ms.get(cooldown_key)
        if cooldown_ms > 0 and last_open_ms is not None and (now_ms - last_open_ms) < cooldown_ms:
            remaining_min = (cooldown_ms - (now_ms - last_open_ms)) / 60_000
            decision = NewsDecision(
                news_url=item.url, news_title=item.title, instrument_key=instrument_key,
                step="cooldown",
                direction=verdict.direction, confidence=verdict.confidence,
                entry_price=verdict.entry, stop_price=verdict.stop, target_price=verdict.target,
                reason=f"cooldown {remaining_min:.1f}min remaining for {verdict.direction}",
                trade_id=None, created_at_ms=now_ms,
            )
            self.decision_store.insert(decision)
            return decision

        try:
            trade = self.trade_store.create_trade(
                instrument_key=instrument_key,
                direction=TradeDirection.LONG if verdict.direction == "long" else TradeDirection.SHORT,
                size=self.config.default_size,
                intent_price=None,
                stop_price=verdict.stop,
                target_prices=(verdict.target,) if verdict.target is not None else (),
                reasoning_text=f"news_analyst: {item.title} | {verdict.reason}",
                session_id=None,
                snapshot_id=None,
                market_kind="news_driven",
                status=TradeStatus.PLANNED,
            )
            trade_id = trade.id
        except ValueError as exc:
            decision = NewsDecision(
                news_url=item.url, news_title=item.title, instrument_key=instrument_key,
                step="llm_error", direction=verdict.direction, confidence=verdict.confidence,
                entry_price=verdict.entry, stop_price=verdict.stop, target_price=verdict.target,
                reason=f"create_trade failed: {exc}",
                trade_id=None, created_at_ms=now_ms,
            )
            self.decision_store.insert(decision)
            return decision

        decision = NewsDecision(
            news_url=item.url, news_title=item.title, instrument_key=instrument_key,
            step="opened", direction=verdict.direction, confidence=verdict.confidence,
            entry_price=verdict.entry, stop_price=verdict.stop, target_price=verdict.target,
            reason=verdict.reason, trade_id=trade_id, created_at_ms=now_ms,
        )
        self.decision_store.insert(decision)
        # 标记 cooldown
        self._last_open_ms[(instrument_key, verdict.direction)] = now_ms
        LOGGER.info(
            "news_analyst: opened paper trade #%s on %s direction=%s confidence=%.2f",
            trade_id, instrument_key, verdict.direction, verdict.confidence,
        )
        return decision
