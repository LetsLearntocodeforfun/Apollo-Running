/**
 * effortService.ts — Route Effort Recognition Engine for Apollo Running.
 *
 * Identifies repeated routes from Strava activities, tracks every effort
 * on each route, and generates data-driven achievements and insights.
 *
 * Capabilities:
 *   - Route fingerprinting via start/end/centroid/distance matching
 *   - Effort ranking: gold / silver / bronze for pace and HR efficiency
 *   - Comparative insights: pace deltas, HR improvements, cadence changes
 *   - All data stored locally, computed during the auto-sync pipeline
 */

import { persistence } from './db/persistence';
import { decodePolyline, haversineDistance, type LatLng } from './routeService';
import type { StravaActivity } from './strava';

// ─── Types ───────────────────────────────────────────────────

export type AchievementTier = 'gold' | 'silver' | 'bronze';

export interface RouteFingerprint {
  id: string;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  centroidLat: number;
  centroidLng: number;
  /** Reference distance in meters (average of all efforts). */
  referenceDistanceMeters: number;
  /** Human-readable name derived from activity names. */
  name: string;
}

export interface RouteEffort {
  activityId: number;
  activityName: string;
  date: string; // YYYY-MM-DD
  distanceMeters: number;
  movingTimeSec: number;
  paceMinPerMi: number;
  averageHR: number | null;
  maxHR: number | null;
  avgCadence: number | null; // steps per minute (doubled from Strava's stride rate)
  totalElevationGain: number | null;
  sufferScore: number | null;
}

export interface RouteBundle {
  fingerprint: RouteFingerprint;
  efforts: RouteEffort[];
}

export interface EffortInsight {
  category: 'pace' | 'heart_rate' | 'efficiency' | 'cadence' | 'overall';
  message: string;
  /** positive = improvement, neutral = baseline/no change, negative = regression */
  sentiment: 'positive' | 'neutral' | 'negative';
}

export interface EffortRecognition {
  activityId: number;
  routeId: string;
  routeName: string;
  /** Which effort this is, e.g. 5 = 5th time running this route. */
  effortNumber: number;
  totalEfforts: number;
  /** Pace ranking tier (null if < 2 efforts or not in top 3). */
  paceTier: AchievementTier | null;
  /** HR efficiency ranking tier (null if insufficient HR data or not top 3). */
  hrEfficiencyTier: AchievementTier | null;
  /** Data-driven insight statements. */
  insights: EffortInsight[];
  analyzedAt: string;
}

// ─── Constants ───────────────────────────────────────────────

const ROUTE_BUNDLES_KEY = 'apollo_route_bundles';
const EFFORT_RECOGNITIONS_KEY = 'apollo_effort_recognitions';
const METERS_TO_MILES = 0.000621371;

/** Max haversine distance (m) for start / end points to be "same location". */
const START_END_TOLERANCE_M = 300;
/** Max haversine distance (m) for route centroids. */
const CENTROID_TOLERANCE_M = 500;
/** Max relative distance difference (0–1). */
const DISTANCE_TOLERANCE_PCT = 0.20;

/** Minimum % change for a pace difference to be called out. */
const PACE_NOTABLE_PCT = 1.0;
/** Minimum % change for an HR difference to be called out. */
const HR_NOTABLE_PCT = 3.0;
/** Minimum cadence change (spm) considered notable. */
const CADENCE_NOTABLE_SPM = 2;
/** Minimum % efficiency improvement worth mentioning. */
const EFFICIENCY_NOTABLE_PCT = 5;

const MAX_ROUTE_BUNDLES = 100;
const MAX_EFFORTS_PER_ROUTE = 50;
const MAX_RECOGNITIONS = 500;
/** Activities shorter than this are ignored. */
const MIN_DISTANCE_M = 400;

const RUN_TYPES = ['Run', 'VirtualRun', 'TrailRun'];

// ─── Persistence ─────────────────────────────────────────────

function getRouteBundles(): RouteBundle[] {
  try {
    const raw = persistence.getItem(ROUTE_BUNDLES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRouteBundles(bundles: RouteBundle[]): void {
  if (bundles.length > MAX_ROUTE_BUNDLES) {
    bundles.sort((a, b) => b.efforts.length - a.efforts.length);
    bundles.length = MAX_ROUTE_BUNDLES;
  }
  persistence.setItem(ROUTE_BUNDLES_KEY, JSON.stringify(bundles));
}

function getRecognitionsMap(): Record<number, EffortRecognition> {
  try {
    const raw = persistence.getItem(EFFORT_RECOGNITIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveRecognitionsMap(map: Record<number, EffortRecognition>): void {
  const entries = Object.entries(map);
  if (entries.length > MAX_RECOGNITIONS) {
    entries.sort((a, b) => b[1].analyzedAt.localeCompare(a[1].analyzedAt));
    const trimmed: Record<number, EffortRecognition> = {};
    for (let i = 0; i < MAX_RECOGNITIONS; i++) {
      trimmed[Number(entries[i][0])] = entries[i][1];
    }
    persistence.setItem(EFFORT_RECOGNITIONS_KEY, JSON.stringify(trimmed));
    return;
  }
  persistence.setItem(EFFORT_RECOGNITIONS_KEY, JSON.stringify(map));
}

// ─── Utility ─────────────────────────────────────────────────

/** Centroid (arithmetic mean) of a coordinate array. */
export function calcCentroid(coords: LatLng[]): LatLng {
  if (coords.length === 0) return { lat: 0, lng: 0 };
  const sum = coords.reduce(
    (acc, c) => ({ lat: acc.lat + c.lat, lng: acc.lng + c.lng }),
    { lat: 0, lng: 0 },
  );
  return { lat: sum.lat / coords.length, lng: sum.lng / coords.length };
}

function calcPace(distanceMeters: number, movingTimeSec: number): number {
  if (!distanceMeters || !movingTimeSec) return 0;
  return (movingTimeSec / 60) / (distanceMeters * METERS_TO_MILES);
}

export function formatPace(paceMinPerMi: number): string {
  if (!paceMinPerMi || paceMinPerMi > 30) return '—';
  const totalSec = Math.round(paceMinPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

/** Percentage change from old to new (positive = increase). */
function pctChange(oldVal: number, newVal: number): number {
  if (!oldVal) return 0;
  return ((newVal - oldVal) / oldVal) * 100;
}

/** Assign a tier based on 1-based rank and total effort count. */
export function assignTier(rank: number, total: number): AchievementTier | null {
  if (total < 2) return null;
  if (rank === 1) return 'gold';
  if (rank === 2) return 'silver';
  if (rank === 3 && total >= 3) return 'bronze';
  return null;
}

// ─── Route Matching ──────────────────────────────────────────

/** Deterministic ID from rounded grid cells (fallback identity). */
function generateRouteId(start: LatLng, end: LatLng, centroid: LatLng): string {
  const g = (n: number) => Math.round(n * 1000);
  return `r_${g(start.lat)}_${g(start.lng)}_${g(end.lat)}_${g(end.lng)}_${g(centroid.lat)}_${g(centroid.lng)}`;
}

/**
 * Find a matching bundle for the given route in the bundles array.
 * Matching criteria: start within 300 m, end within 300 m,
 * centroid within 500 m, distance within 20 %.
 */
export function findMatchingBundle(
  coords: LatLng[],
  distanceMeters: number,
  bundles: RouteBundle[],
): RouteBundle | null {
  const start = coords[0];
  const end = coords[coords.length - 1];
  const centroid = calcCentroid(coords);

  for (const bundle of bundles) {
    const fp = bundle.fingerprint;

    if (haversineDistance(start, { lat: fp.startLat, lng: fp.startLng }) > START_END_TOLERANCE_M) continue;
    if (haversineDistance(end, { lat: fp.endLat, lng: fp.endLng }) > START_END_TOLERANCE_M) continue;

    const maxDist = Math.max(distanceMeters, fp.referenceDistanceMeters);
    if (maxDist > 0 && Math.abs(distanceMeters - fp.referenceDistanceMeters) / maxDist > DISTANCE_TOLERANCE_PCT) continue;

    if (haversineDistance(centroid, { lat: fp.centroidLat, lng: fp.centroidLng }) > CENTROID_TOLERANCE_M) continue;

    return bundle;
  }
  return null;
}

/** Create a new, empty route bundle. */
function createBundle(coords: LatLng[], distanceMeters: number, name: string): RouteBundle {
  const start = coords[0];
  const end = coords[coords.length - 1];
  const centroid = calcCentroid(coords);
  return {
    fingerprint: {
      id: generateRouteId(start, end, centroid),
      startLat: start.lat,
      startLng: start.lng,
      endLat: end.lat,
      endLng: end.lng,
      centroidLat: centroid.lat,
      centroidLng: centroid.lng,
      referenceDistanceMeters: distanceMeters,
      name,
    },
    efforts: [],
  };
}

// ─── Analysis Engine ─────────────────────────────────────────

/**
 * Core analysis: compare a new effort against the full history of a route.
 * Returns tier assignments and data-driven insight statements.
 */
function analyzeEffort(
  effort: RouteEffort,
  bundle: RouteBundle,
): { paceTier: AchievementTier | null; hrEfficiencyTier: AchievementTier | null; insights: EffortInsight[] } {
  const insights: EffortInsight[] = [];
  const allEfforts = bundle.efforts; // includes the new effort
  const previousEfforts = allEfforts.filter((e) => e.activityId !== effort.activityId);

  // First effort on this route — nothing to compare yet
  if (previousEfforts.length === 0) {
    return { paceTier: null, hrEfficiencyTier: null, insights: [] };
  }

  // "Last effort" = most recent effort BEFORE this effort's date
  const olderEfforts = previousEfforts
    .filter((e) => e.date < effort.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  const lastEffort = olderEfforts.length > 0 ? olderEfforts[0] : null;

  // ── 1. Pace Ranking & Comparison ──────────────────────────

  let paceTier: AchievementTier | null = null;

  if (effort.paceMinPerMi > 0) {
    const validPaces = allEfforts
      .filter((e) => e.paceMinPerMi > 0)
      .map((e) => e.paceMinPerMi);

    if (validPaces.length >= 2) {
      const sorted = [...validPaces].sort((a, b) => a - b); // ascending — fastest first
      const rank = sorted.indexOf(effort.paceMinPerMi) + 1;
      paceTier = assignTier(rank, sorted.length);

      if (rank === 1) {
        insights.push({
          category: 'pace',
          message: 'Course record — your fastest effort on this route',
          sentiment: 'positive',
        });
      }
    }

    // vs last attempt
    if (lastEffort && lastEffort.paceMinPerMi > 0) {
      const delta = pctChange(lastEffort.paceMinPerMi, effort.paceMinPerMi);
      if (Math.abs(delta) >= PACE_NOTABLE_PCT) {
        if (delta < 0) {
          insights.push({
            category: 'pace',
            message: `Your pace was ${formatPace(effort.paceMinPerMi)} — ${Math.abs(delta).toFixed(1)}% faster than your last effort on this route (${formatPace(lastEffort.paceMinPerMi)})`,
            sentiment: 'positive',
          });
        } else {
          insights.push({
            category: 'pace',
            message: `Your pace was ${formatPace(effort.paceMinPerMi)} — ${delta.toFixed(1)}% slower than your last effort (${formatPace(lastEffort.paceMinPerMi)})`,
            sentiment: 'negative',
          });
        }
      } else {
        insights.push({
          category: 'pace',
          message: `Your pace was ${formatPace(effort.paceMinPerMi)} — consistent with your last effort (${formatPace(lastEffort.paceMinPerMi)})`,
          sentiment: 'neutral',
        });
      }
    }
  }

  // ── 2. Heart Rate Comparison ──────────────────────────────

  if (effort.averageHR && effort.averageHR > 0) {
    // vs last attempt with HR
    const lastWithHR = lastEffort?.averageHR && lastEffort.averageHR > 0 ? lastEffort : null;
    if (lastWithHR) {
      const hrDelta = pctChange(lastWithHR.averageHR!, effort.averageHR);
      if (Math.abs(hrDelta) >= HR_NOTABLE_PCT) {
        if (hrDelta < 0) {
          insights.push({
            category: 'heart_rate',
            message: `Your heart rate averaged ${Math.round(effort.averageHR)} bpm — ${Math.abs(hrDelta).toFixed(0)}% lower than your last effort on this route (${Math.round(lastWithHR.averageHR!)} bpm)`,
            sentiment: 'positive',
          });
        } else {
          insights.push({
            category: 'heart_rate',
            message: `Your heart rate averaged ${Math.round(effort.averageHR)} bpm — ${hrDelta.toFixed(0)}% higher than your last effort (${Math.round(lastWithHR.averageHR!)} bpm)`,
            sentiment: 'negative',
          });
        }
      }
    }

    // vs route average (3+ efforts with HR)
    const hrEfforts = allEfforts.filter((e) => e.averageHR && e.averageHR > 0);
    if (hrEfforts.length >= 3) {
      const avgHR = hrEfforts.reduce((s, e) => s + (e.averageHR ?? 0), 0) / hrEfforts.length;
      const hrAvgDelta = pctChange(avgHR, effort.averageHR);
      if (hrAvgDelta < -HR_NOTABLE_PCT) {
        insights.push({
          category: 'heart_rate',
          message: `Heart rate ${Math.abs(hrAvgDelta).toFixed(0)}% below your route average of ${Math.round(avgHR)} bpm — your cardiovascular fitness is improving`,
          sentiment: 'positive',
        });
      }
    }
  }

  // ── 3. HR Efficiency Ranking ──────────────────────────────

  let hrEfficiencyTier: AchievementTier | null = null;

  const effortsWithBoth = allEfforts.filter(
    (e) => e.averageHR && e.averageHR > 0 && e.paceMinPerMi > 0,
  );

  if (
    effort.averageHR &&
    effort.averageHR > 0 &&
    effort.paceMinPerMi > 0 &&
    effortsWithBoth.length >= 2
  ) {
    // Efficiency = pace / HR — lower = better (faster pace at lower HR)
    const efficiencies = effortsWithBoth.map((e) => ({
      activityId: e.activityId,
      eff: e.paceMinPerMi / (e.averageHR ?? 1),
    }));
    const sortedEff = [...efficiencies].sort((a, b) => a.eff - b.eff);
    const effRank = sortedEff.findIndex((e) => e.activityId === effort.activityId) + 1;
    hrEfficiencyTier = assignTier(effRank, sortedEff.length);

    // Efficiency comparison to most recent previous effort with HR
    const prevWithHR = olderEfforts
      .filter((e) => e.averageHR && e.averageHR > 0 && e.paceMinPerMi > 0)
      .sort((a, b) => b.date.localeCompare(a.date));

    if (prevWithHR.length > 0) {
      const lastHR = prevWithHR[0];
      const lastEff = lastHR.paceMinPerMi / (lastHR.averageHR ?? 1);
      const currentEff = effort.paceMinPerMi / effort.averageHR;
      const effDelta = pctChange(lastEff, currentEff);

      if (effDelta < -EFFICIENCY_NOTABLE_PCT) {
        insights.push({
          category: 'efficiency',
          message: `Improved efficiency — ${formatPace(effort.paceMinPerMi)} at ${Math.round(effort.averageHR)} bpm vs ${formatPace(lastHR.paceMinPerMi)} at ${Math.round(lastHR.averageHR!)} bpm last time`,
          sentiment: 'positive',
        });
      }
    }
  }

  // ── 4. Cadence Comparison ─────────────────────────────────

  if (effort.avgCadence && effort.avgCadence > 0) {
    const cadenceEfforts = previousEfforts.filter((e) => e.avgCadence && e.avgCadence > 0);
    if (cadenceEfforts.length > 0) {
      const avgCadence =
        cadenceEfforts.reduce((s, e) => s + (e.avgCadence ?? 0), 0) / cadenceEfforts.length;
      const cadenceDelta = effort.avgCadence - avgCadence;

      if (Math.abs(cadenceDelta) >= CADENCE_NOTABLE_SPM) {
        insights.push({
          category: 'cadence',
          message:
            cadenceDelta > 0
              ? `Cadence was ${Math.round(effort.avgCadence)} spm — ${Math.round(cadenceDelta)} spm higher than your route average (${Math.round(avgCadence)} spm)`
              : `Cadence was ${Math.round(effort.avgCadence)} spm — ${Math.round(Math.abs(cadenceDelta))} spm lower than your route average (${Math.round(avgCadence)} spm)`,
          sentiment: cadenceDelta > 0 ? 'positive' : 'neutral',
        });
      }
    }
  }

  // ── 5. Overall Synthesis ──────────────────────────────────

  if (lastEffort && effort.paceMinPerMi > 0 && lastEffort.paceMinPerMi > 0) {
    const paceBetter =
      effort.paceMinPerMi < lastEffort.paceMinPerMi * (1 - PACE_NOTABLE_PCT / 100);

    if (effort.averageHR && lastEffort.averageHR) {
      const hrLower =
        effort.averageHR < lastEffort.averageHR * (1 - HR_NOTABLE_PCT / 100);

      if (paceBetter && hrLower) {
        insights.push({
          category: 'overall',
          message:
            'Strong improvement — faster pace with lower heart rate than your previous attempt',
          sentiment: 'positive',
        });
      } else if (!paceBetter && hrLower) {
        const hrDelta = Math.abs(pctChange(lastEffort.averageHR, effort.averageHR));
        insights.push({
          category: 'overall',
          message: `Your fitness is showing — similar pace at ${hrDelta.toFixed(0)}% lower cardiac cost`,
          sentiment: 'positive',
        });
      }
    }
  }

  return { paceTier, hrEfficiencyTier, insights };
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Process a Strava activity through the effort recognition engine.
 * Called during auto-sync and when browsing activities.
 * Returns the recognition result (also persisted locally).
 */
export function processActivityEffort(activity: StravaActivity): EffortRecognition | null {
  // Validate: must be a run with a polyline and meaningful distance
  if (!RUN_TYPES.includes(activity.type) && !RUN_TYPES.includes(activity.sport_type)) return null;
  const polyline = activity.map?.summary_polyline;
  if (!polyline) return null;
  if (activity.distance < MIN_DISTANCE_M) return null;

  const coords = decodePolyline(polyline);
  if (coords.length < 2) return null;

  // Load all bundles
  const bundles = getRouteBundles();

  // Check if already processed
  const existingRecognition = getRecognitionsMap()[activity.id];

  // Find or create bundle
  let bundle = findMatchingBundle(coords, activity.distance, bundles);
  const isNewRoute = !bundle;
  if (!bundle) {
    bundle = createBundle(coords, activity.distance, activity.name);
    bundles.push(bundle);
  }

  // Avoid duplicate efforts in bundle
  if (bundle.efforts.some((e) => e.activityId === activity.id)) {
    return existingRecognition ?? null;
  }

  // Build effort record
  const effort: RouteEffort = {
    activityId: activity.id,
    activityName: activity.name,
    date: activity.start_date_local.slice(0, 10),
    distanceMeters: activity.distance,
    movingTimeSec: activity.moving_time,
    paceMinPerMi: calcPace(activity.distance, activity.moving_time),
    averageHR: activity.average_heartrate ?? null,
    maxHR: activity.max_heartrate ?? null,
    avgCadence: activity.average_cadence ? Math.round(activity.average_cadence * 2) : null,
    totalElevationGain: activity.total_elevation_gain ?? null,
    sufferScore: activity.suffer_score ?? null,
  };

  // Add effort and keep chronological order
  bundle.efforts.push(effort);
  bundle.efforts.sort((a, b) => a.date.localeCompare(b.date));

  // Trim oldest if too many
  if (bundle.efforts.length > MAX_EFFORTS_PER_ROUTE) {
    bundle.efforts = bundle.efforts.slice(-MAX_EFFORTS_PER_ROUTE);
  }

  // Update the reference distance to the average of all efforts
  if (bundle.efforts.length > 1) {
    bundle.fingerprint.referenceDistanceMeters =
      bundle.efforts.reduce((s, e) => s + e.distanceMeters, 0) / bundle.efforts.length;
  }

  // Save bundles (the array already contains the modified / new bundle)
  if (!isNewRoute) {
    const idx = bundles.findIndex((b) => b.fingerprint.id === bundle!.fingerprint.id);
    if (idx >= 0) bundles[idx] = bundle;
  }
  saveRouteBundles(bundles);

  // Run analysis
  const { paceTier, hrEfficiencyTier, insights } = analyzeEffort(effort, bundle);

  const effortIndex = bundle.efforts.findIndex((e) => e.activityId === effort.activityId);

  const recognition: EffortRecognition = {
    activityId: activity.id,
    routeId: bundle.fingerprint.id,
    routeName: bundle.fingerprint.name,
    effortNumber: effortIndex + 1,
    totalEfforts: bundle.efforts.length,
    paceTier,
    hrEfficiencyTier,
    insights,
    analyzedAt: new Date().toISOString(),
  };

  // Persist
  const map = getRecognitionsMap();
  map[activity.id] = recognition;
  saveRecognitionsMap(map);

  return recognition;
}

/**
 * Retrieve the stored recognition for a specific activity.
 * Returns null if none exists (first effort, no polyline, or not yet processed).
 */
export function getEffortRecognition(activityId: number): EffortRecognition | null {
  return getRecognitionsMap()[activityId] ?? null;
}

/** Retrieve route history for a specific route. */
export function getRouteHistory(routeId: string): RouteBundle | null {
  return getRouteBundles().find((b) => b.fingerprint.id === routeId) ?? null;
}

/** Retrieve all tracked route bundles. */
export function getAllRouteBundles(): RouteBundle[] {
  return getRouteBundles();
}

/**
 * Batch process: analyze stored activities that lack recognitions.
 * Processes in chronological order so history builds correctly.
 */
export function processAllStoredActivities(activities: StravaActivity[]): void {
  const existing = getRecognitionsMap();
  const sorted = [...activities]
    .filter((a) => RUN_TYPES.includes(a.type) || RUN_TYPES.includes(a.sport_type))
    .sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));

  for (const activity of sorted) {
    if (existing[activity.id]) continue;
    processActivityEffort(activity);
  }
}
