/**
 * Shoe Tracker — manage shoe rotation, mileage accumulation,
 * role tags, degradation curves, and race-day retirement alerts.
 *
 * Architecture & Data Integrity:
 *  - Mileage is COMPUTED dynamically on read: `initialMiles` + eligible runs
 *    counted toward each shoe. Nothing drifts when runs are edited, hidden, or deleted.
 *  - Only visible running activities (`isRunActivity(a) && !a.hidden`) accrue
 *    mileage. Cycling, swimming, strength, and hidden runs never count.
 *  - Two visible copies of one run from different sources (same local day,
 *    starts within ±5 min, distances within ±3%) count once toward shoe
 *    mileage. The activity store's own dedupe is unchanged.
 *  - Stored shoes are validated on read with the same limits as new input, so
 *    corrupt distances fall back to defaults instead of reaching the UI as NaN.
 *  - Local calendar dates (`YYYY-MM-DD`) always come from `todayKey()` and
 *    `(a.start_date_local || a.start_date || '').slice(0, 10)` — never
 *    `new Date().toISOString().slice(0, 10)`.
 *  - Internal canonical storage uses miles (`initialMiles` / `maxMiles` / `totalMiles`),
 *    while every user-facing message and helper respects `getDistanceUnit()` (`mi` or `km`).
 *  - Persisted under `apollo_shoes`, `apollo_shoe_assignments`, and
 *    `apollo_shoe_default_periods` so automatic backups and JSON exports include gear.
 */

import type {
  Shoe as BaseShoe,
  ShoeActivity,
  ShoeAssignment,
  ShoeCategory,
  ShoeDefaultPeriod,
  ShoeDegradation,
  ShoeStatus,
  RaceDayShoeAlert,
} from '../types/shoes';
import { DEFAULT_MAX_MILEAGE, SHOE_BRANDS, SHOE_CATEGORIES, SHOE_CATEGORY_LABELS } from '../types/shoes';
import { persistence } from './db/persistence';
import { getAllStoredActivities } from './analyticsService';
import { onActivityStoreChanged } from './activity/manage';
import { isRunActivity } from './activity/sports';
import type { Activity } from './activity/types';
import { getDistanceUnit, metersToMiles, unitLabel, type DistanceUnit } from './unitPreferences';
import { getRaceDate } from './journey';
import {
  addDays,
  dateKeyFromLocalIso,
  daysBetween,
  isDateKey,
  parseDateKey,
  toDateKey,
  todayKey,
} from '../utils/localDate';

export type {
  ShoeActivity,
  ShoeAssignment,
  ShoeCategory,
  ShoeDefaultPeriod,
  ShoeDegradation,
  ShoeStatus,
  RaceDayShoeAlert,
};
export { DEFAULT_MAX_MILEAGE, SHOE_BRANDS, SHOE_CATEGORIES, SHOE_CATEGORY_LABELS };

export const SHOES_STORAGE_KEY = 'apollo_shoes';
export const SHOE_ASSIGNMENTS_KEY = 'apollo_shoe_assignments';
export const SHOE_DEFAULT_PERIODS_KEY = 'apollo_shoe_default_periods';
/** ≤1.0.5 accumulated assignments; dropped once normalized shoes are saved. */
const LEGACY_ACTIVITIES_KEY = 'apollo_shoe_activities';

/** Fired on `window` after any shoe or assignment change. */
export const SHOES_CHANGED_EVENT = 'apollo:shoes-changed';

export const MILES_TO_KM = 1.609344;
const METERS_PER_MILE = 1609.344;

/** Default lifespan presets in each display unit (400 mi / 650 km). */
const DEFAULT_MAX_MI = 400;
const DEFAULT_MAX_KM = 650;

/** Upper bounds that catch typos (miles). */
const MAX_LIMIT_MILES = 5000;
const MAX_INITIAL_MILES = 10000;
const MAX_NAME_LENGTH = 80;
const MAX_NOTES_LENGTH = 1000;
/** Recent window used for the weekly pace (days, including today). */
const RECENT_DAYS = 28;
/** Two copies of one run (different sources, same local day) start within ±5 min of each other… */
const DUPLICATE_RUN_START_SEC = 5 * 60;
/** …and differ in distance by at most ±3%. */
const DUPLICATE_RUN_DISTANCE_RATIO = 0.03;

/** A retirement distance (mi) Apollo accepts: finite, above 0 at 0.01 mi precision, at most 5,000 mi. */
function isValidMaxMiles(v: unknown): v is number {
  return isFiniteNumber(v) && round2(v) > 0 && v <= MAX_LIMIT_MILES;
}

/** A starting distance (mi) Apollo accepts: finite, from 0 to 10,000 mi. */
function isValidInitialMiles(v: unknown): v is number {
  return isFiniteNumber(v) && v >= 0 && v <= MAX_INITIAL_MILES;
}

// ── Role Tags & Extended Types ────────────────────────────────────────────────

/** Specific rotation role for a running shoe. */
export type ShoeRole = 'daily' | 'tempo' | 'long-run' | 'race' | 'trail' | 'recovery';

export const SHOE_ROLES: readonly ShoeRole[] = ['daily', 'long-run', 'tempo', 'race', 'recovery', 'trail'];

export const SHOE_ROLE_LABELS: Record<ShoeRole, string> = {
  daily: 'Daily Trainer',
  'long-run': 'Long Run',
  tempo: 'Tempo / Speed',
  race: 'Race / Carbon',
  recovery: 'Recovery',
  trail: 'Trail',
};

/** Running shoe record with canonical mileage aliases, optional role, and auto-assign control. */
export interface Shoe extends BaseShoe {
  /** Optional rotation role tag (e.g. Daily Trainer, Race / Carbon, Trail). */
  role?: ShoeRole;
  /** Optional custom nickname (e.g. "Blue Pegs"). */
  nickname?: string;
  /** Canonical prior miles before Apollo started counting runs (mirrors `initialMileage`). */
  initialMiles: number;
  /** Canonical retirement limit in miles (mirrors `maxMileage`). */
  maxMiles: number;
  /** Canonical total miles = initialMiles + logged run miles (mirrors `currentMileage`). */
  totalMiles: number;
  /** Local date (YYYY-MM-DD) from which default runs accrue (mirrors `startDate`). */
  addedDate: string;
  /** When true (default), unassigned runs on/after `addedDate` accrue while this shoe is default. */
  autoAssignUnassignedRuns: boolean;
}

/** Rich per-shoe telemetry returned by {@link getShoesWithStats}. */
export interface ShoeWithStats extends Shoe {
  /** Miles accrued from counted runs (excludes `initialMiles`). */
  loggedMiles: number;
  /** Remaining miles until `maxMiles` (clamped at ≥ 0). */
  remainingMiles: number;
  /** Percentage of `maxMiles` used (rounded whole percent, 0–100+). */
  wearPct: number;
  /** Number of counted runs attributed to this shoe. */
  runCount: number;
  /** Most recent run local date (YYYY-MM-DD) counted toward this shoe, or null. */
  lastUsedDate: string | null;
  /** Counted run records (newest first). */
  activities: ShoeActivity[];
  /** Full wear & race-day projection summary (unit-aware `statusMessage`). */
  degradation: ShoeDegradation;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isCategory(v: unknown): v is ShoeCategory {
  return typeof v === 'string' && (SHOE_CATEGORIES as readonly string[]).includes(v);
}

export function isShoeRole(v: unknown): v is ShoeRole {
  return typeof v === 'string' && (SHOE_ROLES as readonly string[]).includes(v);
}

function categoryForRole(role: ShoeRole | undefined): ShoeCategory {
  if (role === 'race') return 'racing';
  if (role === 'tempo') return 'both';
  return 'training';
}

/** Local date key of an ISO timestamp (falls back to `fallback`). */
function localDateOfIso(iso: string | undefined, fallback: string): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : toDateKey(d);
}

/**
 * Extract the local calendar date (`YYYY-MM-DD`) of an activity without UTC drift.
 * Uses `(a.start_date_local || a.start_date || '').slice(0, 10)`.
 */
export function extractActivityLocalDate(a: Pick<Activity, 'start_date_local' | 'start_date'>): string {
  const candidate = (a.start_date_local || a.start_date || '').slice(0, 10);
  return isDateKey(candidate) ? candidate : '';
}

function emitChanged(): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHOES_CHANGED_EVENT));
  } catch {
    /* events are best-effort */
  }
}

/** Subscribe to shoe/assignment changes (any component or tab of the app). Returns an unsubscribe function. */
export function onShoesChanged(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(SHOES_CHANGED_EVENT, cb);
  return () => window.removeEventListener(SHOES_CHANGED_EVENT, cb);
}

// ── Units ─────────────────────────────────────────────────────────────────────

/** Convert canonical miles to the runner's preferred distance unit (`mi` or `km`). */
export function shoeDistanceInUnit(miles: number, unit: DistanceUnit = getDistanceUnit()): number {
  if (!isFiniteNumber(miles)) return 0;
  return unit === 'km' ? miles * MILES_TO_KM : miles;
}

/** Backwards-compatible alias for {@link shoeDistanceInUnit}. */
export function milesToShoeUnit(miles: number, unit: DistanceUnit = getDistanceUnit()): number {
  return shoeDistanceInUnit(miles, unit);
}

/** Convert a distance value entered in the runner's unit (`mi` or `km`) into canonical miles. */
export function unitDistanceToMiles(value: number, unit: DistanceUnit = getDistanceUnit()): number {
  if (!isFiniteNumber(value)) return 0;
  return unit === 'km' ? value / MILES_TO_KM : value;
}

/** Backwards-compatible alias for {@link unitDistanceToMiles}. */
export function shoeUnitToMiles(value: number, unit: DistanceUnit = getDistanceUnit()): number {
  return unitDistanceToMiles(value, unit);
}

/** Default max lifespan in the runner's unit: `400` for `'mi'`, `650` for `'km'`. */
export function defaultMaxDistanceForUnit(unit: DistanceUnit = getDistanceUnit()): number {
  return unit === 'km' ? DEFAULT_MAX_KM : DEFAULT_MAX_MI;
}

/** Format canonical miles in the runner's preferred unit, e.g. `"312 km"` or `"194 mi"`. */
export function formatShoeDistance(miles: number, unit: DistanceUnit = getDistanceUnit(), decimals = 0): string {
  const u = unit ?? getDistanceUnit();
  const value = shoeDistanceInUnit(miles, u);
  return `${value.toFixed(decimals)} ${unitLabel(u)}`;
}

/** "Nov 8" for a local date key. */
function formatShortDate(dateKey: string): string {
  return isDateKey(dateKey)
    ? parseDateKey(dateKey).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : dateKey;
}

// ── Stores (read = normalise in memory, never write) ─────────────────────────

function readJson(key: string): unknown {
  try {
    const raw = persistence.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function syncShoeAliases(shoe: Shoe, totalMiles: number): Shoe {
  const roundedTotal = round2(totalMiles);
  const roundedInit = round2(shoe.initialMileage);
  const roundedMax = round2(shoe.maxMileage);
  return {
    ...shoe,
    initialMileage: roundedInit,
    initialMiles: roundedInit,
    maxMileage: roundedMax,
    maxMiles: roundedMax,
    currentMileage: roundedTotal,
    totalMiles: roundedTotal,
    startDate: shoe.startDate,
    addedDate: shoe.startDate,
  };
}

/**
 * Normalise a stored shoe (fills v1.0.6+ fields for legacy data, in memory only).
 * Stored distances must pass the same limits as new input; anything else (NaN,
 * Infinity, negative, absurdly large) falls back to a default, so the UI never
 * shows NaN or Infinity, and a missing or blank name gets a readable fallback.
 */
function normalizeShoe(raw: unknown, today: string): Shoe | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<Shoe> & Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) return null;

  const role: ShoeRole | undefined = isShoeRole(s.role) ? s.role : undefined;
  const category: ShoeCategory = isCategory(s.category) ? s.category : categoryForRole(role);
  const createdAt = typeof s.createdAt === 'string' ? s.createdAt : new Date(0).toISOString();
  const purchaseDate = isDateKey(s.purchaseDate) ? s.purchaseDate : '';

  // ≤1.0.5 stored an accumulated total and no starting distance: keep that total as the start.
  const legacyTotal = isFiniteNumber(s.currentMileage) && s.currentMileage > 0 ? s.currentMileage : 0;
  const rawInitial = isFiniteNumber(s.initialMileage)
    ? s.initialMileage
    : isFiniteNumber(s.initialMiles)
      ? s.initialMiles
      : legacyTotal;
  const initialMileage = isValidInitialMiles(rawInitial) ? round2(rawInitial) : 0;

  const rawStart = isDateKey(s.startDate)
    ? s.startDate
    : isDateKey(s.addedDate)
      ? s.addedDate
      : localDateOfIso(createdAt, purchaseDate || today);

  const maxMileage = round2(
    isValidMaxMiles(s.maxMileage)
      ? s.maxMileage
      : isValidMaxMiles(s.maxMiles)
        ? s.maxMiles
        : DEFAULT_MAX_MILEAGE[category],
  );

  const nickname = typeof s.nickname === 'string' && s.nickname.trim() ? s.nickname.trim() : undefined;
  const autoAssignUnassignedRuns = s.autoAssignUnassignedRuns !== false;
  const brand = typeof s.brand === 'string' ? s.brand : '';
  const model = typeof s.model === 'string' ? s.model : '';
  const name =
    typeof s.name === 'string' && s.name.trim() ? s.name : nickname || `${brand} ${model}`.trim() || 'Unnamed shoe';

  return {
    id: s.id,
    name,
    nickname,
    brand,
    model,
    category,
    role,
    status: s.status === 'retired' ? 'retired' : 'active',
    purchaseDate,
    maxMileage,
    maxMiles: maxMileage,
    initialMileage,
    initialMiles: initialMileage,
    startDate: rawStart,
    addedDate: rawStart,
    currentMileage: initialMileage,
    totalMiles: initialMileage,
    isDefault: s.isDefault === true && s.status !== 'retired',
    autoAssignUnassignedRuns,
    notes: typeof s.notes === 'string' && s.notes ? s.notes : undefined,
    createdAt,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : createdAt,
    retiredAt: s.status === 'retired' && typeof s.retiredAt === 'string' ? s.retiredAt : undefined,
  };
}

function readShoes(today: string = todayKey()): Shoe[] {
  const raw = readJson(SHOES_STORAGE_KEY);
  const list = Array.isArray(raw) ? raw.map((s) => normalizeShoe(s, today)).filter((s): s is Shoe => s !== null) : [];
  // At most one default (the first flagged active one wins).
  let seen = false;
  for (const s of list) {
    if (s.isDefault && !seen) seen = true;
    else s.isDefault = false;
  }
  return list;
}

function readAssignments(): ShoeAssignment[] {
  const raw = readJson(SHOE_ASSIGNMENTS_KEY);
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, ShoeAssignment>();
  for (const a of raw as Partial<ShoeAssignment>[]) {
    if (!a || typeof a.activityKey !== 'string' || !a.activityKey) continue;
    byKey.set(a.activityKey, {
      activityKey: a.activityKey,
      shoeId: typeof a.shoeId === 'string' && a.shoeId ? a.shoeId : null,
      distanceM: isFiniteNumber(a.distanceM) && a.distanceM > 0 ? a.distanceM : 0,
      date: isDateKey(a.date) ? a.date : '',
      assignedAt: typeof a.assignedAt === 'string' ? a.assignedAt : '',
    });
  }
  return [...byKey.values()];
}

function readPeriods(): ShoeDefaultPeriod[] {
  const raw = readJson(SHOE_DEFAULT_PERIODS_KEY);
  if (!Array.isArray(raw)) return [];
  return (raw as Partial<ShoeDefaultPeriod>[])
    .filter((p): p is ShoeDefaultPeriod => !!p && isDateKey(p.from))
    .map((p) => ({ shoeId: typeof p.shoeId === 'string' && p.shoeId ? p.shoeId : null, from: p.from }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** Stored history, or one synthesised for legacy data (a default shoe but no history). */
function effectivePeriods(shoes: Shoe[], stored: ShoeDefaultPeriod[]): ShoeDefaultPeriod[] {
  if (stored.length > 0) return stored;
  const def = shoes.find((s) => s.isDefault && s.status === 'active');
  return def ? [{ shoeId: def.id, from: def.startDate }] : [];
}

/** Persist shoes (stored without computed run total) and drop the ≤1.0.5 accumulation store. */
function saveShoes(shoes: Shoe[]): void {
  persistence.setItem(
    SHOES_STORAGE_KEY,
    JSON.stringify(
      shoes.map((s) => ({
        ...s,
        currentMileage: s.initialMileage,
        totalMiles: s.initialMileage,
        initialMiles: s.initialMileage,
        maxMiles: s.maxMileage,
        addedDate: s.startDate,
      })),
    ),
  );
  if (persistence.getItem(LEGACY_ACTIVITIES_KEY) !== null) {
    persistence.removeItem(LEGACY_ACTIVITIES_KEY);
  }
}

function saveAssignments(list: ShoeAssignment[]): void {
  persistence.setItem(SHOE_ASSIGNMENTS_KEY, JSON.stringify(list));
}

function savePeriods(periods: ShoeDefaultPeriod[]): void {
  persistence.setItem(SHOE_DEFAULT_PERIODS_KEY, JSON.stringify(periods));
}

/** Start a default period at `from` (periods starting on/after it are replaced). */
function withPeriod(periods: ShoeDefaultPeriod[], shoeId: string | null, from: string): ShoeDefaultPeriod[] {
  const kept = periods.filter((p) => p.from < from);
  const last = kept[kept.length - 1];
  if ((last ? last.shoeId : null) === shoeId) return kept;
  return [...kept, { shoeId, from }];
}

function laterOf(a: string, b: string): string {
  return a > b ? a : b;
}

// Keep assignments tidy and notify UI listeners when activities are hidden/unhidden/deleted.
onActivityStoreChanged((kind, ids) => {
  if (kind === 'delete' && ids.length > 0) {
    const deletedKeys = new Set(ids.map((id) => String(id)));
    const existing = readAssignments();
    const filtered = existing.filter((a) => !deletedKeys.has(a.activityKey));
    if (filtered.length !== existing.length) {
      saveAssignments(filtered);
    }
  }
  emitChanged();
});

// ── Runs (read-only view of activities) ───────────────────────────────────────

interface ActivityRef {
  key: string;
  date: string;
  distanceM: number;
  isRun: boolean;
  hidden: boolean;
  /** Start time in epoch seconds (`start_date`, else `start_date_local`); NaN when unknown. */
  startSec: number;
  /** Where the record came from; legacy records without a source were synced from Strava. */
  source: string;
}

function toActivityRefs(list: readonly Activity[]): ActivityRef[] {
  const refs: ActivityRef[] = [];
  for (const a of list) {
    if (!a || a.id === undefined || a.id === null) continue;
    const date = extractActivityLocalDate(a);
    if (!date) continue;
    const startMs = Date.parse(a.start_date);
    const localStartMs = Date.parse(a.start_date_local);
    refs.push({
      key: String(a.id),
      date,
      distanceM: isFiniteNumber(a.distance) ? Math.max(0, a.distance) : 0,
      isRun: isRunActivity(a),
      hidden: Boolean(a.hidden),
      startSec: Number.isFinite(startMs) ? startMs / 1000 : Number.isFinite(localStartMs) ? localStartMs / 1000 : NaN,
      source: a.source ?? 'strava',
    });
  }
  return refs;
}

function storedActivityRefs(): ActivityRef[] {
  try {
    return toActivityRefs(getAllStoredActivities());
  } catch {
    return [];
  }
}

// ── Attribution (pure) ────────────────────────────────────────────────────────

function retiredDate(shoe: Shoe): string | null {
  return shoe.status === 'retired' && shoe.retiredAt ? localDateOfIso(shoe.retiredAt, '') || null : null;
}

/** The shoe an unassigned run counts toward on `date`, or null. */
function defaultShoeIdOn(date: string, periods: ShoeDefaultPeriod[], byId: Map<string, Shoe>): string | null {
  let current: ShoeDefaultPeriod | null = null;
  for (const p of periods) {
    if (p.from <= date) current = p;
    else break;
  }
  if (!current?.shoeId) return null;
  const shoe = byId.get(current.shoeId);
  if (!shoe || !shoe.autoAssignUnassignedRuns || date < shoe.startDate) return null;
  const retired = retiredDate(shoe);
  if (retired && date > retired) return null;
  return shoe.id;
}

interface ShoeUsage {
  miles: number;
  recentMiles: number;
  activities: ShoeActivity[];
}

interface TrackerState {
  today: string;
  shoes: Shoe[];
  byId: Map<string, Shoe>;
  assignments: Map<string, ShoeAssignment>;
  periods: ShoeDefaultPeriod[];
  usage: Map<string, ShoeUsage>;
}

/** A run's distance attributed to a shoe, before duplicate copies are dropped. */
interface Attribution {
  shoeId: string;
  key: string;
  date: string;
  distanceM: number;
  source: 'explicit' | 'default';
  /** When the explicit choice was made (ISO; '' for default-shoe runs). */
  assignedAt: string;
  /** The stored activity, when there is one (needed to recognise duplicate copies). */
  run?: ActivityRef;
}

/** Two stored records from different sources that describe the same run. */
function isSameRunFromAnotherSource(a: ActivityRef, b: ActivityRef): boolean {
  if (a.source === b.source || a.date !== b.date) return false;
  if (!Number.isFinite(a.startSec) || !Number.isFinite(b.startSec)) return false;
  if (Math.abs(a.startSec - b.startSec) > DUPLICATE_RUN_START_SEC) return false;
  const longer = Math.max(a.distanceM, b.distanceM);
  return longer > 0 && Math.abs(a.distanceM - b.distanceM) <= DUPLICATE_RUN_DISTANCE_RATIO * longer;
}

/**
 * Attributions that are a second copy of a run already counted toward a shoe
 * (the same run synced from two sources and both left visible). Explicit
 * choices are kept over default-shoe attribution, the latest choice first.
 */
function duplicateCopies(attributions: readonly Attribution[]): Set<Attribution> {
  const byDay = new Map<string, Attribution[]>();
  for (const item of attributions) {
    if (!item.run || !Number.isFinite(item.run.startSec)) continue;
    const list = byDay.get(item.date);
    if (list) list.push(item);
    else byDay.set(item.date, [item]);
  }
  const dropped = new Set<Attribution>();
  for (const list of byDay.values()) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) =>
        (a.source === b.source ? 0 : a.source === 'explicit' ? -1 : 1) ||
        b.assignedAt.localeCompare(a.assignedAt) ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    // Runs kept so far, by 5-minute start slot and then by source. A copy starts within ±5 min
    // of the run it copies and comes from another source, so only the same and neighbouring
    // slots under other sources can hold it: each run meets a few candidates, not the whole day.
    const kept = new Map<number, Map<string, ActivityRef[]>>();
    for (const item of list) {
      const run = item.run as ActivityRef;
      const slot = Math.floor(run.startSec / DUPLICATE_RUN_START_SEC);
      let isCopy = false;
      for (let s = slot - 1; s <= slot + 1 && !isCopy; s++) {
        for (const [source, runs] of kept.get(s) ?? []) {
          if (source !== run.source && runs.some((k) => isSameRunFromAnotherSource(k, run))) {
            isCopy = true;
            break;
          }
        }
      }
      if (isCopy) {
        dropped.add(item);
        continue;
      }
      let bySource = kept.get(slot);
      if (!bySource) {
        bySource = new Map();
        kept.set(slot, bySource);
      }
      const runs = bySource.get(run.source);
      if (runs) runs.push(run);
      else bySource.set(run.source, [run]);
    }
  }
  return dropped;
}

/**
 * Attribute every eligible run (`isRun && !hidden`) to a shoe:
 *  1. Explicit choices first (using live distance/date when stored; hidden or
 *     non-run activities never count even if explicitly assigned).
 *  2. Remaining eligible runs accrue to the default shoe active on their local
 *     date (when `autoAssignUnassignedRuns` is enabled and `date >= addedDate`).
 *  3. Two visible copies of one run from different sources (same local day,
 *     starts within ±5 min, distances within ±3%) count once. This only
 *     affects shoe mileage; the activity store's own dedupe is unchanged.
 */
function computeUsage(
  shoes: Shoe[],
  assignments: ShoeAssignment[],
  periods: ShoeDefaultPeriod[],
  activities: ActivityRef[],
  today: string,
  allowStandaloneAssignments: boolean,
): Map<string, ShoeUsage> {
  const byId = new Map(shoes.map((s) => [s.id, s]));
  const usage = new Map<string, ShoeUsage>(shoes.map((s) => [s.id, { miles: 0, recentMiles: 0, activities: [] }]));
  const recentFrom = addDays(today, -(RECENT_DAYS - 1));
  const stored = new Map(activities.map((a) => [a.key, a]));
  const explicit = new Set<string>();
  const attributions: Attribution[] = [];

  const attribute = (item: Attribution) => {
    if (usage.has(item.shoeId) && item.distanceM > 0) attributions.push(item);
  };

  for (const a of assignments) {
    explicit.add(a.activityKey);
    if (!a.shoeId) continue;
    const live = stored.get(a.activityKey);
    if (live) {
      if (live.hidden || !live.isRun) continue;
      attribute({
        shoeId: a.shoeId,
        key: a.activityKey,
        date: live.date,
        distanceM: live.distanceM,
        source: 'explicit',
        assignedAt: a.assignedAt,
        run: live,
      });
    } else if (allowStandaloneAssignments) {
      attribute({
        shoeId: a.shoeId,
        key: a.activityKey,
        date: a.date,
        distanceM: a.distanceM,
        source: 'explicit',
        assignedAt: a.assignedAt,
      });
    }
  }

  for (const run of activities) {
    if (run.hidden || !run.isRun || explicit.has(run.key)) continue;
    const shoeId = defaultShoeIdOn(run.date, periods, byId);
    if (shoeId) {
      attribute({
        shoeId,
        key: run.key,
        date: run.date,
        distanceM: run.distanceM,
        source: 'default',
        assignedAt: '',
        run,
      });
    }
  }

  const duplicates = duplicateCopies(attributions);
  for (const item of attributions) {
    if (duplicates.has(item)) continue;
    const acc = usage.get(item.shoeId) as ShoeUsage;
    const miles = metersToMiles(item.distanceM);
    acc.miles += miles;
    if (item.date && item.date >= recentFrom) acc.recentMiles += miles;
    acc.activities.push({
      activityKey: item.key,
      shoeId: item.shoeId,
      distanceMi: round2(miles),
      date: item.date,
      source: item.source,
    });
  }

  for (const acc of usage.values()) {
    acc.activities.sort((a, b) => b.date.localeCompare(a.date));
  }
  return usage;
}

function loadState(today: string = todayKey(), customActivities?: Activity[]): TrackerState {
  const shoes = readShoes(today);
  const assignmentList = readAssignments();
  const periods = effectivePeriods(shoes, readPeriods());
  const refs = customActivities !== undefined ? toActivityRefs(customActivities) : storedActivityRefs();
  const usage = computeUsage(shoes, assignmentList, periods, refs, today, customActivities === undefined);
  const hydratedShoes = shoes.map((s) => syncShoeAliases(s, s.initialMileage + (usage.get(s.id)?.miles ?? 0)));
  return {
    today,
    shoes: hydratedShoes,
    byId: new Map(hydratedShoes.map((s) => [s.id, s])),
    assignments: new Map(assignmentList.map((a) => [a.activityKey, a])),
    periods,
    usage,
  };
}

function cloneShoe(s: Shoe): Shoe {
  return { ...s };
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Editable shoe fields (distances in canonical miles). */
export interface ShoeInput {
  name?: string;
  nickname?: string;
  brand: string;
  model: string;
  category?: ShoeCategory;
  role?: ShoeRole;
  /** YYYY-MM-DD, optional. */
  purchaseDate?: string;
  /** Retirement distance in miles. Defaults to category limit (or 400 mi when category omitted). */
  maxMileage?: number;
  /** Alias for `maxMileage` (canonical miles). */
  maxMiles?: number;
  /** Distance already on the shoe in miles. Default 0. */
  initialMileage?: number;
  /** Alias for `initialMileage` (canonical miles). */
  initialMiles?: number;
  /** Count default runs from this local date (YYYY-MM-DD). Default: `todayKey()`. */
  startDate?: string;
  /** Alias for `startDate` (YYYY-MM-DD). */
  addedDate?: string;
  isDefault?: boolean;
  /** Whether unassigned runs on/after `addedDate` accrue automatically while default (default true). */
  autoAssignUnassignedRuns?: boolean;
  notes?: string;
}

export type ShoeField =
  | 'name'
  | 'brand'
  | 'model'
  | 'category'
  | 'role'
  | 'purchaseDate'
  | 'startDate'
  | 'maxMileage'
  | 'initialMileage'
  | 'notes';

export type ShoeFieldErrors = Partial<Record<ShoeField, string>>;

/** Thrown by addShoe/updateShoe when the input is invalid. */
export class ShoeValidationError extends Error {
  readonly fieldErrors: ShoeFieldErrors;
  constructor(fieldErrors: ShoeFieldErrors) {
    super(Object.values(fieldErrors)[0] ?? 'Invalid shoe details.');
    this.name = 'ShoeValidationError';
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Field errors for a shoe draft (empty object = valid). With `partial`,
 * only the fields present are checked (updates).
 */
export function validateShoeInput(input: Partial<ShoeInput>, options: { partial?: boolean } = {}): ShoeFieldErrors {
  const errors: ShoeFieldErrors = {};
  const partial = options.partial === true;
  const has = (k: keyof ShoeInput) => !partial || Object.prototype.hasOwnProperty.call(input, k);

  if (has('name') || has('nickname') || has('brand') || has('model')) {
    const label =
      (input.name ?? '').trim() || (input.nickname ?? '').trim() || `${input.brand ?? ''} ${input.model ?? ''}`.trim();
    if (!partial && !label) errors.name = 'Give the shoe a name, or a brand and model.';
    if (
      partial &&
      Object.prototype.hasOwnProperty.call(input, 'name') &&
      input.name !== undefined &&
      !input.name.trim()
    ) {
      errors.name = 'The name can’t be empty.';
    }
    if ((input.name ?? '').trim().length > MAX_NAME_LENGTH) {
      errors.name = `Keep the name under ${MAX_NAME_LENGTH} characters.`;
    }
    if ((input.nickname ?? '').trim().length > MAX_NAME_LENGTH) {
      errors.name = `Keep the nickname under ${MAX_NAME_LENGTH} characters.`;
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(input, 'category') &&
    input.category !== undefined &&
    !isCategory(input.category)
  ) {
    errors.category = 'Choose training, racing or both.';
  }
  if (Object.prototype.hasOwnProperty.call(input, 'role') && input.role !== undefined && !isShoeRole(input.role)) {
    errors.role = 'Choose a valid shoe role.';
  }

  const maxCandidate = input.maxMileage ?? input.maxMiles;
  if ((has('maxMileage') || has('maxMiles')) && maxCandidate !== undefined) {
    if (!isFiniteNumber(maxCandidate) || round2(maxCandidate) <= 0) {
      errors.maxMileage = 'Enter a retirement distance greater than 0.';
    } else if (!isValidMaxMiles(maxCandidate)) {
      errors.maxMileage = 'That retirement distance looks too large.';
    }
  }

  const initCandidate = input.initialMileage ?? input.initialMiles;
  if ((has('initialMileage') || has('initialMiles')) && initCandidate !== undefined) {
    if (!isFiniteNumber(initCandidate) || initCandidate < 0) {
      errors.initialMileage = 'The starting distance can’t be negative.';
    } else if (!isValidInitialMiles(initCandidate)) {
      errors.initialMileage = 'That starting distance looks too large.';
    }
  }

  if (has('purchaseDate') && input.purchaseDate && !isDateKey(input.purchaseDate)) {
    errors.purchaseDate = 'Enter a valid date.';
  }

  const startCandidate = input.startDate ?? input.addedDate;
  if (
    (Object.prototype.hasOwnProperty.call(input, 'startDate') ||
      Object.prototype.hasOwnProperty.call(input, 'addedDate')) &&
    startCandidate !== undefined &&
    !isDateKey(startCandidate)
  ) {
    errors.startDate = 'Enter a valid date.';
  }

  if (has('notes') && (input.notes ?? '').length > MAX_NOTES_LENGTH) {
    errors.notes = `Keep notes under ${MAX_NOTES_LENGTH} characters.`;
  }
  return errors;
}

function assertValid(input: Partial<ShoeInput>, partial: boolean): void {
  const errors = validateShoeInput(input, { partial });
  if (Object.keys(errors).length > 0) throw new ShoeValidationError(errors);
}

// ── Shoe CRUD ─────────────────────────────────────────────────────────────────

function generateId(): string {
  return `shoe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Add a new shoe. Throws ShoeValidationError for invalid input.
 * The first active shoe becomes the default automatically unless `isDefault: false` is explicit?
 * Note: preserves ≤1.0.6 behavior where the first active shoe auto-becomes default when `isDefault` is not explicitly `false`,
 * and also when `isDefault` is omitted.
 */
export function addShoe(shoe: ShoeInput): Shoe {
  assertValid(shoe, false);
  const today = todayKey();
  const shoes = readShoes(today);
  const periodsBefore = effectivePeriods(shoes, readPeriods());
  const now = new Date().toISOString();

  const brand = shoe.brand.trim();
  const model = shoe.model.trim();
  const nickname = shoe.nickname?.trim() || undefined;
  const fullModelName = `${brand} ${model}`.trim();
  const name = (shoe.name ?? '').trim() || nickname || fullModelName;

  const role = shoe.role;
  const category: ShoeCategory = shoe.category ?? categoryForRole(role);
  const defaultLimit = shoe.category ? DEFAULT_MAX_MILEAGE[shoe.category] : DEFAULT_MAX_MI;
  const maxMileage = round2(shoe.maxMileage ?? shoe.maxMiles ?? defaultLimit);
  const initialMileage = round2(shoe.initialMileage ?? shoe.initialMiles ?? 0);
  const startDate = shoe.startDate ?? shoe.addedDate ?? today;
  const autoAssignUnassignedRuns = shoe.autoAssignUnassignedRuns ?? true;

  const newShoe: Shoe = {
    id: generateId(),
    name,
    nickname,
    brand,
    model,
    category,
    role,
    status: 'active',
    purchaseDate: shoe.purchaseDate ?? '',
    maxMileage,
    maxMiles: maxMileage,
    initialMileage,
    initialMiles: initialMileage,
    startDate,
    addedDate: startDate,
    currentMileage: initialMileage,
    totalMiles: initialMileage,
    isDefault: shoe.isDefault ?? false,
    autoAssignUnassignedRuns,
    notes: shoe.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  // Auto-set as default if it's the only active shoe (unless caller explicitly passed isDefault: false)
  if (shoe.isDefault !== false && !shoes.some((s) => s.status === 'active')) {
    newShoe.isDefault = true;
  }

  let periods = periodsBefore;
  if (newShoe.isDefault) {
    for (const s of shoes) s.isDefault = false;
    const last = periods[periods.length - 1];
    const from = !last || newShoe.startDate >= last.from ? newShoe.startDate : laterOf(newShoe.startDate, today);
    periods = withPeriod(periods, newShoe.id, from);
  }

  shoes.push(newShoe);
  saveShoes(shoes);
  if (periods !== periodsBefore || readPeriods().length === 0) savePeriods(periods);
  emitChanged();
  return getShoeById(newShoe.id) ?? newShoe;
}

/** Fields `updateShoe` can change. */
export type ShoeUpdate = Partial<
  Pick<
    Shoe,
    | 'name'
    | 'nickname'
    | 'brand'
    | 'model'
    | 'category'
    | 'role'
    | 'purchaseDate'
    | 'maxMileage'
    | 'maxMiles'
    | 'initialMileage'
    | 'initialMiles'
    | 'startDate'
    | 'addedDate'
    | 'isDefault'
    | 'autoAssignUnassignedRuns'
    | 'notes'
  >
>;

/**
 * Update an existing shoe's editable fields. Throws ShoeValidationError for
 * invalid values (including making a retired shoe the default). Returns null
 * when the shoe doesn't exist.
 */
export function updateShoe(id: string, updates: ShoeUpdate): Shoe | null {
  const today = todayKey();
  const shoes = readShoes(today);
  const idx = shoes.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  assertValid(updates as Partial<ShoeInput>, true);
  const shoe = shoes[idx];
  if (updates.isDefault === true && shoe.status === 'retired') {
    throw new ShoeValidationError({ name: 'Reactivate this shoe before making it your default.' });
  }

  let periods = effectivePeriods(shoes, readPeriods());
  const { isDefault, maxMiles, initialMiles, addedDate, ...fields } = updates;
  const resolvedMax = fields.maxMileage ?? maxMiles;
  const resolvedInitial = fields.initialMileage ?? initialMiles;
  const resolvedStart = fields.startDate ?? addedDate;

  const nextMax = resolvedMax !== undefined ? round2(resolvedMax) : shoe.maxMileage;
  const nextInit = resolvedInitial !== undefined ? round2(resolvedInitial) : shoe.initialMileage;
  const nextStart = resolvedStart !== undefined ? resolvedStart : shoe.startDate;

  const next: Shoe = {
    ...shoe,
    ...fields,
    brand: fields.brand !== undefined ? fields.brand.trim() : shoe.brand,
    model: fields.model !== undefined ? fields.model.trim() : shoe.model,
    name: fields.name !== undefined ? fields.name.trim() : shoe.name,
    nickname: fields.nickname !== undefined ? fields.nickname.trim() || undefined : shoe.nickname,
    notes: fields.notes !== undefined ? fields.notes.trim() || undefined : shoe.notes,
    maxMileage: nextMax,
    maxMiles: nextMax,
    initialMileage: nextInit,
    initialMiles: nextInit,
    startDate: nextStart,
    addedDate: nextStart,
    updatedAt: new Date().toISOString(),
  };

  if (resolvedStart !== undefined && periods[0]?.shoeId === id && resolvedStart < periods[0].from) {
    periods = [{ shoeId: id, from: resolvedStart }, ...periods.slice(1)];
  }
  shoes[idx] = next;

  if (isDefault === true && !shoe.isDefault) {
    for (const s of shoes) s.isDefault = s.id === id;
    periods = withPeriod(periods, id, laterOf(next.startDate, today));
  } else if (isDefault === false && shoe.isDefault) {
    next.isDefault = false;
    periods = withPeriod(periods, null, today);
  }

  saveShoes(shoes);
  savePeriods(periods);
  emitChanged();
  return getShoeById(id);
}

/** Make a shoe the default for new runs (null = no default). Returns the shoe, or null if missing/retired. */
export function setDefaultShoe(id: string | null): Shoe | null {
  if (id === null) {
    const current = getDefaultShoe();
    if (current) updateShoe(current.id, { isDefault: false });
    return null;
  }
  const shoe = getShoeById(id);
  if (!shoe || shoe.status === 'retired') return null;
  return updateShoe(id, { isDefault: true });
}

/**
 * Retire a shoe. Runs up to and including today still count toward it; if it
 * was the default, the next active shoe becomes the default from tomorrow.
 */
export function retireShoe(id: string): Shoe | null {
  const today = todayKey();
  const shoes = readShoes(today);
  const shoe = shoes.find((s) => s.id === id);
  if (!shoe) return null;
  let periods = effectivePeriods(shoes, readPeriods());

  shoe.status = 'retired';
  shoe.retiredAt = new Date().toISOString();
  shoe.updatedAt = shoe.retiredAt;

  if (shoe.isDefault) {
    shoe.isDefault = false;
    const tomorrow = addDays(today, 1);
    const nextActive = shoes.find((s) => s.status === 'active' && s.id !== id);
    if (nextActive) {
      nextActive.isDefault = true;
      periods = withPeriod(periods, nextActive.id, laterOf(nextActive.startDate, tomorrow));
    } else {
      periods = withPeriod(periods, null, tomorrow);
    }
  }

  saveShoes(shoes);
  savePeriods(periods);
  emitChanged();
  return getShoeById(id);
}

/** Re-activate a previously retired shoe (becomes default when no active default exists). */
export function reactivateShoe(id: string): Shoe | null {
  const today = todayKey();
  const shoes = readShoes(today);
  const shoe = shoes.find((s) => s.id === id);
  if (!shoe) return null;
  let periods = effectivePeriods(shoes, readPeriods());

  shoe.status = 'active';
  shoe.retiredAt = undefined;
  shoe.updatedAt = new Date().toISOString();
  if (!shoes.some((s) => s.isDefault && s.status === 'active')) {
    shoe.isDefault = true;
    periods = withPeriod(periods, id, laterOf(shoe.startDate, today));
  }
  saveShoes(shoes);
  savePeriods(periods);
  emitChanged();
  return getShoeById(id);
}

/** Delete a shoe entirely (its explicit run choices revert to automatic). */
export function deleteShoe(id: string): boolean {
  const today = todayKey();
  const shoes = readShoes(today);
  const shoe = shoes.find((s) => s.id === id);
  if (!shoe) return false;
  const filtered = shoes.filter((s) => s.id !== id);
  let periods = effectivePeriods(shoes, readPeriods());
  if (shoe.isDefault) {
    const nextActive = filtered.find((s) => s.status === 'active');
    if (nextActive) {
      nextActive.isDefault = true;
      periods = withPeriod(periods, nextActive.id, laterOf(nextActive.startDate, today));
    } else {
      periods = withPeriod(periods, null, today);
    }
  }
  saveShoes(filtered);
  savePeriods(periods);
  saveAssignments(readAssignments().filter((a) => a.shoeId !== id));
  emitChanged();
  return true;
}

// ── Shoe Queries ──────────────────────────────────────────────────────────────

/** Get all shoes (with computed mileage). */
export function getShoes(): Shoe[] {
  return loadState().shoes.map(cloneShoe);
}

/** Get active shoes only. */
export function getActiveShoes(): Shoe[] {
  return getShoes().filter((s) => s.status === 'active');
}

/** Get retired shoes only. */
export function getRetiredShoes(): Shoe[] {
  return getShoes().filter((s) => s.status === 'retired');
}

/** Get the current default shoe, or null. */
export function getDefaultShoe(): Shoe | null {
  const s = loadState().shoes.find((x) => x.isDefault && x.status === 'active');
  return s ? cloneShoe(s) : null;
}

/** Get a single shoe by ID, or null. */
export function getShoeById(id: string): Shoe | null {
  const s = loadState().byId.get(id);
  return s ? cloneShoe(s) : null;
}

// ── Activity Assignment & Mileage ─────────────────────────────────────────────

function keyOf(activityKey: string | number): string {
  return String(activityKey).trim();
}

/**
 * Explicitly choose the shoe for a run (`shoeId: null` records "no shoe" and
 * overrides any default shoe). If `run` is omitted, looks up the activity in
 * the local activity store. Returns false for an unknown shoe, non-run stored
 * activity, or invalid key.
 */
export function setActivityShoe(
  activityKey: string | number,
  shoeId: string | null,
  run?: { distanceM?: number; date?: string },
): boolean {
  const key = keyOf(activityKey);
  if (!key) return false;
  if (shoeId !== null && !readShoes().some((s) => s.id === shoeId)) return false;

  const stored = getAllStoredActivities().find((a) => String(a.id) === key);
  if (stored && !isRunActivity(stored)) return false;

  const rawDate = run?.date ?? (stored ? extractActivityLocalDate(stored) : '');
  const date = isDateKey(rawDate) ? rawDate : (dateKeyFromLocalIso(rawDate) ?? '');
  const rawDist = run?.distanceM ?? stored?.distance ?? 0;
  const distanceM = isFiniteNumber(rawDist) && rawDist > 0 ? rawDist : 0;

  const list = readAssignments().filter((a) => a.activityKey !== key);
  list.push({
    activityKey: key,
    shoeId,
    distanceM,
    date,
    assignedAt: new Date().toISOString(),
  });
  saveAssignments(list);
  emitChanged();
  return true;
}

/** Forget the explicit choice for a run: it reverts to the default shoe of its date. */
export function clearActivityShoe(activityKey: string | number): void {
  const key = keyOf(activityKey);
  const list = readAssignments();
  const next = list.filter((a) => a.activityKey !== key);
  if (next.length === list.length) return;
  saveAssignments(next);
  emitChanged();
}

/**
 * Assign a shoe to an activity (explicit choice; replaces an earlier one).
 * If no `shoeId` is provided, the default shoe is used.
 * Keeps the ≤1.0.5 signature (`distanceMi` in miles).
 */
export function assignShoeToActivity(
  activityKey: string,
  distanceMi: number,
  date: string,
  shoeId?: string,
): Shoe | null {
  const targetId = shoeId ?? getDefaultShoe()?.id;
  if (!targetId) return null;
  if (!setActivityShoe(activityKey, targetId, { distanceM: distanceMi * METERS_PER_MILE, date })) {
    return null;
  }
  return getShoeById(targetId);
}

/** How a run's shoe was determined. */
export interface ActivityShoeInfo {
  shoe: Shoe | null;
  /** `'explicit'` = chosen for this run; `'default'` = default shoe of that date; `'none'` = no shoe. */
  source: 'explicit' | 'default' | 'none';
  /** True when the athlete made an explicit choice for this run (a shoe or "no shoe"). */
  isExplicit: boolean;
}

/** Shoe of a run: its explicit choice, else the default shoe of `date` (read-only). */
export function getActivityShoeInfo(activityKey: string | number, date?: string | null): ActivityShoeInfo {
  return createActivityShoeResolver()(activityKey, date);
}

/**
 * Shoe lookups for many runs at once, such as a page of the activity list: the
 * shoes, choices and run totals are read once (on the first lookup) instead of
 * once per run. Each lookup answers exactly like {@link getActivityShoeInfo};
 * create a new resolver to see later changes.
 */
export function createActivityShoeResolver(): (activityKey: string | number, date?: string | null) => ActivityShoeInfo {
  let cache: { state: TrackerState; stored: Map<string, Activity> } | null = null;
  return (activityKey, date) => {
    if (!cache) {
      const state = loadState();
      const stored = new Map<string, Activity>();
      for (const a of getAllStoredActivities()) {
        const id = String(a.id);
        if (!stored.has(id)) stored.set(id, a);
      }
      cache = { state, stored };
    }
    const { state, stored } = cache;
    const key = keyOf(activityKey);
    const run = stored.get(key);
    if (run && (run.hidden || !isRunActivity(run))) {
      return { shoe: null, source: 'none', isExplicit: false };
    }
    const assignment = state.assignments.get(key);
    if (assignment) {
      const shoe = assignment.shoeId ? (state.byId.get(assignment.shoeId) ?? null) : null;
      return {
        shoe: shoe ? cloneShoe(shoe) : null,
        source: shoe ? 'explicit' : 'none',
        isExplicit: true,
      };
    }
    const day = date ? (isDateKey(date) ? date : dateKeyFromLocalIso(date)) : null;
    const shoeId = day ? defaultShoeIdOn(day, state.periods, state.byId) : null;
    const shoe = shoeId ? (state.byId.get(shoeId) ?? null) : null;
    return {
      shoe: shoe ? cloneShoe(shoe) : null,
      source: shoe ? 'default' : 'none',
      isExplicit: false,
    };
  };
}

/** Get which shoe was used for an activity (pass the run's date to include the default shoe). */
export function getActivityShoe(activityKey: string, date?: string): Shoe | null {
  return getActivityShoeInfo(activityKey, date).shoe;
}

/** Get activities counted toward a specific shoe (newest first). */
export function getShoeActivities(shoeId: string): ShoeActivity[] {
  return (loadState().usage.get(shoeId)?.activities ?? []).map((a) => ({ ...a }));
}

export interface BatchAssignOptions {
  /** Candidate activities (defaults to visible stored activities). */
  activities?: Activity[];
  /** Optional inclusive lower local date bound (`YYYY-MM-DD`). */
  fromDate?: string;
  /** Optional inclusive upper local date bound (`YYYY-MM-DD`). */
  toDate?: string;
}

/**
 * Visible running activities that currently have NO shoe attributed (neither an
 * explicit choice nor a default-shoe period covering their date).
 */
export function getUnassignedRuns(options: BatchAssignOptions = {}): Activity[] {
  const today = todayKey();
  const source = options.activities ?? getAllStoredActivities();
  const state = loadState(today, options.activities);
  const from = options.fromDate && isDateKey(options.fromDate) ? options.fromDate : null;
  const to = options.toDate && isDateKey(options.toDate) ? options.toDate : null;

  const out: Activity[] = [];
  for (const a of source) {
    if (!a || a.hidden || !isRunActivity(a)) continue;
    const key = keyOf(a.id);
    if (!key || state.assignments.has(key)) continue;
    const date = extractActivityLocalDate(a);
    if (!date) continue;
    if (from && date < from) continue;
    if (to && date > to) continue;
    if (defaultShoeIdOn(date, state.periods, state.byId) !== null) continue;
    out.push(a);
  }
  return out;
}

/**
 * Batch-assign unassigned visible runs to `shoeId` without touching runs already
 * assigned to another shoe, runs explicitly marked "no shoe", or runs already
 * covered by a default shoe period. Returns the number of runs assigned.
 */
export function assignUnassignedRunsToShoe(shoeId: string, options: BatchAssignOptions = {}): number {
  const shoes = readShoes();
  if (!shoes.some((s) => s.id === shoeId)) return 0;

  const runs = getUnassignedRuns(options);
  if (runs.length === 0) return 0;

  const list = readAssignments();
  const now = new Date().toISOString();
  for (const r of runs) {
    list.push({
      activityKey: keyOf(r.id),
      shoeId,
      distanceM: isFiniteNumber(r.distance) && r.distance > 0 ? r.distance : 0,
      date: extractActivityLocalDate(r),
      assignedAt: now,
    });
  }
  saveAssignments(list);
  emitChanged();
  return runs.length;
}

// ── Degradation, Stats & Alerts ───────────────────────────────────────────────

export interface ShoeAlertOptions {
  /** Unit for messages. Default: the athlete's setting (`getDistanceUnit()`). */
  unit?: DistanceUnit;
  /** Override today (`YYYY-MM-DD`) — for deterministic tests. */
  today?: string;
  /** Optional race date (`YYYY-MM-DD`) override for wear projection. */
  raceDate?: string;
}

function degradationFor(
  shoe: Shoe,
  usage: ShoeUsage | undefined,
  today: string,
  unit: DistanceUnit,
  raceDate?: string,
): ShoeDegradation {
  const current = shoe.currentMileage;
  const max = shoe.maxMileage > 0 ? shoe.maxMileage : DEFAULT_MAX_MILEAGE[shoe.category];
  const usagePct = Math.round((current * 100) / max);
  const remainingMiles = round2(Math.max(0, max - current));

  // Estimate weekly mileage from recent 4 weeks of activity
  const milesPerWeek = round1((usage?.recentMiles ?? 0) / (RECENT_DAYS / 7));

  // Project weeks until retirement
  const weeksUntilRetirement = milesPerWeek > 0 ? round1(remainingMiles / milesPerWeek) : null;
  const projectedLimitDate =
    remainingMiles <= 0
      ? today
      : milesPerWeek > 0
        ? addDays(today, Math.ceil(remainingMiles / (milesPerWeek / 7)))
        : null;

  // Check if shoe will exceed limit before race day
  let exceedsBeforeRace = false;
  const race = raceDate && isDateKey(raceDate) ? raceDate : undefined;
  if (race && race >= today && milesPerWeek > 0 && shoe.status === 'active') {
    const projectedMiles = current + milesPerWeek * (daysBetween(today, race) / 7);
    exceedsBeforeRace = projectedMiles > max;
  }

  // Determine urgency
  let urgency: ShoeDegradation['urgency'] = 'ok';
  if (shoe.status === 'retired') urgency = 'retired';
  else if (usagePct >= 100) urgency = 'critical';
  else if (usagePct >= 80 || exceedsBeforeRace) urgency = 'warning';

  const fmt = (mi: number) => formatShoeDistance(mi, unit);
  let statusMessage: string;
  if (shoe.status === 'retired') {
    statusMessage = `${shoe.name} is retired at ${fmt(current)} of ${fmt(max)}.`;
  } else if (usagePct >= 100) {
    statusMessage = `${shoe.name} has exceeded its ${fmt(max)} limit (${fmt(current)}). Time to retire.`;
  } else if (exceedsBeforeRace && race) {
    statusMessage =
      `${shoe.name} — ${fmt(current)} of ${fmt(max)}. At your recent ${fmt(milesPerWeek)} a week it will pass ` +
      `its limit before race day (${formatShortDate(race)}). Consider breaking in a new pair.`;
  } else if (usagePct >= 80) {
    statusMessage = `${shoe.name} — ${fmt(current)} of ${fmt(max)} (${usagePct}%). Approaching retirement.`;
  } else {
    statusMessage = `${shoe.name} — ${fmt(current)} of ${fmt(max)} (${usagePct}%). ${fmt(remainingMiles)} left.`;
  }

  return {
    shoeId: shoe.id,
    usagePct,
    remainingMiles,
    milesPerWeek,
    weeksUntilRetirement,
    exceedsBeforeRace,
    statusMessage,
    urgency,
    currentMiles: current,
    maxMiles: max,
    projectedLimitDate,
  };
}

/**
 * Compute full stats, wear percentage, run count, and unit-aware degradation
 * for every shoe in the rotation.
 * Defaults to visible stored activities (`isRunActivity(a) && !a.hidden`) when
 * `activities` is omitted.
 */
export function getShoesWithStats(activities?: Activity[], options: ShoeAlertOptions = {}): ShoeWithStats[] {
  const today = options.today ?? todayKey();
  const unit = options.unit ?? getDistanceUnit();
  const race = options.raceDate ?? getRaceDate() ?? undefined;
  const state = loadState(today, activities);

  return state.shoes.map((shoe) => {
    const u = state.usage.get(shoe.id);
    const loggedMiles = round2(u?.miles ?? 0);
    const acts = (u?.activities ?? []).map((a) => ({ ...a }));
    const deg = degradationFor(shoe, u, today, unit, race);
    return {
      ...shoe,
      loggedMiles,
      remainingMiles: deg.remainingMiles,
      wearPct: deg.usagePct,
      runCount: acts.length,
      lastUsedDate: acts.length > 0 ? acts[0].date : null,
      activities: acts,
      degradation: deg,
    };
  });
}

/**
 * Calculate degradation status for a single shoe.
 * @param shoeId The shoe to analyze
 * @param raceDate Optional race date (`YYYY-MM-DD`) for projection alerts
 */
export function calculateDegradation(
  shoeId: string,
  raceDate?: string,
  options: ShoeAlertOptions = {},
): ShoeDegradation | null {
  const state = loadState(options.today ?? todayKey());
  const shoe = state.byId.get(shoeId);
  if (!shoe) return null;
  return degradationFor(
    shoe,
    state.usage.get(shoeId),
    state.today,
    options.unit ?? getDistanceUnit(),
    raceDate ?? options.raceDate,
  );
}

/**
 * Check all active shoes for retirement alerts (`≥ 80%` wear or projected to
 * exceed limit before race day).
 */
export function checkRetirementAlerts(raceDate?: string, options: ShoeAlertOptions = {}): ShoeDegradation[] {
  return getShoesSummary(raceDate, options).filter((d) => d.urgency === 'warning' || d.urgency === 'critical');
}

/** Degradation status of every shoe (active and retired). */
export function getShoesSummary(raceDate?: string, options: ShoeAlertOptions = {}): ShoeDegradation[] {
  const state = loadState(options.today ?? todayKey());
  const unit = options.unit ?? getDistanceUnit();
  const effectiveRace = raceDate ?? options.raceDate;
  return state.shoes.map((s) => degradationFor(s, state.usage.get(s.id), state.today, unit, effectiveRace));
}

/**
 * Race-day helper: active shoes that will pass their retirement distance on
 * or before race day at the recent weekly pace (or are already past it).
 * `raceDate` defaults to the goal race (`journey.getRaceDate()`). Returns `[]`
 * when there is no upcoming race.
 */
export function checkRaceDayShoes(raceDate?: string | null, options: ShoeAlertOptions = {}): RaceDayShoeAlert[] {
  const race = raceDate === undefined ? getRaceDate() : raceDate;
  const state = loadState(options.today ?? todayKey());
  if (!race || !isDateKey(race) || race < state.today) return [];
  const unit = options.unit ?? getDistanceUnit();
  const fmt = (mi: number) => formatShoeDistance(mi, unit);
  const daysToRace = daysBetween(state.today, race);
  const alerts: RaceDayShoeAlert[] = [];

  for (const shoe of state.shoes) {
    if (shoe.status !== 'active') continue;
    const d = degradationFor(shoe, state.usage.get(shoe.id), state.today, unit, race);
    const projected = round1(d.currentMiles + d.milesPerWeek * (daysToRace / 7));
    const alreadyOver = d.currentMiles >= d.maxMiles;
    if (!alreadyOver && projected <= d.maxMiles) continue;
    const limitDate = alreadyOver ? null : d.projectedLimitDate;
    const message = alreadyOver
      ? `${shoe.name} is already past its ${fmt(d.maxMiles)} limit. Break in a fresh pair before race day (${formatShortDate(race)}).`
      : `${shoe.name} will pass its ${fmt(d.maxMiles)} limit around ${formatShortDate(limitDate ?? race)}, before race day (${formatShortDate(race)}).`;
    alerts.push({
      shoeId: shoe.id,
      shoeName: shoe.name,
      category: shoe.category,
      raceDate: race,
      currentMiles: d.currentMiles,
      projectedMilesAtRace: projected,
      maxMiles: d.maxMiles,
      limitDate,
      alreadyOver,
      message,
    });
  }
  return alerts;
}
