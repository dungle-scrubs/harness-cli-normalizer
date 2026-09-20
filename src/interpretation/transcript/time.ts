/**
 * The native start times, in the one shape a listing row reports.
 *
 * The six stores write four shapes for the same fact: ISO 8601 UTC with
 * milliseconds (claude, codex, pi), ISO 8601 UTC at second precision
 * (antigravity), epoch microseconds (muse) and epoch milliseconds (cursor).
 * A row that carried them as written could not be compared or sorted, so
 * every one is converted here. This layer cannot construct a `Date`, so the
 * civil-date arithmetic is written out.
 */

const MILLIS_PER_DAY = 86400000;
/** The outer span a `Date` can name; a cheap guard before the arithmetic. */
const MAX_EPOCH_MILLIS = 8.64e15;
/** Years a four-digit ISO 8601 date can name. Beyond them the format needs
 * its expanded `+275760-09-13` form, which no native store writes and no
 * consumer of this field should have to parse. */
const MIN_YEAR = 1;
const MAX_YEAR = 9999;
/** `YYYY-MM-DDTHH:MM:SS`, a space or `T`, optional fraction, and UTC. */
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** The civil date `days` whole days after 1970-01-01, by Howard Hinnant's
 * `civil_from_days`. */
function civilFromDays(days: number): { year: number; month: number; day: number } {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  const year = yearOfEra + era * 400;
  return { year: month <= 2 ? year + 1 : year, month, day };
}

/** A native ISO 8601 UTC time at millisecond precision, or null when the text
 * is not one. A store that names an offset rather than `Z` reports null
 * rather than being read as UTC. */
export function utcTime(text: string): string | null {
  const match = ISO_UTC.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = ""] = match;
  const millis = `${fraction}000`.slice(0, 3);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millis}Z`;
}

/** Epoch milliseconds as a UTC time, or null outside the span a date names. */
export function utcTimeFromEpochMillis(millis: number): string | null {
  if (!Number.isFinite(millis) || Math.abs(millis) > MAX_EPOCH_MILLIS) return null;
  const whole = Math.floor(millis);
  const days = Math.floor(whole / MILLIS_PER_DAY);
  const inDay = whole - days * MILLIS_PER_DAY;
  const { year, month, day } = civilFromDays(days);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  const hour = Math.floor(inDay / 3600000);
  const minute = Math.floor(inDay / 60000) % 60;
  const second = Math.floor(inDay / 1000) % 60;
  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}.${pad(inDay % 1000, 3)}Z`
  );
}

/** Epoch microseconds as a UTC time. Muse counts in microseconds; the
 * sub-millisecond digits are dropped rather than rounded, so the reported
 * time never runs ahead of the native one. */
export function utcTimeFromEpochMicros(micros: number): string | null {
  if (!Number.isFinite(micros)) return null;
  return utcTimeFromEpochMillis(Math.floor(micros / 1000));
}
