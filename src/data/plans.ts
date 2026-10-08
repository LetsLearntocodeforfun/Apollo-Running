/**
 * Popular marathon training plans + custom plan builder.
 * Distances are in miles (as published/estimated); we display both mi and km.
 *
 * v1.0.6 plan fidelity (V8–V11, V21):
 * - The Hal Higdon plans follow the published schedules: pace days, and every long
 *   run carries note 'Long'.
 * - Hansons and FIRST follow their methods' structure. The Pfitzinger and Nike
 *   plans are representative; their descriptions say "based on".
 * - Notes use {@link PLAN_NOTE_TAXONOMY}.
 * - Every plan ends with a race week that tapers into the race on the plan's final
 *   day, with nothing scheduled after it.
 */

import { persistence } from '../services/db/persistence';

export type DayType = 'rest' | 'run' | 'cross' | 'race' | 'marathon';

export interface PlanDay {
  type: DayType;
  label: string;
  distanceMi?: number;
  /** e.g. "Easy", "Long", "Tempo", "Speed" */
  note?: string;
  /** v1.0.6 overlay: true when the athlete skipped this day (the day is then `type: 'rest'`). */
  skipped?: boolean;
  /** v1.0.6 overlay: label of the planned workout this day replaced (skip/convert). */
  originalLabel?: string;
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
  /** Optional per-day workout type assignment (0=Mon … 6=Sun). Keys are day indices, values are workout types. */
  dayAssignments?: Record<number, CustomDayType>;
}

/** Workout types available for custom plan day assignment */
export type CustomDayType = 'easy' | 'long' | 'tempo' | 'speed' | 'marathon_pace' | 'medium_long' | 'rest' | 'cross';

export const CUSTOM_PLAN_ID = 'custom-built-marathon-plan';
const CUSTOM_PLAN_STORAGE_KEY = 'apollo_custom_marathon_plan';

/** Canonical workout kind of a plan day (v1.0.6). */
export type PlanWorkoutKind =
  | 'easy' | 'recovery' | 'long' | 'medium_long' | 'tempo' | 'marathon_pace'
  | 'strength' | 'speed' | 'race' | 'marathon' | 'cross' | 'rest';

/** The note values plans use (the canonical workout taxonomy). */
export const PLAN_NOTE_TAXONOMY = [
  'Easy', 'Long', 'Tempo', 'Speed', 'Strength', 'Medium Long', 'Marathon Pace', 'Recovery', 'Race', 'Rest', 'Cross',
] as const;

/**
 * Canonical workout kind of a plan day, from its type and note (labels only
 * refine notes written by older versions, e.g. "8 mi marathon pace" with note
 * "Tempo"). Whole-word matching — "tempo" never counts as "mp".
 */
export function getWorkoutKind(day: PlanDay | null | undefined): PlanWorkoutKind {
  if (!day || day.type === 'rest') return 'rest';
  if (day.type === 'cross') return 'cross';
  if (day.type === 'marathon') return 'marathon';
  if (day.type === 'race') return 'race';
  const note = (day.note ?? '').trim().toLowerCase();
  const label = String(day.label || '').toLowerCase();
  if (note === 'marathon pace' || note === 'mp' || /\bmarathon pace\b|\bmp\b/.test(label)) return 'marathon_pace';
  if (note === 'race' || note === 'race day') return 'race';
  if (note === 'tempo' || note === 'threshold') return 'tempo';
  if (note === 'speed' || note === 'intervals') return 'speed';
  if (note === 'strength') return 'strength';
  if (note === 'medium long' || note === 'medium-long') return 'medium_long';
  if (note === 'long') return 'long';
  if (note === 'recovery' || /\brecovery\b/.test(label)) return 'recovery';
  if (/\blong\b/.test(label) && !/\bmedium\b/.test(label)) return 'long';
  return 'easy';
}

/** Notes a structured session can carry. */
type SessionNote = 'Tempo' | 'Speed' | 'Strength' | 'Marathon Pace' | 'Medium Long';

const MI = (n: number): PlanDay => ({ type: 'run', label: `${n} mi run`, distanceMi: n, note: 'Easy' });
/** Long run. Every long-run consumer keys on note 'Long' (V9). */
const LONG = (n: number): PlanDay => ({ type: 'run', label: `${n} mi long run`, distanceMi: n, note: 'Long' });
/** Higdon "pace" day: the whole run at goal marathon pace. */
const PACE = (n: number): PlanDay => ({ type: 'run', label: `${n} mi marathon pace`, distanceMi: n, note: 'Marathon Pace' });
const EASY = (n: number, label = `${n} mi easy`): PlanDay => ({ type: 'run', label, distanceMi: n, note: 'Easy' });
const RECOVERY = (n: number): PlanDay => ({ type: 'run', label: `${n} mi recovery`, distanceMi: n, note: 'Recovery' });
/** A structured session; `distanceMi` includes warm-up and cool-down. */
const SESSION = (n: number, label: string, note: SessionNote): PlanDay => ({ type: 'run', label, distanceMi: n, note });
const REST: PlanDay = { type: 'rest', label: 'Rest' };
const CROSS: PlanDay = { type: 'cross', label: 'Cross' };
const HALF: PlanDay = { type: 'race', label: 'Half Marathon', distanceMi: 13.1, note: 'Race' };
const MARATHON: PlanDay = { type: 'marathon', label: 'Marathon', distanceMi: 26.2, note: 'Race' };

type WeekRow = [number, number, number, number]; // [tue, wed, thu, sat] miles
/** Five daily distances in miles; each builder documents which days they are. */
type FiveDayRow = [number, number, number, number, number];

function roundToTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

function roundHalf(n: number): number {
  return Math.round(n * 2) / 2;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readStorage<T>(key: string): T | null {
  try {
    const raw = persistence.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown | null): void {
  try {
    if (value == null) persistence.removeItem(key);
    else persistence.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage errors
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
      sat > 0 ? LONG(sat) : REST,
      i === 7 ? HALF : i === 17 ? MARATHON : CROSS,
    ],
  }));
  return {
    id: 'hal-higdon-novice-1',
    name: 'Novice 1',
    author: 'Hal Higdon',
    description: 'Based on Hal Higdon’s Novice 1, the most popular first-marathon plan. 4 run days, cross-training, long runs to 20 miles. Stepback weeks every third week.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 7,
  };
}

/**
 * Hansons Beginner — 18 weeks, six run days with Wednesday off, long run capped at
 * 16 mi (V8). Weeks 1–5 are easy. Then come speed (weeks 6–10) and strength
 * (weeks 11–17) on Tuesday, and a Thursday tempo at goal marathon pace. ~10-day
 * taper: the last hard session is week 17's Thursday tempo.
 */
function buildHansonsBeginner(): TrainingPlan {
  // Weeks 1–17 (index 0–16); the race week is appended below.
  const easy = [3, 3, 4, 4, 5, 5, 5, 6, 6, 6, 6, 7, 7, 7, 7, 7, 5]; // Mon / Fri / Sat
  const baseTue = [3, 4, 4, 5, 5]; // weeks 1–5: easy
  const baseThu = [3, 3, 4, 4, 5];
  const speed = ['12 × 400 m', '8 × 600 m', '6 × 800 m', '5 × 1 km', '4 × 1200 m']; // weeks 6–10
  const strength = ['6 × 1 mi', '4 × 1.5 mi', '3 × 2 mi', '2 × 3 mi', '3 × 2 mi', '4 × 1.5 mi', '6 × 1 mi']; // weeks 11–17
  const tempoMp = [5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 6]; // weeks 6–17: miles at goal marathon pace (+2 mi warm-up/cool-down)
  const long = [5, 6, 6, 8, 8, 10, 10, 12, 10, 15, 12, 16, 12, 16, 12, 16, 8];
  const weeks: PlanWeek[] = long.map((sun, w) => {
    const e = easy[w];
    const tue = w < 5
      ? EASY(baseTue[w])
      : w < 10
        ? SESSION(6, `${speed[w - 5]} speed`, 'Speed')
        : SESSION(9, `${strength[w - 10]} strength`, 'Strength');
    const thu = w < 5
      ? EASY(baseThu[w])
      : SESSION(tempoMp[w - 5] + 2, `${tempoMp[w - 5]} mi tempo at marathon pace`, 'Marathon Pace');
    return { weekNumber: w + 1, days: [EASY(e), tue, REST, thu, EASY(e), EASY(e), LONG(sun)] };
  });
  // Race week: short easy runs, one short marathon-pace tune-up, no long tempo.
  weeks.push({
    weekNumber: 18,
    days: [
      EASY(5),
      EASY(5),
      REST,
      SESSION(5, '5 mi with 3 at marathon pace', 'Marathon Pace'),
      EASY(4),
      EASY(3, '3 mi easy + strides'),
      MARATHON,
    ],
  });
  return {
    id: 'hansons-beginner',
    name: "Beginner (Just Finish)",
    author: "Hanson's",
    description: 'Based on the Hansons Marathon Method beginner program. Six days of running with Wednesday off, and the long run caps at 16 miles. Speed work comes first, then strength, plus a Thursday tempo at goal marathon pace. It builds cumulative fatigue and ends with a ~10-day taper.',
    totalWeeks: 18,
    weeks,
  };
}

/** Hal Higdon Novice 2 — 18 weeks, 4 run days + cross, Wednesday marathon-pace runs. */
function buildHalHigdonNovice2(): TrainingPlan {
  const weekData: WeekRow[] = [
    [3, 5, 3, 8], [3, 5, 3, 9], [3, 5, 3, 6], [3, 6, 3, 11],
    [3, 6, 3, 12], [3, 6, 3, 9], [4, 7, 4, 14], [4, 7, 4, 15],
    [4, 7, 4, 0], [4, 8, 4, 17], [5, 8, 5, 18], [5, 8, 5, 13],
    [5, 5, 5, 19], [5, 8, 5, 12], [5, 5, 5, 20], [5, 4, 5, 12],
    [4, 3, 4, 8], [3, 2, 0, 2],
  ];
  /** Weeks (0-based) whose Wednesday run is at marathon pace. */
  const paceWeeks = new Set([0, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15]);
  const weeks: PlanWeek[] = weekData.map(([tue, wed, thu, sat], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      MI(tue),
      paceWeeks.has(i) ? PACE(wed) : MI(wed),
      thu === 0 ? REST : MI(thu),
      REST,
      i === 17 ? MI(sat) : sat === 0 ? REST : LONG(sat),
      i === 8 ? HALF : i === 17 ? MARATHON : CROSS,
    ],
  }));
  return {
    id: 'hal-higdon-novice-2',
    name: 'Novice 2',
    author: 'Hal Higdon',
    description: 'Based on Hal Higdon’s Novice 2, a step up from Novice 1. Wednesday marathon-pace runs, slightly higher midweek mileage and long runs to 20 miles. Ideal if you have run a few races.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 8,
  };
}

/** Hal Higdon Intermediate 1 — 18 weeks, 5 run days, Saturday pace runs before the Sunday long run. */
function buildHalHigdonIntermediate1(): TrainingPlan {
  // [tue, wed, thu, sat, sun] miles; Monday cross, Friday rest.
  const weekData: FiveDayRow[] = [
    [3, 5, 3, 5, 8], [3, 5, 3, 5, 9], [3, 5, 3, 5, 6], [3, 6, 3, 6, 11],
    [3, 6, 3, 6, 12], [3, 5, 3, 6, 9], [4, 7, 4, 7, 14], [4, 7, 4, 7, 15],
    [4, 5, 4, 0, 0], [4, 8, 4, 8, 17], [5, 8, 5, 8, 18], [5, 5, 5, 8, 13],
    [5, 8, 5, 5, 20], [5, 5, 5, 8, 12], [5, 8, 5, 5, 20], [5, 6, 5, 4, 12],
    [4, 5, 4, 3, 8], [3, 4, 0, 2, 0],
  ];
  /** Weeks (0-based) whose Saturday run is at marathon pace. */
  const paceWeeks = new Set([0, 2, 3, 5, 6, 9, 11, 12, 14, 15]);
  const weeks: PlanWeek[] = weekData.map(([tue, wed, thu, sat, sun], i) => ({
    weekNumber: i + 1,
    days: [
      CROSS,
      MI(tue),
      MI(wed),
      thu === 0 ? REST : MI(thu),
      REST,
      sat === 0 ? REST : paceWeeks.has(i) ? PACE(sat) : MI(sat),
      i === 8 ? HALF : i === 17 ? MARATHON : LONG(sun),
    ],
  }));
  return {
    id: 'hal-higdon-intermediate-1',
    name: 'Intermediate 1',
    author: 'Hal Higdon',
    description: 'Based on Hal Higdon’s Intermediate 1, for runners with a base. Five run days, with a marathon-pace run on Saturday before the Sunday long run. Long runs reach 20 miles three times, and mileage peaks in the mid-40s.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 8,
  };
}

/** Thursday quality session of Higdon Advanced 1: hills, 800 m repeats, or a tempo in minutes. */
type HigdonQuality = ['hill' | '800' | 'tempo', number];

/** Higdon quality session as a plan day; the distance includes warm-up and cool-down. */
function higdonQuality([kind, n]: HigdonQuality): PlanDay {
  if (kind === 'tempo') return SESSION(roundHalf(2 + n / 8), `${n} min tempo`, 'Tempo');
  if (kind === '800') return SESSION(roundHalf(3 + 0.75 * n), `${n} × 800 m`, 'Speed');
  return SESSION(roundHalf(3 + 0.5 * n), `${n} × hill repeats`, 'Speed');
}

/** Hal Higdon Advanced 1 — 18 weeks, 6 run days, Thursday hills / tempo / 800s, Saturday pace runs, peak ~55+ mi. */
function buildHalHigdonAdvanced1(): TrainingPlan {
  // [mon, tue, wed, sat, sun] miles + the Thursday session; Friday rest.
  const weekData: [FiveDayRow, HigdonQuality][] = [
    [[3, 5, 3, 5, 10], ['hill', 3]],
    [[3, 5, 3, 5, 11], ['tempo', 30]],
    [[3, 6, 3, 6, 8], ['800', 4]],
    [[3, 6, 3, 6, 13], ['hill', 4]],
    [[3, 7, 3, 7, 14], ['tempo', 35]],
    [[3, 7, 3, 7, 10], ['800', 5]],
    [[3, 8, 4, 8, 16], ['hill', 5]],
    [[3, 8, 4, 8, 17], ['tempo', 40]],
    [[3, 9, 4, 0, 0], ['800', 6]],
    [[3, 9, 4, 9, 19], ['hill', 6]],
    [[4, 10, 5, 10, 20], ['tempo', 45]],
    [[4, 6, 5, 6, 12], ['800', 7]],
    [[4, 10, 5, 10, 20], ['hill', 7]],
    [[5, 6, 5, 6, 12], ['tempo', 45]],
    [[5, 10, 5, 10, 20], ['800', 8]],
    [[5, 8, 5, 4, 12], ['hill', 6]],
    [[4, 6, 4, 4, 8], ['tempo', 30]],
  ];
  /** Weeks (0-based) whose Saturday run is at marathon pace. */
  const paceWeeks = new Set([0, 2, 3, 5, 6, 9, 11, 12, 14, 15]);
  const weeks: PlanWeek[] = weekData.map(([[mon, tue, wed, sat, sun], quality], i) => ({
    weekNumber: i + 1,
    days: [
      MI(mon),
      MI(tue),
      MI(wed),
      higdonQuality(quality),
      REST,
      sat === 0 ? REST : paceWeeks.has(i) ? PACE(sat) : MI(sat),
      i === 8 ? HALF : LONG(sun),
    ],
  }));
  // Race week: 3 mi run, 4 × 400, 2 mi run, two rest days, 2 mi run, marathon.
  weeks.push({
    weekNumber: 18,
    days: [MI(3), SESSION(4, '4 × 400 m', 'Speed'), MI(2), REST, REST, MI(2), MARATHON],
  });
  return {
    id: 'hal-higdon-advanced-1',
    name: 'Advanced 1',
    author: 'Hal Higdon',
    description: 'Based on Hal Higdon’s Advanced 1, for experienced marathoners aiming for a PR. Six run days, with Thursday hills, tempo or 800s and Saturday marathon-pace runs. Long runs reach 20 miles and mileage peaks in the mid-50s.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 8,
  };
}

/** Pete Pfitzinger 18/55 (representative structure) — 18 weeks, peaks near 55 mi/week. */
function buildPfitzinger1855(): TrainingPlan {
  // Weeks 1–17; the last 20-miler is 3 weeks before race week, then ~80/60/40 % taper.
  const weeklyTargets = [33, 37, 41, 35, 45, 47, 50, 40, 44, 55, 46, 53, 50, 52, 55, 44, 33];
  const longRuns = [12, 14, 15, 12, 16, 17, 18, 14, 0, 20, 16, 20, 17, 18, 20, 16, 12];
  const weeks: PlanWeek[] = weeklyTargets.map((target, i) => {
    if (i === 8) {
      // Tune-up half marathon: easy Saturday before the race.
      return {
        weekNumber: i + 1,
        days: [REST, EASY(7), SESSION(10, '10 mi medium long', 'Medium Long'), RECOVERY(5), REST, EASY(4), HALF],
      };
    }
    const long = longRuns[i];
    const easy = roundToTenth(target * 0.14);
    const mediumLong = roundToTenth(Math.min(target * 0.24, 15));
    const mp = roundToTenth(target * 0.16);
    const recovery = roundToTenth(Math.max(target - (long + easy + mediumLong + mp), 3));
    const days: PlanDay[] = [
      REST,
      EASY(easy),
      SESSION(mediumLong, `${mediumLong} mi medium long`, 'Medium Long'),
      RECOVERY(recovery),
      REST,
      SESSION(mp, `${mp} mi marathon pace`, 'Marathon Pace'),
      LONG(long),
    ];
    return {
      weekNumber: i + 1,
      days,
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [
      REST,
      EASY(6),
      SESSION(5, '5 mi with 2 at marathon pace', 'Marathon Pace'),
      RECOVERY(4),
      REST,
      EASY(4, '4 mi easy + strides'),
      MARATHON,
    ],
  });
  return {
    id: 'pfitzinger-18-55',
    name: '18/55',
    author: 'Pete Pfitzinger',
    description: 'Based on Pete Pfitzinger’s 18/55 (representative structure), a performance plan peaking around 55 miles/week. Medium-long runs, marathon-pace workouts, long runs to 20 miles and a 3-week taper.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 8,
  };
}

/** Nike Run Club Marathon (representative) — 18 weeks, 5 run days with speed and long runs. */
function buildNikeRunClubMarathon(): TrainingPlan {
  // Weeks 1–17; the last 20-miler is 3 weeks before race week.
  const longRuns = [8, 10, 11, 9, 12, 13, 14, 10, 15, 16, 12, 18, 14, 18, 20, 14, 10];
  const weeks: PlanWeek[] = longRuns.map((long, i) => {
    // [speed, recovery, tempo, easy] miles: base → build → two taper weeks.
    const [speed, recovery, tempo, easy] =
      i < 6 ? [4, 3, 5, 4] : i < 15 ? [5, 4, 6, 5] : i === 15 ? [4, 3, 5, 3] : [3, 3, 4, 3];
    return {
      weekNumber: i + 1,
      days: [
        REST,
        SESSION(speed, `${speed} mi speed workout`, 'Speed'),
        RECOVERY(recovery),
        SESSION(tempo, `${tempo} mi tempo`, 'Tempo'),
        REST,
        EASY(easy),
        LONG(long),
      ],
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [
      REST,
      EASY(4, '4 mi easy + strides'),
      RECOVERY(3),
      SESSION(4, '4 mi with 2 at marathon pace', 'Marathon Pace'),
      REST,
      EASY(2, '2 mi shakeout'),
      MARATHON,
    ],
  });
  return {
    id: 'nike-run-club-marathon',
    name: 'Marathon Plan',
    author: 'Nike Run Club',
    description: 'Based on the Nike Run Club marathon plan (representative structure), a popular digital-first plan. Guided speed sessions, recovery runs and long runs that build to 20 miles.',
    totalWeeks: 18,
    weeks,
  };
}

/**
 * FIRST (Run Less, Run Faster) — 16 weeks, the book's marathon length (V9). Three
 * key runs a week (Tuesday intervals, Thursday tempo, Sunday long) plus two
 * cross-training days. Five 20-milers; the last is 3 weeks before race week.
 */
function buildFirst(): TrainingPlan {
  // Weeks 1–15: [intervals, interval-day miles, Thursday tempo miles, Sunday long run]
  const rows: [string, number, number, number][] = [
    ['8 × 400 m', 5, 5, 13],
    ['5 × 1 km', 6, 6, 15],
    ['3 × 1600 m', 6, 6, 17],
    ['6 × 800 m', 6, 7, 18],
    ['4 × 1200 m', 6, 6, 20],
    ['10 × 400 m', 6, 8, 15],
    ['3 × 1600 m', 6, 7, 20],
    ['5 × 1 km', 6, 8, 13],
    ['2 × 2400 m', 6, 7, 20],
    ['6 × 800 m', 6, 9, 15],
    ['4 × 1200 m', 6, 8, 20],
    ['3 × 1600 m', 6, 10, 18],
    ['5 × 1 km', 6, 8, 20],
    ['6 × 800 m', 5, 7, 15],
    ['8 × 400 m', 5, 5, 10],
  ];
  const weeks: PlanWeek[] = rows.map(([reps, repMiles, tempo, long], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      SESSION(repMiles, `${reps} intervals`, 'Speed'),
      CROSS,
      SESSION(tempo, `${tempo} mi tempo`, 'Tempo'),
      CROSS,
      REST,
      LONG(long),
    ],
  }));
  weeks.push({
    weekNumber: 16,
    days: [
      REST,
      SESSION(4, '6 × 400 m intervals', 'Speed'),
      CROSS,
      SESSION(5, '5 mi with 3 at marathon pace', 'Marathon Pace'),
      REST,
      REST,
      MARATHON,
    ],
  });
  return {
    id: 'first',
    name: 'Run Less, Run Faster',
    author: 'FIRST',
    description: 'Based on FIRST’s Run Less, Run Faster 16-week marathon program. Three quality runs per week (intervals, tempo, long) plus two cross-training days. Lower running volume, higher intensity.',
    totalWeeks: 16,
    weeks,
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

/** Long-run day to keep when several days are marked 'long': Sunday, then Saturday, then the last. */
function pickLongDay(candidates: number[]): number {
  if (candidates.includes(6)) return 6;
  if (candidates.includes(5)) return 5;
  return candidates[candidates.length - 1];
}

/**
 * Race week of a custom plan (V11). Short easy runs (≤ 6 mi, ≤ 4 mi two days out)
 * plus strides, a Saturday shakeout, the marathon on the final day (Sunday) and
 * nothing after it. No quality and no long run.
 */
function buildCustomRaceWeek(runDays: number[], crossDays: Set<number>, trainingMiles: number): PlanDay[] {
  const days: PlanDay[] = Array.from({ length: 7 }, (_, d) => (crossDays.has(d) && d < 5 ? CROSS : REST));
  const hasShakeout = runDays.includes(5);
  const shakeout = trainingMiles >= 20 ? 3 : 2;
  const others = runDays.filter((d) => d < 5);
  const per = others.length > 0 ? (trainingMiles - (hasShakeout ? shakeout : 0)) / others.length : 0;
  others.forEach((d, idx) => {
    const miles = roundHalf(clamp(per, 2, d >= 4 ? 4 : 6));
    const strides = !hasShakeout && idx === others.length - 1;
    days[d] = EASY(miles, strides ? `${miles} mi easy + strides` : `${miles} mi easy`);
  });
  if (hasShakeout) days[5] = EASY(shakeout, `${shakeout} mi shakeout + strides`);
  days[6] = MARATHON;
  return days;
}

export function createCustomPlanFromScratch(input: CustomPlanBuilderInput): TrainingPlan {
  const totalWeeks = clamp(Math.round(input.totalWeeks), 10, 30);
  const runningDays = clamp(Math.round(input.runningDays), 3, 6);
  const baseMiles = clamp(input.currentWeeklyMiles, 8, 80);
  const peakMiles = clamp(Math.max(input.peakWeeklyMiles, baseMiles + 4), baseMiles + 4, 90);
  const raceWeek = totalWeeks - 1;
  /** Last build week: the peak long run lands 3 weeks before race week (V10). */
  const lastBuildWeek = totalWeeks - 4;

  // Default day layouts if no assignments provided
  const defaultRunDayMap: Record<number, number[]> = {
    3: [1, 3, 6],
    4: [1, 2, 4, 6],
    5: [1, 2, 3, 5, 6],
    6: [0, 1, 2, 3, 5, 6],
  };

  // Build the ordered run-day list and per-day workout types
  const assignments = input.dayAssignments;
  let runDays: number[];
  let dayTypes: Record<number, CustomDayType>;

  if (assignments && Object.keys(assignments).length > 0) {
    // Use explicit day assignments: run days are any day that isn't 'rest' or 'cross'
    runDays = [];
    dayTypes = {};
    for (let d = 0; d < 7; d++) {
      const assigned = assignments[d] ?? 'rest';
      dayTypes[d] = assigned;
      if (assigned !== 'rest' && assigned !== 'cross') {
        runDays.push(d);
      }
    }
    // Ensure exactly one long run day exists (V11): extra long days become medium-long runs.
    const longDays = runDays.filter((d) => dayTypes[d] === 'long');
    if (longDays.length === 0) {
      const lastRunDay = runDays[runDays.length - 1] ?? 6;
      dayTypes[lastRunDay] = 'long';
      if (!runDays.includes(lastRunDay)) runDays.push(lastRunDay);
    } else if (longDays.length > 1) {
      const keep = pickLongDay(longDays);
      for (const d of longDays) if (d !== keep) dayTypes[d] = 'medium_long';
    }
  } else {
    // Fallback to default layout
    runDays = defaultRunDayMap[runningDays] ?? defaultRunDayMap[4];
    dayTypes = {};
    const longDay = runDays.includes(6) ? 6 : runDays[runDays.length - 1];
    for (const d of runDays) {
      if (d === longDay) {
        dayTypes[d] = 'long';
      } else {
        dayTypes[d] = 'easy';
      }
    }
    // Add a tempo day if enough running days
    if (runningDays >= 4) {
      const qualityDay = runDays[Math.floor(runDays.length / 2) - 1] ?? runDays[0];
      if (dayTypes[qualityDay] !== 'long') {
        dayTypes[qualityDay] = 'tempo';
      }
    }
  }

  const crossDays = new Set<number>();
  if (assignments) {
    for (let d = 0; d < 7; d++) if (assignments[d] === 'cross') crossDays.add(d);
  }

  // Long-run progression (V10): from ~30 % of current volume up to a
  // marathon-specific 16–20 mi, with cutback weeks. Then a 3-week taper at
  // ~80/60/40 % of peak volume.
  const targetLong = Math.min(20, Math.max(16, roundHalf(0.4 * peakMiles)));
  const startLong = clamp(roundHalf(0.3 * baseMiles), 6, targetLong - 2);
  const isCutback = (w: number) => w > 2 && w % 4 === 3 && w < lastBuildWeek;

  const qualityTypes: CustomDayType[] = ['tempo', 'speed', 'marathon_pace'];
  const qualityCount = runDays.filter((d) => qualityTypes.includes(dayTypes[d])).length;
  const medLongCount = runDays.filter((d) => dayTypes[d] === 'medium_long').length;
  const easyCount = runDays.filter((d) => dayTypes[d] === 'easy').length;

  const weeks: PlanWeek[] = [];
  for (let w = 0; w < totalWeeks; w++) {
    let weekMiles: number;
    let longRaw: number;
    if (w <= lastBuildWeek) {
      const progress = Math.min(w / Math.max(lastBuildWeek, 1), 1);
      weekMiles = baseMiles + (peakMiles - baseMiles) * progress;
      longRaw = startLong + (targetLong - startLong) * progress;
      if (isCutback(w)) {
        weekMiles *= 0.86;
        longRaw *= 0.75;
      }
    } else if (w === raceWeek - 2) {
      weekMiles = peakMiles * 0.8;
      longRaw = targetLong * 0.7;
    } else if (w === raceWeek - 1) {
      weekMiles = peakMiles * 0.6;
      longRaw = targetLong * 0.5;
    } else {
      weekMiles = peakMiles * 0.4;
      longRaw = 0;
    }
    weekMiles = roundToTenth(weekMiles);

    if (w === raceWeek) {
      weeks.push({ weekNumber: w + 1, days: buildCustomRaceWeek(runDays, crossDays, weekMiles) });
      continue;
    }

    // Calculate mileage distribution based on assigned workout types
    const longMiles = roundHalf(longRaw);
    const qualityMiles = roundHalf(clamp(weekMiles * 0.16, 3, 10));
    const medLongMiles = roundHalf(Math.min(clamp(weekMiles * 0.2, 5, 14), Math.max(longMiles, 5)));
    const remainingMiles = weekMiles - longMiles - qualityMiles * qualityCount - medLongMiles * medLongCount;
    // Round easy days down so the week never exceeds its target volume.
    const easyMiles = Math.max(2, Math.floor((easyCount > 0 ? remainingMiles / easyCount : 2) * 2) / 2);

    const days: PlanDay[] = Array.from({ length: 7 }, (_, d) => (crossDays.has(d) ? CROSS : REST));
    for (const day of runDays) {
      switch (dayTypes[day]) {
        case 'long':
          days[day] = LONG(longMiles);
          break;
        case 'tempo':
          days[day] = SESSION(qualityMiles, `${qualityMiles} mi tempo`, 'Tempo');
          break;
        case 'speed':
          days[day] = SESSION(qualityMiles, `${qualityMiles} mi speed`, 'Speed');
          break;
        case 'marathon_pace':
          days[day] = SESSION(qualityMiles, `${qualityMiles} mi MP`, 'Marathon Pace');
          break;
        case 'medium_long':
          days[day] = SESSION(medLongMiles, `${medLongMiles} mi medium long`, 'Medium Long');
          break;
        default:
          days[day] = EASY(easyMiles);
          break;
      }
    }

    weeks.push({ weekNumber: w + 1, days });
  }

  return {
    id: CUSTOM_PLAN_ID,
    name: input.name.trim() || 'Custom Marathon Plan',
    author: 'You + Apollo Builder',
    description:
      `Built from scratch for ${runDays.length} running days/week, starting near ${baseMiles} mpw and peaking around ${peakMiles} mpw. ` +
      `Long runs build to ${targetLong} mi (the last one 3 weeks before race day), followed by a 3-week taper.`,
    totalWeeks,
    weeks,
  };
}

/** Training miles of a plan week (race days excluded). */
function weekTrainingMiles(week: PlanWeek): number {
  return week.days.reduce((sum, d) => sum + (d.type === 'run' ? d.distanceMi ?? 0 : 0), 0);
}

/**
 * Rank built-in plans for a runner (V21). Entry fit compares current weekly miles
 * with the plan's weeks 1–3: starting well above current volume costs more than
 * starting below it. Plans peaking above ~3× current volume are penalised as too
 * steep a ramp.
 */
export function suggestPlansForRunner(weeklyMiles: number, runningDays: number): PlanRecommendation[] {
  const miles = clamp(weeklyMiles, 0, 120);
  const days = clamp(runningDays, 1, 7);
  const plans = BUILT_IN_PLANS;
  const scored = plans.map((plan): PlanRecommendation => {
    const entryWeeks = plan.weeks.slice(0, 3);
    const entry = roundToTenth(entryWeeks.reduce((s, w) => s + weekTrainingMiles(w), 0) / Math.max(1, entryWeeks.length));
    const peak = roundToTenth(Math.max(...plan.weeks.map(weekTrainingMiles)));
    const avgRunsPerWeek = roundToTenth(
      plan.weeks.reduce((sum, week) => sum + week.days.filter((d) => d.type === 'run' || d.type === 'race' || d.type === 'marathon').length, 0) / plan.totalWeeks,
    );
    const gap = entry - miles;
    const entryScore = Math.max(0, 50 - (gap > 0 ? gap * 2.5 : -gap * 1.2));
    const daysScore = Math.max(0, 35 - Math.abs(avgRunsPerWeek - days) * 8);
    const rampPenalty = miles > 0 && peak > miles * 3 ? Math.min(15, (peak / miles - 3) * 5) : 0;
    const planBias =
      plan.id === 'pfitzinger-18-55' ? (miles >= 35 && days >= 5 ? 20 : -5)
        : plan.id === 'hal-higdon-novice-1' ? (miles <= 25 ? 16 : 0)
          : plan.id === 'hal-higdon-novice-2' ? (miles >= 20 && miles <= 35 ? 12 : 0)
            : plan.id === 'first' ? (days <= 4 ? 12 : 0)
              : 0;
    const score = roundToTenth(entryScore + daysScore + planBias - rampPenalty);
    return {
      planId: plan.id,
      score,
      reason: `${plan.name}: starts around ${entry} mi/week (weeks 1–3), peaks around ${peak} mi/week and uses about ${avgRunsPerWeek} run days/week.`,
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
