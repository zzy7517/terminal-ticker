"""news_analyst MVP 单元测试 + e2e 烟雾测。"""
import asyncio
import tempfile
import time
import unittest
from dataclasses import dataclass
from pathlib import Path

from mytradebot.config import NewsAnalystConfig
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
            instrument_key="alpaca:SPY",
            aliases=("SPY", "S&P 500", "标普"),
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
        decision = self._run(analyst.on_top_changed(item))
        self.assertEqual(decision.step, "filter_miss")
        self.assertIsNone(decision.trade_id)
        # 落库
        rows = self.decision_store.recent()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["step"], "filter_miss")

    def test_llm_error_skips_trade(self) -> None:
        analyst = self._make_analyst(llm_raises=RuntimeError("api boom"))
        item = _make_item("Fed cuts SPY rallies hard")
        decision = self._run(analyst.on_top_changed(item))
        self.assertEqual(decision.step, "llm_error")
        self.assertIsNone(decision.trade_id)

    def test_low_confidence_blocks(self) -> None:
        analyst = self._make_analyst(
            llm_response='{"direction":"long","confidence":0.3,"entry":500,'
                         '"stop":495,"target":510,"reason":"weak signal"}',
        )
        item = _make_item("S&P 500 unchanged after some random Fed comment")
        decision = self._run(analyst.on_top_changed(item))
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
        decision = self._run(analyst.on_top_changed(item))
        self.assertEqual(decision.step, "entry_too_far")
        self.assertIsNone(decision.trade_id)

    def test_happy_path_opens_trade(self) -> None:
        analyst = self._make_analyst(
            llm_response='{"direction":"long","confidence":0.85,"entry":500.5,'
                         '"stop":495,"target":510,"reason":"Fed dovish"}',
            current_price=500.0,
        )
        item = _make_item("Fed cuts rates 50bp, SPY futures jump 2%")
        decision = self._run(analyst.on_top_changed(item))
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
        decision = self._run(analyst.on_top_changed(item))
        self.assertEqual(decision.step, "opened")
        self.assertEqual(decision.direction, "short")

    def test_direction_none_blocks(self) -> None:
        analyst = self._make_analyst(
            llm_response='{"direction":"none","confidence":0.9,"entry":null,'
                         '"stop":null,"target":null,"reason":"not market-moving"}',
        )
        item = _make_item("Trump tweets about S&P 500 historical performance")
        decision = self._run(analyst.on_top_changed(item))
        self.assertEqual(decision.step, "gated")
        self.assertEqual(decision.direction, "none")
        self.assertIsNone(decision.trade_id)

    def test_garbage_llm_output(self) -> None:
        analyst = self._make_analyst(llm_response="I am thinking very hard about this...")
        item = _make_item("S&P 500 something happened")
        decision = self._run(analyst.on_top_changed(item))
        self.assertEqual(decision.step, "llm_error")
        self.assertIsNone(decision.trade_id)


if __name__ == "__main__":
    unittest.main()
