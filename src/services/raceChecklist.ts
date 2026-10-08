/**
 * Pre-Race Checklist Generator
 *
 * Customizable race day and race week checklists with course-specific
 * templates. Users can add/remove items, check them off, and data
 * persists locally.
 *
 * v1.0.6:
 * - Every list gets fresh item objects (L-10): templates are plain data and
 *   are never shared by reference, so a second list for the same race always
 *   starts unchecked.
 * - Collision-free ids via `crypto.randomUUID()` with a safe fallback (L-11).
 * - Course items are matched by stable race id (`normalizeMarathonId` +
 *   `isWorldMajorId`), never by substring, and contain race-week items only;
 *   training tasks live in courseTraining (L-12).
 * - Default items can be hidden (excluded from progress), and
 *   {@link getOrCreateChecklistForRace} gives one list per race (L-13).
 */

import { persistence } from './db/persistence';
import { isWorldMajorId, normalizeMarathonId, type WorldMajorId } from '../data/worldMajors';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  category: ChecklistCategory;
  isCustom: boolean;
  /** Default item the athlete has hidden. Hidden items are excluded from progress. */
  hidden?: boolean;
  /** Course-specific item (World Majors). */
  isCourse?: boolean;
}

export type ChecklistCategory =
  | 'gear'
  | 'nutrition'
  | 'logistics'
  | 'morning_of'
  | 'mental'
  | 'post_race';

export interface RaceChecklist {
  id: string;
  name: string;
  /** Race id as given at creation (legacy '*-marathon-2026' ids are matched via normalizeMarathonId). */
  marathonId?: string;
  items: ChecklistItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ChecklistProgress {
  checked: number;
  total: number;
  pct: number;
}

// ── Ids ───────────────────────────────────────────────────────────────────────

let fallbackCounter = 0;

/**
 * Collision-free id: `crypto.randomUUID()` when available, otherwise time +
 * a per-session counter + randomness (unique even within one millisecond).
 */
function newId(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return `${prefix}_${c.randomUUID()}`;
    } catch {
      // fall through to the fallback below
    }
  }
  fallbackCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${fallbackCounter.toString(36)}_${rand}`;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'apollo_race_checklists';

const CATEGORY_KEYS: readonly ChecklistCategory[] = [
  'gear', 'nutrition', 'logistics', 'morning_of', 'mental', 'post_race',
];

function isCategory(v: unknown): v is ChecklistCategory {
  return typeof v === 'string' && (CATEGORY_KEYS as readonly string[]).includes(v);
}

/** Drop malformed items and give duplicate ids (legacy `Date.now()` ids) a deterministic suffix. */
function sanitizeItems(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Map<string, number>();
  const items: ChecklistItem[] = [];
  for (const r of raw as Array<Partial<ChecklistItem> | null>) {
    if (!r || typeof r !== 'object' || typeof r.text !== 'string') continue;
    const baseId = typeof r.id === 'string' && r.id ? r.id : `item_legacy_${items.length + 1}`;
    const n = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, n);
    const item: ChecklistItem = {
      id: n === 1 ? baseId : `${baseId}~${n}`,
      text: r.text,
      checked: r.checked === true,
      category: isCategory(r.category) ? r.category : 'logistics',
      isCustom: r.isCustom === true,
    };
    if (r.hidden === true) item.hidden = true;
    if (r.isCourse === true) item.isCourse = true;
    items.push(item);
  }
  return items;
}

function loadChecklists(): RaceChecklist[] {
  const raw = persistence.getItem(STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const lists: RaceChecklist[] = [];
  for (const l of parsed as Array<Partial<RaceChecklist> | null>) {
    if (!l || typeof l !== 'object' || typeof l.id !== 'string') continue;
    const list: RaceChecklist = {
      id: l.id,
      name: typeof l.name === 'string' ? l.name : 'Race checklist',
      items: sanitizeItems(l.items),
      createdAt: typeof l.createdAt === 'string' ? l.createdAt : '',
      updatedAt: typeof l.updatedAt === 'string' ? l.updatedAt : '',
    };
    if (typeof l.marathonId === 'string' && l.marathonId) list.marathonId = l.marathonId;
    lists.push(list);
  }
  return lists;
}

function saveChecklists(lists: RaceChecklist[]): void {
  persistence.setItem(STORAGE_KEY, JSON.stringify(lists));
}

/** Load, apply `fn` to one list, save when `fn` reports a change. */
function updateList<T>(
  checklistId: string,
  fn: (list: RaceChecklist) => { changed: boolean; result: T },
  fallback: T,
): T {
  const all = loadChecklists();
  const list = all.find((c) => c.id === checklistId);
  if (!list) return fallback;
  const { changed, result } = fn(list);
  if (changed) {
    list.updatedAt = new Date().toISOString();
    saveChecklists(all);
  }
  return result;
}

// ── Default Templates ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<ChecklistCategory, string> = {
  gear: 'Gear & Equipment',
  nutrition: 'Nutrition & Hydration',
  logistics: 'Logistics',
  morning_of: 'Race Morning',
  mental: 'Mental Preparation',
  post_race: 'Post-Race',
};

export { CATEGORY_LABELS };

/** Categories in display order. */
export const CHECKLIST_CATEGORIES: readonly ChecklistCategory[] = CATEGORY_KEYS;

interface ItemTemplate {
  readonly text: string;
  readonly category: ChecklistCategory;
}

/**
 * Generic race-week items. Text is unit-neutral (no miles/feet/°F) because
 * km users see it too.
 */
const DEFAULT_TEMPLATES: readonly ItemTemplate[] = [
  // Gear
  { text: 'Race shoes (broken in, not new)', category: 'gear' },
  { text: 'Race outfit — singlet/shorts/sports bra (nothing new)', category: 'gear' },
  { text: 'Socks (tested on long runs)', category: 'gear' },
  { text: 'Race bib + safety pins', category: 'gear' },
  { text: 'Timing chip (if separate from bib)', category: 'gear' },
  { text: 'GPS watch — fully charged', category: 'gear' },
  { text: 'Anti-chafe product (Body Glide / Vaseline)', category: 'gear' },
  { text: 'Sunglasses (if sunny forecast)', category: 'gear' },
  { text: 'Hat or visor', category: 'gear' },
  { text: 'Sunscreen (SPF 30+)', category: 'gear' },
  { text: 'Throwaway layers for start line', category: 'gear' },
  { text: 'Race belt or fuel pouch', category: 'gear' },
  { text: 'Nipple guards / band-aids (if needed)', category: 'gear' },

  // Nutrition
  { text: 'Gels / chews packed and counted', category: 'nutrition' },
  { text: 'Pre-race breakfast food ready', category: 'nutrition' },
  { text: 'Electrolyte drink for morning', category: 'nutrition' },
  { text: 'Optional caffeine plan (30–60 min before the start) — only if you have practised it in training', category: 'nutrition' },
  { text: 'Post-race recovery snack', category: 'nutrition' },
  { text: 'Water bottle for pre-race hydration', category: 'nutrition' },

  // Logistics
  { text: 'Know your wave/corral start time and when the corral closes', category: 'logistics' },
  { text: 'Plan transportation to start line', category: 'logistics' },
  { text: 'Gear check / bag drop plan', category: 'logistics' },
  { text: 'Travelling across time zones? Shift your sleep a few days early and set alarms in race-local time', category: 'logistics' },
  { text: 'Phone charged (for tracking / photos)', category: 'logistics' },
  { text: 'Cash / credit card for emergencies', category: 'logistics' },
  { text: 'ID (required by some races)', category: 'logistics' },
  { text: 'Know post-race meeting point', category: 'logistics' },
  { text: 'Share race tracking with family/friends', category: 'logistics' },

  // Morning of
  { text: 'Set alarm (3.5-4 hours before start)', category: 'morning_of' },
  { text: 'Eat pre-race meal (3 hours before)', category: 'morning_of' },
  { text: 'Begin hydration (sip, don\'t chug)', category: 'morning_of' },
  { text: 'Apply anti-chafe and sunscreen', category: 'morning_of' },
  { text: 'Pin race bib to singlet', category: 'morning_of' },
  { text: 'Build in a buffer for porta-potty queues (20–30 min at big races)', category: 'morning_of' },
  { text: 'Last bathroom stop before corral', category: 'morning_of' },
  { text: 'Dynamic warm-up (5-10 min)', category: 'morning_of' },

  // Mental
  { text: 'Prioritise sleep two nights before — a restless night before the race is normal', category: 'mental' },
  { text: 'Review race strategy and splits', category: 'mental' },
  { text: 'Set watch to show correct pace data', category: 'mental' },
  { text: 'Remember: the first part should feel too easy', category: 'mental' },
  { text: 'Have mantras ready for the tough final third', category: 'mental' },
  { text: 'Visualize crossing the finish line', category: 'mental' },

  // Post-race
  { text: 'Dry clothes in gear check bag', category: 'post_race' },
  { text: 'Recovery food/drink accessible', category: 'post_race' },
  { text: 'Compression socks for recovery', category: 'post_race' },
  { text: 'Foam roller or massage ball', category: 'post_race' },
  { text: 'Plan a post-race meal / celebration', category: 'post_race' },
];

// ── Course-Specific Items ─────────────────────────────────────────────────────

/**
 * Race-week items per World Major. Training tasks (downhill or cobblestone
 * practice) belong in courseTraining, not here.
 */
const COURSE_TEMPLATES: Readonly<Record<WorldMajorId, readonly ItemTemplate[]>> = {
  boston: [
    { text: 'Warm throwaway layers for the Athletes\' Village wait in Hopkinton (donated to charity)', category: 'gear' },
    { text: 'Know your bus loading time to Hopkinton — buses leave early, by wave', category: 'logistics' },
    { text: 'Save energy for the Newton hills — the last one is Heartbreak Hill', category: 'mental' },
  ],
  nyc: [
    { text: 'Throwaway clothes for the long wait at Fort Wadsworth', category: 'gear' },
    { text: 'Ferry / bus time to the Staten Island start', category: 'logistics' },
    { text: 'Know whether you chose baggage or the no-baggage poncho exit', category: 'logistics' },
    { text: 'Prepare for 5 bridge climbs — run them by effort, not pace', category: 'mental' },
    { text: 'Wind is mainly a Verrazzano Bridge issue at the start — tuck in behind other runners', category: 'mental' },
    { text: 'The Queensboro Bridge lower deck is quiet with no crowds — have a mantra ready', category: 'mental' },
  ],
  chicago: [
    { text: 'Wind protection — a throwaway layer for a cool, windy lakefront start', category: 'gear' },
    { text: 'Plan for potential heat — October can be warm', category: 'mental' },
    { text: 'Draft in groups on exposed Lake Shore sections', category: 'mental' },
    { text: 'GPS can be unreliable between the downtown towers — pace by the course markers', category: 'mental' },
  ],
  london: [
    { text: 'Rain gear for the start (April showers)', category: 'gear' },
    { text: 'Know your start zone colour and how to get there', category: 'logistics' },
    { text: 'Check the official race guide for which drinks are offered where', category: 'nutrition' },
  ],
  berlin: [
    { text: 'Flat and fast — pace yourself, don\'t go out too hard', category: 'mental' },
    { text: 'The finish is just past the Brandenburg Gate — don\'t start your kick too early', category: 'mental' },
    { text: 'German beer at finish — earned!', category: 'post_race' },
  ],
  tokyo: [
    { text: 'Cool, possibly wet start in early March — bring a throwaway layer or poncho', category: 'gear' },
    { text: 'Security at the start is thorough — arrive early', category: 'logistics' },
    { text: 'Amazing crowd support — enjoy the energy', category: 'mental' },
    { text: 'Aid stations offer local snacks — stick to fuel you have practised with', category: 'nutrition' },
  ],
};

/** Stable World Major id for a race id (legacy ids normalised), else null. */
function courseKeyFor(marathonId: string | null | undefined): WorldMajorId | null {
  if (!marathonId) return null;
  const id = normalizeMarathonId(marathonId);
  return isWorldMajorId(id) ? id : null;
}

/** Fresh default items (new objects every call; ids unique within the list). */
function buildDefaultItems(): ChecklistItem[] {
  return DEFAULT_TEMPLATES.map((t, i) => ({
    id: `item_${i + 1}`,
    text: t.text,
    checked: false,
    category: t.category,
    isCustom: false,
  }));
}

/** Fresh course items for a race (empty for custom races). */
function buildCourseItems(marathonId: string): ChecklistItem[] {
  const key = courseKeyFor(marathonId);
  if (!key) return [];
  return COURSE_TEMPLATES[key].map((t, i) => ({
    id: `course_${100 + i}`,
    text: t.text,
    checked: false,
    category: t.category,
    isCustom: false,
    isCourse: true,
  }));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new checklist, optionally with course-specific items.
 * Course items are added only for World Majors (matched by stable id).
 */
export function createChecklist(name: string, marathonId?: string): RaceChecklist {
  const now = new Date().toISOString();
  const items = buildDefaultItems();

  if (marathonId) {
    items.push(...buildCourseItems(marathonId));
  }

  const checklist: RaceChecklist = {
    id: newId('checklist'),
    name,
    marathonId,
    items,
    createdAt: now,
    updatedAt: now,
  };

  const all = loadChecklists();
  all.push(checklist);
  saveChecklists(all);
  return checklist;
}

/**
 * The checklist for a race, created on first use. Idempotent: repeated calls
 * return the same list. Legacy ids ('boston-marathon-2026') match their stable
 * id ('boston'). `raceId` null (or '') means the generic list without a race.
 * When several lists match, the most recently updated one wins.
 */
export function getOrCreateChecklistForRace(raceId: string | null, name: string): RaceChecklist {
  const wanted = raceId ? normalizeMarathonId(raceId) : null;
  const matches = loadChecklists().filter((l) =>
    wanted === null ? !l.marathonId : !!l.marathonId && normalizeMarathonId(l.marathonId) === wanted,
  );
  if (matches.length > 0) {
    return matches.reduce((best, l) => (l.updatedAt > best.updatedAt ? l : best));
  }
  return createChecklist(name, wanted ?? undefined);
}

/**
 * Get all saved checklists.
 */
export function getAllChecklists(): RaceChecklist[] {
  return loadChecklists();
}

/**
 * Get a specific checklist by ID.
 */
export function getChecklistById(id: string): RaceChecklist | undefined {
  return loadChecklists().find((c) => c.id === id);
}

/**
 * Toggle a checklist item's checked state.
 */
export function toggleChecklistItem(checklistId: string, itemId: string): boolean {
  return updateList(checklistId, (list) => {
    const item = list.items.find((i) => i.id === itemId);
    if (!item) return { changed: false, result: false };
    item.checked = !item.checked;
    return { changed: true, result: item.checked };
  }, false);
}

/**
 * Add a custom item to a checklist. Empty text is rejected (null).
 */
export function addCustomItem(
  checklistId: string,
  text: string,
  category: ChecklistCategory,
): ChecklistItem | null {
  const trimmed = text.trim();
  if (!trimmed || !isCategory(category)) return null;
  return updateList<ChecklistItem | null>(checklistId, (list) => {
    const item: ChecklistItem = {
      id: newId('custom'),
      text: trimmed,
      checked: false,
      category,
      isCustom: true,
    };
    list.items.push(item);
    return { changed: true, result: item };
  }, null);
}

/**
 * Remove an item from a checklist (only custom items can be removed; hide defaults instead).
 */
export function removeChecklistItem(checklistId: string, itemId: string): boolean {
  return updateList(checklistId, (list) => {
    const idx = list.items.findIndex((i) => i.id === itemId && i.isCustom);
    if (idx < 0) return { changed: false, result: false };
    list.items.splice(idx, 1);
    return { changed: true, result: true };
  }, false);
}

function setHidden(checklistId: string, itemId: string, hidden: boolean): boolean {
  return updateList(checklistId, (list) => {
    const item = list.items.find((i) => i.id === itemId && !i.isCustom);
    if (!item) return { changed: false, result: false };
    if (hidden) item.hidden = true;
    else delete item.hidden;
    return { changed: true, result: true };
  }, false);
}

/**
 * Hide a default (non-custom) item. Hidden items are excluded from progress.
 * Returns false for custom items (remove those instead) or unknown ids.
 */
export function hideChecklistItem(checklistId: string, itemId: string): boolean {
  return setHidden(checklistId, itemId, true);
}

/** Show a previously hidden default item again. */
export function unhideChecklistItem(checklistId: string, itemId: string): boolean {
  return setHidden(checklistId, itemId, false);
}

/**
 * Delete an entire checklist.
 */
export function deleteChecklist(id: string): boolean {
  const all = loadChecklists();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  saveChecklists(all);
  return true;
}

/** Progress of a list (pure). Hidden items count neither as checked nor in the total. */
export function computeChecklistProgress(checklist: Pick<RaceChecklist, 'items'>): ChecklistProgress {
  const visible = checklist.items.filter((i) => !i.hidden);
  const total = visible.length;
  const checked = visible.filter((i) => i.checked).length;
  return { checked, total, pct: total > 0 ? Math.round((checked / total) * 100) : 0 };
}

/**
 * Get completion percentage for a checklist (hidden items excluded).
 */
export function getChecklistProgress(checklistId: string): ChecklistProgress {
  const checklist = getChecklistById(checklistId);
  if (!checklist) return { checked: 0, total: 0, pct: 0 };
  return computeChecklistProgress(checklist);
}

/**
 * Reset all items in a checklist to unchecked (custom and hidden items are kept).
 */
export function resetChecklist(checklistId: string): boolean {
  return updateList(checklistId, (list) => {
    for (const item of list.items) {
      item.checked = false;
    }
    return { changed: true, result: true };
  }, false);
}

/**
 * Get items grouped by category. Hidden items are left out unless
 * `includeHidden` is true.
 */
export function getItemsByCategory(
  checklistId: string,
  opts: { includeHidden?: boolean } = {},
): Record<ChecklistCategory, ChecklistItem[]> {
  const checklist = getChecklistById(checklistId);
  const result: Record<ChecklistCategory, ChecklistItem[]> = {
    gear: [], nutrition: [], logistics: [], morning_of: [], mental: [], post_race: [],
  };
  if (!checklist) return result;

  for (const item of checklist.items) {
    if (item.hidden && !opts.includeHidden) continue;
    result[item.category].push(item);
  }
  return result;
}
