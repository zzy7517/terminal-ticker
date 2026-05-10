import { BITGET_SOURCE, HYPERLIQUID_SOURCE, InstrumentConfig } from "../config/index.js";
import { BitgetInstrument, resolveInstruments as resolveBitgetInstruments } from "./bitget.js";
import { HyperliquidInstrument, resolveInstruments as resolveHyperliquidInstruments } from "./hyperliquid.js";

export type MarketInstrument = BitgetInstrument | HyperliquidInstrument;

function dedupeKey(config: InstrumentConfig): string {
  return `${config.source}\0${config.instType ?? ""}\0${config.symbol}`;
}

export async function resolveInstruments(configured: readonly InstrumentConfig[]): Promise<MarketInstrument[]> {
  const bitgetConfigs = configured.filter((item) => item.source === BITGET_SOURCE);
  const hyperliquidConfigs = configured.filter((item) => item.source === HYPERLIQUID_SOURCE);
  const resolvedBitget = new Map<string, BitgetInstrument>();
  const resolvedHyperliquid = new Map<string, HyperliquidInstrument>();
  if (bitgetConfigs.length > 0) {
    const instruments = await resolveBitgetInstruments(bitgetConfigs);
    bitgetConfigs.forEach((config, index) => resolvedBitget.set(dedupeKey(config), instruments[index]));
  }
  if (hyperliquidConfigs.length > 0) {
    const instruments = await resolveHyperliquidInstruments(hyperliquidConfigs);
    hyperliquidConfigs.forEach((config, index) => resolvedHyperliquid.set(dedupeKey(config), instruments[index]));
  }
  return configured.map((config) => {
    if (config.source === BITGET_SOURCE) {
      const instrument = resolvedBitget.get(dedupeKey(config));
      if (!instrument) throw new Error(`unresolved Bitget instrument: ${config.symbol}`);
      return instrument;
    }
    if (config.source === HYPERLIQUID_SOURCE) {
      const instrument = resolvedHyperliquid.get(dedupeKey(config));
      if (!instrument) throw new Error(`unresolved Hyperliquid instrument: ${config.symbol}`);
      return instrument;
    }
    throw new Error(`unsupported data source: ${config.source}`);
  });
}
