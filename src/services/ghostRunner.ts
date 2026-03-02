/**
 * Ghost Runner — overlay a past run's pace on a current run for comparison.
 *
 * Select any past long run or race and compare mile-by-mile against
 * another effort. Generates comparison data for SVG chart overlay.
 */

import { persistence } from './db/persistence';

const GHOST_HISTORY_KEY = 'apollo_ghost_comparisons';
const MAX_GHOST_HISTORY = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GhostSplit {
  mile: number;
  paceSec: number; // seconds per mile
  elapsedSec: number; // cumulative time at end of this mile
}

export interface GhostRun {
  activityId: number;
  date: string;
  name: string;
  distanceMi: number;
  totalTimeSec: number;
  splits: GhostSplit[];
}

export interface GhostComparisonMile {
  mile: number;
  /** Current run pace (sec/mi) */
  currentPace: number;
  /** Ghost run pace (sec/mi) */
  ghostPace: number;
  /** Delta: positive = current is slower */
  deltaSec: number;
  /** Cumulative delta from mile 1 */
  cumulativeDeltaSec: number;
  /** Current cumulative time */
  currentElapsed: number;
  /** Ghost cumulative time */
  ghostElapsed: number;
}

export interface GhostComparison {
  currentRun: { activityId: number; date: string; name: string };
  ghostRun: { activityId: number; date: string; name: string };
  miles: GhostComparisonMile[];
  /** Total time difference at comparable distance */
  totalDeltaSec: number;
  /** Miles compared (limited to shorter run) */
  milesCompared: number;
  /** Summary message */
  summary: string;
}

// ── Core Comparison ───────────────────────────────────────────────────────────

/**
 * Compare two runs mile-by-mile and produce ghost overlay data.
 */
export function compareRuns(current: GhostRun, ghost: GhostRun): GhostComparison {
  const milesCompared = Math.min(current.splits.length, ghost.splits.length);
  const miles: GhostComparisonMile[] = [];
  let cumulativeDelta = 0;

  for (let i = 0; i < milesCompared; i++) {
    const c = current.splits[i];
    const g = ghost.splits[i];
    const deltaSec = c.paceSec - g.paceSec;
    cumulativeDelta += deltaSec;

    miles.push({
      mile: i + 1,
      currentPace: c.paceSec,
      ghostPace: g.paceSec,
      deltaSec: Math.round(deltaSec),
      cumulativeDeltaSec: Math.round(cumulativeDelta),
      currentElapsed: c.elapsedSec,
      ghostElapsed: g.elapsedSec,
    });
  }

  const totalDeltaSec = Math.round(cumulativeDelta);
  const summary = buildSummary(current, ghost, miles, totalDeltaSec, milesCompared);

  return {
    currentRun: { activityId: current.activityId, date: current.date, name: current.name },
    ghostRun: { activityId: ghost.activityId, date: ghost.date, name: ghost.name },
    miles,
    totalDeltaSec,
    milesCompared,
    summary,
  };
}

/**
 * Get the comparison message at a specific mile during a run.
 */
export function getGhostMessageAtMile(comparison: GhostComparison, mile: number): string {
  const data = comparison.miles.find((m) => m.mile === mile);
  if (!data) return '';

  const abs = Math.abs(data.cumulativeDeltaSec);
  const direction = data.cumulativeDeltaSec > 0 ? 'behind' : 'ahead of';
  const ghostDate = comparison.ghostRun.date;

  return `At mile ${mile}, you are ${abs} seconds ${direction} your ${ghostDate} effort`;
}

// ── Build from Activity Data ──────────────────────────────────────────────────

/**
 * Build a GhostRun from raw split data (typically from Strava/Garmin activity).
 */
export function buildGhostRun(
  activityId: number,
  date: string,
  name: string,
  splitPacesSec: number[], // pace (sec/mi) for each mile
): GhostRun {
  const splits: GhostSplit[] = [];
  let elapsed = 0;

  for (let i = 0; i < splitPacesSec.length; i++) {
    elapsed += splitPacesSec[i];
    splits.push({
      mile: i + 1,
      paceSec: splitPacesSec[i],
      elapsedSec: elapsed,
    });
  }

  return {
    activityId,
    date,
    name,
    distanceMi: splitPacesSec.length,
    totalTimeSec: elapsed,
    splits,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function saveGhostComparison(comparison: GhostComparison): void {
  const history = getGhostHistory();
  history.push(comparison);
  if (history.length > MAX_GHOST_HISTORY) {
    history.splice(0, history.length - MAX_GHOST_HISTORY);
  }
  persistence.setItem(GHOST_HISTORY_KEY, JSON.stringify(history));
}

export function getGhostHistory(): GhostComparison[] {
  try {
    const raw = persistence.getItem(GHOST_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSummary(
  _current: GhostRun,
  ghost: GhostRun,
  miles: GhostComparisonMile[],
  totalDelta: number,
  milesCompared: number,
): string {
  const abs = Math.abs(totalDelta);
  const direction = totalDelta > 0 ? 'slower than' : 'faster than';
  const minutes = Math.floor(abs / 60);
  const seconds = abs % 60;
  const deltaStr = minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}`
    : `${seconds}s`;

  // Find best and worst miles
  let bestMile = miles[0];
  let worstMile = miles[0];
  for (const m of miles) {
    if (m.deltaSec < bestMile.deltaSec) bestMile = m;
    if (m.deltaSec > worstMile.deltaSec) worstMile = m;
  }

  const parts = [
    `Over ${milesCompared} miles, you were ${deltaStr} ${direction} your ${ghost.date} run.`,
    `Best mile: ${bestMile.mile} (${Math.abs(bestMile.deltaSec)}s ${bestMile.deltaSec < 0 ? 'faster' : 'slower'}).`,
    `Toughest mile: ${worstMile.mile} (${Math.abs(worstMile.deltaSec)}s ${worstMile.deltaSec > 0 ? 'slower' : 'faster'}).`,
  ];

  return parts.join(' ');
}
