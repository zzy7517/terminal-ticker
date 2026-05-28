/**
 * RegimeHUD — always-visible regime status indicator bar.
 */

import { usePipelineStore } from "../../stores/pipelineStore";

const MARKET_COLORS: Record<string, string> = {
  RISK_ON: "text-green-400",
  RISK_OFF: "text-red-400",
  NEUTRAL: "text-yellow-400",
};

const MARKET_ICONS: Record<string, string> = {
  RISK_ON: "🟢",
  RISK_OFF: "🔴",
  NEUTRAL: "🟡",
};

const TREND_ARROWS: Record<string, string> = {
  STRONG_UP: "⬆️",
  UP: "↑",
  RANGE: "↔",
  DOWN: "↓",
  STRONG_DOWN: "⬇️",
};

export function RegimeHUD() {
  const regime = usePipelineStore((s) => s.regime);
  const feeds = usePipelineStore((s) => s.feeds);

  if (!regime) {
    return (
      <div className="px-3 py-1 text-xs text-zinc-500 border-b border-zinc-800">
        Pipeline: No regime data
      </div>
    );
  }

  const { market, volatility, trend, indicators } = regime;
  const fg = feeds.fear_greed;
  const funding = feeds.funding;
  const ls = feeds.long_short_ratio;

  return (
    <div className="px-3 py-1.5 text-xs border-b border-zinc-800 flex items-center gap-3 flex-wrap bg-zinc-900/50">
      {/* Market regime */}
      <span className={`font-medium ${MARKET_COLORS[market] ?? "text-zinc-400"}`}>
        {MARKET_ICONS[market]} {market.replace("_", " ")}
      </span>

      {/* Volatility */}
      <span className={volatility === "EXTREME" ? "text-red-400 animate-pulse" : "text-zinc-400"}>
        Vol: {volatility}
      </span>

      {/* Trend */}
      <span className="text-zinc-400">
        Trend: {TREND_ARROWS[trend] ?? "?"}{trend}
      </span>

      {/* Key indicators */}
      {indicators.vix !== null && (
        <span className={indicators.vix > 30 ? "text-red-400" : "text-zinc-500"}>
          VIX: {indicators.vix.toFixed(1)}
        </span>
      )}

      {fg && (
        <span className={fg.value < 25 ? "text-red-400" : fg.value > 75 ? "text-green-400" : "text-zinc-500"}>
          FG: {fg.value}
        </span>
      )}

      {funding && (
        <span className={Math.abs(funding.rate) > 0.0005 ? "text-yellow-400" : "text-zinc-500"}>
          FR: {(funding.rate * 100).toFixed(3)}%
        </span>
      )}

      {ls && (
        <span className="text-zinc-500">
          LS: {ls.ratio.toFixed(2)}
        </span>
      )}

      {indicators.dxy !== null && (
        <span className="text-zinc-500">
          DXY: {indicators.dxy.toFixed(1)}
        </span>
      )}
    </div>
  );
}
