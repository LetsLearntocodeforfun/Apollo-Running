/**
 * Local calendar-date helpers (v1.0.6).
 *
 * A "date key" is a `YYYY-MM-DD` string in the athlete's LOCAL calendar.
 * All arithmetic is done with `Date.UTC(y, m, d)` on the key's components,
 * so daylight-saving transitions (23 h / 25 h days) can never shift a day.
 *
 * Use these helpers instead of subtracting `Date.getTime()` values between
 * local midnights and dividing by 86 400 000 — that pattern is off by one
 * across a spring-forward boundary.
 *
 * Note: activity `start_date_local` values carry a fake trailing "Z" (they are
 * NOT UTC). Never pass them to `new Date()`; use {@link dateKeyFromLocalIso}.
 */

export type DateKey = string;

const MS_PER_DAY = 86_400_000;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** True if `s` is a syntactically valid, real calendar date key (YYYY-MM-DD). */
export function isDateKey(s: unknown): s is DateKey {
  if (typeof s !== 'string') return false;
  const m = DATE_KEY_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const utc = new Date(Date.UTC(y, mo - 1, d));
  return utc.getUTCFullYear() === y && utc.getUTCMonth() === mo - 1 && utc.getUTCDate() === d;
}

function parts(key: DateKey): [number, number, number] {
  const m = DATE_KEY_RE.exec(key);
  if (!m) throw new RangeError(`Invalid date key: ${String(key)}`);
  return [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
}

function utcMs(key: DateKey): number {
  const [y, m, d] = parts(key);
  return Date.UTC(y, m, d);
}

function fromUtcMs(ms: number): DateKey {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Local calendar date of a Date object as a key (no UTC drift). */
export function toDateKey(date: Date): DateKey {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Local midnight Date for a key. Throws RangeError on malformed input. */
export function parseDateKey(key: DateKey): Date {
  const [y, m, d] = parts(key);
  return new Date(y, m, d, 0, 0, 0, 0);
}

/** Today's local date key. */
export function todayKey(now: Date = new Date()): DateKey {
  return toDateKey(now);
}

/** Whole calendar days from `a` to `b` (positive when `b` is later). DST-safe. */
export function daysBetween(a: DateKey, b: DateKey): number {
  return Math.round((utcMs(b) - utcMs(a)) / MS_PER_DAY);
}

/** Key `n` calendar days after `key` (n may be negative). DST-safe. */
export function addDays(key: DateKey, n: number): DateKey {
  return fromUtcMs(utcMs(key) + Math.round(n) * MS_PER_DAY);
}

/** Day of week with Monday = 0 … Sunday = 6 (the plan grid convention). */
export function weekdayMon0(key: DateKey): number {
  const dow = new Date(utcMs(key)).getUTCDay(); // 0 = Sunday
  return (dow + 6) % 7;
}

/** Monday on or before `key`. */
export function mondayOf(key: DateKey): DateKey {
  return addDays(key, -weekdayMon0(key));
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareDateKeys(a: DateKey, b: DateKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Local date key from an activity's `start_date_local` (or any ISO-like string
 * whose first 10 characters are the local calendar date). Returns null when the
 * input doesn't start with a valid date.
 */
export function dateKeyFromLocalIso(isoLocal: string | null | undefined): DateKey | null {
  if (!isoLocal || isoLocal.length < 10) return null;
  const key = isoLocal.slice(0, 10);
  return isDateKey(key) ? key : null;
}

/** Inclusive list of keys from `from` to `to`. Empty when `to` < `from`. */
export function eachDay(from: DateKey, to: DateKey): DateKey[] {
  const n = daysBetween(from, to);
  const out: DateKey[] = [];
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

/** Short weekday label ("Mon" … "Sun") for a key, independent of locale. */
export function weekdayShort(key: DateKey): string {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][weekdayMon0(key)];
}
