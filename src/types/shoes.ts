/**
 * Shoe Tracking types — manage a shoe rotation with mileage limits,
 * degradation tracking, and race-day retirement alerts.
 *
 * All shoe distances are stored in MILES (like plan data); the UI converts
 * to the athlete's unit with services/unitPreferences.
 */

/** Shoe usage category */
export type ShoeCategory = 'training' | 'racing' | 'both';

/** Shoe status */
export type ShoeStatus = 'active' | 'retired';

/** A single shoe in the rotation */
export interface Shoe {
  /** Unique identifier */
  id: string;
  /** Shoe name (user-chosen, e.g. "Daily Trainer #2") */
  name: string;
  /** Brand (e.g. "Nike", "Hoka", "Brooks") */
  brand: string;
  /** Model (e.g. "Vaporfly 3", "Clifton 9") */
  model: string;
  /** Usage category */
  category: ShoeCategory;
  /** Status */
  status: ShoeStatus;
  /** Purchase date (YYYY-MM-DD) */
  purchaseDate: string;
  /** Maximum mileage before retirement, in miles (default 500 for training, 300 for racing) */
  maxMileage: number;
  /** v1.0.6: distance already on the shoe before Apollo started counting runs (miles). */
  initialMileage: number;
  /**
   * v1.0.6: first local date (YYYY-MM-DD) whose runs count toward this shoe
   * automatically while it is the default shoe. Defaults to the day the shoe
   * was added, so adding a shoe never back-fills old runs silently.
   */
  startDate: string;
  /**
   * Current accumulated mileage (miles) = initialMileage + counted runs.
   * v1.0.6: computed whenever shoes are read; the stored value is not used.
   */
  currentMileage: number;
  /** Is this the default shoe for new activities? */
  isDefault: boolean;
  /** Optional notes */
  notes?: string;
  /** When this shoe was added */
  createdAt: string;
  /** When this shoe was last updated */
  updatedAt: string;
  /** When this shoe was retired (if applicable) */
  retiredAt?: string;
}

/**
 * v1.0.6: the athlete's explicit shoe choice for one run. `shoeId: null`
 * means "no shoe" and overrides the default shoe. Runs without an
 * assignment use the default shoe at read time (nothing is written).
 */
export interface ShoeAssignment {
  /** Canonical activity id from the activity store: `String(activity.id)`. */
  activityKey: string;
  /** Chosen shoe, or null for "no shoe". */
  shoeId: string | null;
  /** Distance (m) when assigned — used only if the activity is no longer stored. */
  distanceM: number;
  /** Local activity date (YYYY-MM-DD) when assigned — same fallback. */
  date: string;
  /** When the choice was made (ISO). */
  assignedAt: string;
}

/**
 * v1.0.6: one span of the default-shoe history. From `from` (YYYY-MM-DD)
 * until the next period starts, runs without an explicit choice count toward
 * `shoeId` (null = no default). Keeps past runs on the shoe that was the
 * default when they happened.
 */
export interface ShoeDefaultPeriod {
  shoeId: string | null;
  from: string;
}

/** A run counted toward a shoe */
export interface ShoeActivity {
  /** Canonical activity id (`String(activity.id)`) */
  activityKey: string;
  /** Shoe ID */
  shoeId: string;
  /** Distance in miles */
  distanceMi: number;
  /** Activity date (YYYY-MM-DD) */
  date: string;
  /** v1.0.6: chosen explicitly, or counted because the shoe was the default. */
  source?: 'explicit' | 'default';
}

/** Shoe degradation status for display */
export interface ShoeDegradation {
  /** Shoe ID */
  shoeId: string;
  /** Percentage of max mileage used (0-100+) */
  usagePct: number;
  /** Remaining miles */
  remainingMiles: number;
  /** Estimated miles per week (from recent activity) */
  milesPerWeek: number;
  /** Estimated weeks until retirement */
  weeksUntilRetirement: number | null;
  /** Will this shoe exceed its limit before race day? */
  exceedsBeforeRace: boolean;
  /** Status message (in the athlete's distance unit) */
  statusMessage: string;
  /** Urgency level */
  urgency: 'ok' | 'warning' | 'critical' | 'retired';
  /** v1.0.6: current mileage (miles). */
  currentMiles: number;
  /** v1.0.6: retirement mileage (miles). */
  maxMiles: number;
  /** v1.0.6: local date the shoe reaches its limit at the recent pace (null when unknown). */
  projectedLimitDate: string | null;
}

/** v1.0.6: a shoe that will pass its limit on or before race day. */
export interface RaceDayShoeAlert {
  shoeId: string;
  shoeName: string;
  category: ShoeCategory;
  /** Race date (YYYY-MM-DD). */
  raceDate: string;
  /** Current mileage (miles). */
  currentMiles: number;
  /** Projected mileage on race day at the recent weekly pace (miles). */
  projectedMilesAtRace: number;
  /** Retirement mileage (miles). */
  maxMiles: number;
  /** Projected date the limit is reached (null when already over it). */
  limitDate: string | null;
  /** True when the shoe is already at or over its limit. */
  alreadyOver: boolean;
  /** Message in the athlete's distance unit. */
  message: string;
}

/** Default mileage limits by category */
export const DEFAULT_MAX_MILEAGE: Record<ShoeCategory, number> = {
  training: 500,
  racing: 300,
  both: 400,
};

/** All shoe categories, in display order. */
export const SHOE_CATEGORIES: readonly ShoeCategory[] = ['training', 'racing', 'both'];

/** Display labels for categories. */
export const SHOE_CATEGORY_LABELS: Record<ShoeCategory, string> = {
  training: 'Training',
  racing: 'Racing',
  both: 'Training & racing',
};

/** Well-known shoe brands for quick selection */
export const SHOE_BRANDS = [
  'Adidas', 'ASICS', 'Brooks', 'Hoka', 'New Balance',
  'Nike', 'On', 'Puma', 'Saucony', 'Under Armour',
  'Other',
] as const;
