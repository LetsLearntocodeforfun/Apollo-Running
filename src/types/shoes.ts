/**
 * Shoe Tracking types — manage a shoe rotation with mileage limits,
 * degradation tracking, and race-day retirement alerts.
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
  /** Maximum mileage before retirement (default 500 for training, 300 for racing) */
  maxMileage: number;
  /** Current accumulated mileage (miles) */
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

/** Activity-to-shoe assignment */
export interface ShoeActivity {
  /** Strava activity ID or date key */
  activityKey: string;
  /** Shoe ID */
  shoeId: string;
  /** Distance in miles */
  distanceMi: number;
  /** Activity date (YYYY-MM-DD) */
  date: string;
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
  /** Status message */
  statusMessage: string;
  /** Urgency level */
  urgency: 'ok' | 'warning' | 'critical' | 'retired';
}

/** Default mileage limits by category */
export const DEFAULT_MAX_MILEAGE: Record<ShoeCategory, number> = {
  training: 500,
  racing: 300,
  both: 400,
};

/** Well-known shoe brands for quick selection */
export const SHOE_BRANDS = [
  'Adidas', 'ASICS', 'Brooks', 'Hoka', 'New Balance',
  'Nike', 'On', 'Puma', 'Saucony', 'Under Armour',
  'Other',
] as const;
