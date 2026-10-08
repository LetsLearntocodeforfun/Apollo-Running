/**
 * Fitness & Form data for the Today chip and the Progress chart (v1.0.6).
 *
 * Reads stored activities, the athlete's max HR, the active plan and the race
 * date, then builds the PMC (CTL/ATL/TSB) with a projection to race day that
 * follows the PLANNED load (falls back to the recent 14-day average).
 *
 * No recharts here: FormChip (Today screen) imports this module.
 * Pure apart from reads; results are memoized per store version.
 */

import { getStoredActivities, getActivityStoreVersion } from '../../services/analyticsService';
import {
  activitiesToDailyLoads,
  buildPMC,
  plannedDailyLoadsFromPlan,
  recentTssPerMile,
  type PMCResult,
  type PlannedDailyLoad,
} from '../../services/pmcChart';
import { getHRProfile } from '../../services/heartRate';
import { getActivePlan, getDateKeyForDay } from '../../services/planProgress';
import { getEffectivePlan } from '../../services/planOverlay';
import { getRaceDate } from '../../services/journey';
import type { TrainingPlan } from '../../data/plans';
import { addDays, daysBetween, isDateKey, todayKey } from '../../utils/localDate';

/** Longest projection drawn (days). */
const MAX_PROJECTION_DAYS = 180;

export interface FitnessFormOptions {
  /** Race date key; `undefined` = journey.getRaceDate(), `null` = no race. */
  raceDate?: string | null;
  /** Include rides, swims, strength… (default true). */
  includeCrossTraining?: boolean;
  /** Override today (tests). */
  today?: string;
}

export interface FitnessFormData {
  pmc: PMCResult;
  today: string;
  raceDate: string | null;
  daysToRace: number | null;
  /** Projected TSB on race day, when a projection reaches it. */
  raceDayTsb: number | null;
  /** True when there are fewer than 42 days of history (CTL still building). */
  warmingUp: boolean;
}

interface ActivePlanRef {
  plan: TrainingPlan;
  startDate: string;
}

/** The effective plan (base plan + the athlete's moves/skips + adaptive changes) and its start date. */
function readActivePlan(): ActivePlanRef | null {
  const active = getActivePlan();
  if (!active || !isDateKey(active.startDate)) return null;
  const plan = getEffectivePlan();
  if (!plan) return null;
  return { plan, startDate: getDateKeyForDay(active.startDate, 0, 0) };
}

/** Race date: journey.getRaceDate() (active plan, else My Race), never re-derived here. */
function resolveRaceDate(): string | null {
  try {
    const d = getRaceDate();
    return d && isDateKey(d) ? d : null;
  } catch {
    return null;
  }
}

/** Known max HR for HR-based load, or null when only the 190 default exists. */
function knownMaxHR(): number | null {
  try {
    const p = getHRProfile();
    return p.source !== 'default' && p.maxHR > 0 ? p.maxHR : null;
  } catch {
    return null;
  }
}

let memo: { key: string; plan: TrainingPlan | null; value: FitnessFormData } | null = null;

/** Build (or reuse) the Fitness & Form data. */
export function getFitnessForm(options: FitnessFormOptions = {}): FitnessFormData {
  const today = options.today && isDateKey(options.today) ? options.today : todayKey();
  const includeCrossTraining = options.includeCrossTraining ?? true;
  const planRef = readActivePlan();
  const raceDate = options.raceDate === undefined ? resolveRaceDate() : options.raceDate;
  const maxHR = knownMaxHR();
  const version = getActivityStoreVersion();
  const planKey = planRef ? `${planRef.plan.id}@${planRef.startDate}` : '-';
  const key = [version, today, includeCrossTraining, raceDate ?? '-', planKey, maxHR ?? '-'].join('|');
  // getEffectivePlan() returns the same object until the plan or its overlay changes.
  if (memo && memo.key === key && memo.plan === (planRef?.plan ?? null)) return memo.value;

  const activities = getStoredActivities();
  const daysToRace = raceDate && isDateKey(raceDate) ? daysBetween(today, raceDate) : null;
  const projectionDays = daysToRace !== null && daysToRace > 0 ? Math.min(daysToRace, MAX_PROJECTION_DAYS) : 0;

  let plannedLoads: PlannedDailyLoad[] | undefined;
  if (projectionDays > 0 && planRef && raceDate) {
    const loads = activitiesToDailyLoads(activities, { includeCrossTraining: false, maxHR });
    const perMile = recentTssPerMile(loads, today);
    const horizon = addDays(today, projectionDays);
    plannedLoads = plannedDailyLoadsFromPlan(planRef.plan, planRef.startDate, today, horizon, perMile);
    if (plannedLoads.length === 0) plannedLoads = undefined;
  }

  const pmc = buildPMC(activities, projectionDays, { today, includeCrossTraining, maxHR, plannedLoads });
  const raceDay = raceDate ? pmc.projection.find((p) => p.date === raceDate) : undefined;
  const value: FitnessFormData = {
    pmc,
    today,
    raceDate: raceDate ?? null,
    daysToRace,
    raceDayTsb: raceDay ? raceDay.tsb : null,
    warmingUp: (pmc.historyDays ?? 0) < 42,
  };
  memo = { key, plan: planRef?.plan ?? null, value };
  return value;
}

/** Format a TSB value with an explicit sign ("+12", "−8", "0"). */
export function formatTsb(tsb: number): string {
  const r = Math.round(tsb);
  if (r > 0) return `+${r}`;
  if (r < 0) return `−${Math.abs(r)}`;
  return '0';
}
