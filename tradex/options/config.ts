import { asRecord, coerceFloat, coerceInt, expandEnvRefs, normalizeBool } from "../config/parsing.js";
import type { OptionsConfig } from "./domain.js";

export function parseOptionsConfig(rawOptionsValue: unknown): OptionsConfig {
  const DEFAULT: OptionsConfig = {
    enabled: false, provider: "yfinance", symbols: ["SPY", "QQQ"],
    pollIntervalSeconds: 60, strikeRangePercent: 0.15,
    riskFreeRate: 0.0363, dividendYield: 0.015,
    deribit: { enabled: false, currencies: ["BTC", "ETH"] },
    alerts: { minOiChange: 1000, minVolumeOiRatio: 3.0, minPremium: 100_000 },
  };
  if (!rawOptionsValue || typeof rawOptionsValue !== "object") return DEFAULT;
  const raw = rawOptionsValue as Record<string, unknown>;
  const rawAlerts = asRecord(raw.alerts, "options.alerts");
  const rawDeribit = asRecord(raw.deribit, "options.deribit");
  const rawTradier = asRecord(raw.tradier, "options.tradier");
  const rawMarketData = asRecord(raw.marketdata, "options.marketdata");
  // Allow ${VAR} env references for the fallback key, like provider secrets.
  const mdKeyRaw = typeof rawMarketData.api_key === "string" ? rawMarketData.api_key.trim() : "";
  const mdKey = mdKeyRaw ? expandEnvRefs(mdKeyRaw, "options.marketdata.api_key") : "";
  return {
    enabled: normalizeBool(raw.enabled, "options.enabled", false),
    provider: (typeof raw.provider === "string" ? raw.provider : "yfinance") as any,
    symbols: Array.isArray(raw.symbols) ? raw.symbols.map(String) : ["SPY", "QQQ"],
    pollIntervalSeconds: coerceInt(raw.poll_interval_seconds, "options.poll_interval_seconds", 60),
    strikeRangePercent: coerceFloat(raw.strike_range_percent, "options.strike_range_percent", 0.15),
    riskFreeRate: coerceFloat(raw.risk_free_rate, "options.risk_free_rate", 0.0363),
    dividendYield: coerceFloat(raw.dividend_yield, "options.dividend_yield", 0.015),
    tradier: rawTradier.api_key ? {
      apiKey: expandEnvRefs(String(rawTradier.api_key), "options.tradier.api_key"),
      apiKeyRaw: String(rawTradier.api_key),
      baseUrl: typeof rawTradier.base_url === "string" ? rawTradier.base_url : "https://sandbox.tradier.com/v1",
    } : undefined,
    marketdata: mdKey ? {
      apiKey: mdKey,
      apiKeyRaw: mdKeyRaw,
      baseUrl: typeof rawMarketData.base_url === "string" ? rawMarketData.base_url : "https://api.marketdata.app/v1",
      strikeLimit: rawMarketData.strike_limit != null ? coerceInt(rawMarketData.strike_limit, "options.marketdata.strike_limit", 80) : undefined,
      dte: rawMarketData.dte != null ? coerceInt(rawMarketData.dte, "options.marketdata.dte", 7) : undefined,
      callsPerMinute: rawMarketData.calls_per_minute != null ? coerceInt(rawMarketData.calls_per_minute, "options.marketdata.calls_per_minute", 30) : undefined,
    } : undefined,
    deribit: {
      enabled: normalizeBool(rawDeribit.enabled, "options.deribit.enabled", false),
      currencies: Array.isArray(rawDeribit.currencies) ? rawDeribit.currencies.map(String) : ["BTC", "ETH"],
    },
    alerts: {
      minOiChange: coerceInt(rawAlerts.min_oi_change, "options.alerts.min_oi_change", 1000),
      minVolumeOiRatio: coerceFloat(rawAlerts.min_volume_oi_ratio, "options.alerts.min_volume_oi_ratio", 3.0),
      minPremium: coerceInt(rawAlerts.min_premium, "options.alerts.min_premium", 100_000),
    },
  };
}
