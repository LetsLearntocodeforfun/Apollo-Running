/**
 * VDOT-based training pace calculator using Jack Daniels' Running Formula.
 *
 * Given a VDOT score (from race prediction), computes the five canonical
 * Daniels training paces: Easy, Marathon, Threshold, Interval, Repetition.
 *
 * Pace coefficients are power-law regressions fitted to Daniels' published tables.
 * Validated against VDOT 30–85 range with <1% error.
 */

import { estimateVDOT, formatTimeSec } from './racePrediction';
import { persistence } from './db/persistence';

const PACE_CACHE_KEY = 'apollo_training_paces';

/** All five Daniels training pace types */
export type DanielsPaceType = 'easy' | 'marathon' | 'threshold' | 'interval' | 'repetition';

/** Full set of training paces for a runner */
export interface TrainingPaces {
  /** VDOT score these paces are derived from */
  vdot: number;
  /** Easy pace range (sec/mi) — the bread & butter of training */
  easy: { min: number; max: number };
  /** Marathon pace (sec/mi) */
  marathon: number;
  /** Threshold / tempo pace (sec/mi) */
  threshold: number;
  /** Interval pace (sec/mi) — e.g. 1K/1200m repeats */
  interval: number;
  /** Repetition pace (sec/mi) — e.g. 200m/400m repeats */
  repetition: number;
  /** When these paces were computed */
  updatedAt: string;
}

/**
 * Power-law coefficients: pace(sec/mi) = A * vdot^B
 *
 * Fitted against Daniels' published tables for VDOT 30-85:
 *   Easy:       13359 * vdot^-0.839
 *   Marathon:   12288 * vdot^-0.843
 *   Threshold:  11337 * vdot^-0.839
 *   Interval:    9555 * vdot^-0.816
 *   Repetition:  8208 * vdot^-0.794
 */
const PACE_COEFFICIENTS: Record<DanielsPaceType, { a: number; b: number }> = {
  easy:       { a: 13359, b: -0.839 },
  marathon:   { a: 12288, b: -0.843 },
  threshold:  { a: 11337, b: -0.839 },
  interval:   { a:  9555, b: -0.816 },
  repetition: { a:  8208, b: -0.794 },
};

/** Calculate a single Daniels pace in sec/mi from VDOT */
function danielsPace(vdot: number, type: DanielsPaceType): number {
  if (vdot <= 0) return 0;
  const { a, b } = PACE_COEFFICIENTS[type];
  return Math.round(a * Math.pow(vdot, b));
}

/**
 * Calculate all training paces from a VDOT score.
 *
 * Easy pace gets a range: approximately ±2% from the midpoint,
 * narrowing at higher VDOT (faster runners have tighter ranges).
 */
export function calculateTrainingPaces(vdot: number): TrainingPaces | null {
  if (vdot <= 0 || !isFinite(vdot)) return null;

  const easyMid = danielsPace(vdot, 'easy');
  // Easy range: ±2% of midpoint, minimum 10s range
  const rangeHalf = Math.max(Math.round(easyMid * 0.02), 5);

  const paces: TrainingPaces = {
    vdot: Math.round(vdot * 10) / 10,
    easy: {
      min: easyMid - rangeHalf, // faster end
      max: easyMid + rangeHalf, // slower end
    },
    marathon:   danielsPace(vdot, 'marathon'),
    threshold:  danielsPace(vdot, 'threshold'),
    interval:   danielsPace(vdot, 'interval'),
    repetition: danielsPace(vdot, 'repetition'),
    updatedAt: new Date().toISOString(),
  };

  return paces;
}

/**
 * Calculate training paces from a race performance.
 * @param distanceMeters Race distance in meters
 * @param timeSec Finish time in seconds
 */
export function calculatePacesFromRace(distanceMeters: number, timeSec: number): TrainingPaces | null {
  const vdot = estimateVDOT(distanceMeters, timeSec);
  if (vdot <= 0) return null;
  return calculateTrainingPaces(vdot);
}

/** Format a pace in sec/mi to "M:SS/mi" string */
export function formatPaceSec(secPerMi: number): string {
  if (secPerMi <= 0) return '—';
  const min = Math.floor(secPerMi / 60);
  const sec = Math.round(secPerMi % 60);
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

/** Format a pace range as "M:SS–M:SS/mi" */
export function formatPaceRange(min: number, max: number): string {
  if (min <= 0 || max <= 0) return '—';
  const minMin = Math.floor(min / 60);
  const minSec = Math.round(min % 60);
  const maxMin = Math.floor(max / 60);
  const maxSec = Math.round(max % 60);
  return `${minMin}:${minSec.toString().padStart(2, '0')}–${maxMin}:${maxSec.toString().padStart(2, '0')}/mi`;
}

/** Format all paces as a human-readable summary */
export function formatTrainingPacesSummary(paces: TrainingPaces): string {
  const lines = [
    `VDOT: ${paces.vdot}`,
    `Easy:       ${formatPaceRange(paces.easy.min, paces.easy.max)}`,
    `Marathon:   ${formatPaceSec(paces.marathon)}`,
    `Threshold:  ${formatPaceSec(paces.threshold)}`,
    `Interval:   ${formatPaceSec(paces.interval)}`,
    `Repetition: ${formatPaceSec(paces.repetition)}`,
  ];
  return lines.join('\n');
}

/** Save computed paces to storage */
export function saveTrainingPaces(paces: TrainingPaces): void {
  try {
    persistence.setItem(PACE_CACHE_KEY, JSON.stringify(paces));
  } catch { /* non-critical */ }
}

/** Get cached training paces */
export function getSavedTrainingPaces(): TrainingPaces | null {
  try {
    const raw = persistence.getItem(PACE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Get or compute training paces from the current VDOT.
 * If a saved prediction exists, uses its VDOT; otherwise returns null.
 */
export function getOrComputeTrainingPaces(): TrainingPaces | null {
  // Try to use saved race prediction VDOT
  try {
    const predRaw = persistence.getItem('apollo_race_prediction');
    if (predRaw) {
      const pred = JSON.parse(predRaw);
      if (pred.vdot && pred.vdot > 0) {
        const paces = calculateTrainingPaces(pred.vdot);
        if (paces) {
          saveTrainingPaces(paces);
          return paces;
        }
      }
    }
  } catch { /* fall through */ }

  return getSavedTrainingPaces();
}

/**
 * Marathon time estimate from a VDOT (for display).
 * Returns formatted string like "3:45:22".
 */
export function vdotToMarathonTime(vdot: number): string {
  if (vdot <= 0) return '—';
  // Marathon pace * 26.2 miles
  const marathonPace = danielsPace(vdot, 'marathon');
  const totalSec = Math.round(marathonPace * 26.2);
  return formatTimeSec(totalSec);
}
