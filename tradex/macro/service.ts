/**
 * Macro data layer — service.
 *
 * Owns scheduling and degradation. Two independent cadences in Phase 1:
 * a daily FRED sweep and a calendar poll. Each series and each provider fails
 * on its own; nothing here throws to the caller.
 */

import { nowMs } from "../db.js";
import type { Jin10Service } from "../jin10/service.js";
import type {
  EventWindowVerdict,
  MacroConfig,
  MacroEvent,
  MacroPoint,
  MacroSeriesStatus,
  MacroStatus,
} from "./domain.js";
import { evaluateEventWindow } from "./calendar.js";
import {
  CRYPTO_CURRENCIES,
  FRED_SERIES,
  MACRO_SERIES,
  findSeries,
  perpSymbol,
} from "./registry.js";
import { FredProvider } from "./providers/fred.js";
import { Jin10CalendarProvider } from "./providers/jin10-calendar.js";
import { ForexFactoryCalendarProvider } from "./providers/forexfactory-calendar.js";
import { DeribitDvolProvider } from "./providers/deribit-dvol.js";
import { BinanceFuturesProvider } from "./providers/binance-futures.js";
import { IndexQuotesProvider, QUOTE_SERIES } from "./providers/quotes.js";
import type { MacroCalendarProvider } from "./domain.js";
import { computeDerived, computeSeriesStats, type MacroSnapshot } from "./snapshot.js";
import { MacroStore } from "./store.js";

/** Events older than this are pruned on each calendar poll. */
const EVENT_RETENTION_DAYS = 90;

/**
 * How far around `atMs` to load events when evaluating a window. Must exceed
 * the largest configured before/after margin.
 */
const WINDOW_LOOKUP_MS = 12 * 60 * 60 * 1000;

export class MacroService {
  readonly config: MacroConfig;
  private readonly store: MacroStore;
  private readonly fred: FredProvider;
  private readonly dvol: DeribitDvolProvider;
  private readonly binance: BinanceFuturesProvider;
  private readonly quotes: IndexQuotesProvider;
  private readonly calendarProviders: MacroCalendarProvider[];

  private fredTimer: NodeJS.Timeout | null = null;
  private calendarTimer: NodeJS.Timeout | null = null;
  private cryptoTimer: NodeJS.Timeout | null = null;
  private quotesTimer: NodeJS.Timeout | null = null;

  private calendarLastFetchedAtMs: number | null = null;
  private calendarLastError: string | null = null;
  /**
   * When the calendar was last *successfully* stored (distinct from the last
   * attempt). Drives the fail-closed contract in {@link isInEventWindow}.
   *
   * Tracked separately because Jin10's `list_calendar` only covers the current
   * natural week with no date parameters, so a stale copy silently loses
   * forward coverage: on Monday, last week's rows contain no upcoming releases
   * and would make a window check report "clear" with false confidence.
   */
  private calendarLastSuccessAtMs: number | null = null;

  constructor(input: {
    config: MacroConfig;
    jin10Service: Jin10Service | null;
    store?: MacroStore;
    /** Test seam — production builds the Jin10 + Forex Factory union. */
    calendarProviders?: MacroCalendarProvider[];
  }) {
    this.config = input.config;
    this.store = input.store ?? new MacroStore();
    this.fred = new FredProvider(input.config.fredApiKey);
    this.dvol = new DeribitDvolProvider();
    this.binance = new BinanceFuturesProvider();
    this.quotes = new IndexQuotesProvider(input.config.twelveDataApiKey);
    this.calendarProviders = input.calendarProviders ?? buildCalendarProviders(input);
  }

  get available(): boolean {
    return this.config.enabled;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.config.enabled) return;

    this.store.upsertSeriesMeta(MACRO_SERIES);
    // Adopt the previous run's fetch time so a restart mid-week keeps working
    // instead of failing closed until the first poll lands. If that copy is
    // already stale the freshness check below still rejects it.
    this.calendarLastSuccessAtMs = this.store.eventBookkeeping().lastFetchedAtMs;

    if (this.fred.available) {
      void this.refreshFred();
      this.fredTimer = setInterval(
        () => void this.refreshFred(),
        this.config.fredPollIntervalSeconds * 1000,
      );
    } else {
      console.warn("[macro] FRED API key not configured — macro series will not update");
    }

    if (this.config.calendarEnabled && this.calendarProviders.length > 0) {
      void this.refreshCalendar();
      this.calendarTimer = setInterval(
        () => void this.refreshCalendar(),
        this.config.calendarPollIntervalSeconds * 1000,
      );
    }

    if (this.config.cryptoEnabled) {
      void this.refreshCrypto();
      this.cryptoTimer = setInterval(
        () => void this.refreshCrypto(),
        this.config.cryptoPollIntervalSeconds * 1000,
      );
    }

    if (this.config.quotesEnabled) {
      void this.refreshQuotes();
      this.quotesTimer = setInterval(
        () => void this.refreshQuotes(),
        this.config.quotesPollIntervalSeconds * 1000,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.fredTimer) { clearInterval(this.fredTimer); this.fredTimer = null; }
    if (this.calendarTimer) { clearInterval(this.calendarTimer); this.calendarTimer = null; }
    if (this.cryptoTimer) { clearInterval(this.cryptoTimer); this.cryptoTimer = null; }
    if (this.quotesTimer) { clearInterval(this.quotesTimer); this.quotesTimer = null; }
  }

  close(): void {
    this.store.close();
  }

  // ── FRED ────────────────────────────────────────────────────────────────────

  /**
   * Sweep every FRED series. Each series is independent: one failure is
   * recorded against that series and the rest continue.
   */
  async refreshFred(): Promise<{ updated: number; failed: number }> {
    if (!this.fred.available) return { updated: 0, failed: 0 };

    const start = new Date(nowMs());
    start.setUTCFullYear(start.getUTCFullYear() - this.config.backfillYears);

    let updated = 0;
    let failed = 0;

    for (const meta of FRED_SERIES) {
      try {
        const points = await this.fred.fetchSeries(meta, start);
        this.store.upsertPoints(points);
        this.store.recordFetchResult(meta.seriesId, null);
        updated++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.store.recordFetchResult(meta.seriesId, message);
        console.warn(`[macro] ${meta.seriesId} fetch failed:`, message);
        failed++;
      }
    }

    return { updated, failed };
  }

  // ── Crypto-native sources ───────────────────────────────────────────────────

  /**
   * Sweep Deribit DVOL and Binance positioning for every configured currency.
   *
   * Each (currency, metric) pair is independent so a single endpoint failing
   * cannot take the others down with it.
   */
  async refreshCrypto(): Promise<{ updated: number; failed: number }> {
    let updated = 0;
    let failed = 0;

    const now = nowMs();
    // DVOL is hourly; a day of backfill keeps percentile windows meaningful
    // without re-pulling history on every poll.
    const dvolFrom = now - 24 * 60 * 60 * 1000;

    for (const currency of CRYPTO_CURRENCIES) {
      const dvolSeries = DeribitDvolProvider.seriesId(currency);
      try {
        this.store.upsertPoints(await this.dvol.fetchDvol(currency, dvolFrom, now));
        this.store.recordFetchResult(dvolSeries, null);
        updated++;
      } catch (error) {
        failed += this.recordFailure(dvolSeries, error);
      }

      const symbol = perpSymbol(currency);
      for (const metric of BinanceFuturesProvider.METRICS) {
        const seriesId = BinanceFuturesProvider.seriesId(symbol, metric);
        try {
          this.store.upsertPoints(await this.binance.fetchMetric(symbol, metric));
          this.store.recordFetchResult(seriesId, null);
          updated++;
        } catch (error) {
          failed += this.recordFailure(seriesId, error);
        }
      }
    }

    return { updated, failed };
  }

  // ── Index quotes ────────────────────────────────────────────────────────────

  /** Sweep DXY / VIX daily closes. */
  async refreshQuotes(): Promise<{ updated: number; failed: number }> {
    let updated = 0;
    let failed = 0;
    const days = Math.max(this.config.backfillYears * 365, 90);

    for (const spec of QUOTE_SERIES) {
      try {
        this.store.upsertPoints(await this.quotes.fetchQuotes(spec, days));
        this.store.recordFetchResult(spec.seriesId, null);
        updated++;
      } catch (error) {
        failed += this.recordFailure(spec.seriesId, error);
      }
    }

    return { updated, failed };
  }

  private recordFailure(seriesId: string, error: unknown): 1 {
    const message = error instanceof Error ? error.message : String(error);
    this.store.recordFetchResult(seriesId, message);
    console.warn(`[macro] ${seriesId} fetch failed:`, message);
    return 1;
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  /**
   * Descriptive snapshot across every registered series.
   *
   * `windowDays` bounds the trailing window used for z-scores and percentiles.
   * Output is intentionally free of directional judgement — see snapshot.ts.
   */
  getSnapshot(options: { atMs?: number; windowDays?: number } = {}): MacroSnapshot {
    const atMs = options.atMs ?? nowMs();
    const windowDays = options.windowDays ?? 90;
    const dayMs = 24 * 60 * 60 * 1000;

    const series = MACRO_SERIES.map((meta) => {
      // Level series override the window (monthly data needs years, not days)
      // and need raw history before it so the transform has a predecessor for
      // the oldest point inside the window.
      const windowFromMs = atMs - (meta.stat?.windowDays ?? windowDays) * dayMs;
      const fetchFromMs = windowFromMs - (meta.stat?.lookbackDays ?? 0) * dayMs;

      return computeSeriesStats(
        {
          seriesId: meta.seriesId,
          label: meta.label,
          category: meta.category,
          unit: meta.unit,
          stat: meta.stat,
        },
        this.store.getSeries(meta.seriesId, { asOfMs: atMs, fromMs: fetchFromMs }),
        atMs,
        windowFromMs,
      );
    });

    return { atMs, series, derived: computeDerived(series) };
  }

  /** Read a series as known at `asOfMs` (defaults to now). */
  getSeries(
    seriesId: string,
    options: { asOfMs?: number; fromMs?: number; limit?: number } = {},
  ): MacroPoint[] {
    if (!findSeries(seriesId)) return [];
    return this.store.getSeries(seriesId, options);
  }

  getLatest(seriesId: string, asOfMs?: number): MacroPoint | null {
    if (!findSeries(seriesId)) return null;
    return this.store.getLatest(seriesId, asOfMs);
  }

  // ── Calendar ────────────────────────────────────────────────────────────────

  /**
   * Poll every calendar provider and persist the union.
   *
   * A provider that throws is skipped; `calendarReady` only advances when at
   * least one provider produced events, so a total outage keeps the window
   * check failing closed rather than silently reporting "nothing scheduled".
   */
  async refreshCalendar(): Promise<{ count: number; error: string | null }> {
    const errors: string[] = [];
    let stored = 0;

    for (const provider of this.calendarProviders) {
      if (!provider.available) continue;
      try {
        const events = await provider.fetchEvents();
        stored += this.store.upsertEvents(events);
      } catch (error) {
        errors.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    this.calendarLastFetchedAtMs = nowMs();
    this.calendarLastError = errors.length > 0 ? errors.join("; ") : null;

    if (stored > 0) {
      this.calendarLastSuccessAtMs = this.calendarLastFetchedAtMs;
      this.store.pruneEvents(nowMs() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    }

    return { count: stored, error: this.calendarLastError };
  }

  getEvents(options: { fromMs: number; toMs: number; minImpact?: MacroEvent["impact"] }): MacroEvent[] {
    return this.store.getEvents(options);
  }

  /** Whether the stored calendar is recent enough to be trusted. */
  get calendarFresh(): boolean {
    if (this.calendarLastSuccessAtMs === null) return false;
    return nowMs() - this.calendarLastSuccessAtMs <= this.calendarStalenessLimitMs;
  }

  /**
   * Tolerate a few missed polls before declaring the calendar unusable, but
   * stay well inside a day so a week rollover cannot go unnoticed.
   */
  private get calendarStalenessLimitMs(): number {
    const threePolls = this.config.calendarPollIntervalSeconds * 3 * 1000;
    return Math.min(Math.max(threePolls, 30 * 60_000), 6 * 60 * 60_000);
  }

  /**
   * Whether `atMs` falls inside a release silence window.
   *
   * Returns `unknown: true` (and `inWindow: true`) when the calendar has never
   * been fetched *or* the stored copy is stale, so callers cannot mistake "we
   * don't know" for "clear". Staleness matters specifically because
   * `list_calendar` covers only the current natural week: an old copy looks
   * populated while containing no upcoming releases at all.
   */
  isInEventWindow(atMs: number = nowMs()): EventWindowVerdict {
    // The layer being off is not the same as the calendar being unreachable: no
    // polling ever ran, so failing closed here would block every order forever
    // on a default install rather than protecting anything.
    if (!this.config.enabled || !this.config.calendarEnabled) {
      return { inWindow: false, event: null, unknown: false };
    }
    if (!this.calendarFresh) {
      return { inWindow: true, event: null, unknown: true };
    }
    const events = this.store.getEvents({
      fromMs: atMs - WINDOW_LOOKUP_MS,
      toMs: atMs + WINDOW_LOOKUP_MS,
      minImpact: this.config.eventWindow.minImpact,
    });
    return evaluateEventWindow(events, atMs, this.config.eventWindow);
  }

  /**
   * Entry gate for the order path.
   *
   * Separate from {@link isInEventWindow} because a verdict is not a decision:
   * the window is always *reported*, but only rejects orders when
   * `block_trades` is on. `reason` is written for an Agent to read back to the
   * user, so it names the event and the margins rather than just saying "no".
   */
  checkEntryGate(atMs: number = nowMs()): {
    blocked: boolean;
    reason: string | null;
    verdict: EventWindowVerdict;
  } {
    const verdict = this.isInEventWindow(atMs);
    if (!verdict.inWindow || !this.config.eventWindow.blockTrades) {
      return { blocked: false, reason: null, verdict };
    }

    const { beforeMinutes, afterMinutes } = this.config.eventWindow;
    const reason = verdict.unknown
      ? "宏观日历数据陈旧或从未成功拉取，无法确认当前是否处于数据发布窗口。按 fail-closed 处理，拒绝开仓。"
      : `当前处于「${verdict.event?.title ?? "高影响事件"}」的发布静默窗口（发布时点 ` +
        `${new Date(verdict.event?.pubTimeMs ?? atMs).toISOString()}，前 ${beforeMinutes} 分钟 / 后 ` +
        `${afterMinutes} 分钟禁止开仓）。`;
    return { blocked: true, reason, verdict };
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  getStatus(): MacroStatus {
    const series: MacroSeriesStatus[] = MACRO_SERIES.map((meta) => {
      const bookkeeping = this.store.getFetchBookkeeping(meta.seriesId);
      const latest = this.store.getLatest(meta.seriesId);
      return {
        seriesId: meta.seriesId,
        label: meta.label,
        source: meta.source,
        lastFetchedAtMs: bookkeeping.lastFetchedAtMs,
        lastError: bookkeeping.lastError,
        latestTs: latest?.ts ?? null,
        latestValue: latest?.value ?? null,
        pointCount: this.store.countPoints(meta.seriesId),
      };
    });

    return {
      enabled: this.config.enabled,
      fredConfigured: this.fred.available,
      series,
      calendar: {
        enabled: this.config.calendarEnabled,
        lastFetchedAtMs: this.calendarLastFetchedAtMs ?? this.calendarLastSuccessAtMs,
        lastError: this.calendarLastError,
        eventCount: this.store.countEvents(),
        providers: this.store.eventProviders(),
        fresh: this.calendarFresh,
      },
    };
  }
}

function buildCalendarProviders(input: {
  config: MacroConfig;
  jin10Service: Jin10Service | null;
}): MacroCalendarProvider[] {
  const providers: MacroCalendarProvider[] = [];
  if (input.jin10Service) {
    providers.push(new Jin10CalendarProvider(input.jin10Service));
  }
  if (input.config.forexfactoryCalendarEnabled) {
    providers.push(new ForexFactoryCalendarProvider({ enabled: true }));
  }
  return providers;
}
