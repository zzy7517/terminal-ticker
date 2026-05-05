"""news_analyst MVP 单元测试 + e2e 烟雾测。"""
import asyncio
import tempfile
import time
import unittest
from dataclasses import dataclass
from pathlib import Path

from mytradebot.config import NewsAnalystConfig, NewsUniverseEntry
from mytradebot.news.types import NewsItem
from mytradebot.news_analyst.service import (
    NewsAnalyst,
    NewsDecisionStore,
    matches_aliases,
)
from mytradebot.trading.models import TradeStatus
from mytradebot.trading.store import TradeStore


@dataclass
class _FakeChatResponse:
    content: str


def _make_item(title: str, summary: str = "", url: str = "https://x/") -> NewsItem:
    now_ms = int(time.time() * 1000)
    return NewsItem(
        url=url,
        source="reuters",
        title=title,
        summary=summary,
        published_at_ms=now_ms,
        fetched_at_ms=now_ms,
        keywords=(),
    )


class FilterTests(unittest.TestCase):
    """子串过滤行为。"""

    aliases = ("S&P 500", "S&P500", "SPX", "标普", "S&P", "SPY")

    def test_hit_in_title_word_boundary(self) -> None:
        item = _make_item("Fed cuts rates, S&P 500 surges to record high")
        self.assertTrue(matches_aliases(item, self.aliases))

    def test_hit_in_summary(self) -> None:
        item = _make_item("Markets rally", "SPY ETF inflows hit 2026 high")
        self.assertTrue(matches_aliases(item, self.aliases))

    def test_chinese_alias_substring(self) -> None:
        item = _make_item("美股全线收涨，标普指数创新高")
        self.assertTrue(matches_aliases(item, self.aliases))

    def test_word_boundary_avoids_false_positive(self) -> None:
        # "espy" 包含 "spy" 子串，但 word boundary 应避免命中。
        item = _make_item("Reporters espy a peculiar trend at the espy gala")
        self.assertFalse(matches_aliases(item, ("SPY",)))

    def test_no_hit_returns_false(self) -> None:
        item = _make_item("Cricket: India beats Australia in Sydney")
        self.assertFalse(matches_aliases(item, self.aliases))

    def test_empty_aliases(self) -> None:
        item = _make_item("Anything")
        self.assertFalse(matches_aliases(item, ()))


class NewsAnalystServiceTests(unittest.TestCase):
    """end-to-end: filter → fake LLM → gate → trade_store。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.trade_db_path = Path(self._tmp.name) / "trades.sqlite3"
        self.trade_store = TradeStore(self.trade_db_path)
        self.decision_store = NewsDecisionStore(self.trade_db_path)
        self.config = NewsAnalystConfig(
            enabled=True,
            universe=(
                NewsUniverseEntry(
                    instrument_key="alpaca:SPY",
                    aliases=("SPY", "S&P 500", "标普"),
                ),
            ),
            min_confidence=0.7,
            max_entry_distance_pct=0.5,
            default_size=1.0,
            llm_timeout_seconds=5.0,
        )

    def _run(self, coro):
        return asyncio.get_event_loop().run_until_complete(coro) if False else asyncio.run(coro)

    def _make_analyst(
        self,
        *,
        llm_response: str | None = None,
        llm_raises: Exception | None = None,
        current_price: float | None = 500.0,
    ) -> NewsAnalyst:
        async def fake_chat(messages):
            if llm_raises is not None:
                raise llm_raises
            return _FakeChatResponse(content=llm_response or "")

        return NewsAnalyst(
            config=self.config,
            decision_store=self.decision_store,
            trade_store=self.trade_store,
            llm_chat=fake_chat,
            current_price_provider=lambda key: current_price,
        )

    def test_filter_miss_no_llm_no_trade(self) -> None:
        analyst = self._make_analyst(llm_response="UNREACHED")
        item = _make_item("Cricket: India beats Australia in Sydney")
        decisions = self._run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.step, "filter_miss")
        self.assertIsNone(decision.trade_id)
        # 落库
        rows = self.decision_store.recent()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["step"], "filter_miss")

    def test_llm_error_skips_trade(self) -> None:
        analyst = self._make_analyst(llm_raises=RuntimeError("api boom"))
        item = _make_item("Fed cuts SPY rallies hard")
        decisions = self._run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.step, "llm_error")
        self.assertIsNone(decision.trade_id)

    def test_low_confidence_blocks(self) -> None:
        analyst = self._make_analyst(
            llm_response='{"direction":"long","confidence":0.3,"entry":500,'
                         '"stop":495,"target":510,"reason":"weak signal"}',
        )
        item = _make_item("S&P 500 unchanged after some random Fed comment")
        decisions = self._run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.step, "low_confidence")
        self.assertEqual(decision.direction, "long")
        self.assertIsNone(decision.trade_id)

    def test_entry_too_far_blocks(self) -> None:
        # current_price=500, entry=520 → 4% off mark > 0.5% threshold
        analyst = self._make_analyst(
            llm_response='{"direction":"long","confidence":0.9,"entry":520,'
                         '"stop":515,"target":530,"reason":"strong signal"}',
            current_price=500.0,
        )
        item = _make_item("Fed surprise rate cut, SPY explodes")
        decisions = self._run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.step, "entry_too_far")
        self.assertIsNone(decision.trade_id)

    def test_happy_path_opens_trade(self) -> None:
        analyst = self._make_analyst(
            llm_response='{"direction":"long","confidence":0.85,"entry":500.5,'
                         '"stop":495,"target":510,"reason":"Fed dovish"}',
            current_price=500.0,
        )
        item = _make_item("Fed cuts rates 50bp, SPY futures jump 2%")
        decisions = self._run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.step, "opened")
        self.assertEqual(decision.direction, "long")
        self.assertAlmostEqual(decision.confidence or 0, 0.85)
        self.assertIsNotNone(decision.trade_id)
        # 真的写进 trades 表了
        trade = self.trade_store.get_trade(decision.trade_id)
        self.assertIsNotNone(trade)
        self.assertEqual(trade.status, TradeStatus.PLANNED)
        self.assertEqual(trade.market_kind, "news_driven")
        self.assertIn("news_analyst", trade.reasoning_text)

    def test_llm_returns_code_fenced_json(self) -> None:
        # 真实 LLM 经常用 ```json ``` 包起来
        wrapped = (
            '```json\n'
            '{"direction":"short","confidence":0.8,"entry":499.5,'
            '"stop":502,"target":495,"reason":"hawkish surprise"}\n'
            '```'
        )
        analyst = self._make_analyst(llm_response=wrapped, current_price=500.0)
        item = _make_item("Fed signals more hikes, SPY tumbles")
        decisions = self._run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.step, "opened")
        self.assertEqual(decision.direction, "short")

    def test_direction_none_blocks(self) -> None:
        analyst = self._make_analyst(
            llm_response='{"direction":"none","confidence":0.9,"entry":null,'
                         '"stop":null,"target":null,"reason":"not market-moving"}',
        )
        item = _make_item("Trump tweets about S&P 500 historical performance")
        decisions = self._run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.step, "gated")
        self.assertEqual(decision.direction, "none")
        self.assertIsNone(decision.trade_id)

    def test_garbage_llm_output(self) -> None:
        analyst = self._make_analyst(llm_response="I am thinking very hard about this...")
        item = _make_item("S&P 500 something happened")
        decisions = self._run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        decision = decisions[0]
        self.assertEqual(decision.step, "llm_error")
        self.assertIsNone(decision.trade_id)


class CooldownTests(unittest.TestCase):
    """同品种同方向 N 分钟内不重复开。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        path = Path(self._tmp.name) / "trades.sqlite3"
        self.trade_store = TradeStore(path)
        self.decision_store = NewsDecisionStore(path)
        self.config = NewsAnalystConfig(
            enabled=True,
            universe=(NewsUniverseEntry(instrument_key="alpaca:SPY", aliases=("SPY",)),),
            min_confidence=0.7, max_entry_distance_pct=5.0,
            default_size=1.0, llm_timeout_seconds=5.0,
            cooldown_minutes=30,
        )

    def _analyst(self, llm_response: str) -> NewsAnalyst:
        async def fake_chat(messages):
            return _FakeChatResponse(content=llm_response)
        return NewsAnalyst(
            config=self.config, decision_store=self.decision_store,
            trade_store=self.trade_store, llm_chat=fake_chat,
            current_price_provider=lambda key: 500.0,
        )

    def test_second_same_direction_blocked_by_cooldown(self) -> None:
        analyst = self._analyst(
            '{"direction":"long","confidence":0.9,"entry":500,"stop":495,'
            '"target":510,"reason":"strong"}'
        )
        item1 = _make_item("Fed cuts SPY rallies", url="https://x/1")
        d1 = asyncio.run(analyst.on_top_changed(item1))[0]
        self.assertEqual(d1.step, "opened")
        item2 = _make_item("More dovish Fed comments, SPY up", url="https://x/2")
        d2 = asyncio.run(analyst.on_top_changed(item2))[0]
        self.assertEqual(d2.step, "cooldown")
        self.assertIsNone(d2.trade_id)

    def test_opposite_direction_not_blocked(self) -> None:
        # 第一次 long, 第二次 short → cooldown key 不同, 不阻塞
        analyst = self._analyst(
            '{"direction":"long","confidence":0.9,"entry":500,"stop":495,'
            '"target":510,"reason":"strong"}'
        )
        item1 = _make_item("Fed cuts SPY", url="https://x/1")
        asyncio.run(analyst.on_top_changed(item1))

        async def fake_chat_short(messages):
            return _FakeChatResponse(
                '{"direction":"short","confidence":0.9,"entry":500,"stop":505,'
                '"target":490,"reason":"reversal"}'
            )
        analyst.llm_chat = fake_chat_short
        item2 = _make_item("Fed surprise hawkish, SPY tumbles", url="https://x/2")
        d2 = asyncio.run(analyst.on_top_changed(item2))[0]
        self.assertEqual(d2.step, "opened")
        self.assertEqual(d2.direction, "short")

    def test_zero_cooldown_disables_check(self) -> None:
        self.config = NewsAnalystConfig(
            enabled=True,
            universe=(NewsUniverseEntry(instrument_key="alpaca:SPY", aliases=("SPY",)),),
            min_confidence=0.7, max_entry_distance_pct=5.0,
            default_size=1.0, llm_timeout_seconds=5.0,
            cooldown_minutes=0,
        )
        analyst = self._analyst(
            '{"direction":"long","confidence":0.9,"entry":500,"stop":495,'
            '"target":510,"reason":"strong"}'
        )
        item1 = _make_item("SPY 1", url="https://x/1")
        item2 = _make_item("SPY 2", url="https://x/2")
        d1 = asyncio.run(analyst.on_top_changed(item1))[0]
        d2 = asyncio.run(analyst.on_top_changed(item2))[0]
        self.assertEqual(d1.step, "opened")
        self.assertEqual(d2.step, "opened")


class MultiUniverseTests(unittest.TestCase):
    """新闻同时命中多个品种时，每个品种独立跑决策流。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        path = Path(self._tmp.name) / "trades.sqlite3"
        self.trade_store = TradeStore(path)
        self.decision_store = NewsDecisionStore(path)
        self.config = NewsAnalystConfig(
            enabled=True,
            universe=(
                NewsUniverseEntry(instrument_key="alpaca:SPY", aliases=("S&P 500", "SPY")),
                NewsUniverseEntry(instrument_key="alpaca:QQQ", aliases=("Nasdaq", "QQQ")),
                NewsUniverseEntry(instrument_key="alpaca:GLD", aliases=("gold", "黄金")),
            ),
            min_confidence=0.7, max_entry_distance_pct=0.5,
            default_size=1.0, llm_timeout_seconds=5.0,
        )

    def test_news_hits_two_universe_entries_independent_decisions(self) -> None:
        # 同时提到 S&P 500 和 Nasdaq → SPY 和 QQQ 都命中，GLD 不命中
        # SPY: LLM 给高置信度 long → 开单
        # QQQ: LLM 给低置信度 → 拦
        async def fake_chat(messages):
            user_msg = next(m["content"] for m in messages if m["role"] == "user")
            if "alpaca:SPY" in user_msg:
                return _FakeChatResponse(
                    '{"direction":"long","confidence":0.9,"entry":500,"stop":495,'
                    '"target":510,"reason":"strong"}'
                )
            if "alpaca:QQQ" in user_msg:
                return _FakeChatResponse(
                    '{"direction":"long","confidence":0.4,"entry":400,"stop":395,'
                    '"target":410,"reason":"weak"}'
                )
            return _FakeChatResponse('{"direction":"none","confidence":0,"entry":null,'
                                     '"stop":null,"target":null,"reason":"n/a"}')

        analyst = NewsAnalyst(
            config=self.config, decision_store=self.decision_store,
            trade_store=self.trade_store, llm_chat=fake_chat,
            current_price_provider=lambda key: 500.0 if key == "alpaca:SPY" else 400.0,
        )
        item = _make_item("Fed cuts rates: S&P 500 and Nasdaq surge")
        decisions = asyncio.run(analyst.on_top_changed(item))
        # 两个品种命中，所以应该有 2 条 decision
        self.assertEqual(len(decisions), 2)
        spy = next(d for d in decisions if d.instrument_key == "alpaca:SPY")
        qqq = next(d for d in decisions if d.instrument_key == "alpaca:QQQ")
        self.assertEqual(spy.step, "opened")
        self.assertIsNotNone(spy.trade_id)
        self.assertEqual(qqq.step, "low_confidence")
        self.assertIsNone(qqq.trade_id)

    def test_no_universe_hit_records_filter_miss_once(self) -> None:
        async def fake_chat(messages):
            return _FakeChatResponse("UNREACHED")

        analyst = NewsAnalyst(
            config=self.config, decision_store=self.decision_store,
            trade_store=self.trade_store, llm_chat=fake_chat,
        )
        item = _make_item("Cricket: India beats Australia in Sydney")
        decisions = asyncio.run(analyst.on_top_changed(item))
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0].step, "filter_miss")


if __name__ == "__main__":
    unittest.main()
