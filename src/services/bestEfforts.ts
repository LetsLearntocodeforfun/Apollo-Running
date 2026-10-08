/**
 * Best efforts (B1): the fastest time over standard distances found INSIDE an
 * activity, from its splits (or per-second samples), instead of crediting a
 * whole activity's time to the nearest distance bucket. The old bucket logic
 * made a fast 10.9 km run the "10K PR" (with its full 10.9 km time) and never
 * found the 10K inside a half marathon.
 *
 * Pure: never writes to storage. Results are memoized per activity object
 * (store records are stable objects until the store changes).
 */
import type { Activity, ActivitySplit, BestEffort, BestEffortKey } from './activity/types';
import { isRunActivity } from './activity/sports';

export interface BestEffortDistance {
  key: BestEffortKey;
  meters: number;
  label: string;
}

/** Distances Apollo tracks records for (labels match the Analytics PR list). */
export const BEST_EFFORT_DISTANCES: readonly BestEffortDistance[] = [
  { key: '1k', meters: 1000, label: '1K' },
  { key: '1mi', meters: 1609.344, label: '1 Mile' },
  { key: '5k', meters: 5000, label: '5K' },
  { key: '10k', meters: 10000, label: '10K' },
  { key: '15k', meters: 15000, label: '15K' },
  { key: 'hm', meters: 21097.5, label: 'Half Marathon' },
  { key: '20mi', meters: 32186.88, label: '20 Miles' },
  { key: 'm', meters: 42195, label: 'Marathon' },
];

/** Without splits, a whole activity counts only when it is at most 2 % longer than the distance. */
export const WHOLE_ACTIVITY_TOLERANCE = 0.02;

/** Rounding slack in meters (split distances are often 999.8 m and the like). */
const EPS = 0.5;

/** Cumulative distance (m, non-decreasing) against elapsed time (s). */
interface Curve {
  d: number[];
  t: number[];
}

/** Smallest k with d[k] >= x (d.length when none). */
function lowerIndex(d: number[], x: number): number {
  let lo = 0;
  let hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Largest k with d[k] <= x (-1 when none). */
function upperIndex(d: number[], x: number): number {
  let lo = 0;
  let hi = d.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (d[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Earliest time the curve reaches distance x (constant pace inside a segment). */
function firstTimeAt(c: Curve, x: number): number | null {
  const k = lowerIndex(c.d, x);
  if (k >= c.d.length) return null;
  if (k === 0) return c.t[0];
  const d0 = c.d[k - 1];
  const d1 = c.d[k];
  return c.t[k - 1] + ((x - d0) / (d1 - d0)) * (c.t[k] - c.t[k - 1]);
}

/** Latest time the curve is still at distance x (skips standing still at the start of a window). */
function lastTimeAt(c: Curve, x: number): number | null {
  const k = upperIndex(c.d, x);
  if (k < 0) return null;
  if (k === c.d.length - 1) return c.t[k];
  const d0 = c.d[k];
  const d1 = c.d[k + 1];
  return c.t[k] + ((x - d0) / (d1 - d0)) * (c.t[k + 1] - c.t[k]);
}

/**
 * Fastest contiguous window of `target` meters. On a piecewise-linear curve
 * the optimum has one end on a breakpoint, so it suffices to try windows that
 * start at each breakpoint and windows that end at each breakpoint.
 */
export function fastestWindow(c: Curve, target: number): { elapsedSec: number; startM: number } | null {
  const n = c.d.length;
  if (n < 2) return null;
  const first = c.d[0];
  const last = c.d[n - 1];
  if (last - first < target - EPS) return null;
  let bestSec = Infinity;
  let bestStart = 0;
  for (let i = 0; i < n; i++) {
    const s = c.d[i];
    if (s + target > last + EPS) break;
    const t0 = lastTimeAt(c, s);
    const t1 = firstTimeAt(c, Math.min(s + target, last));
    if (t0 != null && t1 != null && t1 - t0 > 0 && t1 - t0 < bestSec - 1e-9) {
      bestSec = t1 - t0;
      bestStart = s;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    const s = Math.max(first, c.d[j] - target);
    if (c.d[j] - target < first - EPS) break;
    const t0 = lastTimeAt(c, s);
    const t1 = firstTimeAt(c, c.d[j]);
    if (t0 != null && t1 != null && t1 - t0 > 0 && t1 - t0 < bestSec - 1e-9) {
      bestSec = t1 - t0;
      bestStart = s;
    }
  }
  return Number.isFinite(bestSec) ? { elapsedSec: bestSec, startM: bestStart } : null;
}

function effortsFromCurve(c: Curve, source: BestEffort['source']): BestEffort[] {
  const out: BestEffort[] = [];
  for (const dist of BEST_EFFORT_DISTANCES) {
    const w = fastestWindow(c, dist.meters);
    if (w) out.push({ key: dist.key, distanceM: dist.meters, elapsedSec: w.elapsedSec, startM: w.startM, source });
  }
  return out;
}

/** Cumulative curve from splits (elapsed time, so stops count, as in races). The partial last split interpolates. */
function curveFromSplits(splits: readonly ActivitySplit[]): Curve | null {
  const d = [0];
  const t = [0];
  for (const s of splits) {
    const dist = Math.max(0, Number(s.distance) || 0);
    const time = Math.max(0, Number(s.elapsed_time) || Number(s.moving_time) || 0);
    if (time <= 0) continue;
    d.push(d[d.length - 1] + dist);
    t.push(t[t.length - 1] + time);
  }
  return d.length > 1 ? { d, t } : null;
}

/** Best efforts from per-km or per-mile splits (contiguous windows; the partial last split is interpolated). */
export function bestEffortsFromSplits(splits: readonly ActivitySplit[]): BestEffort[] {
  const c = curveFromSplits(splits);
  return c ? effortsFromCurve(c, 'splits') : [];
}

/** Best efforts from distance/time samples (e.g. a FIT or GPX stream). */
export function bestEffortsFromSamples(samples: readonly { timeSec: number; distanceM: number }[]): BestEffort[] {
  const d: number[] = [];
  const t: number[] = [];
  let maxD = 0;
  for (const s of samples) {
    if (!Number.isFinite(s.timeSec) || !Number.isFinite(s.distanceM)) continue;
    if (t.length > 0 && s.timeSec < t[t.length - 1]) continue;
    maxD = Math.max(maxD, s.distanceM, d.length > 0 ? d[d.length - 1] : 0);
    d.push(maxD);
    t.push(s.timeSec);
  }
  return d.length > 1 ? effortsFromCurve({ d, t }, 'stream') : [];
}

/** No usable splits: the whole activity counts only within [m, m·1.02], scaled to exactly m. */
function wholeActivityEfforts(a: Activity): BestEffort[] {
  const time = a.elapsed_time || a.moving_time || 0;
  if (!(a.distance > 0) || !(time > 0)) return [];
  const out: BestEffort[] = [];
  for (const dist of BEST_EFFORT_DISTANCES) {
    if (a.distance >= dist.meters - EPS && a.distance <= dist.meters * (1 + WHOLE_ACTIVITY_TOLERANCE)) {
      out.push({
        key: dist.key,
        distanceM: dist.meters,
        elapsedSec: time * Math.min(1, dist.meters / a.distance),
        startM: 0,
        source: 'activity',
      });
    }
  }
  return out;
}

const memo = new WeakMap<Activity, BestEffort[]>();

/**
 * Best efforts of one activity: stored `best_efforts` (from streams at import)
 * when present, else from splits that cover the activity, else the
 * whole-activity fallback. Memoized per record object.
 */
export function getActivityBestEfforts(a: Activity): BestEffort[] {
  const hit = memo.get(a);
  if (hit) return hit;
  let efforts: BestEffort[];
  if (a.best_efforts && a.best_efforts.length > 0) {
    efforts = a.best_efforts;
  } else {
    const splits = a.splits_metric?.length ? a.splits_metric : a.splits_standard?.length ? a.splits_standard : null;
    const c = splits ? curveFromSplits(splits) : null;
    // Splits must cover (nearly) the whole activity to be trusted for every distance.
    efforts = c && c.d[c.d.length - 1] >= a.distance * 0.97 ? effortsFromCurve(c, 'splits') : wholeActivityEfforts(a);
  }
  memo.set(a, efforts);
  return efforts;
}

/** Treadmill / virtual runs: their distances are estimates, so they never set records. */
export function isIndoorActivity(a: Activity): boolean {
  return !!a.trainer || a.type === 'VirtualRun' || a.sport_type === 'VirtualRun';
}

export interface EffortRecord {
  key: BestEffortKey;
  label: string;
  distanceM: number;
  elapsedSec: number;
  activity: Activity;
}

/**
 * Personal records per distance from best efforts. Hidden activities are
 * ignored, and treadmill / virtual runs unless `includeIndoor`. Ties go to
 * the earlier run (the first to set the time).
 */
export function detectPersonalRecordsFromEfforts(
  activities: readonly Activity[],
  opts: { includeIndoor?: boolean } = {},
): EffortRecord[] {
  const runs = activities
    .filter((a) => isRunActivity(a) && !a.hidden && (opts.includeIndoor || !isIndoorActivity(a)))
    .sort((x, y) => (x.start_date_local ?? '').localeCompare(y.start_date_local ?? ''));
  const out: EffortRecord[] = [];
  for (const dist of BEST_EFFORT_DISTANCES) {
    let best: EffortRecord | null = null;
    for (const a of runs) {
      const e = getActivityBestEfforts(a).find((x) => x.key === dist.key);
      if (e && (best === null || e.elapsedSec < best.elapsedSec - 1e-9)) {
        best = { key: dist.key, label: dist.label, distanceM: dist.meters, elapsedSec: e.elapsedSec, activity: a };
      }
    }
    if (best) out.push(best);
  }
  return out;
}
