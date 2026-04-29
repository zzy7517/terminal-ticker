"""文件用途：基于 OHLCV 的 regime/context filter 和离线信号验证。"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from statistics import mean, pstdev
from typing import Literal

from .price_action import Candle

SignalSide = Literal["long", "short", "flat"]
RegimeLabel = Literal["trend", "range", "high_vol", "low_vol", "transition", "unclear"]


@dataclass(frozen=True)
class StrategyConfig:
    """说明：封装离线研究策略的可调参数。"""

    window: int = 48
    horizon: int = 6
    fast_span: int = 8
    slow_span: int = 21
    trend_threshold: float = 0.65
    efficiency_threshold: float = 0.28
    min_confidence: float = 0.58
    high_volatility_atr: float = 0.025
    low_volatility_atr: float = 0.004
    range_edge_threshold: float = 0.72


@dataclass(frozen=True)
class RegimeFeatures:
    """说明：描述一段 K 线的结构化上下文。"""

    close_return: float
    range_efficiency: float
    atr_percent: float
    realized_volatility: float
    trend_score: float
    position_in_range: float
    volume_ratio: float
    latest_close: float
    recent_high: float
    recent_low: float


@dataclass(frozen=True)
class StrategySignal:
    """说明：封装一个可回测的方向信号。"""

    side: SignalSide
    regime: RegimeLabel
    confidence: float
    reason: str
    features: RegimeFeatures


@dataclass(frozen=True)
class TradeOutcome:
    """说明：封装一个历史时点的预测和后续验证结果。"""

    signal_time_ms: int
    side: SignalSide
    regime: RegimeLabel
    confidence: float
    entry_price: float
    exit_price: float
    forward_return: float
    strategy_return: float


@dataclass(frozen=True)
class BacktestMetrics:
    """说明：封装一段回测结果。"""

    observations: int
    trades: int
    long_trades: int
    short_trades: int
    flat_count: int
    hit_rate: float
    average_trade_return: float
    total_return: float
    max_drawdown: float
    sharpe_like: float
    profit_factor: float

    def to_dict(self) -> dict[str, float | int]:
        """说明：转换成脚本和 API 容易序列化的结果。"""
        return {
            "observations": self.observations,
            "trades": self.trades,
            "long_trades": self.long_trades,
            "short_trades": self.short_trades,
            "flat_count": self.flat_count,
            "hit_rate": self.hit_rate,
            "average_trade_return": self.average_trade_return,
            "total_return": self.total_return,
            "max_drawdown": self.max_drawdown,
            "sharpe_like": self.sharpe_like,
            "profit_factor": self.profit_factor,
        }


@dataclass(frozen=True)
class SplitEvaluation:
    """说明：封装前半段调参、后半段验证的研究结果。"""

    config: StrategyConfig
    train: BacktestMetrics
    validation: BacktestMetrics


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    """说明：把数值限制在固定区间。"""
    return max(low, min(high, value))


def _ema(values: list[float], span: int) -> float:
    """说明：计算最后一个 EMA 值。"""
    if not values:
        return 0.0
    alpha = 2 / (span + 1)
    current = values[0]
    for value in values[1:]:
        current = alpha * value + (1 - alpha) * current
    return current


def _ordered(candles: tuple[Candle, ...] | list[Candle]) -> tuple[Candle, ...]:
    """说明：按开盘时间排序 K 线。"""
    return tuple(sorted(candles, key=lambda candle: candle.open_time_ms))


def compute_regime_features(
    candles: tuple[Candle, ...] | list[Candle],
    *,
    fast_span: int = 8,
    slow_span: int = 21,
) -> RegimeFeatures:
    """说明：从一段 K 线中提取 regime/context filter 需要的事实。"""
    ordered = _ordered(candles)
    if len(ordered) < 3:
        raise ValueError("at least 3 candles are required")

    closes = [candle.close for candle in ordered]
    highs = [candle.high for candle in ordered]
    lows = [candle.low for candle in ordered]
    volumes = [candle.volume for candle in ordered]
    returns = [
        (closes[index] - closes[index - 1]) / closes[index - 1]
        for index in range(1, len(closes))
        if closes[index - 1] != 0
    ]
    latest_close = closes[-1]
    close_return = (latest_close - closes[0]) / closes[0] if closes[0] else 0.0
    total_path = sum(abs(item) for item in returns)
    range_efficiency = abs(close_return) / total_path if total_path else 0.0
    true_ranges = []
    for index, candle in enumerate(ordered):
        previous_close = ordered[index - 1].close if index > 0 else candle.close
        true_ranges.append(
            max(
                candle.high - candle.low,
                abs(candle.high - previous_close),
                abs(candle.low - previous_close),
            )
        )
    atr = mean(true_ranges)
    atr_percent = atr / latest_close if latest_close else 0.0
    realized_volatility = pstdev(returns) if len(returns) > 1 else 0.0
    fast = _ema(closes, min(len(closes), fast_span))
    slow = _ema(closes, min(len(closes), slow_span))
    normalizer = max(atr_percent, 0.000001)
    trend_score = ((fast - slow) / latest_close) / normalizer if latest_close else 0.0
    recent_high = max(highs)
    recent_low = min(lows)
    price_range = max(recent_high - recent_low, abs(latest_close) * 0.000001, 0.000001)
    position_in_range = (latest_close - recent_low) / price_range
    average_volume = mean(volumes)
    volume_ratio = volumes[-1] / average_volume if average_volume else 1.0
    return RegimeFeatures(
        close_return=close_return,
        range_efficiency=range_efficiency,
        atr_percent=atr_percent,
        realized_volatility=realized_volatility,
        trend_score=trend_score,
        position_in_range=_clamp(position_in_range),
        volume_ratio=volume_ratio,
        latest_close=latest_close,
        recent_high=recent_high,
        recent_low=recent_low,
    )


def classify_regime(features: RegimeFeatures, config: StrategyConfig = StrategyConfig()) -> RegimeLabel:
    """说明：把结构化事实归类成交易环境，而不是直接归类成买卖点。"""
    directional = (
        abs(features.trend_score) >= config.trend_threshold
        and features.range_efficiency >= config.efficiency_threshold
    )
    if directional:
        return "trend"
    if features.atr_percent >= config.high_volatility_atr:
        return "high_vol"
    if features.atr_percent <= config.low_volatility_atr and features.range_efficiency < config.efficiency_threshold:
        return "low_vol"
    if features.range_efficiency < config.efficiency_threshold:
        return "range"
    return "transition"


def generate_signal(
    candles: tuple[Candle, ...] | list[Candle],
    config: StrategyConfig = StrategyConfig(),
) -> StrategySignal:
    """说明：从已知 K 线中生成 long/short/flat 信号。"""
    ordered = _ordered(candles)
    if len(ordered) < config.window:
        raise ValueError(f"at least {config.window} candles are required")
    window = ordered[-config.window :]
    features = compute_regime_features(
        window,
        fast_span=config.fast_span,
        slow_span=config.slow_span,
    )
    regime = classify_regime(features, config)
    edge_distance = abs(features.position_in_range - 0.5) * 2
    reversion_confidence = _clamp(
        0.48 * edge_distance
        + 0.34 * (1 - features.range_efficiency)
        + 0.18 * _clamp((1.25 - features.volume_ratio) / 1.25)
    )
    if regime in {"range", "low_vol"} and reversion_confidence >= config.min_confidence:
        if features.position_in_range >= config.range_edge_threshold:
            return StrategySignal(
                side="short",
                regime=regime,
                confidence=reversion_confidence,
                reason=(
                    f"{regime}: price near range high "
                    f"({features.position_in_range:.2f}) with low efficiency "
                    f"{features.range_efficiency:.2f}"
                ),
                features=features,
            )
        if features.position_in_range <= 1 - config.range_edge_threshold:
            return StrategySignal(
                side="long",
                regime=regime,
                confidence=reversion_confidence,
                reason=(
                    f"{regime}: price near range low "
                    f"({features.position_in_range:.2f}) with low efficiency "
                    f"{features.range_efficiency:.2f}"
                ),
                features=features,
            )

    trend_strength = _clamp((abs(features.trend_score) - config.trend_threshold) / 1.8)
    efficiency_strength = _clamp(
        (features.range_efficiency - config.efficiency_threshold) / max(1 - config.efficiency_threshold, 0.01)
    )
    volume_strength = _clamp((features.volume_ratio - 0.8) / 0.7)
    location_bonus = 0.0
    if features.trend_score > 0 and features.position_in_range >= 0.65:
        location_bonus = 0.12
    if features.trend_score < 0 and features.position_in_range <= 0.35:
        location_bonus = 0.12
    directional_confidence = _clamp(
        0.46 * trend_strength
        + 0.32 * efficiency_strength
        + 0.10 * volume_strength
        + location_bonus
    )
    if regime in {"range", "low_vol"}:
        directional_confidence *= 0.55
    if regime == "high_vol" and features.range_efficiency < config.efficiency_threshold:
        directional_confidence *= 0.65

    side: SignalSide = "flat"
    if directional_confidence >= config.min_confidence:
        side = "long" if features.trend_score > 0 else "short"

    if side == "flat":
        confidence = _clamp(1 - directional_confidence)
        reason = (
            f"{regime}: directional confidence {directional_confidence:.2f} "
            f"below threshold {config.min_confidence:.2f}"
        )
    else:
        confidence = directional_confidence
        reason = (
            f"{regime}: trend_score={features.trend_score:.2f}, "
            f"efficiency={features.range_efficiency:.2f}, "
            f"atr={features.atr_percent:.3f}, volume={features.volume_ratio:.2f}"
        )
    return StrategySignal(
        side=side,
        regime=regime,
        confidence=confidence,
        reason=reason,
        features=features,
    )


def walk_forward_outcomes(
    candles: tuple[Candle, ...] | list[Candle],
    config: StrategyConfig = StrategyConfig(),
) -> tuple[TradeOutcome, ...]:
    """说明：只用历史窗口生成信号，并用之后的 K 线验证。"""
    ordered = _ordered(candles)
    outcomes: list[TradeOutcome] = []
    max_index = len(ordered) - config.horizon
    for index in range(config.window, max_index):
        history = ordered[index - config.window : index]
        signal = generate_signal(history, config)
        entry = history[-1].close
        exit_ = ordered[index + config.horizon - 1].close
        forward_return = (exit_ - entry) / entry if entry else 0.0
        if signal.side == "long":
            strategy_return = forward_return
        elif signal.side == "short":
            strategy_return = -forward_return
        else:
            strategy_return = 0.0
        outcomes.append(
            TradeOutcome(
                signal_time_ms=history[-1].open_time_ms,
                side=signal.side,
                regime=signal.regime,
                confidence=signal.confidence,
                entry_price=entry,
                exit_price=exit_,
                forward_return=forward_return,
                strategy_return=strategy_return,
            )
        )
    return tuple(outcomes)


def evaluate_outcomes(outcomes: tuple[TradeOutcome, ...] | list[TradeOutcome]) -> BacktestMetrics:
    """说明：把逐笔验证结果汇总成稳定性指标。"""
    items = tuple(outcomes)
    active = tuple(item for item in items if item.side != "flat")
    active_returns = [item.strategy_return for item in active]
    positive = [item.strategy_return for item in active if item.strategy_return > 0]
    negative = [item.strategy_return for item in active if item.strategy_return < 0]
    equity = 1.0
    peak = 1.0
    max_drawdown = 0.0
    for item in items:
        equity *= 1 + item.strategy_return
        peak = max(peak, equity)
        drawdown = (peak - equity) / peak if peak else 0.0
        max_drawdown = max(max_drawdown, drawdown)
    observations = len(items)
    trades = len(active)
    average_trade_return = mean(active_returns) if active_returns else 0.0
    volatility = pstdev(active_returns) if len(active_returns) > 1 else 0.0
    sharpe_like = average_trade_return / volatility * math.sqrt(trades) if volatility else 0.0
    gains = sum(positive)
    losses = abs(sum(negative))
    profit_factor = (gains / losses) if losses else (999.0 if gains > 0 else 0.0)
    return BacktestMetrics(
        observations=observations,
        trades=trades,
        long_trades=sum(1 for item in active if item.side == "long"),
        short_trades=sum(1 for item in active if item.side == "short"),
        flat_count=sum(1 for item in items if item.side == "flat"),
        hit_rate=(len(positive) / trades) if trades else 0.0,
        average_trade_return=average_trade_return,
        total_return=equity - 1,
        max_drawdown=max_drawdown,
        sharpe_like=sharpe_like,
        profit_factor=profit_factor,
    )


def optimize_strategy(
    candles: tuple[Candle, ...] | list[Candle],
    base_config: StrategyConfig = StrategyConfig(),
) -> tuple[StrategyConfig, BacktestMetrics]:
    """说明：只在训练段上搜索几个保守阈值。"""
    best_config = base_config
    best_metrics = evaluate_outcomes(walk_forward_outcomes(candles, base_config))
    best_score = _score_metrics(best_metrics)
    for min_confidence in (0.48, 0.54, 0.60, 0.66):
        for trend_threshold in (0.45, 0.65, 0.85, 1.05):
            for efficiency_threshold in (0.18, 0.28, 0.38):
                candidate = replace(
                    base_config,
                    min_confidence=min_confidence,
                    trend_threshold=trend_threshold,
                    efficiency_threshold=efficiency_threshold,
                )
                metrics = evaluate_outcomes(walk_forward_outcomes(candles, candidate))
                score = _score_metrics(metrics)
                if score > best_score:
                    best_config = candidate
                    best_metrics = metrics
                    best_score = score
    return best_config, best_metrics


def split_optimize_validate(
    candles: tuple[Candle, ...] | list[Candle],
    base_config: StrategyConfig = StrategyConfig(),
) -> SplitEvaluation:
    """说明：用前半段选择阈值，再用后半段做样本外验证。"""
    ordered = _ordered(candles)
    minimum = base_config.window * 2 + base_config.horizon * 2
    if len(ordered) < minimum:
        raise ValueError(f"at least {minimum} candles are required")
    midpoint = len(ordered) // 2
    train_candles = ordered[:midpoint]
    validation_start = max(0, midpoint - base_config.window)
    validation_candles = ordered[validation_start:]
    config, train_metrics = optimize_strategy(train_candles, base_config)
    validation_metrics = evaluate_outcomes(walk_forward_outcomes(validation_candles, config))
    return SplitEvaluation(config=config, train=train_metrics, validation=validation_metrics)


def _score_metrics(metrics: BacktestMetrics) -> float:
    """说明：给训练段指标打分，避免只追求交易次数或单一收益。"""
    if metrics.trades < 8:
        return -1_000 + metrics.trades
    coverage = metrics.trades / metrics.observations if metrics.observations else 0.0
    coverage_penalty = abs(coverage - 0.35) * 0.4
    return (
        metrics.total_return
        + metrics.average_trade_return * 10
        + metrics.hit_rate * 0.35
        + metrics.sharpe_like * 0.08
        - metrics.max_drawdown * 1.2
        - coverage_penalty
    )
