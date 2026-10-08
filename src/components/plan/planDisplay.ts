/**
 * Pure display helpers shared by the Plan (Training), Calendar and Today screens.
 *
 * - Unit-free workout titles: plan labels embed miles ("5 mi tempo"), so km users
 *   would see "mi". Titles strip the distance and the formatted distance is added
 *   back through unitPreferences.
 * - Progress that counts workout days only. Rest days can't be ticked off, so
 *   counting them meant a finished plan could never reach 100 % (UI review B6).
 * - Accessible, locale-formatted date labels built from local date keys.
 */

import type { PlanDay, PlanWeek, TrainingPlan } from '../../data/plans';
import { formatMiles } from '../../services/unitPreferences';
import { isDateKey, parseDateKey } from '../../utils/localDate';

/** Completion lookup for a plan day (0-based week and day indices). */
export type IsDayCompleted = (weekIndex: number, dayIndex: number) => boolean;

/** Progress over workout days only. `pct` is 0–100 (rounded). */
export interface ProgressStats {
  completed: number;
  total: number;
  pct: number;
}

/** True for days that can be completed: runs, cross-training and races (not rest days). */
export function isWorkoutDay(day: PlanDay | null | undefined): day is PlanDay {
  return !!day && day.type !== 'rest';
}

const RUN_SUFFIX = /^(easy|long|tempo|recovery|medium long|medium-long)$/i;

/**
 * Unit-free title for a plan day, e.g. "Tempo run", "Long run", "Speed intervals",
 * "Rest", "Marathon". Plan labels such as "5 mi tempo" lose their distance part.
 */
export function workoutTitle(day: PlanDay): string {
  if (day.type === 'rest') return day.skipped ? 'Skipped' : 'Rest';
  if (day.type === 'cross') return 'Cross-training';
  if (day.type === 'marathon') return 'Marathon';
  let title = day.label.replace(/^\s*\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*(?:mi|miles?|km)\b\s*/i, '').trim();
  if (!title || /^run$/i.test(title)) title = day.note ? day.note : 'Run';
  if (/^mp$/i.test(title)) title = 'Marathon-pace run';
  else if (/^speed$/i.test(title)) title = 'Speed workout';
  else if (RUN_SUFFIX.test(title)) title = `${title} run`;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** "Tempo run · 8.0 km" (or with a custom separator, e.g. ", " for screen-reader labels). */
export function workoutSummary(day: PlanDay, separator = ' · '): string {
  const title = workoutTitle(day);
  if (day.type === 'rest' || day.distanceMi == null || !(day.distanceMi > 0)) return title;
  return `${title}${separator}${formatMiles(day.distanceMi)}`;
}

/** Workout-day progress for one plan week. */
export function computeWeekProgress(week: PlanWeek, weekIndex: number, isCompleted: IsDayCompleted): ProgressStats {
  let completed = 0;
  let total = 0;
  week.days.forEach((day, dayIndex) => {
    if (!isWorkoutDay(day)) return;
    total++;
    if (isCompleted(weekIndex, dayIndex)) completed++;
  });
  return { completed, total, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

/** Workout-day progress for a whole plan: completing every workout reaches exactly 100 %. */
export function computePlanProgress(plan: TrainingPlan, isCompleted: IsDayCompleted): ProgressStats {
  let completed = 0;
  let total = 0;
  plan.weeks.forEach((week, weekIndex) => {
    const w = computeWeekProgress(week, weekIndex, isCompleted);
    completed += w.completed;
    total += w.total;
  });
  return { completed, total, pct: total > 0 ? Math.round((completed / total) * 100) : 0 };
}

/** "Tuesday, October 7, 2026" for a local date key (the key itself when invalid). */
export function formatLongDate(dateKey: string): string {
  if (!isDateKey(dateKey)) return dateKey;
  return parseDateKey(dateKey).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

/** "Oct 7, 2026" for a local date key (the key itself when invalid). */
export function formatMediumDate(dateKey: string): string {
  if (!isDateKey(dateKey)) return dateKey;
  return parseDateKey(dateKey).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Oct 7" for a local date key (the key itself when invalid). */
export function formatShortDate(dateKey: string): string {
  if (!isDateKey(dateKey)) return dateKey;
  return parseDateKey(dateKey).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Wed, Oct 7" for a local date key (the key itself when invalid). */
export function formatDayLabel(dateKey: string): string {
  if (!isDateKey(dateKey)) return dateKey;
  return parseDateKey(dateKey).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "1 day" / "5 days". */
export function pluralDays(n: number): string {
  return `${n} day${Math.abs(n) === 1 ? '' : 's'}`;
}
