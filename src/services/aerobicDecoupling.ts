/**
 * Aerobic Decoupling Monitor — track cardiac drift during long runs.
 *
 * Aerobic decoupling measures how much heart rate rises in the second half
 * of a steady-effort run while pace remains constant. It's a key indicator
 * of aerobic fitness for marathon training.
 *
 * Decoupling % = ((HR₂/Pace₂) / (HR₁/Pace₁) - 1) × 100
 *   where HR₁,Pace₁ = first half averages; HR₂,Pace₂ = second half averages
 *
 * Research: Friel (2009), Coggan & Allen (2010)
 * Thresholds:
 *   < 5% → excellent aerobic base
 *   5-10% → adequate
 *   > 10% → aerobic base needs work
 */

import { persistence } from './db/persistence';

const DECOUPLING_HISTORY_KEY = 'apollo_aerobic_decoupling';
const MAX_HISTORY = 100;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SplitHRPace {
  /** Mile number (1-indexed) */
  mile: number;
  /** Pace in seconds per mile */
  paceSec: number;
  /** Average heart rate for this mile */
  avgHR: number;
}

export interface DecouplingResult {
  activityId: number;
  date: string;
  distanceMi: number;
  /** Average HR first half */
  hrFirstHalf: number;
  /** Average HR second half */
  hrSecondHalf: number;
  /** Average pace (sec/mi) first half */
  paceFirstHalf: number;
  /** Average pace (sec/mi) second half */
  paceSecondHalf: number;
  /** Decoupling percentage — positive = drift */
  decouplingPct: number;
  /** Rating based on thresholds */
  rating: 'excellent' | 'adequate' | 'needs_work';
  /** Number of valid splits used */
  splitsUsed: number;
}

export type DecouplingTrend = {
  /** Trend direction */
  trend: 'improving' | 'stable' | 'declining';
  /** Average decoupling from first half of history */
  earlyAvg: number;
  /** Average decoupling from second half of history */
  recentAvg: number;
  /** Change (negative = improving) */
  changePct: number;
  /** Human-readable message */
  message: string;
};

// ── Core Calculation ──────────────────────────────────────────────────────────

/**
 * Calculate aerobic decoupling from mile splits with HR data.
 *
 * Only meaningful for runs ≥ 8 miles at steady effort.
 * Filters out anomalous splits (walk breaks, stops).
 */
export function calculateDecoupling(
  splits: SplitHRPace[],
  distanceMi: number,
  activityId: number,
  date: string,
): DecouplingResult | null {
  if (distanceMi < 8 || splits.length < 6) return null;

  // Filter anomalous splits: remove splits where pace is >30% slower than median
  const paces = splits.map((s) => s.paceSec).sort((a, b) => a - b);
  const medianPace = paces[Math.floor(paces.length / 2)];
  const maxPace = medianPace * 1.3;
  const minHR = 90; // filter splits with implausibly low HR

  const validSplits = splits.filter(
    (s) => s.paceSec <= maxPace && s.avgHR >= minHR,
  );

  if (validSplits.length < 6) return null;

  // Split into first and second half
  const midpoint = Math.floor(validSplits.length / 2);
  const firstHalf = validSplits.slice(0, midpoint);
  const secondHalf = validSplits.slice(midpoint);

  // Calculate averages
  const hrFirstHalf = avg(firstHalf.map((s) => s.avgHR));
  const hrSecondHalf = avg(secondHalf.map((s) => s.avgHR));
  const paceFirstHalf = avg(firstHalf.map((s) => s.paceSec));
  const paceSecondHalf = avg(secondHalf.map((s) => s.paceSec));

  // Efficiency ratio: HR/Pace for each half
  // Higher ratio = less efficient (HR is higher relative to pace)
  const effFirst = hrFirstHalf / paceFirstHalf;
  const effSecond = hrSecondHalf / paceSecondHalf;

  // Decoupling % — positive means efficiency dropped (HR drifted up)
  const decouplingPct = Math.round(((effSecond / effFirst) - 1) * 10000) / 100;

  const rating = rateDecoupling(decouplingPct);

  return {
    activityId,
    date,
    distanceMi,
    hrFirstHalf: Math.round(hrFirstHalf),
    hrSecondHalf: Math.round(hrSecondHalf),
    paceFirstHalf: Math.round(paceFirstHalf),
    paceSecondHalf: Math.round(paceSecondHalf),
    decouplingPct,
    rating,
    splitsUsed: validSplits.length,
  };
}

function rateDecoupling(pct: number): 'excellent' | 'adequate' | 'needs_work' {
  if (pct < 5) return 'excellent';
  if (pct <= 10) return 'adequate';
  return 'needs_work';
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function saveDecouplingResult(result: DecouplingResult): void {
  const history = getDecouplingHistory();
  const idx = history.findIndex((h) => h.activityId === result.activityId);
  if (idx >= 0) {
    history[idx] = result;
  } else {
    history.push(result);
  }
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  persistence.setItem(DECOUPLING_HISTORY_KEY, JSON.stringify(history));
}

export function getDecouplingHistory(): DecouplingResult[] {
  try {
    const raw = persistence.getItem(DECOUPLING_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ── Trend Analysis ────────────────────────────────────────────────────────────

/**
 * Analyze decoupling trend over recent history.
 * Compares the early half of entries to the recent half.
 */
export function getDecouplingTrend(minEntries: number = 4): DecouplingTrend | null {
  const history = getDecouplingHistory()
    .sort((a, b) => a.date.localeCompare(b.date));

  if (history.length < minEntries) return null;

  const mid = Math.floor(history.length / 2);
  const earlyAvg = avg(history.slice(0, mid).map((h) => h.decouplingPct));
  const recentAvg = avg(history.slice(mid).map((h) => h.decouplingPct));
  const changePct = Math.round((recentAvg - earlyAvg) * 100) / 100;

  let trend: DecouplingTrend['trend'];
  if (changePct < -1.5) trend = 'improving';
  else if (changePct > 1.5) trend = 'declining';
  else trend = 'stable';

  const message = buildTrendMessage(trend, earlyAvg, recentAvg, history.length);

  return { trend, earlyAvg: Math.round(earlyAvg * 100) / 100, recentAvg: Math.round(recentAvg * 100) / 100, changePct, message };
}

function buildTrendMessage(
  trend: DecouplingTrend['trend'],
  earlyAvg: number,
  recentAvg: number,
  count: number,
): string {
  const earlyStr = earlyAvg.toFixed(1);
  const recentStr = recentAvg.toFixed(1);

  switch (trend) {
    case 'improving':
      return `Your aerobic decoupling dropped from ${earlyStr}% to ${recentStr}% over ${count} long runs — your marathon base is getting stronger.`;
    case 'declining':
      return `Your aerobic decoupling has risen from ${earlyStr}% to ${recentStr}%. Consider adding more easy-paced long runs to rebuild your aerobic base.`;
    case 'stable':
      return `Your aerobic decoupling is steady at ~${recentStr}% over ${count} long runs.${recentAvg < 5 ? ' Excellent aerobic base!' : recentAvg < 10 ? ' Solid foundation.' : ' Room for improvement with more easy mileage.'}`;
  }
}

// ── Coaching Integration ──────────────────────────────────────────────────────

/**
 * Get a coaching message based on the latest decoupling result.
 */
export function getDecouplingCoachingMessage(result: DecouplingResult): string {
  const pctStr = result.decouplingPct.toFixed(1);
  const hrDelta = result.hrSecondHalf - result.hrFirstHalf;

  switch (result.rating) {
    case 'excellent':
      return `Aerobic decoupling: ${pctStr}% — excellent! Your HR only drifted ${hrDelta} bpm. Your aerobic engine is well-tuned for marathon distance.`;
    case 'adequate':
      return `Aerobic decoupling: ${pctStr}% — adequate. Your HR rose ${hrDelta} bpm in the second half. More easy long runs will tighten this up.`;
    case 'needs_work':
      return `Aerobic decoupling: ${pctStr}% — your HR drifted ${hrDelta} bpm. Your aerobic base may need more development. Prioritize easy-paced long runs at conversational effort.`;
  }
}
