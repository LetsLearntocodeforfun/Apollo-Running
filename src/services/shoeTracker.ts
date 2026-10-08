/**
 * Shoe Tracker — manage shoe rotation, mileage accumulation,
 * degradation curves, and race-day retirement alerts.
 *
 * Shoes auto-accumulate mileage from synced activities.
 * Default shoe is assigned unless the user tags an activity to a specific shoe.
 *
 * v1.0.6 model (U-22..U-27):
 *  - Mileage is COMPUTED when shoes are read: `initialMileage` + the runs
 *    counted toward the shoe. Nothing accumulates in storage, so corrected or
 *    deleted activities can't make the total drift.
 *  - A run counts toward a shoe when the athlete chose that shoe for it
 *    (explicit assignment; "no shoe" is an explicit choice too), otherwise
 *    toward the shoe that was the DEFAULT on the run's date — applied at read
 *    time, never written — and only on/after that shoe's `startDate`. Adding a
 *    shoe therefore never back-fills years of history silently.
 *  - Runs only (Run, TrailRun, VirtualRun), keyed by the canonical activity
 *    id (`String(activity.id)`; cross-source duplicates are merged into one
 *    record by the activity store), so a run is never counted twice.
 *  - Messages use the athlete's distance unit. Distances are stored in miles.
 */

import type {
  Shoe,
  ShoeActivity,
  ShoeAssignment,
  ShoeCategory,
  ShoeDefaultPeriod,
  ShoeDegradation,
  RaceDayShoeAlert,
} from '../types/shoes';
import { DEFAULT_MAX_MILEAGE, SHOE_CATEGORIES } from '../types/shoes';
import { persistence } from './db/persistence';
import { getStoredActivities } from './analyticsService';
import { isRunActivity } from './activity/sports';
import { getDistanceUnit, type DistanceUnit } from './unitPreferences';
import { getRaceDate } from './journey';
import { addDays, dateKeyFromLocalIso, daysBetween, isDateKey, parseDateKey, toDateKey, todayKey } from '../utils/localDate';

const SHOES_KEY = 'apollo_shoes';
/** v1.0.6 explicit per-run choices. */
const ASSIGNMENTS_KEY = 'apollo_shoe_assignments';
/** v1.0.6 default-shoe history. */
const DEFAULT_PERIODS_KEY = 'apollo_shoe_default_periods';
/** ≤1.0.5 accumulated assignments; their mileage is already in the legacy `currentMileage`. */
const LEGACY_ACTIVITIES_KEY = 'apollo_shoe_activities';

/** Fired on `window` after any shoe or assignment change. */
export const SHOES_CHANGED_EVENT = 'apollo:shoes-changed';

const METERS_PER_MILE = 1609.344;
const KM_PER_MILE = 1.609344;
/** Upper bounds that catch typos (miles). */
const MAX_LIMIT_MILES = 5000;
const MAX_INITIAL_MILES = 10000;
const MAX_NAME_LENGTH = 80;
const MAX_NOTES_LENGTH = 1000;
/** Recent window used for the weekly pace (days, including today). */
const RECENT_DAYS = 28;

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

/** Local date key of an ISO timestamp (falls back to `fallback`). */
function localDateOfIso(iso: string | undefined, fallback: string): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : toDateKey(d);
}

function emitChanged(): void {
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SHOES_CHANGED_EVENT));
  } catch { /* events are best-effort */ }
}

/** Subscribe to shoe/assignment changes (any component or tab of the app). Returns an unsubscribe function. */
export function onShoesChanged(cb: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener(SHOES_CHANGED_EVENT, cb);
  return () => window.removeEventListener(SHOES_CHANGED_EVENT, cb);
}

// ── Units ─────────────────────────────────────────────────────────────────────

/** Miles → the athlete's unit (number). */
export function milesToShoeUnit(miles: number, unit: DistanceUnit = getDistanceUnit()): number {
  return unit === 'km' ? miles * KM_PER_MILE : miles;
}

/** A distance typed in the athlete's unit → miles (for addShoe/updateShoe). */
export function shoeUnitToMiles(value: number, unit: DistanceUnit = getDistanceUnit()): number {
  return unit === 'km' ? value / KM_PER_MILE : value;
}

/** "312 km" / "194 mi" (whole units by default). */
export function formatShoeDistance(miles: number, unit: DistanceUnit = getDistanceUnit(), decimals = 0): string {
  const value = milesToShoeUnit(miles, unit);
  return `${value.toFixed(decimals)} ${unit}`;
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

/** Normalise a stored shoe (fills v1.0.6 fields for ≤1.0.5 data, in memory only). */
function normalizeShoe(raw: unknown, today: string): Shoe | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<Shoe> & Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) return null;
  const category: ShoeCategory = isCategory(s.category) ? s.category : 'training';
  const createdAt = typeof s.createdAt === 'string' ? s.createdAt : new Date(0).toISOString();
  const purchaseDate = isDateKey(s.purchaseDate) ? s.purchaseDate : '';
  // ≤1.0.5 stored an accumulated total and no starting distance: keep that total as the start.
  const legacyTotal = isFiniteNumber(s.currentMileage) && s.currentMileage > 0 ? s.currentMileage : 0;
  const initialMileage = isFiniteNumber(s.initialMileage) && s.initialMileage >= 0 ? s.initialMileage : legacyTotal;
  const startDate = isDateKey(s.startDate) ? s.startDate : localDateOfIso(createdAt, purchaseDate || today);
  const maxMileage = isFiniteNumber(s.maxMileage) && s.maxMileage > 0 ? s.maxMileage : DEFAULT_MAX_MILEAGE[category];
  return {
    id: s.id,
    name: typeof s.name === 'string' ? s.name : '',
    brand: typeof s.brand === 'string' ? s.brand : '',
    model: typeof s.model === 'string' ? s.model : '',
    category,
    status: s.status === 'retired' ? 'retired' : 'active',
    purchaseDate,
    maxMileage,
    initialMileage,
    startDate,
    currentMileage: initialMileage,
    isDefault: s.isDefault === true && s.status !== 'retired',
    notes: typeof s.notes === 'string' && s.notes ? s.notes : undefined,
    createdAt,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : createdAt,
    retiredAt: s.status === 'retired' && typeof s.retiredAt === 'string' ? s.retiredAt : undefined,
  };
}

function readShoes(today: string = todayKey()): Shoe[] {
  const raw = readJson(SHOES_KEY);
  const list = Array.isArray(raw) ? raw.map((s) => normalizeShoe(s, today)).filter((s): s is Shoe => s !== null) : [];
  // At most one default (the first flagged one wins).
  let seen = false;
  for (const s of list) {
    if (s.isDefault && !seen) seen = true;
    else s.isDefault = false;
  }
  return list;
}

function readAssignments(): ShoeAssignment[] {
  const raw = readJson(ASSIGNMENTS_KEY);
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
  const raw = readJson(DEFAULT_PERIODS_KEY);
  if (!Array.isArray(raw)) return [];
  return (raw as Partial<ShoeDefaultPeriod>[])
    .filter((p): p is ShoeDefaultPeriod => !!p && isDateKey(p.from))
    .map((p) => ({ shoeId: typeof p.shoeId === 'string' && p.shoeId ? p.shoeId : null, from: p.from }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** Stored history, or one synthesised for ≤1.0.5 data (a default shoe but no history). */
function effectivePeriods(shoes: Shoe[], stored: ShoeDefaultPeriod[]): ShoeDefaultPeriod[] {
  if (stored.length > 0) return stored;
  const def = shoes.find((s) => s.isDefault && s.status === 'active');
  return def ? [{ shoeId: def.id, from: def.startDate }] : [];
}

/** Persist shoes (stored without the computed total) and drop the ≤1.0.5 accumulation store. */
function saveShoes(shoes: Shoe[]): void {
  persistence.setItem(SHOES_KEY, JSON.stringify(shoes.map((s) => ({ ...s, currentMileage: s.initialMileage }))));
  if (persistence.getItem(LEGACY_ACTIVITIES_KEY) !== null) persistence.removeItem(LEGACY_ACTIVITIES_KEY);
}

function saveAssignments(list: ShoeAssignment[]): void {
  persistence.setItem(ASSIGNMENTS_KEY, JSON.stringify(list));
}

function savePeriods(periods: ShoeDefaultPeriod[]): void {
  persistence.setItem(DEFAULT_PERIODS_KEY, JSON.stringify(periods));
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

// ── Runs (read-only view of the activity store) ──────────────────────────────

interface StoredActivityRef {
  key: string;
  date: string;
  distanceM: number;
  isRun: boolean;
}

let activityCache: { source: unknown; refs: StoredActivityRef[] } | null = null;

/** Every stored activity with a valid local date, keyed by canonical id. */
function storedActivityRefs(): StoredActivityRef[] {
  let list: ReturnType<typeof getStoredActivities>;
  try {
    list = getStoredActivities();
  } catch {
    return [];
  }
  if (activityCache && activityCache.source === list) return activityCache.refs;
  const refs: StoredActivityRef[] = [];
  for (const a of Array.isArray(list) ? list : []) {
    const date = dateKeyFromLocalIso(a.start_date_local);
    if (!date || a.id === undefined || a.id === null) continue;
    refs.push({ key: String(a.id), date, distanceM: isFiniteNumber(a.distance) ? Math.max(0, a.distance) : 0, isRun: isRunActivity(a) });
  }
  activityCache = { source: list, refs };
  return refs;
}

// ── Attribution (pure) ────────────────────────────────────────────────────────

function retiredDate(shoe: Shoe): string | null {
  return shoe.status === 'retired' && shoe.retiredAt ? localDateOfIso(shoe.retiredAt, '') || null : null;
}

/** The shoe a run without an explicit choice counts toward on `date`, or null. */
function defaultShoeIdOn(date: string, periods: ShoeDefaultPeriod[], byId: Map<string, Shoe>): string | null {
  let current: ShoeDefaultPeriod | null = null;
  for (const p of periods) {
    if (p.from <= date) current = p;
    else break;
  }
  if (!current?.shoeId) return null;
  const shoe = byId.get(current.shoeId);
  if (!shoe || date < shoe.startDate) return null;
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

/**
 * Attribute every counted run to a shoe: explicit choices first (live
 * distance/date when the activity is still stored), then runs without a
 * choice to the default shoe of their date. Non-runs never count.
 */
function computeUsage(
  shoes: Shoe[],
  assignments: ShoeAssignment[],
  periods: ShoeDefaultPeriod[],
  activities: StoredActivityRef[],
  today: string,
): Map<string, ShoeUsage> {
  const byId = new Map(shoes.map((s) => [s.id, s]));
  const usage = new Map<string, ShoeUsage>(shoes.map((s) => [s.id, { miles: 0, recentMiles: 0, activities: [] }]));
  const recentFrom = addDays(today, -(RECENT_DAYS - 1));
  const stored = new Map(activities.map((a) => [a.key, a]));
  const explicit = new Set<string>();

  const count = (shoeId: string, key: string, date: string, distanceM: number, source: 'explicit' | 'default') => {
    const acc = usage.get(shoeId);
    if (!acc || !(distanceM > 0)) return;
    const miles = distanceM / METERS_PER_MILE;
    acc.miles += miles;
    if (date >= recentFrom) acc.recentMiles += miles;
    acc.activities.push({ activityKey: key, shoeId, distanceMi: round2(miles), date, source });
  };

  for (const a of assignments) {
    explicit.add(a.activityKey);
    if (!a.shoeId) continue;
    const live = stored.get(a.activityKey);
    if (live && !live.isRun) continue;
    count(a.shoeId, a.activityKey, live?.date ?? a.date, live?.distanceM ?? a.distanceM, 'explicit');
  }
  for (const run of activities) {
    if (!run.isRun || explicit.has(run.key)) continue;
    const shoeId = defaultShoeIdOn(run.date, periods, byId);
    if (shoeId) count(shoeId, run.key, run.date, run.distanceM, 'default');
  }
  for (const acc of usage.values()) acc.activities.sort((a, b) => b.date.localeCompare(a.date));
  return usage;
}

let stateCache: { sig: string; activities: unknown; state: TrackerState } | null = null;

/** Shoes with computed mileage + attribution (memoised on the raw stores). */
function loadState(today: string = todayKey()): TrackerState {
  const sig = [
    today,
    persistence.getItem(SHOES_KEY) ?? '',
    persistence.getItem(ASSIGNMENTS_KEY) ?? '',
    persistence.getItem(DEFAULT_PERIODS_KEY) ?? '',
  ].join('\u0000');
  const activities = storedActivityRefs();
  if (stateCache && stateCache.sig === sig && stateCache.activities === activities) return stateCache.state;

  const shoes = readShoes(today);
  const assignmentList = readAssignments();
  const periods = effectivePeriods(shoes, readPeriods());
  const usage = computeUsage(shoes, assignmentList, periods, activities, today);
  for (const s of shoes) s.currentMileage = round2(s.initialMileage + (usage.get(s.id)?.miles ?? 0));
  const state: TrackerState = {
    today,
    shoes,
    byId: new Map(shoes.map((s) => [s.id, s])),
    assignments: new Map(assignmentList.map((a) => [a.activityKey, a])),
    periods,
    usage,
  };
  stateCache = { sig, activities, state };
  return state;
}

function cloneShoe(s: Shoe): Shoe {
  return { ...s };
}

// ── Validation (U-24) ─────────────────────────────────────────────────────────

/** Editable shoe fields (distances in miles). */
export interface ShoeInput {
  name?: string;
  brand: string;
  model: string;
  category: ShoeCategory;
  /** YYYY-MM-DD, optional. */
  purchaseDate?: string;
  /** Retirement distance (miles). Default: by category. */
  maxMileage?: number;
  /** Distance already on the shoe (miles). Default 0. */
  initialMileage?: number;
  /** Count runs from this date while default (YYYY-MM-DD). Default: today. */
  startDate?: string;
  isDefault?: boolean;
  notes?: string;
}

export type ShoeField = 'name' | 'brand' | 'model' | 'category' | 'purchaseDate' | 'startDate' | 'maxMileage' | 'initialMileage' | 'notes';
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

  if (has('name') || has('brand') || has('model')) {
    const label = (input.name ?? '').trim() || `${input.brand ?? ''} ${input.model ?? ''}`.trim();
    if (!partial && !label) errors.name = 'Give the shoe a name, or a brand and model.';
    if (partial && has('name') && input.name !== undefined && !input.name.trim()) errors.name = 'The name can’t be empty.';
    if ((input.name ?? '').trim().length > MAX_NAME_LENGTH) errors.name = `Keep the name under ${MAX_NAME_LENGTH} characters.`;
  }
  if (has('category') && !isCategory(input.category)) errors.category = 'Choose training, racing or both.';
  if (has('maxMileage') && input.maxMileage !== undefined) {
    if (!isFiniteNumber(input.maxMileage) || input.maxMileage <= 0) errors.maxMileage = 'Enter a retirement distance greater than 0.';
    else if (input.maxMileage > MAX_LIMIT_MILES) errors.maxMileage = 'That retirement distance looks too large.';
  }
  if (has('initialMileage') && input.initialMileage !== undefined) {
    if (!isFiniteNumber(input.initialMileage) || input.initialMileage < 0) errors.initialMileage = 'The starting distance can’t be negative.';
    else if (input.initialMileage > MAX_INITIAL_MILES) errors.initialMileage = 'That starting distance looks too large.';
  }
  if (has('purchaseDate') && input.purchaseDate && !isDateKey(input.purchaseDate)) errors.purchaseDate = 'Enter a valid date.';
  if (has('startDate') && input.startDate !== undefined && !isDateKey(input.startDate)) errors.startDate = 'Enter a valid date.';
  if (has('notes') && (input.notes ?? '').length > MAX_NOTES_LENGTH) errors.notes = `Keep notes under ${MAX_NOTES_LENGTH} characters.`;
  return errors;
}

function assertValid(input: Partial<ShoeInput>, partial: boolean): void {
  const errors = validateShoeInput(input, { partial });
  if (Object.keys(errors).length > 0) throw new ShoeValidationError(errors);
}

// ── Shoe CRUD ─────────────────────────────────────────────────────────────────

/** Generate a short unique ID */
function generateId(): string {
  return `shoe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Add a new shoe. Throws ShoeValidationError for invalid input. The first
 * active shoe becomes the default automatically.
 */
export function addShoe(shoe: ShoeInput): Shoe {
  assertValid(shoe, false);
  const today = todayKey();
  const shoes = readShoes(today);
  const periodsBefore = effectivePeriods(shoes, readPeriods());
  const now = new Date().toISOString();
  const name = (shoe.name ?? '').trim() || `${shoe.brand} ${shoe.model}`.trim();

  const newShoe: Shoe = {
    id: generateId(),
    name,
    brand: shoe.brand.trim(),
    model: shoe.model.trim(),
    category: shoe.category,
    status: 'active',
    purchaseDate: shoe.purchaseDate ?? '',
    maxMileage: shoe.maxMileage ?? DEFAULT_MAX_MILEAGE[shoe.category],
    initialMileage: round2(shoe.initialMileage ?? 0),
    startDate: shoe.startDate ?? today,
    currentMileage: round2(shoe.initialMileage ?? 0),
    isDefault: shoe.isDefault ?? false,
    notes: shoe.notes?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
  };

  // Auto-set as default if it's the only active shoe
  if (!shoes.some((s) => s.status === 'active')) newShoe.isDefault = true;

  let periods = periodsBefore;
  if (newShoe.isDefault) {
    // If this is the default, clear other defaults
    for (const s of shoes) s.isDefault = false;
    // A new default counts its runs from its start date — unless that would
    // take runs away from an earlier default, in which case from today.
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
export type ShoeUpdate = Partial<Pick<Shoe,
  'name' | 'brand' | 'model' | 'category' | 'purchaseDate' | 'maxMileage' | 'initialMileage' | 'startDate' | 'isDefault' | 'notes'>>;

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
  const { isDefault, ...fields } = updates;
  const next: Shoe = {
    ...shoe,
    ...fields,
    name: fields.name !== undefined ? fields.name.trim() : shoe.name,
    notes: fields.notes !== undefined ? fields.notes.trim() || undefined : shoe.notes,
    initialMileage: fields.initialMileage !== undefined ? round2(fields.initialMileage) : shoe.initialMileage,
    updatedAt: new Date().toISOString(),
  };

  // Moving the start date earlier on the very first default period back-fills it (explicit choice).
  if (fields.startDate !== undefined && periods[0]?.shoeId === id && fields.startDate < periods[0].from) {
    periods = [{ shoeId: id, from: fields.startDate }, ...periods.slice(1)];
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

  // If retired shoe was default, pick next active shoe
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

/** Re-activate a previously retired shoe (it becomes the default when there is none). */
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

/** Delete a shoe entirely (its explicit run choices go back to automatic). */
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

  // Also remove activity assignments
  saveAssignments(readAssignments().filter((a) => a.shoeId !== id));
  emitChanged();
  return true;
}

// ── Shoe Queries ──────────────────────────────────────────────────────────────

/** Get all shoes (with computed mileage) */
export function getShoes(): Shoe[] {
  return loadState().shoes.map(cloneShoe);
}

/** Get active shoes only */
export function getActiveShoes(): Shoe[] {
  return getShoes().filter((s) => s.status === 'active');
}

/** Get retired shoes */
export function getRetiredShoes(): Shoe[] {
  return getShoes().filter((s) => s.status === 'retired');
}

/** Get the default shoe */
export function getDefaultShoe(): Shoe | null {
  const s = loadState().shoes.find((x) => x.isDefault && x.status === 'active');
  return s ? cloneShoe(s) : null;
}

/** Get a shoe by ID */
export function getShoeById(id: string): Shoe | null {
  const s = loadState().byId.get(id);
  return s ? cloneShoe(s) : null;
}

// ── Activity Assignment & Mileage ─────────────────────────────────────────────

/** Canonical assignment key for an activity id. */
function keyOf(activityKey: string | number): string {
  return String(activityKey).trim();
}

/**
 * Explicitly choose the shoe for a run (U-22: reassigning replaces the
 * previous choice). `shoeId: null` records "no shoe", which overrides the
 * default shoe. `run` is the run's distance (m) and local date, used if the
 * activity later disappears from the store. Returns false for an unknown shoe
 * or invalid input.
 */
export function setActivityShoe(
  activityKey: string | number,
  shoeId: string | null,
  run: { distanceM: number; date: string },
): boolean {
  const key = keyOf(activityKey);
  if (!key) return false;
  if (shoeId !== null && !readShoes().some((s) => s.id === shoeId)) return false;
  const date = isDateKey(run.date) ? run.date : dateKeyFromLocalIso(run.date) ?? '';
  const list = readAssignments().filter((a) => a.activityKey !== key);
  list.push({
    activityKey: key,
    shoeId,
    distanceM: isFiniteNumber(run.distanceM) && run.distanceM > 0 ? run.distanceM : 0,
    date,
    assignedAt: new Date().toISOString(),
  });
  saveAssignments(list);
  emitChanged();
  return true;
}

/** Forget the explicit choice for a run: it goes back to the default shoe (U-22). */
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
 * If no shoeId is provided, the default shoe is used.
 * Returns the updated shoe or null if no shoe could be assigned.
 * Prefer {@link setActivityShoe}; this keeps the ≤1.0.5 signature (miles).
 */
export function assignShoeToActivity(
  activityKey: string,
  distanceMi: number,
  date: string,
  shoeId?: string,
): Shoe | null {
  const targetId = shoeId ?? getDefaultShoe()?.id;
  if (!targetId) return null;
  if (!setActivityShoe(activityKey, targetId, { distanceM: distanceMi * METERS_PER_MILE, date })) return null;
  return getShoeById(targetId);
}

/** How a run's shoe was determined. */
export interface ActivityShoeInfo {
  shoe: Shoe | null;
  /** 'explicit' = chosen for this run; 'none' = no shoe (chosen, or no default applies); 'default' = default shoe of that date. */
  source: 'explicit' | 'default' | 'none';
  /** True when the athlete made a choice for this run (shoe or "no shoe"). */
  isExplicit: boolean;
}

/** Shoe of a run: its explicit choice, else the default shoe of `date` (read-only). */
export function getActivityShoeInfo(activityKey: string | number, date?: string | null): ActivityShoeInfo {
  const state = loadState();
  const assignment = state.assignments.get(keyOf(activityKey));
  if (assignment) {
    const shoe = assignment.shoeId ? state.byId.get(assignment.shoeId) ?? null : null;
    return { shoe: shoe ? cloneShoe(shoe) : null, source: shoe ? 'explicit' : 'none', isExplicit: true };
  }
  const day = date ? (isDateKey(date) ? date : dateKeyFromLocalIso(date)) : null;
  const shoeId = day ? defaultShoeIdOn(day, state.periods, state.byId) : null;
  const shoe = shoeId ? state.byId.get(shoeId) ?? null : null;
  return { shoe: shoe ? cloneShoe(shoe) : null, source: shoe ? 'default' : 'none', isExplicit: false };
}

/** Get which shoe was used for an activity (pass the run's date to include the default shoe). */
export function getActivityShoe(activityKey: string, date?: string): Shoe | null {
  return getActivityShoeInfo(activityKey, date).shoe;
}

/** Get activities counted toward a specific shoe (newest first) */
export function getShoeActivities(shoeId: string): ShoeActivity[] {
  return (loadState().usage.get(shoeId)?.activities ?? []).map((a) => ({ ...a }));
}

// ── Degradation & Alerts ──────────────────────────────────────────────────────

export interface ShoeAlertOptions {
  /** Unit for messages. Default: the athlete's setting. */
  unit?: DistanceUnit;
  /** Override today (YYYY-MM-DD) — tests. */
  today?: string;
}

function degradationFor(shoe: Shoe, usage: ShoeUsage | undefined, today: string, unit: DistanceUnit, raceDate?: string): ShoeDegradation {
  const current = shoe.currentMileage;
  const max = shoe.maxMileage > 0 ? shoe.maxMileage : DEFAULT_MAX_MILEAGE[shoe.category];
  const usagePct = Math.round((current / max) * 100);
  const remainingMiles = round2(Math.max(0, max - current));

  // Estimate weekly mileage from recent 4 weeks of activity
  const milesPerWeek = round1((usage?.recentMiles ?? 0) / (RECENT_DAYS / 7));

  // Project weeks until retirement
  const weeksUntilRetirement = milesPerWeek > 0 ? round1(remainingMiles / milesPerWeek) : null;
  const projectedLimitDate = remainingMiles <= 0
    ? today
    : milesPerWeek > 0 ? addDays(today, Math.ceil(remainingMiles / (milesPerWeek / 7))) : null;

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
    statusMessage = `${shoe.name} — ${fmt(current)} of ${fmt(max)}. At your recent ${fmt(milesPerWeek)} a week it will pass `
      + `its limit before race day (${formatShortDate(race)}). Consider breaking in a new pair.`;
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
 * Calculate degradation status for a shoe.
 * @param shoeId The shoe to analyze
 * @param raceDate Optional race date (YYYY-MM-DD) for projection alerts
 */
export function calculateDegradation(shoeId: string, raceDate?: string, options: ShoeAlertOptions = {}): ShoeDegradation | null {
  const state = loadState(options.today ?? todayKey());
  const shoe = state.byId.get(shoeId);
  if (!shoe) return null;
  return degradationFor(shoe, state.usage.get(shoeId), state.today, options.unit ?? getDistanceUnit(), raceDate);
}

/**
 * Check all active shoes for retirement alerts.
 * Returns shoes that need attention (≥80% used or will exceed before race day).
 */
export function checkRetirementAlerts(raceDate?: string, options: ShoeAlertOptions = {}): ShoeDegradation[] {
  return getShoesSummary(raceDate, options).filter((d) => d.urgency === 'warning' || d.urgency === 'critical');
}

/** Status of every shoe (active and retired). */
export function getShoesSummary(raceDate?: string, options: ShoeAlertOptions = {}): ShoeDegradation[] {
  const state = loadState(options.today ?? todayKey());
  const unit = options.unit ?? getDistanceUnit();
  return state.shoes.map((s) => degradationFor(s, state.usage.get(s.id), state.today, unit, raceDate));
}

/**
 * Race-day helper: active shoes that will pass their retirement distance on
 * or before race day at the recent weekly pace (or are already past it).
 * `raceDate` defaults to the goal race (journey.getRaceDate()). Returns []
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
