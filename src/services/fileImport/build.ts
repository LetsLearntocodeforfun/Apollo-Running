/**
 * Turns parsed activity files into Apollo's canonical `Activity`.
 *
 * Every parser (FIT, GPX, TCX) produces neutral `ParsedActivity` records;
 * this module derives everything the rest of the app expects from a synced
 * activity — IDs, UTC and local start times, distance / moving / elapsed
 * time, speeds, heart rate, elevation gain, cadence (running cadence in
 * strides/min), power, the route polyline, per-km / per-mile splits and
 * device laps — so imported workouts flow through the same analytics,
 * training-plan matching and deduplication as intervals.icu / Strava data.
 *
 * Values the device reported (totals) always win over values derived from
 * samples. Derivations are deliberately conservative: GPS distance skips
 * glitches, moving time ignores stops and pauses, and elevation gain uses a
 * hysteresis so GPS altitude noise doesn't add phantom climbing.
 */

import type { Activity, ActivityLap, ActivitySplit } from '../activity/types';
import { formatSportType, isRunActivity } from '../activity/sports';
import {
  cleanLatLngs,
  decimate,
  deriveSplits,
  encodePolyline,
  type LatLngPair,
  type StreamSample,
} from '../activity/streams';
import type { ParsedActivity, ParsedLap, ParsedSample } from './types';

/**
 * File imports get their own numeric ID range (FILE_ID_OFFSET + start epoch
 * seconds) so they never collide with Strava IDs or intervals.icu IDs
 * (offset 1e14) in the shared store — and the same workout imported twice
 * (or as FIT and GPX) maps to the same record.
 */
export const FILE_ID_OFFSET = 3e14;

/** Points kept for the stored route (lists, maps, effort recognition). */
const SUMMARY_MAX_POINTS = 500;
/** Slower than this counts as stopped (matches activity/streams.ts). */
const MOVING_SPEED_MPS = 0.5;
/** Longer gaps between samples are pauses (auto-pause / timer stopped). */
const MAX_SAMPLE_GAP_SEC = 60;
/** Climbs / descents smaller than this are treated as altitude noise. */
const ELEVATION_HYSTERESIS_M = 3;
/** Shorter workouts without any distance are discarded as accidental recordings. */
const MIN_DURATION_SEC = 60;
/** GPS jumps implying more than this speed (360 km/h) are ignored. */
const MAX_PLAUSIBLE_SPEED_MPS = 100;
/** Max speed derived from positions uses windows of at least this many seconds. */
const MAX_SPEED_WINDOW_SEC = 5;
/** Average speed above which an untyped workout is assumed to be a ride (faster than any marathon pace). */
const RIDE_SPEED_MPS = 6;
/** Average speed below which an untyped workout is assumed to be a walk (slower than 10:25 min/km). */
const WALK_SPEED_MPS = 1.6;
const MIN_HEART_RATE = 25;
const MAX_HEART_RATE = 250;
const MIN_LAPS = 2;
const MAX_LAPS = 100;
/** Activities starting before this are clock errors (FIT's epoch is 1989-12-31). */
const EARLIEST_START_MS = Date.UTC(1990, 0, 1);
const MAX_UTC_OFFSET_SEC = 18 * 3600;
const MILE_M = 1609.344;

// ── Sport types ───────────────────────────────────────────────────────────────

/** A sport type in Strava / intervals.icu vocabulary, plus whether the name implies indoor. */
export interface SportInfo {
  /** e.g. "Run", "TrailRun", "VirtualRide"; '' when unknown. */
  type: string;
  trainer?: boolean;
}

/**
 * Aliases (lower-case, non-alphanumerics removed) → sport type. Covers
 * Strava / intervals.icu names and display names ("Virtual Ride"), Garmin
 * activity keys ("trail_running", "lap_swimming"), TCX sports ("Biking") and
 * common app spellings. Canonical names map to themselves.
 */
const SPORT_ALIASES: Record<string, string> = {
  run: 'Run', running: 'Run', roadrunning: 'Run', streetrunning: 'Run', trackrunning: 'Run',
  ultrarun: 'Run', ultrarunning: 'Run', obstaclerun: 'Run', jogging: 'Run',
  trailrun: 'TrailRun', trailrunning: 'TrailRun',
  virtualrun: 'VirtualRun', virtualrunning: 'VirtualRun',
  treadmill: 'Run', treadmillrun: 'Run', treadmillrunning: 'Run', indoorrun: 'Run', indoorrunning: 'Run',
  ride: 'Ride', cycling: 'Ride', biking: 'Ride', bike: 'Ride', roadbiking: 'Ride', roadcycling: 'Ride',
  roadride: 'Ride', cyclocross: 'Ride', bmx: 'Ride', recumbentcycling: 'Ride', commuting: 'Ride',
  indoorcycling: 'Ride', indoorbiking: 'Ride', indoorride: 'Ride', spinning: 'Ride',
  virtualride: 'VirtualRide', virtualcycling: 'VirtualRide', virtualbiking: 'VirtualRide',
  mountainbikeride: 'MountainBikeRide', mountainbiking: 'MountainBikeRide', mountainbike: 'MountainBikeRide',
  mtb: 'MountainBikeRide', downhillbiking: 'MountainBikeRide', enduromtb: 'MountainBikeRide',
  gravelride: 'GravelRide', gravelcycling: 'GravelRide', gravelbiking: 'GravelRide', gravel: 'GravelRide',
  ebikeride: 'EBikeRide', ebike: 'EBikeRide', ebiking: 'EBikeRide', ebikefitness: 'EBikeRide',
  emountainbikeride: 'EMountainBikeRide', emountainbiking: 'EMountainBikeRide', ebikemountain: 'EMountainBikeRide',
  trackride: 'TrackRide', trackcycling: 'TrackRide', handcycle: 'Handcycle', handcycling: 'Handcycle',
  velomobile: 'Velomobile',
  swim: 'Swim', swimming: 'Swim', lapswimming: 'Swim', poolswim: 'Swim', poolswimming: 'Swim',
  openwaterswim: 'OpenWaterSwim', openwaterswimming: 'OpenWaterSwim',
  walk: 'Walk', walking: 'Walk', casualwalking: 'Walk', speedwalking: 'Walk', fitnesswalking: 'Walk',
  indoorwalking: 'Walk',
  hike: 'Hike', hiking: 'Hike', mountaineering: 'Hike',
  weighttraining: 'WeightTraining', strengthtraining: 'WeightTraining', strength: 'WeightTraining',
  weights: 'WeightTraining',
  workout: 'Workout', other: 'Workout', generic: 'Workout', training: 'Workout', cardio: 'Workout',
  indoorcardio: 'Workout', cardiotraining: 'Workout', fitnessequipment: 'Workout', multisport: 'Workout',
  transition: 'Workout', breathwork: 'Workout',
  hiit: 'HighIntensityIntervalTraining', highintensityintervaltraining: 'HighIntensityIntervalTraining',
  crossfit: 'Crossfit', yoga: 'Yoga', pilates: 'Pilates',
  rowing: 'Rowing', rower: 'Rowing', indoorrowing: 'Rowing', virtualrow: 'VirtualRow',
  elliptical: 'Elliptical', stairstepper: 'StairStepper', stairclimbing: 'StairStepper', stairs: 'StairStepper',
  alpineski: 'AlpineSki', resortskiing: 'AlpineSki', resortskiingsnowboarding: 'AlpineSki',
  downhillskiing: 'AlpineSki', skiing: 'AlpineSki',
  backcountryski: 'BackcountrySki', backcountryskiing: 'BackcountrySki',
  backcountryskiingsnowboarding: 'BackcountrySki',
  nordicski: 'NordicSki', crosscountryskiing: 'NordicSki', crosscountryclassicskiing: 'NordicSki',
  crosscountryskateskiing: 'NordicSki', skateskiing: 'NordicSki',
  rollerski: 'RollerSki', rollerskiing: 'RollerSki',
  snowboard: 'Snowboard', snowboarding: 'Snowboard', snowshoe: 'Snowshoe', snowshoeing: 'Snowshoe',
  iceskate: 'IceSkate', iceskating: 'IceSkate', inlineskate: 'InlineSkate', inlineskating: 'InlineSkate',
  kayaking: 'Kayaking', kayak: 'Kayaking', whitewaterkayaking: 'Kayaking', canoeing: 'Canoeing',
  canoe: 'Canoeing', standuppaddling: 'StandUpPaddling', standuppaddleboarding: 'StandUpPaddling',
  sup: 'StandUpPaddling', surfing: 'Surfing', kitesurf: 'Kitesurf', kitesurfing: 'Kitesurf',
  kiteboarding: 'Kitesurf', windsurf: 'Windsurf', windsurfing: 'Windsurf', sail: 'Sail', sailing: 'Sail',
  rockclimbing: 'RockClimbing', climbing: 'RockClimbing', bouldering: 'RockClimbing',
  indoorclimbing: 'RockClimbing',
  golf: 'Golf', soccer: 'Soccer', football: 'Soccer', tennis: 'Tennis', squash: 'Squash',
  badminton: 'Badminton', pickleball: 'Pickleball', tabletennis: 'TableTennis', racquetball: 'Racquetball',
  wheelchair: 'Wheelchair', skateboard: 'Skateboard', skateboarding: 'Skateboard',
};

/** Aliases that imply an indoor / trainer session. */
const INDOOR_ALIASES = new Set([
  'treadmill', 'treadmillrun', 'treadmillrunning', 'indoorrun', 'indoorrunning', 'indoorcycling',
  'indoorbiking', 'indoorride', 'spinning', 'virtualride', 'virtualcycling', 'virtualbiking',
  'virtualrun', 'virtualrunning', 'indoorrowing', 'virtualrow', 'indoorwalking',
]);

/** `<type>` codes used in Strava's GPX exports. */
const STRAVA_GPX_CODES: Record<string, string> = { '1': 'Ride', '4': 'Hike', '9': 'Run', '10': 'Walk' };

/**
 * Normalize a sport name from any source to the Strava / intervals.icu
 * vocabulary: "running" → Run, "Biking" → Ride, "Virtual Ride" → VirtualRide,
 * "treadmill_running" → Run (trainer), Strava GPX "9" → Run. Unknown names
 * are kept, PascalCased ("floor_climbing" → "FloorClimbing"); blank → ''.
 */
export function normalizeSportType(raw: string | null | undefined): SportInfo {
  const text = (raw ?? '').trim();
  if (!text) return { type: '' };
  if (/^\d+$/.test(text)) return { type: STRAVA_GPX_CODES[text] ?? '' };
  const key = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mapped = SPORT_ALIASES[key];
  if (mapped) return INDOOR_ALIASES.has(key) ? { type: mapped, trainer: true } : { type: mapped };
  const words = text.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const type = words
    .map((w) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
  return { type };
}

const ORIGIN_PATTERNS: [RegExp, string][] = [
  [/garmin|forerunner|f[eē]nix|\bedge\b|epix|vivoactive|v[ií]vo|\bvenu\b|instinct|enduro|approach|descent/i, 'GARMIN'],
  [/coros/i, 'COROS'],
  [/suunto/i, 'SUUNTO'],
  [/polar/i, 'POLAR'],
  [/wahoo|elemnt/i, 'WAHOO'],
  [/zwift/i, 'ZWIFT'],
  [/strava/i, 'STRAVA'],
  [/apple|iphone|healthfit|workoutdoors/i, 'APPLE'],
  [/amazfit|zepp/i, 'AMAZFIT'],
  [/huawei/i, 'HUAWEI'],
  [/samsung|galaxy watch/i, 'SAMSUNG'],
  [/fitbit/i, 'FITBIT'],
  [/hammerhead|karoo/i, 'HAMMERHEAD'],
  [/bryton/i, 'BRYTON'],
  [/runkeeper/i, 'RUNKEEPER'],
  [/komoot/i, 'KOMOOT'],
];

/** Guess the upstream platform from a device / creator name ("Forerunner 965" → GARMIN). */
export function originFromName(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  for (const [pattern, origin] of ORIGIN_PATTERNS) if (pattern.test(name)) return origin;
  return undefined;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function finite(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function positive(v: number | null | undefined): number | undefined {
  return finite(v) && v > 0 ? v : undefined;
}

function round(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function validHeartRate(v: number | undefined): number | undefined {
  return finite(v) && v >= MIN_HEART_RATE && v <= MAX_HEART_RATE ? v : undefined;
}

function stripUndefined<T extends object>(obj: T): T {
  const rec = obj as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (rec[k] === undefined) delete rec[k];
  return obj;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "YYYY-MM-DDTHH:MM:SSZ" from UTC getters (`utc`) or the machine's local time zone. */
function formatWallClock(d: Date, utc: boolean): string {
  const y = utc ? d.getUTCFullYear() : d.getFullYear();
  const mo = utc ? d.getUTCMonth() : d.getMonth();
  const day = utc ? d.getUTCDate() : d.getDate();
  const h = utc ? d.getUTCHours() : d.getHours();
  const mi = utc ? d.getUTCMinutes() : d.getMinutes();
  const s = utc ? d.getUTCSeconds() : d.getSeconds();
  return `${String(y).padStart(4, '0')}-${pad2(mo + 1)}-${pad2(day)}T${pad2(h)}:${pad2(mi)}:${pad2(s)}Z`;
}

/** Same naming as intervals.ts: "Morning Run", "Evening Ride"… from the LOCAL start hour. */
function defaultName(type: string, startLocal: string): string {
  const hour = Number(startLocal.slice(11, 13));
  const part = hour >= 5 && hour < 12 ? 'Morning'
    : hour >= 12 && hour < 17 ? 'Afternoon'
    : hour >= 17 && hour < 21 ? 'Evening'
    : 'Night';
  return `${part} ${formatSportType(type)}`;
}

/** Per-km / per-mile splits only make sense for pace-based sports (as on Strava, where only runs get them). */
function hasPaceSplits(type: string): boolean {
  return isRunActivity({ type }) || type === 'Walk' || type === 'Hike';
}

/** Sport of a workout whose file names none, from its average moving speed. */
function inferSport(distance: number, moving: number): string {
  if (!(distance > 0) || !(moving > 0)) return 'Workout';
  const speed = distance / moving;
  return speed > RIDE_SPEED_MPS ? 'Ride' : speed < WALK_SPEED_MPS ? 'Walk' : 'Run';
}

// ── Sample-derived metrics ────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6371008.8;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function hasPosition(s: ParsedSample): s is ParsedSample & { lat: number; lng: number } {
  return finite(s.lat) && finite(s.lng) && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180 && !(s.lat === 0 && s.lng === 0);
}

/** Samples with a valid time, in chronological order. */
function prepareSamples(raw: ParsedSample[] | undefined): ParsedSample[] {
  if (!Array.isArray(raw)) return [];
  const samples = raw.filter((s) => s && finite(s.time));
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].time < samples[i - 1].time) return samples.sort((a, b) => a.time - b.time);
  }
  return samples;
}

/**
 * Cumulative distance per sample: the device's own distance when most samples
 * carry it (kept non-decreasing), else accumulated GPS distance (skipping
 * implausible jumps), else null.
 */
function distanceStream(samples: ParsedSample[]): number[] | null {
  const n = samples.length;
  if (n < 2) return null;
  let withDistance = 0;
  let withPosition = 0;
  for (const s of samples) {
    if (finite(s.distance) && s.distance >= 0) withDistance++;
    if (hasPosition(s)) withPosition++;
  }
  const out = new Array<number>(n);
  if (withDistance >= 2 && withDistance >= n / 2) {
    let last = samples.find((s) => finite(s.distance) && s.distance >= 0)?.distance ?? 0;
    for (let i = 0; i < n; i++) {
      const d = samples[i].distance;
      if (finite(d) && d > last) last = d;
      out[i] = last;
    }
    return out;
  }
  if (withPosition < 2) return null;
  let total = 0;
  let prev: (ParsedSample & { lat: number; lng: number }) | null = null;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (hasPosition(s)) {
      if (prev) {
        const step = haversineMeters(prev.lat, prev.lng, s.lat, s.lng);
        const dt = (s.time - prev.time) / 1000;
        // A jump faster than any human-powered sport is a GPS glitch: skip the point.
        if (dt > 0 ? step / dt <= MAX_PLAUSIBLE_SPEED_MPS : step < 5) {
          total += step;
          prev = s;
        }
      } else {
        prev = s;
      }
    }
    out[i] = total;
  }
  return out;
}

/**
 * Moving time: intervals of at most 60 s whose speed is at least 0.5 m/s
 * (from the distance stream, else the recorded speed). Without any distance
 * or speed data, every interval that isn't a pause counts.
 */
function movingTimeSec(samples: ParsedSample[], times: number[], dist: number[] | null): number {
  let moving = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = times[i] - times[i - 1];
    if (!(dt > 0) || dt > MAX_SAMPLE_GAP_SEC) continue;
    let speed: number | undefined;
    if (dist) speed = (dist[i] - dist[i - 1]) / dt;
    else if (finite(samples[i].speed)) speed = samples[i].speed;
    if (speed === undefined || speed >= MOVING_SPEED_MPS) moving += dt;
  }
  return moving;
}

/** Average of a channel weighted by sample interval (pauses excluded); plain mean as fallback. */
function timeWeightedMean(samples: ParsedSample[], pick: (s: ParsedSample) => number | undefined): number | undefined {
  let sum = 0;
  let weight = 0;
  let plainSum = 0;
  let plainCount = 0;
  let prevTime = NaN;
  for (const s of samples) {
    const v = pick(s);
    if (v !== undefined) {
      plainSum += v;
      plainCount++;
      const dt = (s.time - prevTime) / 1000;
      if (dt > 0 && dt <= MAX_SAMPLE_GAP_SEC) {
        sum += v * dt;
        weight += dt;
      }
    }
    prevTime = s.time;
  }
  if (weight > 0) return sum / weight;
  return plainCount > 0 ? plainSum / plainCount : undefined;
}

function maxOf(samples: ParsedSample[], pick: (s: ParsedSample) => number | undefined): number | undefined {
  let max: number | undefined;
  for (const s of samples) {
    const v = pick(s);
    if (v !== undefined && (max === undefined || v > max)) max = v;
  }
  return max;
}

/** Max speed: the recorded speed channel, else the fastest ≥ 5 s window of the distance stream. */
function sampleMaxSpeed(samples: ParsedSample[], times: number[], dist: number[] | null): number | undefined {
  const recorded = maxOf(samples, (s) => (finite(s.speed) && s.speed >= 0 && s.speed < MAX_PLAUSIBLE_SPEED_MPS ? s.speed : undefined));
  if (recorded !== undefined) return recorded > 0 ? recorded : undefined;
  if (!dist) return undefined;
  let max = 0;
  let j = 0;
  for (let i = 1; i < times.length; i++) {
    while (j + 1 < i && times[i] - times[j + 1] >= MAX_SPEED_WINDOW_SEC) j++;
    const dt = times[i] - times[j];
    if (dt < MAX_SPEED_WINDOW_SEC || dt > MAX_SAMPLE_GAP_SEC) continue;
    const v = (dist[i] - dist[j]) / dt;
    if (v > max && v < MAX_PLAUSIBLE_SPEED_MPS) max = v;
  }
  return max > 0 ? max : undefined;
}

/**
 * Elevation gain with hysteresis: altitude must reverse by at least
 * `threshold` meters before a climb (or descent) counts as finished, so GPS /
 * barometer jitter adds nothing while every real climb counts in full.
 */
export function elevationGain(altitudes: number[], threshold: number = ELEVATION_HYSTERESIS_M): number {
  const alts = altitudes.filter(finite);
  if (alts.length < 2) return 0;
  let gain = 0;
  let direction = 0; // 1 climbing, -1 descending, 0 not yet known
  let turn = alts[0]; // last confirmed turning point
  let extreme = alts[0]; // highest (climbing) / lowest (descending) point since `turn`
  let low = alts[0];
  let high = alts[0];
  let lowIndex = 0;
  let highIndex = 0;
  for (let i = 1; i < alts.length; i++) {
    const a = alts[i];
    if (direction === 0) {
      if (a < low) { low = a; lowIndex = i; }
      if (a > high) { high = a; highIndex = i; }
      if (high - low >= threshold) {
        direction = highIndex > lowIndex ? 1 : -1;
        turn = direction === 1 ? low : high;
        extreme = direction === 1 ? high : low;
      }
    } else if (direction === 1) {
      if (a > extreme) extreme = a;
      else if (extreme - a >= threshold) {
        gain += extreme - turn;
        turn = extreme;
        extreme = a;
        direction = -1;
      }
    } else if (a < extreme) {
      extreme = a;
    } else if (a - extreme >= threshold) {
      turn = extreme;
      extreme = a;
      direction = 1;
    }
  }
  if (direction === 1) gain += extreme - turn;
  return round(gain, 1);
}

/**
 * Normalized power: 30 s rolling average of a 1 Hz power series (pauses
 * skipped), raised to the 4th power, averaged, 4th root.
 */
function normalizedPower(samples: ParsedSample[]): number | undefined {
  const series: number[] = [];
  let prev: ParsedSample | null = null;
  for (const s of samples) {
    if (!finite(s.power) || s.power < 0) continue;
    if (prev) {
      const dt = Math.round((s.time - prev.time) / 1000);
      if (dt > 0 && dt <= MAX_SAMPLE_GAP_SEC) for (let k = 0; k < dt; k++) series.push(s.power);
    }
    prev = s;
    if (series.length > 3 * 86400) return undefined;
  }
  if (series.length < 30) return undefined;
  let window = 0;
  let sum4 = 0;
  let count = 0;
  for (let i = 0; i < series.length; i++) {
    window += series[i];
    if (i >= 30) window -= series[i - 30];
    if (i >= 29) {
      sum4 += (window / 30) ** 4;
      count++;
    }
  }
  return Math.round(Math.pow(sum4 / count, 0.25));
}

/** Index of the first sample at or after `time` (samples sorted). */
function lowerBound(samples: ParsedSample[], time: number): number {
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (samples[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ── Laps ──────────────────────────────────────────────────────────────────────

function toActivityLaps(
  parsed: ParsedLap[] | undefined,
  samples: ParsedSample[],
  isRun: boolean,
  cadenceFactor: number | undefined,
): ActivityLap[] | undefined {
  if (!Array.isArray(parsed)) return undefined;
  const laps = parsed
    .filter((l) => l && finite(l.startTime) && ((positive(l.elapsedSec) ?? 0) >= 1 || (positive(l.distance) ?? 0) >= 1))
    .sort((a, b) => a.startTime - b.startTime);
  if (laps.length < MIN_LAPS || laps.length > MAX_LAPS) return undefined;

  const n = samples.length;
  const starts = laps.map((l) => Math.min(Math.max(0, n - 1), lowerBound(samples, l.startTime)));
  return laps.map((l, i) => {
    const startIndex = n ? starts[i] : 0;
    const endIndex = n ? (i + 1 < laps.length ? Math.max(startIndex, starts[i + 1] - 1) : n - 1) : 0;
    const slice = n ? samples.slice(startIndex, endIndex + 1) : [];
    const elapsed = positive(l.elapsedSec) ?? 0;
    const moving = positive(l.movingSec) ?? elapsed;
    const distance = finite(l.distance) && l.distance > 0 ? l.distance : 0;
    const avgCadence = positive(l.avgCadence);
    const factor = cadenceFactor ?? (isRun && avgCadence !== undefined && avgCadence > 120 ? 0.5 : 1);
    const avgHr = positive(l.avgHeartRate) ?? timeWeightedMean(slice, (s) => validHeartRate(s.heartRate));
    const maxHr = positive(l.maxHeartRate) ?? maxOf(slice, (s) => validHeartRate(s.heartRate));
    const ascent = finite(l.ascent) && l.ascent >= 0
      ? l.ascent
      : slice.length >= 2 ? elevationGain(slice.map((s) => s.altitude ?? NaN)) : 0;
    return stripUndefined<ActivityLap>({
      id: i + 1,
      name: l.name?.trim() || `Lap ${i + 1}`,
      lap_index: i,
      split: i + 1,
      distance: round(distance, 1),
      elapsed_time: Math.round(elapsed),
      moving_time: Math.round(moving),
      average_speed: round(positive(l.avgSpeed) ?? (moving > 0 ? distance / moving : 0), 3),
      max_speed: round(positive(l.maxSpeed) ?? 0, 3),
      average_heartrate: avgHr !== undefined ? round(avgHr, 1) : undefined,
      max_heartrate: maxHr !== undefined ? Math.round(maxHr) : undefined,
      average_cadence: avgCadence !== undefined ? round(avgCadence * factor, 1) : undefined,
      total_elevation_gain: round(ascent, 1),
      start_index: startIndex,
      end_index: endIndex,
    });
  });
}

// ── Conversion ────────────────────────────────────────────────────────────────

/** Overrides and identity for `toActivity`. */
export interface ToActivityOptions {
  /** Name of the file the workout came from (diagnostics only; not stored). */
  fileName: string;
  /** Store ID, e.g. the Strava activity ID of a Strava-archive row. Default: FILE_ID_OFFSET + start epoch seconds. */
  id?: number;
  /** Provider-native ID; default `file:<startEpochSec>`. Strava-archive rows use `strava:<id>`. */
  sourceId?: string;
  /** Name from archive metadata — wins over the name stored in the file. */
  name?: string;
  /** Sport type from archive metadata, raw or canonical ("Virtual Ride", "trail_running", "Run"). */
  type?: string;
  /** Upstream platform, e.g. "STRAVA" — wins over the file's own origin. */
  origin?: string;
}

/**
 * Convert a parsed workout into Apollo's canonical `Activity` (source 'file').
 * Returns null for unusable records: no plausible start time, or shorter than
 * a minute without any distance.
 */
export function toActivity(p: ParsedActivity, opts: ToActivityOptions): Activity | null {
  if (!p || !finite(p.startTime) || p.startTime < EARLIEST_START_MS) return null;
  const startMs = Math.floor(p.startTime / 1000) * 1000;
  const startSec = startMs / 1000;
  const totals = p.totals ?? {};
  const laps = Array.isArray(p.laps) ? p.laps : [];

  const samples = prepareSamples(p.samples);
  const n = samples.length;
  const times = samples.map((s) => (s.time - startMs) / 1000);
  const dist = distanceStream(samples);

  // ── Distance & durations (device totals first) ──
  const streamDistance = dist ? dist[n - 1] - dist[0] : 0;
  const lapDistance = laps.reduce((sum, l) => sum + (positive(l?.distance) ?? 0), 0);
  const distance = positive(totals.distance)
    ?? (streamDistance > 0 ? streamDistance : undefined)
    ?? (lapDistance > 0 ? lapDistance : 0);

  const span = n >= 2 ? (samples[n - 1].time - Math.min(startMs, samples[0].time)) / 1000 : 0;
  const lapElapsed = laps.reduce((sum, l) => sum + (positive(l?.elapsedSec) ?? 0), 0);
  let elapsed = positive(totals.elapsedSec)
    ?? (span > 0 ? span : undefined)
    ?? positive(totals.movingSec)
    ?? (lapElapsed > 0 ? lapElapsed : 0);

  const derivedMoving = n >= 2 ? movingTimeSec(samples, times, dist) : 0;
  const lapMoving = laps.reduce((sum, l) => sum + (positive(l?.movingSec) ?? positive(l?.elapsedSec) ?? 0), 0);
  const moving = positive(totals.movingSec)
    ?? (derivedMoving > 0 ? derivedMoving : undefined)
    ?? (lapMoving > 0 ? lapMoving : elapsed);
  if (moving > elapsed) elapsed = moving;

  if (elapsed < MIN_DURATION_SEC && moving < MIN_DURATION_SEC && !(distance > 0)) return null;

  // ── Identity ──
  const metaSport = normalizeSportType(opts.type);
  const fileSport = normalizeSportType(p.type);
  let type = metaSport.type || fileSport.type;
  if (!type) type = inferSport(distance, moving);
  const trainer = typeof p.trainer === 'boolean'
    ? p.trainer
    : metaSport.trainer || fileSport.trainer || type.startsWith('Virtual') ? true : undefined;

  const offset = finite(p.utcOffsetSec) && Math.abs(p.utcOffsetSec) <= MAX_UTC_OFFSET_SEC ? Math.round(p.utcOffsetSec) : undefined;
  const startLocal = offset !== undefined
    ? formatWallClock(new Date(startMs + offset * 1000), true)
    : formatWallClock(new Date(startMs), false);
  const id = finite(opts.id) && Number.isSafeInteger(opts.id) && opts.id > 0 ? opts.id : FILE_ID_OFFSET + startSec;
  const isRun = isRunActivity({ type });

  // ── Heart rate, cadence, power, elevation ──
  const avgHr = positive(totals.avgHeartRate) ?? timeWeightedMean(samples, (s) => validHeartRate(s.heartRate));
  const maxHr = positive(totals.maxHeartRate) ?? maxOf(samples, (s) => validHeartRate(s.heartRate));
  const rawCadence = positive(totals.avgCadence)
    ?? timeWeightedMean(samples, (s) => (finite(s.cadence) && s.cadence > 0 ? s.cadence : undefined));
  // Running cadence is stored as strides/min; anything above 120 can only be steps/min.
  const cadenceFactor = rawCadence === undefined ? undefined : isRun && rawCadence > 120 ? 0.5 : 1;
  const hasPower = samples.some((s) => finite(s.power) && s.power > 0);
  const avgWatts = positive(totals.avgPower)
    ?? (hasPower ? timeWeightedMean(samples, (s) => (finite(s.power) && s.power >= 0 ? s.power : undefined)) : undefined);
  const weightedWatts = positive(totals.normalizedPower) ?? (hasPower ? normalizedPower(samples) : undefined);
  const altitudes = samples.map((s) => s.altitude ?? NaN).filter(finite);
  const elevation = finite(totals.ascent) && totals.ascent >= 0
    ? totals.ascent
    : altitudes.length >= 2 ? elevationGain(altitudes) : undefined;
  const avgSpeed = positive(totals.avgSpeed) ?? (moving > 0 && distance > 0 ? distance / moving : undefined);
  const maxSpeed = positive(totals.maxSpeed) ?? sampleMaxSpeed(samples, times, dist);

  // ── Route ──
  const latlngs: LatLngPair[] = cleanLatLngs(samples.filter(hasPosition).map((s) => [s.lat, s.lng]));
  const hasRoute = latlngs.length >= 2;

  // ── Splits ──
  let splitsMetric: ActivitySplit[] | undefined;
  let splitsStandard: ActivitySplit[] | undefined;
  if (distance > 0 && dist && hasPaceSplits(type)) {
    const stream: StreamSample[] = samples.map((s, i) => {
      const point: StreamSample = { t: times[i], d: dist[i] };
      const hr = validHeartRate(s.heartRate);
      if (hr !== undefined) point.hr = hr;
      if (finite(s.altitude)) point.alt = s.altitude;
      return point;
    });
    const metric = deriveSplits(stream, 1000);
    const standard = deriveSplits(stream, MILE_M);
    if (metric.length) splitsMetric = metric;
    if (standard.length) splitsStandard = standard;
  }

  return stripUndefined<Activity>({
    id,
    name: opts.name?.trim() || p.name?.trim() || defaultName(type, startLocal),
    type,
    sport_type: type,
    distance: round(distance, 1),
    moving_time: Math.round(moving),
    elapsed_time: Math.round(elapsed),
    start_date: new Date(startMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    start_date_local: startLocal,
    kudos_count: 0,
    average_speed: avgSpeed !== undefined ? round(avgSpeed, 3) : undefined,
    max_speed: maxSpeed !== undefined ? round(maxSpeed, 3) : undefined,
    average_heartrate: avgHr !== undefined ? round(avgHr, 1) : undefined,
    max_heartrate: maxHr !== undefined ? Math.round(maxHr) : undefined,
    total_elevation_gain: elevation !== undefined ? round(elevation, 1) : undefined,
    average_cadence: rawCadence !== undefined ? round(rawCadence * (cadenceFactor ?? 1), 1) : undefined,
    calories: positive(totals.calories) !== undefined ? Math.round(totals.calories as number) : undefined,
    average_watts: avgWatts !== undefined ? Math.round(avgWatts) : undefined,
    weighted_average_watts: weightedWatts !== undefined ? Math.round(weightedWatts) : undefined,
    training_load: positive(totals.trainingLoad) !== undefined ? round(totals.trainingLoad as number, 1) : undefined,
    trainer,
    device_name: p.device?.trim() || undefined,
    // '' marks "checked — no GPS" so nothing tries to fetch a route later.
    map: { id: `file-${id}`, summary_polyline: hasRoute ? encodePolyline(decimate(latlngs, SUMMARY_MAX_POINTS)) : '' },
    start_latlng: hasRoute ? latlngs[0] : null,
    end_latlng: hasRoute ? latlngs[latlngs.length - 1] : null,
    splits_metric: splitsMetric,
    splits_standard: splitsStandard,
    laps: toActivityLaps(laps, samples, isRun, cadenceFactor),
    source: 'file',
    source_id: opts.sourceId || `file:${startSec}`,
    origin: opts.origin || p.origin || undefined,
  });
}
