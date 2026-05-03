#!/usr/bin/env python3
"""Run offline regime/context strategy research on OHLCV candles."""
from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from terminal_ticker.market_data.bitget import BitgetInstrument, fetch_candles
from terminal_ticker.domain.price_action import Candle
from terminal_ticker.domain.strategy import StrategyConfig, split_optimize_validate


def _default_output(symbol: str, inst_type: str, interval: str) -> Path:
    """Return the default local research dataset path."""
    safe = f"{inst_type}_{symbol}_{interval}".replace("/", "-").replace(":", "-")
    return Path("data") / "strategy" / f"{safe}.csv"


def _read_csv(path: Path) -> tuple[Candle, ...]:
    """Load normalized candles from CSV."""
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        return tuple(
            Candle(
                symbol_key=row["symbol_key"],
                open_time_ms=int(row["open_time_ms"]),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row["volume"]),
            )
            for row in reader
        )


def _write_csv(path: Path, candles: Iterable[Candle]) -> None:
    """Persist normalized candles for repeatable research."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=["symbol_key", "open_time_ms", "open", "high", "low", "close", "volume"],
        )
        writer.writeheader()
        for candle in candles:
            writer.writerow(
                {
                    "symbol_key": candle.symbol_key,
                    "open_time_ms": candle.open_time_ms,
                    "open": candle.open,
                    "high": candle.high,
                    "low": candle.low,
                    "close": candle.close,
                    "volume": candle.volume,
                }
            )


def _fetch_bitget(symbol: str, inst_type: str, interval: str, limit: int) -> tuple[Candle, ...]:
    """Fetch recent Bitget candles without requiring user credentials."""
    instrument = BitgetInstrument(
        symbol=symbol,
        inst_type=inst_type,
        label=symbol,
        base_asset=symbol.removesuffix("USDT") or symbol,
        quote_asset="USDT",
        market_kind="perp" if inst_type != "SPOT" else "spot",
    )
    return fetch_candles(instrument, interval=interval, limit=limit)


def _config_from_args(args: argparse.Namespace) -> StrategyConfig:
    """Build strategy config from CLI flags."""
    return StrategyConfig(
        window=args.window,
        horizon=args.horizon,
        min_confidence=args.min_confidence,
        trend_threshold=args.trend_threshold,
        efficiency_threshold=args.efficiency_threshold,
    )


def _stability_summary(train: dict, validation: dict) -> dict[str, bool | str]:
    """Return a conservative pass/fail summary for the split result."""
    checks = {
        "train_positive": train["total_return"] > 0,
        "validation_positive": validation["total_return"] > 0,
        "validation_hit_rate": validation["hit_rate"] >= 0.52,
        "validation_drawdown": validation["max_drawdown"] <= 0.08,
        "enough_validation_trades": validation["trades"] >= 20,
    }
    stable = all(checks.values())
    return {
        "stable": stable,
        "status": "research-pass" if stable else "needs-more-work",
        **checks,
    }


def main() -> int:
    """Run the research workflow."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, help="Read candles from an existing normalized CSV")
    parser.add_argument("--symbol", default="BTCUSDT", help="Bitget symbol to fetch when --csv is omitted")
    parser.add_argument("--inst-type", default="USDT-FUTURES", help="Bitget instrument type")
    parser.add_argument("--interval", default="5m", help="Candle interval")
    parser.add_argument("--limit", type=int, default=1000, help="Number of recent candles to fetch")
    parser.add_argument("--output", type=Path, help="Where fetched candles should be saved")
    parser.add_argument("--refresh", action="store_true", help="Fetch again even if the output CSV exists")
    parser.add_argument("--window", type=int, default=48, help="Candles used to produce one signal")
    parser.add_argument("--horizon", type=int, default=6, help="Candles used to judge one signal")
    parser.add_argument("--min-confidence", type=float, default=0.58)
    parser.add_argument("--trend-threshold", type=float, default=0.65)
    parser.add_argument("--efficiency-threshold", type=float, default=0.28)
    args = parser.parse_args()

    output = args.output or _default_output(args.symbol, args.inst_type, args.interval)
    if args.csv:
        candles = _read_csv(args.csv)
        dataset_path = args.csv
    elif output.exists() and not args.refresh:
        candles = _read_csv(output)
        dataset_path = output
    else:
        candles = _fetch_bitget(args.symbol, args.inst_type, args.interval, args.limit)
        _write_csv(output, candles)
        dataset_path = output

    config = _config_from_args(args)
    result = split_optimize_validate(candles, config)
    train = result.train.to_dict()
    validation = result.validation.to_dict()
    payload = {
        "dataset": str(dataset_path),
        "candles": len(candles),
        "selected_config": asdict(result.config),
        "train": train,
        "validation": validation,
        "stability": _stability_summary(train, validation),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
