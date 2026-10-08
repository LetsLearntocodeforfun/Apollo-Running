/**
 * Pure helpers for the Today screen (v1.0.6 Today v2): journey header text,
 * countdown copy, unit-aware pace ranges, prediction ranges and the VDOT used
 * for today's workout targets. Nothing here writes to storage.
 */

import type { PlanDay } from '../../data/plans';
import type { JourneyState } from '../../services/journey';
import type { PhaseName } from '../../services/periodization';
import { deriveVdot, getVdotSourceLabel, formatTimeSec, type RacePrediction } from '../../services/racePrediction';
import { getSavedTrainingPaces } from '../../services/paceCalculator';
import { getWorkoutTarget } from '../../services/workoutTargets';
import type { WorkoutTarget } from '../../types/workout';
import { formatPaceFromMinPerMi, paceUnitLabel } from '../../services/unitPreferences';
import { daysBetween, isDateKey, parseDateKey } from '../../utils/localDate';

/** Human labels for periodization phases. */
export const TRAINING_PHASE_LABEL: Record<PhaseName, string> = {
  base: 'Base',
  build: 'Build',
  peak: 'Peak',
  taper: 'Taper',
  race: 'Race week',
};

/** "Build", "Taper"… or null when the phase is unknown. */
export function trainingPhaseLabel(phase: PhaseName | null | undefined): string | null {
  return phase ? TRAINING_PHASE_LABEL[phase] ?? null : null;
}

/** "47 days to race", "1 day to race", "Race day!" — null when unknown or in the past. */
export function countdownText(daysToRace: number | null | undefined): string | null {
  if (daysToRace == null || !Number.isFinite(daysToRace) || daysToRace < 0) return null;
  if (daysToRace === 0) return 'Race day!';
  return `${daysToRace} ${daysToRace === 1 ? 'day' : 'days'} to race`;
}

/** Header parts, skipping unknown ones: ["Week 9 of 18", "Build", "47 days to race"]. */
export function journeyHeaderParts(j: JourneyState): string[] {
  const parts: string[] = [];
  if (j.weekIndex != null && j.totalWeeks != null && j.totalWeeks > 0) {
    parts.push(`Week ${j.weekIndex + 1} of ${j.totalWeeks}`);
    const phase = trainingPhaseLabel(j.trainingPhase);
    if (phase) parts.push(phase);
  }
  const countdown = countdownText(j.daysToRace);
  if (countdown) parts.push(countdown);
  return parts;
}

/** "Mon, Oct 12" for a local date key (the key itself when invalid). */
export function formatWeekdayDate(key: string): string {
  if (!isDateKey(key)) return key;
  return parseDateKey(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "in 5 days" / "tomorrow" / "today" for a future date key (relative to `today`). */
export function relativeDaysText(today: string, key: string): string {
  if (!isDateKey(today) || !isDateKey(key)) return '';
  const n = daysBetween(today, key);
  if (n <= 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

/** Unit-aware pace range from sec/mi values, e.g. "7:05–7:15/mi" or "4:24–4:30/km". */
export function formatPaceRangeSecPerMi(minSecPerMi: number, maxSecPerMi: number): string {
  const lo = formatPaceFromMinPerMi(minSecPerMi / 60);
  const hi = formatPaceFromMinPerMi(maxSecPerMi / 60);
  if (lo === hi) return hi;
  const suffix = paceUnitLabel();
  const loShort = suffix && lo.endsWith(suffix) ? lo.slice(0, -suffix.length) : lo;
  return `${loShort}–${hi}`;
}

/** "3:18" (h:mm, rounded to the minute). */
export function formatClockHM(totalSec: number): string {
  const totalMin = Math.round(totalSec / 60);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}

/** "3:18–3:26" from the prediction range, else the point estimate ("3:22:10"). */
export function predictionRangeText(p: RacePrediction): string {
  const { rangeLowSec: low, rangeHighSec: high } = p;
  if (low != null && high != null && low > 0 && high > low) {
    const a = formatClockHM(low);
    const b = formatClockHM(high);
    return a === b ? a : `${a}–${b}`;
  }
  return p.marathonTimeFormatted || formatTimeSec(p.marathonTimeSec);
}

/** The VDOT behind today's paces and where it came from. */
export interface TodayVdot {
  vdot: number;
  sourceLabel: string;
}

/**
 * VDOT for workout targets: `deriveVdot()` (race → best effort → HR estimate →
 * goal) unless its source is 'none', else the last saved training paces. Pure
 * reads only (getOrComputeTrainingPaces would write).
 */
export function getTodayVdot(): TodayVdot | null {
  try {
    const derived = deriveVdot();
    if (derived.source !== 'none' && derived.vdot != null && derived.vdot > 0) {
      return { vdot: derived.vdot, sourceLabel: getVdotSourceLabel(derived.source) };
    }
  } catch {
    // fall through to the saved paces
  }
  const saved = getSavedTrainingPaces();
  if (saved && Number.isFinite(saved.vdot) && saved.vdot > 0) {
    return { vdot: saved.vdot, sourceLabel: 'Saved training paces' };
  }
  return null;
}

/** Days whose effort can be targeted with a pace (runs and races, not rest/cross). */
export function isPacedDay(day: PlanDay): boolean {
  return day.type === 'run' || day.type === 'marathon' || day.type === 'race';
}

/** Workout target for a plan day, or null (rest/cross days, no VDOT). */
export function targetForDay(day: PlanDay, vdot: number | null): WorkoutTarget | null {
  if (vdot == null || !(vdot > 0) || !isPacedDay(day)) return null;
  const note = day.note || (day.type === 'run' ? 'Easy' : 'Race');
  try {
    return getWorkoutTarget(note, vdot, day.distanceMi);
  } catch {
    return null;
  }
}

/** First sentence of a target description (unit-free coaching purpose). */
export function firstSentence(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.match(/^.*?[.!?](?=\s|$)/);
  const s = (match ? match[0] : text).trim();
  return s || null;
}
