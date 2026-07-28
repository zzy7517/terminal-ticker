import { BITGET_SOURCE, InstrumentConfig } from "../config/index.js";
import { BitgetInstrument, resolveInstruments as resolveBitgetInstruments } from "./bitget.js";

export type MarketInstrument = BitgetInstrument;

function dedupeKey(config: InstrumentConfig): string {
  return `${config.source}\0${config.instType ?? ""}\0${config.symbol}`;
}

export async function resolveInstruments(configured: readonly InstrumentConfig[]): Promise<MarketInstrument[]> {
  const bitgetConfigs = configured.filter((item) => item.source === BITGET_SOURCE);
  const resolvedBitget = new Map<string, BitgetInstrument>();
  if (bitgetConfigs.length > 0) {
    const instruments = await resolveBitgetInstruments(bitgetConfigs);
    bitgetConfigs.forEach((config, index) => resolvedBitget.set(dedupeKey(config), instruments[index]));
  }
  return configured.map((config) => {
    if (config.source === BITGET_SOURCE) {
      const instrument = resolvedBitget.get(dedupeKey(config));
      if (!instrument) throw new Error(`unresolved Bitget instrument: ${config.symbol}`);
      return instrument;
    }
    throw new Error(`unsupported data source: ${config.source}`);
  });
}
