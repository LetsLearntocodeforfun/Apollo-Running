/**
 * Course GPX parser for custom race imports (Epic 3A).
 *
 * Uses Apollo's streaming SAX-like `scanXml` scanner (no DOMParser, immune to
 * XXE and quadratic attribute backtracking) to turn a race course `.gpx` file
 * into a ready-to-import `CourseProfile`, per-mile `GpxCourseSplit[]`
 * (including partial final splits like 0.2 mi on a marathon), extracted `<wpt>`
 * aid stations, and difficulty rating.
 *
 * Elevation is read in ONE pass ({@link computeElevationPass}): the profile is
 * averaged over a 150 m window every 25 m along the course, then climb and
 * descent are accumulated with a 2 m hysteresis. The header totals, per-mile
 * climb and descent, terrain labels, difficulty and the BQ/PR flags all come
 * from that pass, so the splits always add up to the header totals.
 *
 * Track sections more than 200 m apart are never joined (the longest one is
 * used), and a course measuring within ±3% of the race distance is rescaled to
 * finish exactly at it ({@link fitCourseToDistance}). A marathon — 26.2 mi,
 * 42.2 km or 42.195 km — means the official 42.195 km ({@link MARATHON_MI}).
 */

import { decodeXmlBytes, parseXmlNumber, scanXml } from './fileImport/xml';
import { persistence } from './db/persistence';
import { MARATHON_MI, safeWebsite } from './raceStrategy';
import type { AidStation, CourseProfile, CourseSplit, ElevationPoint, MarathonRace } from '../types/raceStrategy';

/** Maximum accepted GPX payload size (15 MB). */
export const MAX_COURSE_GPX_BYTES = 15 * 1024 * 1024;

/** Minimum total course distance: 0.5 miles (~805 m). */
export const MIN_COURSE_DISTANCE_MI = 0.5;
export const MIN_COURSE_DISTANCE_M = MIN_COURSE_DISTANCE_MI * 1609.344;

/** Elevation is sampled every 25 m along the course for the climb/descent pass. */
export const ELEVATION_SAMPLE_SPACING_M = 25;

/** Each elevation sample is the distance-weighted mean over a 150 m window, which averages out GPS/DEM jitter. */
export const ELEVATION_SMOOTHING_WINDOW_M = 150;

/**
 * Vertical hysteresis (2 m ≈ 6.6 ft): a rise or fall counts once it reaches
 * this size, and then counts in full, so leftover jitter on flat courses
 * doesn't fabricate climb.
 */
export const ELEVATION_DEADBAND_M = 2;

/** Maximum chart profile points returned for crisp SVG rendering. */
export const MAX_ELEVATION_PROFILE_POINTS = 200;

/** Maximum `<trkpt>` or `<rtept>` elements accepted in a single course GPX file (DoS guard). */
export const MAX_COURSE_TRACKPOINTS = 250_000;

/** Maximum `<wpt>` waypoint elements evaluated for aid-station matching (O(W * N) DoS guard). */
export const MAX_COURSE_WAYPOINTS = 1_000;

/** Consecutive tracks or segments are joined only when the gap between them is at most 200 m. */
export const MAX_TRACK_JOIN_GAP_M = 200;

/** A course measuring within ±3% of the race distance is rescaled to finish exactly at it. */
export const COURSE_DISTANCE_FIT_TOLERANCE = 0.03;

/** Race distance a course is fitted to when none is given: the marathon, 42.195 km (26.21875 mi). */
export const DEFAULT_COURSE_DISTANCE_MI = MARATHON_MI;

/**
 * A race distance within 0.02 mi (about 30 m) of 42.195 km denotes the
 * marathon: 26.2 mi, 42.2 km and 42.195 km all do, while 26.1 mi or 42.3 km
 * don't.
 */
export const MARATHON_DISTANCE_MATCH_MI = 0.02;

/** True when `distanceMi` denotes the marathon (see {@link MARATHON_DISTANCE_MATCH_MI}). */
export function isMarathonDistanceMi(distanceMi: number): boolean {
  return Number.isFinite(distanceMi) && Math.abs(distanceMi - MARATHON_MI) <= MARATHON_DISTANCE_MATCH_MI;
}

/**
 * The distance a course is fitted to for a race of `raceDistanceMi`: the
 * official 42.195 km when the distance denotes a marathon, otherwise exactly
 * the distance given. A missing or invalid distance means the marathon.
 */
export function courseFitTargetMi(raceDistanceMi: number | undefined): number {
  if (typeof raceDistanceMi !== 'number' || !Number.isFinite(raceDistanceMi) || raceDistanceMi <= 0) {
    return DEFAULT_COURSE_DISTANCE_MI;
  }
  return isMarathonDistanceMi(raceDistanceMi) ? MARATHON_MI : raceDistanceMi;
}

const METERS_PER_MILE = 1609.344;
const FT_PER_M = 3.28084;
const EARTH_RADIUS_M = 6_371_000;
const CUSTOM_MARATHONS_KEY = 'apollo_custom_marathons';

/** Course difficulty rating on a 1–5 scale (1 = flat/fast, 5 = mountain/very hilly). */
export type CourseDifficulty = 1 | 2 | 3 | 4 | 5;

/**
 * Per-mile course split with full climb/descent/grade telemetry.
 * Extends `CourseSplit` so it plugs directly into `MarathonRace.splits`.
 */
export interface GpxCourseSplit extends CourseSplit {
  /** 1-based split number (matches `number`). */
  splitNumber: number;
  /** Length of this split in miles (e.g. 1.0 for full miles, 0.2 for mile 26.2). */
  distanceMi: number;
  /** Gross elevation gain within this split (ft). */
  elevationGainFt: number;
  /** Gross elevation loss within this split (ft). */
  elevationLossFt: number;
  /** Average grade over this split in % (rise / run × 100). */
  avgGradePct: number;
  /** Pacing / terrain cue (e.g. 'Significant climb', 'Fast downhill', 'Final push'). */
  notes: string;
}

export interface ParseCourseGpxOptions {
  /** Fallback course name (e.g. uploaded filename) when GPX `<name>` tags are absent. */
  fallbackName?: string;
  /**
   * Race distance in miles. A course measuring within ±3% of it is rescaled
   * to finish exactly there; a marathon (26.2 mi, 42.2 km or 42.195 km) means
   * the official 42.195 km ({@link courseFitTargetMi}). Default: the marathon.
   */
  targetDistanceMi?: number;
}

/** How the measured course length compares with the race distance. */
export interface CourseDistanceFit {
  /** Length measured along the GPX track (mi). */
  measuredMi: number;
  /** Race distance the course was compared with (mi): 26.21875 for a marathon, else the distance given. */
  targetMi: number;
  /** True when the measured length was within ±3% of `targetMi`, so the course now finishes exactly there. */
  fitted: boolean;
  /** Factor applied to every distance along the course (1 when left as measured). */
  scale: number;
}

/** A `<wpt>` matched to the course, at its distance along the measured track. */
export interface CourseWaypointMatch {
  /** Distance along the measured track (m). */
  distM: number;
  /** Landmark label (waypoint name, description or type; '' for none). */
  label: string;
  /** Aid-station name (waypoint name or description; '' to generate one). */
  aidName: string;
  /** True when the waypoint text describes an aid, water, fuel or medical station. */
  isAid: boolean;
  /** Offerings inferred from the waypoint text (aid stations only). */
  offerings: string[];
}

/** Result of {@link computeElevationPass}. Distances are along the measured course. */
export interface ElevationPass {
  /** Sample positions (m from the start): every {@link ELEVATION_SAMPLE_SPACING_M}, plus the finish. */
  sampleDistM: number[];
  /** Filtered elevation at each sample (m): smoothed, with sub-deadband wiggles held flat. */
  elevationM: number[];
  /** Climb accumulated from the start to each sample (m). */
  cumGainM: number[];
  /** Descent accumulated from the start to each sample (m). */
  cumLossM: number[];
}

/**
 * Measured course data kept with a parse result, so {@link fitCourseToDistance}
 * can rebuild splits, aid stations and the profile for another race distance
 * without re-reading the file.
 */
export interface GpxCourseMeasurement extends ElevationPass {
  /** Course length measured along the GPX track (m). */
  lengthM: number;
  hasElevation: boolean;
  waypoints: CourseWaypointMatch[];
}

export interface ParsedGpxCourse {
  suggestedName: string;
  suggestedCourseType: MarathonRace['courseType'];
  /** Course length used for splits, aid stations and the profile (fitted to the race distance when within ±3%). */
  distanceM: number;
  distanceKm: number;
  distanceMi: number;
  elevationGainM: number;
  elevationLossM: number;
  elevationGainFt: number;
  elevationLossFt: number;
  highPointFt: number;
  lowPointFt: number;
  pointCount: number;
  sourceKind: 'track' | 'route';
  hasElevation: boolean;
  difficulty: CourseDifficulty;
  elevationProfile: ElevationPoint[];
  splits: GpxCourseSplit[];
  aidStations: AidStation[];
  /** Ready-to-attach `MarathonRace['course']` object (1–10 internal difficulty scale). */
  course: CourseProfile;
  startLat: number;
  startLon: number;
  /** Measured length vs. race distance, and whether the course was rescaled to it. */
  distanceFit: CourseDistanceFit;
  /** Plain-language notes about the file, e.g. track sections that were left out. */
  warnings: string[];
  /** Measured data behind this result (see {@link fitCourseToDistance}). */
  measurement: GpxCourseMeasurement;
}

interface RawPoint {
  lat: number;
  lon: number;
  eleM?: number;
}

interface RawWaypoint {
  lat: number;
  lon: number;
  name: string;
  desc: string;
  type: string;
  sym: string;
}

/** A contiguous run of points: one track/route section, or several joined across gaps of ≤ 200 m. */
interface CoursePart {
  points: RawPoint[];
  /** Cumulative distance from the part's first point (m). */
  distM: number[];
}

interface CoursePoint {
  lat: number;
  lon: number;
  distM: number;
}

/** Everything {@link buildCourse} needs; a `ParsedGpxCourse` satisfies it, so it can be refitted. */
type CourseBase = Pick<
  ParsedGpxCourse,
  | 'suggestedName'
  | 'suggestedCourseType'
  | 'pointCount'
  | 'sourceKind'
  | 'startLat'
  | 'startLon'
  | 'warnings'
  | 'measurement'
>;

const AID_KEYWORDS_RE =
  /\b(?:aid|water|aqua|gel|fuel|nutrition|medical|med|first\s*aid|station|hydration|drink|electrolyte|isotonic|gatorade|powerade|maurten|nuun|fluid|sponge|bananas?|fruit|porta|toilet|restroom)\b/i;

function isValidCoordinate(lat: number | undefined, lon: number | undefined): boolean {
  if (lat === undefined || lon === undefined) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (lat === 0 && lon === 0) return false;
  return true;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Great-circle Haversine distance in meters between two WGS84 coordinates. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

// ── Elevation pass ────────────────────────────────────────────────────────────

/**
 * Zig-zag hysteresis: a rise or fall only counts once it reaches `deadbandM`,
 * and then counts in full (turns don't shave anything off real hills). Returns
 * the filtered series — flat through sub-deadband wiggles, following the
 * running high (or low) on confirmed climbs (or descents) — and the climb and
 * descent accumulated up to each index.
 */
function applyHysteresis(
  elevationsM: readonly number[],
  deadbandM: number,
): { filteredM: number[]; cumGainM: number[]; cumLossM: number[] } {
  const n = elevationsM.length;
  const filteredM = new Array<number>(n);
  const cumGainM = new Array<number>(n);
  const cumLossM = new Array<number>(n);
  if (n === 0) return { filteredM, cumGainM, cumLossM };
  const threshold = Math.max(deadbandM, 1e-9);

  // 1. Confirmed legs (alternating climbs and descents, each at least `threshold` tall).
  const legs: { from: number; to: number }[] = [];
  let dir = 0;
  let lo = 0;
  let hi = 0;
  let legStart = 0;
  let extreme = 0;
  for (let i = 1; i < n; i++) {
    const v = elevationsM[i];
    if (dir === 0) {
      if (v > elevationsM[hi]) hi = i;
      if (v < elevationsM[lo]) lo = i;
      if (elevationsM[hi] - elevationsM[lo] >= threshold) {
        dir = hi > lo ? 1 : -1;
        legStart = hi > lo ? lo : hi;
        extreme = i;
      }
    } else if (dir > 0) {
      if (v >= elevationsM[extreme]) extreme = i;
      else if (elevationsM[extreme] - v >= threshold) {
        legs.push({ from: legStart, to: extreme });
        legStart = extreme;
        extreme = i;
        dir = -1;
      }
    } else if (v <= elevationsM[extreme]) {
      extreme = i;
    } else if (v - elevationsM[extreme] >= threshold) {
      legs.push({ from: legStart, to: extreme });
      legStart = extreme;
      extreme = i;
      dir = 1;
    }
  }
  if (dir !== 0) legs.push({ from: legStart, to: extreme });

  // 2. Filtered profile: on a leg, follow the running extreme (it reaches the leg's
  //    end value exactly); before the first leg and after the last, hold steady.
  let level = legs.length > 0 ? elevationsM[legs[0].from] : elevationsM[0];
  let gain = 0;
  let loss = 0;
  let leg = 0;
  for (let i = 0; i < n; i++) {
    while (leg < legs.length && i > legs[leg].to) leg++;
    if (leg < legs.length && i > legs[leg].from) {
      const { from, to } = legs[leg];
      const v = elevationsM[i];
      const next =
        elevationsM[to] > elevationsM[from]
          ? Math.min(elevationsM[to], Math.max(level, v))
          : Math.max(elevationsM[to], Math.min(level, v));
      if (next > level) gain += next - level;
      else loss += level - next;
      level = next;
    }
    filteredM[i] = level;
    cumGainM[i] = gain;
    cumLossM[i] = loss;
  }
  return { filteredM, cumGainM, cumLossM };
}

/**
 * Hysteresis (deadband) climb/descent totals for an elevation series (meters).
 * A rise or fall counts once it reaches `deadbandM` (default 2 m ≈ 6.6 ft), and
 * then counts in full, so GPS/DEM jitter smaller than that never accumulates.
 */
export function computeDeadbandGainLossMeters(
  elevationsM: readonly number[],
  deadbandM: number = ELEVATION_DEADBAND_M,
): { gainM: number; lossM: number } {
  if (elevationsM.length < 2) return { gainM: 0, lossM: 0 };
  const { cumGainM, cumLossM } = applyHysteresis(elevationsM, deadbandM);
  return { gainM: cumGainM[cumGainM.length - 1], lossM: cumLossM[cumLossM.length - 1] };
}

/**
 * The single elevation pass behind every climb number on a course. The
 * piecewise-linear profile through (`distancesM`, `elevationsM`) is averaged
 * over `windowM` (distance-weighted, so dense and sparse files behave the same)
 * at every `spacingM`, then climb and descent are accumulated with a
 * `deadbandM` hysteresis ({@link computeDeadbandGainLossMeters}).
 *
 * `distancesM` is the cumulative distance from the start (first value 0,
 * non-decreasing). The cumulative arrays let any stretch of the course read
 * its own climb and descent, so per-mile values always add up to the totals.
 */
export function computeElevationPass(
  distancesM: readonly number[],
  elevationsM: readonly number[],
  options: { windowM?: number; spacingM?: number; deadbandM?: number } = {},
): ElevationPass {
  const n = Math.min(distancesM.length, elevationsM.length);
  const windowM = Math.max(0, options.windowM ?? ELEVATION_SMOOTHING_WINDOW_M);
  const spacingM = Math.max(1, options.spacingM ?? ELEVATION_SAMPLE_SPACING_M);
  const deadbandM = options.deadbandM ?? ELEVATION_DEADBAND_M;
  if (n === 0) return { sampleDistM: [], elevationM: [], cumGainM: [], cumLossM: [] };
  const lengthM = Math.max(0, distancesM[n - 1]);

  const sampleDistM: number[] = [];
  for (let k = 0; k * spacingM < lengthM - 1e-6; k++) sampleDistM.push(k * spacingM);
  sampleDistM.push(lengthM);

  // Running integral of the piecewise-linear profile, so each window mean is
  // (I(b) − I(a)) / (b − a) and every point inside the window counts by distance.
  const integralAtPoint = new Array<number>(n);
  integralAtPoint[0] = 0;
  for (let i = 1; i < n; i++) {
    const span = Math.max(0, distancesM[i] - distancesM[i - 1]);
    integralAtPoint[i] = integralAtPoint[i - 1] + (span * (elevationsM[i] + elevationsM[i - 1])) / 2;
  }
  const integralCursor = () => {
    let i = 0;
    return (d: number): number => {
      while (i < n - 1 && distancesM[i + 1] <= d) i++;
      if (i >= n - 1) return integralAtPoint[n - 1];
      const span = distancesM[i + 1] - distancesM[i];
      if (span <= 0 || d <= distancesM[i]) return integralAtPoint[i];
      const t = (d - distancesM[i]) / span;
      const eleAtD = elevationsM[i] + t * (elevationsM[i + 1] - elevationsM[i]);
      return integralAtPoint[i] + ((d - distancesM[i]) * (elevationsM[i] + eleAtD)) / 2;
    };
  };
  const integralFrom = integralCursor();
  const integralTo = integralCursor();
  const pointCursor = (() => {
    let i = 0;
    return (d: number): number => {
      while (i < n - 1 && distancesM[i + 1] <= d) i++;
      if (i >= n - 1) return elevationsM[n - 1];
      const span = distancesM[i + 1] - distancesM[i];
      return span > 0
        ? elevationsM[i] + ((d - distancesM[i]) / span) * (elevationsM[i + 1] - elevationsM[i])
        : elevationsM[i];
    };
  })();

  const smoothedM = sampleDistM.map((x) => {
    const a = Math.max(0, x - windowM / 2);
    const b = Math.min(lengthM, x + windowM / 2);
    return b - a > 1e-9 ? (integralTo(b) - integralFrom(a)) / (b - a) : pointCursor(x);
  });

  const { filteredM, cumGainM, cumLossM } = applyHysteresis(smoothedM, deadbandM);
  return { sampleDistM, elevationM: filteredM, cumGainM, cumLossM };
}

/** Linear interpolation of `values` (sampled at increasing `xs`) at `x`, clamped to the ends. */
function interpolateSample(xs: readonly number[], values: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]) return values[0];
  if (x >= xs[n - 1]) return values[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  if (span <= 1e-9) return values[hi];
  return values[lo] + ((x - xs[lo]) / span) * (values[hi] - values[lo]);
}

/** Fill missing `<ele>` values by linear interpolation along distance when at least some exist. */
function fillMissingElevations(
  points: readonly RawPoint[],
  distM: readonly number[],
): { elevationsM: number[]; hasElevation: boolean } {
  const n = points.length;
  const isUsable = (e: number | undefined): e is number =>
    e !== undefined && Number.isFinite(e) && e > -500 && e < 9000;
  let firstValidIdx = -1;
  for (let i = 0; i < n; i++) {
    if (isUsable(points[i].eleM)) {
      firstValidIdx = i;
      break;
    }
  }
  if (firstValidIdx < 0) {
    return { elevationsM: new Array<number>(n).fill(0), hasElevation: false };
  }

  const out = new Array<number>(n);
  const firstVal = points[firstValidIdx].eleM as number;
  for (let i = 0; i <= firstValidIdx; i++) out[i] = firstVal;

  let prevIdx = firstValidIdx;
  for (let i = firstValidIdx + 1; i < n; i++) {
    const e = points[i].eleM;
    if (isUsable(e)) {
      const prevVal = out[prevIdx];
      const spanM = distM[i] - distM[prevIdx];
      for (let k = prevIdx + 1; k < i; k++) {
        const t = spanM > 0 ? (distM[k] - distM[prevIdx]) / spanM : (k - prevIdx) / (i - prevIdx);
        out[k] = prevVal + t * (e - prevVal);
      }
      out[i] = e;
      prevIdx = i;
    }
  }
  for (let i = prevIdx + 1; i < n; i++) out[i] = out[prevIdx];

  return { elevationsM: out, hasElevation: true };
}

// ── Course geometry ───────────────────────────────────────────────────────────

/**
 * Chain track (or route) sections in file order. A section joins the previous
 * one only when it starts within {@link MAX_TRACK_JOIN_GAP_M} of where that one
 * ended (a GPS dropout); a bigger jump starts a new, separate part.
 */
function joinCourseParts(sections: readonly RawPoint[][]): CoursePart[] {
  const parts: CoursePart[] = [];
  let current: CoursePart | null = null;
  for (const section of sections) {
    if (section.length === 0) continue;
    if (current) {
      const last = current.points[current.points.length - 1];
      const gapM = haversineMeters(last.lat, last.lon, section[0].lat, section[0].lon);
      if (!(gapM <= MAX_TRACK_JOIN_GAP_M)) current = null;
    }
    if (!current) {
      current = { points: [], distM: [] };
      parts.push(current);
    }
    for (const p of section) {
      const count = current.points.length;
      let d = 0;
      if (count > 0) {
        const prev = current.points[count - 1];
        const stepM = haversineMeters(prev.lat, prev.lon, p.lat, p.lon);
        d = current.distM[count - 1] + (Number.isFinite(stepM) && stepM > 0 ? stepM : 0);
      }
      current.points.push(p);
      current.distM.push(d);
    }
  }
  return parts;
}

function partLengthM(part: CoursePart): number {
  return part.distM.length > 0 ? part.distM[part.distM.length - 1] : 0;
}

/** Longest part by distance (then by point count); null when there are none. */
function longestPart(parts: readonly CoursePart[]): CoursePart | null {
  let best: CoursePart | null = null;
  for (const part of parts) {
    if (
      !best ||
      partLengthM(part) > partLengthM(best) ||
      (partLengthM(part) === partLengthM(best) && part.points.length > best.points.length)
    ) {
      best = part;
    }
  }
  return best;
}

function cleanFallbackName(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/\.(?:gpx|xml)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Infer loop / out-and-back / point-to-point from course geometry. */
function inferCourseType(points: readonly CoursePoint[]): MarathonRace['courseType'] {
  if (points.length < 4) return 'point-to-point';
  const start = points[0];
  const end = points[points.length - 1];
  const totalM = end.distM;
  const startToEndM = haversineMeters(start.lat, start.lon, end.lat, end.lon);
  const closedThresholdM = Math.min(800, totalM * 0.08);

  if (startToEndM > closedThresholdM) return 'point-to-point';

  // Check if the quarter and three-quarter points lie close together (out-and-back)
  const q1Target = totalM * 0.25;
  const q3Target = totalM * 0.75;
  const midTarget = totalM * 0.5;
  let q1 = start;
  let mid = start;
  let q3 = end;
  for (const p of points) {
    if (Math.abs(p.distM - q1Target) < Math.abs(q1.distM - q1Target)) q1 = p;
    if (Math.abs(p.distM - midTarget) < Math.abs(mid.distM - midTarget)) mid = p;
    if (Math.abs(p.distM - q3Target) < Math.abs(q3.distM - q3Target)) q3 = p;
  }
  const midToStartM = haversineMeters(start.lat, start.lon, mid.lat, mid.lon);
  if (midToStartM < Math.min(400, totalM * 0.04)) return 'multi-loop';
  const q1ToQ3M = haversineMeters(q1.lat, q1.lon, q3.lat, q3.lon);
  if (q1ToQ3M < Math.min(250, totalM * 0.025)) return 'out-and-back';
  return 'loop';
}

// ── Aid stations ──────────────────────────────────────────────────────────────

function inferWaypointOfferings(text: string): string[] {
  const offerings: string[] = [];
  if (/\b(?:water|aqua|hydration|fluid|aid|station|drink)\b/i.test(text)) offerings.push('water');
  if (/\b(?:electrolyte|isotonic|gatorade|powerade|nuun|sports\s*drink)\b/i.test(text)) {
    offerings.push('sports drink');
  }
  if (/\b(?:gel|maurten|gu\b|fuel|nutrition|carb)\b/i.test(text)) offerings.push('energy gel');
  if (/\b(?:banana|fruit|food)\b/i.test(text)) offerings.push('fruit');
  if (/\b(?:medical|med\b|first\s*aid)\b/i.test(text)) offerings.push('medical');
  if (offerings.length === 0) offerings.push('water', 'sports drink');
  return offerings;
}

function buildDefaultEvery2MileAidStations(distanceMi: number): AidStation[] {
  const stations: AidStation[] = [];
  for (let mile = 2; mile < distanceMi - 0.15; mile += 2) {
    const offerings = ['water', 'sports drink'];
    if (mile >= 6 && mile % 6 === 0) offerings.push('energy gel');
    stations.push({
      distanceMi: mile,
      name: `Aid Station ${stations.length + 1} (Mile ${mile})`,
      offerings,
    });
  }
  if (stations.length === 0 && distanceMi >= 1) {
    stations.push({
      distanceMi: Math.round((distanceMi / 2) * 10) / 10,
      name: 'Midpoint Aid Station',
      offerings: ['water', 'sports drink'],
    });
  }
  return stations;
}

/** Snap each `<wpt>` to its nearest course point (measured distance); waypoints over 2.5 km away are ignored. */
function matchWaypoints(waypoints: readonly RawWaypoint[], points: readonly CoursePoint[]): CourseWaypointMatch[] {
  const matches: CourseWaypointMatch[] = [];
  if (waypoints.length === 0 || points.length === 0) return matches;

  // Decimate course lookup slightly only if huge (> 5000 pts) to keep waypoint snapping O(W * min(N, 5000))
  const stride = Math.max(1, Math.floor(points.length / 5000));

  for (const wpt of waypoints) {
    const combinedText = `${wpt.name} ${wpt.desc} ${wpt.type} ${wpt.sym}`.trim();
    if (!combinedText) continue;

    let bestPt = points[0];
    let bestDistM = Infinity;
    for (let i = 0; i < points.length; i += stride) {
      const d = haversineMeters(wpt.lat, wpt.lon, points[i].lat, points[i].lon);
      if (d < bestDistM) {
        bestDistM = d;
        bestPt = points[i];
      }
    }
    // Ignore waypoints farther than 2.5 km from the route
    if (bestDistM > 2500) continue;

    const isAid = AID_KEYWORDS_RE.test(combinedText);
    matches.push({
      distM: bestPt.distM,
      label: wpt.name || wpt.desc || wpt.type,
      aidName: wpt.name || wpt.desc,
      isAid,
      offerings: isAid ? inferWaypointOfferings(combinedText) : [],
    });
  }
  return matches;
}

/** Split end points (mi): 1, 2, … then the remainder; a remainder under 0.03 mi joins the last full mile. */
function splitEndsMi(totalMi: number): number[] {
  const wholeMiles = Math.floor(totalMi + 1e-6);
  const remainderMi = totalMi - wholeMiles;
  const ends: number[] = [];
  for (let m = 1; m <= wholeMiles; m++) ends.push(m);
  if (remainderMi >= 0.03 || ends.length === 0) {
    ends.push(totalMi);
  } else {
    ends[ends.length - 1] = totalMi;
  }
  return ends;
}

/** 1-based number of the split containing course mile `mi`. */
function splitNumberAt(ends: readonly number[], mi: number): number {
  for (let i = 0; i < ends.length; i++) {
    if (mi <= ends[i] + 1e-9) return i + 1;
  }
  return ends.length;
}

/**
 * Landmarks per split and aid stations at fitted course miles. Matched aid
 * waypoints within 0.08 mi of each other merge; without any, a station is
 * placed every 2 miles.
 */
function placeWaypoints(
  waypoints: readonly CourseWaypointMatch[],
  scale: number,
  ends: readonly number[],
  totalDistanceMi: number,
): { aidStations: AidStation[]; splitLandmarks: Map<number, string[]> } {
  const splitLandmarks = new Map<number, string[]>();
  const matchedAid: AidStation[] = [];

  for (const wpt of waypoints) {
    const courseMi = (wpt.distM * scale) / METERS_PER_MILE;
    const snappedMi = Math.round(courseMi * 10) / 10;
    if (wpt.label) {
      const splitIdx = splitNumberAt(ends, courseMi);
      const list = splitLandmarks.get(splitIdx) ?? [];
      if (!list.includes(wpt.label) && list.length < 3) {
        list.push(wpt.label);
        splitLandmarks.set(splitIdx, list);
      }
    }
    if (wpt.isAid) {
      matchedAid.push({
        distanceMi: snappedMi,
        name: wpt.aidName || `Aid Station (${snappedMi} mi)`,
        offerings: [...wpt.offerings],
      });
    }
  }

  if (matchedAid.length === 0) {
    return { aidStations: buildDefaultEvery2MileAidStations(totalDistanceMi), splitLandmarks };
  }

  matchedAid.sort((a, b) => a.distanceMi - b.distanceMi);
  const deduped: AidStation[] = [];
  for (const station of matchedAid) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(station.distanceMi - prev.distanceMi) < 0.08) {
      for (const item of station.offerings) {
        if (!prev.offerings.includes(item)) prev.offerings.push(item);
      }
    } else {
      deduped.push(station);
    }
  }

  return { aidStations: deduped, splitLandmarks };
}

// ── Splits, profile & difficulty ──────────────────────────────────────────────

function computeCourseSplits(
  pass: ElevationPass,
  scale: number,
  ends: readonly number[],
  splitLandmarks: ReadonlyMap<number, string[]>,
): GpxCourseSplit[] {
  const at = (values: readonly number[], mi: number) =>
    interpolateSample(pass.sampleDistM, values, (mi * METERS_PER_MILE) / scale);
  // Differences of rounded running totals: each split is within 1 ft of its own
  // climb or descent, and the splits add up exactly to the course totals.
  const runningFt = (values: readonly number[], mi: number) => Math.round(at(values, mi) * FT_PER_M);

  const splits: GpxCourseSplit[] = [];
  for (let idx = 0; idx < ends.length; idx++) {
    const splitNumber = idx + 1;
    const startMi = idx === 0 ? 0 : ends[idx - 1];
    const endMi = ends[idx];
    const segLenMi = Math.max(0.01, endMi - startMi);
    const isLast = idx === ends.length - 1;

    const startEleM = at(pass.elevationM, startMi);
    const endEleM = at(pass.elevationM, endMi);
    const elevationChangeFt = runningFt(pass.elevationM, endMi) - runningFt(pass.elevationM, startMi);
    const avgGradePct = Math.round((((endEleM - startEleM) * FT_PER_M) / (segLenMi * 5280)) * 1000) / 10;
    const elevationGainFt = runningFt(pass.cumGainM, endMi) - runningFt(pass.cumGainM, startMi);
    const elevationLossFt = runningFt(pass.cumLossM, endMi) - runningFt(pass.cumLossM, startMi);

    let terrain = 'Flat';
    let cue = 'Steady effort';
    if (avgGradePct >= 2.5) {
      terrain = 'Steep climb';
      cue = 'Significant climb';
    } else if (avgGradePct >= 1.0) {
      terrain = 'Uphill';
      cue = 'Steady climb';
    } else if (avgGradePct <= -2.5) {
      terrain = 'Steep descent';
      cue = 'Fast downhill — protect quads';
    } else if (avgGradePct <= -1.0) {
      terrain = 'Downhill';
      cue = 'Fast downhill';
    } else if (elevationGainFt >= 35 && elevationLossFt >= 35) {
      terrain = 'Rolling';
      cue = 'Rolling terrain';
    }

    const notes = isLast ? (cue === 'Steady effort' ? 'Final push' : `${cue} · Final push`) : cue;
    const landmarks = splitLandmarks.get(splitNumber) ?? [];

    splits.push({
      number: splitNumber,
      splitNumber,
      distanceMi: Math.round((endMi - startMi) * 1000) / 1000,
      endMi: Math.round(endMi * 1000) / 1000,
      elevationChangeFt,
      elevationGainFt,
      elevationLossFt,
      avgGradePct,
      terrain,
      landmarks: [...landmarks],
      notes,
    });
  }

  return splits;
}

/** Profile of the filtered elevation at up to `maxPoints` evenly spaced course miles. */
function buildElevationProfile(
  pass: ElevationPass,
  scale: number,
  totalMi: number,
  maxPoints: number,
): ElevationPoint[] {
  const count = Math.min(maxPoints, Math.max(2, pass.sampleDistM.length));
  const profile: ElevationPoint[] = [];
  for (let i = 0; i < count; i++) {
    const d = i === count - 1 ? totalMi : (i / (count - 1)) * totalMi;
    const eleM = interpolateSample(pass.sampleDistM, pass.elevationM, (d * METERS_PER_MILE) / scale);
    profile.push({
      distanceMi: Math.round(d * 1000) / 1000,
      elevationFt: Math.round(eleM * FT_PER_M * 10) / 10,
    });
  }
  return profile;
}

/** Estimate 1–5 `CourseDifficulty` and 1–10 `CourseProfile.difficulty` from ft/mi + peak grade. */
function estimateDifficulty(
  elevationGainFt: number,
  distanceMi: number,
  splits: readonly GpxCourseSplit[],
): { difficulty: CourseDifficulty; profileDifficulty10: number } {
  if (distanceMi <= 0 || elevationGainFt <= 0) {
    return { difficulty: 1, profileDifficulty10: 1 };
  }
  const gainPerMi = elevationGainFt / distanceMi;
  let peakAbsGrade = 0;
  for (const s of splits) {
    if (s.distanceMi >= 0.25) {
      peakAbsGrade = Math.max(peakAbsGrade, Math.abs(s.avgGradePct));
    }
  }

  let difficulty: CourseDifficulty;
  if (gainPerMi < 15 && peakAbsGrade < 1.5) difficulty = 1;
  else if (gainPerMi < 32 && peakAbsGrade < 2.5) difficulty = 2;
  else if (gainPerMi < 60 && peakAbsGrade < 4.5) difficulty = 3;
  else if (gainPerMi < 95 && peakAbsGrade < 6.5) difficulty = 4;
  else difficulty = 5;

  const raw10 = Math.round(gainPerMi / 14 + (peakAbsGrade >= 3 ? (peakAbsGrade - 2) * 0.8 : 0));
  const profileDifficulty10 = Math.min(10, Math.max(1, raw10 || 1));

  return { difficulty, profileDifficulty10 };
}

/**
 * Compare the measured length with the race distance: a marathon means the
 * official 42.195 km, and an invalid target falls back to it ({@link courseFitTargetMi}).
 */
function resolveDistanceFit(lengthM: number, targetDistanceMi: number | undefined): CourseDistanceFit {
  const targetMi = courseFitTargetMi(targetDistanceMi);
  const targetM = targetMi * METERS_PER_MILE;
  const fitted = lengthM > 0 && Math.abs(lengthM - targetM) <= COURSE_DISTANCE_FIT_TOLERANCE * targetM;
  return {
    measuredMi: round3(lengthM / METERS_PER_MILE),
    targetMi,
    fitted,
    scale: fitted ? targetM / lengthM : 1,
  };
}

/** Build every distance-dependent output from the measured course, fitted to `targetDistanceMi` when within ±3%. */
function buildCourse(base: CourseBase, targetDistanceMi: number | undefined): ParsedGpxCourse {
  const m = base.measurement;
  const distanceFit = resolveDistanceFit(m.lengthM, targetDistanceMi);
  const { scale } = distanceFit;
  const courseM = distanceFit.fitted ? distanceFit.targetMi * METERS_PER_MILE : m.lengthM;
  const courseMi = courseM / METERS_PER_MILE;

  const distanceM = Math.round(courseM * 10) / 10;
  const distanceKm = round3(courseM / 1000);
  const distanceMi = round3(courseMi);

  const lastIdx = m.sampleDistM.length - 1;
  const gainM = lastIdx >= 0 ? m.cumGainM[lastIdx] : 0;
  const lossM = lastIdx >= 0 ? m.cumLossM[lastIdx] : 0;
  const elevationGainM = Math.round(gainM);
  const elevationLossM = Math.round(lossM);
  const elevationGainFt = Math.round(gainM * FT_PER_M);
  const elevationLossFt = Math.round(lossM * FT_PER_M);

  let highPointFt = 0;
  let lowPointFt = 0;
  let netChangeFt = 0;
  if (m.hasElevation && lastIdx >= 0) {
    let maxM = -Infinity;
    let minM = Infinity;
    for (const e of m.elevationM) {
      if (e > maxM) maxM = e;
      if (e < minM) minM = e;
    }
    highPointFt = Math.round(maxM * FT_PER_M);
    lowPointFt = Math.round(minM * FT_PER_M);
    // Same rounding as the splits, so their net changes add up to this.
    netChangeFt = Math.round(m.elevationM[lastIdx] * FT_PER_M) - Math.round(m.elevationM[0] * FT_PER_M);
  }

  const ends = splitEndsMi(courseMi);
  const elevationProfile = buildElevationProfile(m, scale, courseMi, MAX_ELEVATION_PROFILE_POINTS);
  const { aidStations, splitLandmarks } = placeWaypoints(m.waypoints, scale, ends, distanceMi);
  const splits = computeCourseSplits(m, scale, ends, splitLandmarks);
  const { difficulty, profileDifficulty10 } = estimateDifficulty(elevationGainFt, distanceMi, splits);

  const course: CourseProfile = {
    totalGainFt: elevationGainFt,
    totalLossFt: elevationLossFt,
    netChangeFt,
    highPointFt,
    lowPointFt,
    elevationPoints: elevationProfile,
    difficulty: profileDifficulty10,
    bqFriendly: profileDifficulty10 <= 3 && netChangeFt <= 50,
    prFriendly: profileDifficulty10 <= 3,
  };

  return {
    suggestedName: base.suggestedName,
    suggestedCourseType: base.suggestedCourseType,
    distanceM,
    distanceKm,
    distanceMi,
    elevationGainM,
    elevationLossM,
    elevationGainFt,
    elevationLossFt,
    highPointFt,
    lowPointFt,
    pointCount: base.pointCount,
    sourceKind: base.sourceKind,
    hasElevation: m.hasElevation,
    difficulty,
    elevationProfile,
    splits,
    aidStations,
    course,
    startLat: base.startLat,
    startLon: base.startLon,
    distanceFit,
    warnings: [...base.warnings],
    measurement: m,
  };
}

/**
 * Fit a parsed course to a race distance. When the measured length is within
 * ±3% of `targetDistanceMi`, every distance along the course is rescaled so it
 * finishes exactly there, and splits, aid stations and the profile are rebuilt
 * (climb and descent don't change). A marathon distance (26.2 mi, 42.2 km or
 * 42.195 km) is fitted to the official 42.195 km; any other distance as given.
 * Otherwise the course stays as measured and `distanceFit.fitted` is false.
 */
export function fitCourseToDistance(parsed: ParsedGpxCourse, targetDistanceMi: number): ParsedGpxCourse {
  return buildCourse(parsed, targetDistanceMi);
}

/**
 * Parse a GPX 1.0 / 1.1 course file (`string` or `Uint8Array`) into elevation
 * profile, splits, aid stations, and summary metrics.
 *
 * Throws `RangeError` when the file exceeds `MAX_COURSE_GPX_BYTES` or `Error`
 * with a runner-friendly message when the GPX is malformed or shorter than 0.5 mi.
 */
export function parseCourseGpx(xmlOrBytes: string | Uint8Array, options: ParseCourseGpxOptions = {}): ParsedGpxCourse {
  let xmlText: string;
  if (xmlOrBytes instanceof Uint8Array || ArrayBuffer.isView(xmlOrBytes)) {
    const view =
      xmlOrBytes instanceof Uint8Array
        ? xmlOrBytes
        : new Uint8Array(xmlOrBytes.buffer, xmlOrBytes.byteOffset, xmlOrBytes.byteLength);
    if (view.byteLength > MAX_COURSE_GPX_BYTES) {
      throw new RangeError('Course GPX file exceeds the 15 MB size limit.');
    }
    xmlText = decodeXmlBytes(view);
  } else if (typeof xmlOrBytes === 'string') {
    if (xmlOrBytes.length > MAX_COURSE_GPX_BYTES) {
      throw new RangeError('Course GPX file exceeds the 15 MB size limit.');
    }
    if (xmlOrBytes.length > MAX_COURSE_GPX_BYTES / 3) {
      const utf8Len = new TextEncoder().encode(xmlOrBytes).byteLength;
      if (utf8Len > MAX_COURSE_GPX_BYTES) {
        throw new RangeError('Course GPX file exceeds the 15 MB size limit.');
      }
    }
    xmlText = xmlOrBytes;
  } else {
    throw new Error('Invalid GPX input.');
  }

  if (!xmlText.trim()) {
    throw new Error('This GPX file is empty. Export a course track or route and try again.');
  }

  let sawGpxRoot = false;
  let metadataName = '';
  let trackName = '';
  let routeName = '';

  // Points are grouped by <trk>/<trkseg> and <rte>, so separate sections are never silently joined.
  const trkSections: RawPoint[][] = [];
  const rteSections: RawPoint[][] = [];
  let trkPointCount = 0;
  let rtePointCount = 0;
  let openTrkSection: RawPoint[] | null = null;
  let openRteSection: RawPoint[] | null = null;
  const waypoints: RawWaypoint[] = [];

  let activePt: RawPoint | null = null;
  let activePtKind: 'trkpt' | 'rtept' | null = null;
  let activeWpt: RawWaypoint | null = null;

  scanXml(xmlText, {
    open(name, attrs, path) {
      if (name === 'gpx' && path.length === 1) {
        sawGpxRoot = true;
      } else if (name === 'trk' || name === 'trkseg') {
        openTrkSection = null;
      } else if (name === 'rte') {
        openRteSection = null;
      } else if (name === 'trkpt') {
        const lat = parseXmlNumber(attrs.lat ?? '');
        const lon = parseXmlNumber(attrs.lon ?? '');
        if (isValidCoordinate(lat, lon)) {
          activePt = { lat: lat as number, lon: lon as number };
          activePtKind = 'trkpt';
        } else {
          activePt = null;
          activePtKind = null;
        }
      } else if (name === 'rtept') {
        const lat = parseXmlNumber(attrs.lat ?? '');
        const lon = parseXmlNumber(attrs.lon ?? '');
        if (isValidCoordinate(lat, lon)) {
          activePt = { lat: lat as number, lon: lon as number };
          activePtKind = 'rtept';
        } else {
          activePt = null;
          activePtKind = null;
        }
      } else if (name === 'wpt') {
        const lat = parseXmlNumber(attrs.lat ?? '');
        const lon = parseXmlNumber(attrs.lon ?? '');
        if (isValidCoordinate(lat, lon)) {
          activeWpt = {
            lat: lat as number,
            lon: lon as number,
            name: '',
            desc: '',
            type: '',
            sym: '',
          };
        } else {
          activeWpt = null;
        }
      }
    },
    text(value, path) {
      const leaf = path[path.length - 1];
      const parent = path[path.length - 2];

      if (activePt && (parent === 'trkpt' || parent === 'rtept') && leaf === 'ele') {
        const ele = parseXmlNumber(value);
        if (ele !== undefined) activePt.eleM = ele;
        return;
      }

      if (activeWpt && parent === 'wpt') {
        const trimmed = value.trim();
        if (leaf === 'name' && !activeWpt.name) activeWpt.name = trimmed;
        else if ((leaf === 'desc' || leaf === 'cmt') && !activeWpt.desc) activeWpt.desc = trimmed;
        else if (leaf === 'type' && !activeWpt.type) activeWpt.type = trimmed;
        else if (leaf === 'sym' && !activeWpt.sym) activeWpt.sym = trimmed;
        return;
      }

      if (leaf === 'name') {
        const trimmed = value.trim();
        if (!trimmed) return;
        if (parent === 'trk' && !trackName) trackName = trimmed;
        else if (parent === 'rte' && !routeName) routeName = trimmed;
        else if ((parent === 'metadata' || parent === 'gpx') && !metadataName) metadataName = trimmed;
      }
    },
    close(name) {
      if (name === 'trkpt') {
        if (activePt && activePtKind === 'trkpt') {
          if (trkPointCount >= MAX_COURSE_TRACKPOINTS) {
            throw new RangeError(
              `Course GPX contains more than ${MAX_COURSE_TRACKPOINTS.toLocaleString()} track points. Simplify the GPX track and try again.`,
            );
          }
          if (!openTrkSection) {
            openTrkSection = [];
            trkSections.push(openTrkSection);
          }
          openTrkSection.push(activePt);
          trkPointCount++;
        }
        activePt = null;
        activePtKind = null;
      } else if (name === 'rtept') {
        if (activePt && activePtKind === 'rtept') {
          if (rtePointCount >= MAX_COURSE_TRACKPOINTS) {
            throw new RangeError(
              `Course GPX contains more than ${MAX_COURSE_TRACKPOINTS.toLocaleString()} route points. Simplify the GPX route and try again.`,
            );
          }
          if (!openRteSection) {
            openRteSection = [];
            rteSections.push(openRteSection);
          }
          openRteSection.push(activePt);
          rtePointCount++;
        }
        activePt = null;
        activePtKind = null;
      } else if (name === 'trkseg' || name === 'trk') {
        openTrkSection = null;
      } else if (name === 'rte') {
        openRteSection = null;
      } else if (name === 'wpt') {
        if (activeWpt && waypoints.length < MAX_COURSE_WAYPOINTS) {
          waypoints.push(activeWpt);
        }
        activeWpt = null;
      }
    },
  });

  if (!sawGpxRoot) {
    throw new Error('Could not read GPX file: missing <gpx> element. Make sure you selected a valid .gpx course file.');
  }

  const trackParts = joinCourseParts(trkSections);
  const bestTrack = longestPart(trackParts);
  const useTrack = bestTrack !== null && bestTrack.points.length >= 2;
  const parts = useTrack ? trackParts : joinCourseParts(rteSections);
  const chosen = useTrack ? bestTrack : longestPart(parts);
  const sourceKind: 'track' | 'route' = useTrack ? 'track' : 'route';

  if (!chosen || chosen.points.length < 2) {
    throw new Error(
      'Course GPX must contain at least 2 valid GPS points (<trkpt> or <rtept>). Check that the file holds a course route.',
    );
  }

  const rawPoints = chosen.points;
  const distM = chosen.distM;
  const lengthM = partLengthM(chosen);

  if (lengthM < MIN_COURSE_DISTANCE_M) {
    throw new Error(
      `Course GPX is too short (${(lengthM / METERS_PER_MILE).toFixed(2)} mi / ${Math.round(lengthM)} m). Courses must be at least 0.5 miles (800 m).`,
    );
  }

  const warnings: string[] = [];
  if (parts.length > 1) {
    const others = parts.length - 1;
    warnings.push(
      `This GPX has ${parts.length} separate ${sourceKind} sections more than ${MAX_TRACK_JOIN_GAP_M} m apart. ` +
        `Apollo used the longest one for the course and left out the other${others === 1 ? '' : 's'}.`,
    );
  }

  const { elevationsM, hasElevation } = fillMissingElevations(rawPoints, distM);
  const pass = computeElevationPass(distM, elevationsM);
  const coursePoints: CoursePoint[] = rawPoints.map((p, i) => ({ lat: p.lat, lon: p.lon, distM: distM[i] }));

  const primaryName = useTrack ? trackName || metadataName || routeName : routeName || metadataName || trackName;
  const suggestedName = primaryName || cleanFallbackName(options.fallbackName) || 'Custom GPX Course';

  return buildCourse(
    {
      suggestedName,
      suggestedCourseType: inferCourseType(coursePoints),
      pointCount: rawPoints.length,
      sourceKind,
      startLat: Math.round(rawPoints[0].lat * 10000) / 10000,
      startLon: Math.round(rawPoints[0].lon * 10000) / 10000,
      warnings,
      measurement: { ...pass, lengthM, hasElevation, waypoints: matchWaypoints(waypoints, coursePoints) },
    },
    options.targetDistanceMi,
  );
}

/**
 * Attach a parsed GPX course profile, splits, aid stations, and start coordinates
 * to a saved custom marathon in persistence so `buildRaceStrategy` and `Course`
 * training use the real GPX elevation profile instead of a flat placeholder.
 */
export function applyGpxCourseToMarathon(marathonId: string, parsed: ParsedGpxCourse): MarathonRace | null {
  try {
    const raw = persistence.getItem(CUSTOM_MARATHONS_KEY);
    const list: MarathonRace[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return null;
    const idx = list.findIndex((m) => m.id === marathonId);
    if (idx < 0) return null;

    const existing = list[idx];
    const updated: MarathonRace = {
      ...existing,
      distanceMi: parsed.distanceMi,
      website: safeWebsite(existing.website),
      course: parsed.course,
      splits: parsed.splits,
      aidStations: parsed.aidStations,
      lat: parsed.startLat,
      lon: parsed.startLon,
      courseDescription: existing.courseDescription.includes('flat (no course file)')
        ? `${existing.name}: GPX course (${parsed.distanceMi.toFixed(1)} mi, +${parsed.elevationGainFt} ft / −${parsed.elevationLossFt} ft).`
        : existing.courseDescription,
    };
    list[idx] = updated;
    persistence.setItem(CUSTOM_MARATHONS_KEY, JSON.stringify(list));
    return updated;
  } catch {
    return null;
  }
}
