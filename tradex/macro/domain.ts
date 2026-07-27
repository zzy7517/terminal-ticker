/**
 * Macro data layer — domain types.
 *
 * Pure types and interfaces. No I/O.
 *
 * Two distinct kinds of data live here, and the split is deliberate:
 *
 *  - `MacroPoint`  — numeric time series ("what is the value"). Sourced from
 *                    authoritative providers with revision history (FRED).
 *  - `MacroEvent`  — release schedule ("when is it published"). Sourced from
 *                    economic calendars.
 *
 * Calendar `actual` / `consensus` strings are carried on the event for display
 * but are never promoted into `MacroPoint`. See ADR note in MACRO_DATA_DESIGN.md
 * (决策 6).
 */

// ── Series ────────────────────────────────────────────────────────────────────

export type MacroSource = "fred" | "deribit" | "binance" | "polymarket" | "quotes";

/** Broad category, used to group the snapshot for display and agent context. */
export type MacroCategory =
  | "rates"
  | "inflation"
  | "dollar"
  | "employment"
  | "energy"
  | "metals"
  | "risk";

export interface MacroSeriesMeta {
  /** Stable internal id, e.g. "us10y". Independent of the provider's naming. */
  seriesId: string;
  source: MacroSource;
  /** The provider's own identifier, e.g. FRED's "DGS10". */
  sourceSeriesId: string;
  label: string;
  category: MacroCategory;
  /** Display unit, e.g. "%" or "USD". null when dimensionless. */
  unit: string | null;
  cadenceSeconds: number;
  /**
   * Whether observations are revised after first publication, meaning the
   * period timestamp and the publication timestamp differ. Monthly series
   * (CPI, PCE, payrolls) are vintaged; daily market rates are not.
   *
   * Vintaged series MUST be queried with an `asOf` bound — see
   * {@link MacroPoint.vintageTs}.
   */
  vintaged: boolean;
}

export interface MacroPoint {
  seriesId: string;
  /** The period the value describes (epoch ms). */
  ts: number;
  /** null when the provider reports the observation as missing. */
  value: number | null;
  /**
   * When this value became publicly known (epoch ms), or null for sources that
   * publish in real time (period === publication).
   *
   * This is what prevents lookahead bias: January CPI has ts = Jan 31 but
   * vintageTs = Feb 12. A backtest at Feb 1 must not see it.
   */
  vintageTs: number | null;
}

export interface MacroSeriesStatus {
  seriesId: string;
  label: string;
  source: MacroSource;
  lastFetchedAtMs: number | null;
  lastError: string | null;
  /** Period of the most recent stored observation. */
  latestTs: number | null;
  latestValue: number | null;
  pointCount: number;
}

// ── Calendar events ───────────────────────────────────────────────────────────

/**
 * Normalized importance. Jin10 grades 1-5 stars; English calendars typically
 * grade three levels. Three levels is therefore the lowest common denominator
 * and the only field consumers may rely on.
 */
export type MacroEventImpact = "high" | "medium" | "low";

export interface MacroEvent {
  /**
   * Identity is `(normalizedTitle, pubTimeMs)` — deliberately NOT the
   * provider's row id, so the same release reported by two calendars
   * deduplicates instead of double-counting.
   */
  key: string;
  /** Publication instant, epoch ms. Parsed with an explicit timezone. */
  pubTimeMs: number;
  title: string;
  /** Lowercased, whitespace/punctuation-collapsed title used for the key. */
  normalizedTitle: string;
  country: string | null;
  impact: MacroEventImpact;
  /**
   * Finer-grained importance when the provider supplies it (Jin10: 1-5).
   * Optional enhancement — never required, so a three-level provider can be
   * added without a schema change.
   */
  star: number | null;
  /** Raw display strings; may carry units like "%" or Chinese text. */
  previous: string | null;
  consensus: string | null;
  actual: string | null;
  revised: string | null;
  /** Provider commentary (Jin10 `affect_txt`). */
  note: string | null;
  provider: string;
  fetchedAtMs: number;
}

/**
 * A calendar data source. Implementations parse and normalize; they do not
 * persist. Adding a second calendar means adding one of these, not changing
 * the schema.
 */
export interface MacroCalendarProvider {
  readonly name: string;
  /** Whether the provider is configured and usable right now. */
  readonly available: boolean;
  /** Fetch the current calendar window. Throws on transport failure. */
  fetchEvents(): Promise<MacroEvent[]>;
}

// ── Event window ──────────────────────────────────────────────────────────────

export interface EventWindowConfig {
  /** Minimum impact that triggers a silence window. */
  minImpact: MacroEventImpact;
  /** Minutes before a release during which trading is suppressed. */
  beforeMinutes: number;
  /** Minutes after a release during which trading is suppressed. */
  afterMinutes: number;
  /**
   * Whether the window actually rejects new entries, as opposed to only being
   * reported. Off turns the whole thing into an advisory signal the Agent can
   * read but that never blocks an order.
   *
   * Exits are never blocked either way — refusing to close a position during a
   * volatile release is strictly worse than allowing it.
   */
  blockTrades: boolean;
}

export interface EventWindowVerdict {
  inWindow: boolean;
  /** The event responsible for the verdict, when inWindow. */
  event: MacroEvent | null;
  /**
   * True when the calendar could not be consulted (no data at all). Callers
   * must treat this as "assume in window" — see fail-closed note in
   * MACRO_DATA_DESIGN.md 决策 4.
   */
  unknown: boolean;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface MacroConfig {
  enabled: boolean;
  /** FRED API key. Empty disables the FRED provider (other sources still run). */
  fredApiKey: string;
  /** Original TOML value (may be `${VAR}`); persisted on save so the secret stays in the vault. */
  fredApiKeyRaw?: string;
  /** How much history to backfill on first run. */
  backfillYears: number;
  /** Poll cadence for the daily FRED sweep. */
  fredPollIntervalSeconds: number;
  /**
   * Twelve Data API key for spot metals (gold/silver). Empty falls back to
   * Yahoo Finance's unofficial endpoint. ICE DXY always uses Yahoo — Twelve
   * Data has no listing for it.
   */
  twelveDataApiKey: string;
  /** Original TOML value of `twelveDataApiKey`; see {@link fredApiKeyRaw}. */
  twelveDataApiKeyRaw?: string;
  /** Deribit DVOL + Binance positioning. Keyless, so on by default. */
  cryptoEnabled: boolean;
  cryptoPollIntervalSeconds: number;
  /** DXY / VIX daily closes. */
  quotesEnabled: boolean;
  quotesPollIntervalSeconds: number;
  /** Persist the Jin10/other calendar to SQLite and serve event windows. */
  calendarEnabled: boolean;
  calendarPollIntervalSeconds: number;
  eventWindow: EventWindowConfig;
}

export interface MacroStatus {
  enabled: boolean;
  fredConfigured: boolean;
  series: MacroSeriesStatus[];
  calendar: {
    enabled: boolean;
    lastFetchedAtMs: number | null;
    lastError: string | null;
    eventCount: number;
    /** Providers that contributed to the stored calendar. */
    providers: string[];
    /**
     * Whether the stored copy is recent enough to trust. False means event
     * windows report `unknown` and callers must assume a release is imminent.
     */
    fresh: boolean;
  };
}
