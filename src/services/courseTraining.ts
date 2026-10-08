/**
 * Course-Specific Training Recommendations — auto-generated training
 * adaptations based on a marathon course profile.
 *
 * Provides specific workout recommendations for World Major courses
 * and generic recommendations based on elevation profile difficulty.
 *
 * v1.0.6
 * - World Majors are matched by id only (stable 'boston' or legacy
 *   'boston-marathon-2026') on races flagged as World Majors, never by name
 *   or city. A custom "Boston … Half" gets the generic plan (L-36).
 * - The generic plan also looks at total loss / net drop and race distance:
 *   net-downhill courses get eccentric (downhill) preparation, and long runs
 *   scale to the race distance (L-38).
 * - Every call builds fresh objects; nothing shared is sorted or mutated (L-37).
 * - Course facts corrected (L-39) and copy follows the athlete's units (L-40).
 * - `groupWorkoutsByWindow` buckets workouts into now / upcoming / passed.
 */

import type { CourseProfile, MarathonRace } from '../types/raceStrategy';
import type { DistanceUnit } from './unitPreferences';
import type { TemperatureUnit } from './athleteProfile';
import type { WorldMajorId } from '../data/worldMajors';
import { fToC } from './athleteProfile';
import { isWorldMajorId, normalizeMarathonId } from '../data/worldMajors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CourseTrainingPlan {
  raceName: string;
  difficulty: number;
  courseType: string;
  keyWorkouts: CourseWorkout[];
  weeklyGuidance: string[];
  taperNotes: string[];
  raceExecutionTips: string[];
  /** v1.0.6: template used — a World Major id for course-specific plans, else 'generic'. */
  source: WorldMajorId | 'generic';
}

export interface CourseWorkout {
  name: string;
  description: string;
  /** When to do this in the training cycle (weeks out from race), e.g. '12-16' or '8'. */
  weeksOut: string;
  /** Workout category */
  category: 'hill' | 'long_run' | 'tempo' | 'specific' | 'surface' | 'mental';
  /** Priority: 1=essential, 2=recommended, 3=nice-to-have */
  priority: 1 | 2 | 3;
}

/** Options for {@link generateCourseTraining} / {@link getKeyWorkouts}. */
export interface CourseTrainingOptions {
  /** Distance unit for distances, paces and elevations in the copy. Default 'mi'. */
  unit?: DistanceUnit;
  /** Temperature unit for the copy. Default '°C' for km and '°F' for mi. */
  temperatureUnit?: TemperatureUnit;
}

/** Course numbers the plans work from. Missing data gets safe defaults. */
export interface CourseFacts {
  distanceMi: number;
  gainFt: number;
  lossFt: number;
  /** Total loss minus total gain, ft (positive = net downhill). */
  netDropFt: number;
  /** 1-10 (1 = flat/fast, 10 = extremely hilly). */
  difficulty: number;
}

/** Workouts bucketed by their training window relative to the race. */
export interface WorkoutWindows {
  /** Window is open now (within one week either side). */
  now: CourseWorkout[];
  /** Window is still ahead (closer to race day). */
  upcoming: CourseWorkout[];
  /** Window has passed (it was further out from the race than today). */
  passed: CourseWorkout[];
}

type PlanCopy = Omit<CourseTrainingPlan, 'raceName' | 'difficulty' | 'courseType' | 'source'>;

// ── Unit-aware copy ───────────────────────────────────────────────────────────

const KM_PER_MI = 1.609344;
const M_PER_FT = 0.3048;
const FT_PER_MI = 5280;
const MARATHON_MI = 26.2;

/** Small formatter set so the same copy reads naturally in mi/ft or km/m. */
interface CopyFormat {
  unit: DistanceUnit;
  /** "18 mi" / "29 km" */
  dist(mi: number): string;
  /** "18-20 mi" / "29-32 km" */
  range(loMi: number, hiMi: number): string;
  /** "780 ft" / "238 m" */
  elev(ft: number): string;
  /** Course position: "mile 20.5" / "km 33" */
  at(mi: number): string;
  /** Course span: "miles 16-21" / "km 26-34" */
  span(loMi: number, hiMi: number): string;
  /** Pace offset: "5 sec/mi" / "3 sec/km" (optionally a range) */
  secPer(lo: number, hi?: number): string;
  /** Temperature: "60-70°F" / "16-21°C" (optionally a range) */
  temps(loF: number, hiF?: number): string;
  /** Hand-written alternatives when a conversion would read badly. */
  pick(mi: string, km: string): string;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function makeFormat(unit: DistanceUnit, temperatureUnit: TemperatureUnit): CopyFormat {
  const km = unit === 'km';
  const d = (mi: number): string => (km ? String(Math.round(mi * KM_PER_MI)) : trimNum(mi));
  const s = (secPerMi: number): string => String(Math.max(1, Math.round(km ? secPerMi / KM_PER_MI : secPerMi)));
  const t = (f: number): string => String(Math.round(temperatureUnit === 'C' ? fToC(f) : f));
  const deg = temperatureUnit === 'C' ? '°C' : '°F';
  return {
    unit,
    dist: (mi) => `${d(mi)} ${unit}`,
    range: (lo, hi) => `${d(lo)}-${d(hi)} ${unit}`,
    elev: (ft) => (km ? `${Math.round(ft * M_PER_FT)} m` : `${Math.round(ft)} ft`),
    at: (mi) => (km ? `km ${d(mi)}` : `mile ${d(mi)}`),
    span: (lo, hi) => (km ? `km ${d(lo)}-${d(hi)}` : `miles ${d(lo)}-${d(hi)}`),
    secPer: (lo, hi) => `${s(lo)}${hi === undefined ? '' : `-${s(hi)}`} sec/${unit}`,
    temps: (lo, hi) => `${t(lo)}${hi === undefined ? '' : `-${t(hi)}`}${deg}`,
    pick: (mi, kmText) => (km ? kmText : mi),
  };
}

// ── World Majors Recommendations ──────────────────────────────────────────────
// Each entry is a function so every call returns fresh arrays (L-37).

const MAJOR_RECOMMENDATIONS: Record<WorldMajorId, (f: CopyFormat) => PlanCopy> = {
  boston: (f) => ({
    keyWorkouts: [
      { name: 'Newton Hills Simulation', description: `Find a route with 3-4 consecutive hills in the last third of your long run. Hold marathon effort on the uphills (let the pace slow) and don't brake on the downhills. Simulates ${f.span(16, 21)}, where Heartbreak Hill is the 4th climb.`, weeksOut: '12-16', category: 'hill', priority: 1 },
      { name: 'Downhill Tempo Segments', description: `On a gentle 2-4 % downhill, run 4-6 × 3-4 min at marathon effort, jogging back up between reps. Quick, light turnover with a slight forward lean and no braking; add a rep every week or two. Prepares your quads for the net drop of more than ${f.elev(400)} over the first ${f.dist(16)}.`, weeksOut: '10-16', category: 'hill', priority: 1 },
      { name: 'Hilly Long Run', description: `${f.range(18, 20)} on a hilly route, with the last ${f.dist(6)} at marathon pace. Boston's four Newton hills fall in ${f.span(16, 21)}, so put hills late in your long runs.`, weeksOut: '8-14', category: 'long_run', priority: 1 },
      { name: 'Eccentric Quad Builder', description: 'Controlled downhill strides: 6-10 × 20-30 s on a gentle 2-4 % grade, relaxed and quick (not sprints), walking back up. Pair with eccentric strength work (step-downs, slow-lowering squats). Builds quad tolerance for the downhill pounding.', weeksOut: '14-20', category: 'hill', priority: 2 },
      { name: 'Negative Split Long Run', description: `${f.range(16, 18)}: the first ${f.dist(10)} conservative, the last ${f.range(6, 8)} at marathon pace. Boston rewards patience — the course runs downhill to Newton, then you need legs for the hills.`, weeksOut: '6-12', category: 'long_run', priority: 2 },
      { name: 'Boston Dress Rehearsal', description: `${f.range(13, 16)} in race kit at your race start time: the first two-thirds on a gently downhill or rolling route at marathon pace, then 2-3 hills at marathon effort. Practise your race fueling.`, weeksOut: '3-6', category: 'specific', priority: 2 },
    ],
    weeklyGuidance: [
      `Include at least one hilly run per week. Boston has about ${f.elev(780)} of climbing.`,
      `Prioritize downhill training — most runners underestimate the quad damage from the net-downhill first ${f.dist(16)}.`,
      'Practice race-pace running on tired legs (hills + tempo in the same session).',
      'Strengthen glutes and quads with lunges, step-downs, and single-leg squats.',
    ],
    taperNotes: [
      'Maintain one short hill session in taper week 1 to keep neuromuscular patterns fresh.',
      'Don\'t do any downhill training in the final 10 days — quads need full recovery.',
    ],
    raceExecutionTips: [
      `Bank time on the downhill start? NO. The quads you save over the first ${f.dist(16)} decide the last ${f.dist(10)}.`,
      'Run the tangents through the Newton hills — the course adds up if you run wide on turns.',
      `Heartbreak Hill (${f.at(20.5)}) is actually the 4th hill — don't spend all your energy on the first three.`,
      'The course runs west to east, so a west wind is a tailwind. The usual problem is an easterly sea-breeze headwind, often strongest late in the race. If one is forecast, tuck in behind other runners and adjust your goal pace.',
    ],
  }),

  nyc: (f) => ({
    keyWorkouts: [
      { name: 'Bridge Repeat Simulation', description: 'Hill session: 5 × 3-4 min climbs on a 4-6 % grade, using the descent as recovery. Simulates NYC\'s five bridge crossings (Verrazzano-Narrows, Pulaski, Queensboro, Willis Avenue, Madison Avenue). Hold effort, not pace, on the climbs.', weeksOut: '10-16', category: 'hill', priority: 1 },
      { name: 'Rolling Course Long Run', description: `${f.range(18, 20)} on a rolling route. NYC is never truly flat — constant small grade changes add up, so train your legs for them.`, weeksOut: '8-14', category: 'long_run', priority: 1 },
      { name: 'Crowded Start Practice', description: `Start a long run in a busy park or a tune-up race and practise patience early: ${f.pick('mile 1', 'the first 1.6 km')} climbs the Verrazzano-Narrows Bridge (the biggest climb of the race) and ${f.pick('mile 2', 'the next 1.6 km')} descends into Brooklyn. Run by effort, not pace.`, weeksOut: '6-10', category: 'mental', priority: 2 },
      { name: 'Fifth Avenue Tempo', description: `${f.range(6, 8)} at marathon pace on a gradual uphill. Fifth Avenue (${f.span(22, 24)}) climbs gently when your legs are most tired — practise running strong there.`, weeksOut: '8-12', category: 'tempo', priority: 1 },
      { name: 'Central Park Finish Simulation', description: `Finish a long run with the last ${f.range(3, 4)} over rolling hills. Central Park's small hills come when you're most depleted.`, weeksOut: '6-10', category: 'long_run', priority: 2 },
      { name: 'Controlled Descent Practice', description: 'Once a week, add 4-6 controlled downhill segments of 1-2 min on a gentle 2-4 % grade to an easy or hill run: quick, light steps, no braking, building volume gradually. The Verrazzano descent and the drop off the Queensboro Bridge onto First Avenue are where quads get hammered and pace runs away.', weeksOut: '6-12', category: 'hill', priority: 2 },
    ],
    weeklyGuidance: [
      'Train on rolling terrain at least twice per week. NYC has constant elevation changes.',
      'Practice bridge-style efforts: a 3-4 min climb at steady effort followed by a controlled descent.',
      'The course goes through 5 boroughs with very different vibes — practice mentally resetting.',
      `The Queensboro Bridge (${f.span(15, 16)}) is silent — no crowds. Practice running strong without crowd energy.`,
    ],
    taperNotes: [
      'Include one session with 3-4 short bridge-effort hills during taper week 1.',
      'Ferries and buses to the Staten Island start leave hours before your wave — shift your sleep schedule earlier in race week.',
    ],
    raceExecutionTips: [
      `${f.pick('Mile 1', 'The first 1.6 km')} climbs the Verrazzano-Narrows Bridge — the biggest climb on the course, and often windy. Run it by effort and let the pace slow.`,
      `${f.pick('Mile 2', 'The next 1.6 km')} is the descent into Brooklyn. Stay relaxed and controlled — bank zero time here.`,
      `Queensboro Bridge (${f.span(15, 16)}): silence + uphill = danger zone. Stay disciplined.`,
      `Fifth Avenue (${f.span(22, 24)}) is a subtle uphill that feels like a wall on tired legs.`,
      `Central Park's rolling hills in the last ${f.dist(2)} are deceptively tough — save something.`,
    ],
  }),

  berlin: (f) => ({
    keyWorkouts: [
      { name: 'Pace Lock Tempo', description: `${f.range(8, 10)} at exact marathon pace. Practice metronome pacing — Berlin rewards consistency. Vary pace by no more than ${f.secPer(5)}.`, weeksOut: '8-14', category: 'tempo', priority: 1 },
      { name: 'Flat Long Run at MP', description: `${f.dist(20)} on flat terrain with the final ${f.dist(10)} at marathon pace. Berlin is about sustaining pace — this is your key workout.`, weeksOut: '6-10', category: 'long_run', priority: 1 },
      { name: 'Pace Discipline Intervals', description: `${f.pick('6 × 1 mi', '6 × 1.5 km')} at marathon pace with a 1 min jog. Each rep within 2-3 seconds of its target time — this is pacing school.`, weeksOut: '10-16', category: 'tempo', priority: 1 },
      { name: 'Negative Split Practice', description: `${f.dist(16)}: the first half at marathon pace + ${f.secPer(10)}, the second half at marathon pace − ${f.secPer(5)}. Berlin's flat profile rewards negative splitting.`, weeksOut: '6-12', category: 'long_run', priority: 2 },
      { name: 'Cobbles & Uneven Surfaces', description: 'Berlin is mostly smooth asphalt but has a few short cobbled or uneven stretches. Run part of an easy run each week on cobbles, brick or packed trail so a change of surface doesn\'t break your rhythm.', weeksOut: '4-12', category: 'surface', priority: 3 },
    ],
    weeklyGuidance: [
      'Focus on pace consistency above everything. Berlin is the flattest World Major.',
      'Train on flat courses for your key workouts. Eliminate variables.',
      'Tempo runs at exactly marathon pace are more valuable than faster intervals for Berlin.',
      'Practice taking drinks on the move — crowded aid stations are where pace slips.',
    ],
    taperNotes: [
      'Maintain pace-feel with 2-3 short marathon-pace pickups during taper.',
      `Late September in Berlin can be warm (${f.temps(60, 70)}) — check the forecast and adjust pace if needed.`,
    ],
    raceExecutionTips: [
      'The field goes out FAST. Ignore them. Your pace is your pace.',
      'Aid stations come about every 5 km — practice grabbing cups at pace without stopping.',
      'The course is flat but has several 90-degree turns that disrupt rhythm. Anticipate and recover quickly.',
      `You run through the Brandenburg Gate with ${f.pick('about a quarter mile', 'about 400 m')} still to go — keep pushing all the way to the finish line.`,
    ],
  }),

  chicago: (f) => ({
    keyWorkouts: [
      { name: 'Headwind Tempo', description: `${f.range(6, 8)} at marathon effort into the wind. Chicago's lakefront exposure means wind is a factor — practice holding effort when the pace drops.`, weeksOut: '8-14', category: 'specific', priority: 1 },
      { name: 'Flat Pace Marathon Long Run', description: `${f.dist(20)} on flat terrain with the last ${f.range(8, 12)} at marathon pace. Chicago is fast and flat — train for exactly that.`, weeksOut: '6-10', category: 'long_run', priority: 1 },
      { name: 'Drafting Practice', description: 'Run a long run or tempo with a group and practice sitting behind other runners to cut wind drag. This is a real race strategy for Chicago.', weeksOut: '8-14', category: 'specific', priority: 2 },
      { name: 'Heat Adaptation', description: `October can surprise with ${f.temps(60, 75)}. Do 2-3 long runs in warmer conditions, slow down by ${f.secPer(5, 10)} and practice your hydration.`, weeksOut: '10-16', category: 'specific', priority: 2 },
    ],
    weeklyGuidance: [
      `Train on flat terrain. Chicago has only about ${f.elev(105)} of gain; the one notable rise is Roosevelt Road just before the finish.`,
      'Practice running into a headwind — the lakefront sections are exposed.',
      'Chicago is a PR course — focus on pace consistency and fast flat-ground running.',
      'Consider a drafting strategy if running with a pace group.',
    ],
    taperNotes: [
      `Check the forecast — October weather in Chicago varies widely (${f.temps(40, 75)}).`,
      'The start is at Grant Park with a massive field — arrive early for your corral.',
    ],
    raceExecutionTips: [
      `${f.pick('Mile 1', 'The first 2 km')} is packed and GPS is unreliable among the downtown towers — don't weave; settle in and run by effort.`,
      `Chinatown (around ${f.at(21)}) is a crowd highlight — enjoy the lift, but don't surge.`,
      'The last stretch runs north up Michigan Avenue — a north or northeast wind off the lake is a headwind there, so save energy and tuck in behind others.',
      `The only notable hill is the short rise on Roosevelt Road just before the finish (around ${f.at(26)}) — expect it and save a little for it.`,
      'This is one of the best BQ courses — execute your plan precisely.',
    ],
  }),

  tokyo: (f) => ({
    keyWorkouts: [
      { name: 'Flat Speed-Pace Long Run', description: `${f.range(18, 20)} with the last ${f.dist(8)} at marathon pace. Tokyo is fast and flat — train for sustained pace on flat ground.`, weeksOut: '6-12', category: 'long_run', priority: 1 },
      { name: 'Cool-to-Warm Transition Run', description: `Do some long runs early on cool mornings (around ${f.temps(40)}) and practice adjusting layers and pace as it warms to ${f.temps(50, 55)}. March in Tokyo can start cold and warm up.`, weeksOut: '8-14', category: 'specific', priority: 2 },
      { name: 'Pace Consistency Tempo', description: `${f.dist(8)} at exact marathon pace. Tokyo rewards even splits on its flat profile.`, weeksOut: '8-14', category: 'tempo', priority: 1 },
    ],
    weeklyGuidance: [
      'Tokyo is one of the flattest World Majors — train for sustained effort.',
      `March weather is variable (${f.temps(38, 52)}, possible rain). Prepare for all conditions.`,
      'Practice fueling with the drinks and food offered on course, or carry your own.',
      'Jet lag from Europe or the Americas is significant — arrive 4-5 days early if you can.',
    ],
    taperNotes: [
      'Account for jet lag in your taper — you may need extra rest days.',
      'The start is at 9:10 AM — practice running at that time of day.',
    ],
    raceExecutionTips: [
      'Security is thorough — arrive at the start extra early.',
      `The first ${f.pick('5 miles', '8 km')} drop gently from Shinjuku — it's easy to start too fast. Keep the early pace in check.`,
      'Open stretches can be breezy — tuck in behind other runners when they are.',
      'Crowd support is huge and enthusiastic — enjoy it, but don\'t let it pull you off pace.',
    ],
  }),

  london: (f) => ({
    keyWorkouts: [
      { name: 'Varied Surface Long Run', description: `${f.dist(18)} mixing asphalt, concrete, brick and some cobblestone sections. London has short cobbled stretches (around Greenwich's Cutty Sark and near the Tower of London) — prepare your feet and stride for the surface changes.`, weeksOut: '8-14', category: 'surface', priority: 1 },
      { name: 'Flat Tempo with Pace Lock', description: `${f.dist(8)} at marathon pace on a flat route. London is predominantly flat — train for pace consistency.`, weeksOut: '8-14', category: 'tempo', priority: 1 },
      { name: 'Thames Embankment Simulation', description: `${f.dist(6)} at marathon pace along a river or other exposed flat route. The riverside sections can be windy — practice running exposed.`, weeksOut: '6-12', category: 'specific', priority: 2 },
    ],
    weeklyGuidance: [
      `London is largely flat. The first ${f.pick('3 miles', '5 km')} from Blackheath and Greenwich are net downhill, so it's easy to start too fast.`,
      'Practice on varied surfaces — cobblestone sections can disrupt rhythm.',
      `April weather is unpredictable (${f.temps(45, 60)}, possible rain, the odd warm day). Train in both cool and mild conditions.`,
      'The course runs from Greenwich to The Mall with many turns — study the map, especially the Docklands section.',
    ],
    taperNotes: [
      'London ballot stress is over — trust your training and enjoy the build-up.',
      'The start is split between blue, red, and green starts that merge — know your start.',
    ],
    raceExecutionTips: [
      `The starts merge into one course around ${f.at(3)} — expect congestion.`,
      `Tower Bridge (around ${f.at(12)}) is an emotional high — don't surge.`,
      `The Docklands section (${f.span(14, 21)}) can feel quieter after Tower Bridge — stay disciplined.`,
      'The final stretch along Birdcage Walk, past Buckingham Palace and onto The Mall is flat and fast — finish strong.',
    ],
  }),
};

// ── Core Generator ────────────────────────────────────────────────────────────

/**
 * Generate course-specific training recommendations for a race.
 *
 * World Majors (matched by id, see {@link identifyWorldMajor}) get their
 * course-specific plan; every other race gets a generic plan built from its
 * climbing, net drop and distance. Pure: returns fresh objects on every call.
 */
export function generateCourseTraining(race: MarathonRace, options: CourseTrainingOptions = {}): CourseTrainingPlan {
  const unit: DistanceUnit = options.unit === 'km' ? 'km' : 'mi';
  const f = makeFormat(unit, options.temperatureUnit ?? (unit === 'km' ? 'C' : 'F'));
  const facts = getCourseFacts(race);
  const base = { raceName: race.name, difficulty: facts.difficulty, courseType: race.courseType };

  // Check if we have specific recommendations for this race
  const major = identifyWorldMajor(race);
  if (major) {
    return { ...base, source: major, ...MAJOR_RECOMMENDATIONS[major](f) };
  }

  // Generate generic recommendations based on course profile
  return { ...base, source: 'generic', ...generateGenericPlan(facts, f) };
}

/**
 * Get just the key workouts for a race (lighter API), most important first.
 * Sorts a copy, so repeated calls never reorder anything shared (L-37).
 */
export function getKeyWorkouts(race: MarathonRace, options: CourseTrainingOptions = {}): CourseWorkout[] {
  const plan = generateCourseTraining(race, options);
  return [...plan.keyWorkouts].sort((a, b) => a.priority - b.priority);
}

// ── Training windows ──────────────────────────────────────────────────────────

/** Parse a `weeksOut` window ('12-16', '12–16' or '8') into an inclusive range. */
export function parseWeeksOut(weeksOut: string): { min: number; max: number } | null {
  const m = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(weeksOut ?? '');
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * Bucket workouts by their training window relative to `weeksToRace`
 * (whole weeks until race day, e.g. `Math.floor(daysToRace / 7)`).
 *
 * A window `min-max` (weeks out) counts as:
 * - `now` when `weeksToRace` is within one week of it: `min - 1 <= weeksToRace <= max + 1`
 *   (for a single week `w` that is `|weeksToRace - w| <= 1`);
 * - `upcoming` when it lies entirely closer to race day: `max < weeksToRace - 1`;
 * - `passed` when it lay further out than today: `min > weeksToRace + 1`.
 *
 * The three buckets partition the input. Workouts with an unparseable window,
 * or a non-finite `weeksToRace`, go to `upcoming`. Within each bucket the
 * order is: priority, then (upcoming) the window that opens first. Pure:
 * the input array is not mutated.
 */
export function groupWorkoutsByWindow(workouts: CourseWorkout[], weeksToRace: number): WorkoutWindows {
  const now: CourseWorkout[] = [];
  const upcoming: CourseWorkout[] = [];
  const passed: CourseWorkout[] = [];
  const known = Number.isFinite(weeksToRace);
  for (const w of workouts) {
    const range = parseWeeksOut(w.weeksOut);
    if (!known || !range) upcoming.push(w);
    else if (range.max < weeksToRace - 1) upcoming.push(w);
    else if (range.min > weeksToRace + 1) passed.push(w);
    else now.push(w);
  }
  const maxOf = (w: CourseWorkout): number => parseWeeksOut(w.weeksOut)?.max ?? -1;
  now.sort((a, b) => a.priority - b.priority);
  upcoming.sort((a, b) => maxOf(b) - maxOf(a) || a.priority - b.priority);
  passed.sort((a, b) => a.priority - b.priority);
  return { now, upcoming, passed };
}

// ── Course identification & facts ─────────────────────────────────────────────

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** True when `distanceMi` is (about) a marathon. Missing distance counts as one. */
function isMarathonDistance(distanceMi: unknown): boolean {
  return typeof distanceMi !== 'number' || !Number.isFinite(distanceMi) || Math.abs(distanceMi - MARATHON_MI) <= 1;
}

/**
 * The World Major whose course-specific plan applies to `race`, or null.
 * Matches on the id only (stable 'boston' or legacy 'boston-marathon-2026'),
 * and only for marathon-distance races flagged as World Majors
 * (`isWorldMajor` or category 'world-major'). Never matches on name or city,
 * so a custom "Boston Run to Remember Half" gets the generic plan (L-36).
 */
export function identifyWorldMajor(
  race: Pick<MarathonRace, 'id' | 'isWorldMajor' | 'category' | 'distanceMi'>,
): WorldMajorId | null {
  if (!race || typeof race.id !== 'string') return null;
  const id = normalizeMarathonId(race.id);
  if (!isWorldMajorId(id)) return null;
  if (race.isWorldMajor !== true && race.category !== 'world-major') return null;
  if (!isMarathonDistance(race.distanceMi)) return null;
  return id;
}

/**
 * Course numbers for the plans and the course card. The net drop is derived
 * from total gain and loss (falling back to `netChangeFt`, negative =
 * downhill), so it doesn't depend on how `netChangeFt` was stored.
 */
export function getCourseFacts(race: MarathonRace): CourseFacts {
  const course: Partial<CourseProfile> = race.course ?? {};
  const rawDistance = finiteOr(race.distanceMi, MARATHON_MI);
  const distanceMi = rawDistance > 0 ? rawDistance : MARATHON_MI;
  const gainFt = Math.max(0, finiteOr(course.totalGainFt, 0));
  let lossFt: number;
  if (typeof course.totalLossFt === 'number' && Number.isFinite(course.totalLossFt)) {
    lossFt = Math.max(0, course.totalLossFt);
  } else if (typeof course.netChangeFt === 'number' && Number.isFinite(course.netChangeFt)) {
    lossFt = Math.max(0, gainFt - course.netChangeFt);
  } else {
    lossFt = gainFt;
  }
  const difficulty = Math.min(10, Math.max(1, Math.round(finiteOr(course.difficulty, 5))));
  return { distanceMi, gainFt, lossFt, netDropFt: lossFt - gainFt, difficulty };
}

// ── Generic Generator ─────────────────────────────────────────────────────────

/** ≈1,000 ft of climbing (or descending) per marathon. */
const HILLY_FT_PER_MI = 38;
/** A net-downhill course drops at least this much overall… */
const NET_DROP_MIN_FT = 250;
/** …and at least this much per mile (≈0.2 % average grade). */
const NET_DROP_MIN_FT_PER_MI = 10;
/** Big drops make eccentric preparation essential. */
const BIG_DROP_FT = 1000;
const BIG_DROP_FT_PER_MI = 40;

type DistanceClass = 'short' | 'half' | 'long' | 'marathon' | 'ultra';

interface DistanceSpec {
  /** Peak long-run range, miles. */
  longRunMi: readonly [number, number];
  /** Peak long-run duration. */
  longRunTime: string;
  /** Goal-pace volume inside key sessions, miles. */
  paceMi: readonly [number, number];
}

const DISTANCE_SPECS: Readonly<Record<DistanceClass, DistanceSpec>> = {
  short: { longRunMi: [6, 10], longRunTime: '60-90 min', paceMi: [2, 4] },
  half: { longRunMi: [10, 13], longRunTime: '90-120 min', paceMi: [3, 6] },
  long: { longRunMi: [14, 18], longRunTime: '2-2.5 h', paceMi: [5, 8] },
  marathon: { longRunMi: [18, 20], longRunTime: '2.5-3 h at most', paceMi: [6, 10] },
  ultra: { longRunMi: [20, 26], longRunTime: '3-5 h', paceMi: [6, 10] },
};

function classifyDistance(mi: number): DistanceClass {
  if (mi < 9) return 'short'; // 5K-15K
  if (mi <= 16) return 'half'; // 10 mi-25K, incl. the half marathon
  if (mi < 24) return 'long'; // 30K / 20 mi
  if (mi <= 28) return 'marathon';
  return 'ultra';
}

function generateGenericPlan(c: CourseFacts, f: CopyFormat): PlanCopy {
  const cls = classifyDistance(c.distanceMi);
  const spec = DISTANCE_SPECS[cls];
  const lrRange = f.range(spec.longRunMi[0], spec.longRunMi[1]);
  const lr = cls === 'ultra' ? `${spec.longRunTime} on your feet (roughly ${lrRange})` : `${lrRange} (${spec.longRunTime})`;
  const pace = f.range(spec.paceMi[0], spec.paceMi[1]);

  const gainPerMi = c.gainFt / c.distanceMi;
  const lossPerMi = c.lossFt / c.distanceMi;
  const dropPerMi = c.netDropFt / c.distanceMi;
  const downhill = c.netDropFt >= NET_DROP_MIN_FT && dropPerMi >= NET_DROP_MIN_FT_PER_MI;
  const bigDrop = downhill && (c.netDropFt >= BIG_DROP_FT || dropPerMi >= BIG_DROP_FT_PER_MI);
  const hilly = c.difficulty >= 6 || gainPerMi >= HILLY_FT_PER_MI;
  const descents = !downhill && lossPerMi >= HILLY_FT_PER_MI;
  const flat = !hilly && !downhill && c.difficulty <= 3;

  const workouts: CourseWorkout[] = [];
  const guidance: string[] = [];
  const taperNotes: string[] = [];
  const tips: string[] = [];

  if (hilly) {
    // Hilly course
    workouts.push(
      { name: 'Hilly Long Run', description: `${lr} on a route with sustained climbs (aim for about ${f.elev(Math.round((c.gainFt * 0.5) / 50) * 50)} of climbing). Run the uphills by effort and keep the descents relaxed and controlled.`, weeksOut: '8-14', category: 'long_run', priority: 1 },
      { name: 'Uphill Strength Repeats', description: '8-10 × 60-90 s uphill at about 5K effort, jogging back down. Builds power for the climbs.', weeksOut: '12-20', category: 'hill', priority: 2 },
    );
    guidance.push(
      `This is a challenging course with ${f.elev(c.gainFt)} of climbing. Hill training is essential.`,
      `Run by effort, not pace, on hills. Expect pace to vary ${f.secPer(15, 30)} on significant climbs.`,
      'Strengthen quads, glutes, and calves with hill-specific strength work.',
    );
    tips.push(
      'Don\'t try to maintain flat-ground pace on uphills — run even effort instead.',
      'On descents stay relaxed: quick cadence, slight forward lean, no braking — but don\'t race them.',
    );
  }

  if (downhill) {
    // Net-downhill course: eccentric preparation (L-38)
    const gradePct = (c.netDropFt / (c.distanceMi * FT_PER_MI)) * 100;
    workouts.push(
      { name: 'Eccentric Downhill Prep', description: `This course drops ${f.elev(c.netDropFt)} net (about ${gradePct.toFixed(1)} % on average)${bigDrop ? ', which hammers unprepared quads' : ''}. Once a week, add controlled downhill running on a gentle 2-4 % grade to an easy run: start with 5-10 min of total downhill and add about 5 min a week, up to 20-30 min. Quick, light steps, slight forward lean, no braking. Some quad soreness after the first sessions is part of the adaptation. None in the final 10 days.`, weeksOut: '8-16', category: 'hill', priority: bigDrop ? 1 : 2 },
      { name: 'Downhill Long Run Finish', description: `${lr}, with the final third on a long, gentle downhill (2-4 %) at goal effort, so you learn to hold form on tired legs while descending. Build the downhill portion up over several weeks.`, weeksOut: '6-12', category: 'long_run', priority: bigDrop ? 1 : 2 },
      { name: 'Controlled Downhill Strides', description: '6-8 × 20-30 s strides on a gentle 2-4 % downhill, relaxed and quick (not sprints), walking back up. Teaches quick turnover and light foot strikes.', weeksOut: '10-16', category: 'hill', priority: 2 },
    );
    guidance.push(
      'Net-downhill courses load the quads eccentrically (muscles lengthening under load) with every stride. Build downhill volume progressively — a little more each week — rather than all at once.',
      'Twice a week, add eccentric strength work: step-downs, slow-lowering split squats, and single-leg squats.',
    );
    taperNotes.push('No downhill running in the final 10 days — let your quads recover fully.');
    tips.push(
      'Start conservatively. The early downhill sections feel easy, but the quad damage shows up late — don\'t bank time.',
      'Keep your cadence quick and land under your hips; don\'t over-stride or brake on the steepest parts.',
    );
  } else if (hilly || descents) {
    // Plenty of descending on a hilly / rolling loop
    workouts.push(
      { name: 'Controlled Downhill Running', description: 'Once a week, add 4-6 × 1-2 min of controlled downhill running on a gentle 2-4 % grade to a hill or easy run: quick, light steps, no braking. Add volume gradually; none in the final 10 days.', weeksOut: '10-16', category: 'hill', priority: hilly ? 1 : 2 },
    );
    taperNotes.push('No downhill running in the final 10 days — quads need full recovery.');
  }

  if (flat) {
    // Flat course
    workouts.push(
      { name: 'Pace Consistency Long Run', description: `${lr} at even pace, finishing with ${pace} at goal race pace. On a flat course, pace discipline is everything — keep each ${f.pick('mile', 'kilometre')} within ${f.secPer(5)} of target.`, weeksOut: '6-12', category: 'long_run', priority: 1 },
      { name: 'Goal-Pace Tempo', description: `${pace} at exact goal race pace. Flat courses reward metronomic pacing.`, weeksOut: '8-14', category: 'tempo', priority: 1 },
    );
    guidance.push(
      'Flat course — focus on pace consistency and negative splitting.',
      'Spend most tempo work at goal race pace, not faster.',
    );
    tips.push(
      'Resist the urge to go out fast on a flat course — the field will pull you.',
      'Even splits or a slight negative split is the optimal strategy here.',
    );
  } else if (!hilly && !downhill) {
    // Moderate course
    workouts.push(
      { name: 'Mixed Terrain Long Run', description: `${lr} mixing flat and rolling sections. Practice moving between flat running and short hills without surging.`, weeksOut: '8-14', category: 'long_run', priority: 1 },
      { name: 'Rolling Hill Tempo', description: `${pace} at goal race pace on a route with moderate hills — keep the effort steady while the pace varies.`, weeksOut: '8-12', category: 'tempo', priority: 1 },
    );
    guidance.push(
      'Moderate course difficulty — include some hill training but don\'t overdo it.',
      'Practice effort-based pacing: keep effort consistent even when pace varies on hills.',
    );
  }

  // Distance-specific guidance (L-38)
  if (cls === 'short') {
    guidance.push('For a race this short, long runs of 60-90 min build the aerobic base; your key sessions are at or near race pace.');
  } else if (cls === 'half') {
    guidance.push(`Half-marathon build: long runs of about ${f.range(10, 13)} (90-120 min) are enough; put goal-pace work in the final ${f.range(3, 5)}.`);
  } else if (cls === 'long') {
    guidance.push(`Long runs of ${lrRange} (2-2.5 h) cover this distance — you don't need marathon-length long runs.`);
  } else if (cls === 'ultra') {
    guidance.push('Beyond the marathon, time on feet matters more than distance: build long runs to 3-5 h, consider back-to-back long days, and practice eating, drinking, and walking or hiking the climbs.');
  }

  // Common
  workouts.push({
    name: 'Race Dress Rehearsal',
    description: `A medium-long run with ${pace} at goal race pace, in your race shoes and kit and at your race start time. Practice your pre-race meal${cls === 'short' ? '' : ' and race fueling'}.`,
    weeksOut: '3-6',
    category: 'specific',
    priority: 2,
  });
  taperNotes.push(
    'Maintain race-specific neuromuscular patterns with short pickups during taper.',
    'Study the course map and elevation profile before race day.',
  );
  tips.push(
    'Know where the aid stations are and practice your fueling at race pace.',
    `Course difficulty: ${c.difficulty}/10. ${c.difficulty >= 5 ? 'Adjust your time goal by +2-4% versus a flat course.' : 'This course is suitable for a strong effort.'}`,
  );

  return { keyWorkouts: workouts, weeklyGuidance: guidance, taperNotes, raceExecutionTips: tips };
}
