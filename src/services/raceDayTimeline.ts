/**
 * Race Day Timeline — alarm → start area → race → recovery, in race-local
 * wall-clock time.
 *
 * Pure: no storage, no network, no `Date`. Every time is a whole number of
 * minutes after race-local midnight on race day (never a device-TZ `Date`);
 * the caller supplies a short time-zone label for display.
 *
 * Everything comes in through {@link RaceDayInput}: the wave's gun time, travel
 * and arrival preferences, an optional body mass, the projected finish, the
 * race distance, the pacing plan's `milePaces` (milestone times follow it) and
 * the in-race fuel items (time-based — e.g. from `planRaceFueling`; this module
 * does not compute fueling itself).
 */

import type { MilePacePlan } from '../types/raceStrategy';
import { KM_PER_MI, formatDurationSec, timeAtDistance } from './raceStrategy';

// ── Types ─────────────────────────────────────────────────────────────────────

export type MealPreference = 'light' | 'moderate' | 'full';

/** One fuel item placed by time (e.g. an item of `planRaceFueling().items`). */
export interface TimelineFuelItem {
  /** Seconds after the gun (negative = before the start, e.g. a pre-race gel). */
  timeSec: number;
  /** Planned distance at that moment, in miles. */
  distanceMi: number;
  label: string;
  carbsG?: number;
  note?: string;
}

export interface RaceDayInput {
  /**
   * Gun time of the athlete's wave, race-local. Accepts 24 h ('07:30', '17:30')
   * and 12 h forms with an optional zone / wave suffix ('7:30 AM CT',
   * '10:00 AM ET (Wave 1)'). An unrecognised string throws a `RangeError` —
   * validate with {@link parseClockTime} first. Never silently becomes 7:00.
   */
  raceStartTime: string;
  /** Travel time from where you sleep to the start area, in minutes. */
  travelMinutes: number;
  /** Breakfast size: light ≈ 1, moderate ≈ 2, full ≈ 3 g carbs per kg. */
  mealPreference: MealPreference;
  /** Body mass (kg). Optional: scales breakfast carbs and fluids; generic copy when missing. */
  weightKg?: number;
  /** Projected finish (s). 0 / non-finite → in-race milestones, finish and recovery are omitted. */
  projectedFinishSec: number;
  raceName: string;
  /** Race-local date, YYYY-MM-DD (echoed in the output and the text export). */
  raceDate?: string;
  /** Short zone label for display, e.g. 'CDT'. Falls back to a label inside `raceStartTime` ('CT'). */
  timeZoneLabel?: string;
  /** Start wave / corral label, shown with the gun time. */
  wave?: string;
  /** Race distance in miles. Default: the last `milePaces` entry, else 26.2. */
  distanceMi?: number;
  /** Pacing plan; milestone times follow it (scaled to `projectedFinishSec`). Default: even pace. */
  milePaces?: MilePacePlan[];
  /**
   * Fuel items placed at gun + `timeSec`. Omit for no in-race fuel rows (a
   * default pre-race gel at −15 min is still listed); pass `[]` for none at all.
   */
  fuelItems?: TimelineFuelItem[];
  /** Minutes before the gun to be at the start area. Default: {@link defaultArrivalLeadMin}(fieldSize). */
  arrivalLeadMin?: number;
  /** Number of starters; drives the default arrival lead, bag-check and corral timing. */
  fieldSize?: number;
  /** Add a short warm-up that ends ~10 min before the gun. */
  includeWarmup?: boolean;
  /** Distance unit for labels and copy. Default 'mi'. */
  unit?: 'mi' | 'km';
  /** @deprecated Ignored since v1.0.6 (it spread gels by mile) — pass time-based `fuelItems`. */
  fuelingItemsCount?: number;
}

export type TimelineCategory = 'wake' | 'nutrition' | 'logistics' | 'warmup' | 'race' | 'fueling' | 'milestone';
export type TimelinePhase = 'pre-race' | 'race' | 'post-race';

export interface TimelineEvent {
  /** Race-local clock time, e.g. "4:30 AM" (suffixed "(day before)" / "(next day)" when it crosses midnight). */
  time: string;
  title: string;
  description: string;
  /** Category for grouping/styling. */
  category: TimelineCategory;
  /** Whole minutes before the gun (negative = after the start). */
  minutesBeforeStart: number;
  /** Exact seconds relative to the gun (negative = before). Events are sorted by this. */
  offsetSec: number;
  /** Race-local minutes after midnight on race day (< 0 the evening before, ≥ 1440 after midnight). */
  clockMinutes: number;
  phase: TimelinePhase;
}

export interface RaceDayTimeline {
  raceName: string;
  raceDate?: string;
  /** Zone label the times are in (input label, else the one parsed from the start time), or null. */
  timeZoneLabel: string | null;
  /** Gun time, race-local minutes after midnight. */
  startMinutes: number;
  /** Minutes before the gun the athlete is at the start area (input or field-size default). */
  arrivalLeadMin: number;
  /** Sorted by `offsetSec`. */
  events: TimelineEvent[];
  /** Coaching warnings, e.g. "bag check may close before you arrive". */
  warnings: string[];
  /** Plain-text export of the timeline. */
  textExport: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DISTANCE_MI = 26.2;
const MARATHON_RANGE_MI: readonly [number, number] = [25.9, 26.5];

/** Breakfast ~3 h before the gun when logistics allow (inside the 1–4 h window). */
const BREAKFAST_IDEAL_MIN_BEFORE = 180;
const BREAKFAST_DURATION_MIN = 20;
/** Breakfast must be finished at least this long before leaving. */
const BREAKFAST_END_BEFORE_LEAVE_MIN = 15;
const WAKE_TO_BREAKFAST_MIN = 30;
const MIN_WAKE_TO_LEAVE_MIN = 60;
/** Beyond this, breakfast is outside the 1–4 h window → add a carb snack. */
const BREAKFAST_SNACK_THRESHOLD_MIN = 240;

const LARGE_FIELD = 20_000;
const MEDIUM_FIELD = 5_000;
const MIN_ARRIVAL_LEAD_MIN = 20;
const MAX_ARRIVAL_LEAD_MIN = 300;

const CORRAL_CLOSE_MIN = 15;
const CORRAL_ENTRY_MIN = 25;
const PORTA_POTTY_MIN = 45;
const WARMUP_START_MIN = 22;
const WARMUP_END_MIN = 10;
const MIN_WARMUP_DURATION_MIN = 8;
const LINE_UP_MIN = 10;
const START_AREA_STEP_GAP_MIN = 3;
const DEFAULT_PRE_RACE_GEL_MIN = 15;
const RECOVERY_AFTER_FINISH_MIN = 10;

const MEAL_CARBS_G_PER_KG: Record<MealPreference, number> = { light: 1, moderate: 2, full: 3 };
const MEAL_LABEL: Record<MealPreference, string> = { light: 'Light', moderate: 'Moderate', full: 'Full' };
const ML_PER_FL_OZ = 29.5735;

const PHASE_TITLES: Record<TimelinePhase, string> = { 'pre-race': 'Pre-race', race: 'Race', 'post-race': 'Post-race' };
const PHASE_ORDER: TimelinePhase[] = ['pre-race', 'race', 'post-race'];

// ── Clock parsing ─────────────────────────────────────────────────────────────

/** A parsed race-local clock time. */
export interface ParsedClockTime {
  /** Minutes after midnight (0–1439). */
  minutes: number;
  /** Zone abbreviation found after the time ('CT', 'ET', 'JST', 'GMT+1'), else null. */
  tzLabel: string | null;
}

const CLOCK_RE = /^\s*(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(?:([ap])\.?\s?m\.?)?(?=$|[\s(,;–-])\s*(.*)$/i;
const TZ_LABEL_RE = /^([A-Z]{2,5}(?:[+-]\d{1,2}(?::?\d{2})?)?)(?![A-Za-z])/;

/**
 * Parse a race start time in 24 h ('17:30', '07:30') or 12 h form ('7:30 AM',
 * '7:30am', '12:00 AM' = 0), optionally followed by a zone and other text
 * ('7:30 AM CT', '10:00 AM ET (Wave 1)'). Returns null for anything invalid
 * ('25:00', '13:00 PM', 'abc', '', a bare '7').
 */
export function parseClockTime(s: string): ParsedClockTime | null {
  if (typeof s !== 'string') return null;
  const m = CLOCK_RE.exec(s);
  if (!m) return null;
  const [, hRaw, mRaw, meridiem, rest] = m;
  const h = Number(hRaw);
  const min = mRaw === undefined ? 0 : Number(mRaw);
  if (!Number.isInteger(h) || !Number.isInteger(min) || min > 59) return null;
  let hours24: number;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    hours24 = (h % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0);
  } else {
    if (mRaw === undefined || h > 23) return null;
    hours24 = h;
  }
  const tz = TZ_LABEL_RE.exec((rest ?? '').trim());
  return { minutes: hours24 * 60 + min, tzLabel: tz ? tz[1] : null };
}

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Default minutes before the gun to be at the start area: ≥ 20,000 starters → 120, ≥ 5,000 → 90, else 60. */
export function defaultArrivalLeadMin(fieldSize?: number): number {
  if (typeof fieldSize === 'number' && fieldSize >= LARGE_FIELD) return 120;
  if (typeof fieldSize === 'number' && fieldSize >= MEDIUM_FIELD) return 90;
  return 60;
}

function resolveArrivalLead(lead: number | undefined, fieldSize: number | undefined): number {
  if (typeof lead === 'number' && Number.isFinite(lead)) {
    return Math.min(MAX_ARRIVAL_LEAD_MIN, Math.max(MIN_ARRIVAL_LEAD_MIN, Math.round(lead)));
  }
  return defaultArrivalLeadMin(fieldSize);
}

// ── Core generator ────────────────────────────────────────────────────────────

interface Builder {
  startMin: number;
  unit: 'mi' | 'km';
  events: TimelineEvent[];
  warnings: string[];
}

/**
 * Build the race-day timeline. Pure. Throws a `RangeError` when
 * `raceStartTime` can't be parsed (see {@link parseClockTime}).
 */
export function generateRaceDayTimeline(input: RaceDayInput): RaceDayTimeline {
  const parsed = parseClockTime(input.raceStartTime);
  if (!parsed) {
    throw new RangeError(
      `Unrecognised race start time "${input.raceStartTime}". Use 24 h "HH:mm" (e.g. "07:30") or "7:30 AM".`,
    );
  }
  const b: Builder = { startMin: parsed.minutes, unit: input.unit === 'km' ? 'km' : 'mi', events: [], warnings: [] };
  const tzLabel = input.timeZoneLabel?.trim() || parsed.tzLabel;
  const weightKg = isPositive(input.weightKg) ? input.weightKg : undefined;
  const meal: MealPreference = Object.prototype.hasOwnProperty.call(MEAL_CARBS_G_PER_KG, input.mealPreference)
    ? input.mealPreference
    : 'moderate';
  const lead = resolveArrivalLead(input.arrivalLeadMin, input.fieldSize);
  const finishSec = isPositive(input.projectedFinishSec) ? input.projectedFinishSec : 0;

  const leaveMB = addMorning(b, {
    lead,
    travel: Math.max(0, Math.round(Number.isFinite(input.travelMinutes) ? input.travelMinutes : 0)),
    meal,
    weightKg,
  });
  addStartArea(b, { lead, leaveMB, fieldSize: input.fieldSize, includeWarmup: input.includeWarmup === true });
  addPreRaceFuel(b, input.fuelItems);
  addGun(b, input.wave);

  if (finishSec > 0) {
    const distanceMi = resolveDistance(input.distanceMi, input.milePaces);
    addMilestones(b, distanceMi, makeElapsedAt(distanceMi, finishSec, input.milePaces));
    addInRaceFuel(b, input.fuelItems, finishSec);
    addFinishAndRecovery(b, finishSec, weightKg);
  } else {
    b.warnings.push('Add a goal time or a race strategy to see race milestones and your projected finish.');
  }

  const events = b.events.sort((x, y) => x.offsetSec - y.offsetSec);
  return {
    raceName: input.raceName,
    ...(input.raceDate ? { raceDate: input.raceDate } : {}),
    timeZoneLabel: tzLabel ?? null,
    startMinutes: b.startMin,
    arrivalLeadMin: lead,
    events,
    warnings: b.warnings,
    textExport: buildTextExport({
      raceName: input.raceName,
      raceDate: input.raceDate,
      tzLabel: tzLabel ?? null,
      wave: input.wave,
      events,
      warnings: b.warnings,
    }),
  };
}

// ── Pre-race: morning ─────────────────────────────────────────────────────────

/** Alarm, fluids, breakfast (finished ≥ 15 min before leaving), leave. Returns leave minutes-before. */
function addMorning(
  b: Builder,
  o: { lead: number; travel: number; meal: MealPreference; weightKg?: number },
): number {
  const leaveMB = o.lead + o.travel;
  const breakfastMB = Math.max(
    BREAKFAST_IDEAL_MIN_BEFORE,
    leaveMB + BREAKFAST_END_BEFORE_LEAVE_MIN + BREAKFAST_DURATION_MIN,
  );
  const alarmMB = Math.max(breakfastMB + WAKE_TO_BREAKFAST_MIN, leaveMB + MIN_WAKE_TO_LEAVE_MIN);
  const finishEatingBy = formatClock(b.startMin - breakfastMB + BREAKFAST_DURATION_MIN);

  pushAt(b, -alarmMB, 'pre-race', 'wake', 'Alarm — wake up',
    'Bathroom, race kit on, bib pinned (lay everything out the night before).');
  pushAt(b, -(alarmMB - 5), 'pre-race', 'nutrition', 'Drink fluids', fluidsCopy(o.weightKg));
  pushAt(b, -breakfastMB, 'pre-race', 'nutrition', 'Breakfast', breakfastCopy(o.meal, o.weightKg, finishEatingBy));
  if (breakfastMB > BREAKFAST_SNACK_THRESHOLD_MIN) {
    const used = new Set(b.events.map((e) => e.minutesBeforeStart).concat([leaveMB, o.lead]));
    const snackMB = pickFreeMinute([90, 100, 80, 110, 70, 120], used);
    pushAt(b, -snackMB, 'pre-race', 'nutrition', 'Carb snack',
      'Breakfast is more than 4 h before the gun: eat a 30–60g carb snack (banana, bar or sports drink) about 1–2 h before the start — on the way is fine.');
  }
  pushAt(b, -leaveMB, 'pre-race', 'logistics', 'Leave for the start',
    `${o.travel} min to the start area, arriving ${o.lead} min before the gun. Bib, timing chip, gels, phone and a throwaway layer.`);
  return leaveMB;
}

function breakfastCopy(meal: MealPreference, weightKg: number | undefined, finishBy: string): string {
  const gPerKg = MEAL_CARBS_G_PER_KG[meal];
  const carbs = weightKg
    ? `~${Math.round(weightKg * gPerKg)}g carbs (${gPerKg} g/kg)`
    : `about ${gPerKg} g of carbs per kg of body weight (add your weight in your profile to see grams)`;
  return `${MEAL_LABEL[meal]} breakfast: ${carbs}. Finish eating by ${finishBy}, at least 15 min before you leave. ` +
    'Familiar, low-fibre, low-fat foods: oatmeal with banana, a white bagel or toast with honey or jam.';
}

function fluidsCopy(weightKg: number | undefined): string {
  if (!weightKg) {
    return 'Drink about 5–7 mL per kg of body weight (2.3–3.2 mL per lb) of water or sports drink over the next 30–60 min — ideally ≥ 4 h before the start. ' +
      'If your urine is still dark about 2 h before the gun, add 3–5 mL/kg. Add your weight in your profile to see exact amounts.';
  }
  const [lo, hi, topLo, topHi] = [5, 7, 3, 5].map((mlPerKg) => roundTo(weightKg * mlPerKg, 10));
  return `Drink ${lo}–${hi} mL (${toOz(lo)}–${toOz(hi)} oz) of water or sports drink over the next 30–60 min (5–7 mL/kg, ideally ≥ 4 h before the start). ` +
    `If your urine is still dark about 2 h before the gun, add ${topLo}–${topHi} mL (${toOz(topLo)}–${toOz(topHi)} oz). Sips only after that.`;
}

// ── Pre-race: start area ──────────────────────────────────────────────────────

interface StartAreaStep {
  key: 'bag' | 'potty' | 'corral' | 'warmup' | 'lineup';
  desired: number;
  /** Smallest acceptable minutes-before; below it the step is dropped. */
  min: number;
}

/**
 * Arrive → bag check (closes ~45–60 min out) → porta-potty → corral (closes
 * ~15 min out) → optional warm-up ending ~10 min before the gun. Steps are
 * spaced so they never share a minute; short arrival leads drop steps with a
 * warning instead of piling them up.
 */
function addStartArea(
  b: Builder,
  o: { lead: number; leaveMB: number; fieldSize?: number; includeWarmup: boolean },
): void {
  const fieldKnown = typeof o.fieldSize === 'number' && Number.isFinite(o.fieldSize);
  const bigField = fieldKnown && (o.fieldSize as number) >= LARGE_FIELD;
  const hasCorrals = !fieldKnown || (o.fieldSize as number) >= MEDIUM_FIELD;
  const bagCloseMB = bigField ? 60 : 45;

  pushAt(b, -o.lead, 'pre-race', 'logistics', 'Arrive at the start area',
    bigField
      ? 'Allow time for security and the walk to the start village — big races take a while to get through.'
      : 'Find bag check, the porta-potties and your start corral before you need them.');

  const steps: StartAreaStep[] = [
    { key: 'bag', desired: Math.min(o.lead - 10, bagCloseMB + 15), min: 3 },
    { key: 'potty', desired: PORTA_POTTY_MIN, min: 3 },
  ];
  if (hasCorrals) steps.push({ key: 'corral', desired: CORRAL_ENTRY_MIN, min: 3 });
  if (o.includeWarmup) steps.push({ key: 'warmup', desired: WARMUP_START_MIN, min: WARMUP_END_MIN + MIN_WARMUP_DURATION_MIN });
  if (!hasCorrals) steps.push({ key: 'lineup', desired: LINE_UP_MIN, min: 2 });

  let prev = o.lead;
  for (const step of steps) {
    const mb = Math.min(step.desired, prev - START_AREA_STEP_GAP_MIN);
    if (mb < step.min) {
      if (step.key === 'warmup') {
        b.warnings.push(`Not enough time for a warm-up with a ${o.lead}-min arrival — arrive earlier, or use the first mile as your warm-up.`);
      } else {
        b.warnings.push(`A ${o.lead}-min arrival leaves too little time at the start area — arrive earlier.`);
      }
      continue;
    }
    addStartAreaStep(b, step.key, mb, { bagCloseMB, lead: o.lead });
    prev = mb;
  }
}

function addStartAreaStep(
  b: Builder,
  key: StartAreaStep['key'],
  mb: number,
  o: { bagCloseMB: number; lead: number },
): void {
  switch (key) {
    case 'bag':
      if (mb < o.bagCloseMB) {
        b.warnings.push(`Bag check usually closes about ${o.bagCloseMB} min before the gun — with a ${o.lead}-min arrival you may miss it. Arrive earlier or skip the bag.`);
      }
      pushAt(b, -mb, 'pre-race', 'logistics', 'Drop your gear bag',
        `Bag check usually closes about ${o.bagCloseMB} min before the gun (${formatClock(b.startMin - o.bagCloseMB)}). Keep gels, phone/watch and a throwaway layer.`);
      return;
    case 'potty':
      pushAt(b, -mb, 'pre-race', 'logistics', 'Porta-potty stop',
        'Queues at big races take 15–20 min, so join one now. Small sips only from here.');
      return;
    case 'corral':
      pushAt(b, -mb, 'pre-race', 'race', 'Enter your corral',
        `Corrals usually close about ${CORRAL_CLOSE_MIN} min before the gun (${formatClock(b.startMin - CORRAL_CLOSE_MIN)}). Line up with your pace group; stay warm in throwaway layers.`);
      return;
    case 'warmup':
      pushAt(b, -mb, 'pre-race', 'warmup', 'Warmup: easy jog + drills',
        `${mb - WARMUP_END_MIN} min: easy jog or brisk walk, leg swings and drills, then 3–4 relaxed strides — finish about ${WARMUP_END_MIN} min before the gun. ` +
        'In a packed corral, do the drills in place. Optional: many marathoners use the first mile as the warm-up.');
      return;
    case 'lineup':
      pushAt(b, -mb, 'pre-race', 'race', 'Line up at the start',
        'Seed yourself by goal pace — not too close to the front.');
      return;
  }
}

/** Pre-race fuel items (timeSec < 0) or, when `fuelItems` is omitted, a default gel at −15 min. */
function addPreRaceFuel(b: Builder, fuelItems: TimelineFuelItem[] | undefined): void {
  const used = new Set(b.events.map((e) => e.minutesBeforeStart));
  const defaultGel: TimelineFuelItem = { timeSec: -DEFAULT_PRE_RACE_GEL_MIN * 60, distanceMi: 0, label: 'Pre-race gel' };
  const items = fuelItems === undefined
    ? [defaultGel]
    : fuelItems.filter((f) => Number.isFinite(f.timeSec) && f.timeSec < 0);
  for (const item of items) {
    const mb = pickFreeMinute([Math.max(1, Math.round(-item.timeSec / 60))], used);
    used.add(mb);
    const carbs = isPositive(item.carbsG) ? ` (${Math.round(item.carbsG)}g carbs)` : '';
    const note = item.note?.trim() || 'Take it with a few sips of water.';
    pushAt(b, -mb, 'pre-race', 'nutrition', `${item.label}${carbs}`, note);
  }
}

// ── Race ──────────────────────────────────────────────────────────────────────

function addGun(b: Builder, wave: string | undefined): void {
  const waveText = wave?.trim() ? ` Your start: ${wave.trim()}.` : '';
  pushSec(b, 0, 'race', 'race', 'Gun time — race start',
    `Start controlled: the first mile should feel easy — don't chase the crowd.${waveText}`);
}

function resolveDistance(distanceMi: number | undefined, milePaces: MilePacePlan[] | undefined): number {
  if (isPositive(distanceMi)) return distanceMi;
  const last = milePaces?.[milePaces.length - 1];
  return last && isPositive(last.mile) ? last.mile : DEFAULT_DISTANCE_MI;
}

/** Elapsed seconds at a distance: the plan's shape scaled to the projected finish, else even pace. */
function makeElapsedAt(
  distanceMi: number,
  finishSec: number,
  milePaces: MilePacePlan[] | undefined,
): (mi: number) => number {
  if (milePaces && milePaces.length > 0) {
    const planFinish = milePaces[milePaces.length - 1].cumulativeTimeSec;
    const scale = planFinish > 0 ? finishSec / planFinish : 1;
    return (mi) => timeAtDistance(milePaces, mi) * scale;
  }
  return (mi) => (finishSec / distanceMi) * Math.min(mi, distanceMi);
}

interface Milestone { mi: number; title: string; tip: string }

/** 5K, 10K, halfway and — for a marathon only — 20 mi / 30K with the wall-zone copy. */
function addMilestones(b: Builder, distanceMi: number, elapsedAt: (mi: number) => number): void {
  const isMarathon = distanceMi >= MARATHON_RANGE_MI[0] && distanceMi <= MARATHON_RANGE_MI[1];
  const list: Milestone[] = [
    { mi: 5 / KM_PER_MI, title: '5K', tip: 'Check in: relaxed breathing, on pace, not ahead of it.' },
    { mi: 10 / KM_PER_MI, title: '10K', tip: 'Should still feel comfortable. Keep your rhythm and keep fueling.' },
  ];
  const half = distanceMi / 2;
  if (list.every((m) => Math.abs(m.mi - half) > 0.25)) {
    list.push({
      mi: half,
      title: isMarathon ? 'Half marathon' : 'Halfway',
      tip: "Check your time. Feeling great? Hold steady — don't accelerate yet.",
    });
  }
  if (isMarathon) {
    list.push(b.unit === 'km'
      ? { mi: 30 / KM_PER_MI, title: '30K', tip: wallZoneTip('12 km') }
      : { mi: 20, title: '20 mi', tip: wallZoneTip('10K') });
  }
  for (const m of list.filter((x) => x.mi < distanceMi - 0.05).sort((x, y) => x.mi - y.mi)) {
    const elapsed = elapsedAt(m.mi);
    pushSec(b, elapsed, 'race', 'milestone', m.title,
      `Projected ${formatDurationSec(elapsed)} at ${formatDistance(m.mi, b.unit)}. ${m.tip}`);
  }
}

function wallZoneTip(toGo: string): string {
  return `Wall zone: glycogen runs low around here for many runners. Keep taking your fuel on schedule, relax your shoulders and focus on form — ${toGo} to go.`;
}

/** In-race fuel items at gun + timeSec (time-based; never respaced by mile). */
function addInRaceFuel(b: Builder, fuelItems: TimelineFuelItem[] | undefined, finishSec: number): void {
  for (const item of fuelItems ?? []) {
    if (!Number.isFinite(item.timeSec) || item.timeSec < 0 || item.timeSec > finishSec) continue;
    const carbs = isPositive(item.carbsG) ? ` (${Math.round(item.carbsG)}g carbs)` : '';
    const where = Number.isFinite(item.distanceMi) && item.distanceMi > 0
      ? `, around ${formatDistance(item.distanceMi, b.unit)}`
      : '';
    const note = item.note?.trim() ? ` ${item.note.trim()}.` : ' Take it with water at the nearest aid station.';
    pushSec(b, item.timeSec, 'race', 'fueling', `${item.label}${carbs}`,
      `${formatDurationSec(item.timeSec)} into the race${where}.${note}`);
  }
}

function addFinishAndRecovery(b: Builder, finishSec: number, weightKg: number | undefined): void {
  pushSec(b, finishSec, 'race', 'milestone', 'Projected finish',
    `Projected time ${formatDurationSec(finishSec)}. Keep walking through the finish area.`);
  const carbs = weightKg
    ? `~${roundTo(weightKg, 5)}–${roundTo(weightKg * 1.2, 5)}g carbs (1–1.2 g/kg)`
    : 'carbs (about 1–1.2 g per kg of body weight)';
  pushSec(b, finishSec + RECOVERY_AFTER_FINISH_MIN * 60, 'post-race', 'nutrition', 'Recovery: refuel and rehydrate',
    `Keep walking. Within 30–60 min: fluids with electrolytes, ${carbs} and 20–25g protein. Warm layers on — you'll cool quickly.`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPositive(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function toOz(ml: number): number {
  return Math.round(ml / ML_PER_FL_OZ);
}

function formatDistance(mi: number, unit: 'mi' | 'km'): string {
  return unit === 'km' ? `${(mi * KM_PER_MI).toFixed(1)} km` : `${mi.toFixed(1)} mi`;
}

/** First candidate (minutes-before) not already used; otherwise nudge earlier until free. */
function pickFreeMinute(candidates: number[], used: Set<number>): number {
  const free = candidates.find((c) => !used.has(c));
  if (free !== undefined) return free;
  let mb = candidates[0];
  while (used.has(mb)) mb += 1;
  return mb;
}

/** Push an event at a whole-minute offset (negative = before the gun). */
function pushAt(b: Builder, offsetMin: number, phase: TimelinePhase, category: TimelineCategory, title: string, description: string): void {
  pushSec(b, offsetMin * 60, phase, category, title, description);
}

function pushSec(b: Builder, offsetSec: number, phase: TimelinePhase, category: TimelineCategory, title: string, description: string): void {
  const offsetMin = Math.round(offsetSec / 60);
  const clockMinutes = b.startMin + offsetMin;
  b.events.push({
    time: formatClock(clockMinutes),
    title,
    description,
    category,
    minutesBeforeStart: -offsetMin + 0, // `+ 0` normalises -0 to 0
    offsetSec,
    clockMinutes,
    phase,
  });
}

/** "h:mm AM" for race-local minutes after midnight; marks times that cross midnight. */
function formatClock(clockMinutes: number): string {
  const day = Math.floor(clockMinutes / 1440);
  const m = ((clockMinutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const base = `${h12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  if (day < 0) return `${base} (day before)`;
  if (day > 0) return `${base} (next day)`;
  return base;
}

function buildTextExport(t: {
  raceName: string;
  raceDate?: string;
  tzLabel: string | null;
  wave?: string;
  events: TimelineEvent[];
  warnings: string[];
}): string {
  const lines = [`RACE DAY TIMELINE — ${t.raceName}`];
  const meta = [t.raceDate ? `Race date: ${t.raceDate}` : '', t.wave?.trim() ? `Start: ${t.wave.trim()}` : '']
    .filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '));
  lines.push(t.tzLabel ? `Times are race-local (${t.tzLabel})` : 'Times are race-local');
  lines.push('═'.repeat(40), '');
  for (const phase of PHASE_ORDER) {
    const events = t.events.filter((e) => e.phase === phase);
    if (events.length === 0) continue;
    lines.push(PHASE_TITLES[phase].toUpperCase());
    for (const e of events) {
      lines.push(`${e.time.padStart(8)}  ${e.title}`);
      lines.push(`          ${e.description}`);
    }
    lines.push('');
  }
  if (t.warnings.length) {
    lines.push('NOTES');
    for (const w of t.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  lines.push('═'.repeat(40));
  lines.push('Generated by Apollo Running');
  return lines.join('\n');
}
