/**
 * FeedStatusBar — compact real-time feed indicators.
 */

import { usePipelineStore } from "../../stores/pipelineStore";
import "./PipelinePanels.css";

export function FeedStatusBar() {
  const feeds = usePipelineStore((s) => s.feeds);

  const fg = feeds.fear_greed;
  const funding = feeds.funding;
  const ls = feeds.long_short_ratio;
  const oi = feeds.oi_delta;
  const dxy = feeds.dxy;

  if (!fg && !funding && !ls && !oi && !dxy) return null;

  return (
    <div className="feed-status-bar">
      {fg && (
        <span className={fg.value < 20 ? "pipeline-tone--down" : fg.value > 80 ? "pipeline-tone--up" : ""}>
          FG:{fg.value}
        </span>
      )}
      {funding && (
        <span className={Math.abs(funding.rate) > 0.0005 ? "pipeline-tone--warn" : ""}>
          FR:{(funding.rate * 100).toFixed(3)}%
        </span>
      )}
      {ls && <span>LS:{ls.ratio.toFixed(2)}</span>}
      {oi && (
        <span className={oi.delta1h > 0 ? "pipeline-tone--up" : oi.delta1h < 0 ? "pipeline-tone--down" : ""}>
          OI:{oi.delta1h > 0 ? "+" : ""}{(oi.delta1h / 1e6).toFixed(1)}M/1h
        </span>
      )}
      {dxy && <span>DXY:{dxy.value.toFixed(1)}</span>}
    </div>
  );
}
