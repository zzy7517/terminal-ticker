import { asRecord, coerceMinInt, normalizeBool, parseSecretField } from "../config/parsing.js";
import type { MacroConfig } from "./domain.js";

export function parseMacroConfig(rawMacroValue: unknown): MacroConfig {
  const raw = asRecord(rawMacroValue ?? {}, "macro");
  const window = asRecord(raw.event_window ?? {}, "macro.event_window");
  const rawImpact = typeof window.min_impact === "string" ? window.min_impact.trim().toLowerCase() : "high";
  const minImpact = rawImpact === "low" || rawImpact === "medium" ? rawImpact : "high";
  const fredKey = parseSecretField(raw.fred_api_key, "macro.fred_api_key");
  const twelveDataKey = parseSecretField(raw.twelve_data_api_key, "macro.twelve_data_api_key");
  return {
    enabled: normalizeBool(raw.enabled, "macro.enabled", false),
    fredApiKey: fredKey.value,
    fredApiKeyRaw: fredKey.raw,
    backfillYears: coerceMinInt(raw.backfill_years, "macro.backfill_years", 2, 1),
    fredPollIntervalSeconds: coerceMinInt(
      raw.fred_poll_interval_seconds,
      "macro.fred_poll_interval_seconds",
      6 * 60 * 60,
      600,
    ),
    twelveDataApiKey: twelveDataKey.value,
    twelveDataApiKeyRaw: twelveDataKey.raw,
    calendarEnabled: normalizeBool(raw.calendar_enabled, "macro.calendar_enabled", true),
    calendarPollIntervalSeconds: coerceMinInt(
      raw.calendar_poll_interval_seconds,
      "macro.calendar_poll_interval_seconds",
      300,
      60,
    ),
    forexfactoryCalendarEnabled: normalizeBool(
      raw.forexfactory_calendar_enabled,
      "macro.forexfactory_calendar_enabled",
      true,
    ),
    cryptoEnabled: normalizeBool(raw.crypto_enabled, "macro.crypto_enabled", true),
    cryptoPollIntervalSeconds: coerceMinInt(
      raw.crypto_poll_interval_seconds,
      "macro.crypto_poll_interval_seconds",
      300,
      60,
    ),
    quotesEnabled: normalizeBool(raw.quotes_enabled, "macro.quotes_enabled", true),
    quotesPollIntervalSeconds: coerceMinInt(
      raw.quotes_poll_interval_seconds,
      "macro.quotes_poll_interval_seconds",
      6 * 60 * 60,
      600,
    ),
    eventWindow: {
      minImpact,
      beforeMinutes: coerceMinInt(window.before_minutes, "macro.event_window.before_minutes", 15, 0),
      afterMinutes: coerceMinInt(window.after_minutes, "macro.event_window.after_minutes", 15, 0),
      blockTrades: normalizeBool(window.block_trades, "macro.event_window.block_trades", true),
    },
  };
}
