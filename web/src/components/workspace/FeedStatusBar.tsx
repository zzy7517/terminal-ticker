/**
 * FeedStatusBar — compact real-time feed indicators.
 */

import { usePipelineStore } from "../../stores/pipelineStore";

export function FeedStatusBar() {
  const feeds = usePipelineStore((s) => s.feeds);

  const fg = feeds.fear_greed;
  const funding = feeds.funding;
  const ls = feeds.long_short_ratio;
  const oi = feeds.oi_delta;
  const dxy = feeds.dxy;

  // If no feed data, don't render
  if (!fg && !funding && !ls && !oi && !dxy) return null;

  return (
    <div className="px-3 py-1 text-[10px] border-t border-zinc-800 flex items-center gap-3 text-zinc-500 bg-zinc-900/30">
      {fg && (
        <span className={fg.value < 20 ? "text-red-400" : fg.value > 80 ? "text-green-400" : ""}>
          FG:{fg.value}
        </span>
      )}
      {funding && (
        <span className={Math.abs(funding.rate) > 0.0005 ? "text-yellow-400" : ""}>
          FR:{(funding.rate * 100).toFixed(3)}%
        </span>
      )}
      {ls && (
        <span>LS:{ls.ratio.toFixed(2)}</span>
      )}
      {oi && (
        <span className={oi.delta1h > 0 ? "text-green-500/70" : oi.delta1h < 0 ? "text-red-400/70" : ""}>
          OI:{oi.delta1h > 0 ? "+" : ""}{(oi.delta1h / 1e6).toFixed(1)}M/1h
        </span>
      )}
      {dxy && (
        <span>DXY:{dxy.value.toFixed(1)}</span>
      )}
    </div>
  );
}
