/**
 * Heart Rate Zones — zone definitions, HR data storage, and zone analysis.
 * Supports both Strava and Garmin HR data sources.
 * Uses standard 5-zone model (identical to Strava's zone display).
 */

import { persistence } from './db/persistence';

const HR_PROFILE_KEY = 'apollo_hr_profile';
const HR_HISTORY_KEY = 'apollo_hr_history';

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
}

const ZONE_DEFS: { name: string; description: string; minPct: number; maxPct: number; color: string }[] = [
  { name: 'Recovery', description: 'Very light effort, active recovery', minPct: 50, maxPct: 60, color: '#78909C' },
  { name: 'Aerobic', description: 'Easy endurance, fat burning, base building', minPct: 60, maxPct: 70, color: '#4FC3F7' },
  { name: 'Tempo', description: 'Moderate effort, improves aerobic capacity', minPct: 70, maxPct: 80, color: '#66BB6A' },
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
  } catch { /* fallthrough */ }
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
    minBpm: Math.round(hr * def.minPct / 100),
    maxBpm: Math.round(hr * def.maxPct / 100),
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
    history[idx] = data;
  } else {
    history.push(data);
  }
  // Keep last 2000 activities max (IndexedDB allows much larger datasets)
  if (history.length > 2000) history.splice(0, history.length - 2000);
  saveHRHistory(history);
}

/** Estimate time-in-zones from average HR when detailed zone data isn't available */
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

/** Build HR data from a Strava activity (uses average_heartrate / max_heartrate) */
export function buildHRDataFromStrava(
  activityId: number,
  date: string,
  averageHR: number,
  maxHR: number,
  movingTimeSec: number,
  avgCadence?: number
): ActivityHRData | null {
  if (!averageHR || averageHR <= 0) return null;

  const profile = getHRProfile();
  // Update max HR if we see a higher value from an activity
  // Guard against sensor spikes: must be between 120-230 and within 15% of current maxHR
  if (maxHR > profile.maxHR && maxHR < 230 && maxHR >= 120 && maxHR <= profile.maxHR * 1.15) {
    console.info(`[Apollo HR] Auto-updated maxHR: ${profile.maxHR} → ${maxHR} (from activity ${activityId})`);
    setHRProfile({ ...profile, maxHR, source: 'strava', updatedAt: new Date().toISOString() });
  }

  const timeInZones = estimateTimeInZones(averageHR, profile.maxHR, movingTimeSec);

  return {
    activityId,
    date,
    averageHR,
    maxHR: maxHR || profile.maxHR,
    timeInZones,
    source: 'strava',
    movingTimeSec,
    avgCadence,
  };
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
} {
  const history = getHRHistory();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const totalTime = [0, 0, 0, 0, 0];
  let totalTimeSec = 0;

  for (const h of history) {
    if (h.date < cutoffStr) continue;
    for (let i = 0; i < 5; i++) {
      totalTime[i] += h.timeInZones[i] || 0;
    }
    totalTimeSec += h.movingTimeSec;
  }

  const percentages = totalTime.map((t) => totalTimeSec > 0 ? Math.round((t / totalTimeSec) * 100) : 0);

  return {
    zones: getHRZones(),
    totalTime,
    totalTimeSec,
    percentages,
  };
}

/** Calculate aerobic efficiency: pace at a given HR (lower = more efficient) */
export function getAerobicEfficiency(
  recentActivities: { avgHR: number; paceMinPerMi: number }[]
): number | null {
  if (recentActivities.length < 3) return null;
  // Efficiency = avg pace / avg HR ratio (lower pace at same HR = better)
  const total = recentActivities.reduce(
    (acc, a) => ({ pace: acc.pace + a.paceMinPerMi, hr: acc.hr + a.avgHR }),
    { pace: 0, hr: 0 }
  );
  const avgPace = total.pace / recentActivities.length;
  const avgHR = total.hr / recentActivities.length;
  // Return efficiency factor: pace * 1000 / HR (arbitrary units, lower = better pace at HR)
  return avgHR > 0 ? (avgPace / avgHR) * 100 : null;
}
