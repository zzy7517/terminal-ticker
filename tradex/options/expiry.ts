/**
 * Option expiration time helpers.
 *
 * US equity/ETF options expire at the 4:00 PM America/New_York close. The
 * previous implementation hardcoded the EDT offset ("-04:00"), which made
 * every TTE calculation off by one hour during winter (EST, "-05:00") and
 * could mark a contract expired while the market was still open.
 *
 * Note: crypto options (Deribit) actually expire at 08:00 UTC; the equity
 * close is still used for them, which overstates TTE by ~12h on expiry day.
 */

const NY_OFFSET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  timeZoneName: "longOffset",
});

/** Offset of America/New_York from UTC in minutes (negative, e.g. -240 or -300). */
function newYorkOffsetMinutes(at: Date): number {
  const name = NY_OFFSET_FORMATTER.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT-04:00";
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return -240;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}

/**
 * UTC timestamp (ms) of 16:00 America/New_York on the given ISO date
 * ("YYYY-MM-DD"), DST-aware. Returns NaN for unparseable input.
 */
export function expiryCloseMs(expiration: string): number {
  const guess = Date.parse(`${expiration}T16:00:00-04:00`);
  if (!Number.isFinite(guess)) return NaN;
  const offsetMinutes = newYorkOffsetMinutes(new Date(guess));
  // 16:00 local == 16:00 UTC minus the (negative) offset.
  return Date.parse(`${expiration}T16:00:00Z`) - offsetMinutes * 60_000;
}

/** Time to expiration in years (365.25-day basis); 0 when expired or invalid. */
export function yearsToExpiry(expiration: string, nowMs: number): number {
  const diffMs = expiryCloseMs(expiration) - nowMs;
  if (!Number.isFinite(diffMs) || diffMs <= 0) return 0;
  return diffMs / (365.25 * 24 * 3600 * 1000);
}
