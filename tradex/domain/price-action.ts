export interface CandleInput {
  symbolKey: string;
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class Candle {
  readonly symbolKey: string;
  readonly openTimeMs: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;

  constructor(input: CandleInput) {
    if (input.high < Math.max(input.open, input.close, input.low)) {
      throw new Error("candle high must be greater than or equal to open, low, and close");
    }
    if (input.low > Math.min(input.open, input.close, input.high)) {
      throw new Error("candle low must be less than or equal to open, high, and close");
    }
    this.symbolKey = input.symbolKey;
    this.openTimeMs = input.openTimeMs;
    this.open = input.open;
    this.high = input.high;
    this.low = input.low;
    this.close = input.close;
    this.volume = input.volume;
  }

  get range(): number {
    return this.high - this.low;
  }

  get body(): number {
    return Math.abs(this.close - this.open);
  }
}

export function mergeCandles(existing: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  const byOpenTime = new Map<number, Candle>();
  for (const candle of existing) byOpenTime.set(candle.openTimeMs, candle);
  for (const candle of incoming) byOpenTime.set(candle.openTimeMs, candle);
  return [...byOpenTime.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, candle]) => candle);
}
