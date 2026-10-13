// Heart rate zones — zone definitions, HR data storage, and zone analysis.

import { persistence } from './db/persistence';

const HR_PROFILE_KEY = 'apollo_hr_profile';
const HR_HISTORY_KEY = 'apollo_hr_history';
/**
 * v1.0.7 (L-11): measured zone times (activity id → seconds in zones 1-5) for
 * activities that have no HR record yet, e.g. file imports. The sync's HR capture
 * picks them up for activities that were actually stored, so duplicates dropped
 * by the store never leave orphan HR records.
 */
const HR_MEASURED_ZONES_KEY = 'apollo_hr_measured_zones';
const MAX_PENDING_MEASURED = 500;

/** Standard 5-zone heart rate model */
export interface HRZone {
  zone: number;
  name: string;
  description: string;
  minPct: number; // % of max HR
  maxPct: number;
  minBpm: number; // computed from max HR
  maxBpm: number;
  color: string;
}

export interface HRProfile {
  maxHR: number;
  restingHR: number;
  /** Source: 'manual' | 'strava' | 'garmin' */
  source: string;
  updatedAt: string;
  /** Lactate threshold HR (if available from Garmin/Strava) */
  lthr?: number;
}

export interface ActivityHRData {
  activityId: number;
  date: string; // YYYY-MM-DD
  averageHR: number;
  maxHR: number;
  /** Time in each zone (seconds), indexed 0-4 for zones 1-5 */
  timeInZones: number[];
  /** Source: 'strava' | 'garmin' */
  source: string;
  /** Moving time for percentage calculations */
  movingTimeSec: number;
  /** Cadence if available */
  avgCadence?: number;
  /** Training effect score (Garmin) */
  trainingEffect?: number;
  /**
   * v1.0.7 (L-11): where `timeInZones` came from. 'measured' = from a heart-rate
   * stream or source-reported zone times; 'estimated' = synthesized from average
   * HR. Records written before v1.0.7 have no value and were always estimated.
   */
  zoneSource?: 'measured' | 'estimated';
}

const ZONE_DEFS: { name: string; description: string; minPct: number; maxPct: number; color: string }[] = [
  { name: 'Recovery', description: 'Very light effort, active recovery', minPct: 50, maxPct: 60, color: '#78909C' },
  {
    name: 'Aerobic',
    description: 'Easy endurance, fat burning, base building',
    minPct: 60,
    maxPct: 70,
    color: '#4FC3F7',
  },
  {
    name: 'Tempo',
    description: 'Moderate effort, improves aerobic capacity',
    minPct: 70,
    maxPct: 80,
    color: '#66BB6A',
  },
  { name: 'Threshold', description: 'Hard effort, raises lactate threshold', minPct: 80, maxPct: 90, color: '#FFA726' },
  { name: 'VO2 Max', description: 'Maximum effort, builds speed and power', minPct: 90, maxPct: 100, color: '#EF5350' },
];

/** Default max HR estimation: 220 - age (or 190 if no age) */
const DEFAULT_MAX_HR = 190;
const DEFAULT_RESTING_HR = 60;

export function getHRProfile(): HRProfile {
  try {
    const raw = persistence.getItem(HR_PROFILE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fallthrough */
  }
  return { maxHR: DEFAULT_MAX_HR, restingHR: DEFAULT_RESTING_HR, source: 'default', updatedAt: '' };
}

export function setHRProfile(profile: HRProfile): void {
  persistence.setItem(HR_PROFILE_KEY, JSON.stringify(profile));
}

/** Compute the 5 HR zones from the user's max HR */
export function getHRZones(maxHR?: number): HRZone[] {
  const hr = maxHR ?? getHRProfile().maxHR;
  return ZONE_DEFS.map((def, i) => ({
    zone: i + 1,
    name: def.name,
    description: def.description,
    minPct: def.minPct,
    maxPct: def.maxPct,
    minBpm: Math.round((hr * def.minPct) / 100),
    maxBpm: Math.round((hr * def.maxPct) / 100),
    color: def.color,
  }));
}

/** Determine which zone a given HR falls into */
export function getZoneForHR(hr: number, maxHR?: number): number {
  const zones = getHRZones(maxHR);
  for (let i = zones.length - 1; i >= 0; i--) {
    if (hr >= zones[i].minBpm) return zones[i].zone;
  }
  return 1;
}

/** Get all stored HR history records */
export function getHRHistory(): ActivityHRData[] {
  try {
    const raw = persistence.getItem(HR_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHRHistory(history: ActivityHRData[]): void {
  persistence.setItem(HR_HISTORY_KEY, JSON.stringify(history));
}

/** Add or update HR data for an activity */
export function upsertActivityHR(data: ActivityHRData): void {
  const history = getHRHistory();
  const idx = history.findIndex((h) => h.activityId === data.activityId);
  if (idx >= 0) {
    const prev = history[idx];
    // v1.0.7 (L-11): a later average-HR rebuild must not replace measured zone times.
    history[idx] =
      prev.zoneSource === 'measured' && data.zoneSource !== 'measured'
        ? { ...data, timeInZones: prev.timeInZones, zoneSource: 'measured' }
        : data;
  } else {
    history.push(data);
  }
  // Keep last 2000 activities max (IndexedDB allows much larger datasets)
  if (history.length > 2000) history.splice(0, history.length - 2000);
  saveHRHistory(history);
}

/**
 * v1.0.7 (L-11): measured time in zones (seconds, zones 1-5) from a heart-rate
 * stream. Each sample's HR counts for the time until the next sample (gaps over
 * 30 s, e.g. auto-pause, are capped). Below zone 1 counts as zone 1. Null when
 * the stream has fewer than 2 HR samples.
 */
export function timeInZonesFromStream(
  samples: ReadonlyArray<{ t: number; hr?: number }>,
  maxHR: number,
): number[] | null {
  if (!(maxHR > 0)) return null;
  const pts = samples.filter((s) => Number.isFinite(s.t) && typeof s.hr === 'number' && s.hr > 0);
  if (pts.length < 2) return null;
  const zones = getHRZones(maxHR);
  const out = [0, 0, 0, 0, 0];
  for (let i = 0; i < pts.length - 1; i++) {
    const dt = Math.min(30, Math.max(0, pts[i + 1].t - pts[i].t));
    if (dt <= 0) continue;
    const hr = pts[i].hr as number;
    let z = 0;
    for (let k = zones.length - 1; k >= 0; k--) {
      if (hr >= zones[k].minBpm) {
        z = k;
        break;
      }
    }
    out[z] += dt;
  }
  const total = out.reduce((s, v) => s + v, 0);
  return total > 0 ? out.map((v) => Math.round(v)) : null;
}

/** True when `v` is five finite, non-negative zone times with a positive total. */
function isZoneTimes(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === 5 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) &&
    v.reduce((s: number, x: number) => s + x, 0) > 0
  );
}

/**
 * Estimate time-in-zones from average HR when detailed zone data isn't available.
 * v1.0.7 (L-11): this is a synthetic bell curve around average HR, not a
 * measurement; records built from it are tagged `zoneSource: 'estimated'`.
 */
export function estimateTimeInZones(avgHR: number, maxHR: number, movingTimeSec: number): number[] {
  const zones = getHRZones(maxHR);
  const timeInZones = [0, 0, 0, 0, 0];
  const pct = (avgHR / maxHR) * 100;

  // Gaussian-like distribution centered on the zone that avgHR falls into
  for (let i = 0; i < 5; i++) {
    const zoneMid = (zones[i].minPct + zones[i].maxPct) / 2;
    const dist = Math.abs(pct - zoneMid) / 10;
    const weight = Math.exp(-dist * dist);
    timeInZones[i] = weight;
  }

  // Normalize
  const total = timeInZones.reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (let i = 0; i < 5; i++) {
      timeInZones[i] = Math.round((timeInZones[i] / total) * movingTimeSec);
    }
  }
  return timeInZones;
}

/**
 * Build HR data from a synced activity (uses average_heartrate / max_heartrate).
 * @param source Where the activity came from ('intervals' | 'strava').
 */
export function buildHRDataFromActivity(
  activityId: number,
  date: string,
  averageHR: number,
  maxHR: number,
  movingTimeSec: number,
  avgCadence?: number,
  source: string = 'strava',
  /** v1.0.7 (L-11): real zone times (s, zones 1-5) from an HR stream or the source, when available. */
  measuredTimeInZones?: number[] | null,
): ActivityHRData | null {
  if (!averageHR || averageHR <= 0) return null;

  const profile = getHRProfile();
  // Update max HR if we see a higher value from an activity
  // Guard against sensor spikes: must be between 120-230 and within 15% of current maxHR.
  // v1.0.7 (L-10): never overwrite a max HR the athlete entered (e.g. from a lab or field test).
  if (
    profile.source !== 'manual' &&
    maxHR > profile.maxHR &&
    maxHR < 230 &&
    maxHR >= 120 &&
    maxHR <= profile.maxHR * 1.15
  ) {
    console.info(`[Apollo HR] Auto-updated maxHR: ${profile.maxHR} → ${maxHR} (from activity ${activityId})`);
    setHRProfile({ ...profile, maxHR, source, updatedAt: new Date().toISOString() });
  }

  // L-11: prefer measured zone times; only synthesize (and say so) when there are none.
  const measured = isZoneTimes(measuredTimeInZones) ? measuredTimeInZones.map((x) => Math.round(x)) : null;
  const timeInZones = measured ?? estimateTimeInZones(averageHR, profile.maxHR, movingTimeSec);

  return {
    activityId,
    date,
    averageHR,
    maxHR: maxHR || profile.maxHR,
    timeInZones,
    source,
    movingTimeSec,
    avgCadence,
    zoneSource: measured ? 'measured' : 'estimated',
  };
}

function readPendingMeasured(): Record<string, number[]> {
  try {
    const raw = persistence.getItem(HR_MEASURED_ZONES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function savePendingMeasured(activityId: number, zones: number[]): void {
  const map = readPendingMeasured();
  delete map[String(activityId)];
  map[String(activityId)] = zones;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PENDING_MEASURED))) delete map[k];
  persistence.setItem(HR_MEASURED_ZONES_KEY, JSON.stringify(map));
}

/**
 * v1.0.7 (L-11): measured zone times (s, zones 1-5) for an activity, from its HR
 * record or from zones saved at import time, or null.
 */
export function getMeasuredTimeInZones(activityId: number): number[] | null {
  const rec = getHRHistory().find((h) => h.activityId === activityId);
  if (rec && rec.zoneSource === 'measured' && isZoneTimes(rec.timeInZones)) return rec.timeInZones.slice();
  const pending = readPendingMeasured()[String(activityId)];
  return isZoneTimes(pending) ? pending.slice() : null;
}

/**
 * v1.0.7 (L-11): store measured time in zones from an activity's heart-rate
 * stream (e.g. when its detail is fetched from intervals.icu). Updates the
 * activity's HR record, or creates one from the stream when there is none.
 * With `createRecord: false` (file imports, before the store has deduplicated
 * the activity) zones for an activity without a record are kept aside and used
 * when the sync's HR capture builds that record. Returns true when saved.
 */
export function recordMeasuredTimeInZones(
  activityId: number,
  date: string,
  samples: ReadonlyArray<{ t: number; hr?: number }>,
  opts: { movingTimeSec?: number; averageHR?: number; maxHR?: number; source?: string; createRecord?: boolean } = {},
): boolean {
  const profile = getHRProfile();
  const zones = timeInZonesFromStream(samples, profile.maxHR);
  if (!zones) return false;
  const history = getHRHistory();
  const existing = history.find((h) => h.activityId === activityId);
  if (!existing && opts.createRecord === false) {
    savePendingMeasured(activityId, zones);
    return true;
  }
  const hrs = samples.map((s) => s.hr).filter((h): h is number => typeof h === 'number' && h > 0);
  const streamAvg = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : 0;
  const streamMax = hrs.length ? Math.max(...hrs) : 0;
  upsertActivityHR({
    ...(existing ?? {
      activityId,
      date,
      averageHR: opts.averageHR && opts.averageHR > 0 ? opts.averageHR : streamAvg,
      maxHR: opts.maxHR && opts.maxHR > 0 ? opts.maxHR : streamMax,
      source: opts.source ?? 'intervals',
      movingTimeSec:
        opts.movingTimeSec && opts.movingTimeSec > 0 ? opts.movingTimeSec : zones.reduce((a, b) => a + b, 0),
    }),
    timeInZones: zones,
    zoneSource: 'measured',
  });
  return true;
}

/** @deprecated Use buildHRDataFromActivity (source-aware). Kept for backward compatibility. */
export function buildHRDataFromStrava(
  activityId: number,
  date: string,
  averageHR: number,
  maxHR: number,
  movingTimeSec: number,
  avgCadence?: number,
): ActivityHRData | null {
  return buildHRDataFromActivity(activityId, date, averageHR, maxHR, movingTimeSec, avgCadence, 'strava');
}

/** Get HR trend data: rolling average of avg HR over recent runs */
export function getHRTrend(days: number = 30): { date: string; avgHR: number; maxHR: number }[] {
  const history = getHRHistory();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return history
    .filter((h) => h.date >= cutoffStr)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((h) => ({ date: h.date, avgHR: h.averageHR, maxHR: h.maxHR }));
}

/** Aggregate zone distribution across all recent activities */
export function getAggregateZoneDistribution(days: number = 30): {
  zones: HRZone[];
  totalTime: number[];
  totalTimeSec: number;
  percentages: number[];
  /** v1.0.7 (L-11): true when any activity in the window has synthesized (not measured) zone times. */
  estimated: boolean;
  /** v1.0.7 (L-11): share (0-1) of the window's time whose zones were measured. */
  measuredShare: number;
} {
  const history = getHRHistory();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const totalTime = [0, 0, 0, 0, 0];
  let totalTimeSec = 0;
  let measuredSec = 0;
  let estimated = false;

  for (const h of history) {
    if (h.date < cutoffStr) continue;
    for (let i = 0; i < 5; i++) {
      totalTime[i] += h.timeInZones[i] || 0;
    }
    totalTimeSec += h.movingTimeSec;
    // L-11: anything not explicitly measured (incl. pre-1.0.7 records) is an estimate.
    if (h.zoneSource === 'measured') measuredSec += h.movingTimeSec;
    else estimated = true;
  }

  const percentages = totalTime.map((t) => (totalTimeSec > 0 ? Math.round((t / totalTimeSec) * 100) : 0));

  return {
    zones: getHRZones(),
    totalTime,
    totalTimeSec,
    percentages,
    estimated,
    measuredShare: totalTimeSec > 0 ? measuredSec / totalTimeSec : 0,
  };
}

/** Calculate aerobic efficiency: pace at a given HR (lower = more efficient) */
export function getAerobicEfficiency(recentActivities: { avgHR: number; paceMinPerMi: number }[]): number | null {
  if (recentActivities.length < 3) return null;
  // Efficiency = avg pace / avg HR ratio (lower pace at same HR = better)
  const total = recentActivities.reduce((acc, a) => ({ pace: acc.pace + a.paceMinPerMi, hr: acc.hr + a.avgHR }), {
    pace: 0,
    hr: 0,
  });
  const avgPace = total.pace / recentActivities.length;
  const avgHR = total.hr / recentActivities.length;
  // Return efficiency factor: pace * 1000 / HR (arbitrary units, lower = better pace at HR)
  return avgHR > 0 ? (avgPace / avgHR) * 100 : null;
}
