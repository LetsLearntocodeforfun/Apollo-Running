/**
 * Post-Race Analysis (L-23..L-30 science & accuracy fixes applied; kept in src/labs/
 * per R-14 / PX-10 until wired to a post-race UI screen).
 *
 * Compares actual race execution (from a synced/imported Activity or split list)
 * against a goal time and optional RaceStrategy:
 *  - L-23: Distance-weights every split (including partial final splits like 0.2 mi).
 *  - L-24: Rewards meeting or beating the goal time (never penalizes faster finishes).
 *  - L-25: Computes 1st-half vs 2nd-half splits by interpolating at exact 50% distance.
 *  - L-26: Uses signed pace deviations (+ = slower/weakest, − = faster/strongest).
 *  - L-27: Deduplicates/upserts saved reports by `activityId` (newest first).
 *  - L-28: Safely guards empty, zero-distance, zero-time, or single-split inputs.
 *  - L-29: Provides honest, evidence-grounded takeaways (no invented multipliers).
 *  - L-30: Uses `elapsed_time` (official gun/chip clock) and surfaces GPS overdistance (>0.3%).
 */

import { persistence } from '../services/db/persistence';
import type { Activity, ActivitySplit } from '../services/activity/types';
import { getDistanceUnit, paceUnitLabel, type DistanceUnit } from '../services/unitPreferences';
import { formatDurationSec, formatPaceForUnit, getStrategyDistanceMi, timeAtDistance } from '../services/raceStrategy';
import type { MilePacePlan, RaceStrategy } from '../types/raceStrategy';

export const CANONICAL_MARATHON_M = 42_195;
export const CANONICAL_HALF_MARATHON_M = 21_097.5;
const METERS_PER_MILE = 1609.344;
const METERS_PER_KM = 1000;
const OVERDISTANCE_THRESHOLD_PCT = 0.3;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActualMileSplit {
  /** Split number or cumulative end distance in miles (e.g. 1..26, 26.2). */
  mile: number;
  /** Pace for this split in sec/mi. */
  paceSec: number;
  /** Optional explicit split length in miles (e.g. 0.2 for partial final split). */
  distanceMi?: number;
  /** Optional explicit split length in meters. */
  distanceM?: number;
  /** Optional explicit split elapsed time in seconds (preferred when present). */
  elapsedSec?: number;
  /** Optional split moving time in seconds. */
  movingSec?: number;
  heartRate?: number;
  elevationGainFt?: number;
  cadence?: number;
}

export interface MileComparison {
  mile: number;
  /** Length of this split in miles (e.g. 1.0 or 0.2). */
  distanceMi: number;
  plannedPaceSec: number;
  actualPaceSec: number;
  /** Signed pace delta in sec/mi: positive = slower than planned, negative = faster. */
  deltaSec: number;
  plannedCumSec: number;
  actualCumSec: number;
  cumDeltaSec: number;
  heartRate?: number;
  verdict: 'on_target' | 'slightly_fast' | 'too_fast' | 'slightly_slow' | 'too_slow';
  notes: string;
}

export interface SplitAnalysis {
  /** Exact 50% distance of the analyzed run in meters. */
  halfDistanceM: number;
  /** Exact 50% distance of the analyzed run in miles. */
  halfDistanceMi: number;
  firstHalfActualSec: number;
  secondHalfActualSec: number;
  firstHalfPlannedSec: number;
  secondHalfPlannedSec: number;
  /** `secondHalfActualSec - firstHalfActualSec` (positive = positive split / slowed). */
  actualSplitDiff: number;
  plannedSplitDiff: number;
  splitType: 'negative' | 'even' | 'positive';
  firstHalfAvgHr?: number;
  secondHalfAvgHr?: number;
}

export interface PaceSegment {
  label: string;
  startMile: number;
  endMile: number;
  distanceM: number;
  /** Distance-weighted actual pace (sec/mi). */
  avgPaceSec: number;
  /** Distance-weighted planned/target pace (sec/mi). */
  plannedAvgSec: number;
  /** Signed pace delta (sec/mi): positive = slower than planned, negative = faster. */
  deltaSec: number;
}

export interface GpsOverdistanceAnalysis {
  recordedDistanceM: number;
  canonicalDistanceM: number | null;
  extraDistanceM: number;
  overdistancePct: number;
  isOverdistance: boolean;
  /** Actual pace run over the GPS-recorded distance (sec/mi). */
  effectiveGpsPaceSecPerMi: number;
  /** Effective clock pace over the canonical course distance (sec/mi). */
  officialClockPaceSecPerMi: number;
  /** Approximate clock time spent running distance beyond canonical course length (s). */
  extraDistanceTimeSec: number;
  /** Difference between official `elapsed_time` and `moving_time` (aid stations / stops). */
  stoppedTimeSec: number;
  summary: string;
}

export type PostRaceGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'D' | 'F';

export interface PostRaceReport {
  id: string;
  activityId?: number | string;
  activityName?: string;
  strategyId: string;
  strategyName: string;
  marathonName: string;
  raceDate: string;
  recordedDistanceM: number;
  /** Official race clock finish (`elapsed_time`, falling back to `moving_time`). */
  actualFinishSec: number;
  actualFinishFormatted: string;
  movingTimeSec: number;
  plannedFinishSec: number;
  plannedFinishFormatted: string;
  /** `actualFinishSec - plannedFinishSec` (negative = beat goal, positive = slower than goal). */
  deltaFinishSec: number;
  mileComparisons: MileComparison[];
  splitAnalysis: SplitAnalysis;
  segments: PaceSegment[];
  strongestSegment: PaceSegment | null;
  weakestSegment: PaceSegment | null;
  gpsAnalysis: GpsOverdistanceAnalysis;
  grade: PostRaceGrade;
  score: number;
  insights: string[];
  lessonsLearned: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyzeRaceOptions {
  /** Activity ID used to deduplicate/upsert saved reports (L-27). */
  activityId?: number | string;
  activityName?: string;
  /** Official elapsed race time (gun/chip clock, s). Overrides split sum if larger. */
  elapsedTimeSec?: number;
  /** Moving time (s), used to surface aid-station stop duration. */
  movingTimeSec?: number;
  /** Total GPS-recorded distance (m). */
  recordedDistanceM?: number;
  /** Official course distance (m), e.g. 42195 for a marathon. Auto-inferred when omitted. */
  canonicalDistanceM?: number;
  /** Unit for human-readable insights and segment labels (`mi` or `km`). */
  unit?: DistanceUnit;
  /** Set `false` for pure preview without writing to persistence. Default `true`. */
  persist?: boolean;
}

export interface AnalyzeActivityOptions {
  /** Goal finish time in seconds (defaults to `strategy.targetTimeSec` if strategy is supplied). */
  goalTimeSec?: number;
  /** Optional RaceStrategy for hill/split-aware mile comparisons. */
  strategy?: RaceStrategy | null;
  /** Optional race name override. */
  marathonName?: string;
  /** Official course distance in meters (auto-detected for Marathon / Half / 10K / 5K if omitted). */
  canonicalDistanceM?: number;
  lessonsLearned?: string;
  unit?: DistanceUnit;
  /** Default `true` when explicitly saving/analyzing, `false` for pure read-only previews. */
  persist?: boolean;
}

interface NormalizedSplit {
  index: number;
  startDistM: number;
  endDistM: number;
  distM: number;
  distMi: number;
  endMi: number;
  elapsedSec: number;
  movingSec: number;
  paceSecPerMi: number;
  heartRate?: number;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'apollo_post_race_reports';
let reportCounter = 0;

function loadReports(): PostRaceReport[] {
  const raw = persistence.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveReports(reports: PostRaceReport[]): void {
  persistence.setItem(STORAGE_KEY, JSON.stringify(reports));
}

/** Upsert a report: deduplicates by `activityId` (when present) or `(strategyId, raceDate)`, newest first (L-27). */
export function savePostRaceReport(report: PostRaceReport): PostRaceReport {
  const all = loadReports();
  const matchIdx = all.findIndex((existing) => {
    if (report.activityId !== undefined && report.activityId !== null) {
      return existing.activityId !== undefined && String(existing.activityId) === String(report.activityId);
    }
    return (
      existing.activityId === undefined &&
      existing.strategyId === report.strategyId &&
      existing.raceDate === report.raceDate
    );
  });

  const nowIso = new Date().toISOString();
  if (matchIdx >= 0) {
    const prev = all[matchIdx];
    const merged: PostRaceReport = {
      ...report,
      id: prev.id,
      lessonsLearned: report.lessonsLearned || prev.lessonsLearned || '',
      createdAt: prev.createdAt || report.createdAt,
      updatedAt: nowIso,
    };
    all.splice(matchIdx, 1);
    all.unshift(merged);
    saveReports(all);
    return merged;
  }

  const fresh: PostRaceReport = {
    ...report,
    updatedAt: nowIso,
  };
  all.unshift(fresh);
  saveReports(all);
  return fresh;
}

// ── Formatting & Interpolation Helpers ────────────────────────────────────────

function formatClockHms(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '0:00:00';
  const rounded = Math.round(totalSec);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatPaceDelta(deltaSecPerMi: number, unit: DistanceUnit): string {
  const scaled = Math.round(unit === 'km' ? deltaSecPerMi / 1.609344 : deltaSecPerMi);
  if (scaled === 0) return `0s${paceUnitLabel(unit)}`;
  return `${scaled > 0 ? '+' : '−'}${Math.abs(scaled)}s${paceUnitLabel(unit)}`;
}

function getMileVerdict(deltaSec: number): MileComparison['verdict'] {
  if (deltaSec <= -15) return 'too_fast';
  if (deltaSec < -5) return 'slightly_fast';
  if (deltaSec <= 5) return 'on_target';
  if (deltaSec <= 15) return 'slightly_slow';
  return 'too_slow';
}

function getMileNotes(
  mileEnd: number,
  totalMiles: number,
  deltaSec: number,
  actualPaceSecPerMi: number,
  plannedPaceSecPerMi: number,
  unit: DistanceUnit,
): string {
  const verdict = getMileVerdict(deltaSec);
  if (verdict === 'on_target') return 'Right on target.';

  const pLabel = paceUnitLabel(unit);
  const dispDelta = Math.max(1, Math.round(Math.abs(unit === 'km' ? deltaSec / 1.609344 : deltaSec)));
  const direction = deltaSec > 0 ? 'slower' : 'faster';
  const base = `${dispDelta}s${pLabel} ${direction} than target (${formatPaceForUnit(actualPaceSecPerMi, unit)} vs ${formatPaceForUnit(plannedPaceSecPerMi, unit)}${pLabel}).`;

  const earlyCutoff = Math.min(5, totalMiles * 0.25);
  const lateCutoff = totalMiles * 0.76;

  if (mileEnd <= earlyCutoff && deltaSec < -12) {
    return `${base} Fast early pace — keep effort controlled to protect the final quarter.`;
  }
  if (mileEnd >= lateCutoff && deltaSec > 15) {
    return `${base} Late-race slowdown — fueling, heat, or early pacing load showing up.`;
  }
  if (mileEnd >= lateCutoff && deltaSec < -5) {
    return `${base} Strong closing split — finishing faster than target in the late stages.`;
  }
  return base;
}

/** Linearly interpolate cumulative actual time (s) at `targetM` meters from start. */
function interpolateActualTimeAtM(splits: readonly NormalizedSplit[], targetM: number): number {
  if (splits.length === 0 || !Number.isFinite(targetM) || targetM <= 0) return 0;
  for (const s of splits) {
    if (targetM <= s.endDistM + 1e-6) {
      const prevTime = splits.slice(0, s.index - 1).reduce((acc, item) => acc + item.elapsedSec, 0);
      const frac = s.distM > 0 ? Math.min(1, Math.max(0, (targetM - s.startDistM) / s.distM)) : 1;
      return prevTime + frac * s.elapsedSec;
    }
  }
  return splits.reduce((acc, item) => acc + item.elapsedSec, 0);
}

/** Planned cumulative time (s) at `distanceMi` miles; scales linearly beyond strategy distance if GPS ran long. */
function plannedTimeAtMile(strategy: RaceStrategy, distanceMi: number): number {
  if (!Number.isFinite(distanceMi) || distanceMi <= 0) return 0;
  const stratDistMi = getStrategyDistanceMi(strategy);
  if (strategy.milePaces.length > 0 && stratDistMi > 0) {
    if (distanceMi <= stratDistMi) {
      return timeAtDistance(strategy.milePaces, distanceMi);
    }
    const baseEnd = timeAtDistance(strategy.milePaces, stratDistMi);
    const tailPace =
      strategy.milePaces[strategy.milePaces.length - 1]?.targetPaceSec || strategy.targetTimeSec / stratDistMi;
    return baseEnd + (distanceMi - stratDistMi) * tailPace;
  }
  const fallbackDist = stratDistMi > 0 ? stratDistMi : 26.21875;
  return (distanceMi / fallbackDist) * strategy.targetTimeSec;
}

/** Time-weighted average HR over `[startM, endM]`, or undefined if insufficient HR data. */
function weightedHrInWindow(splits: readonly NormalizedSplit[], startM: number, endM: number): number | undefined {
  let hrWeighted = 0;
  let hrSec = 0;
  for (const s of splits) {
    if (s.heartRate === undefined || !(s.heartRate > 0)) continue;
    const overlapStart = Math.max(startM, s.startDistM);
    const overlapEnd = Math.min(endM, s.endDistM);
    if (overlapEnd > overlapStart && s.distM > 0) {
      const sec = ((overlapEnd - overlapStart) / s.distM) * s.elapsedSec;
      hrWeighted += s.heartRate * sec;
      hrSec += sec;
    }
  }
  return hrSec > 0 ? Math.round(hrWeighted / hrSec) : undefined;
}

/** Infer canonical course distance (m) for GPS overdistance comparison (L-30). */
export function inferCanonicalDistanceMeters(
  recordedDistanceM: number,
  strategyDistanceMi?: number,
  explicitCanonicalM?: number,
): number | null {
  if (explicitCanonicalM !== undefined && Number.isFinite(explicitCanonicalM) && explicitCanonicalM > 0) {
    return explicitCanonicalM;
  }
  if (strategyDistanceMi !== undefined && Number.isFinite(strategyDistanceMi) && strategyDistanceMi > 0) {
    if (Math.abs(strategyDistanceMi - 26.2) < 0.15) return CANONICAL_MARATHON_M;
    if (Math.abs(strategyDistanceMi - 13.1) < 0.12) return CANONICAL_HALF_MARATHON_M;
    // Only treat strategy distance as canonical if recorded distance is plausibly the same race (within -3% .. +8%)
    const stratM = strategyDistanceMi * METERS_PER_MILE;
    if (recordedDistanceM >= stratM * 0.97 && recordedDistanceM <= stratM * 1.08) {
      return stratM;
    }
  }
  if (recordedDistanceM >= 41_800 && recordedDistanceM <= 45_500) return CANONICAL_MARATHON_M;
  if (recordedDistanceM >= 20_900 && recordedDistanceM <= 22_800) return CANONICAL_HALF_MARATHON_M;
  if (recordedDistanceM >= 9_900 && recordedDistanceM <= 10_600) return 10_000;
  if (recordedDistanceM >= 4_950 && recordedDistanceM <= 5_350) return 5_000;
  return null;
}

function buildGpsAnalysis(
  recordedDistanceM: number,
  officialFinishSec: number,
  movingTimeSec: number,
  canonicalDistanceM: number | null,
  unit: DistanceUnit,
): GpsOverdistanceAnalysis {
  const safeDistM = Number.isFinite(recordedDistanceM) && recordedDistanceM > 0 ? recordedDistanceM : 0;
  const safeFinishSec = Number.isFinite(officialFinishSec) && officialFinishSec > 0 ? officialFinishSec : 0;
  const safeMovingSec =
    Number.isFinite(movingTimeSec) && movingTimeSec > 0 ? Math.min(safeFinishSec, movingTimeSec) : safeFinishSec;
  const stoppedTimeSec = Math.max(0, Math.round(safeFinishSec - safeMovingSec));

  const recordedMi = safeDistM / METERS_PER_MILE;
  const effectiveGpsPaceSecPerMi = recordedMi > 0 && safeFinishSec > 0 ? safeFinishSec / recordedMi : 0;

  if (!canonicalDistanceM || canonicalDistanceM <= 0 || safeDistM <= 0 || safeFinishSec <= 0) {
    return {
      recordedDistanceM: Math.round(safeDistM * 10) / 10,
      canonicalDistanceM: null,
      extraDistanceM: 0,
      overdistancePct: 0,
      isOverdistance: false,
      effectiveGpsPaceSecPerMi: Math.round(effectiveGpsPaceSecPerMi * 10) / 10,
      officialClockPaceSecPerMi: Math.round(effectiveGpsPaceSecPerMi * 10) / 10,
      extraDistanceTimeSec: 0,
      stoppedTimeSec,
      summary: '',
    };
  }

  const extraDistanceM = safeDistM - canonicalDistanceM;
  const overdistancePct = (extraDistanceM / canonicalDistanceM) * 100;
  const isOverdistance = overdistancePct > OVERDISTANCE_THRESHOLD_PCT;
  const canonicalMi = canonicalDistanceM / METERS_PER_MILE;
  const officialClockPaceSecPerMi = canonicalMi > 0 ? safeFinishSec / canonicalMi : effectiveGpsPaceSecPerMi;
  const extraDistanceTimeSec = extraDistanceM > 0 ? Math.round(extraDistanceM * (safeFinishSec / safeDistM)) : 0;

  let summary = '';
  const pLabel = paceUnitLabel(unit);
  if (isOverdistance) {
    const gpsPaceStr = `${formatPaceForUnit(effectiveGpsPaceSecPerMi, unit)}${pLabel}`;
    const clockPaceStr = `${formatPaceForUnit(officialClockPaceSecPerMi, unit)}${pLabel}`;
    if (unit === 'km') {
      const recKm = (safeDistM / METERS_PER_KM).toFixed(2);
      const canKm = (canonicalDistanceM / METERS_PER_KM).toFixed(2);
      const extraStr =
        extraDistanceM >= 1000 ? `${(extraDistanceM / 1000).toFixed(2)} km` : `${Math.round(extraDistanceM)} m`;
      summary = `GPS recorded ${recKm} km (+${extraStr} / +${overdistancePct.toFixed(1)}% over the ${canKm} km course). You ran ${gpsPaceStr} GPS pace vs ${clockPaceStr} official course pace (~${formatDurationSec(extraDistanceTimeSec)} spent on extra tangent/GPS distance).`;
    } else {
      const extraMi = (extraDistanceM / METERS_PER_MILE).toFixed(2);
      summary = `GPS recorded ${recordedMi.toFixed(2)} mi (+${extraMi} mi / +${overdistancePct.toFixed(1)}% over the ${canonicalMi.toFixed(2)} mi course). You ran ${gpsPaceStr} GPS pace vs ${clockPaceStr} official course pace (~${formatDurationSec(extraDistanceTimeSec)} spent on extra tangent/GPS distance).`;
    }
  } else if (stoppedTimeSec >= 20) {
    summary = `Official elapsed time includes ${formatDurationSec(stoppedTimeSec)} of non-moving stop time (aid stations or pauses) vs ${formatClockHms(safeMovingSec)} moving time.`;
  }

  return {
    recordedDistanceM: Math.round(safeDistM * 10) / 10,
    canonicalDistanceM: Math.round(canonicalDistanceM * 10) / 10,
    extraDistanceM: Math.round(extraDistanceM * 10) / 10,
    overdistancePct: Math.round(overdistancePct * 100) / 100,
    isOverdistance,
    effectiveGpsPaceSecPerMi: Math.round(effectiveGpsPaceSecPerMi * 10) / 10,
    officialClockPaceSecPerMi: Math.round(officialClockPaceSecPerMi * 10) / 10,
    extraDistanceTimeSec,
    stoppedTimeSec,
    summary,
  };
}

// ── Grading (L-24 fixed) ──────────────────────────────────────────────────────

function gradeFromScore(score: number): PostRaceGrade {
  if (score >= 95) return 'A+';
  if (score >= 90) return 'A';
  if (score >= 85) return 'A-';
  if (score >= 80) return 'B+';
  if (score >= 75) return 'B';
  if (score >= 70) return 'B-';
  if (score >= 65) return 'C+';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function calculateExecutionScore(
  actualFinishSec: number,
  plannedFinishSec: number,
  splits: readonly NormalizedSplit[],
  mileComparisons: readonly MileComparison[],
  splitAnalysis: SplitAnalysis,
): { score: number; grade: PostRaceGrade } {
  if (!(actualFinishSec > 0) || !(plannedFinishSec > 0)) {
    return { score: 0, grade: 'F' };
  }

  let score = 100;
  const finishDelta = actualFinishSec - plannedFinishSec;

  // 1. Goal achievement (L-24): meeting or beating goal deducts ZERO points!
  if (finishDelta > 0) {
    const pctSlower = (finishDelta / plannedFinishSec) * 100;
    score -= Math.min(35, pctSlower * 5);
  }

  if (splits.length >= 2 && mileComparisons.length === splits.length) {
    const totalDistMi = splits.reduce((acc, s) => acc + s.distMi, 0);
    const scaleToActual = plannedFinishSec > 0 ? actualFinishSec / plannedFinishSec : 1;

    // 2. Distance-weighted pacing consistency around the athlete's own scaled plan shape (L-23 + L-24)
    if (totalDistMi > 0) {
      let weightedAbsDev = 0;
      for (let i = 0; i < splits.length; i++) {
        const expectedShapePace = mileComparisons[i].plannedPaceSec * scaleToActual;
        weightedAbsDev += splits[i].distMi * Math.abs(splits[i].paceSecPerMi - expectedShapePace);
      }
      const madSecPerMi = weightedAbsDev / totalDistMi;
      if (madSecPerMi > 5) {
        score -= Math.min(25, (madSecPerMi - 5) * 0.85);
      }

      // 3. Early overpacing relative to sustainable race pace
      const earlyCutoffMi = Math.min(5, totalDistMi * 0.25);
      let earlyDist = 0;
      let earlyDevSum = 0;
      for (let i = 0; i < splits.length; i++) {
        if (splits[i].endMi <= earlyCutoffMi + 0.25) {
          const expectedShapePace = mileComparisons[i].plannedPaceSec * scaleToActual;
          earlyDist += splits[i].distMi;
          earlyDevSum += splits[i].distMi * (splits[i].paceSecPerMi - expectedShapePace);
        }
      }
      const earlyMeanDev = earlyDist > 0 ? earlyDevSum / earlyDist : 0;
      if (earlyMeanDev < -8) {
        score -= Math.min(20, (Math.abs(earlyMeanDev) - 8) * 1.1);
      }

      // 4. Late-race fade (final ~24% vs first ~76%, adjusted for course shape)
      const lateStartMi = totalDistMi * 0.76;
      let baseDist = 0;
      let baseDev = 0;
      let lateDist = 0;
      let lateDev = 0;
      for (let i = 0; i < splits.length; i++) {
        const expectedShapePace = mileComparisons[i].plannedPaceSec * scaleToActual;
        const dev = splits[i].paceSecPerMi - expectedShapePace;
        if (splits[i].endMi <= lateStartMi) {
          baseDist += splits[i].distMi;
          baseDev += splits[i].distMi * dev;
        } else {
          lateDist += splits[i].distMi;
          lateDev += splits[i].distMi * dev;
        }
      }
      if (baseDist > 0 && lateDist > 0) {
        const fadeSecPerMi = lateDev / lateDist - baseDev / baseDist;
        if (fadeSecPerMi > 12) {
          score -= Math.min(20, (fadeSecPerMi - 12) * 0.75);
        }
      }
    }

    // 5. Equal-distance half-split execution
    if (splitAnalysis.firstHalfActualSec > 0) {
      const splitPct = (splitAnalysis.actualSplitDiff / splitAnalysis.firstHalfActualSec) * 100;
      if (splitAnalysis.splitType === 'negative') {
        score += 4;
      } else if (splitAnalysis.splitType === 'even') {
        score += 2;
      } else if (splitPct > 2.0) {
        score -= Math.min(15, (splitPct - 1.5) * 3.2);
      }
    }
  }

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  return { score: clamped, grade: gradeFromScore(clamped) };
}

// ── Segments (L-23 + L-26 fixed, mi & km aware) ──────────────────────────────

function buildSegments(
  splits: readonly NormalizedSplit[],
  strategy: RaceStrategy,
  unit: DistanceUnit,
): {
  segments: PaceSegment[];
  strongestSegment: PaceSegment | null;
  weakestSegment: PaceSegment | null;
} {
  if (splits.length === 0) {
    return { segments: [], strongestSegment: null, weakestSegment: null };
  }

  const totalDistM = splits[splits.length - 1].endDistM;
  const totalDistMi = totalDistM / METERS_PER_MILE;
  if (!(totalDistM > 0)) {
    return { segments: [], strongestSegment: null, weakestSegment: null };
  }

  const windows: { label: string; startM: number; endM: number; startMile: number; endMile: number }[] = [];

  if (unit === 'km') {
    const totalKm = totalDistM / METERS_PER_KM;
    const stepKm = totalKm >= 15 ? 5 : totalKm >= 6 ? 2 : 1;
    let startKm = 0;
    while (startKm < totalKm - 0.05) {
      let endKm = startKm + stepKm;
      if (totalKm - endKm < stepKm * 0.45) {
        endKm = totalKm;
      }
      const endLabel = Math.abs(endKm - Math.round(endKm)) < 0.05 ? `${Math.round(endKm)}K` : `${endKm.toFixed(1)}K`;
      windows.push({
        label: `${Math.round(startKm)}–${endLabel}`,
        startM: startKm * METERS_PER_KM,
        endM: Math.min(totalDistM, endKm * METERS_PER_KM),
        startMile: Math.round(((startKm * METERS_PER_KM) / METERS_PER_MILE) * 100) / 100,
        endMile: Math.round((Math.min(totalDistM, endKm * METERS_PER_KM) / METERS_PER_MILE) * 100) / 100,
      });
      startKm = endKm;
    }
  } else if (totalDistMi >= 22 && totalDistMi <= 29) {
    // Classic 5-block marathon breakdown matching Miles 1-5 .. Miles 21-26.2
    const boundsMi = [0, 5, 10, 15, 20, totalDistMi];
    const labels = ['Miles 1-5', 'Miles 6-10', 'Miles 11-15', 'Miles 16-20', 'Miles 21-26.2'];
    for (let i = 0; i < 5; i++) {
      const sMi = boundsMi[i];
      const eMi = Math.min(totalDistMi, boundsMi[i + 1]);
      if (eMi <= sMi) continue;
      windows.push({
        label: labels[i],
        startM: sMi * METERS_PER_MILE,
        endM: eMi * METERS_PER_MILE,
        startMile: i * 5 + 1,
        endMile: i === 4 ? Math.round(totalDistMi * 10) / 10 : (i + 1) * 5,
      });
    }
  } else {
    const stepMi = totalDistMi >= 10 ? 3 : totalDistMi >= 4 ? 1 : Math.max(0.5, totalDistMi / 3);
    let startMi = 0;
    while (startMi < totalDistMi - 0.05) {
      let endMi = startMi + stepMi;
      if (totalDistMi - endMi < stepMi * 0.45) {
        endMi = totalDistMi;
      }
      const sDisp = Math.round(startMi * 10) / 10;
      const eDisp = Math.round(endMi * 10) / 10;
      windows.push({
        label: `Miles ${sDisp === 0 ? 1 : sDisp}-${eDisp}`,
        startM: startMi * METERS_PER_MILE,
        endM: Math.min(totalDistM, endMi * METERS_PER_MILE),
        startMile: sDisp === 0 ? 1 : sDisp,
        endMile: eDisp,
      });
      startMi = endMi;
    }
  }

  const segments: PaceSegment[] = [];
  for (const w of windows) {
    const segDistM = w.endM - w.startM;
    const segDistMi = segDistM / METERS_PER_MILE;
    if (!(segDistMi > 0)) continue;

    const actualSec = interpolateActualTimeAtM(splits, w.endM) - interpolateActualTimeAtM(splits, w.startM);
    const plannedSec =
      plannedTimeAtMile(strategy, w.endM / METERS_PER_MILE) - plannedTimeAtMile(strategy, w.startM / METERS_PER_MILE);

    const avgActualSecPerMi = actualSec / segDistMi;
    const avgPlannedSecPerMi = plannedSec > 0 ? plannedSec / segDistMi : strategy.avgPaceSec;

    segments.push({
      label: w.label,
      startMile: w.startMile,
      endMile: Math.round((w.endM / METERS_PER_MILE) * 10) / 10,
      distanceM: Math.round(segDistM * 10) / 10,
      avgPaceSec: Math.round(avgActualSecPerMi),
      plannedAvgSec: Math.round(avgPlannedSecPerMi),
      // L-26: positive deltaSec = slower than target (faded), negative = faster than target
      deltaSec: Math.round(avgActualSecPerMi - avgPlannedSecPerMi),
    });
  }

  if (segments.length === 0) {
    return { segments: [], strongestSegment: null, weakestSegment: null };
  }

  // L-26: Strongest = lowest deltaSec (fastest vs plan); Weakest = highest deltaSec (slowest vs plan)
  let strongestSegment = segments[0];
  let weakestSegment = segments[0];
  for (const seg of segments) {
    if (seg.deltaSec < strongestSegment.deltaSec) strongestSegment = seg;
    if (seg.deltaSec > weakestSegment.deltaSec) weakestSegment = seg;
  }

  return { segments, strongestSegment, weakestSegment };
}

// ── Honest, Evidence-Grounded Takeaways (L-29 + L-30) ────────────────────────

function generateInsights(
  miles: readonly MileComparison[],
  splits: SplitAnalysis,
  segments: readonly PaceSegment[],
  strongestSegment: PaceSegment | null,
  weakestSegment: PaceSegment | null,
  finishDelta: number,
  gpsAnalysis: GpsOverdistanceAnalysis,
  unit: DistanceUnit,
): string[] {
  const insights: string[] = [];
  const pLabel = paceUnitLabel(unit);

  // 1. Goal comparison (official elapsed clock)
  if (Math.abs(finishDelta) <= 60) {
    insights.push('Finished within 1 minute of your goal time — dialed-in race clock execution.');
  } else if (finishDelta < 0) {
    insights.push(
      `Finished ${formatDurationSec(Math.abs(finishDelta))} ahead of your goal time (${formatClockHms(
        splits.firstHalfActualSec + splits.secondHalfActualSec,
      )}). Your fitness supports a faster target for your next cycle.`,
    );
  } else {
    insights.push(
      `Finished ${formatDurationSec(finishDelta)} slower than your goal time. ${
        finishDelta > 300
          ? 'Review half-split pacing, fueling cadence, and weather conditions below.'
          : 'Close to target — small pacing or tangent adjustments can bridge this gap.'
      }`,
    );
  }

  // 2. GPS overdistance / stop time (L-30)
  if (gpsAnalysis.isOverdistance && gpsAnalysis.summary) {
    insights.push(gpsAnalysis.summary);
  } else if (gpsAnalysis.stoppedTimeSec >= 30) {
    insights.push(
      `Official clock time included ${formatDurationSec(gpsAnalysis.stoppedTimeSec)} of stopped time at aid stations or pauses.`,
    );
  }

  if (miles.length < 2) {
    insights.push(
      'Detailed per-split data was not available for this activity; grade reflects overall finish vs goal.',
    );
    return insights;
  }

  // 3. Exact 50% half-split differential (L-25 + L-29: zero fabricated multipliers!)
  if (splits.splitType === 'negative') {
    insights.push(
      `Negative split by ${formatDurationSec(Math.abs(splits.actualSplitDiff))} over equal halves — strong aerobic durability and early restraint.`,
    );
  } else if (splits.splitType === 'even') {
    insights.push(
      `Even split (${formatDurationSec(splits.actualSplitDiff, { signed: true })} between equal first and second halves) — textbook energy distribution.`,
    );
  } else if (splits.actualSplitDiff > 180) {
    insights.push(
      `Positive split of +${formatDurationSec(splits.actualSplitDiff)} in the second half. Starting 5–10s${pLabel} more conservatively in the opening quarter and fueling early helps protect late-race pace.`,
    );
  } else {
    insights.push(`Mild positive split of +${formatDurationSec(splits.actualSplitDiff)} across the second half.`);
  }

  // 4. Cardiac drift (if HR was recorded in both halves)
  if (splits.firstHalfAvgHr && splits.secondHalfAvgHr) {
    const hrDiff = splits.secondHalfAvgHr - splits.firstHalfAvgHr;
    if (hrDiff >= 8 && splits.actualSplitDiff > 60) {
      insights.push(
        `Heart rate rose from ${splits.firstHalfAvgHr} bpm (1st half) to ${splits.secondHalfAvgHr} bpm (2nd half) (+${hrDiff} bpm) while pace slowed — a classic sign of thermal/hydration or glycogen drift.`,
      );
    } else if (Math.abs(hrDiff) <= 5 && splits.splitType !== 'positive') {
      insights.push(
        `Heart rate stayed steady (${splits.firstHalfAvgHr} → ${splits.secondHalfAvgHr} bpm) with controlled pacing — strong aerobic efficiency.`,
      );
    }
  }

  // 5. Early fast start check
  const totalDistMi = miles.reduce((acc, m) => acc + m.distanceMi, 0);
  const earlyFast = miles.filter((m) => m.mile <= Math.min(5, totalDistMi * 0.25) && m.deltaSec < -10);
  if (earlyFast.length >= 3) {
    const earlyDist = earlyFast.reduce((s, m) => s + m.distanceMi, 0);
    const avgFastMi =
      earlyDist > 0 ? earlyFast.reduce((s, m) => s + Math.abs(m.deltaSec) * m.distanceMi, 0) / earlyDist : 0;
    const dispFast = Math.max(1, Math.round(unit === 'km' ? avgFastMi / 1.609344 : avgFastMi));
    insights.push(
      `First quarter averaged ${dispFast}s${pLabel} faster than planned${
        splits.splitType === 'positive'
          ? ', contributing to the second-half slowdown.'
          : ' and you held strong through the finish.'
      }`,
    );
  }

  // 6. Late-race slowdown ("the wall") check
  const lateCutoff = totalDistMi * 0.76;
  const wallMiles = miles.filter((m) => m.mile >= lateCutoff && m.deltaSec > 20);
  if (wallMiles.length >= 2) {
    const wallDist = wallMiles.reduce((s, m) => s + m.distanceMi, 0);
    const avgSlowMi = wallDist > 0 ? wallMiles.reduce((s, m) => s + m.deltaSec * m.distanceMi, 0) / wallDist : 0;
    const dispSlow = Math.max(1, Math.round(unit === 'km' ? avgSlowMi / 1.609344 : avgSlowMi));
    insights.push(
      `Final quarter slowed by +${dispSlow}s${pLabel} vs target. Prioritize 60–90 g/h carbohydrate intake from the first 30 minutes and long runs with marathon-pace finishes.`,
    );
  }

  // 7. Strongest vs weakest segment (L-26: properly signed!)
  if (segments.length >= 2 && strongestSegment && weakestSegment && strongestSegment !== weakestSegment) {
    if (weakestSegment.deltaSec > 10 || strongestSegment.deltaSec < -10) {
      const bestPace = `${formatPaceForUnit(strongestSegment.avgPaceSec, unit)}${pLabel}`;
      const worstPace = `${formatPaceForUnit(weakestSegment.avgPaceSec, unit)}${pLabel}`;
      insights.push(
        `Strongest segment: ${strongestSegment.label} (${bestPace}, ${formatPaceDelta(strongestSegment.deltaSec, unit)} vs target). Weakest segment: ${weakestSegment.label} (${worstPace}, ${formatPaceDelta(weakestSegment.deltaSec, unit)} vs target).`,
      );
    }
  }

  return insights;
}

// ── Split Normalization ───────────────────────────────────────────────────────

function normalizeActualMileSplits(
  rawSplits: readonly ActualMileSplit[],
  officialElapsedSec?: number,
): NormalizedSplit[] {
  if (!Array.isArray(rawSplits) || rawSplits.length === 0) return [];
  const normalized: NormalizedSplit[] = [];
  let cumDistM = 0;
  let prevMileMarker = 0;

  for (const s of rawSplits) {
    if (!s || typeof s !== 'object') continue;
    let distMi: number;
    if (typeof s.distanceM === 'number' && Number.isFinite(s.distanceM) && s.distanceM > 0) {
      distMi = s.distanceM / METERS_PER_MILE;
    } else if (typeof s.distanceMi === 'number' && Number.isFinite(s.distanceMi) && s.distanceMi > 0) {
      distMi = s.distanceMi;
    } else if (typeof s.mile === 'number' && Number.isFinite(s.mile) && s.mile > prevMileMarker) {
      distMi = s.mile - prevMileMarker;
    } else {
      distMi = 1;
    }
    if (!(distMi > 0) || !Number.isFinite(distMi)) continue;

    let elapsedSec: number;
    if (typeof s.elapsedSec === 'number' && Number.isFinite(s.elapsedSec) && s.elapsedSec > 0) {
      elapsedSec = s.elapsedSec;
    } else if (typeof s.paceSec === 'number' && Number.isFinite(s.paceSec) && s.paceSec > 0) {
      // L-23: multiply pace (sec/mi) by actual split length (mi), never sum raw paceSec for partial splits!
      elapsedSec = s.paceSec * distMi;
    } else {
      continue;
    }

    const movingSec =
      typeof s.movingSec === 'number' && Number.isFinite(s.movingSec) && s.movingSec > 0
        ? Math.min(elapsedSec, s.movingSec)
        : elapsedSec;

    const distM = distMi * METERS_PER_MILE;
    const startDistM = cumDistM;
    const endDistM = cumDistM + distM;
    cumDistM = endDistM;
    prevMileMarker = cumDistM / METERS_PER_MILE;

    normalized.push({
      index: normalized.length + 1,
      startDistM,
      endDistM,
      distM,
      distMi,
      endMi: Math.round((endDistM / METERS_PER_MILE) * 1000) / 1000,
      elapsedSec,
      movingSec,
      paceSecPerMi: elapsedSec / distMi,
      heartRate: typeof s.heartRate === 'number' && s.heartRate > 0 ? s.heartRate : undefined,
    });
  }

  // Reconcile split elapsed sum to official elapsed finish clock if provided (L-30)
  if (
    normalized.length > 0 &&
    officialElapsedSec !== undefined &&
    Number.isFinite(officialElapsedSec) &&
    officialElapsedSec > 0
  ) {
    const rawSum = normalized.reduce((acc, item) => acc + item.elapsedSec, 0);
    if (rawSum > 0 && Math.abs(officialElapsedSec - rawSum) > 0.5) {
      const k = officialElapsedSec / rawSum;
      for (const item of normalized) {
        item.elapsedSec *= k;
        item.paceSecPerMi = item.elapsedSec / item.distMi;
      }
    }
  }

  return normalized;
}

function buildSyntheticStrategy(goalTimeSec: number, distanceMi: number, marathonName: string): RaceStrategy {
  const safeDist = distanceMi > 0 ? distanceMi : 26.21875;
  const safeGoal = goalTimeSec > 0 ? Math.round(goalTimeSec) : 14400;
  const avgPaceSec = safeGoal / safeDist;
  const whole = Math.floor(safeDist + 1e-6);
  const ends: number[] = [];
  for (let i = 1; i <= whole; i++) ends.push(i);
  if (safeDist - whole > 0.02 || ends.length === 0) ends.push(safeDist);

  const milePaces: MilePacePlan[] = ends.map((endMi) => ({
    mile: Math.round(endMi * 1000) / 1000,
    targetPaceSec: Math.round(avgPaceSec),
    targetPaceFormatted: formatDurationSec(avgPaceSec),
    cumulativeTimeSec: Math.round(endMi * avgPaceSec),
    cumulativeTimeFormatted: formatClockHms(endMi * avgPaceSec),
    elevationChangeFt: 0,
    notes: '',
  }));

  const firstHalfSec = Math.round(safeGoal / 2);
  const secondHalfSec = safeGoal - firstHalfSec;
  const nowIso = new Date().toISOString();

  return {
    id: 'goal-even-baseline',
    name: `${marathonName} — ${formatClockHms(safeGoal)} Goal`,
    marathonId: 'custom',
    marathonName,
    targetTimeSec: safeGoal,
    targetTimeFormatted: formatClockHms(safeGoal),
    pacingStrategy: 'even-split',
    milePaces,
    nutritionPlan: [],
    firstHalfSec,
    secondHalfSec,
    splitPct: 0,
    distanceMi: safeDist,
    avgPaceSec: Math.round(avgPaceSec),
    createdAt: nowIso,
    updatedAt: nowIso,
    notes: '',
  };
}

// ── Core Analysis ─────────────────────────────────────────────────────────────

/**
 * Generate a post-race analysis report comparing actual splits to a planned strategy.
 */
export function analyzeRace(
  strategy: RaceStrategy,
  actualSplits: ActualMileSplit[],
  raceDate: string,
  lessonsLearned?: string,
  options: AnalyzeRaceOptions = {},
): PostRaceReport {
  const unit: DistanceUnit = options.unit ?? getDistanceUnit();
  const persist = options.persist ?? true;
  const safePlannedFinishSec =
    Number.isFinite(strategy?.targetTimeSec) && strategy.targetTimeSec > 0 ? Math.round(strategy.targetTimeSec) : 0;

  const normalizedSplits = normalizeActualMileSplits(actualSplits, options.elapsedTimeSec);
  const splitsDistanceM = normalizedSplits.reduce((acc, s) => acc + s.distM, 0);
  const recordedDistanceM =
    options.recordedDistanceM !== undefined &&
    Number.isFinite(options.recordedDistanceM) &&
    options.recordedDistanceM > 0
      ? options.recordedDistanceM
      : splitsDistanceM;

  const splitsFinishSec = normalizedSplits.reduce((acc, s) => acc + s.elapsedSec, 0);
  const rawElapsed = options.elapsedTimeSec;
  const rawMoving = options.movingTimeSec;
  const officialFinishSec =
    rawElapsed !== undefined && Number.isFinite(rawElapsed) && rawElapsed > 0
      ? Math.round(rawElapsed)
      : splitsFinishSec > 0
        ? Math.round(splitsFinishSec)
        : rawMoving !== undefined && Number.isFinite(rawMoving) && rawMoving > 0
          ? Math.round(rawMoving)
          : 0;
  const movingTimeSec =
    rawMoving !== undefined && Number.isFinite(rawMoving) && rawMoving > 0
      ? Math.min(officialFinishSec, Math.round(rawMoving))
      : Math.round(normalizedSplits.reduce((acc, s) => acc + s.movingSec, 0)) || officialFinishSec;

  const nowIso = new Date().toISOString();
  const reportId = `report_${Date.now()}_${++reportCounter}`;

  // L-28: Graceful guard for empty / zero-distance / zero-time data
  if (officialFinishSec <= 0 || recordedDistanceM <= 0) {
    const emptyReport: PostRaceReport = {
      id: reportId,
      ...(options.activityId !== undefined ? { activityId: options.activityId } : {}),
      ...(options.activityName ? { activityName: options.activityName } : {}),
      strategyId: strategy?.id ?? 'unknown',
      strategyName: strategy?.name ?? 'Race Plan',
      marathonName: strategy?.marathonName ?? 'Race',
      raceDate: raceDate || '',
      recordedDistanceM: Math.max(0, recordedDistanceM),
      actualFinishSec: 0,
      actualFinishFormatted: '0:00:00',
      movingTimeSec: 0,
      plannedFinishSec: safePlannedFinishSec,
      plannedFinishFormatted: formatClockHms(safePlannedFinishSec),
      deltaFinishSec: 0,
      mileComparisons: [],
      splitAnalysis: {
        halfDistanceM: 0,
        halfDistanceMi: 0,
        firstHalfActualSec: 0,
        secondHalfActualSec: 0,
        firstHalfPlannedSec: strategy?.firstHalfSec ?? 0,
        secondHalfPlannedSec: strategy?.secondHalfSec ?? 0,
        actualSplitDiff: 0,
        plannedSplitDiff: (strategy?.secondHalfSec ?? 0) - (strategy?.firstHalfSec ?? 0),
        splitType: 'even',
      },
      segments: [],
      strongestSegment: null,
      weakestSegment: null,
      gpsAnalysis: buildGpsAnalysis(0, 0, 0, null, unit),
      grade: 'F',
      score: 0,
      insights: ['Insufficient race distance or duration data to generate a pacing analysis.'],
      lessonsLearned: lessonsLearned ?? '',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    return persist ? savePostRaceReport(emptyReport) : emptyReport;
  }

  const totalSplitMiles = splitsDistanceM / METERS_PER_MILE;

  // Build distance-weighted split-by-split comparisons (L-23)
  let actualCum = 0;
  const mileComparisons: MileComparison[] = normalizedSplits.map((actual, idx) => {
    actualCum += actual.elapsedSec;
    const prevEndMi = idx === 0 ? 0 : normalizedSplits[idx - 1].endMi;
    const plannedCumEnd = plannedTimeAtMile(strategy, actual.endMi);
    const plannedCumStart = plannedTimeAtMile(strategy, prevEndMi);
    const plannedSegPaceSec =
      actual.distMi > 0 && plannedCumEnd > plannedCumStart
        ? (plannedCumEnd - plannedCumStart) / actual.distMi
        : strategy.avgPaceSec || safePlannedFinishSec / Math.max(1, getStrategyDistanceMi(strategy));

    const actualPaceRounded = Math.round(actual.paceSecPerMi);
    const plannedPaceRounded = Math.round(plannedSegPaceSec);
    const deltaSec = Math.round(actual.paceSecPerMi - plannedSegPaceSec);

    return {
      mile: actual.endMi,
      distanceMi: Math.round(actual.distMi * 1000) / 1000,
      plannedPaceSec: plannedPaceRounded,
      actualPaceSec: actualPaceRounded,
      deltaSec,
      plannedCumSec: Math.round(plannedCumEnd),
      actualCumSec: Math.round(actualCum),
      cumDeltaSec: Math.round(actualCum - plannedCumEnd),
      ...(actual.heartRate !== undefined ? { heartRate: actual.heartRate } : {}),
      verdict: getMileVerdict(deltaSec),
      notes: getMileNotes(actual.endMi, totalSplitMiles, deltaSec, actual.paceSecPerMi, plannedSegPaceSec, unit),
    };
  });

  // L-25: Exact 50% halfway interpolation (equal distance in both halves!)
  const analysisTotalM = splitsDistanceM > 0 ? splitsDistanceM : recordedDistanceM;
  const halfDistanceM = analysisTotalM / 2;
  const halfDistanceMi = halfDistanceM / METERS_PER_MILE;

  let firstHalfActualSec: number;
  let secondHalfActualSec: number;
  if (normalizedSplits.length >= 2) {
    firstHalfActualSec = Math.round(interpolateActualTimeAtM(normalizedSplits, halfDistanceM));
    secondHalfActualSec = officialFinishSec - firstHalfActualSec;
  } else {
    firstHalfActualSec = Math.round(officialFinishSec / 2);
    secondHalfActualSec = officialFinishSec - firstHalfActualSec;
  }

  const stratDistMi = getStrategyDistanceMi(strategy);
  const firstHalfPlannedSec =
    stratDistMi > 0 && strategy.milePaces.length > 0
      ? Math.round(plannedTimeAtMile(strategy, stratDistMi / 2))
      : strategy.firstHalfSec || Math.round(safePlannedFinishSec / 2);
  const secondHalfPlannedSec = Math.max(0, safePlannedFinishSec - firstHalfPlannedSec);

  const actualSplitDiff = secondHalfActualSec - firstHalfActualSec;
  const evenThresholdSec = Math.max(20, Math.round(officialFinishSec * 0.003));
  const firstHalfAvgHr = weightedHrInWindow(normalizedSplits, 0, halfDistanceM);
  const secondHalfAvgHr = weightedHrInWindow(normalizedSplits, halfDistanceM, analysisTotalM);

  const splitAnalysis: SplitAnalysis = {
    halfDistanceM: Math.round(halfDistanceM * 10) / 10,
    halfDistanceMi: Math.round(halfDistanceMi * 1000) / 1000,
    firstHalfActualSec,
    secondHalfActualSec,
    firstHalfPlannedSec,
    secondHalfPlannedSec,
    actualSplitDiff,
    plannedSplitDiff: secondHalfPlannedSec - firstHalfPlannedSec,
    splitType:
      actualSplitDiff < -evenThresholdSec ? 'negative' : actualSplitDiff > evenThresholdSec ? 'positive' : 'even',
    ...(firstHalfAvgHr !== undefined ? { firstHalfAvgHr } : {}),
    ...(secondHalfAvgHr !== undefined ? { secondHalfAvgHr } : {}),
  };

  // Segments & signed strongest/weakest (L-26)
  const { segments, strongestSegment, weakestSegment } =
    normalizedSplits.length >= 2
      ? buildSegments(normalizedSplits, strategy, unit)
      : { segments: [], strongestSegment: null, weakestSegment: null };

  // GPS Overdistance & official clock analysis (L-30)
  const canonicalM = inferCanonicalDistanceMeters(
    recordedDistanceM,
    stratDistMi > 0 ? stratDistMi : undefined,
    options.canonicalDistanceM,
  );
  const gpsAnalysis = buildGpsAnalysis(recordedDistanceM, officialFinishSec, movingTimeSec, canonicalM, unit);

  const deltaFinish = officialFinishSec - safePlannedFinishSec;
  const { score, grade } = calculateExecutionScore(
    officialFinishSec,
    safePlannedFinishSec,
    normalizedSplits,
    mileComparisons,
    splitAnalysis,
  );

  const insights = generateInsights(
    mileComparisons,
    splitAnalysis,
    segments,
    strongestSegment,
    weakestSegment,
    deltaFinish,
    gpsAnalysis,
    unit,
  );

  const report: PostRaceReport = {
    id: reportId,
    ...(options.activityId !== undefined ? { activityId: options.activityId } : {}),
    ...(options.activityName ? { activityName: options.activityName } : {}),
    strategyId: strategy.id,
    strategyName: strategy.name,
    marathonName: strategy.marathonName,
    raceDate,
    recordedDistanceM: Math.round(recordedDistanceM * 10) / 10,
    actualFinishSec: officialFinishSec,
    actualFinishFormatted: formatClockHms(officialFinishSec),
    movingTimeSec,
    plannedFinishSec: safePlannedFinishSec,
    plannedFinishFormatted: strategy.targetTimeFormatted || formatClockHms(safePlannedFinishSec),
    deltaFinishSec: deltaFinish,
    mileComparisons,
    splitAnalysis,
    segments,
    strongestSegment,
    weakestSegment,
    gpsAnalysis,
    grade,
    score,
    insights,
    lessonsLearned: lessonsLearned ?? '',
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  return persist ? savePostRaceReport(report) : report;
}

/** Convert an Activity's `splits_standard` or `splits_metric` into distance-accurate `ActualMileSplit[]`. */
export function activitySplitsToMileSplits(
  activity: Pick<Activity, 'splits_standard' | 'splits_metric'>,
): ActualMileSplit[] {
  const sourceSplits: ActivitySplit[] =
    activity.splits_standard && activity.splits_standard.length > 0
      ? activity.splits_standard
      : activity.splits_metric && activity.splits_metric.length > 0
        ? activity.splits_metric
        : [];

  let cumMi = 0;
  const out: ActualMileSplit[] = [];
  for (const sp of sourceSplits) {
    if (!sp || !(sp.distance > 0) || !Number.isFinite(sp.distance)) continue;
    const elapsed =
      sp.elapsed_time > 0 && sp.elapsed_time >= (sp.moving_time || 0)
        ? sp.elapsed_time
        : sp.moving_time > 0
          ? sp.moving_time
          : sp.average_speed > 0
            ? sp.distance / sp.average_speed
            : 0;
    if (!(elapsed > 0) || !Number.isFinite(elapsed)) continue;
    const distMi = sp.distance / METERS_PER_MILE;
    cumMi += distMi;
    out.push({
      mile: Math.round(cumMi * 1000) / 1000,
      distanceM: sp.distance,
      distanceMi: distMi,
      elapsedSec: elapsed,
      movingSec: sp.moving_time > 0 ? sp.moving_time : elapsed,
      paceSec: elapsed / distMi,
      heartRate: sp.average_heartrate && sp.average_heartrate > 0 ? sp.average_heartrate : undefined,
      elevationGainFt: Number.isFinite(sp.elevation_difference)
        ? Math.round(sp.elevation_difference * 3.28084)
        : undefined,
    });
  }
  return out;
}

/**
 * Analyze a synced or file-imported `Activity` against a goal time and optional
 * `RaceStrategy`. Uses official `elapsed_time` (falling back to `moving_time`)
 * and deduplicates saved reports by `activity.id`.
 */
export function analyzeRaceActivity(
  activity: Pick<
    Activity,
    | 'id'
    | 'name'
    | 'distance'
    | 'moving_time'
    | 'elapsed_time'
    | 'start_date_local'
    | 'splits_standard'
    | 'splits_metric'
  >,
  options: AnalyzeActivityOptions = {},
): PostRaceReport {
  const officialElapsed =
    Number.isFinite(activity.elapsed_time) &&
    activity.elapsed_time >= (activity.moving_time || 0) &&
    activity.elapsed_time > 0
      ? activity.elapsed_time
      : Math.max(0, activity.moving_time || 0);
  const movingSec =
    Number.isFinite(activity.moving_time) && activity.moving_time > 0 ? activity.moving_time : officialElapsed;

  const recordedDistM = Number.isFinite(activity.distance) && activity.distance > 0 ? activity.distance : 0;
  const canonicalM = inferCanonicalDistanceMeters(
    recordedDistM,
    options.strategy ? getStrategyDistanceMi(options.strategy) : undefined,
    options.canonicalDistanceM,
  );
  const targetCourseDistMi =
    canonicalM && canonicalM > 0
      ? canonicalM / METERS_PER_MILE
      : recordedDistM > 0
        ? recordedDistM / METERS_PER_MILE
        : 26.21875;

  const goalSec =
    options.goalTimeSec && options.goalTimeSec > 0
      ? options.goalTimeSec
      : options.strategy?.targetTimeSec && options.strategy.targetTimeSec > 0
        ? options.strategy.targetTimeSec
        : officialElapsed > 0
          ? officialElapsed
          : 14400;

  const raceTitle = options.marathonName || options.strategy?.marathonName || activity.name || 'Race';
  const effectiveStrategy =
    options.strategy && Math.abs(options.strategy.targetTimeSec - goalSec) <= 1
      ? options.strategy
      : options.strategy
        ? {
            ...options.strategy,
            targetTimeSec: Math.round(goalSec),
            targetTimeFormatted: formatClockHms(goalSec),
            avgPaceSec: Math.round(
              goalSec / Math.max(0.5, getStrategyDistanceMi(options.strategy) || targetCourseDistMi),
            ),
            milePaces: options.strategy.milePaces.map((mp) => {
              const scale = options.strategy!.targetTimeSec > 0 ? goalSec / options.strategy!.targetTimeSec : 1;
              return {
                ...mp,
                targetPaceSec: Math.round(mp.targetPaceSec * scale),
                cumulativeTimeSec: Math.round(mp.cumulativeTimeSec * scale),
              };
            }),
          }
        : buildSyntheticStrategy(goalSec, targetCourseDistMi, raceTitle);

  const splits = activitySplitsToMileSplits(activity);
  const raceDate = (activity.start_date_local ?? '').slice(0, 10);

  return analyzeRace(effectiveStrategy, splits, raceDate, options.lessonsLearned, {
    activityId: activity.id,
    activityName: activity.name,
    elapsedTimeSec: officialElapsed,
    movingTimeSec: movingSec,
    recordedDistanceM: recordedDistM,
    canonicalDistanceM: canonicalM ?? undefined,
    unit: options.unit,
    persist: options.persist ?? true,
  });
}

// ── Report Management ─────────────────────────────────────────────────────────

export function getAllReports(): PostRaceReport[] {
  return loadReports();
}

export function getReportById(id: string): PostRaceReport | undefined {
  return loadReports().find((r) => r.id === id);
}

export function getReportByActivityId(activityId: number | string): PostRaceReport | undefined {
  return loadReports().find((r) => r.activityId !== undefined && String(r.activityId) === String(activityId));
}

export function getReportsForStrategy(strategyId: string): PostRaceReport[] {
  return loadReports().filter((r) => r.strategyId === strategyId);
}

export function updateLessonsLearned(reportId: string, lessons: string): boolean {
  const all = loadReports();
  const report = all.find((r) => r.id === reportId);
  if (!report) return false;
  report.lessonsLearned = lessons;
  report.updatedAt = new Date().toISOString();
  saveReports(all);
  return true;
}

export function deleteReport(id: string): boolean {
  const all = loadReports();
  const idx = all.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  saveReports(all);
  return true;
}
