import { Candle } from "./price_action.js";

export interface MacdValue {
  macd: number;
  signal: number;
  histogram: number;
}

export interface EmaValues {
  ema20?: number;
  ema50?: number;
}

export interface TechnicalIndicators {
  rsi14?: number;
  macd?: MacdValue;
  ema?: EmaValues;
}

const RSI_PERIOD = 14;
const MACD_FAST_PERIOD = 12;
const MACD_SLOW_PERIOD = 26;
const MACD_SIGNAL_PERIOD = 9;
const EMA_PERIODS = [20, 50] as const;

export function calculateTechnicalIndicators(candles: readonly Candle[]): TechnicalIndicators | null {
  const closes = candles.map((candle) => candle.close);
  const indicators: TechnicalIndicators = {};

  const rsi14 = calculateRsi(closes, RSI_PERIOD);
  if (rsi14 !== null) indicators.rsi14 = round(rsi14);

  const macd = calculateMacd(closes);
  if (macd !== null) {
    indicators.macd = {
      macd: round(macd.macd),
      signal: round(macd.signal),
      histogram: round(macd.histogram),
    };
  }

  const ema: EmaValues = {};
  for (const period of EMA_PERIODS) {
    const value = lastEma(closes, period);
    if (value === null) continue;
    if (period === 20) ema.ema20 = round(value);
    if (period === 50) ema.ema50 = round(value);
  }
  if (Object.keys(ema).length > 0) indicators.ema = ema;

  return Object.keys(indicators).length > 0 ? indicators : null;
}

function calculateRsi(values: readonly number[], period: number): number | null {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    const currentGain = change > 0 ? change : 0;
    const currentLoss = change < 0 ? -change : 0;
    averageGain = (averageGain * (period - 1) + currentGain) / period;
    averageLoss = (averageLoss * (period - 1) + currentLoss) / period;
  }

  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function calculateMacd(values: readonly number[]): MacdValue | null {
  const fastSeries = emaSeries(values, MACD_FAST_PERIOD);
  const slowSeries = emaSeries(values, MACD_SLOW_PERIOD);
  const macdSeries: number[] = [];

  for (let index = 0; index < values.length; index += 1) {
    const fast = fastSeries[index];
    const slow = slowSeries[index];
    if (fast === null || slow === null) continue;
    macdSeries.push(fast - slow);
  }

  const signal = lastEma(macdSeries, MACD_SIGNAL_PERIOD);
  if (signal === null || macdSeries.length === 0) return null;
  const macd = macdSeries[macdSeries.length - 1];
  return { macd, signal, histogram: macd - signal };
}

function lastEma(values: readonly number[], period: number): number | null {
  const series = emaSeries(values, period);
  return series.at(-1) ?? null;
}

function emaSeries(values: readonly number[], period: number): Array<number | null> {
  const series = new Array<number | null>(values.length).fill(null);
  if (values.length < period) return series;

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  series[period - 1] = ema;
  for (let index = period; index < values.length; index += 1) {
    ema = (values[index] - ema) * multiplier + ema;
    series[index] = ema;
  }
  return series;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
