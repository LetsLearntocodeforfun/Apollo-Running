/**
 * Popular marathon training plans + custom plan builder.
 * Distances are in miles (as published/estimated); we display both mi and km.
 */

export type DayType = 'rest' | 'run' | 'cross' | 'race' | 'marathon';

export interface PlanDay {
  type: DayType;
  label: string;
  distanceMi?: number;
  /** e.g. "Easy", "Long", "Tempo", "Speed" */
  note?: string;
}

export interface PlanWeek {
  weekNumber: number;
  days: PlanDay[];
}

export interface TrainingPlan {
  id: string;
  name: string;
  author: string;
  description: string;
  totalWeeks: number;
  weeks: PlanWeek[];
  /** Optional half-marathon week (0-based) */
  halfMarathonWeek?: number;
}

export interface PlanRecommendation {
  planId: string;
  score: number;
  reason: string;
}

export interface CustomPlanBuilderInput {
  name: string;
  totalWeeks: number;
  runningDays: number;
  currentWeeklyMiles: number;
  peakWeeklyMiles: number;
}

export const CUSTOM_PLAN_ID = 'custom-built-marathon-plan';
const CUSTOM_PLAN_STORAGE_KEY = 'apollo_custom_marathon_plan';

const MI = (n: number): PlanDay => ({ type: 'run', label: `${n} mi run`, distanceMi: n, note: 'Easy' });
const REST: PlanDay = { type: 'rest', label: 'Rest' };
const CROSS: PlanDay = { type: 'cross', label: 'Cross' };
const HALF: PlanDay = { type: 'race', label: 'Half Marathon', distanceMi: 13.1, note: 'Race' };
const MARATHON: PlanDay = { type: 'marathon', label: 'Marathon', distanceMi: 26.2, note: 'Race day' };

type WeekRow = [number, number, number, number]; // [tue, wed, thu, sat] miles

function roundToTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore local storage errors
  }
}

/** Hal Higdon Novice 1 — 18 weeks, 4 run days + cross. Long run builds to 20 mi, stepback every 3rd week. */
function buildHalHigdonNovice1(): TrainingPlan {
  const weekData: WeekRow[] = [
    [3, 3, 3, 6], [3, 3, 3, 7], [3, 4, 3, 5], [3, 4, 3, 9],
    [3, 5, 3, 10], [3, 5, 3, 7], [3, 6, 3, 12], [3, 6, 3, 0],
    [3, 7, 4, 10], [3, 7, 4, 15], [4, 8, 4, 16], [4, 8, 5, 12],
    [4, 9, 5, 18], [5, 9, 5, 14], [5, 10, 5, 20], [5, 8, 4, 12],
    [4, 6, 3, 8], [3, 4, 2, 0],
  ];
  const weeks: PlanWeek[] = weekData.map(([tue, wed, thu, sat], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      MI(tue),
      MI(wed),
      MI(thu),
      REST,
      sat === 0 && i === 7 ? REST : sat === 0 && i === 17 ? REST : MI(sat),
      i === 7 ? HALF : i === 17 ? MARATHON : CROSS,
    ],
  }));
  return {
    id: 'hal-higdon-novice-1',
    name: 'Novice 1',
    author: 'Hal Higdon',
    description: 'Most popular first-marathon plan. 4 run days, cross-training, long runs to 20 miles. Stepback weeks every third week.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 7,
  };
}

/** Hanson's Beginner — 18 weeks, 6 run days, long run cap 16 mi. Simplified structure. */
function buildHansonsBeginner(): TrainingPlan {
  const weeks: PlanWeek[] = [];
  const longRuns = [6, 8, 10, 8, 10, 12, 10, 12, 14, 10, 14, 16, 12, 16, 12, 10, 8, 0];
  for (let w = 0; w < 18; w++) {
    const long = longRuns[w];
    const easy = w < 4 ? 4 : w < 10 ? 5 : 6;
    const tempo = Math.min(5 + Math.floor(w / 2), 10);
    weeks.push({
      weekNumber: w + 1,
      days: [
        { type: 'run', label: `${easy} mi easy`, distanceMi: easy, note: 'Easy' },
        { type: 'run', label: w < 9 ? 'Speed intervals' : 'Strength', distanceMi: 6, note: w < 9 ? 'Speed' : 'Strength' },
        { type: 'run', label: `${easy} mi easy`, distanceMi: easy, note: 'Easy' },
        { type: 'run', label: `${easy} mi easy`, distanceMi: easy, note: 'Easy' },
        { type: 'run', label: `${tempo} mi tempo`, distanceMi: tempo, note: 'Tempo' },
        { type: 'run', label: `${easy} mi easy`, distanceMi: easy, note: 'Easy' },
        w === 17 ? MARATHON : { type: 'run', label: `${long} mi long`, distanceMi: long, note: 'Long' },
      ],
    });
  }
  return {
    id: 'hansons-beginner',
    name: "Beginner (Just Finish)",
    author: "Hanson's",
    description: 'Six days of running, long run cap at 16 miles. Builds cumulative fatigue with tempo and strength. Race week = marathon.',
    totalWeeks: 18,
    weeks,
  };
}

/** Hal Higdon Novice 2 — 18 weeks, slightly more mileage than Novice 1, 4 run days + cross. */
function buildHalHigdonNovice2(): TrainingPlan {
  const weekData: WeekRow[] = [
    [3, 5, 3, 8], [3, 5, 3, 9], [3, 5, 3, 6], [3, 6, 3, 11],
    [3, 6, 3, 12], [3, 6, 3, 9], [4, 7, 4, 14], [4, 7, 4, 15],
    [4, 7, 4, 0], [4, 8, 4, 17], [5, 8, 5, 18], [5, 8, 5, 13],
    [5, 5, 5, 19], [5, 8, 5, 12], [5, 5, 5, 20], [5, 4, 5, 12],
    [4, 3, 4, 8], [3, 2, 0, 2],
  ];
  const weeks: PlanWeek[] = weekData.map(([tue, wed, thu, sat], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      MI(tue),
      MI(wed),
      thu === 0 ? REST : MI(thu),
      REST,
      sat === 0 && (i === 8 || i === 17) ? REST : MI(sat),
      i === 8 ? HALF : i === 17 ? MARATHON : CROSS,
    ],
  }));
  return {
    id: 'hal-higdon-novice-2',
    name: 'Novice 2',
    author: 'Hal Higdon',
    description: 'Step up from Novice 1. Slightly higher midweek mileage and long runs to 20 miles. Ideal if you have run a few races.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 8,
  };
}

/** Hal Higdon Intermediate 1 — 18 weeks, 5 run days, more mileage. */
function buildHalHigdonIntermediate1(): TrainingPlan {
  const weekData: WeekRow[] = [
    [3, 5, 3, 8], [3, 5, 3, 9], [3, 5, 3, 6], [3, 6, 3, 10],
    [3, 6, 3, 11], [3, 6, 3, 8], [4, 7, 4, 12], [4, 7, 4, 0],
    [4, 8, 4, 14], [4, 8, 4, 16], [5, 8, 5, 18], [5, 8, 5, 12],
    [5, 10, 5, 20], [5, 10, 5, 12], [5, 6, 4, 12], [4, 6, 3, 8],
    [3, 4, 2, 8], [3, 4, 2, 0],
  ];
  const weeks: PlanWeek[] = weekData.map(([tue, wed, thu, sat], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      MI(tue),
      MI(wed),
      MI(thu),
      REST,
      sat === 0 && (i === 7 || i === 17) ? REST : MI(sat),
      i === 7 ? HALF : i === 17 ? MARATHON : CROSS,
    ],
  }));
  return {
    id: 'hal-higdon-intermediate-1',
    name: 'Intermediate 1',
    author: 'Hal Higdon',
    description: 'Five run days, higher mileage. For runners with a base. Long runs to 20 miles.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 7,
  };
}

/** Hal Higdon Advanced 1 — 18 weeks, 5 run days, speedwork, peak ~55 mi. */
function buildHalHigdonAdvanced1(): TrainingPlan {
  const weekData: WeekRow[] = [
    [5, 8, 5, 10], [5, 8, 5, 11], [5, 8, 5, 8], [5, 9, 5, 13],
    [5, 9, 5, 14], [5, 9, 5, 10], [5, 10, 5, 15], [5, 10, 5, 0],
    [5, 11, 5, 17], [5, 11, 5, 18], [5, 12, 5, 20], [5, 12, 5, 12],
    [5, 12, 5, 20], [5, 10, 5, 12], [5, 8, 5, 12], [5, 8, 5, 8],
    [4, 6, 4, 0], [3, 4, 2, 0],
  ];
  const weeks: PlanWeek[] = weekData.map(([tue, wed, thu, sat], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      MI(tue),
      MI(wed),
      MI(thu),
      REST,
      sat === 0 && (i === 7 || i === 16 || i === 17) ? REST : MI(sat),
      i === 7 ? HALF : i === 17 ? MARATHON : CROSS,
    ],
  }));
  return {
    id: 'hal-higdon-advanced-1',
    name: 'Advanced 1',
    author: 'Hal Higdon',
    description: 'For experienced marathoners aiming for a PR. Higher mileage, optional speedwork. Long runs to 20 miles.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 7,
  };
}

/** Pete Pfitzinger 18/55 (representative structure) — 18 weeks, peaks near 55 mi/week. */
function buildPfitzinger1855(): TrainingPlan {
  const weeklyTargets = [33, 37, 41, 35, 45, 47, 50, 40, 52, 55, 46, 53, 55, 48, 44, 38, 30, 22];
  const longRuns = [12, 14, 15, 12, 16, 17, 18, 14, 18, 20, 16, 20, 20, 17, 15, 12, 10, 0];
  const weeks: PlanWeek[] = weeklyTargets.map((target, i) => {
    const long = longRuns[i];
    const mediumLong = roundToTenth(target * 0.24);
    const tempo = roundToTenth(target * 0.16);
    const easy1 = roundToTenth(target * 0.14);
    const easy2 = roundToTenth(target * 0.14);
    const easy3 = roundToTenth(Math.max(target - (long + mediumLong + tempo + easy1 + easy2), 4));
    const saturday: PlanDay = i === 17
      ? { type: 'run', label: `${easy3} mi easy`, distanceMi: easy3, note: 'Easy' }
      : { type: 'run', label: `${tempo} mi marathon pace`, distanceMi: tempo, note: 'Tempo' };
    const sunday: PlanDay = i === 17 ? MARATHON : i === 8 ? HALF : { type: 'run', label: `${long} mi long`, distanceMi: long, note: 'Long' };
    const days: PlanDay[] = [
      REST,
      { type: 'run', label: `${easy1} mi easy`, distanceMi: easy1, note: 'Easy' },
      { type: 'run', label: `${mediumLong} mi medium long`, distanceMi: mediumLong, note: 'Medium Long' },
      { type: 'run', label: `${easy2} mi recovery`, distanceMi: easy2, note: 'Easy' },
      REST,
      saturday,
      sunday,
    ];
    return {
      weekNumber: i + 1,
      days,
    };
  });
  return {
    id: 'pfitzinger-18-55',
    name: '18/55',
    author: 'Pete Pfitzinger',
    description: 'Classic performance-focused plan peaking around 55 miles/week. Includes medium-long runs, marathon pace workouts, and long-run progression.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 8,
  };
}

/** Nike Run Club Marathon (representative) — 18 weeks, 5 run days with speed and long runs. */
function buildNikeRunClubMarathon(): TrainingPlan {
  const longRuns = [8, 10, 11, 9, 12, 13, 14, 10, 15, 16, 18, 14, 20, 14, 12, 10, 8, 0];
  const weeks: PlanWeek[] = longRuns.map((long, i) => {
    const recovery = i < 5 ? 3 : i < 12 ? 4 : 3;
    const speed = i < 6 ? 4 : i < 12 ? 5 : 4;
    const tempo = i < 6 ? 5 : i < 12 ? 6 : 5;
    const easy = i < 6 ? 4 : i < 12 ? 5 : 4;
    return {
      weekNumber: i + 1,
      days: [
        REST,
        { type: 'run', label: `${speed} mi speed workout`, distanceMi: speed, note: 'Speed' },
        { type: 'run', label: `${recovery} mi recovery`, distanceMi: recovery, note: 'Easy' },
        { type: 'run', label: `${tempo} mi tempo`, distanceMi: tempo, note: 'Tempo' },
        REST,
        { type: 'run', label: `${easy} mi easy`, distanceMi: easy, note: 'Easy' },
        i === 17 ? MARATHON : { type: 'run', label: `${long} mi long`, distanceMi: long, note: 'Long' },
      ],
    };
  });
  return {
    id: 'nike-run-club-marathon',
    name: 'Marathon Plan',
    author: 'Nike Run Club',
    description: 'Popular digital-first plan with guided speed sessions, recovery runs, and progressive long runs.',
    totalWeeks: 18,
    weeks,
  };
}

/** FIRST (Run Less, Run Faster) — 3 quality runs + 2 cross-training. 18 weeks. */
function buildFirst(): TrainingPlan {
  const longRuns = [10, 12, 10, 14, 12, 16, 14, 18, 13.1, 20, 12, 22, 12, 20, 10, 8, 0, 0];
  const weeks: PlanWeek[] = longRuns.map((long, i) => {
    const tempo = i < 6 ? 5 : i < 12 ? 6 : 5;
    const intervals = 3 + Math.floor(i / 4);
    return {
      weekNumber: i + 1,
      days: [
        REST,
        { type: 'run', label: `${tempo} mi tempo`, distanceMi: tempo, note: 'Tempo' },
        CROSS,
        { type: 'run', label: `${intervals} mi intervals`, distanceMi: intervals, note: 'Speed' },
        CROSS,
        REST,
        i === 8 ? HALF : i === 17 ? MARATHON : long > 0 ? { type: 'run', label: `${long} mi long`, distanceMi: long, note: 'Long' } : REST,
      ],
    };
  });
  return {
    id: 'first',
    name: 'Run Less, Run Faster',
    author: 'FIRST',
    description: 'Three quality runs per week (tempo, intervals, long) plus two cross-training days. Lower running volume, higher intensity.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 8,
  };
}

const HAL_HIGDON_NOVICE_1 = buildHalHigdonNovice1();
const HAL_HIGDON_NOVICE_2 = buildHalHigdonNovice2();
const HANSONS_BEGINNER = buildHansonsBeginner();
const HAL_HIGDON_INTERMEDIATE_1 = buildHalHigdonIntermediate1();
const HAL_HIGDON_ADVANCED_1 = buildHalHigdonAdvanced1();
const PFITZINGER_18_55 = buildPfitzinger1855();
const NIKE_RUN_CLUB = buildNikeRunClubMarathon();
const FIRST = buildFirst();

export const BUILT_IN_PLANS: TrainingPlan[] = [
  HAL_HIGDON_NOVICE_1,
  HAL_HIGDON_NOVICE_2,
  HANSONS_BEGINNER,
  HAL_HIGDON_INTERMEDIATE_1,
  HAL_HIGDON_ADVANCED_1,
  PFITZINGER_18_55,
  NIKE_RUN_CLUB,
  FIRST,
];

export function createCustomPlanFromScratch(input: CustomPlanBuilderInput): TrainingPlan {
  const totalWeeks = clamp(Math.round(input.totalWeeks), 10, 30);
  const runningDays = clamp(Math.round(input.runningDays), 3, 6);
  const baseMiles = clamp(input.currentWeeklyMiles, 8, 80);
  const peakMiles = clamp(Math.max(input.peakWeeklyMiles, baseMiles + 4), baseMiles + 4, 90);
  const buildWeeks = Math.max(totalWeeks - 2, 6);
  const runDayMap: Record<number, number[]> = {
    3: [1, 3, 6],
    4: [1, 2, 4, 6],
    5: [1, 2, 3, 5, 6],
    6: [0, 1, 2, 3, 5, 6],
  };
  const runDays = runDayMap[runningDays] ?? runDayMap[4];

  const weeks: PlanWeek[] = [];
  for (let w = 0; w < totalWeeks; w++) {
    const progress = Math.min(w / Math.max(buildWeeks - 1, 1), 1);
    const isCutback = w > 2 && w % 4 === 3;
    let weekMiles = baseMiles + (peakMiles - baseMiles) * progress;
    if (w === totalWeeks - 2) weekMiles = peakMiles * 0.72;
    if (w === totalWeeks - 1) weekMiles = peakMiles * 0.45;
    if (isCutback && w < totalWeeks - 2) weekMiles *= 0.86;
    weekMiles = roundToTenth(weekMiles);

    const isRaceWeek = w === totalWeeks - 1;
    const longMiles = isRaceWeek ? 26.2 : roundToTenth(clamp(weekMiles * 0.32, 6, 22));
    const qualityMiles = runningDays >= 4 && !isRaceWeek ? roundToTenth(clamp(weekMiles * 0.2, 3, 10)) : 0;
    const remainingMiles = Math.max(weekMiles - longMiles - qualityMiles, runningDays);
    const easyRuns = Math.max(runningDays - (qualityMiles > 0 ? 2 : 1), 1);
    const easyMiles = roundToTenth(remainingMiles / easyRuns);

    const days: PlanDay[] = Array.from({ length: 7 }, () => REST);
    const longRunDay = runDays.includes(6) ? 6 : runDays[runDays.length - 1];
    for (const day of runDays) {
      if (day === longRunDay) {
        days[day] = isRaceWeek ? MARATHON : { type: 'run', label: `${longMiles} mi long`, distanceMi: longMiles, note: 'Long' };
      } else {
        days[day] = { type: 'run', label: `${easyMiles} mi easy`, distanceMi: easyMiles, note: 'Easy' };
      }
    }
    if (qualityMiles > 0) {
      const qualityDay = runDays[Math.floor(runDays.length / 2) - 1] ?? runDays[0];
      if (qualityDay !== longRunDay) {
        days[qualityDay] = { type: 'run', label: `${qualityMiles} mi tempo`, distanceMi: qualityMiles, note: 'Tempo' };
      }
    }

    weeks.push({ weekNumber: w + 1, days });
  }

  return {
    id: CUSTOM_PLAN_ID,
    name: input.name.trim() || 'Custom Marathon Plan',
    author: 'You + Apollo Builder',
    description: `Built from scratch for ${runningDays} running days/week, starting near ${baseMiles} mpw and peaking around ${peakMiles} mpw.`,
    totalWeeks,
    weeks,
  };
}

export function suggestPlansForRunner(weeklyMiles: number, runningDays: number): PlanRecommendation[] {
  const miles = clamp(weeklyMiles, 0, 120);
  const days = clamp(runningDays, 1, 7);
  const plans = BUILT_IN_PLANS;
  const scored = plans.map((plan): PlanRecommendation => {
    const overview = getPlanOverview(plan);
    const peak = Math.max(...overview.map((w) => w.totalMiles));
    const avgRunsPerWeek = roundToTenth(
      plan.weeks.reduce((sum, week) => sum + week.days.filter((d) => d.type === 'run' || d.type === 'race' || d.type === 'marathon').length, 0) / plan.totalWeeks,
    );
    const milesScore = Math.max(0, 50 - Math.abs(peak - miles) * 1.2);
    const daysScore = Math.max(0, 35 - Math.abs(avgRunsPerWeek - days) * 8);
    const planBias =
      plan.id === 'pfitzinger-18-55' ? (miles >= 35 && days >= 5 ? 20 : -5)
        : plan.id === 'hal-higdon-novice-1' ? (miles <= 25 ? 16 : 0)
          : plan.id === 'hal-higdon-novice-2' ? (miles >= 20 && miles <= 35 ? 12 : 0)
            : plan.id === 'first' ? (days <= 4 ? 12 : 0)
              : 0;
    const score = roundToTenth(milesScore + daysScore + planBias);
    return {
      planId: plan.id,
      score,
      reason: `${plan.name}: peaks around ${peak} mi/week and typically uses about ${avgRunsPerWeek} run days/week.`,
    };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 3);
}

export function getCustomPlan(): TrainingPlan | null {
  return readStorage<TrainingPlan>(CUSTOM_PLAN_STORAGE_KEY);
}

export function setCustomPlan(plan: TrainingPlan | null): void {
  writeStorage(CUSTOM_PLAN_STORAGE_KEY, plan);
}

export function getPlanById(id: string): TrainingPlan | undefined {
  const builtIn = BUILT_IN_PLANS.find((p) => p.id === id);
  if (builtIn) return builtIn;
  if (id === CUSTOM_PLAN_ID) return getCustomPlan() ?? undefined;
  return undefined;
}

/** All plan days in order for progress keying: planId -> weekIndex -> dayIndex (0–6). */
export function getTotalDays(plan: TrainingPlan): number {
  return plan.weeks.length * 7;
}

export function getDayAt(plan: TrainingPlan, weekIndex: number, dayIndex: number): PlanDay | null {
  const w = plan.weeks[weekIndex];
  if (!w) return null;
  return w.days[dayIndex] ?? null;
}

/** Weekly summary for plan overview: total run miles and long-run miles per week. */
export interface PlanWeekSummary {
  weekNumber: number;
  totalMiles: number;
  longRunMiles: number;
}

export function getPlanOverview(plan: TrainingPlan): PlanWeekSummary[] {
  return plan.weeks.map((week) => {
    let totalMiles = 0;
    let longRunMiles = 0;
    for (const day of week.days) {
      const mi = day.distanceMi ?? 0;
      totalMiles += mi;
      if (day.type === 'run' || day.type === 'race' || day.type === 'marathon') {
        if (mi > longRunMiles) longRunMiles = mi;
      }
    }
    return { weekNumber: week.weekNumber, totalMiles: Math.round(totalMiles * 10) / 10, longRunMiles: longRunMiles || 0 };
  });
}
