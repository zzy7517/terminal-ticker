"""Probe Longbridge quote push subscriptions from the command line."""
from __future__ import annotations

import argparse
import os
import sys
from time import sleep


REQUIRED_ENV = (
    "LONGBRIDGE_APP_KEY",
    "LONGBRIDGE_APP_SECRET",
    "LONGBRIDGE_ACCESS_TOKEN",
)


def parse_args() -> argparse.Namespace:
    """Parse the symbols and runtime limit for a Longbridge push probe."""
    parser = argparse.ArgumentParser(description="Probe Longbridge quote push events.")
    parser.add_argument(
        "symbols",
        nargs="*",
        default=["AAPL.US", "SPY.US"],
        help="Longbridge symbols, e.g. AAPL.US SPY.US",
    )
    parser.add_argument(
        "--seconds",
        type=int,
        default=30,
        help="how long to wait for pushes",
    )
    return parser.parse_args()


def main() -> int:
    """Subscribe to Longbridge push quotes long enough to print received events."""
    args = parse_args()
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        print("Missing environment variables:", ", ".join(missing), file=sys.stderr)
        return 2

    try:
        from longbridge.openapi import Config, QuoteContext, SubType
    except ImportError:
        print("Missing dependency: install with `pip install -r requirements.txt`", file=sys.stderr)
        return 2

    config = Config.from_apikey_env()
    ctx = QuoteContext(config)

    def on_quote(symbol, event) -> None:
        """Print each quote push event with its source symbol."""
        last_done = getattr(event, "last_done", None)
        timestamp = getattr(event, "timestamp", None)
        sequence = getattr(event, "sequence", None)
        print(f"push {symbol} last_done={last_done} timestamp={timestamp} sequence={sequence}")

    ctx.set_on_quote(on_quote)
    print(f"subscribing {args.symbols} for {args.seconds}s")
    try:
        ctx.subscribe(args.symbols, [SubType.Quote], True)
    except TypeError:
        ctx.subscribe(args.symbols, [SubType.Quote])
    sleep(args.seconds)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
