import { AppConfig } from "../config/index.js";
import { mergeCandles } from "../domain/price_action.js";
import { QuoteState } from "../domain/quotes.js";
import { MarketInstrument } from "../market_data/router.js";
import { FeedEvent, FeedWorker } from "./feed.js";

export interface DrainResult {
  dirty: boolean;
  flashDirections: Record<string, number>;
}

type WorkerFactory = new (input: {
  config: AppConfig;
  instruments: readonly MarketInstrument[];
  emit: (event: FeedEvent) => void;
}) => FeedWorker;

export class TickerController {
  readonly config: AppConfig;
  readonly instruments: readonly MarketInstrument[];
  readonly quotes: Record<string, QuoteState>;
  streamStatus = "idle";
  lastMessageAt: Date | null = null;
  readonly eventQueue: FeedEvent[] = [];
  readonly feedWorker: FeedWorker;

  constructor(input: { config: AppConfig; instruments: readonly MarketInstrument[]; workerFactory?: WorkerFactory }) {
    this.config = input.config;
    this.instruments = input.instruments;
    this.quotes = Object.fromEntries(input.instruments.map((instrument) => [instrument.key, QuoteState.placeholder(instrument.label)]));
    const Factory = input.workerFactory ?? FeedWorker;
    this.feedWorker = new Factory({
      config: input.config,
      instruments: input.instruments,
      emit: (event) => this.eventQueue.push(event),
    });
  }

  start(): void {
    this.feedWorker.start();
  }

  async stop(): Promise<void> {
    await this.feedWorker.stop();
  }

  drainEvents(): DrainResult {
    let dirty = false;
    const flashDirections: Record<string, number> = {};
    while (this.eventQueue.length > 0) {
      const event = this.eventQueue.shift();
      if (!event) break;
      dirty = this.applyEvent(event, flashDirections) || dirty;
    }
    return { dirty, flashDirections };
  }

  private applyEvent(event: FeedEvent, flashDirections: Record<string, number>): boolean {
    if (event.kind === "quote") {
      const payload = event.payload as Record<string, unknown>;
      const key = String(payload.id || "");
      const quote = this.quotes[key];
      if (!quote) return false;
      const previousPrice = quote.price;
      quote.applyPayload(payload);
      const direction = TickerController.flashDirection(previousPrice, quote.price);
      if (direction !== 0) flashDirections[key] = direction;
      this.lastMessageAt = new Date();
      this.streamStatus = "live";
      return true;
    }
    if (event.kind === "snapshot") {
      let dirty = false;
      const payload = event.payload as Record<string, Record<string, unknown>>;
      for (const [key, item] of Object.entries(payload)) {
        const quote = this.quotes[key];
        if (quote && quote.updateCount === 0) {
          quote.applySnapshot(item);
          dirty = true;
        }
      }
      return dirty;
    }
    if (event.kind === "status") {
      this.streamStatus = String(event.payload);
      return true;
    }
    if (event.kind === "error") {
      this.streamStatus = "retrying";
      const payload = event.payload;
      if (payload && typeof payload === "object") {
        const detail = String((payload as Record<string, unknown>).message || "");
        const ids = (payload as Record<string, unknown>).ids;
        if (detail && Array.isArray(ids)) {
          for (const key of ids) this.quotes[String(key)]?.markError(detail);
        }
      }
      return true;
    }
    if (event.kind === "candles") {
      const payload = event.payload as Record<string, unknown>;
      const key = String(payload.id || "");
      const quote = this.quotes[key];
      if (!quote) return false;
      const incoming = Array.isArray(payload.candles) ? payload.candles : [];
      const multiRaw = payload.multi_timeframe_candles;
      quote.applyCandles({
        candles: incoming.length > 0 ? mergeCandles(quote.candles, incoming) : [],
        multiTimeframeCandles:
          multiRaw && typeof multiRaw === "object" && !Array.isArray(multiRaw)
            ? Object.fromEntries(Object.entries(multiRaw as Record<string, unknown>).map(([interval, candles]) => [interval, Array.isArray(candles) ? candles : []]))
            : undefined,
      });
      if (payload.error) quote.markError(String(payload.error));
      return true;
    }
    return false;
  }

  static flashDirection(previousPrice: number | null, currentPrice: number | null): number {
    if (previousPrice === null || currentPrice === null) return 0;
    if (currentPrice > previousPrice) return 1;
    if (currentPrice < previousPrice) return -1;
    return 0;
  }
}
