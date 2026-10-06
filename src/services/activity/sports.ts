/**
 * Sport classification shared across the app.
 *
 * Type names follow the Strava / intervals.icu convention (both platforms use
 * the same vocabulary), e.g. Run, TrailRun, VirtualRun (Zwift run), Ride,
 * VirtualRide (Zwift ride), Swim, WeightTraining, Walk, Hike, Rowing…
 */

export type SportCategory = 'run' | 'ride' | 'swim' | 'walk' | 'strength' | 'other';

type SportTyped = { type?: string | null; sport_type?: string | null };

/** Activity types counted as running (training plan, pace analytics, PRs). */
export const RUN_TYPES: readonly string[] = ['Run', 'VirtualRun', 'TrailRun'];

/** Cycling types — includes Zwift/indoor rides (VirtualRide). */
export const RIDE_TYPES: readonly string[] = [
  'Ride', 'VirtualRide', 'EBikeRide', 'EMountainBikeRide', 'MountainBikeRide',
  'GravelRide', 'TrackRide', 'Handcycle', 'Velomobile',
];

const SWIM_TYPES: readonly string[] = ['Swim', 'OpenWaterSwim'];
const WALK_TYPES: readonly string[] = ['Walk', 'Hike'];
const STRENGTH_TYPES: readonly string[] = [
  'WeightTraining', 'Crossfit', 'HighIntensityIntervalTraining', 'Workout',
];

function matches(a: SportTyped, list: readonly string[]): boolean {
  return (!!a.type && list.includes(a.type)) || (!!a.sport_type && list.includes(a.sport_type));
}

/** True for runs (road, trail, treadmill and virtual/Zwift runs). */
export function isRunActivity(a: SportTyped): boolean {
  return matches(a, RUN_TYPES);
}

/** True for any cycling activity, indoor or outdoor. */
export function isRideActivity(a: SportTyped): boolean {
  return matches(a, RIDE_TYPES);
}

/** Anything that is not a run counts as cross-training. */
export function isCrossTrainingActivity(a: SportTyped): boolean {
  return !isRunActivity(a);
}

/** Broad sport category used for grouping, icons and filters. */
export function getSportCategory(a: SportTyped): SportCategory {
  if (isRunActivity(a)) return 'run';
  if (isRideActivity(a)) return 'ride';
  if (matches(a, SWIM_TYPES)) return 'swim';
  if (matches(a, WALK_TYPES)) return 'walk';
  if (matches(a, STRENGTH_TYPES)) return 'strength';
  return 'other';
}

const CATEGORY_META: Record<SportCategory, { label: string; icon: string; color: string }> = {
  run: { label: 'Running', icon: '🏃', color: 'var(--apollo-gold, #E8C05A)' },
  ride: { label: 'Cycling', icon: '🚴', color: 'var(--apollo-teal, #2EC4B6)' },
  swim: { label: 'Swimming', icon: '🏊', color: '#4FC3F7' },
  walk: { label: 'Walking & Hiking', icon: '🥾', color: '#A5D6A7' },
  strength: { label: 'Strength', icon: '🏋️', color: '#CE93D8' },
  other: { label: 'Other', icon: '⚡', color: '#90A4AE' },
};

export const SPORT_CATEGORIES: readonly SportCategory[] = ['run', 'ride', 'swim', 'walk', 'strength', 'other'];

export function getSportCategoryLabel(category: SportCategory): string {
  return CATEGORY_META[category].label;
}

export function getSportCategoryIcon(category: SportCategory): string {
  return CATEGORY_META[category].icon;
}

export function getSportCategoryColor(category: SportCategory): string {
  return CATEGORY_META[category].color;
}

/** Icon for a specific activity. */
export function getSportIcon(a: SportTyped): string {
  return CATEGORY_META[getSportCategory(a)].icon;
}

/** Human label for a raw type, e.g. "VirtualRide" → "Virtual Ride". */
export function formatSportType(type: string | null | undefined): string {
  if (!type) return 'Activity';
  if (type === 'HighIntensityIntervalTraining') return 'HIIT';
  if (type === 'WeightTraining') return 'Strength Training';
  return type.replace(/^E(?=[A-Z])/, 'E-').replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Human label for an activity, preferring the more specific sport_type. */
export function getSportLabel(a: SportTyped): string {
  return formatSportType(a.sport_type || a.type);
}
