import { AppConfig } from "../config/index.js";
import { Candle } from "../domain/price_action.js";
import { BitgetInstrument, BitgetPublicWebSocket, fetchCandles as fetchBitgetCandles, fetchSnapshotPayloads } from "../market_data/bitget.js";
import { CandleCache, cachedFetchCandles, retentionSecondsForWindow } from "../market_data/candle_cache.js";
import { HyperliquidAllMidsWebSocket, HyperliquidInstrument, fetchCandles as fetchHyperliquidCandles, fetchSnapshotPayloads as fetchHyperliquidSnapshotPayloads } from "../market_data/hyperliquid.js";
import { MarketInstrument } from "../market_data/router.js";

export const CHART_CANDLE_LIMIT = 1000;
export const MULTI_TIMEFRAME_CANDLE_LIMIT = 120;
const MULTI_TIMEFRAME_STACKS: Record<string, string[]> = {
  "1m": ["1D", "4H", "1H", "15m", "5m", "1m"],
  "3m": ["1D", "4H", "1H", "15m", "5m", "3m"],
  "5m": ["1D", "4H", "1H", "15m", "5m"],
  "15m": ["1D", "4H", "1H", "15m", "5m"],
  "30m": ["1W", "1D", "4H", "1H", "30m"],
  "1H": ["1W", "1D", "4H", "1H", "15m"],
  "4H": ["1W", "1D", "4H", "1H"],
  "6H": ["1W", "1D", "6H", "1H"],
  "12H": ["1W", "1D", "12H", "4H"],
  "1D": ["1M", "1W", "1D", "4H"],
  "3D": ["1M", "1W", "3D", "1D"],
  "1W": ["1M", "1W", "1D"],
  "1M": ["1M", "1W"],
};

export function relatedAnalysisIntervals(primaryInterval: string): string[] {
  return MULTI_TIMEFRAME_STACKS[primaryInterval] ?? [primaryInterval];
}

export interface FeedEvent {
  kind: "quote" | "snapshot" | "status" | "error" | "candles";
  payload: unknown;
}

type EventHandler = (event: FeedEvent) => void;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export class FeedWorker {
  readonly config: AppConfig;
  readonly instruments: readonly MarketInstrument[];
  readonly bitgetInstruments: BitgetInstrument[];
  readonly hyperliquidInstruments: HyperliquidInstrument[];
  private readonly emit: EventHandler;
  private readonly candleCache: CandleCache | null;
  private abortController: AbortController | null = null;
  private tasks: Array<Promise<void>> = [];
  private bitgetSocket: BitgetPublicWebSocket | null = null;
  private hyperliquidSocket: HyperliquidAllMidsWebSocket | null = null;
  /** Keys excluded from candle polling (removed at runtime without feed restart). */
  private readonly excludedKeys = new Set<string>();

  constructor(input: { config: AppConfig; instruments: readonly MarketInstrument[]; emit: EventHandler; candleCache?: CandleCache | null }) {
    this.config = input.config;
    this.instruments = input.instruments;
    this.bitgetInstruments = input.instruments.filter((instrument): instrument is BitgetInstrument => instrument instanceof BitgetInstrument);
    this.hyperliquidInstruments = input.instruments.filter((instrument): instrument is HyperliquidInstrument => instrument instanceof HyperliquidInstrument);
    this.emit = input.emit;
    this.candleCache = input.candleCache ?? (this.config.cache.enabled ? CandleCache.fromConfig(this.config.cache) : null);
  }

  /**
   * Mark an instrument key as excluded — the candle polling loop will skip it.
   * WebSocket streams are left running; quote events for excluded keys are
   * harmlessly dropped by TickerController (quotes[key] is already deleted).
   */
  excludeInstrument(key: string): void {
    this.excludedKeys.add(key);
  }

  start(): void {
    if (this.abortController !== null) return;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    if (this.bitgetInstruments.length > 0) this.tasks.push(this.runBitget(signal));
    if (this.config.analysis.enabled && (this.bitgetInstruments.length > 0 || this.hyperliquidInstruments.length > 0)) this.tasks.push(this.runCandles(signal));
    if (this.hyperliquidInstruments.length > 0) this.tasks.push(this.runHyperliquid(signal));
    void Promise.allSettled(this.tasks).then(() => this.emit({ kind: "status", payload: "stopped" }));
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    await this.bitgetSocket?.close();
    await this.hyperliquidSocket?.close();
    this.bitgetSocket = null;
    this.hyperliquidSocket = null;
    await Promise.race([
      Promise.allSettled(this.tasks),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    this.tasks = [];
    this.abortController = null;
  }

  private async runBitget(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.emit({ kind: "status", payload: "connecting" });
        void this.emitBitgetSnapshotBestEffort();
        this.bitgetSocket = new BitgetPublicWebSocket(this.bitgetInstruments);
        this.emit({ kind: "status", payload: "subscribed" });
        await this.bitgetSocket.listen((payload) => this.emit({ kind: "quote", payload }), signal);
      } catch (error) {
        if (signal.aborted) break;
        this.emit({ kind: "error", payload: error instanceof Error ? error.message : String(error) });
        await sleep(this.config.display.reconnectDelaySeconds * 1000, signal).catch(() => undefined);
      } finally {
        await this.bitgetSocket?.close();
        this.bitgetSocket = null;
      }
    }
  }

  private async runHyperliquid(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.emit({ kind: "status", payload: "connecting" });
        void this.emitHyperliquidSnapshotBestEffort();
        this.hyperliquidSocket = new HyperliquidAllMidsWebSocket(this.hyperliquidInstruments);
        this.emit({ kind: "status", payload: "subscribed" });
        await this.hyperliquidSocket.listen((payload) => this.emit({ kind: "quote", payload }), signal);
      } catch (error) {
        if (signal.aborted) break;
        this.emit({ kind: "error", payload: error instanceof Error ? error.message : String(error) });
        await sleep(this.config.display.reconnectDelaySeconds * 1000, signal).catch(() => undefined);
      } finally {
        await this.hyperliquidSocket?.close();
        this.hyperliquidSocket = null;
      }
    }
  }

  private async runCandles(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      for (const instrument of [...this.bitgetInstruments, ...this.hyperliquidInstruments]) {
        if (signal.aborted) break;
        if (this.excludedKeys.has(instrument.key)) continue;
        const interval = instrument.analysisInterval || this.config.analysis.interval;
        let candles: Candle[] = [];
        const multiTimeframeCandles: Record<string, Candle[]> = {};
        let error: string | null = null;
        try {
          candles = await this.fetchCandles(instrument, { interval, limit: Math.max(this.config.analysis.lookback, CHART_CANDLE_LIMIT) });
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        for (const timeframe of relatedAnalysisIntervals(interval)) {
          try {
            if (timeframe === interval && candles.length > 0) {
              multiTimeframeCandles[timeframe] = candles.slice(-MULTI_TIMEFRAME_CANDLE_LIMIT);
              continue;
            }
            const limit = Math.max(this.config.agent.maxCandles, MULTI_TIMEFRAME_CANDLE_LIMIT);
            const timeframeCandles = await this.fetchCandles(instrument, { interval: timeframe, limit });
            if (timeframeCandles.length > 0) multiTimeframeCandles[timeframe] = timeframeCandles.slice(-limit);
          } catch {
            // Missing secondary timeframes should not break the main quote stream.
          }
        }
        this.emit({
          kind: "candles",
          payload: {
            id: instrument.key,
            candles,
            multi_timeframe_candles: multiTimeframeCandles,
            ...(error ? { error } : {}),
          },
        });
      }
      await sleep(this.config.analysis.pollIntervalSeconds * 1000, signal).catch(() => undefined);
    }
  }

  private async fetchCandles(
    instrument: MarketInstrument,
    input: { interval: string; limit: number; minimumRetentionSeconds?: number | null; maxCacheAgeSeconds?: number | null },
  ): Promise<Candle[]> {
    if (this.candleCache !== null) {
      try {
        return await cachedFetchCandles({
          cache: this.candleCache,
          symbolKey: instrument.key,
          interval: input.interval,
          limit: input.limit,
          fetcher: (args) => this.fetchProviderCandles(instrument, args),
          minimumRetentionSeconds: input.minimumRetentionSeconds ?? retentionSecondsForWindow(input.interval, input.limit),
          maxCacheAgeSeconds: input.maxCacheAgeSeconds ?? null,
        });
      } catch (error) {
        console.warn(`Candle cache unavailable for ${instrument.key} ${input.interval}:`, error);
      }
    }
    return this.fetchProviderCandles(instrument, input);
  }

  private fetchProviderCandles(
    instrument: MarketInstrument,
    input: { interval: string; limit: number; afterOpenTimeMs?: number | null; beforeOpenTimeMs?: number | null },
  ): Promise<Candle[]> {
    if (instrument instanceof BitgetInstrument) return fetchBitgetCandles(instrument, input);
    if (instrument instanceof HyperliquidInstrument) return fetchHyperliquidCandles(instrument, input);
    throw new Error(`unsupported candle provider: ${String(instrument)}`);
  }

  private async emitBitgetSnapshotBestEffort(): Promise<void> {
    try {
      const payloads = await fetchSnapshotPayloads(this.bitgetInstruments);
      if (Object.keys(payloads).length > 0) this.emit({ kind: "snapshot", payload: payloads });
    } catch (error) {
      console.warn("Bitget REST snapshot unavailable; continuing with WebSocket ticker:", error);
    }
  }

  private async emitHyperliquidSnapshotBestEffort(): Promise<void> {
    try {
      const payloads = await fetchHyperliquidSnapshotPayloads(this.hyperliquidInstruments);
      for (const payload of Object.values(payloads)) this.emit({ kind: "quote", payload });
    } catch (error) {
      console.warn("Hyperliquid REST snapshot unavailable; continuing with allMids WebSocket:", error);
    }
  }
}
