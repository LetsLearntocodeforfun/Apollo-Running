/**
 * Daily Recap — generates a rich daily training summary comparing
 * actual performance vs the plan, with coaching insights.
 */

import { getActivePlan, getWeekDayForDate, getSyncMeta, isDayCompleted, formatDateKey } from './planProgress';
import { getPlanById } from '../data/plans';
import { getWeeklyMileageSummary, type WeeklyMileage } from './autoSync';
import { getHRHistory, getHRZones, type ActivityHRData } from './heartRate';
import { getSavedPrediction } from './racePrediction';
import { persistence } from './db/persistence';
import { formatPaceFromMinPerMi, formatMiles } from './unitPreferences';

const RECAP_KEY = 'apollo_daily_recaps';

export interface DailyRecap {
  date: string; // YYYY-MM-DD
  /** What was planned */
  plannedWorkout: string;
  plannedDistanceMi: number;
  /** What was done */
  actualDistanceMi: number;
  actualPaceMinPerMi: number;
  movingTimeSec: number;
  /** Did they complete it? */
  completed: boolean;
  synced: boolean;
  /** Performance vs plan */
  distanceDiffMi: number;
  distanceDiffPct: number;
  metPlan: boolean;
  exceededPlan: boolean;
  /** HR data if available */
  avgHR?: number;
  maxHR?: number;
  primaryZone?: string;
  /** Weekly context */
  weekNumber: number;
  weeklyMileage: WeeklyMileage | null;
  /** Coaching message */
  coachMessage: string;
  /** Mood/grade: 'outstanding' | 'strong' | 'solid' | 'missed' | 'rest_day' */
  grade: string;
  /** Current predicted marathon time */
  predictedMarathon?: string;
  generatedAt: string;
}

function getRecapStore(): Record<string, DailyRecap> {
  try {
    const raw = persistence.getItem(RECAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRecapStore(store: Record<string, DailyRecap>): void {
  persistence.setItem(RECAP_KEY, JSON.stringify(store));
}

export function getDailyRecap(date: string): DailyRecap | null {
  return getRecapStore()[date] ?? null;
}

export function getRecentRecaps(count: number = 7): DailyRecap[] {
  const store = getRecapStore();
  return Object.values(store)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, count);
}

/** Generate the daily recap for a specific date */
export function generateDailyRecap(dateStr?: string): DailyRecap | null {
  const activePlan = getActivePlan();
  if (!activePlan) return null;

  const plan = getPlanById(activePlan.planId);
  if (!plan) return null;

  const date = dateStr ?? formatDateKey(new Date());
  const dateObj = new Date(date + 'T00:00:00');
  const pos = getWeekDayForDate(activePlan.startDate, plan.totalWeeks, dateObj);
  if (!pos) return null;

  const { weekIndex, dayIndex } = pos;
  const plannedDay = plan.weeks[weekIndex]?.days[dayIndex];
  if (!plannedDay) return null;

  const syncMeta = getSyncMeta(plan.id, weekIndex, dayIndex);
  const completed = isDayCompleted(plan.id, weekIndex, dayIndex);
  const weeklyMileage = getWeeklyMileageSummary(plan.id, weekIndex);

  const plannedDistanceMi = plannedDay.distanceMi ?? 0;
  const actualDistanceMi = syncMeta?.actualDistanceMi ?? 0;
  const actualPaceMinPerMi = syncMeta?.actualPaceMinPerMi ?? 0;
  const movingTimeSec = syncMeta?.movingTimeSec ?? 0;

  const distanceDiffMi = actualDistanceMi - plannedDistanceMi;
  const distanceDiffPct = plannedDistanceMi > 0 ? (distanceDiffMi / plannedDistanceMi) * 100 : 0;
  const metPlan = plannedDistanceMi > 0 ? actualDistanceMi >= plannedDistanceMi * 0.9 : completed;
  const exceededPlan = plannedDistanceMi > 0 && actualDistanceMi > plannedDistanceMi * 1.05;

  // HR data
  const hrHistory = getHRHistory();
  const todayHR: ActivityHRData | undefined = hrHistory.find((h) => h.date === date);
  const zones = getHRZones();

  let primaryZone: string | undefined;
  if (todayHR && todayHR.timeInZones.length === 5) {
    const maxIdx = todayHR.timeInZones.indexOf(Math.max(...todayHR.timeInZones));
    primaryZone = zones[maxIdx]?.name;
  }

  // Grade
  let grade: string;
  if (plannedDay.type === 'rest') {
    grade = 'rest_day';
  } else if (!completed && !syncMeta) {
    grade = 'missed';
  } else if (exceededPlan) {
    grade = 'outstanding';
  } else if (metPlan) {
    grade = 'strong';
  } else {
    grade = 'solid';
  }

  // Coach message
  const coachMessage = buildCoachMessage(
    grade, plannedDay.type, plannedDay.note ?? '',
    actualDistanceMi, plannedDistanceMi, actualPaceMinPerMi,
    weeklyMileage, primaryZone
  );

  const prediction = getSavedPrediction();

  const recap: DailyRecap = {
    date,
    plannedWorkout: plannedDay.label,
    plannedDistanceMi,
    actualDistanceMi,
    actualPaceMinPerMi,
    movingTimeSec,
    completed,
    synced: !!syncMeta,
    distanceDiffMi,
    distanceDiffPct,
    metPlan,
    exceededPlan,
    avgHR: todayHR?.averageHR,
    maxHR: todayHR?.maxHR,
    primaryZone,
    weekNumber: weekIndex + 1,
    weeklyMileage,
    coachMessage,
    grade,
    predictedMarathon: prediction?.marathonTimeFormatted,
    generatedAt: new Date().toISOString(),
  };

  // Save
  const store = getRecapStore();
  store[date] = recap;
  // Keep last 365 days (IndexedDB has ample capacity)
  const keys = Object.keys(store).sort();
  if (keys.length > 365) {
    for (const old of keys.slice(0, keys.length - 365)) {
      delete store[old];
    }
  }
  saveRecapStore(store);

  return recap;
}

function buildCoachMessage(
  grade: string,
  _dayType: string,
  note: string,
  actualMi: number,
  plannedMi: number,
  pace: number,
  weeklyMileage: WeeklyMileage | null,
  primaryZone?: string,
): string {
  const lines: string[] = [];
  const paceStr = formatPaceFromMinPerMi(pace);

  switch (grade) {
    case 'rest_day':
      lines.push('Rest day — recovery is when your body gets stronger. Hydrate, stretch, and sleep well tonight.');
      break;
    case 'missed':
      lines.push('Looks like today\'s workout was missed. No worries — one day doesn\'t define your training.');
      lines.push('Try to get back on track tomorrow. Consistency over perfection.');
      break;
    case 'outstanding':
      lines.push(`Exceptional work! You crushed ${formatMiles(actualMi)} at ${paceStr} — exceeding the ${formatMiles(plannedMi)} target.`);
      if (note.toLowerCase() === 'easy') {
        lines.push('Just watch that you\'re keeping easy days truly easy to avoid overtraining.');
      }
      break;
    case 'strong':
      lines.push(`Strong session! ${formatMiles(actualMi)} at ${paceStr} — right on target with the ${formatMiles(plannedMi)} plan.`);
      break;
    case 'solid':
      lines.push(`Solid effort with ${formatMiles(actualMi)} at ${paceStr}. A little short of the ${formatMiles(plannedMi)} goal, but every mile counts.`);
      break;
  }

  // Workout-type-specific coaching
  if (grade !== 'rest_day' && grade !== 'missed') {
    const noteLC = note.toLowerCase();
    if (noteLC === 'long' && actualMi > 0) {
      lines.push('Long runs are the backbone of marathon training. Great job building endurance.');
    } else if (noteLC === 'tempo') {
      lines.push('Tempo runs teach your body to sustain a faster pace. Focus on controlled effort.');
    } else if (noteLC === 'speed') {
      lines.push('Speed work builds your top-end fitness. Make sure to warm up and cool down properly.');
    }

    if (primaryZone) {
      lines.push(`Primary heart rate zone: ${primaryZone}.`);
      if (noteLC === 'easy' && (primaryZone === 'Threshold' || primaryZone === 'VO2 Max')) {
        lines.push('⚠️ Your HR was high for an easy day — try slowing down to keep easy runs truly easy.');
      }
    }
  }

  // Weekly context
  if (weeklyMileage && weeklyMileage.actualMi > 0) {
    const pct = weeklyMileage.plannedMi > 0 ? Math.round((weeklyMileage.actualMi / weeklyMileage.plannedMi) * 100) : 0;
    lines.push(`Week ${weeklyMileage.weekIndex + 1} progress: ${formatMiles(weeklyMileage.actualMi)}/${formatMiles(weeklyMileage.plannedMi)} (${pct}%).`);
  }

  return lines.join(' ');
}

/** Generate today's recap if not already generated */
export function generateTodayRecap(): DailyRecap | null {
  return generateDailyRecap(formatDateKey(new Date()));
}
