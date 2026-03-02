/**
 * Compliance Analysis — compares actual run performance against
 * VDOT-derived workout targets and generates feedback + scoring.
 *
 * Called after auto-sync to evaluate how well the runner executed
 * each workout relative to its prescribed targets.
 */

import type { ComplianceResult, WorkoutTarget } from '../types/workout';
import { getWorkoutTarget } from './workoutTargets';
import { getOrComputeTrainingPaces } from './paceCalculator';
import { formatPaceFromMinPerMi } from './unitPreferences';
import { persistence } from './db/persistence';

const COMPLIANCE_KEY = 'apollo_compliance_results';

/**
 * Analyze a single run for compliance against its workout target.
 *
 * @param note Plan day note (e.g. "Easy", "Tempo", "Speed")
 * @param actualPaceMinPerMi Actual average pace in min/mi
 * @param actualDistanceMi Actual distance in miles
 * @param plannedDistanceMi Planned distance in miles
 * @returns ComplianceResult with score, feedback, and coaching
 */
export function analyzeCompliance(
  note: string,
  actualPaceMinPerMi: number,
  actualDistanceMi: number,
  plannedDistanceMi: number,
): ComplianceResult | null {
  if (!note || actualPaceMinPerMi <= 0) return null;

  const paces = getOrComputeTrainingPaces();
  if (!paces) return null;

  const target = getWorkoutTarget(note, paces.vdot, plannedDistanceMi);
  if (!target) return null;

  const actualPaceSec = Math.round(actualPaceMinPerMi * 60);

  // Calculate pace compliance
  const paceCompliance = analyzePaceCompliance(actualPaceSec, target);

  // Calculate distance compliance
  const distanceCompliance = analyzeDistanceCompliance(actualDistanceMi, plannedDistanceMi);

  // Overall score: 70% pace compliance + 30% distance compliance
  const paceScore = calculatePaceScore(actualPaceSec, target);
  const overallScore = Math.round(paceScore * 0.7 + distanceCompliance.score * 0.3);

  // Generate feedback
  const feedback = generateComplianceFeedback(target, paceCompliance, distanceCompliance, actualPaceMinPerMi);
  const coachingSuggestion = generateCoachingSuggestion(target, paceCompliance);

  return {
    score: overallScore,
    paceCompliance,
    distanceCompliance,
    feedback,
    coachingSuggestion,
  };
}

/**
 * Analyze pace compliance against the workout target range.
 */
function analyzePaceCompliance(
  actualPaceSec: number,
  target: WorkoutTarget,
): ComplianceResult['paceCompliance'] {
  const range = target.targetPaceRange;
  if (!range) {
    return {
      inRange: true,
      actualPaceSecPerMi: actualPaceSec,
      deviationSec: 0,
      direction: 'on_target',
    };
  }

  let deviationSec = 0;
  let direction: 'too_fast' | 'too_slow' | 'on_target' = 'on_target';
  let inRange = true;

  if (actualPaceSec < range.minSecPerMi) {
    // Too fast
    deviationSec = range.minSecPerMi - actualPaceSec;
    direction = 'too_fast';
    inRange = false;
  } else if (actualPaceSec > range.maxSecPerMi) {
    // Too slow
    deviationSec = actualPaceSec - range.maxSecPerMi;
    direction = 'too_slow';
    inRange = false;
  }

  return {
    inRange,
    actualPaceSecPerMi: actualPaceSec,
    targetRange: range,
    deviationSec,
    direction,
  };
}

/**
 * Calculate pace compliance score (0-100).
 * Full credit if in range, proportional penalty outside range.
 */
function calculatePaceScore(actualPaceSec: number, target: WorkoutTarget): number {
  const range = target.targetPaceRange;
  if (!range) return 100; // No target = full credit

  if (actualPaceSec >= range.minSecPerMi && actualPaceSec <= range.maxSecPerMi) {
    return 100; // In range = perfect
  }

  // Out of range: score decreases proportionally
  // 10 sec/mi off = ~85, 20 sec/mi off = ~70, 30+ sec/mi off = ~55
  const rangeMid = (range.minSecPerMi + range.maxSecPerMi) / 2;
  const deviation = actualPaceSec < range.minSecPerMi
    ? range.minSecPerMi - actualPaceSec
    : actualPaceSec - range.maxSecPerMi;
  const maxDeviation = rangeMid * 0.15; // 15% of target pace = zero credit
  const penalty = Math.min(deviation / maxDeviation, 1) * 50;
  return Math.max(Math.round(100 - penalty), 50);
}

/**
 * Analyze distance compliance.
 */
function analyzeDistanceCompliance(
  actualMi: number,
  plannedMi: number,
): ComplianceResult['distanceCompliance'] {
  if (plannedMi <= 0) {
    return { score: 100, actualMi, plannedMi, diffPct: 0 };
  }

  const diffPct = ((actualMi - plannedMi) / plannedMi) * 100;
  let score: number;

  if (Math.abs(diffPct) <= 5) {
    score = 100; // Within 5% = perfect
  } else if (diffPct > 5) {
    // Over-distance: mild penalty (better than under)
    score = Math.max(80, Math.round(100 - (diffPct - 5)));
  } else {
    // Under-distance: stronger penalty
    score = Math.max(50, Math.round(100 + (diffPct + 5) * 1.5));
  }

  return { score, actualMi, plannedMi, diffPct: Math.round(diffPct) };
}

/**
 * Generate human-readable compliance feedback.
 */
function generateComplianceFeedback(
  _target: WorkoutTarget,
  paceCompliance: ComplianceResult['paceCompliance'],
  _distanceCompliance: ComplianceResult['distanceCompliance'],
  actualPaceMinPerMi: number,
): string {
  const paceStr = formatPaceFromMinPerMi(actualPaceMinPerMi);
  const lines: string[] = [];

  if (!paceCompliance.targetRange) {
    lines.push(`Ran at ${paceStr}.`);
    return lines.join(' ');
  }

  const targetMin = paceCompliance.targetRange.minSecPerMi;
  const targetMax = paceCompliance.targetRange.maxSecPerMi;
  const targetMinStr = formatSecToPace(targetMin);
  const targetMaxStr = formatSecToPace(targetMax);

  if (paceCompliance.inRange) {
    lines.push(`Right on target at ${paceStr} (goal: ${targetMinStr}–${targetMaxStr}/mi). Perfect execution.`);
  } else if (paceCompliance.direction === 'too_fast') {
    lines.push(
      `Averaged ${paceStr} — ${paceCompliance.deviationSec}s/mi faster than the ${targetMinStr}–${targetMaxStr}/mi target.`
    );
  } else {
    lines.push(
      `Averaged ${paceStr} — ${paceCompliance.deviationSec}s/mi slower than the ${targetMinStr}–${targetMaxStr}/mi target.`
    );
  }

  return lines.join(' ');
}

/**
 * Generate specific coaching suggestions based on compliance.
 */
function generateCoachingSuggestion(
  target: WorkoutTarget,
  paceCompliance: ComplianceResult['paceCompliance'],
): string | undefined {
  if (paceCompliance.inRange) return undefined;

  const dev = paceCompliance.deviationSec;
  const cat = target.category;

  if (paceCompliance.direction === 'too_fast') {
    if (cat === 'easy' || cat === 'long' || cat === 'medium_long') {
      if (dev > 20) {
        return `Your easy pace is significantly too fast. Running easy days hard ` +
          `increases injury risk and reduces the quality of your hard sessions. ` +
          `Slow down — easy runs build aerobic base best when truly easy.`;
      }
      return `Try slowing down on easy days. The purpose is active recovery and aerobic base building, not speed.`;
    }
    if (cat === 'tempo') {
      if (dev > 15) {
        return `Your tempo was faster than threshold pace. Running tempos too fast ` +
          `turns them into VO2max sessions and requires more recovery. ` +
          `Dial back to maximize lactate threshold adaptation.`;
      }
      return `Slightly faster than tempo target. Consider dialing back to maximize threshold adaptation.`;
    }
    if (cat === 'speed') {
      return `Running intervals too fast can compromise form and recovery. ` +
        `Focus on consistent repeats at the target pace rather than maximum effort.`;
    }
  }

  if (paceCompliance.direction === 'too_slow') {
    if (cat === 'tempo') {
      if (dev > 15) {
        return `Your tempo pace was well below threshold. To improve lactate threshold, ` +
          `you need to run at a pace that's comfortably hard — hard enough that you ` +
          `can only speak in short phrases.`;
      }
      return `A bit slower than tempo target. Try to hold pace more consistently next time.`;
    }
    if (cat === 'speed') {
      return `Interval pace was below target. If you're fatigued, reduce the number of repeats ` +
        `rather than slowing down — quality over quantity for speed work.`;
    }
    if (cat === 'easy' || cat === 'long') {
      // Slower than easy pace is usually fine
      return undefined;
    }
  }

  return undefined;
}

/** Format seconds to M:SS */
function formatSecToPace(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Compliance History ──

interface ComplianceEntry {
  date: string;
  weekIndex: number;
  dayIndex: number;
  result: ComplianceResult;
}

/** Save a compliance result for a specific day */
export function saveComplianceResult(
  weekIndex: number,
  dayIndex: number,
  result: ComplianceResult,
): void {
  try {
    const store = getComplianceStore();
    const key = `${weekIndex}:${dayIndex}`;
    store[key] = {
      date: new Date().toISOString().slice(0, 10),
      weekIndex,
      dayIndex,
      result,
    };
    // Keep last 365 entries
    const keys = Object.keys(store);
    if (keys.length > 365) {
      const sorted = keys.sort((a, b) =>
        (store[a].date ?? '').localeCompare(store[b].date ?? ''));
      for (const old of sorted.slice(0, keys.length - 365)) {
        delete store[old];
      }
    }
    persistence.setItem(COMPLIANCE_KEY, JSON.stringify(store));
  } catch { /* non-critical */ }
}

/** Get compliance result for a specific week/day */
export function getComplianceResult(weekIndex: number, dayIndex: number): ComplianceResult | null {
  const store = getComplianceStore();
  return store[`${weekIndex}:${dayIndex}`]?.result ?? null;
}

/** Get all compliance results */
export function getAllComplianceResults(): ComplianceEntry[] {
  const store = getComplianceStore();
  return Object.values(store).sort((a, b) => a.date.localeCompare(b.date));
}

/** Calculate weekly compliance trend (average score per week) */
export function getWeeklyComplianceTrend(): { weekIndex: number; avgScore: number; count: number }[] {
  const entries = getAllComplianceResults();
  const byWeek = new Map<number, number[]>();

  for (const entry of entries) {
    const scores = byWeek.get(entry.weekIndex) ?? [];
    scores.push(entry.result.score);
    byWeek.set(entry.weekIndex, scores);
  }

  return Array.from(byWeek.entries())
    .map(([weekIndex, scores]) => ({
      weekIndex,
      avgScore: Math.round(scores.reduce((s, v) => s + v, 0) / scores.length),
      count: scores.length,
    }))
    .sort((a, b) => a.weekIndex - b.weekIndex);
}

function getComplianceStore(): Record<string, ComplianceEntry> {
  try {
    const raw = persistence.getItem(COMPLIANCE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
