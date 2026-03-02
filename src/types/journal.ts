/**
 * Training Journal types — entirely opt-in subjective tracking.
 * Disabled by default; zero UI surfaces unless user enables it.
 */

/** Mood emoji scale (1-5) */
export type MoodRating = 1 | 2 | 3 | 4 | 5;

/** Energy level (1-5) */
export type EnergyRating = 1 | 2 | 3 | 4 | 5;

/** Sleep quality (1-5) */
export type SleepQualityRating = 1 | 2 | 3 | 4 | 5;

/** RPE (Rate of Perceived Exertion) — Borg 1-10 scale */
export type RPERating = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** Running surface type */
export type SurfaceType = 'road' | 'trail' | 'track' | 'treadmill';

/** Weather conditions (manual entry or API-fetched) */
export interface WeatherEntry {
  tempF?: number;
  humidity?: number;
  wind?: string;
  conditions?: string; // e.g. "Sunny", "Rain", "Cloudy"
  source: 'manual' | 'api';
}

/** Single journal entry for a training day */
export interface JournalEntry {
  /** Date key (YYYY-MM-DD) */
  date: string;
  /** Free-form text notes */
  notes?: string;
  /** Mood: 1=terrible, 2=bad, 3=neutral, 4=good, 5=great */
  mood?: MoodRating;
  /** Energy level: 1=exhausted, 2=low, 3=moderate, 4=high, 5=excellent */
  energy?: EnergyRating;
  /** Sleep quality: 1=terrible, 2=poor, 3=fair, 4=good, 5=great */
  sleepQuality?: SleepQualityRating;
  /** Hours slept (e.g. 7.5) */
  sleepHours?: number;
  /** RPE for the day's workout (Borg 1-10) */
  rpe?: RPERating;
  /** Running surface */
  surface?: SurfaceType;
  /** Weather conditions */
  weather?: WeatherEntry;
  /** When this entry was created/last updated */
  updatedAt: string;
}

/** Journal preferences (opt-in system) */
export interface JournalPreferences {
  /** Master toggle — everything disabled when false */
  enabled: boolean;
  /** Show RPE prompt after sync (disabled by default) */
  autoPromptRPE: boolean;
  /** Fetch weather automatically via Open-Meteo (opt-in within opt-in) */
  autoFetchWeather: boolean;
  /** When journal was first enabled */
  enabledAt?: string;
}

/** Mood emoji labels for display */
export const MOOD_LABELS: Record<MoodRating, string> = {
  1: '😫 Terrible',
  2: '😞 Bad',
  3: '😐 Neutral',
  4: '🙂 Good',
  5: '😄 Great',
};

/** Energy labels for display */
export const ENERGY_LABELS: Record<EnergyRating, string> = {
  1: 'Exhausted',
  2: 'Low',
  3: 'Moderate',
  4: 'High',
  5: 'Excellent',
};

/** Sleep quality labels */
export const SLEEP_LABELS: Record<SleepQualityRating, string> = {
  1: 'Terrible',
  2: 'Poor',
  3: 'Fair',
  4: 'Good',
  5: 'Great',
};

/** RPE descriptors (Borg CR-10 scale) */
export const RPE_LABELS: Record<RPERating, string> = {
  1: 'Very Light',
  2: 'Light',
  3: 'Moderate',
  4: 'Somewhat Hard',
  5: 'Hard',
  6: 'Hard+',
  7: 'Very Hard',
  8: 'Very Hard+',
  9: 'Near Maximal',
  10: 'Maximal',
};

/** Surface labels */
export const SURFACE_LABELS: Record<SurfaceType, string> = {
  road: 'Road',
  trail: 'Trail',
  track: 'Track',
  treadmill: 'Treadmill',
};
