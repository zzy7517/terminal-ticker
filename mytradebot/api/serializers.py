"""文件用途：把内部数据结构序列化成 WebSocket / REST 响应 payload。"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from ..config import AppConfig
from ..domain.price_action import Candle
from ..domain.quotes import QuoteState
from ..market_data.router import MarketInstrument

THUMBNAIL_CANDLE_LIMIT = 60
DEFAULT_AGENT_USER_PROMPT = "Analyze the current K-line chart and update the watch plan."


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def agent_session_title(instrument: MarketInstrument) -> str:
    return f"{instrument.label} · {instrument.symbol}"


def agent_session_config_kwargs(config: Any) -> dict[str, Any]:
    return {
        "api_mode": config.api_mode,
        "reasoning_effort": config.reasoning_effort,
    }


def sse_event(event: dict[str, Any]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}\n\n"


def instrument_payload(instrument: MarketInstrument, *, default_interval: str) -> dict[str, Any]:
    return {
        "key": instrument.key,
        "symbol": instrument.symbol,
        "label": instrument.label,
        "source": instrument.source,
        "instType": getattr(instrument, "inst_type", None),
        "group": instrument.group,
        "analysisInterval": instrument.analysis_interval or default_interval,
    }


def instrument_catalog_item_payload(
    instrument: MarketInstrument,
    *,
    active_keys: set[str],
) -> dict[str, Any]:
    base_asset = getattr(instrument, "base_asset", instrument.symbol)
    quote_asset = getattr(instrument, "quote_asset", "")
    inst_type = getattr(instrument, "inst_type", None)
    group = getattr(instrument, "group", None)
    category = getattr(instrument, "category", None)
    dex = getattr(instrument, "dex", None)
    if instrument.source == "bitget":
        display_text = f"{inst_type} · {base_asset}/{quote_asset}"
    else:
        prefix = (category or "perp").upper()
        suffix = f" · {dex}" if dex else ""
        display_text = f"{prefix} perp · {base_asset}/{quote_asset}{suffix}"
    return {
        "source": instrument.source,
        "symbol": instrument.symbol,
        "label": instrument.label,
        "instType": inst_type,
        "group": group,
        "category": category,
        "dex": dex,
        "key": instrument.key,
        "displayText": display_text,
        "exists": instrument.key in active_keys,
    }


def candle_payload(candle: Candle) -> dict[str, Any]:
    return {
        "time": candle.open_time_ms // 1000,
        "open": candle.open,
        "high": candle.high,
        "low": candle.low,
        "close": candle.close,
        "volume": candle.volume,
    }


def quote_payload(
    quote: QuoteState,
    *,
    stale_after_seconds: int,
) -> dict[str, Any]:
    return {
        "symbol": quote.symbol,
        "displayName": quote.display_name,
        "price": quote.price,
        "priceLabel": quote.price_label(),
        "change": quote.change,
        "changePercent": quote.change_percent,
        "changeLabel": quote.change_label(),
        "percentLabel": quote.percent_label(),
        "previousClose": quote.previous_close,
        "dayHigh": quote.day_high,
        "dayLow": quote.day_low,
        "volume": quote.volume,
        "volumeLabel": quote.volume_label(),
        "currency": quote.currency,
        "exchange": quote.exchange,
        "status": quote.status,
        "ageLabel": quote.age_label(),
        "stale": quote.is_stale(stale_after_seconds),
        "lastError": quote.last_error,
        "updateCount": quote.update_count,
        "multiTimeframeIntervals": sorted(quote.multi_timeframe_candles.keys()),
        "candles": [candle_payload(candle) for candle in quote.candles],
        "thumbnailCandles": [
            candle_payload(candle)
            for candle in quote.thumbnail_candles[-THUMBNAIL_CANDLE_LIMIT:]
        ],
    }


def serialize_market_state(
    *,
    config: AppConfig,
    instruments: tuple[MarketInstrument, ...],
    quotes: dict[str, QuoteState],
    stream_status: str,
    agent_analyses: dict[str, dict[str, Any]] | None = None,
    open_trades: list[dict[str, Any]] | None = None,
    exchange_positions: list[dict[str, Any]] | None = None,
    exchange_orders: list[dict[str, Any]] | None = None,
    recent_news: list[dict[str, Any]] | None = None,
    news_status: dict[str, Any] | None = None,
) -> dict[str, Any]:
    groups: dict[str, list[str]] = {}
    for instrument in instruments:
        groups.setdefault(instrument.source, []).append(instrument.key)
    return {
        "type": "state",
        "updatedAt": utc_now_iso(),
        "streamStatus": stream_status,
        "config": {
            "analysis": {
                "enabled": config.analysis.enabled,
                "interval": config.analysis.interval,
                "lookback": config.analysis.lookback,
                "pollIntervalSeconds": config.analysis.poll_interval_seconds,
                "staleAfterSeconds": config.analysis.stale_after_seconds,
            },
            "agent": {
                "enabled": config.agent.enabled,
                "provider": config.agent.provider,
                "apiMode": config.agent.api_mode,
                "model": config.agent.model,
                "maxCandles": config.agent.max_candles,
                "reasoningEffort": config.agent.reasoning_effort,
                "providerProfiles": {
                    name: {
                        "enabled": profile.enabled,
                        "models": list(profile.models),
                        "modelEfforts": dict(profile.model_efforts),
                    }
                    for name, profile in config.agent.provider_profiles.items()
                },
            },
            "display": {
                "refreshIntervalMs": config.display.refresh_interval_ms,
                "staleAfterSeconds": config.display.stale_after_seconds,
                "stockPollIntervalSeconds": config.display.stock_poll_interval_seconds,
            },
            "news": {
                "enabled": config.news.enabled,
                "pollIntervalSeconds": config.news.poll_interval_seconds,
                "maxIntervalSeconds": config.news.max_interval_seconds,
                "recentLimit": config.news.recent_limit,
                "reutersUrl": config.news.reuters_url,
                "requestTimeoutSeconds": config.news.request_timeout_seconds,
                "retentionDays": config.news.retention_days,
            },
            "socialFeed": {
                "enabled": config.social_feed.enabled,
                "recentLimit": config.social_feed.recent_limit,
                "retentionDays": config.social_feed.retention_days,
                "maxItems": config.social_feed.max_items,
            },
            "memory": {
                "enabled": config.memory.enabled,
                "useMemories": config.memory.use_memories,
                "generateMemories": config.memory.generate_memories,
                "extractModel": config.memory.extract_model,
                "consolidationModel": config.memory.consolidation_model,
                "maxRawMemories": config.memory.max_raw_memories_for_consolidation,
                "maxUnusedDays": config.memory.max_unused_days,
                "maxSourceAgeDays": config.memory.max_source_age_days,
                "maxRolloutsPerStartup": config.memory.max_rollouts_per_startup,
                "minSessionIdleHours": config.memory.min_session_idle_hours,
                "extensionRetentionDays": config.memory.extension_retention_days,
            },
            "trading": {
                "hyperliquidEnabled": config.trading.hyperliquid_enabled,
                "bitgetDemoEnabled": config.trading.bitget_demo_enabled,
            },
            "sourcePath": str(config.source_path) if config.source_path else None,
        },
        "instruments": [
            instrument_payload(instrument, default_interval=config.analysis.interval)
            for instrument in instruments
        ],
        "groups": groups,
        "quotes": {
            key: quote_payload(
                quote,
                stale_after_seconds=config.display.stale_after_seconds,
            )
            for key, quote in quotes.items()
        },
        "agentAnalyses": agent_analyses or {},
        "openTrades": open_trades or [],
        "exchangePositions": exchange_positions or [],
        "exchangeOrders": exchange_orders or [],
        "recentNews": recent_news or [],
        "newsStatus": news_status or {},
    }
