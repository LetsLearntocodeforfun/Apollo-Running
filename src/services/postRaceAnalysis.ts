/**
 * Post-Race Analysis Service
 *
 * Compares actual race execution to the planned strategy.
 * Identifies where the runner followed/diverged from the plan,
 * provides actionable feedback, and captures lessons learned.
 */

import { persistence } from './db/persistence';
import type { RaceStrategy } from '../types/raceStrategy';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ActualMileSplit {
  mile: number;
  paceSec: number;
  heartRate?: number;
  elevationGainFt?: number;
  cadence?: number;
}

export interface MileComparison {
  mile: number;
  plannedPaceSec: number;
  actualPaceSec: number;
  deltaSec: number;           // positive = slower than plan
  plannedCumSec: number;
  actualCumSec: number;
  cumDeltaSec: number;
  verdict: 'on_target' | 'slightly_fast' | 'too_fast' | 'slightly_slow' | 'too_slow';
  notes: string;
}

export interface SplitAnalysis {
  firstHalfActualSec: number;
  secondHalfActualSec: number;
  firstHalfPlannedSec: number;
  secondHalfPlannedSec: number;
  actualSplitDiff: number;     // positive = positive split
  plannedSplitDiff: number;
  splitType: 'negative' | 'even' | 'positive';
}

export interface PaceSegment {
  label: string;
  startMile: number;
  endMile: number;
  avgPaceSec: number;
  plannedAvgSec: number;
  deltaSec: number;
}

export interface PostRaceReport {
  id: string;
  strategyId: string;
  strategyName: string;
  marathonName: string;
  raceDate: string;
  actualFinishSec: number;
  actualFinishFormatted: string;
  plannedFinishSec: number;
  plannedFinishFormatted: string;
  deltaFinishSec: number;
  mileComparisons: MileComparison[];
  splitAnalysis: SplitAnalysis;
  segments: PaceSegment[];
  grade: PostRaceGrade;
  insights: string[];
  lessonsLearned: string;
  createdAt: string;
}

export type PostRaceGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'D' | 'F';

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'apollo_post_race_reports';

function loadReports(): PostRaceReport[] {
  const raw = persistence.getItem(STORAGE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function saveReports(reports: PostRaceReport[]): void {
  persistence.setItem(STORAGE_KEY, JSON.stringify(reports));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.round(totalSec % 60);
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatPace(secPerMi: number): string {
  const m = Math.floor(secPerMi / 60);
  const s = Math.round(secPerMi % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function getMileVerdict(deltaSec: number): MileComparison['verdict'] {
  if (deltaSec <= -15) return 'too_fast';
  if (deltaSec < -5) return 'slightly_fast';
  if (deltaSec <= 5) return 'on_target';
  if (deltaSec <= 15) return 'slightly_slow';
  return 'too_slow';
}

function getMileNotes(mile: number, deltaSec: number, actualPace: number, plannedPace: number): string {
  const verdict = getMileVerdict(deltaSec);
  const absDelta = Math.abs(deltaSec);

  if (verdict === 'on_target') return 'Right on target.';

  const direction = deltaSec > 0 ? 'slower' : 'faster';
  const base = `${absDelta}s ${direction} than planned (${formatPace(actualPace)} vs ${formatPace(plannedPace)}).`;

  if (mile <= 5 && deltaSec < -10) {
    return `${base} Going out too fast in the early miles is the #1 marathon mistake.`;
  }
  if (mile >= 20 && deltaSec > 15) {
    return `${base} Late-race slowdown — this is where fueling, training, and pacing discipline show.`;
  }
  if (mile >= 20 && deltaSec < -5) {
    return `${base} Strong finish — negative splitting the late miles is elite-level execution.`;
  }
  return base;
}

function calculateGrade(
  finishDelta: number,
  mileComparisons: MileComparison[],
  splitAnalysis: SplitAnalysis,
): PostRaceGrade {
  let score = 100;

  // Finish time delta (max 30 points off)
  const finishPenalty = Math.min(Math.abs(finishDelta) / 10, 30);
  score -= finishPenalty;

  // Pacing consistency (max 30 points off)
  const avgAbsDelta = mileComparisons.reduce((s, m) => s + Math.abs(m.deltaSec), 0) / mileComparisons.length;
  const pacePenalty = Math.min(avgAbsDelta / 2, 30);
  score -= pacePenalty;

  // Early pace discipline (max 20 points off) — going out too fast
  const earlyMiles = mileComparisons.filter((m) => m.mile <= 5);
  const earlyAvgDelta = earlyMiles.reduce((s, m) => s + m.deltaSec, 0) / (earlyMiles.length || 1);
  if (earlyAvgDelta < -10) {
    score -= Math.min(Math.abs(earlyAvgDelta), 20);
  }

  // Late-race fade (max 20 points off)
  const lateMiles = mileComparisons.filter((m) => m.mile >= 20);
  const lateAvgDelta = lateMiles.reduce((s, m) => s + m.deltaSec, 0) / (lateMiles.length || 1);
  if (lateAvgDelta > 15) {
    score -= Math.min(lateAvgDelta - 10, 20);
  }

  // Positive split bonus/penalty
  if (splitAnalysis.splitType === 'negative') score += 5;
  else if (splitAnalysis.actualSplitDiff > 180) score -= 10;

  score = Math.max(0, Math.min(100, score));

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

// ── Core Analysis ─────────────────────────────────────────────────────────────

/**
 * Generate a post-race analysis report comparing actual splits to planned strategy.
 */
export function analyzeRace(
  strategy: RaceStrategy,
  actualSplits: ActualMileSplit[],
  raceDate: string,
  lessonsLearned?: string,
): PostRaceReport {
  const planned = strategy.milePaces;

  // Build mile-by-mile comparison
  let actualCum = 0;
  const mileComparisons: MileComparison[] = actualSplits.map((actual) => {
    actualCum += actual.paceSec;
    const plan = planned.find((p) => p.mile === actual.mile) ?? planned[Math.min(actual.mile - 1, planned.length - 1)];
    const deltaSec = Math.round(actual.paceSec - plan.targetPaceSec);

    return {
      mile: actual.mile,
      plannedPaceSec: plan.targetPaceSec,
      actualPaceSec: actual.paceSec,
      deltaSec,
      plannedCumSec: plan.cumulativeTimeSec,
      actualCumSec: actualCum,
      cumDeltaSec: Math.round(actualCum - plan.cumulativeTimeSec),
      verdict: getMileVerdict(deltaSec),
      notes: getMileNotes(actual.mile, deltaSec, actual.paceSec, plan.targetPaceSec),
    };
  });

  // Split analysis (first half vs second half)
  const halfMile = 13;
  const firstHalfActual = actualSplits.filter((s) => s.mile <= halfMile).reduce((sum, s) => sum + s.paceSec, 0);
  const secondHalfActual = actualSplits.filter((s) => s.mile > halfMile).reduce((sum, s) => sum + s.paceSec, 0);
  const actualSplitDiff = secondHalfActual - firstHalfActual;

  const splitAnalysis: SplitAnalysis = {
    firstHalfActualSec: firstHalfActual,
    secondHalfActualSec: secondHalfActual,
    firstHalfPlannedSec: strategy.firstHalfSec,
    secondHalfPlannedSec: strategy.secondHalfSec,
    actualSplitDiff,
    plannedSplitDiff: strategy.secondHalfSec - strategy.firstHalfSec,
    splitType: actualSplitDiff < -30 ? 'negative' : actualSplitDiff > 30 ? 'positive' : 'even',
  };

  // Segment analysis (5K chunks)
  const segmentDefs = [
    { label: 'Miles 1-5', startMile: 1, endMile: 5 },
    { label: 'Miles 6-10', startMile: 6, endMile: 10 },
    { label: 'Miles 11-15', startMile: 11, endMile: 15 },
    { label: 'Miles 16-20', startMile: 16, endMile: 20 },
    { label: 'Miles 21-26.2', startMile: 21, endMile: 27 },
  ];

  const segments: PaceSegment[] = segmentDefs.map((seg) => {
    const segActual = actualSplits.filter((s) => s.mile >= seg.startMile && s.mile <= seg.endMile);
    const segPlanned = planned.filter((p) => p.mile >= seg.startMile && p.mile <= seg.endMile);

    const avgActual = segActual.length > 0 ? segActual.reduce((s, m) => s + m.paceSec, 0) / segActual.length : 0;
    const avgPlanned = segPlanned.length > 0 ? segPlanned.reduce((s, m) => s + m.targetPaceSec, 0) / segPlanned.length : 0;

    return {
      label: seg.label,
      startMile: seg.startMile,
      endMile: seg.endMile,
      avgPaceSec: Math.round(avgActual),
      plannedAvgSec: Math.round(avgPlanned),
      deltaSec: Math.round(avgActual - avgPlanned),
    };
  });

  const actualFinish = actualSplits.reduce((sum, s) => sum + s.paceSec, 0);
  const deltaFinish = Math.round(actualFinish - strategy.targetTimeSec);
  const grade = calculateGrade(deltaFinish, mileComparisons, splitAnalysis);

  // Generate insights
  const insights = generateInsights(mileComparisons, splitAnalysis, segments, deltaFinish);

  const report: PostRaceReport = {
    id: `report_${Date.now()}`,
    strategyId: strategy.id,
    strategyName: strategy.name,
    marathonName: strategy.marathonName,
    raceDate,
    actualFinishSec: actualFinish,
    actualFinishFormatted: formatTime(actualFinish),
    plannedFinishSec: strategy.targetTimeSec,
    plannedFinishFormatted: strategy.targetTimeFormatted,
    deltaFinishSec: deltaFinish,
    mileComparisons,
    splitAnalysis,
    segments,
    grade,
    insights,
    lessonsLearned: lessonsLearned ?? '',
    createdAt: new Date().toISOString(),
  };

  // Persist
  const all = loadReports();
  all.push(report);
  saveReports(all);

  return report;
}

function generateInsights(
  miles: MileComparison[],
  splits: SplitAnalysis,
  segments: PaceSegment[],
  finishDelta: number,
): string[] {
  const insights: string[] = [];

  // Finish time
  if (Math.abs(finishDelta) <= 60) {
    insights.push(`Finished within 1 minute of target — excellent pacing discipline.`);
  } else if (finishDelta > 0) {
    insights.push(`Finished ${formatTime(finishDelta)} slower than target. ${finishDelta > 300 ? 'Significant deviation — review contributing factors.' : 'Minor deviation — adjustable with small pacing tweaks.'}`);
  } else {
    insights.push(`Finished ${formatTime(Math.abs(finishDelta))} faster than target — you may be undertargeting. Consider a more aggressive goal next time.`);
  }

  // Split type
  if (splits.splitType === 'negative') {
    insights.push(`Negative split by ${formatTime(Math.abs(splits.actualSplitDiff))} — strong execution. Running the second half faster demonstrates excellent fatigue resistance.`);
  } else if (splits.splitType === 'positive' && splits.actualSplitDiff > 180) {
    insights.push(`Positive split by ${formatTime(splits.actualSplitDiff)}. A conservative first half saves ~${Math.round(splits.actualSplitDiff * 0.3)}s overall by preventing late-race fade.`);
  }

  // Early miles
  const earlyFast = miles.filter((m) => m.mile <= 5 && m.deltaSec < -10);
  if (earlyFast.length >= 3) {
    const avgFast = Math.round(earlyFast.reduce((s, m) => s + Math.abs(m.deltaSec), 0) / earlyFast.length);
    insights.push(`You went out ${avgFast}s/mi faster than planned in the first 5 miles. This is the #1 correlator of late-race slowdown.`);
  }

  // The wall check (miles 20-26)
  const wallMiles = miles.filter((m) => m.mile >= 20 && m.deltaSec > 20);
  if (wallMiles.length >= 3) {
    const avgSlow = Math.round(wallMiles.reduce((s, m) => s + m.deltaSec, 0) / wallMiles.length);
    insights.push(`Significant slowdown of +${avgSlow}s/mi after mile 20 — classic "wall" pattern. Focus on fueling, more long runs at MP, and conservative early pacing.`);
  }

  // Consistency
  const onTarget = miles.filter((m) => m.verdict === 'on_target').length;
  const pct = Math.round((onTarget / miles.length) * 100);
  if (pct >= 70) {
    insights.push(`${pct}% of miles were within ±5s of target — exceptional pacing consistency.`);
  } else if (pct < 40) {
    insights.push(`Only ${pct}% of miles were within ±5s of target. Practice running by effort and checking pace less frequently to build internal pacing sense.`);
  }

  // Best/worst segments
  const bestSeg = segments.reduce((best, seg) => Math.abs(seg.deltaSec) < Math.abs(best.deltaSec) ? seg : best);
  const worstSeg = segments.reduce((worst, seg) => Math.abs(seg.deltaSec) > Math.abs(worst.deltaSec) ? seg : worst);
  if (Math.abs(worstSeg.deltaSec) > 15) {
    insights.push(`Strongest execution: ${bestSeg.label} (${formatPace(bestSeg.avgPaceSec)}/mi, Δ${bestSeg.deltaSec > 0 ? '+' : ''}${bestSeg.deltaSec}s). Weakest: ${worstSeg.label} (${formatPace(worstSeg.avgPaceSec)}/mi, Δ+${Math.abs(worstSeg.deltaSec)}s).`);
  }

  return insights;
}

// ── Report Management ─────────────────────────────────────────────────────────

export function getAllReports(): PostRaceReport[] {
  return loadReports();
}

export function getReportById(id: string): PostRaceReport | undefined {
  return loadReports().find((r) => r.id === id);
}

export function getReportsForStrategy(strategyId: string): PostRaceReport[] {
  return loadReports().filter((r) => r.strategyId === strategyId);
}

export function updateLessonsLearned(reportId: string, lessons: string): boolean {
  const all = loadReports();
  const report = all.find((r) => r.id === reportId);
  if (!report) return false;
  report.lessonsLearned = lessons;
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
