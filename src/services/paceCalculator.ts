/**
 * VDOT-based training pace calculator using Jack Daniels' Running Formula.
 *
 * Given a VDOT score (from race prediction), computes the five canonical
 * Daniels training paces: Easy, Marathon, Threshold, Interval, Repetition.
 *
 * v1.0.6 (V1, V13, A-01): paces come straight from the Daniels–Gilbert oxygen
 * cost equation VO2 = −4.60 + 0.182258·v + 0.000104·v² (v in m/min) — the same
 * engine as racePrediction, so paces and predictions always agree:
 *   - Easy:       59–74 % of VO2max (a range)
 *   - Marathon:   marathon race pace at this VDOT (`raceTimeFromVdot`)
 *   - Threshold:  88 % of VO2max
 *   - Interval:   97.5 % of VO2max
 *   - Repetition: mile race pace at this VDOT (faster than I)
 * (The old power-law fit gave a marathon time ~2× too slow — V1.)
 *
 * The VDOT itself comes from `deriveVdot()` (races, best efforts, heart rate,
 * goal) — never from easy training pace.
 */

import {
  deriveVdot,
  estimateVDOT,
  formatTimeSec,
  MARATHON_M,
  raceTimeFromVdot,
  vdotToMarathonSec,
  velocityAtVo2,
  type DeriveVdotOptions,
  type DerivedVdot,
  type VdotConfidence,
  type VdotSource,
} from './racePrediction';
import { persistence } from './db/persistence';

const PACE_CACHE_KEY = 'apollo_training_paces';
const METERS_PER_MILE = 1609.344;

/** All five Daniels training pace types */
export type DanielsPaceType = 'easy' | 'marathon' | 'threshold' | 'interval' | 'repetition';

/** Full set of training paces for a runner */
export interface TrainingPaces {
  /** VDOT score these paces are derived from */
  vdot: number;
  /** Easy pace range (sec/mi) — the bread & butter of training. `min` = faster end (74 % VO2max), `max` = slower end (59 %). */
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
  // ── v1.0.6 (optional; set when the VDOT came from deriveVdot) ──
  /** Where the VDOT came from. */
  source?: VdotSource;
  /** Confidence of that source. */
  confidence?: VdotConfidence;
  /** Human-readable description of the source, e.g. "Half marathon in 1:35:00 on 2026-09-12". */
  sourceDetail?: string;
  /** YYYY-MM-DD of the performance behind the VDOT (null for heart-rate estimates and goals). */
  asOf?: string | null;
}

/** Fractions of VO2max used for the Daniels intensities (Daniels' Running Formula). */
export const DANIELS_INTENSITY = {
  /** Fast end of the easy range. */
  easyFast: 0.74,
  /** Slow end of the easy range. */
  easySlow: 0.59,
  threshold: 0.88,
  interval: 0.975,
} as const;

/** Pace (sec/mi, unrounded) of running at `fraction` of VO2max for a VDOT. */
function paceAtFraction(vdot: number, fraction: number): number {
  const v = velocityAtVo2(vdot * fraction);
  return v > 0 ? (METERS_PER_MILE / v) * 60 : 0;
}

/** All-out race pace (sec/mi, unrounded) over `meters` for a VDOT. */
function racePace(vdot: number, meters: number): number {
  const t = raceTimeFromVdot(vdot, meters);
  return t > 0 ? t / (meters / METERS_PER_MILE) : 0;
}

/** Calculate a single Daniels pace in sec/mi from VDOT (easy = middle of the E range). */
function danielsPace(vdot: number, type: DanielsPaceType): number {
  if (!(vdot > 0) || !Number.isFinite(vdot)) return 0;
  switch (type) {
    case 'easy':
      return Math.round((paceAtFraction(vdot, DANIELS_INTENSITY.easyFast) + paceAtFraction(vdot, DANIELS_INTENSITY.easySlow)) / 2);
    case 'marathon':
      return Math.round(racePace(vdot, MARATHON_M));
    case 'threshold':
      return Math.round(paceAtFraction(vdot, DANIELS_INTENSITY.threshold));
    case 'interval':
      return Math.round(paceAtFraction(vdot, DANIELS_INTENSITY.interval));
    case 'repetition':
      return Math.round(racePace(vdot, METERS_PER_MILE));
  }
}

/**
 * Calculate all training paces from a VDOT score (Daniels–Gilbert, see the
 * module comment). Anchors at VDOT 50: E ≈ 7:52–9:26/mi, M ≈ 7:17/mi,
 * T ≈ 6:51/mi, I ≈ 6:18/mi, R ≈ 5:50/mi.
 */
export function calculateTrainingPaces(vdot: number): TrainingPaces | null {
  if (vdot <= 0 || !isFinite(vdot)) return null;

  const paces: TrainingPaces = {
    vdot: Math.round(vdot * 10) / 10,
    easy: {
      min: Math.round(paceAtFraction(vdot, DANIELS_INTENSITY.easyFast)), // faster end
      max: Math.round(paceAtFraction(vdot, DANIELS_INTENSITY.easySlow)), // slower end
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
  const rounded = Math.round(secPerMi);
  const min = Math.floor(rounded / 60);
  const sec = rounded % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

/** Format a pace range as "M:SS–M:SS/mi" */
export function formatPaceRange(min: number, max: number): string {
  if (min <= 0 || max <= 0) return '—';
  const lo = Math.round(min);
  const hi = Math.round(max);
  const minMin = Math.floor(lo / 60);
  const minSec = lo % 60;
  const maxMin = Math.floor(hi / 60);
  const maxSec = hi % 60;
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

function isPositive(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** True when `p` has the TrainingPaces shape with positive, finite paces. */
export function isValidTrainingPaces(p: unknown): p is TrainingPaces {
  if (!p || typeof p !== 'object') return false;
  const x = p as Partial<TrainingPaces>;
  return isPositive(x.vdot) && !!x.easy && isPositive(x.easy.min) && isPositive(x.easy.max) &&
    isPositive(x.marathon) && isPositive(x.threshold) && isPositive(x.interval) && isPositive(x.repetition);
}

/** Get cached training paces (validated; null when missing or malformed). */
export function getSavedTrainingPaces(): TrainingPaces | null {
  try {
    const raw = persistence.getItem(PACE_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isValidTrainingPaces(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The athlete's current training paces — pure (no storage writes). The VDOT
 * comes from {@link deriveVdot} (recent race → detected race → best effort →
 * heart-rate estimate → goal time) and its source is attached. Null when no
 * source exists.
 */
export function getCurrentTrainingPaces(opts: DeriveVdotOptions = {}): TrainingPaces | null {
  let derived: DerivedVdot;
  try {
    derived = deriveVdot(opts);
  } catch {
    return null;
  }
  if (derived.vdot == null || derived.source === 'none') return null;
  const paces = calculateTrainingPaces(derived.vdot);
  if (!paces) return null;
  return {
    ...paces,
    source: derived.source,
    confidence: derived.confidence,
    sourceDetail: derived.detail,
    asOf: derived.asOf,
  };
}

/**
 * Compute the current training paces ({@link getCurrentTrainingPaces}) and
 * save them, source included (explicit, idempotent upsert). When there is no
 * VDOT source the cache is cleared — older caches came from training-run
 * VDOTs (V2) — and null is returned.
 */
export function getOrComputeTrainingPaces(): TrainingPaces | null {
  const paces = getCurrentTrainingPaces();
  if (paces) {
    saveTrainingPaces(paces);
    return paces;
  }
  try {
    persistence.removeItem(PACE_CACHE_KEY);
  } catch { /* non-critical */ }
  return null;
}

/**
 * Marathon time estimate from a VDOT (for display), e.g. "3:10:49" for VDOT 50.
 * Same engine as the race prediction (`vdotToMarathonSec`).
 */
export function vdotToMarathonTime(vdot: number): string {
  if (!(vdot > 0)) return '—';
  return formatTimeSec(vdotToMarathonSec(vdot));
}
