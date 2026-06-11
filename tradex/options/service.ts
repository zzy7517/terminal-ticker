/**
 * Options & GEX Analysis - Service Layer
 *
 * Orchestrates periodic data fetching, GEX calculation, OI tracking,
 * and unusual activity detection.
 */

import type { GexSnapshot, OptionChain, OptionsConfig, UnusualActivity } from "./domain.js";
import { GexCalculator } from "./gex_calculator.js";
import { DeribitProvider } from "./providers/deribit.js";
import { createProvider, resolveProviderForSymbol, type OptionsDataProvider } from "./providers/index.js";
import { OptionsStore } from "./store.js";
import { buildIVSurface, deriveRegimeParams, deriveSpotVolCoupling } from "./iv_surface.js";
import { computeHedgeImpulseCurve } from "./hedge_impulse.js";
import { computePressureCloud } from "./pressure_cloud.js";
import { calculateFullExposure } from "./exposure.js";
import { expiryCloseMs } from "./expiry.js";

export class OptionsService {
  private readonly config: OptionsConfig;
  private readonly primaryProvider: OptionsDataProvider;
  private readonly deribitProvider: DeribitProvider | null;
  private readonly calculator: GexCalculator;
  private readonly store: OptionsStore;

  /** Current GEX snapshots by symbol (in-memory cache) */
  private readonly snapshots = new Map<string, GexSnapshot>();

  /**
   * Symbols with an in-flight background refresh, so a burst of reads only
   * triggers a single fetch per symbol.
   */
  private readonly inFlight = new Set<string>();

  /** Age (ms) past which a cached snapshot is considered stale and a lazy
   * background refresh is triggered on the next read. Reuses the configured
   * poll interval, now interpreted as a freshness threshold. */
  private get staleMs(): number {
    return this.config.pollIntervalSeconds * 1000;
  }

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

  /**
   * Start the service. No background polling loop: data is fetched lazily on
   * read when the cached snapshot is missing or stale (see getSnapshot). We
   * only warm the in-memory cache from the last persisted snapshot so reads
   * have something to return immediately after startup.
   */
  start(): void {
    this.hydrateFromStore();
    const hours = (this.staleMs / 3_600_000).toFixed(1);
    console.log(`[options] Lazy mode: ${this.config.symbols.join(", ")} refresh when older than ${hours}h`);
  }

  /**
   * Load the most recent persisted snapshot for each configured symbol into the
   * in-memory cache. Persisted rows omit live-only analytics (exposure, IV
   * surface, etc.) but carry the core GEX/levels needed for display and agent
   * context between infrequent polls.
   */
  private hydrateFromStore(): void {
    const symbols = new Set<string>(this.config.symbols.map((s) => s.toUpperCase()));
    if (this.deribitProvider && this.config.deribit?.enabled) {
      for (const currency of this.config.deribit.currencies) symbols.add(currency.toUpperCase());
    }
    let loaded = 0;
    for (const symbol of symbols) {
      if (this.snapshots.has(symbol)) continue;
      const recent = this.store.getRecentSnapshots(symbol, 1);
      const last = recent[recent.length - 1];
      if (last) {
        this.snapshots.set(symbol, last);
        loaded += 1;
      }
    }
    if (loaded > 0) console.log(`[options] Hydrated ${loaded} snapshot(s) from local store`);
  }

  /** Stop the service. Nothing to tear down in lazy mode. */
  stop(): void {
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

  /**
   * Get the latest GEX snapshot for a symbol. Returns the cached value
   * immediately (possibly null or stale); if the cache is missing or older
   * than the freshness threshold, a background refresh is kicked off so the
   * next read sees fresh data. Reads never block on the network.
   */
  getSnapshot(symbol: string): GexSnapshot | null {
    const key = symbol.toUpperCase();
    const snap = this.snapshots.get(key) ?? null;
    this.maybeRefresh(key, snap);
    return snap;
  }

  /** Get all current snapshots, triggering lazy refresh for any stale symbol. */
  getAllSnapshots(): Map<string, GexSnapshot> {
    for (const key of this.trackedSymbols()) {
      this.maybeRefresh(key, this.snapshots.get(key) ?? null);
    }
    return new Map(this.snapshots);
  }

  /** Unusual-activity tracking is disabled (no history is retained). */
  getUnusualActivity(_symbol?: string, _limit = 50): UnusualActivity[] {
    return [];
  }

  /** Historical GEX is not retained; only the latest snapshot is kept. */
  getHistory(symbol: string, _limit = 100): GexSnapshot[] {
    const snap = this.snapshots.get(symbol.toUpperCase());
    return snap ? [snap] : [];
  }

  /** Force a refresh for a specific symbol. */
  async refresh(symbol: string): Promise<GexSnapshot | null> {
    return this.fetchAndCalculate(symbol.toUpperCase());
  }

  // --------------------------------------------------------------------------
  // Lazy refresh
  // --------------------------------------------------------------------------

  /** All symbols this service tracks (configured equities + Deribit crypto). */
  private trackedSymbols(): string[] {
    const symbols = new Set<string>(this.config.symbols.map((s) => s.toUpperCase()));
    if (this.deribitProvider && this.config.deribit?.enabled) {
      for (const currency of this.config.deribit.currencies) symbols.add(currency.toUpperCase());
    }
    return [...symbols];
  }

  /**
   * Trigger a non-blocking background fetch when the snapshot is missing or
   * older than staleMs and no refresh is already in flight for that symbol.
   */
  private maybeRefresh(key: string, snap: GexSnapshot | null): void {
    const fresh = snap != null && Date.now() - snap.timestamp < this.staleMs;
    if (fresh || this.inFlight.has(key)) return;
    this.inFlight.add(key);
    void this.fetchAndCalculate(key)
      .catch((err) => console.error(`[options] Lazy refresh failed for ${key}:`, err instanceof Error ? err.message : err))
      .finally(() => this.inFlight.delete(key));
  }

  private async fetchAndCalculate(symbol: string): Promise<GexSnapshot | null> {
    // Fetch raw chain → local GEX calculation
    const provider = resolveProviderForSymbol(symbol, this.primaryProvider, this.deribitProvider);

    const chain = await provider.getOptionsChain(symbol, {
      strikeRangePercent: this.config.strikeRangePercent,
    });

    if (chain.contracts.length === 0) {
      console.warn(`[options] No contracts for ${symbol}`);
      return null;
    }

    // Calculate GEX
    const snapshot = this.calculator.calculate(chain);

    // Enrich with advanced analytics (IV surface → regime → hedge impulse →
    // pressure cloud) plus full 4D exposure. Non-fatal: failures leave nulls.
    this.enrichSnapshot(snapshot, chain);

    // Store in memory cache
    this.snapshots.set(symbol, snapshot);

    // Persist latest-only: replace any prior row for this symbol so the store
    // never accumulates history. Used solely to warm the cache on restart.
    this.store.replaceLatestSnapshot(snapshot);

    return snapshot;
  }

  // --------------------------------------------------------------------------
  // Advanced Analytics (A modules)
  // --------------------------------------------------------------------------

  /**
   * Compute IV surface, regime params, hedge impulse curve, pressure cloud,
   * and full 4D exposure from the chain, attaching them to the snapshot.
   *
   * The IV-surface-derived chain (surface → regime → impulse → cloud) is built
   * on the nearest expiration, where dealer hedging is most price-sensitive.
   * Exposure is computed across all expirations.
   */
  private enrichSnapshot(snapshot: GexSnapshot, chain: OptionChain): void {
    const { spotPrice, contracts } = chain;
    const r = this.config.riskFreeRate;
    const q = this.config.dividendYield;
    const contractMultiplier = chain.contractMultiplier;

    try {
      // Full 4D exposure across all expirations
      snapshot.exposure = calculateFullExposure(contracts, spotPrice, {
        riskFreeRate: r,
        dividendYield: q,
        asOfTimestamp: chain.timestamp,
        contractMultiplier,
      });
    } catch (err) {
      console.warn(`[options] exposure failed for ${chain.underlying}:`, err instanceof Error ? err.message : err);
      snapshot.exposure = null;
    }

    try {
      // Front (nearest) expiration drives the surface/impulse/cloud chain
      const frontExpiration = this.nearestExpiration(contracts, chain.timestamp);
      if (!frontExpiration) return;

      const surface = buildIVSurface(contracts, spotPrice, frontExpiration);
      if (!surface) return;
      snapshot.ivSurface = surface;

      const regimeParams = deriveRegimeParams(surface);
      snapshot.regimeParams = regimeParams;

      const k = deriveSpotVolCoupling(regimeParams);
      const impulse = computeHedgeImpulseCurve(contracts, spotPrice, k, {
        riskFreeRate: r,
        dividendYield: q,
        contractMultiplier,
      });
      snapshot.hedgeImpulse = impulse;

      snapshot.pressureCloud = computePressureCloud(impulse, regimeParams);
    } catch (err) {
      console.warn(`[options] analytics failed for ${chain.underlying}:`, err instanceof Error ? err.message : err);
    }
  }

  /** Pick the nearest non-expired expiration present in the chain. */
  private nearestExpiration(contracts: OptionChain["contracts"], nowMs: number): string | null {
    let best: string | null = null;
    let bestMs = Infinity;
    for (const c of contracts) {
      // Match GexCalculator.timeToExpiration: 4:00 PM ET close (DST-aware).
      const expMs = expiryCloseMs(c.expiration);
      if (!isFinite(expMs) || expMs <= nowMs) continue;
      if (expMs < bestMs) {
        bestMs = expMs;
        best = c.expiration;
      }
    }
    return best;
  }

}
