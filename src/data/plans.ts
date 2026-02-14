/**
 * Popular marathon training plans — Hal Higdon & Hanson's.
 * Distances in miles (as published); we display both mi and km.
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

const MI = (n: number): PlanDay => ({ type: 'run', label: `${n} mi run`, distanceMi: n, note: 'Easy' });
const REST: PlanDay = { type: 'rest', label: 'Rest' };
const CROSS: PlanDay = { type: 'cross', label: 'Cross' };
const HALF: PlanDay = { type: 'race', label: 'Half Marathon', distanceMi: 13.1, note: 'Race' };
const MARATHON: PlanDay = { type: 'marathon', label: 'Marathon', distanceMi: 26.2, note: 'Race day' };

type WeekRow = [number, number, number, number]; // [tue, wed, thu, sat] miles

/** Hal Higdon Novice 1 — 18 weeks, 4 run days + cross. Long run builds to 20 mi, stepback every 3rd week. */
function buildHalHigdonNovice1(): TrainingPlan {
  const weekData: WeekRow[] = [
    [3, 3, 3, 6],   [3, 3, 3, 7],   [3, 4, 3, 5],   [3, 4, 3, 9],
    [3, 5, 3, 10],  [3, 5, 3, 7],   [3, 6, 3, 12],  [3, 6, 3, 0],  // wk8: 0 = rest sat, sun = half
    [3, 7, 4, 10],  [3, 7, 4, 15],  [4, 8, 4, 16],  [4, 8, 5, 12],
    [4, 9, 5, 18],  [5, 9, 5, 14],  [5, 10, 5, 20], [5, 8, 4, 12],  // taper
    [4, 6, 3, 8],   [3, 4, 2, 0],   // wk18: rest rest marathon
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
  // Hanson's: Mon easy, Tue SOS (speed/strength then tempo), Wed easy, Thu easy, Fri SOS tempo, Sat easy, Sun long (max 16)
  // We use a representative week structure; exact daily miles vary by week.
  const weeks: PlanWeek[] = [];
  const longRuns = [6, 8, 10, 8, 10, 12, 10, 12, 14, 10, 14, 16, 12, 16, 12, 10, 8, 0]; // week 18 = marathon
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
    description: "Six days of running, long run cap at 16 miles. Builds cumulative fatigue with tempo and strength. Race week = marathon.",
    totalWeeks: 18,
    weeks,
  };
}

/** Hal Higdon Novice 2 — 18 weeks, slightly more mileage than Novice 1, 4 run days + cross. */
function buildHalHigdonNovice2(): TrainingPlan {
  const weekData: WeekRow[] = [
    [3, 5, 3, 8],    [3, 5, 3, 9],    [3, 5, 3, 6],    [3, 6, 3, 11],
    [3, 6, 3, 12],   [3, 6, 3, 9],    [4, 7, 4, 14],   [4, 7, 4, 15],
    [4, 7, 4, 0],    [4, 8, 4, 17],   [5, 8, 5, 18],   [5, 8, 5, 13],
    [5, 5, 5, 19],   [5, 8, 5, 12],   [5, 5, 5, 20],  [5, 4, 5, 12],
    [4, 3, 4, 8],    [3, 2, 0, 2],    // wk18: Thu rest, Sat 2 mi, Sun Marathon
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
    [3, 5, 3, 8],    [3, 5, 3, 9],    [3, 5, 3, 6],    [3, 6, 3, 10],
    [3, 6, 3, 11],   [3, 6, 3, 8],    [4, 7, 4, 12],   [4, 7, 4, 0],
    [4, 8, 4, 14],   [4, 8, 4, 16],   [5, 8, 5, 18],   [5, 8, 5, 12],
    [5, 10, 5, 20],  [5, 10, 5, 12],  [5, 6, 4, 12],  [4, 6, 3, 8],
    [3, 4, 2, 8],    [3, 4, 2, 0],
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
    [5, 8, 5, 10],   [5, 8, 5, 11],   [5, 8, 5, 8],    [5, 9, 5, 13],
    [5, 9, 5, 14],   [5, 9, 5, 10],   [5, 10, 5, 15],  [5, 10, 5, 0],
    [5, 11, 5, 17],  [5, 11, 5, 18],  [5, 12, 5, 20], [5, 12, 5, 12],
    [5, 12, 5, 20],  [5, 10, 5, 12],  [5, 8, 5, 12],  [5, 8, 5, 8],
    [4, 6, 4, 0],    [3, 4, 2, 0],
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
const FIRST = buildFirst();

export const BUILT_IN_PLANS: TrainingPlan[] = [
  HAL_HIGDON_NOVICE_1,
  HAL_HIGDON_NOVICE_2,
  HANSONS_BEGINNER,
  HAL_HIGDON_INTERMEDIATE_1,
  HAL_HIGDON_ADVANCED_1,
  FIRST,
];

export function getPlanById(id: string): TrainingPlan | undefined {
  return BUILT_IN_PLANS.find((p) => p.id === id);
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
