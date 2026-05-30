/**
 * Options & GEX Analysis - Service Layer
 *
 * Orchestrates periodic data fetching, GEX calculation, OI tracking,
 * and unusual activity detection.
 */

import type { GexSnapshot, OiRecord, OptionsConfig, UnusualActivity } from "./domain.js";
import { GexCalculator } from "./gex_calculator.js";
import { DeribitProvider } from "./providers/deribit.js";
import { createProvider, resolveProviderForSymbol, type OptionsDataProvider } from "./providers/index.js";
import { OptionsStore } from "./store.js";

export class OptionsService {
  private readonly config: OptionsConfig;
  private readonly primaryProvider: OptionsDataProvider;
  private readonly deribitProvider: DeribitProvider | null;
  private readonly calculator: GexCalculator;
  private readonly store: OptionsStore;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Current GEX snapshots by symbol (in-memory cache) */
  private readonly snapshots = new Map<string, GexSnapshot>();

  /** Recent unusual activity (ring buffer) */
  private readonly recentActivity: UnusualActivity[] = [];
  private static readonly MAX_RECENT = 200;

  constructor(config: OptionsConfig) {
    this.config = config;
    this.primaryProvider = createProvider(config);

    // Create separate Deribit provider if crypto is enabled
    this.deribitProvider = config.deribit?.enabled
      ? new DeribitProvider(config.deribit.currencies)
      : null;

    this.calculator = new GexCalculator({
      riskFreeRate: config.riskFreeRate,
      dividendYield: config.dividendYield,
    });

    this.store = new OptionsStore();
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  /** Start the polling loop */
  start(): void {
    if (this.intervalHandle) return;

    const intervalMs = this.config.pollIntervalSeconds * 1000;
    console.log(`[options] Starting service: ${this.config.symbols.join(", ")} every ${this.config.pollIntervalSeconds}s`);

    // Initial fetch
    void this.pollAll();

    // Periodic poll
    this.intervalHandle = setInterval(() => void this.pollAll(), intervalMs);
  }

  /** Stop the polling loop */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    console.log("[options] Service stopped");
  }

  /** Clean up resources */
  async close(): Promise<void> {
    this.stop();
    await this.primaryProvider.close();
    if (this.deribitProvider) await this.deribitProvider.close();
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /** Get the latest GEX snapshot for a symbol */
  getSnapshot(symbol: string): GexSnapshot | null {
    return this.snapshots.get(symbol.toUpperCase()) ?? null;
  }

  /** Get all current snapshots */
  getAllSnapshots(): Map<string, GexSnapshot> {
    return new Map(this.snapshots);
  }

  /** Get recent unusual activity */
  getUnusualActivity(symbol?: string, limit = 50): UnusualActivity[] {
    if (symbol) {
      return this.recentActivity
        .filter(a => a.symbol === symbol.toUpperCase())
        .slice(0, limit);
    }
    return this.recentActivity.slice(0, limit);
  }

  /** Get historical GEX data from store */
  getHistory(symbol: string, limit = 100): GexSnapshot[] {
    return this.store.getRecentSnapshots(symbol.toUpperCase(), limit);
  }

  /** Force a refresh for a specific symbol */
  async refresh(symbol: string): Promise<GexSnapshot | null> {
    return this.fetchAndCalculate(symbol.toUpperCase());
  }

  // --------------------------------------------------------------------------
  // Polling
  // --------------------------------------------------------------------------

  private async pollAll(): Promise<void> {
    const allSymbols = [...this.config.symbols];
    if (this.deribitProvider && this.config.deribit?.enabled) {
      for (const currency of this.config.deribit.currencies) {
        if (!allSymbols.includes(currency)) allSymbols.push(currency);
      }
    }

    // Process sequentially to respect rate limits
    for (const symbol of allSymbols) {
      try {
        await this.fetchAndCalculate(symbol);
      } catch (err) {
        console.error(`[options] Error fetching ${symbol}:`, err instanceof Error ? err.message : err);
      }
    }

    // Periodic cleanup (once a day roughly)
    if (Math.random() < 1 / (86400 / this.config.pollIntervalSeconds)) {
      this.store.cleanup();
    }
  }

  private async fetchAndCalculate(symbol: string): Promise<GexSnapshot | null> {
    const provider = resolveProviderForSymbol(symbol, this.primaryProvider, this.deribitProvider);

    // Fetch options chain
    const chain = await provider.getOptionsChain(symbol, {
      strikeRangePercent: this.config.strikeRangePercent,
    });

    if (chain.contracts.length === 0) {
      console.warn(`[options] No contracts for ${symbol}`);
      return null;
    }

    // Calculate GEX
    const snapshot = this.calculator.calculate(chain);

    // Store in memory cache
    this.snapshots.set(symbol, snapshot);

    // Persist
    this.store.saveGexSnapshot(snapshot);

    // Track OI changes and detect unusual activity
    this.trackOiChanges(chain);
    this.detectUnusualActivity(chain);

    return snapshot;
  }

  // --------------------------------------------------------------------------
  // OI Change Tracking
  // --------------------------------------------------------------------------

  private trackOiChanges(chain: import("./domain.js").OptionChain): void {
    const records: OiRecord[] = chain.contracts.map(c => ({
      symbol: chain.underlying,
      strike: c.strike,
      type: c.type,
      expiration: c.expiration,
      timestampMs: chain.timestamp,
      openInterest: c.openInterest,
      volume: c.volume,
      impliedVol: c.impliedVol,
    }));

    this.store.saveOiRecords(records);
  }

  // --------------------------------------------------------------------------
  // Unusual Activity Detection
  // --------------------------------------------------------------------------

  private detectUnusualActivity(chain: import("./domain.js").OptionChain): void {
    const { minOiChange, minVolumeOiRatio, minPremium } = this.config.alerts;
    const newActivity: UnusualActivity[] = [];

    for (const contract of chain.contracts) {
      // Check volume/OI ratio
      const volumeOiRatio = contract.openInterest > 0
        ? contract.volume / contract.openInterest
        : 0;

      // Check OI change from previous snapshot
      const prevOi = this.store.getPreviousOi(
        chain.underlying, contract.strike, contract.type, contract.expiration,
      );
      const oiChange = prevOi != null ? contract.openInterest - prevOi : 0;

      // Estimate premium
      const premiumEstimate = contract.volume * contract.mid * 100; // $ notional

      // Apply filters
      const isUnusual =
        (Math.abs(oiChange) >= minOiChange) ||
        (volumeOiRatio >= minVolumeOiRatio && contract.volume > 100) ||
        (premiumEstimate >= minPremium);

      if (isUnusual) {
        // Determine signal type
        let signal: UnusualActivity["signal"] = "unknown";
        if (oiChange > minOiChange) signal = "opening";
        else if (oiChange < -minOiChange) signal = "closing";
        else if (volumeOiRatio >= minVolumeOiRatio) signal = "sweep";

        const activity: UnusualActivity = {
          symbol: chain.underlying,
          strike: contract.strike,
          type: contract.type,
          expiration: contract.expiration,
          timestampMs: chain.timestamp,
          oiChange,
          volume: contract.volume,
          volumeOiRatio,
          premiumEstimate,
          signal,
        };

        newActivity.push(activity);
      }
    }

    if (newActivity.length > 0) {
      // Add to ring buffer
      this.recentActivity.unshift(...newActivity);
      if (this.recentActivity.length > OptionsService.MAX_RECENT) {
        this.recentActivity.length = OptionsService.MAX_RECENT;
      }

      // Persist
      this.store.saveUnusualActivity(newActivity);
    }
  }
}
