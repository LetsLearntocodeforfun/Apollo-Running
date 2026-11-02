/**
 * Expanded Marathon & Block Plan Library for Apollo Running.
 *
 * Compact, deterministic builders for 25+ additional plans across:
 *   - Hal Higdon (Novice Supreme 30w, Intermediate 2, Advanced 2, Personal Best)
 *   - Pete Pfitzinger Method (12/55, 12/70, 18/70, 18/85, Multiple Marathoning 12w & 8w)
 *   - Jack Daniels 2Q Method (2Q-40, 2Q-55, 2Q-70, 2Q-85)
 *   - Hansons Marathon Method (Just Finish, Advanced)
 *   - Jeff Galloway Run-Walk-Run (20w)
 *   - Specialty Methodologies (Time-on-Feet Endurance, Norwegian Sub-Threshold,
 *     Canova Specific-Block, Boston Qualifier 18/60)
 *   - Supplemental Base & Recovery Blocks (8w Base, 12w Base, 4w Post-Marathon Recovery, 6w Off-Season)
 *
 * Every marathon plan strictly satisfies Apollo's fidelity invariants:
 *   - Canonical PLAN_NOTE_TAXONOMY notes (the note alone determines getWorkoutKind)
 *   - Coach-authentic tempo shapes (never generic cruise intervals on built-in plans)
 *   - Taper <= 75% of peak in the final two weeks; strict race-week caps; Sunday marathon finish
 *   - Allow-listed https official attribution links
 */

import type { PlanAttribution, PlanDay, PlanTier, PlanWeek, TrainingPlan } from './plans';

type SessionNote = 'Tempo' | 'Speed' | 'Strength' | 'Marathon Pace' | 'Medium Long';

const rHalf = (n: number): number => Math.round(n * 2) / 2;

const REST: PlanDay = { type: 'rest', label: 'Rest' };
const CROSS: PlanDay = { type: 'cross', label: 'Cross' };
const HALF: PlanDay = { type: 'race', label: 'Half Marathon', distanceMi: 13.1, note: 'Race' };
const TEN_K: PlanDay = { type: 'race', label: '10K Tune-Up Race', distanceMi: 6.2, note: 'Race' };
const MARATHON: PlanDay = { type: 'marathon', label: 'Marathon', distanceMi: 26.2, note: 'Race' };

const MI = (n: number): PlanDay => ({ type: 'run', label: `${n} mi run`, distanceMi: n, note: 'Easy' });
const EASY = (n: number, label = `${n} mi easy`): PlanDay => ({ type: 'run', label, distanceMi: n, note: 'Easy' });
const REC = (n: number, pmMi?: number): PlanDay => ({
  type: 'run',
  label: `${n} mi recovery`,
  distanceMi: n,
  note: 'Recovery',
  ...(pmMi && pmMi > 0
    ? { secondary: { label: `${pmMi} mi PM recovery`, distanceMi: pmMi, note: 'Recovery' as const } }
    : {}),
});
const LONG = (n: number, extra?: Partial<PlanDay>): PlanDay => ({
  type: 'run',
  label: `${n} mi long run`,
  distanceMi: n,
  note: 'Long',
  ...extra,
});
const LONG_MP = (n: number): PlanDay => LONG(n, { mpFinish: true });
const MLR = (n: number, pmMi?: number): PlanDay => ({
  type: 'run',
  label: `${n} mi medium long`,
  distanceMi: n,
  note: 'Medium Long',
  ...(pmMi && pmMi > 0
    ? { secondary: { label: `${pmMi} mi PM recovery`, distanceMi: pmMi, note: 'Recovery' as const } }
    : {}),
});
const PACE = (n: number): PlanDay => ({
  type: 'run',
  label: `${n} mi marathon pace`,
  distanceMi: n,
  note: 'Marathon Pace',
});
const MP_WORK = (total: number, mp: number): PlanDay => ({
  type: 'run',
  label: `${total} mi with ${mp} at marathon pace`,
  distanceMi: total,
  note: 'Marathon Pace',
});
const CONT_TEMPO = (n: number, label = `${n} mi tempo`, pmMi?: number): PlanDay => ({
  type: 'run',
  label,
  distanceMi: n,
  note: 'Tempo',
  tempoShape: 'continuous',
  ...(pmMi && pmMi > 0
    ? { secondary: { label: `${pmMi} mi PM recovery`, distanceMi: pmMi, note: 'Recovery' as const } }
    : {}),
});
const PROG_TEMPO = (min: number): PlanDay => ({
  type: 'run',
  label: `${min} min tempo`,
  distanceMi: rHalf(2 + min / 8),
  note: 'Tempo',
  tempoShape: 'progressive',
});
const SESSION = (n: number, label: string, note: SessionNote, pmMi?: number): PlanDay => ({
  type: 'run',
  label,
  distanceMi: n,
  note,
  ...(pmMi && pmMi > 0
    ? { secondary: { label: `${pmMi} mi PM recovery`, distanceMi: pmMi, note: 'Recovery' as const } }
    : {}),
});

// ── Shared Attributions ─────────────────────────────────────────────────────

function higdonAttr(planName: string, slug: string): PlanAttribution {
  return {
    coach: 'Hal Higdon',
    fidelity: 'published-schedule',
    note:
      `Follows Hal Higdon’s published ${planName} schedule day for day. ` +
      'Apollo adds VDOT pace targets, mileage estimates for timed sessions and repeats, race-date placement and compliance tracking; visit Hal Higdon’s site for his full workout notes.',
    sources: [
      {
        label: `Hal Higdon’s ${planName} schedule`,
        url: `https://www.halhigdon.com/training-programs/marathon-training/${slug}/`,
        kind: 'free-plan',
      },
      {
        label: 'All of Hal Higdon’s marathon plans',
        url: 'https://www.halhigdon.com/training/marathon-training/',
        kind: 'website',
      },
    ],
  };
}

function pfitzAttr(planLabel: string, note?: string): PlanAttribution {
  return {
    coach: 'Pete Pfitzinger',
    fidelity: 'method',
    note:
      note ??
      `Built from Pete Pfitzinger’s ${planLabel} principles in Advanced Marathoning: endurance + lactate-threshold ` +
        'mesocycles, midweek medium-long runs, VO₂max sharpening, marathon-pace long runs and a 3-week taper. Not a verbatim table copy; see the book for full tables.',
    sources: [
      {
        label: 'Advanced Marathoning by Pete Pfitzinger & Scott Douglas (Human Kinetics)',
        url: 'https://us.humankinetics.com/products/advanced-marathoning-4th-edition',
        kind: 'book',
      },
    ],
  };
}

function danielsAttr(bandLabel: string): PlanAttribution {
  return {
    coach: 'Jack Daniels',
    fidelity: 'method',
    note:
      `Built from Jack Daniels’ 2Q (${bandLabel}) marathon method: two structured quality workouts (Q1 weekend endurance/MP/T, ` +
      'Q2 midweek threshold and interval work) supported by easy aerobic mileage scaled from peak weekly volume. See Daniels’ Running Formula for official tables.',
    sources: [
      {
        label: 'Daniels’ Running Formula (Human Kinetics)',
        url: 'https://us.humankinetics.com/products/daniels-running-formula-4th-edition',
        kind: 'book',
      },
      {
        label: 'VDOT O2 official coaching platform',
        url: 'https://vdoto2.com/',
        kind: 'website',
      },
    ],
  };
}

function hansonsAttr(level: string): PlanAttribution {
  return {
    coach: 'Hansons',
    fidelity: 'method',
    note:
      `Built from the Hansons Marathon Method (${level}): six weekly run days with Wednesday off, SOS (Something of Substance) ` +
      'Tuesday speed-to-strength progressions, Thursday marathon-pace tempos and cumulative fatigue with a 16-mile long-run cap.',
    sources: [
      {
        label: 'Luke Humphrey Running: Hansons Marathon Method',
        url: 'https://lukehumphreyrunning.com/',
        kind: 'website',
      },
    ],
  };
}

/**
 * v1.0.9: plans Apollo designed itself. They follow no coach's published plan,
 * so they say "Designed by Apollo" and cite no coach's book or website.
 */
function apolloLabAttr(note: string, sources: PlanAttribution['sources'] = []): PlanAttribution {
  return { coach: 'Apollo Coaching Lab', fidelity: 'original', note, sources };
}

// ── 1. Hal Higdon Additions ─────────────────────────────────────────────────
//
// v1.0.9: each table below is transcribed cell for cell from the plan's page on
// halhigdon.com (Miles tab), Monday to Sunday. `higdonDay` turns a cell into a
// plan day with the same conventions as Novice 1 / Intermediate 1 / Advanced 1
// in plans.ts. Higdon gives timed sessions in minutes and repeats as counts, so
// their distances (warm-up and cool-down included) are Apollo's estimates.

/** One week of a Higdon table: seven cells, Monday to Sunday. */
type HigdonWeek = readonly [string, string, string, string, string, string, string];

/** Which day carries the week's long run, and how it is written. */
interface HigdonLongRunRule {
  /** 0 = Monday … 6 = Sunday. */
  day: number;
  /** LONG, or LONG_MP for plans aimed at experienced marathoners. */
  build: (miles: number) => PlanDay;
  /** Shorter runs on that day stay ordinary runs. */
  minMiles: number;
}

const HIGDON_RACES: Readonly<Record<string, PlanDay>> = {
  '5-k race': { type: 'race', label: '5K race', distanceMi: 3.1, note: 'Race' },
  '8-k race': { type: 'race', label: '8K race', distanceMi: 5, note: 'Race' },
  '10-k race': { type: 'race', label: '10K race', distanceMi: 6.2, note: 'Race' },
  '15-k race': { type: 'race', label: '15K race', distanceMi: 9.3, note: 'Race' },
  'half marathon': HALF,
  'half marathon race': HALF,
  marathon: MARATHON,
};

/** Miles per repeat (the rep plus an equal jog); 3 mi of warm-up and cool-down are added, as in Advanced 1. */
const HIGDON_REP_MILES: Readonly<Record<string, number>> = { '200': 0.25, '400': 0.375, '800': 0.75 };

/**
 * Higdon fartlek ("speed play"): continuous running with short surges by feel.
 * It has no fixed reps or pace, so it carries the easy note rather than being
 * turned into Apollo's default interval session.
 */
const FARTLEK = (min: number): PlanDay => ({
  type: 'run',
  label: `${min} min fartlek`,
  distanceMi: rHalf(min / 8.5),
  note: 'Easy',
});

/** One published Higdon cell as a plan day. Throws on a cell it doesn't recognize. */
function higdonDay(cell: string, dayIndex: number, longRun: HigdonLongRunRule): PlanDay {
  const c = cell.trim().toLowerCase();
  if (c === 'rest') return REST;
  if (c === 'cross') return CROSS;
  const race = HIGDON_RACES[c];
  if (race) return race;
  let m = /^(\d+(?:\.\d+)?)(?: mi run)?$/.exec(c);
  if (m) {
    const miles = Number(m[1]);
    return dayIndex === longRun.day && miles >= longRun.minMiles ? longRun.build(miles) : MI(miles);
  }
  if ((m = /^(\d+(?:\.\d+)?) mi pace$/.exec(c))) return PACE(Number(m[1]));
  if ((m = /^(\d+)(?: min)? tempo$/.exec(c))) return PROG_TEMPO(Number(m[1]));
  if ((m = /^(\d+) min fartlek$/.exec(c))) return FARTLEK(Number(m[1]));
  if ((m = /^(\d+) min walk$/.exec(c))) return { type: 'cross', label: `${m[1]} min walk` };
  if ((m = /^(\d+) x hill$/.exec(c))) {
    const n = Number(m[1]);
    return SESSION(rHalf(3 + 0.5 * n), `${n} × hill repeats`, 'Speed');
  }
  if ((m = /^(\d+) x (200|400|800)$/.exec(c))) {
    const n = Number(m[1]);
    return SESSION(rHalf(3 + HIGDON_REP_MILES[m[2]] * n), `${n} × ${m[2]} m`, 'Speed');
  }
  throw new Error(`Unrecognized Higdon schedule cell: "${cell}"`);
}

function higdonWeeks(table: readonly HigdonWeek[], longRun: HigdonLongRunRule): PlanWeek[] {
  return table.map((cells, i) => ({
    weekNumber: i + 1,
    days: cells.map((cell, d) => higdonDay(cell, d, longRun)),
  }));
}

/** Novice Supreme, 30 weeks, Mon–Sun, as published on halhigdon.com (Miles tab). */
const HIGDON_NOVICE_SUPREME: readonly HigdonWeek[] = [
  ['Rest', '1.5 mi run', '3 mi run', '1.5 mi run', 'Rest', '3 mi run', '30 min walk'], // 1
  ['Rest', '1.5 mi run', '3 mi run', '1.5 mi run', 'Rest', '3.5 mi run', '35 min walk'], // 2
  ['Rest', '1.5 mi run', '3 mi run', '1.5 mi run', 'Rest', '3 mi run', '40 min walk'], // 3
  ['Rest', '2 mi run', '3 mi run', '1.5 mi run', 'Rest', '4 mi run', '30 min walk'], // 4
  ['Rest', '2 mi run', '3 mi run', '2 mi run', 'Rest', '3 mi run', '45 min walk'], // 5
  ['Rest', '2 mi run', '3 mi run', '2 mi run', 'Rest', '4.5 mi run', '30 min walk'], // 6
  ['Rest', '2 mi run', '3 mi run', '2 mi run', 'Rest', '3 mi run', '50 min walk'], // 7
  ['Rest', '2 mi run', '3 mi run', '2 mi run', 'Rest', '5 mi run', '30 min walk'], // 8
  ['Rest', '2 mi run', '3 mi run', '2.5 mi run', 'Rest', '3 mi run', '55 min walk'], // 9
  ['Rest', '2 mi run', '3 mi run', '2.5 mi run', 'Rest', '5.5 mi run', '30 min walk'], // 10
  ['Rest', '3 mi run', '3 mi run', '3 mi run', 'Rest', '3 mi run', '60 min walk'], // 11
  ['Rest', '3 mi run', '3 mi run', '3 mi run', 'Rest', '6 mi run', '30 min walk'], // 12
  ['Rest', '3 mi run', '3 mi run', '3 mi run', 'Rest', '6 mi run', 'Cross'], // 13
  ['Rest', '3 mi run', '3 mi run', '3 mi run', 'Rest', '7 mi run', 'Cross'], // 14
  ['Rest', '3 mi run', '4 mi run', '3 mi run', 'Rest', '5 mi run', 'Cross'], // 15
  ['Rest', '3 mi run', '4 mi run', '3 mi run', 'Rest', '9 mi run', 'Cross'], // 16
  ['Rest', '3 mi run', '5 mi run', '3 mi run', 'Rest', '10 mi run', 'Cross'], // 17
  ['Rest', '3 mi run', '5 mi run', '3 mi run', 'Rest', '7 mi run', 'Cross'], // 18
  ['Rest', '3 mi run', '6 mi run', '3 mi run', 'Rest', '12 mi run', 'Cross'], // 19
  ['Rest', '3 mi run', '6 mi run', '3 mi run', 'Rest', '13 mi run', 'Cross'], // 20
  ['Rest', '3 mi run', '7 mi run', '4 mi run', 'Rest', '10 mi run', 'Cross'], // 21
  ['Rest', '3 mi run', '7 mi run', '4 mi run', 'Rest', '15 mi run', 'Cross'], // 22
  ['Rest', '4 mi run', '8 mi run', '4 mi run', 'Rest', '16 mi run', 'Cross'], // 23
  ['Rest', '4 mi run', '8 mi run', '5 mi run', 'Rest', '12 mi run', 'Cross'], // 24
  ['Rest', '4 mi run', '9 mi run', '5 mi run', 'Rest', '18 mi run', 'Cross'], // 25
  ['Rest', '5 mi run', '9 mi run', '5 mi run', 'Rest', '14 mi run', 'Cross'], // 26
  ['Rest', '5 mi run', '10 mi run', '5 mi run', 'Rest', '20 mi run', 'Cross'], // 27
  ['Rest', '5 mi run', '8 mi run', '4 mi run', 'Rest', '12 mi run', 'Cross'], // 28
  ['Rest', '4 mi run', '6 mi run', '3 mi run', 'Rest', '8 mi run', 'Cross'], // 29
  ['Rest', '3 mi run', '4 mi run', '2 mi run', 'Rest', 'Rest', 'Marathon'], // 30
];

/** Personal Best, 30 weeks, Mon–Sun, as published on halhigdon.com (Miles tab). */
const HIGDON_PERSONAL_BEST: readonly HigdonWeek[] = [
  ['3 mi run', '3 mi run', '3 x hill', '3 mi run', 'Rest', '30 min tempo', '6 mi run'], // 1
  ['3 mi run', '3 mi run', '3 x hill', '3 mi run', 'Rest', '30 min fartlek', '7 mi run'], // 2
  ['3 mi run', '4 mi run', '4 x hill', '3 mi run', 'Rest', '35 min tempo', '6 mi run'], // 3
  ['3 mi run', '4 mi run', '4 x hill', '3 mi run', 'Rest', '35 min fartlek', '7 mi run'], // 4
  ['3 mi run', '5 mi run', '5 x hill', '3 mi run', 'Rest', '35 min tempo', '8 mi run'], // 5
  ['3 mi run', '5 mi run', '5 x hill', '3 mi run', 'Rest', 'Rest', '5-K Race'], // 6
  ['3 mi run', '4 mi run', '8 x 200', '3 mi run', 'Rest', '40 min fartlek', '7 mi run'], // 7
  ['3 mi run', '5 mi run', '6 x 400', '3 mi run', 'Rest', '40 min tempo', '8 mi run'], // 8
  ['3 mi run', '6 mi run', '10 x 200', '3 mi run', 'Rest', 'Rest', '8-K Race'], // 9
  ['3 mi run', '4 mi run', '7 x 400', '3 mi run', 'Rest', '45 min fartlek', '7 mi run'], // 10
  ['3 mi run', '5 mi run', '12 x 200', '3 mi run', 'Rest', '45 min tempo', '6 mi run'], // 11
  ['3 mi run', '6 mi run', '8 x 400', '3 mi run', 'Rest', 'Rest', '10-K Race'], // 12
  ['Cross', '3 mi run', '5 mi run', '3 mi run', 'Rest', '5 mi pace', '8 mi run'], // 13
  ['Cross', '3 mi run', '5 mi run', '3 mi run', 'Rest', '3 mi run', '9 mi run'], // 14
  ['Cross', '3 mi run', '5 mi run', '3 mi run', 'Rest', '5 mi pace', '6 mi run'], // 15
  ['Cross', '3 mi run', '6 mi run', '3 mi run', 'Rest', '6 mi pace', '11 mi run'], // 16
  ['Cross', '3 mi run', '6 mi run', '3 mi run', 'Rest', '6 mi run', '12 mi run'], // 17
  ['Cross', '3 mi run', '5 mi run', '3 mi run', 'Rest', 'Rest', '15-K Race'], // 18
  ['Cross', '4 mi run', '7 mi run', '4 mi run', 'Rest', '7 mi run', '14 mi run'], // 19
  ['Cross', '4 mi run', '7 mi run', '4 mi run', 'Rest', '7 mi pace', '15 mi run'], // 20
  ['Cross', '4 mi run', '5 mi run', '4 mi run', 'Rest', '8 mi pace', '11 mi run'], // 21
  ['Cross', '4 mi run', '8 mi run', '4 mi run', 'Rest', '8 mi run', '17 mi run'], // 22
  ['Cross', '5 mi run', '8 mi run', '5 mi run', 'Rest', '8 mi pace', '18 mi run'], // 23
  ['Cross', '5 mi run', '5 mi run', '5 mi run', 'Rest', 'Rest', 'Half Marathon Race'], // 24
  ['Cross', '5 mi run', '8 mi run', '5 mi run', 'Rest', '5 mi pace', '20 mi run'], // 25
  ['Cross', '5 mi run', '5 mi run', '5 mi run', 'Rest', '8 mi run', '12 mi run'], // 26
  ['Cross', '5 mi run', '8 mi run', '5 mi run', 'Rest', '5 mi pace', '20 mi run'], // 27
  ['Cross', '5 mi run', '6 mi run', '5 mi run', 'Rest', '4 mi pace', '12 mi run'], // 28
  ['Cross', '4 mi run', '5 mi run', '4 mi run', 'Rest', '3 mi run', '8 mi run'], // 29
  ['Cross', '4 mi run', '4 mi run', 'Rest', 'Rest', '2 mi run', 'Marathon'], // 30
];

/** Advanced 2, 18 weeks, Mon–Sun, as published on halhigdon.com (Miles tab). */
const HIGDON_ADVANCED_2: readonly HigdonWeek[] = [
  ['3 mi run', '3 x hill', '3 mi run', '30 tempo', 'Rest', '5 mi pace', '10'], // 1
  ['3 mi run', '30 tempo', '3 mi run', '3 mi pace', 'Rest', '5 mi run', '11'], // 2
  ['3 mi run', '4 x 800', '3 mi run', '30 tempo', 'Rest', '6 mi pace', '8'], // 3
  ['3 mi run', '4 x hill', '3 mi run', '35 tempo', 'Rest', '6 mi pace', '13'], // 4
  ['3 mi run', '35 tempo', '3 mi run', '3 mi pace', 'Rest', '7 mi run', '14'], // 5
  ['3 mi run', '5 x 800', '3 mi run', '35 tempo', 'Rest', '7 mi pace', '10'], // 6
  ['3 mi run', '5 x hill', '4 mi run', '40 tempo', 'Rest', '8 mi pace', '16'], // 7
  ['3 mi run', '40 tempo', '4 mi run', '3 mi pace', 'Rest', '8 mi run', '17'], // 8
  ['4 mi run', '6 x 800', '4 mi run', '40 tempo', 'Rest', 'Rest', 'Half Marathon'], // 9
  ['3 mi run', '6 x hill', '4 mi run', '45 tempo', 'Rest', '9 mi pace', '19'], // 10
  ['4 mi run', '45 tempo', '5 mi run', '4 mi pace', 'Rest', '10 mi run', '20'], // 11
  ['4 mi run', '7 x 800', '5 mi run', '45 tempo', 'Rest', '6 mi pace', '12'], // 12
  ['4 mi run', '7 x hill', '5 mi run', '50 tempo', 'Rest', '10 mi pace', '20'], // 13
  ['5 mi run', '45 tempo', '5 mi run', '5 mi pace', 'Rest', '6 mi run', '12'], // 14
  ['5 mi run', '8 x 800', '5 mi run', '40 tempo', 'Rest', '10 mi pace', '20'], // 15
  ['5 mi run', '6 x hill', '5 mi run', '30 tempo', 'Rest', '4 mi pace', '12'], // 16
  ['4 mi run', '30 tempo', '4 mi run', '4 mi pace', 'Rest', '4 mi run', '8'], // 17
  ['3 mi run', '4 x 400', '3 mi run', 'Rest', 'Rest', '2 mi run', 'Marathon'], // 18
];

/** Intermediate 2, 18 weeks, Mon–Sun, as published on halhigdon.com (Miles tab). */
const HIGDON_INTERMEDIATE_2: readonly HigdonWeek[] = [
  ['Cross', '3 mi run', '5 mi run', '3 mi run', 'Rest', '5 mi pace', '10'], // 1
  ['Cross', '3 mi run', '5 mi run', '3 mi run', 'Rest', '5 mi run', '11'], // 2
  ['Cross', '3 mi run', '6 mi run', '3 mi run', 'Rest', '6 mi pace', '8'], // 3
  ['Cross', '3 mi run', '6 mi run', '3 mi run', 'Rest', '6 mi pace', '13'], // 4
  ['Cross', '3 mi run', '7 mi run', '3 mi run', 'Rest', '7 mi run', '14'], // 5
  ['Cross', '3 mi run', '7 mi run', '3 mi run', 'Rest', '7 mi pace', '10'], // 6
  ['Cross', '4 mi run', '8 mi run', '4 mi run', 'Rest', '8 mi pace', '16'], // 7
  ['Cross', '4 mi run', '8 mi run', '4 mi run', 'Rest', '8 mi run', '17'], // 8
  ['Cross', '4 mi run', '9 mi run', '4 mi run', 'Rest', 'Rest', 'Half Marathon'], // 9
  ['Cross', '4 mi run', '9 mi run', '4 mi run', 'Rest', '9 mi pace', '19'], // 10
  ['Cross', '5 mi run', '10 mi run', '5 mi run', 'Rest', '10 mi run', '20'], // 11
  ['Cross', '5 mi run', '6 mi run', '5 mi run', 'Rest', '6 mi pace', '12'], // 12
  ['Cross', '5 mi run', '10 mi run', '5 mi run', 'Rest', '10 mi pace', '20'], // 13
  ['Cross', '5 mi run', '6 mi run', '5 mi run', 'Rest', '6 mi run', '12'], // 14
  ['Cross', '5 mi run', '10 mi run', '5 mi run', 'Rest', '10 mi pace', '20'], // 15
  ['Cross', '5 mi run', '8 mi run', '5 mi run', 'Rest', '4 mi pace', '12'], // 16
  ['Cross', '4 mi run', '6 mi run', '4 mi run', 'Rest', '4 mi run', '8'], // 17
  ['Cross', '3 mi run', '4 mi run', 'Rest', 'Rest', '2 mi run', 'Marathon'], // 18
];

function buildHigdonNoviceSupreme(): TrainingPlan {
  return {
    id: 'hal-higdon-novice-supreme',
    name: 'Novice Supreme (30-Week)',
    author: 'Hal Higdon',
    description:
      'Based on Hal Higdon’s 30-week Novice Supreme for new runners: his 12-week novice base program (short runs, a Saturday long run that builds from 3 to 6 miles and Sunday walks), then the 18-week Novice 1 marathon schedule with long runs to 20 miles.',
    totalWeeks: 30,
    weeks: higdonWeeks(HIGDON_NOVICE_SUPREME, { day: 5, build: LONG, minMiles: 0 }),
    tier: 'beginner',
    category: 'first-marathon',
    tags: ['30-week', 'couch-to-marathon', 'walk-days', 'cross-training'],
    attribution: higdonAttr('Novice Supreme', 'novice-supreme'),
  };
}

function buildHigdonIntermediate2(): TrainingPlan {
  return {
    id: 'hal-higdon-intermediate-2',
    name: 'Intermediate 2',
    author: 'Hal Higdon',
    description:
      'Based on Hal Higdon’s Intermediate 2: five run days with cross-training on Monday, a Saturday run (often at marathon pace) before the Sunday long run, a half-marathon tune-up and three 20-mile long runs.',
    totalWeeks: 18,
    weeks: higdonWeeks(HIGDON_INTERMEDIATE_2, { day: 6, build: LONG_MP, minMiles: 8 }),
    halfMarathonWeek: 8,
    tier: 'intermediate',
    category: 'classic-build',
    tags: ['5-days', 'three-20-milers', 'pace-runs'],
    attribution: higdonAttr('Intermediate 2', 'intermediate-2-marathon'),
  };
}

function buildHigdonAdvanced2(): TrainingPlan {
  return {
    id: 'hal-higdon-advanced-2',
    name: 'Advanced 2',
    author: 'Hal Higdon',
    description:
      'Based on Hal Higdon’s Advanced 2 for experienced marathoners: six run days with Tuesday hills, tempo runs or 800s, a Thursday tempo or pace run, Saturday runs mostly at marathon pace, a half-marathon tune-up and three 20-mile long runs.',
    totalWeeks: 18,
    weeks: higdonWeeks(HIGDON_ADVANCED_2, { day: 6, build: LONG_MP, minMiles: 8 }),
    halfMarathonWeek: 8,
    tier: 'advanced',
    category: 'classic-build',
    tags: ['6-days', 'two-quality', 'three-20-milers'],
    attribution: higdonAttr('Advanced 2', 'advanced-2-marathon'),
  };
}

function buildHigdonPersonalBest(): TrainingPlan {
  return {
    id: 'hal-higdon-personal-best',
    name: 'Personal Best (30-Week)',
    author: 'Hal Higdon',
    description:
      'Based on Hal Higdon’s 30-week Personal Best for runners with two or more marathons behind them: 12 weeks of base and speed (hills, 200s and 400s, tempo runs, fartlek and 5K, 8K and 10K tune-up races), then 18 weeks of marathon build with Saturday pace runs, 15K and half-marathon tune-ups and long runs to 20 miles.',
    totalWeeks: 30,
    weeks: higdonWeeks(HIGDON_PERSONAL_BEST, { day: 6, build: LONG, minMiles: 6 }),
    halfMarathonWeek: 23,
    tier: 'intermediate',
    category: 'classic-build',
    tags: ['30-week', 'pr-focused', 'tune-up-races', 'speedwork'],
    attribution: higdonAttr('Personal Best', 'personal-best'),
  };
}

// ── 2. Pete Pfitzinger Method Family ────────────────────────────────────────

function buildPfitz1255(): TrainingPlan {
  // 12 weeks peaking at 55 mpw, 5 run days
  const targets = [37, 41, 45, 39, 49, 53, 45, 55, 52, 43, 32];
  const longs = [13, 15, 16, 13, 18, 20, 0, 20, 17, 16, 12];
  const weeks: PlanWeek[] = targets.map((t, i) => {
    if (i === 6) {
      return {
        weekNumber: 7,
        days: [REST, EASY(7), MLR(10), REC(5), REST, EASY(4), HALF],
      };
    }
    const long = longs[i];
    const mlr = Math.min(13, Math.round(t * 0.24));
    const qual =
      i < 4
        ? CONT_TEMPO(8, '8 mi lactate threshold')
        : i < 8
          ? SESSION(8, '5 × 1 km intervals', 'Speed')
          : CONT_TEMPO(7, '7 mi lactate threshold');
    const sunDay = i === 1 || i === 4 ? MP_WORK(long, i === 1 ? 8 : 10) : LONG_MP(long);
    // Keep note 'Long' on peak longest weeks (20 mi); MP_WORK is used only on 15 & 18 mi weeks!
    const rem = Math.max(6, t - long - mlr - 8);
    const e1 = Math.round(rem * 0.55);
    const r1 = Math.max(3, rem - e1);
    return {
      weekNumber: i + 1,
      days: [REST, qual, MLR(mlr), REC(r1), REST, EASY(e1), i === 1 || i === 4 ? LONG_MP(long) : sunDay],
    };
  });
  // Inject MP into Saturday of weeks 2 & 5 while keeping Sunday note === 'Long'
  weeks[1].days[5] = MP_WORK(8, 5);
  weeks[4].days[5] = MP_WORK(9, 6);
  weeks.push({
    weekNumber: 12,
    days: [REST, EASY(5), MP_WORK(5, 2), REC(4), REST, EASY(4, '4 mi easy + strides'), MARATHON],
  });
  return {
    id: 'pfitzinger-12-55',
    name: '12/55 Method',
    author: 'Pete Pfitzinger',
    description:
      'Based on Pete Pfitzinger’s 12-week, 55-mpw compressed marathon block for runners entering with a solid base. Threshold runs, medium-long runs and two 20-milers.',
    totalWeeks: 12,
    weeks,
    halfMarathonWeek: 6,
    tier: 'advanced',
    category: 'classic-build',
    tags: ['12-week', '5-days', 'medium-long-runs'],
    attribution: pfitzAttr('12/55'),
  };
}

function buildPfitz1270(): TrainingPlan {
  // 12 weeks peaking at 70 mpw, 6 run days + Friday PM recovery double on peak weeks
  const targets = [52, 56, 61, 54, 65, 68, 58, 70, 64, 54, 42];
  const longs = [15, 16, 18, 14, 20, 21, 16, 20, 17, 16, 12];
  const weeks: PlanWeek[] = targets.map((t, i) => {
    const long = longs[i];
    const hasDouble = t >= 64;
    const pm = hasDouble ? 4 : 0;
    const mlr = Math.min(15, Math.round(t * 0.21));
    const tue =
      i === 6
        ? TEN_K
        : i < 5
          ? CONT_TEMPO(9, '9 mi threshold')
          : i < 9
            ? SESSION(9, '6 × 1 km intervals', 'Speed')
            : CONT_TEMPO(8, '8 mi threshold');
    const tueMi = tue.distanceMi ?? 8;
    const sat = i === 2 || i === 5 || i === 8 ? MP_WORK(10, 7) : EASY(7);
    const satMi = sat.distanceMi ?? 7;
    const rem = Math.max(8, rHalf(t - long - mlr - tueMi - satMi - pm));
    const thu = Math.max(5, Math.round(rem * 0.55));
    const fri = Math.max(4, rHalf(rem - thu));
    return {
      weekNumber: i + 1,
      days: [REST, tue, MLR(mlr), EASY(thu), REC(fri, pm), sat, LONG_MP(long)],
    };
  });
  weeks.push({
    weekNumber: 12,
    days: [REST, EASY(6), MP_WORK(6, 2), REC(5), REC(4), EASY(4, '4 mi easy + strides'), MARATHON],
  });
  return {
    id: 'pfitzinger-12-70',
    name: '12/70 Method',
    author: 'Pete Pfitzinger',
    description:
      'Based on Pete Pfitzinger’s 12-week, 70-mpw marathon method with midweek medium-long runs up to 15 miles, a few PM recovery runs in the biggest weeks and a 21-mile peak long run.',
    totalWeeks: 12,
    weeks,
    tier: 'advanced',
    category: 'high-volume',
    hasDoubles: true,
    tags: ['12-week', '6-days', 'doubles', '70-mpw'],
    attribution: pfitzAttr('12/70'),
  };
}

function buildPfitz1870(): TrainingPlan {
  // 18 weeks peaking at 70 mpw, 6 run days + AM/PM recovery doubles on 64+ mpw weeks
  const targets = [52, 55, 58, 52, 61, 64, 67, 58, 63, 68, 60, 70, 66, 70, 68, 56, 44];
  const longs = [14, 15, 16, 14, 17, 18, 20, 15, 18, 21, 16, 22, 18, 20, 20, 16, 12];
  const weeks: PlanWeek[] = targets.map((t, i) => {
    const long = longs[i];
    const pm = t >= 64 ? 4 : 0;
    const mlr1 = Math.min(15, Math.round(t * 0.21));
    const mlr2 = Math.min(12, Math.round(t * 0.16));
    const tue =
      i < 6
        ? CONT_TEMPO(9, '9 mi threshold')
        : i < 11
          ? CONT_TEMPO(10, '10 mi threshold')
          : i < 15
            ? SESSION(9, '5 × 1200 m intervals', 'Speed')
            : CONT_TEMPO(8, '8 mi threshold');
    const sat = i === 8 ? TEN_K : i === 3 || i === 7 || i === 12 ? MP_WORK(9, 6) : REC(6);
    const satMi = sat.distanceMi ?? 6;
    const tueMi = tue.distanceMi ?? 9;
    const fri = Math.max(4, t - long - mlr1 - mlr2 - tueMi - satMi - pm);
    return {
      weekNumber: i + 1,
      days: [REST, tue, MLR(mlr1), MLR(mlr2), REC(fri, pm), sat, LONG_MP(long)],
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [REST, EASY(7), MP_WORK(6, 2), REC(5), REC(4), EASY(4, '4 mi easy + strides'), MARATHON],
  });
  return {
    id: 'pfitzinger-18-70',
    name: '18/70 Method (Doubles)',
    author: 'Pete Pfitzinger',
    description:
      'Based on Pete Pfitzinger’s iconic 18-week, 70-mpw marathon method: twin medium-long runs, threshold progressions, VO₂max intervals, PM doubles and long runs to 22 miles.',
    totalWeeks: 18,
    weeks,
    tier: 'advanced',
    category: 'high-volume',
    hasDoubles: true,
    tags: ['18-week', '6-days', 'doubles', '70-mpw', 'bq-favorite'],
    attribution: pfitzAttr('18/70'),
  };
}

function buildPfitz1885(): TrainingPlan {
  // 18 weeks peaking at 85 mpw, 6-7 run days + AM/PM doubles on Tuesday & Friday
  const targets = [64, 68, 72, 65, 75, 78, 81, 72, 78, 83, 74, 85, 80, 85, 82, 68, 52];
  const longs = [16, 17, 18, 15, 18, 20, 21, 16, 20, 22, 17, 22, 18, 22, 20, 17, 13];
  const weeks: PlanWeek[] = targets.map((t, i) => {
    const long = longs[i];
    const pm1 = t >= 74 ? 4 : 0;
    const pm2 = t >= 80 ? 4 : 0;
    const mlr1 = Math.min(15, Math.round(t * 0.18));
    const tue =
      i < 10
        ? CONT_TEMPO(10, '10 mi threshold', pm1)
        : i < 15
          ? SESSION(10, '6 × 1200 m intervals', 'Speed', pm1)
          : CONT_TEMPO(8, '8 mi threshold');
    const sat = i === 8 ? TEN_K : i % 3 === 1 ? MP_WORK(10, 7) : EASY(7);
    const mon = REC(6);
    // Size the second medium-long run so the week lands on its target (Friday keeps >= 5 mi).
    const base = 6 + (tue.distanceMi ?? 10) + pm1 + mlr1 + (sat.distanceMi ?? 7) + long + pm2;
    const mlr2 = Math.max(8, Math.min(13, Math.round(t * 0.15), Math.floor(t - base - 5)));
    const fri = Math.max(5, rHalf(t - base - mlr2));
    return {
      weekNumber: i + 1,
      days: [mon, tue, MLR(mlr1), MLR(mlr2), REC(fri, pm2), sat, LONG_MP(long)],
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [REC(5), EASY(7), MP_WORK(6, 2), REC(5), REST, EASY(4, '4 mi easy + strides'), MARATHON],
  });
  return {
    id: 'pfitzinger-18-85',
    name: '18/85 Elite Method (Doubles)',
    author: 'Pete Pfitzinger',
    description:
      'Based on Pete Pfitzinger’s high-mileage 18-week, 85-mpw schedule for sub-2:50 and elite marathoners, featuring 7-day aerobic volume, twice-weekly doubles and three 22-mile long runs.',
    totalWeeks: 18,
    weeks,
    tier: 'elite',
    category: 'high-volume',
    hasDoubles: true,
    tags: ['18-week', '7-days', 'doubles', '85-mpw', 'sub-3'],
    attribution: pfitzAttr('18/85'),
  };
}

function buildPfitzMulti12(): TrainingPlan {
  // 12 weeks between marathons: 3w recovery reverse-taper -> 6w rebuild -> 3w taper
  const rows: [number, number, number, number, number][] = [
    // [tue, wed, thu, sat, sunLong]
    [0, 4, 4, 4, 7],
    [4, 5, 4, 5, 10],
    [5, 6, 5, 5, 12],
    [6, 8, 5, 6, 14],
    [7, 10, 5, 6, 16],
    [8, 11, 5, 7, 17],
    [7, 9, 5, 6, 14],
    [8, 12, 6, 7, 19],
    [8, 11, 6, 7, 18],
    [7, 9, 5, 5, 15],
    [6, 7, 4, 4, 11],
  ];
  const weeks: PlanWeek[] = rows.map(([tue, wed, thu, sat, sun], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      tue === 0 ? REST : i >= 4 && i <= 8 ? CONT_TEMPO(tue, `${tue} mi threshold`) : EASY(tue),
      wed >= 9 ? MLR(wed) : REC(wed),
      REC(thu),
      REST,
      i === 5 || i === 8 ? MP_WORK(sat, sat - 2) : EASY(sat),
      LONG_MP(sun),
    ],
  }));
  weeks.push({
    weekNumber: 12,
    days: [REST, EASY(5), MP_WORK(5, 2), REC(4), REST, EASY(3, '3 mi easy + strides'), MARATHON],
  });
  return {
    id: 'pfitzinger-multi-12',
    name: 'Multiple Marathoning (12-Week)',
    author: 'Pete Pfitzinger',
    description:
      'Based on Pete Pfitzinger’s 12-week Multiple Marathoning bridge: 3 weeks of post-race recovery, 6 weeks of targeted threshold and endurance rebuilding, then a 3-week taper.',
    totalWeeks: 12,
    weeks,
    tier: 'advanced',
    category: 'multi-marathon',
    tags: ['12-week', 'back-to-back', 'recovery-bridge'],
    attribution: pfitzAttr(
      'Multiple Marathoning 12-Week',
      'Built from the multiple-marathoning guidance in Pete Pfitzinger’s Advanced Marathoning for races 12 weeks apart: recovery first, a short rebuild with threshold runs and long runs, then a taper. Not a verbatim table copy; see the book for the full schedules.',
    ),
  };
}

function buildApolloMulti8(): TrainingPlan {
  // 8-week bridge between marathons 8 weeks apart
  const rows: [number, number, number, number, number][] = [
    [0, 4, 4, 4, 6],
    [4, 5, 4, 5, 10],
    [6, 8, 5, 6, 13],
    [7, 10, 5, 6, 16],
    [8, 11, 5, 7, 17],
    [6, 8, 5, 5, 13],
    [5, 6, 4, 4, 10],
  ];
  const weeks: PlanWeek[] = rows.map(([tue, wed, thu, sat, sun], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      tue === 0 ? REST : i === 3 || i === 4 ? CONT_TEMPO(tue, `${tue} mi threshold`) : EASY(tue),
      wed >= 8 ? MLR(wed) : REC(wed),
      REC(thu),
      REST,
      i === 4 ? MP_WORK(sat, 4) : EASY(sat),
      LONG_MP(sun),
    ],
  }));
  weeks.push({
    weekNumber: 8,
    days: [REST, EASY(5), MP_WORK(5, 2), REC(3), REST, EASY(3, '3 mi easy + strides'), MARATHON],
  });
  return {
    id: 'apollo-multi-8',
    name: 'Multiple Marathoning (8-Week)',
    author: 'Pete Pfitzinger',
    description:
      'Based on Pete Pfitzinger’s 8-week Multiple Marathoning bridge for marathons two months apart: structured recovery first, two sharpeners up to 17 miles and a crisp taper.',
    totalWeeks: 8,
    weeks,
    tier: 'advanced',
    category: 'multi-marathon',
    tags: ['8-week', 'back-to-back', 'recovery-bridge'],
    attribution: pfitzAttr(
      'Multiple Marathoning 8-Week',
      'Built from the multiple-marathoning guidance in Pete Pfitzinger’s Advanced Marathoning for races 8 weeks apart: recovery first, two weeks of threshold work and long runs up to 17 miles, then a short taper. Not a verbatim table copy; see the book for the full schedules.',
    ),
  };
}

// ── 3. Jack Daniels 2Q Method Family ────────────────────────────────────────

function buildDaniels2Q(
  id: string,
  name: string,
  peakMi: number,
  runDaysCount: 5 | 6 | 7,
  tier: PlanTier,
  withDoubles: boolean,
): TrainingPlan {
  // Daniels 18-week 2Q fractions of peak mileage:
  // weeks 1-16 stay between 0.80 and 1.00 of peak; week 17 = 0.70; week 18 = race week
  const fracs = [0.8, 0.85, 0.9, 0.85, 0.9, 0.95, 1.0, 0.85, 0.95, 1.0, 0.9, 1.0, 0.95, 1.0, 0.9, 0.8, 0.65];
  // Long runs: Daniels caps L at about 150 minutes; for the up-to-40 mpw plan that is ~15 mi at easy pace.
  const maxLong = peakMi <= 42 ? 15 : peakMi <= 56 ? 19 : peakMi <= 72 ? 20 : 22;
  const weeks: PlanWeek[] = fracs.map((f, i) => {
    const target = Math.round(peakMi * f);
    const isPeakLong = i === 6 || i === 9 || i === 11 || i === 13;
    const q1Long = isPeakLong
      ? maxLong
      : i === 16
        ? Math.min(12, Math.round(maxLong * 0.6))
        : i === 15
          ? // Two weeks before race week: no 18+ mi run this close to the race.
            Math.min(16, Math.max(12, Math.min(maxLong - 2, Math.round(target * 0.3))))
          : Math.max(12, Math.min(maxLong - 2, Math.round(target * 0.3)));

    // Q2 midweek session rotates Daniels T cruise intervals, I intervals (Speed) and an MP block.
    const q2Dist = Math.min(12, Math.max(6, Math.round(target * 0.2)));
    // Daniels: T-pace running in one session stays at or under ~10% of the week's mileage
    // (1-mile reps, 1-minute rests); the rest of the day is easy warm-up and cool-down.
    // Today and the watch keep this rep count (workoutTargets: plan-named cruise intervals).
    const cruiseReps = Math.max(2, Math.min(6, Math.floor(target * 0.1)));
    const q2: PlanDay =
      i % 3 === 0
        ? SESSION(q2Dist, `${cruiseReps} × 1 mi cruise intervals (T pace)`, 'Tempo')
        : i % 3 === 1
          ? SESSION(q2Dist, '5 × 1 km intervals', 'Speed')
          : MP_WORK(q2Dist, Math.max(4, q2Dist - 3));

    const pm = withDoubles && target >= 66 ? 4 : 0;
    const rem = Math.max(6, target - q1Long - q2Dist - pm);
    const easySlots = runDaysCount - 2;
    const baseEasy = Math.max(3, Math.floor(rem / easySlots));
    const extra = rem - baseEasy * easySlots;

    const days: PlanDay[] = [REST, REST, REST, REST, REST, REST, LONG_MP(q1Long)];
    // Place Q2 on Wednesday (index 2)
    days[2] = q2;
    const slotIndices = runDaysCount === 5 ? [1, 3, 5] : runDaysCount === 6 ? [0, 1, 4, 5] : [0, 1, 3, 4, 5];
    slotIndices.forEach((dIdx, idx) => {
      const dist = baseEasy + (idx < extra ? 1 : 0);
      days[dIdx] = idx === slotIndices.length - 2 && pm > 0 ? REC(dist, pm) : EASY(dist);
    });
    return { weekNumber: i + 1, days };
  });

  const raceEasy = peakMi >= 70 ? 5 : 4;
  weeks.push({
    weekNumber: 18,
    days: [
      runDaysCount === 7 ? REC(4) : REST,
      EASY(raceEasy),
      CONT_TEMPO(5, '5 mi lactate threshold'),
      REC(raceEasy - 1),
      runDaysCount >= 6 ? REC(3) : REST,
      EASY(3, '3 mi shakeout + strides'),
      MARATHON,
    ],
  });

  return {
    id,
    name,
    author: 'Jack Daniels',
    description:
      `Based on Jack Daniels’ 2Q marathon method peaking at ${peakMi} mpw: two weekly quality workouts (Q1 endurance/MP long run and Q2 threshold cruise intervals, I intervals or an MP block) framed by easy E-pace volume` +
      (peakMi <= 42 ? ', with long runs kept to about 2½ hours.' : '.'),
    totalWeeks: 18,
    weeks,
    tier,
    category: peakMi >= 68 ? 'high-volume' : 'classic-build',
    hasDoubles: withDoubles,
    tags: ['2Q', `${runDaysCount}-days`, `${peakMi}-mpw`, ...(withDoubles ? ['doubles'] : [])],
    attribution: danielsAttr(`up to ${peakMi} mpw`),
  };
}

// ── 4. Hansons Additions ────────────────────────────────────────────────────

function buildHansonsJustFinish(): TrainingPlan {
  // 18 weeks, 5 run days (Mon/Wed off), long run capped at 16 mi
  const longs = [4, 5, 6, 7, 8, 9, 10, 10, 12, 10, 14, 12, 15, 12, 16, 12, 8];
  const weeks: PlanWeek[] = longs.map((sun, w) => {
    const e = w < 5 ? 3 : w < 11 ? 4 : w < 16 ? 5 : 4;
    const mp = w === 16 ? 5 : Math.min(8, 4 + Math.floor((w - 6) / 2));
    const thu = w < 6 ? EASY(e + 1) : MP_WORK(mp + 2, mp);
    return {
      weekNumber: w + 1,
      days: [REST, EASY(e + 1), REST, thu, EASY(e), EASY(e), LONG(sun)],
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [REST, EASY(4), REST, EASY(4), EASY(3), EASY(2, '2 mi shakeout'), MARATHON],
  });
  return {
    id: 'hansons-just-finish',
    name: 'Just Finish',
    author: 'Hansons',
    description:
      'Based on the Hansons Just Finish program: five manageable run days per week, cumulative aerobic endurance, gentle marathon-pace Thursdays and a 16-mile long-run cap.',
    totalWeeks: 18,
    weeks,
    tier: 'beginner',
    category: 'first-marathon',
    tags: ['5-days', '16-mi-cap', 'first-timers'],
    attribution: hansonsAttr('Just Finish'),
  };
}

function buildHansonsAdvanced(): TrainingPlan {
  // 18 weeks, 6 run days from week 1 (Wed rest), immediate Tuesday SOS (Speed w1-9, Strength w10-17) + Thu MP up to 10 mi, 16 mi cap, peaks ~63 mpw
  const speed = [
    '12 × 400 m',
    '8 × 600 m',
    '6 × 800 m',
    '5 × 1 km',
    '4 × 1200 m',
    '3 × 1600 m',
    '6 × 800 m',
    '5 × 1 km',
    '4 × 1200 m',
  ];
  const strength = ['6 × 1 mi', '4 × 1.5 mi', '3 × 2 mi', '2 × 3 mi', '3 × 2 mi', '4 × 1.5 mi', '3 × 2 mi', '6 × 1 mi'];
  const mpMiles = [5, 6, 6, 7, 7, 8, 8, 8, 9, 9, 9, 10, 10, 10, 10, 10, 6];
  const longs = [8, 10, 10, 12, 10, 14, 12, 15, 10, 16, 10, 16, 10, 16, 10, 16, 8];
  const weeks: PlanWeek[] = longs.map((sun, w) => {
    const e = w < 4 ? 5 : w < 9 ? 6 : w < 16 ? 7 : 5;
    const tue =
      w < 9 ? SESSION(7, `${speed[w]} speed`, 'Speed') : SESSION(9, `${strength[w - 9]} strength`, 'Strength');
    const mp = mpMiles[w];
    const thu = MP_WORK(mp + 3, mp);
    return {
      weekNumber: w + 1,
      days: [EASY(e), tue, REST, thu, EASY(e - 1), EASY(e + 1), LONG_MP(sun)],
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [EASY(5), EASY(5), REST, MP_WORK(5, 3), EASY(4), EASY(3, '3 mi easy + strides'), MARATHON],
  });
  return {
    id: 'hansons-advanced',
    name: 'Advanced',
    author: 'Hansons',
    description:
      'Based on the Hansons Advanced Marathon program: six weekly run days starting immediately with speed and marathon-pace SOS sessions, building to strength intervals and three 16-mile long runs on tired legs, with mileage peaking near 60 mpw.',
    totalWeeks: 18,
    weeks,
    tier: 'advanced',
    category: 'classic-build',
    tags: ['6-days', '16-mi-cap', 'cumulative-fatigue'],
    attribution: hansonsAttr('Advanced'),
  };
}

// ── 5. Run-Walk & Specialty Methodologies ───────────────────────────────────

function buildGallowayRunWalk(): TrainingPlan {
  // 20 weeks, 3 run days (Tue/Thu 30-45 min, Sun alternating biweekly long run up to 20 mi + easy walk/run cutback)
  const longs = [6, 8, 6, 10, 7, 12, 8, 14, 8, 16, 8, 18, 9, 19, 9, 20, 10, 12, 8];
  const weeks: PlanWeek[] = longs.map((sun, i) => {
    const mid = i < 6 ? 3 : i < 16 ? 4 : 3;
    return {
      weekNumber: i + 1,
      days: [
        REST,
        { ...EASY(mid, `${mid} mi run-walk`), durationMin: mid * 11, runWalkRatio: '4 min run / 1 min walk' },
        CROSS,
        { ...EASY(mid, `${mid} mi run-walk`), durationMin: mid * 11, runWalkRatio: '4 min run / 1 min walk' },
        REST,
        CROSS,
        LONG(sun, { durationMin: sun * 12, runWalkRatio: '3 min run / 1 min walk' }),
      ],
    };
  });
  weeks.push({
    weekNumber: 20,
    days: [
      REST,
      { ...EASY(3, '3 mi run-walk'), durationMin: 33, runWalkRatio: '3 min run / 1 min walk' },
      REST,
      { ...EASY(2, '2 mi run-walk'), durationMin: 22, runWalkRatio: '3 min run / 1 min walk' },
      REST,
      REST,
      MARATHON,
    ],
  });
  return {
    id: 'galloway-run-walk',
    name: 'Run-Walk-Run (20-Week)',
    author: 'Jeff Galloway',
    description:
      'Based on Jeff Galloway’s Run-Walk-Run marathon method: three run days per week with planned walk breaks from mile one and biweekly long-run progressions to 20 miles for injury-resistant endurance.',
    totalWeeks: 20,
    weeks,
    tier: 'beginner',
    category: 'time-run-walk',
    isTimeBased: true,
    tags: ['3-days', 'run-walk', 'low-injury-risk'],
    attribution: {
      coach: 'Jeff Galloway',
      fidelity: 'method',
      note: 'Built from Jeff Galloway’s Run-Walk-Run principles: two short weekday maintenance sessions, cross-training and every-other-week long runs with structured walk breaks.',
      sources: [
        {
          label: 'Jeff Galloway official Run-Walk-Run training',
          url: 'https://www.jeffgalloway.com/',
          kind: 'website',
        },
      ],
    },
  };
}

function buildTimeBasedEndurance(): TrainingPlan {
  // 18 weeks, 4 run days designed around duration caps (long run capped at ~3 hours / 16 mi equivalent) for 4:30-6:00 marathoners
  const longs = [7, 8, 9, 7, 10, 11, 12, 9, 13, 14, 11, 15, 16, 12, 16, 12, 8];
  const weeks: PlanWeek[] = longs.map((sun, i) => {
    const tue = i < 6 ? 3.5 : i < 15 ? 4.5 : 3.5;
    const thu = i % 2 === 0 ? PROG_TEMPO(i < 6 ? 25 : i < 15 ? 35 : 25) : EASY(4, '4 mi easy (45 min)');
    const sat = i < 8 ? 3.5 : i < 15 ? 4 : 3;
    return {
      weekNumber: i + 1,
      days: [
        REST,
        { ...EASY(tue, `${tue} mi easy`), durationMin: Math.round(tue * 11) },
        CROSS,
        thu,
        REST,
        { ...EASY(sat, `${sat} mi easy`), durationMin: Math.round(sat * 11) },
        LONG(sun, {
          // The cap is time, not miles: slower runners stop at 3 hours (see the attribution note).
          ...(sun >= 12 ? { label: `${sun} mi long run (max 3 h)` } : {}),
          durationMin: Math.min(180, Math.round(sun * 11.5)),
        }),
      ],
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [REST, EASY(3, '3 mi easy'), REST, EASY(3, '3 mi easy'), REST, EASY(2, '2 mi shakeout'), MARATHON],
  });
  return {
    id: 'apollo-time-based-endurance',
    name: 'Time-on-Feet Endurance (3h Cap)',
    author: 'Apollo Coaching Lab',
    description:
      'Designed by Apollo for runners expecting a 4:30–6:00 marathon: four run days plus cross-training, an every-other-week tempo, and long runs that stop at 3 hours (about 16 miles at an 11:15/mi easy pace), so no training day approaches marathon length.',
    totalWeeks: 18,
    weeks,
    tier: 'beginner',
    category: 'time-run-walk',
    isTimeBased: true,
    tags: ['4-days', 'time-based', '3h-long-run-cap'],
    attribution: apolloLabAttr(
      'Apollo’s own plan, not based on a coach’s published schedule. Long runs are capped by time: if your easy pace is slower than about 11:15/mi, stop at 3 hours even if the planned miles aren’t done.',
    ),
  };
}

function buildNorwegianSubThreshold(): TrainingPlan {
  // 18 weeks peaking ~66 mpw: Tuesday & Thursday controlled sub-threshold intervals, a PM recovery run after
  // most peak-block Tuesday sessions, easy aerobic days and easy long runs to 21 miles.
  const longs = [14, 15, 16, 13, 17, 18, 19, 14, 18, 20, 15, 20, 17, 21, 20, 15, 11];
  const weeks: PlanWeek[] = longs.map((sun, i) => {
    const peakBlock = i >= 5 && i <= 14 && i !== 7 && i !== 10;
    const isTaper = i >= 15;
    // 'Strength' paces between marathon pace and threshold: a sub-threshold effort.
    const tue = SESSION(
      isTaper ? 7 : 9,
      isTaper ? '5 × 1 km sub-threshold' : '6 × 1 km sub-threshold',
      'Strength',
      peakBlock ? 5 : 0,
    );
    const thu = SESSION(isTaper ? 7 : 10, isTaper ? '2 × 2 mi sub-threshold' : '3 × 2 mi sub-threshold', 'Strength');
    const wed = EASY(i < 5 ? 7 : i < 15 ? 9 : i === 15 ? 7 : 5);
    const mon = REC(i < 5 ? 5 : i < 15 ? 6 : 4);
    const sat = i === 4 || i === 8 || i === 12 ? MP_WORK(8, 5) : REC(i < 15 ? 6 : 4);
    return {
      weekNumber: i + 1,
      days: [mon, tue, wed, thu, REST, sat, LONG(sun)],
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [
      REC(4),
      SESSION(6, '4 × 1 km sub-threshold', 'Strength'),
      EASY(5),
      REC(4),
      REST,
      EASY(3, '3 mi shakeout + strides'),
      MARATHON,
    ],
  });
  return {
    id: 'apollo-norwegian-70',
    name: 'Norwegian-Style Sub-Threshold',
    author: 'Apollo Coaching Lab',
    description:
      'Designed by Apollo, inspired by Norwegian-style sub-threshold training: two controlled sessions a week (1 km and 2-mile repeats a little slower than threshold pace), easy days in between, a short PM recovery run after most peak-block Tuesday sessions and easy long runs to 21 miles. Mileage peaks around 66 mpw.',
    totalWeeks: 18,
    weeks,
    tier: 'advanced',
    category: 'threshold-doubles',
    hasDoubles: true,
    tags: ['sub-threshold', 'doubles', '6-days', '66-mpw'],
    attribution: apolloLabAttr(
      'Apollo’s simplified take on Norwegian-style sub-threshold training, not any coach’s published plan. It doesn’t include lactate testing or double-threshold days.',
    ),
  };
}

function buildCanovaSpecific75(): TrainingPlan {
  // 16 weeks peaking ~75 mpw: fundamental (w1-5) -> special (w6-10) -> specific MP block (w11-14) -> taper (w15-16).
  // The last 18+ mi run is in week 13, three weeks before race week.
  const longs = [15, 16, 18, 14, 19, 20, 16, 21, 16, 22, 16, 22, 18, 16, 12];
  const weeks: PlanWeek[] = longs.map((sun, i) => {
    const isSpecific = i >= 8 && i <= 13;
    const isTaper = i === 14;
    const wedQuality: PlanDay = isTaper
      ? MP_WORK(8, 5)
      : i < 5
        ? SESSION(9, '8 × hill repeats', 'Speed')
        : i < 9
          ? CONT_TEMPO(10, '10 mi progressive threshold')
          : MP_WORK(12, 9);
    const satDay = isTaper ? REC(5) : isSpecific && i % 2 === 0 ? REC(6) : i % 2 === 1 ? MP_WORK(9, 6) : EASY(7);
    const pm = i >= 5 && i <= 12 ? 4 : 0;
    const mon = REC(isTaper ? 5 : 6);
    const tue = EASY(isTaper ? 6 : 8, isTaper ? '6 mi easy' : '8 mi easy');
    const thu = REC(isTaper ? 5 : 7, pm);
    const fri = REC(isTaper ? 4 : 6);
    return {
      weekNumber: i + 1,
      days: [mon, tue, wedQuality, thu, fri, satDay, LONG_MP(sun)],
    };
  });
  weeks.push({
    weekNumber: 16,
    days: [REC(5), EASY(6), MP_WORK(6, 3), REC(4), REST, EASY(3, '3 mi shakeout + strides'), MARATHON],
  });
  return {
    id: 'apollo-canova-75',
    name: 'Canova-Style Specific Block 16/75',
    author: 'Apollo Coaching Lab',
    description:
      'Designed by Apollo, inspired by Renato Canova’s funnel periodization: hill repeats and general endurance first, then progressive threshold runs, then a block of long marathon-pace sessions, with easy days and PM recovery runs in between and long runs to 22 miles.',
    totalWeeks: 16,
    weeks,
    tier: 'elite',
    category: 'high-volume',
    hasDoubles: true,
    tags: ['16-week', 'canova-funnel', 'specific-mp', '75-mpw'],
    attribution: apolloLabAttr(
      'Apollo’s simplified take on Canova-style funnel periodization (general endurance narrowing to marathon-specific work), not Renato Canova’s own program.',
    ),
  };
}

function buildBostonQualifier60(): TrainingPlan {
  // 18 weeks peaking ~60 mpw, 6 run days: early hill repeats, rolling threshold runs, medium-long runs and MP Saturdays
  const longs = [13, 14, 15, 12, 16, 17, 18, 14, 0, 20, 16, 20, 17, 21, 20, 15, 11];
  const weeks: PlanWeek[] = longs.map((sun, i) => {
    if (i === 8) {
      return {
        weekNumber: 9,
        days: [REST, EASY(6), MLR(9), REC(5), REST, EASY(4), HALF],
      };
    }
    const tue =
      i < 7
        ? SESSION(8, `${5 + Math.min(3, Math.floor(i / 2))} × hill repeats`, 'Speed')
        : i < 13
          ? CONT_TEMPO(9, '9 mi rolling threshold')
          : SESSION(8, '5 × 1 km intervals', 'Speed');
    const thu = MLR(i < 5 ? 9 : i < 15 ? 11 : 8);
    const sat = i % 3 === 1 && i < 15 ? MP_WORK(8, 5) : REC(5);
    const wed = REC(5);
    const fri = EASY(i < 6 ? 5 : i < 15 ? 6 : 4);
    return {
      weekNumber: i + 1,
      days: [REST, tue, wed, thu, fri, sat, LONG_MP(sun)],
    };
  });
  weeks.push({
    weekNumber: 18,
    days: [REST, EASY(5), MP_WORK(5, 2), REC(4), REST, EASY(3, '3 mi shakeout + strides'), MARATHON],
  });
  return {
    id: 'apollo-bq-60',
    name: 'Boston Qualifier (BQ) 18/60',
    author: 'Apollo Coaching Lab',
    description:
      'Designed by Apollo for runners chasing a Boston qualifying time: early hill repeats, rolling threshold runs, midweek medium-long runs, marathon-pace Saturdays, a half-marathon tune-up and long runs to 21 miles, peaking near 60 mpw.',
    totalWeeks: 18,
    weeks,
    halfMarathonWeek: 8,
    tier: 'advanced',
    category: 'bq-performance',
    tags: ['bq', 'hills', '6-days', '60-mpw'],
    attribution: apolloLabAttr(
      'Apollo’s own plan for a qualifying attempt, not based on a coach’s published schedule. Qualifying standards change, so check the current times on the Boston Athletic Association’s site.',
      [
        {
          label: 'Boston Athletic Association (qualifying standards)',
          url: 'https://www.baa.org/',
          kind: 'website',
        },
      ],
    ),
  };
}

// ── 6. Supplemental Non-Marathon Block Plans (Base & Recovery) ──────────────

function buildBaseBuilder8(): TrainingPlan {
  // 8-week aerobic base builder: 18 -> 34 mpw, 4-5 run days
  const rows: [number, number, number, number, number][] = [
    [3, 4, 0, 3, 6],
    [3, 4, 3, 3, 7],
    [4, 5, 3, 4, 8],
    [3, 4, 3, 3, 6],
    [4, 5, 4, 4, 9],
    [4, 6, 4, 4, 10],
    [5, 6, 4, 5, 11],
    [4, 5, 4, 4, 10],
  ];
  const weeks: PlanWeek[] = rows.map(([tue, wed, thu, sat, sun], i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      EASY(tue, `${tue} mi easy + strides`),
      i >= 4 ? CONT_TEMPO(wed, `${wed} mi aerobic progression`) : EASY(wed),
      thu === 0 ? CROSS : EASY(thu),
      REST,
      EASY(sat),
      LONG(sun),
    ],
  }));
  return {
    id: 'apollo-base-8',
    name: '8-Week Aerobic Base Builder',
    author: 'Apollo Coaching Lab',
    description:
      'Designed by Apollo: 8 weeks building from about 16 to 31 mpw with strides, gentle progression runs and lighter weeks 4 and 8, so you start an 18-week marathon plan rested and ready.',
    totalWeeks: 8,
    weeks,
    tier: 'specialty',
    category: 'base-recovery',
    tags: ['8-week', 'base-building', 'pre-marathon'],
    attribution: apolloLabAttr(
      'Apollo’s own base block, not based on a coach’s published schedule: more running days each week, strides and a gradually longer Sunday run before a full 16–18 week marathon plan.',
    ),
  };
}

function buildBaseBuilder12(): TrainingPlan {
  // 12-week high-aerobic base builder: 26 -> 50 mpw, 5-6 run days
  const targets = [26, 29, 33, 28, 36, 40, 43, 36, 45, 48, 50, 42];
  const longs = [8, 9, 10, 8, 11, 12, 13, 10, 13, 14, 15, 12];
  const weeks: PlanWeek[] = targets.map((t, i) => {
    const long = longs[i];
    const mlr = Math.max(6, Math.round(t * 0.22));
    const tue = i >= 4 ? CONT_TEMPO(6, '6 mi threshold') : SESSION(5, '6 × hill repeats', 'Speed');
    const rem = Math.max(6, t - long - mlr - (tue.distanceMi ?? 6));
    const e1 = Math.round(rem * 0.5);
    const e2 = Math.max(3, rem - e1);
    return {
      weekNumber: i + 1,
      days: [REST, tue, MLR(mlr), REC(e1), REST, EASY(e2, `${e2} mi easy + strides`), LONG(long)],
    };
  });
  return {
    id: 'apollo-base-12',
    name: '12-Week Performance Base (50 mpw)',
    author: 'Apollo Coaching Lab',
    description:
      'Designed by Apollo: 12 weeks building from 26 to 50 mpw with hill repeats, an introduction to threshold runs and midweek medium-long runs, ahead of a higher-mileage marathon plan.',
    totalWeeks: 12,
    weeks,
    tier: 'specialty',
    category: 'base-recovery',
    tags: ['12-week', 'base-building', '50-mpw'],
    attribution: apolloLabAttr(
      'Apollo’s own base block, not based on a coach’s published schedule: it raises weekly mileage gradually, with a cutback every fourth week, before a 55–70 mpw marathon plan.',
    ),
  };
}

function buildPostMarathonRecovery4(): TrainingPlan {
  // 4-week reverse taper post-marathon recovery block
  const weeks: PlanWeek[] = [
    { weekNumber: 1, days: [REST, REST, CROSS, REC(3), REST, REC(3), REC(4)] },
    { weekNumber: 2, days: [REST, REC(4), CROSS, REC(4), REST, EASY(4), EASY(6)] },
    { weekNumber: 3, days: [REST, EASY(4), EASY(5), REC(4), REST, EASY(5, '5 mi easy + strides'), LONG(8)] },
    {
      weekNumber: 4,
      days: [REST, EASY(5), CONT_TEMPO(5, '5 mi gentle tempo'), REC(4), REST, EASY(5, '5 mi easy + strides'), LONG(10)],
    },
  ];
  return {
    id: 'apollo-recovery-4',
    name: '4-Week Post-Marathon Reverse Taper',
    author: 'Apollo Coaching Lab',
    description:
      'Designed by Apollo: four reverse-taper weeks after a marathon, starting with rest, cross-training and short recovery runs and building back to a gentle tempo and a 10-mile long run.',
    totalWeeks: 4,
    weeks,
    tier: 'specialty',
    category: 'base-recovery',
    tags: ['4-week', 'post-race', 'recovery'],
    attribution: apolloLabAttr(
      'Apollo’s own recovery block, not based on a coach’s published schedule. If anything still hurts after the race, rest longer or check with a doctor before following it.',
    ),
  };
}

function buildOffSeasonMaintenance6(): TrainingPlan {
  const weeks: PlanWeek[] = Array.from({ length: 6 }, (_, i) => ({
    weekNumber: i + 1,
    days: [
      REST,
      i % 2 === 0 ? CONT_TEMPO(6, '6 mi tempo') : SESSION(6, '6 × 800 m', 'Speed'),
      EASY(5),
      REC(4),
      REST,
      EASY(5, '5 mi easy + strides'),
      LONG(i === 3 ? 9 : 11 + (i % 2)),
    ],
  }));
  return {
    id: 'apollo-maintenance-6',
    name: '6-Week Off-Season Maintenance',
    author: 'Apollo Coaching Lab',
    description:
      'Designed by Apollo: six steady weeks of about 31 mpw between training cycles, with one tempo or 800 m session a week, easy runs with strides and a 9–12 mile long run.',
    totalWeeks: 6,
    weeks,
    tier: 'specialty',
    category: 'base-recovery',
    tags: ['6-week', 'maintenance', 'off-season'],
    attribution: apolloLabAttr(
      'Apollo’s own maintenance block, not based on a coach’s published schedule: enough quality to stay sharp without the fatigue of a marathon build.',
    ),
  };
}

// ── Exported Collections ────────────────────────────────────────────────────

export const EXPANDED_MARATHON_PLANS: TrainingPlan[] = [
  buildHigdonNoviceSupreme(),
  buildHigdonIntermediate2(),
  buildHigdonAdvanced2(),
  buildHigdonPersonalBest(),
  buildPfitz1255(),
  buildPfitz1270(),
  buildPfitz1870(),
  buildPfitz1885(),
  buildPfitzMulti12(),
  buildApolloMulti8(),
  buildDaniels2Q('daniels-2q-40', '2Q Marathon (Up to 40 mpw)', 40, 5, 'intermediate', false),
  buildDaniels2Q('daniels-2q-55', '2Q Marathon (41–55 mpw)', 55, 5, 'advanced', false),
  buildDaniels2Q('daniels-2q-70', '2Q Marathon (56–70 mpw)', 70, 6, 'advanced', true),
  buildDaniels2Q('daniels-2q-85', '2Q Marathon (71–85 mpw)', 85, 7, 'elite', true),
  buildHansonsJustFinish(),
  buildHansonsAdvanced(),
  buildGallowayRunWalk(),
  buildTimeBasedEndurance(),
  buildNorwegianSubThreshold(),
  buildCanovaSpecific75(),
  buildBostonQualifier60(),
];

export const SUPPLEMENTAL_PLANS: TrainingPlan[] = [
  buildBaseBuilder8(),
  buildBaseBuilder12(),
  buildPostMarathonRecovery4(),
  buildOffSeasonMaintenance6(),
];
