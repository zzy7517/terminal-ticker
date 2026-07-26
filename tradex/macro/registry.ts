/**
 * Macro series registry.
 *
 * Maps stable internal ids to provider series. Internal ids are what the rest
 * of the codebase (snapshot derivations, agent tools, API) refers to, so a
 * provider swap never ripples outward.
 */

import type { MacroSeriesMeta } from "./domain.js";

const DAY = 24 * 60 * 60;
const HOUR = 60 * 60;
const FIVE_MIN = 5 * 60;

/**
 * Phase 1 series — all from FRED.
 *
 * `vintaged: true` marks series that are revised after first publication and
 * therefore require `asOf`-bounded reads to avoid lookahead bias. As a rule:
 * monthly survey data is vintaged, daily market rates are not.
 */
export const FRED_SERIES: MacroSeriesMeta[] = [
  // ── Rates ───────────────────────────────────────────────────────────────────
  {
    seriesId: "us10y",
    source: "fred",
    sourceSeriesId: "DGS10",
    label: "10 年期美债收益率",
    category: "rates",
    unit: "%",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "us2y",
    source: "fred",
    sourceSeriesId: "DGS2",
    label: "2 年期美债收益率",
    category: "rates",
    unit: "%",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "curve_2s10s",
    source: "fred",
    sourceSeriesId: "T10Y2Y",
    label: "2s10s 利差",
    category: "rates",
    unit: "%",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "fed_funds",
    source: "fred",
    sourceSeriesId: "DFF",
    label: "联邦基金有效利率",
    category: "rates",
    unit: "%",
    cadenceSeconds: DAY,
    vintaged: false,
  },

  // ── Inflation ───────────────────────────────────────────────────────────────
  {
    seriesId: "breakeven_10y",
    source: "fred",
    sourceSeriesId: "T10YIE",
    label: "10 年盈亏平衡通胀预期",
    category: "inflation",
    unit: "%",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "cpi",
    source: "fred",
    sourceSeriesId: "CPIAUCSL",
    label: "CPI（季调）",
    category: "inflation",
    unit: "index",
    cadenceSeconds: DAY,
    vintaged: true,
  },
  {
    seriesId: "core_pce",
    source: "fred",
    sourceSeriesId: "PCEPILFE",
    label: "核心 PCE 物价指数",
    category: "inflation",
    unit: "index",
    cadenceSeconds: DAY,
    vintaged: true,
  },

  // ── Dollar ──────────────────────────────────────────────────────────────────
  {
    seriesId: "dxy_broad",
    source: "fred",
    sourceSeriesId: "DTWEXBGS",
    label: "广义美元指数",
    category: "dollar",
    unit: "index",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  // FX pairs migrated off Jin10 `get_quote` (see #11 in MACRO_DATA_DESIGN.md).
  // FRED carries all three at daily frequency with no request quota, which the
  // metered Jin10 tool did not.
  {
    seriesId: "eurusd",
    source: "fred",
    sourceSeriesId: "DEXUSEU",
    label: "欧元/美元",
    category: "dollar",
    unit: "USD",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "usdjpy",
    source: "fred",
    sourceSeriesId: "DEXJPUS",
    label: "美元/日元",
    category: "dollar",
    unit: "JPY",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    // Onshore CNY, not the offshore CNH that Jin10 quoted. The two track each
    // other closely; the spread itself is a signal we do not currently need.
    seriesId: "usdcny",
    source: "fred",
    sourceSeriesId: "DEXCHUS",
    label: "美元/人民币（在岸）",
    category: "dollar",
    unit: "CNY",
    cadenceSeconds: DAY,
    vintaged: false,
  },

  // ── Employment ──────────────────────────────────────────────────────────────
  {
    seriesId: "payrolls",
    source: "fred",
    sourceSeriesId: "PAYEMS",
    label: "非农就业人数",
    category: "employment",
    unit: "千人",
    cadenceSeconds: DAY,
    vintaged: true,
  },
  {
    seriesId: "unemployment",
    source: "fred",
    sourceSeriesId: "UNRATE",
    label: "失业率",
    category: "employment",
    unit: "%",
    cadenceSeconds: DAY,
    vintaged: true,
  },

  // ── Energy ──────────────────────────────────────────────────────────────────
  {
    seriesId: "wti",
    source: "fred",
    sourceSeriesId: "DCOILWTICO",
    label: "WTI 原油现货",
    category: "energy",
    unit: "USD",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "natgas",
    source: "fred",
    sourceSeriesId: "DHHNGSP",
    label: "亨利港天然气现货",
    category: "energy",
    unit: "USD",
    cadenceSeconds: DAY,
    vintaged: false,
  },

  // ── Risk ────────────────────────────────────────────────────────────────────
  {
    // VIX lives on FRED rather than behind the quotes provider: the daily close
    // is authoritative, unmetered, and needs no unofficial endpoint. Free
    // real-time VIX sources proved unusable in practice — Yahoo's chart endpoint
    // returns 403/429 from some regions even with a crumb session.
    seriesId: "vix",
    source: "fred",
    sourceSeriesId: "VIXCLS",
    label: "VIX 波动率指数",
    category: "risk",
    unit: null,
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "stress_index",
    source: "fred",
    sourceSeriesId: "STLFSI4",
    label: "圣路易斯联储金融压力指数",
    category: "risk",
    unit: "index",
    cadenceSeconds: DAY,
    vintaged: false,
  },
];

// ── Crypto positioning & volatility ──────────────────────────────────────────

/**
 * Currencies covered by the crypto-native sources.
 *
 * Deliberately a fixed list rather than config-driven: the registry is written
 * to `macro_series_meta` once at startup, so a runtime-variable set would leave
 * orphaned rows behind. Adding a currency is a one-line edit here.
 */
export const CRYPTO_CURRENCIES = ["BTC", "ETH"] as const;

/** Binance perp symbol for a currency. */
export function perpSymbol(currency: string): string {
  return `${currency.toUpperCase()}USDT`;
}


export const DERIBIT_SERIES: MacroSeriesMeta[] = CRYPTO_CURRENCIES.map((currency) => ({
  seriesId: `dvol_${currency.toLowerCase()}`,
  source: "deribit" as const,
  sourceSeriesId: currency,
  label: `${currency} DVOL 隐含波动率`,
  category: "risk" as const,
  unit: "%",
  cadenceSeconds: HOUR,
  vintaged: false,
}));

export const BINANCE_SERIES: MacroSeriesMeta[] = CRYPTO_CURRENCIES.flatMap((currency) => {
  const asset = currency.toLowerCase();
  const symbol = perpSymbol(currency);
  return [
    {
      seriesId: `binance_oi_${asset}`,
      source: "binance" as const,
      sourceSeriesId: symbol,
      label: `${currency} 未平仓量（币计价）`,
      category: "risk" as const,
      unit: currency,
      cadenceSeconds: FIVE_MIN,
      vintaged: false,
    },
    {
      seriesId: `binance_ls_ratio_${asset}`,
      source: "binance" as const,
      sourceSeriesId: symbol,
      label: `${currency} 大户多空持仓比`,
      category: "risk" as const,
      unit: null,
      cadenceSeconds: FIVE_MIN,
      vintaged: false,
    },
    {
      seriesId: `binance_taker_ratio_${asset}`,
      source: "binance" as const,
      sourceSeriesId: symbol,
      label: `${currency} 主动买卖量比`,
      category: "risk" as const,
      unit: null,
      cadenceSeconds: FIVE_MIN,
      vintaged: false,
    },
  ];
});

// ── Index quotes ─────────────────────────────────────────────────────────────

/**
 * Series that only the quotes provider can supply — i.e. the ones FRED does not
 * carry. Everything FRED covers is registered above instead, because FRED needs
 * no unofficial endpoint and has no request quota.
 *
 * Gold and silver are the reason this list still exists: FRED's LBMA series were
 * discontinued, so they require a Twelve Data key (the keyless Yahoo fallback is
 * best-effort and blocked in some regions).
 */
export const QUOTES_SERIES: MacroSeriesMeta[] = [
  {
    // ICE DXY proper. FRED's `dxy_broad` (DTWEXBGS) is a different, broader
    // basket — kept as the keyless fallback rather than a substitute.
    seriesId: "dxy",
    source: "quotes",
    sourceSeriesId: "DX-Y.NYB",
    label: "美元指数 DXY",
    category: "dollar",
    unit: "index",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "gold",
    source: "quotes",
    sourceSeriesId: "XAU/USD",
    label: "现货黄金",
    category: "metals",
    unit: "USD",
    cadenceSeconds: DAY,
    vintaged: false,
  },
  {
    seriesId: "silver",
    source: "quotes",
    sourceSeriesId: "XAG/USD",
    label: "现货白银",
    category: "metals",
    unit: "USD",
    cadenceSeconds: DAY,
    vintaged: false,
  },
];

/** All registered series across every source. */
export const MACRO_SERIES: MacroSeriesMeta[] = [
  ...FRED_SERIES,
  ...DERIBIT_SERIES,
  ...BINANCE_SERIES,
  ...QUOTES_SERIES,
];

const BY_ID = new Map(MACRO_SERIES.map((s) => [s.seriesId, s]));

export function findSeries(seriesId: string): MacroSeriesMeta | null {
  return BY_ID.get(seriesId) ?? null;
}

export function seriesForSource(source: MacroSeriesMeta["source"]): MacroSeriesMeta[] {
  return MACRO_SERIES.filter((s) => s.source === source);
}
