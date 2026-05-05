"""文件用途：news_analyst 模块入口，导出 NewsAnalyst 服务和决策类型。

这一模块串起 NewsService 抓到的最新头条与 LLM/paper trading：
1) 当 NewsService 顶部新闻变了，调 NewsAnalyst.on_top_changed(item)
2) 子串过滤 (alias 命中) → 命中才喂给 LLM
3) LLM 给 {direction, confidence, entry, stop, target} JSON
4) 规则门通过 → TradeStore.create_trade（市价 paper trade）
5) 决策结果（不论是否下单）落库到 news_decisions 表，便于事后复盘
"""
from .service import NewsAnalyst, NewsDecision, NewsDecisionStore

__all__ = ["NewsAnalyst", "NewsDecision", "NewsDecisionStore"]
