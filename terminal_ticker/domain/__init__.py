"""文件用途：terminal_ticker/domain/__init__.py 对应的后端模块。"""
from __future__ import annotations

from .price_action import Candle
from .quotes import QuoteState
from .strategy import (
    BacktestMetrics,
    RegimeFeatures,
    SplitEvaluation,
    StrategyConfig,
    StrategySignal,
    TradeOutcome,
    classify_regime,
    compute_regime_features,
    evaluate_outcomes,
    generate_signal,
    optimize_strategy,
    split_optimize_validate,
    walk_forward_outcomes,
)

__all__ = [
    "BacktestMetrics",
    "Candle",
    "RegimeFeatures",
    "QuoteState",
    "SplitEvaluation",
    "StrategyConfig",
    "StrategySignal",
    "TradeOutcome",
    "classify_regime",
    "compute_regime_features",
    "evaluate_outcomes",
    "generate_signal",
    "optimize_strategy",
    "split_optimize_validate",
    "walk_forward_outcomes",
]
