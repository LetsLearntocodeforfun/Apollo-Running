/**
 * splitService.ts — Split & Lap Analysis Engine for Apollo Running.
 *
 * Analyzes per-split and per-lap data from Strava to provide:
 *   - Per-split pace, HR, elevation breakdowns
 *   - Pace consistency scoring (coefficient of variation)
 *   - Negative/positive split detection and grading
 *   - Interval workout recognition from lap patterns
 *   - Even-split gold badge system
 *   - Detailed split-by-split comparison insights
 *
 * All data stays local. Works with both metric (km) and standard (mi) splits.
 */

import type { StravaActivity, StravaSplit, StravaLap } from './strava';
import { getDistanceUnit, formatPaceShort, type DistanceUnit } from './unitPreferences';
import { persistence } from './db/persistence';

// ─── Types ───────────────────────────────────────────────────

export interface SplitData {
  /** 1-indexed split number */
  number: number;
  /** Distance in meters */
  distanceMeters: number;
  /** Moving time in seconds */
  movingTimeSec: number;
  /** Pace in min per user unit */
  paceMinPerUnit: number;
  /** Average heart rate (null if unavailable) */
  avgHR: number | null;
  /** Elevation change in meters (+ or -) */
  elevationDiffMeters: number;
  /** Average speed in m/s */
  avgSpeedMs: number;
  /** Whether this is the fastest split */
  isFastest: boolean;
  /** Whether this is the slowest split */
  isSlowest: boolean;
  /** Deviation from mean pace as percentage (negative = faster, positive = slower) */
  paceDeviationPct: number;
}

export interface LapData {
  /** 0-indexed lap position */
  index: number;
  /** Lap name (e.g. "Lap 1", "Interval", or custom) */
  name: string;
  /** Distance in meters */
  distanceMeters: number;
  /** Moving time in seconds */
  movingTimeSec: number;
  /** Elapsed time in seconds (includes stops) */
  elapsedTimeSec: number;
  /** Pace in min per user unit */
  paceMinPerUnit: number;
  /** Average heart rate (null if unavailable) */
  avgHR: number | null;
  /** Max heart rate (null if unavailable) */
  maxHR: number | null;
  /** Average cadence in spm (null if unavailable) */
  avgCadenceSpm: number | null;
  /** Total elevation gain in meters */
  elevationGainMeters: number;
  /** Average speed in m/s */
  avgSpeedMs: number;
}

export type PaceConsistencyGrade = 'gold' | 'silver' | 'bronze' | 'iron';

export interface PaceConsistencyAnalysis {
  /** Coefficient of variation of split paces (lower = more consistent) */
  coefficientOfVariation: number;
  /** Grade based on CV: gold (<4%), silver (<7%), bronze (<12%), iron (>=12%) */
  grade: PaceConsistencyGrade;
  /** Mean pace in min/unit */
  meanPace: number;
  /** Standard deviation of pace in min/unit */
  stdDevPace: number;
  /** Fastest split pace in min/unit */
  fastestPace: number;
  /** Slowest split pace in min/unit */
  slowestPace: number;
  /** Fastest-to-slowest range in seconds */
  rangeSec: number;
}

export type SplitPattern = 'negative' | 'positive' | 'even' | 'variable' | 'fade' | 'surge';

export interface SplitPatternAnalysis {
  /** Detected split pattern */
  pattern: SplitPattern;
  /** Human-readable description */
  description: string;
  /** Average pace of first half in min/unit */
  firstHalfPace: number;
  /** Average pace of second half in min/unit */
  secondHalfPace: number;
  /** Percentage difference: negative = negative split (faster 2nd half) */
  halfDiffPct: number;
}

export interface IntervalDetection {
  /** Whether the laps suggest an interval workout */
  isInterval: boolean;
  /** Number of work intervals detected */
  workIntervals: number;
  /** Number of recovery intervals detected */
  recoveryIntervals: number;
  /** Average work interval pace */
  avgWorkPace: number;
  /** Average recovery interval pace */
  avgRecoveryPace: number;
  /** Work:rest ratio description */
  workRestRatio: string;
}

export interface SplitAnalysis {
  /** Processed splits in the user's preferred unit */
  splits: SplitData[];
  /** Processed laps (if available) */
  laps: LapData[];
  /** Pace consistency grade + metrics */
  consistency: PaceConsistencyAnalysis;
  /** Split pattern detection (negative/positive/even/etc) */
  pattern: SplitPatternAnalysis;
  /** Interval workout detection (from laps) */
  intervals: IntervalDetection | null;
  /** Data-driven insight strings */
  insights: SplitInsight[];
  /** Which unit system was used for analysis */
  unit: DistanceUnit;
  /** Activity ID this analysis belongs to */
  activityId: number;
  /** Timestamp of analysis */
  analyzedAt: string;
}

export interface SplitInsight {
  category: 'consistency' | 'pattern' | 'interval' | 'progression' | 'heartrate';
  message: string;
  sentiment: 'positive' | 'neutral' | 'negative';
}

// ─── Constants ───────────────────────────────────────────────

const SPLIT_CACHE_KEY = 'apollo_split_analyses';
const MAX_CACHED_ANALYSES = 200;

const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;

/** CV thresholds for pace consistency grade */
const CV_GOLD = 4;    // < 4% — metronomic pacing
const CV_SILVER = 7;  // < 7% — strong pacing
const CV_BRONZE = 12; // < 12% — acceptable variation

/** Half difference thresholds for split pattern */
const NEGATIVE_SPLIT_PCT = -2;  // 2nd half > 2% faster
const POSITIVE_SPLIT_PCT = 2;   // 1st half > 2% faster
const EVEN_SPLIT_PCT = 2;       // within ±2%
const FADE_THRESHOLD_PCT = 8;   // severe slowdown in last quarter
const SURGE_THRESHOLD_PCT = -8; // severe speedup in last quarter

/** Minimum number of splits for meaningful analysis */
const MIN_SPLITS = 2;

/** Minimum split distance to include (filters out partials < 40%) */
const MIN_SPLIT_FRACTION = 0.4;

/** Pace difference ratio for interval detection (work vs rest) */
const INTERVAL_PACE_RATIO = 1.15;

// ─── Core Analysis Functions ─────────────────────────────────

/**
 * Convert raw Strava splits to SplitData with user-preferred units.
 * Filters out very short partial splits at the end.
 */
export function processSplits(
  rawSplits: StravaSplit[],
  unit: DistanceUnit,
): SplitData[] {
  if (!rawSplits || rawSplits.length < MIN_SPLITS) return [];

  const expectedDist = unit === 'km' ? METERS_PER_KM : METERS_PER_MILE;

  // Filter out very short final partial splits
  const filtered = rawSplits.filter(
    (s) => s.distance >= expectedDist * MIN_SPLIT_FRACTION,
  );

  if (filtered.length < MIN_SPLITS) return [];

  // Calculate paces
  const withPace = filtered.map((s) => {
    const distUnits = s.distance / expectedDist;
    const paceMinPerUnit = distUnits > 0 ? (s.moving_time / 60) / distUnits : 0;
    return { split: s, paceMinPerUnit };
  });

  // Calculate mean pace (only full-ish splits)
  const fullSplits = withPace.filter((s) => s.split.distance >= expectedDist * 0.9);
  const meanPace =
    fullSplits.length > 0
      ? fullSplits.reduce((sum, s) => sum + s.paceMinPerUnit, 0) / fullSplits.length
      : withPace.reduce((sum, s) => sum + s.paceMinPerUnit, 0) / withPace.length;

  // Find fastest and slowest (among full splits)
  const paces = fullSplits.map((s) => s.paceMinPerUnit);
  const fastest = Math.min(...paces);
  const slowest = Math.max(...paces);

  return withPace.map((s) => ({
    number: s.split.split,
    distanceMeters: s.split.distance,
    movingTimeSec: s.split.moving_time,
    paceMinPerUnit: s.paceMinPerUnit,
    avgHR: s.split.average_heartrate ?? null,
    elevationDiffMeters: s.split.elevation_difference,
    avgSpeedMs: s.split.average_speed,
    isFastest: s.paceMinPerUnit === fastest && s.split.distance >= expectedDist * 0.9,
    isSlowest: s.paceMinPerUnit === slowest && s.split.distance >= expectedDist * 0.9,
    paceDeviationPct: meanPace > 0 ? ((s.paceMinPerUnit - meanPace) / meanPace) * 100 : 0,
  }));
}

/** Convert raw Strava laps to LapData. */
export function processLaps(
  rawLaps: StravaLap[],
  unit: DistanceUnit,
): LapData[] {
  if (!rawLaps || rawLaps.length === 0) return [];

  const divisor = unit === 'km' ? METERS_PER_KM : METERS_PER_MILE;

  return rawLaps.map((lap) => {
    const distUnits = lap.distance / divisor;
    const paceMinPerUnit = distUnits > 0 ? (lap.moving_time / 60) / distUnits : 0;

    return {
      index: lap.lap_index,
      name: lap.name,
      distanceMeters: lap.distance,
      movingTimeSec: lap.moving_time,
      elapsedTimeSec: lap.elapsed_time,
      paceMinPerUnit,
      avgHR: lap.average_heartrate ?? null,
      maxHR: lap.max_heartrate ?? null,
      avgCadenceSpm: lap.average_cadence ? Math.round(lap.average_cadence * 2) : null,
      elevationGainMeters: lap.total_elevation_gain,
      avgSpeedMs: lap.average_speed,
    };
  });
}

/** Analyze pace consistency across splits. */
export function analyzePaceConsistency(splits: SplitData[]): PaceConsistencyAnalysis {
  // Use full-distance splits only for consistency analysis
  // Only exclude the fastest split if it's a single outlier (not when all are equal)
  const fastestCount = splits.filter((s) => s.isFastest).length;
  const paces = splits
    .filter((s) => !(s.isFastest && fastestCount === 1) || splits.length <= 3)
    .map((s) => s.paceMinPerUnit)
    .filter((p) => p > 0);

  if (paces.length < MIN_SPLITS) {
    return {
      coefficientOfVariation: 0,
      grade: 'iron',
      meanPace: 0,
      stdDevPace: 0,
      fastestPace: 0,
      slowestPace: 0,
      rangeSec: 0,
    };
  }

  const mean = paces.reduce((a, b) => a + b, 0) / paces.length;
  const variance = paces.reduce((sum, p) => sum + (p - mean) ** 2, 0) / paces.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? (stdDev / mean) * 100 : 0;

  const fastest = Math.min(...paces);
  const slowest = Math.max(...paces);
  const rangeSec = Math.round((slowest - fastest) * 60);

  let grade: PaceConsistencyGrade;
  if (cv < CV_GOLD) grade = 'gold';
  else if (cv < CV_SILVER) grade = 'silver';
  else if (cv < CV_BRONZE) grade = 'bronze';
  else grade = 'iron';

  return {
    coefficientOfVariation: cv,
    grade,
    meanPace: mean,
    stdDevPace: stdDev,
    fastestPace: fastest,
    slowestPace: slowest,
    rangeSec,
  };
}

/** Detect the overall split pattern (negative/positive/even/fade/surge). */
export function detectSplitPattern(splits: SplitData[], unit: DistanceUnit): SplitPatternAnalysis {
  const empty: SplitPatternAnalysis = {
    pattern: 'variable',
    description: 'Insufficient data',
    firstHalfPace: 0,
    secondHalfPace: 0,
    halfDiffPct: 0,
  };

  if (splits.length < 3) return empty;

  const midpoint = Math.floor(splits.length / 2);
  const firstHalf = splits.slice(0, midpoint);
  const secondHalf = splits.slice(midpoint);

  const avgPace = (arr: SplitData[]) => {
    const p = arr.filter((s) => s.paceMinPerUnit > 0);
    return p.length > 0 ? p.reduce((s, v) => s + v.paceMinPerUnit, 0) / p.length : 0;
  };

  const firstHalfPace = avgPace(firstHalf);
  const secondHalfPace = avgPace(secondHalf);

  if (!firstHalfPace || !secondHalfPace) return empty;

  // Negative = second half is FASTER (lower pace number)
  const halfDiffPct = ((secondHalfPace - firstHalfPace) / firstHalfPace) * 100;

  // Check for fade or surge in last quarter
  const lastQuarterStart = Math.floor(splits.length * 0.75);
  const lastQuarter = splits.slice(lastQuarterStart);
  const restSplits = splits.slice(0, lastQuarterStart);
  const lastQuarterPace = avgPace(lastQuarter);
  const restPace = avgPace(restSplits);
  const lastQuarterDiff = restPace > 0 ? ((lastQuarterPace - restPace) / restPace) * 100 : 0;

  const unitName = unit === 'km' ? 'km' : 'mile';

  let pattern: SplitPattern;
  let description: string;

  if (lastQuarterDiff >= FADE_THRESHOLD_PCT) {
    pattern = 'fade';
    description = `Significant pace fade in the final ${lastQuarter.length} ${unitName}${lastQuarter.length > 1 ? 's' : ''} — pacing slowed ${Math.abs(lastQuarterDiff).toFixed(1)}% vs the earlier splits`;
  } else if (lastQuarterDiff <= SURGE_THRESHOLD_PCT) {
    pattern = 'surge';
    description = `Strong finish — you surged ${Math.abs(lastQuarterDiff).toFixed(1)}% faster over the final ${lastQuarter.length} ${unitName}${lastQuarter.length > 1 ? 's' : ''}`;
  } else if (halfDiffPct < NEGATIVE_SPLIT_PCT) {
    pattern = 'negative';
    description = `Negative split — second half ${Math.abs(halfDiffPct).toFixed(1)}% faster. Textbook marathon pacing`;
  } else if (halfDiffPct > POSITIVE_SPLIT_PCT) {
    pattern = 'positive';
    description = `Positive split — first half was ${halfDiffPct.toFixed(1)}% faster than the second`;
  } else if (Math.abs(halfDiffPct) <= EVEN_SPLIT_PCT) {
    pattern = 'even';
    description = `Even split pacing — first and second half within ${Math.abs(halfDiffPct).toFixed(1)}% of each other`;
  } else {
    pattern = 'variable';
    description = 'Variable pacing across the run';
  }

  return { pattern, description, firstHalfPace, secondHalfPace, halfDiffPct };
}

/** Detect if laps represent an interval workout. */
export function detectIntervals(laps: LapData[]): IntervalDetection | null {
  // Need at least 3 laps (work-rest-work) to detect intervals
  if (laps.length < 3) return null;

  // Sort paces to find the median
  const paces = laps
    .filter((l) => l.paceMinPerUnit > 0)
    .map((l) => l.paceMinPerUnit);

  if (paces.length < 3) return null;

  const sortedPaces = [...paces].sort((a, b) => a - b);
  const median = sortedPaces[Math.floor(sortedPaces.length / 2)];

  // Classify each lap as work (faster than median × threshold) or recovery
  const work: LapData[] = [];
  const recovery: LapData[] = [];

  for (const lap of laps) {
    if (lap.paceMinPerUnit <= 0) continue;
    // Work = faster pace (lower number), recovery = slower
    if (lap.paceMinPerUnit < median * (1 / INTERVAL_PACE_RATIO)) {
      work.push(lap);
    } else if (lap.paceMinPerUnit > median * INTERVAL_PACE_RATIO) {
      recovery.push(lap);
    }
  }

  // Must have at least 2 work intervals to call it an interval workout
  if (work.length < 2) {
    return { isInterval: false, workIntervals: 0, recoveryIntervals: 0, avgWorkPace: 0, avgRecoveryPace: 0, workRestRatio: '' };
  }

  const avgWorkPace = work.reduce((s, l) => s + l.paceMinPerUnit, 0) / work.length;
  const avgRecoveryPace = recovery.length > 0
    ? recovery.reduce((s, l) => s + l.paceMinPerUnit, 0) / recovery.length
    : 0;

  const avgWorkTime = work.reduce((s, l) => s + l.movingTimeSec, 0) / work.length;
  const avgRestTime = recovery.length > 0
    ? recovery.reduce((s, l) => s + l.movingTimeSec, 0) / recovery.length
    : 0;

  const ratio = avgRestTime > 0 ? `${(avgWorkTime / avgRestTime).toFixed(1)}:1` : 'N/A';

  return {
    isInterval: true,
    workIntervals: work.length,
    recoveryIntervals: recovery.length,
    avgWorkPace,
    avgRecoveryPace,
    workRestRatio: ratio,
  };
}

// ─── Insight Generation ──────────────────────────────────────

function generateInsights(
  splits: SplitData[],
  consistency: PaceConsistencyAnalysis,
  pattern: SplitPatternAnalysis,
  intervals: IntervalDetection | null,
  unit: DistanceUnit,
): SplitInsight[] {
  const insights: SplitInsight[] = [];
  const unitName = unit === 'km' ? 'km' : 'mile';

  // Consistency insights
  if (consistency.grade === 'gold' && splits.length >= 4) {
    insights.push({
      category: 'consistency',
      message: `Metronomic pacing — your splits varied by only ${consistency.coefficientOfVariation.toFixed(1)}%. This is elite-level consistency`,
      sentiment: 'positive',
    });
  } else if (consistency.grade === 'silver') {
    insights.push({
      category: 'consistency',
      message: `Strong pace control — ${consistency.coefficientOfVariation.toFixed(1)}% variation across your splits. ${consistency.rangeSec}s range from fastest to slowest`,
      sentiment: 'positive',
    });
  } else if (consistency.grade === 'bronze') {
    insights.push({
      category: 'consistency',
      message: `Moderate pace variation (${consistency.coefficientOfVariation.toFixed(1)}% CV). Aim for tighter splits on your next run — a ${consistency.rangeSec}s gap between fastest and slowest`,
      sentiment: 'neutral',
    });
  } else if (consistency.grade === 'iron' && splits.length >= 4) {
    insights.push({
      category: 'consistency',
      message: `High pace variation (${consistency.coefficientOfVariation.toFixed(1)}% CV) with a ${consistency.rangeSec}s range. Practice dialing in your target pace from ${unitName} 1`,
      sentiment: 'negative',
    });
  }

  // Pattern insights
  if (pattern.pattern === 'negative') {
    insights.push({
      category: 'pattern',
      message: pattern.description,
      sentiment: 'positive',
    });
  } else if (pattern.pattern === 'even') {
    insights.push({
      category: 'pattern',
      message: pattern.description,
      sentiment: 'positive',
    });
  } else if (pattern.pattern === 'fade') {
    insights.push({
      category: 'pattern',
      message: pattern.description,
      sentiment: 'negative',
    });
  } else if (pattern.pattern === 'surge') {
    insights.push({
      category: 'pattern',
      message: pattern.description,
      sentiment: 'positive',
    });
  } else if (pattern.pattern === 'positive' && Math.abs(pattern.halfDiffPct) > 5) {
    insights.push({
      category: 'pattern',
      message: `${pattern.description}. Starting more conservatively could help maintain pace in the second half`,
      sentiment: 'negative',
    });
  }

  // Interval insights
  if (intervals?.isInterval) {
    insights.push({
      category: 'interval',
      message: `Interval workout detected: ${intervals.workIntervals} work intervals with ${intervals.recoveryIntervals} recovery periods (${intervals.workRestRatio} work:rest ratio)`,
      sentiment: 'neutral',
    });
  }

  // HR progression insight
  const splitsWithHR = splits.filter((s) => s.avgHR && s.avgHR > 0);
  if (splitsWithHR.length >= 4) {
    const firstThirdHR = splitsWithHR.slice(0, Math.floor(splitsWithHR.length / 3));
    const lastThirdHR = splitsWithHR.slice(-Math.floor(splitsWithHR.length / 3));

    const avgFirst = firstThirdHR.reduce((s, v) => s + (v.avgHR ?? 0), 0) / firstThirdHR.length;
    const avgLast = lastThirdHR.reduce((s, v) => s + (v.avgHR ?? 0), 0) / lastThirdHR.length;

    if (avgLast > 0 && avgFirst > 0) {
      const hrDrift = ((avgLast - avgFirst) / avgFirst) * 100;
      if (hrDrift > 10) {
        insights.push({
          category: 'heartrate',
          message: `Cardiac drift of ${hrDrift.toFixed(0)}% — HR rose from ~${Math.round(avgFirst)} to ~${Math.round(avgLast)} bpm. Normal for longer runs, but consider hydration and pacing`,
          sentiment: 'neutral',
        });
      } else if (hrDrift < 3) {
        insights.push({
          category: 'heartrate',
          message: `Steady heart rate throughout — only ${hrDrift.toFixed(0)}% drift. Strong aerobic endurance`,
          sentiment: 'positive',
        });
      }
    }
  }

  // Fastest/slowest split callout
  const fastest = splits.find((s) => s.isFastest);
  const slowest = splits.find((s) => s.isSlowest);
  if (fastest && slowest && fastest.number !== slowest.number && splits.length >= 4) {
    if (fastest.number === 1 && slowest.number === splits.length) {
      insights.push({
        category: 'progression',
        message: `You started fast (${unitName} 1) and finished slowest (${unitName} ${splits.length}). Try banking less energy early`,
        sentiment: 'negative',
      });
    } else if (slowest.number === 1 && fastest.number === splits.length) {
      insights.push({
        category: 'progression',
        message: `Classic warmup-to-finish progression — slowest on ${unitName} 1, fastest on ${unitName} ${splits.length}`,
        sentiment: 'positive',
      });
    }
  }

  return insights;
}

// ─── Persistence ─────────────────────────────────────────────

function getCachedAnalyses(): Record<number, SplitAnalysis> {
  try {
    const raw = persistence.getItem(SPLIT_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveCachedAnalyses(cache: Record<number, SplitAnalysis>): void {
  const entries = Object.entries(cache);
  if (entries.length > MAX_CACHED_ANALYSES) {
    entries.sort((a, b) => b[1].analyzedAt.localeCompare(a[1].analyzedAt));
    const trimmed: Record<number, SplitAnalysis> = {};
    for (let i = 0; i < MAX_CACHED_ANALYSES; i++) {
      trimmed[Number(entries[i][0])] = entries[i][1];
    }
    persistence.setItem(SPLIT_CACHE_KEY, JSON.stringify(trimmed));
    return;
  }
  persistence.setItem(SPLIT_CACHE_KEY, JSON.stringify(cache));
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Perform full split analysis on a Strava activity.
 * Requires the detailed activity (with splits_metric/splits_standard/laps).
 *
 * Returns null if insufficient split data exists.
 */
export function analyzeSplits(activity: StravaActivity): SplitAnalysis | null {
  const unit = getDistanceUnit();

  // Pick the appropriate split array for the user's unit
  const rawSplits = unit === 'km' ? activity.splits_metric : activity.splits_standard;
  if (!rawSplits || rawSplits.length < MIN_SPLITS) return null;

  const splits = processSplits(rawSplits, unit);
  if (splits.length < MIN_SPLITS) return null;

  const laps = processLaps(activity.laps ?? [], unit);
  const consistency = analyzePaceConsistency(splits);
  const pattern = detectSplitPattern(splits, unit);
  const intervals = laps.length >= 3 ? detectIntervals(laps) : null;
  const insights = generateInsights(splits, consistency, pattern, intervals, unit);

  const analysis: SplitAnalysis = {
    splits,
    laps,
    consistency,
    pattern,
    intervals,
    insights,
    unit,
    activityId: activity.id,
    analyzedAt: new Date().toISOString(),
  };

  // Cache the analysis
  const cache = getCachedAnalyses();
  cache[activity.id] = analysis;
  saveCachedAnalyses(cache);

  return analysis;
}

/**
 * Retrieve a cached split analysis for an activity.
 * Returns null if not yet analyzed.
 */
export function getCachedSplitAnalysis(activityId: number): SplitAnalysis | null {
  return getCachedAnalyses()[activityId] ?? null;
}

/**
 * Check if split data is available on an activity.
 * Use to conditionally show the "load splits" button.
 */
export function hasSplitData(activity: StravaActivity): boolean {
  return !!(
    (activity.splits_metric && activity.splits_metric.length >= MIN_SPLITS) ||
    (activity.splits_standard && activity.splits_standard.length >= MIN_SPLITS)
  );
}

export { formatPaceShort };
