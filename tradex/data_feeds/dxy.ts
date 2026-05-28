/**
 * DXY approximation feed — derived from EURUSD (Jin10 quotes or feed).
 *
 * The simplified DXY ≈ 1/EURUSD × 100 (EUR is ~57.6% of DXY basket).
 * For a quick proxy this is sufficient; the actual DXY involves 6 currencies.
 * We use: DXY ≈ 50.14348112 × EURUSD^(-0.576) × USDJPY^(0.136) × ...
 * Simplified: DXY ≈ 1/EURUSD × baseline_factor (calibrated).
 */

import { BaseFeed } from "./base_feed.js";
import type { DXYData } from "./types.js";

/** Calibration: when EURUSD=1.08, DXY≈104. So factor ≈ 104 × 1.08 = 112.32 */
const CALIBRATION_FACTOR = 112.32;

export interface DXYFeedConfig {
  /** Function that returns current EURUSD rate (from Jin10 quotes or market data). */
  getEURUSD: () => number | null;
  pollIntervalMs?: number;
}

export class DXYFeed extends BaseFeed<DXYData> {
  readonly name = "dxy";
  readonly pollIntervalMs: number;
  private getEURUSD: () => number | null;

  constructor(config: DXYFeedConfig) {
    super();
    this.getEURUSD = config.getEURUSD;
    this.pollIntervalMs = config.pollIntervalMs ?? 30_000;
  }

  protected async fetch(): Promise<DXYData | null> {
    const eurusd = this.getEURUSD();
    if (!eurusd || eurusd <= 0) return null;
    const dxy = CALIBRATION_FACTOR / eurusd;
    return {
      value: Math.round(dxy * 100) / 100,
      eurusd,
      timestamp: new Date().toISOString(),
    };
  }
}
