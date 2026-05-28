/**
 * RegimeHUD — always-visible regime status indicator bar.
 */

import { useMarketStore } from "../../stores/marketStore";
import { usePipelineStore } from "../../stores/pipelineStore";
import "./PipelinePanels.css";

const MARKET_CLASSES: Record<string, string> = {
  RISK_ON: "pipeline-chip--risk-on",
  RISK_OFF: "pipeline-chip--risk-off",
  NEUTRAL: "pipeline-chip--neutral",
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
  const pipelineEnabled = useMarketStore((s) => s.state?.config.pipeline.enabled ?? false);

  if (!pipelineEnabled) {
    return <div className="pipeline-hud pipeline-hud--empty">Pipeline: disabled</div>;
  }

  if (!regime) {
    return <div className="pipeline-hud pipeline-hud--empty">Pipeline: enabled, waiting for first run</div>;
  }

  const { market, volatility, trend, indicators } = regime;
  const fg = feeds.fear_greed;
  const funding = feeds.funding;
  const ls = feeds.long_short_ratio;

  return (
    <div className="pipeline-hud">
      <span className={`pipeline-chip ${MARKET_CLASSES[market] ?? "pipeline-chip--primary"}`}>
        {MARKET_ICONS[market]} {market.replace("_", " ")}
      </span>

      <span className={`pipeline-chip ${volatility === "EXTREME" ? "pipeline-chip--down pipeline-chip--pulse" : ""}`}>
        Vol: {volatility}
      </span>

      <span className="pipeline-chip">
        Trend: {TREND_ARROWS[trend] ?? "?"}{trend}
      </span>

      {indicators.vix !== null && (
        <span className={`pipeline-chip ${indicators.vix > 30 ? "pipeline-chip--down" : ""}`}>
          VIX: {indicators.vix.toFixed(1)}
        </span>
      )}

      {fg && (
        <span className={`pipeline-chip ${fg.value < 25 ? "pipeline-chip--down" : fg.value > 75 ? "pipeline-chip--up" : ""}`}>
          FG: {fg.value}
        </span>
      )}

      {funding && (
        <span className={`pipeline-chip ${Math.abs(funding.rate) > 0.0005 ? "pipeline-chip--warn" : ""}`}>
          FR: {(funding.rate * 100).toFixed(3)}%
        </span>
      )}

      {ls && <span className="pipeline-chip">LS: {ls.ratio.toFixed(2)}</span>}

      {indicators.dxy !== null && (
        <span className="pipeline-chip">DXY: {indicators.dxy.toFixed(1)}</span>
      )}
    </div>
  );
}
