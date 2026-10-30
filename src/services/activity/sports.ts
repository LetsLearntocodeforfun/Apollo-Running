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
  'Ride',
  'VirtualRide',
  'EBikeRide',
  'EMountainBikeRide',
  'MountainBikeRide',
  'GravelRide',
  'TrackRide',
  'Handcycle',
  'Velomobile',
];

const SWIM_TYPES: readonly string[] = ['Swim', 'OpenWaterSwim'];
const WALK_TYPES: readonly string[] = ['Walk', 'Hike'];
const STRENGTH_TYPES: readonly string[] = ['WeightTraining', 'Crossfit', 'HighIntensityIntervalTraining', 'Workout'];

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

// ── Normalizing sport names ──────────────────────────────────────────────────
// Moved from fileImport/build.ts in v1.0.8 so file imports and live sources
// (Garmin Connect activity type keys like "trail_running") share one vocabulary.

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
  run: 'Run',
  running: 'Run',
  roadrunning: 'Run',
  streetrunning: 'Run',
  trackrunning: 'Run',
  ultrarun: 'Run',
  ultrarunning: 'Run',
  obstaclerun: 'Run',
  jogging: 'Run',
  trailrun: 'TrailRun',
  trailrunning: 'TrailRun',
  virtualrun: 'VirtualRun',
  virtualrunning: 'VirtualRun',
  treadmill: 'Run',
  treadmillrun: 'Run',
  treadmillrunning: 'Run',
  indoorrun: 'Run',
  indoorrunning: 'Run',
  ride: 'Ride',
  cycling: 'Ride',
  biking: 'Ride',
  bike: 'Ride',
  roadbiking: 'Ride',
  roadcycling: 'Ride',
  roadride: 'Ride',
  cyclocross: 'Ride',
  bmx: 'Ride',
  recumbentcycling: 'Ride',
  commuting: 'Ride',
  indoorcycling: 'Ride',
  indoorbiking: 'Ride',
  indoorride: 'Ride',
  spinning: 'Ride',
  virtualride: 'VirtualRide',
  virtualcycling: 'VirtualRide',
  virtualbiking: 'VirtualRide',
  mountainbikeride: 'MountainBikeRide',
  mountainbiking: 'MountainBikeRide',
  mountainbike: 'MountainBikeRide',
  mtb: 'MountainBikeRide',
  downhillbiking: 'MountainBikeRide',
  enduromtb: 'MountainBikeRide',
  gravelride: 'GravelRide',
  gravelcycling: 'GravelRide',
  gravelbiking: 'GravelRide',
  gravel: 'GravelRide',
  ebikeride: 'EBikeRide',
  ebike: 'EBikeRide',
  ebiking: 'EBikeRide',
  ebikefitness: 'EBikeRide',
  emountainbikeride: 'EMountainBikeRide',
  emountainbiking: 'EMountainBikeRide',
  ebikemountain: 'EMountainBikeRide',
  trackride: 'TrackRide',
  trackcycling: 'TrackRide',
  handcycle: 'Handcycle',
  handcycling: 'Handcycle',
  velomobile: 'Velomobile',
  swim: 'Swim',
  swimming: 'Swim',
  lapswimming: 'Swim',
  poolswim: 'Swim',
  poolswimming: 'Swim',
  openwaterswim: 'OpenWaterSwim',
  openwaterswimming: 'OpenWaterSwim',
  walk: 'Walk',
  walking: 'Walk',
  casualwalking: 'Walk',
  speedwalking: 'Walk',
  fitnesswalking: 'Walk',
  indoorwalking: 'Walk',
  hike: 'Hike',
  hiking: 'Hike',
  mountaineering: 'Hike',
  weighttraining: 'WeightTraining',
  strengthtraining: 'WeightTraining',
  strength: 'WeightTraining',
  weights: 'WeightTraining',
  workout: 'Workout',
  other: 'Workout',
  generic: 'Workout',
  training: 'Workout',
  cardio: 'Workout',
  indoorcardio: 'Workout',
  cardiotraining: 'Workout',
  fitnessequipment: 'Workout',
  multisport: 'Workout',
  transition: 'Workout',
  breathwork: 'Workout',
  hiit: 'HighIntensityIntervalTraining',
  highintensityintervaltraining: 'HighIntensityIntervalTraining',
  crossfit: 'Crossfit',
  yoga: 'Yoga',
  pilates: 'Pilates',
  rowing: 'Rowing',
  rower: 'Rowing',
  indoorrowing: 'Rowing',
  virtualrow: 'VirtualRow',
  elliptical: 'Elliptical',
  stairstepper: 'StairStepper',
  stairclimbing: 'StairStepper',
  stairs: 'StairStepper',
  alpineski: 'AlpineSki',
  resortskiing: 'AlpineSki',
  resortskiingsnowboarding: 'AlpineSki',
  // Garmin Connect's winter-sport keys end in "_ws" (e.g. resort_skiing_snowboarding_ws).
  resortskiingsnowboardingws: 'AlpineSki',
  downhillskiing: 'AlpineSki',
  skiing: 'AlpineSki',
  backcountryski: 'BackcountrySki',
  backcountryskiing: 'BackcountrySki',
  backcountryskiingsnowboarding: 'BackcountrySki',
  backcountryskiingsnowboardingws: 'BackcountrySki',
  nordicski: 'NordicSki',
  crosscountryskiing: 'NordicSki',
  crosscountryskiingws: 'NordicSki',
  crosscountryclassicskiing: 'NordicSki',
  crosscountryskateskiing: 'NordicSki',
  skateskiing: 'NordicSki',
  skateskiingws: 'NordicSki',
  rollerski: 'RollerSki',
  rollerskiing: 'RollerSki',
  snowboard: 'Snowboard',
  snowboarding: 'Snowboard',
  snowshoe: 'Snowshoe',
  snowshoeing: 'Snowshoe',
  snowshoews: 'Snowshoe',
  iceskate: 'IceSkate',
  iceskating: 'IceSkate',
  inlineskate: 'InlineSkate',
  inlineskating: 'InlineSkate',
  kayaking: 'Kayaking',
  kayak: 'Kayaking',
  whitewaterkayaking: 'Kayaking',
  canoeing: 'Canoeing',
  canoe: 'Canoeing',
  standuppaddling: 'StandUpPaddling',
  standuppaddleboarding: 'StandUpPaddling',
  sup: 'StandUpPaddling',
  surfing: 'Surfing',
  kitesurf: 'Kitesurf',
  kitesurfing: 'Kitesurf',
  kiteboarding: 'Kitesurf',
  windsurf: 'Windsurf',
  windsurfing: 'Windsurf',
  sail: 'Sail',
  sailing: 'Sail',
  rockclimbing: 'RockClimbing',
  climbing: 'RockClimbing',
  bouldering: 'RockClimbing',
  indoorclimbing: 'RockClimbing',
  golf: 'Golf',
  soccer: 'Soccer',
  football: 'Soccer',
  tennis: 'Tennis',
  squash: 'Squash',
  badminton: 'Badminton',
  pickleball: 'Pickleball',
  tabletennis: 'TableTennis',
  racquetball: 'Racquetball',
  wheelchair: 'Wheelchair',
  skateboard: 'Skateboard',
  skateboarding: 'Skateboard',
};

/** Aliases that imply an indoor / trainer session. */
const INDOOR_ALIASES = new Set([
  'treadmill',
  'treadmillrun',
  'treadmillrunning',
  'indoorrun',
  'indoorrunning',
  'indoorcycling',
  'indoorbiking',
  'indoorride',
  'spinning',
  'virtualride',
  'virtualcycling',
  'virtualbiking',
  'virtualrun',
  'virtualrunning',
  'indoorrowing',
  'virtualrow',
  'indoorwalking',
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
    .map((w) =>
      w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join('');
  return { type };
}
