import type {
  InstrumentSearchResult,
  MarketState,
  Quote,
} from '../types';
import { addBitgetSymbol } from '../api';

export function orderedGroups(state: MarketState | null) {
  if (!state) return [];
  const preferred = ['bitget'];
  const present = Object.keys(state.groups);
  return [
    ...preferred.filter((group) => present.includes(group)),
    ...present.filter((group) => !preferred.includes(group)).sort(),
  ];
}

export function changeClass(quote: Quote | undefined) {
  if (!quote || quote.change == null) return 'neutral';
  if (quote.change > 0) return 'up';
  if (quote.change < 0) return 'down';
  return 'neutral';
}

export function sourceName(source: string) {
  return source.toUpperCase();
}

export function addInstrumentBySource(result: InstrumentSearchResult) {
  if (result.source === 'bitget') return addBitgetSymbol(result);
  throw new Error(`unsupported instrument source: ${result.source}`);
}

export function formatContextWindow(size: number | null) {
  if (size == null) return '-';
  if (size >= 1000) return `${Math.round(size / 1000)}K`;
  return String(size);
}
