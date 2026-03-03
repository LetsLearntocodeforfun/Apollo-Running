/**
 * Pre-Race Checklist Generator
 *
 * Customizable race day and race week checklists with course-specific
 * templates. Users can add/remove items, check them off, and data
 * persists locally.
 */

import { persistence } from './db/persistence';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
  category: ChecklistCategory;
  isCustom: boolean;
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
  marathonId?: string;
  items: ChecklistItem[];
  createdAt: string;
  updatedAt: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'apollo_race_checklists';

function loadChecklists(): RaceChecklist[] {
  const raw = persistence.getItem(STORAGE_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function saveChecklists(lists: RaceChecklist[]): void {
  persistence.setItem(STORAGE_KEY, JSON.stringify(lists));
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

let nextId = 1;
function makeItem(text: string, category: ChecklistCategory): ChecklistItem {
  return { id: `item_${nextId++}`, text, checked: false, category, isCustom: false };
}

function getDefaultItems(): ChecklistItem[] {
  nextId = 1;
  return [
    // Gear
    makeItem('Race shoes (broken in, not new)', 'gear'),
    makeItem('Race outfit — singlet/shorts/sports bra (nothing new)', 'gear'),
    makeItem('Socks (tested on long runs)', 'gear'),
    makeItem('Race bib + safety pins', 'gear'),
    makeItem('Timing chip (if separate from bib)', 'gear'),
    makeItem('GPS watch — fully charged', 'gear'),
    makeItem('Anti-chafe product (Body Glide / Vaseline)', 'gear'),
    makeItem('Sunglasses (if sunny forecast)', 'gear'),
    makeItem('Hat or visor', 'gear'),
    makeItem('Sunscreen (SPF 30+)', 'gear'),
    makeItem('Throwaway layers for start line', 'gear'),
    makeItem('Race belt or fuel pouch', 'gear'),
    makeItem('Nipple guards / band-aids (if needed)', 'gear'),

    // Nutrition
    makeItem('Gels / chews packed and counted', 'nutrition'),
    makeItem('Pre-race breakfast food ready', 'nutrition'),
    makeItem('Electrolyte drink for morning', 'nutrition'),
    makeItem('Post-race recovery snack', 'nutrition'),
    makeItem('Water bottle for pre-race hydration', 'nutrition'),

    // Logistics
    makeItem('Know the start time and corral assignment', 'logistics'),
    makeItem('Plan transportation to start line', 'logistics'),
    makeItem('Gear check / bag drop plan', 'logistics'),
    makeItem('Phone charged (for tracking / photos)', 'logistics'),
    makeItem('Cash / credit card for emergencies', 'logistics'),
    makeItem('ID (required by some races)', 'logistics'),
    makeItem('Know post-race meeting point', 'logistics'),
    makeItem('Share race tracking with family/friends', 'logistics'),

    // Morning of
    makeItem('Set alarm (3.5-4 hours before start)', 'morning_of'),
    makeItem('Eat pre-race meal (3 hours before)', 'morning_of'),
    makeItem('Begin hydration (sip, don\'t chug)', 'morning_of'),
    makeItem('Apply anti-chafe and sunscreen', 'morning_of'),
    makeItem('Pin race bib to singlet', 'morning_of'),
    makeItem('Last bathroom stop before corral', 'morning_of'),
    makeItem('Dynamic warm-up (5-10 min)', 'morning_of'),

    // Mental
    makeItem('Review race strategy and mile splits', 'mental'),
    makeItem('Set watch to show correct pace data', 'mental'),
    makeItem('Remember: first miles should feel too easy', 'mental'),
    makeItem('Have mantras ready for tough miles (18-22)', 'mental'),
    makeItem('Visualize crossing the finish line', 'mental'),

    // Post-race
    makeItem('Dry clothes in gear check bag', 'post_race'),
    makeItem('Recovery food/drink accessible', 'post_race'),
    makeItem('Compression socks for recovery', 'post_race'),
    makeItem('Foam roller or massage ball', 'post_race'),
    makeItem('Plan a post-race meal / celebration', 'post_race'),
  ];
}

// ── Course-Specific Items ─────────────────────────────────────────────────────

const COURSE_SPECIFIC_ITEMS: Record<string, ChecklistItem[]> = {};

function getCourseItems(marathonId: string): ChecklistItem[] {
  if (COURSE_SPECIFIC_ITEMS[marathonId]) return COURSE_SPECIFIC_ITEMS[marathonId];

  const items: ChecklistItem[] = [];
  let id = 100;
  const make = (text: string, cat: ChecklistCategory): ChecklistItem =>
    ({ id: `course_${id++}`, text, checked: false, category: cat, isCustom: false });

  if (marathonId.includes('boston')) {
    items.push(make('Warm layers for Hopkinton (can be cold at start)', 'gear'));
    items.push(make('Bus to start — arrive early (Athletes\' Village)', 'logistics'));
    items.push(make('Practice downhill running before race', 'mental'));
    items.push(make('Save energy for Newton Hills (miles 16-21)', 'mental'));
    items.push(make('Throwaway clothes (donated to charity)', 'gear'));
  } else if (marathonId.includes('nyc')) {
    items.push(make('Throwaway clothes for Fort Wadsworth (long wait)', 'gear'));
    items.push(make('Ferry / bus to Staten Island start', 'logistics'));
    items.push(make('UTA bag for gear check', 'logistics'));
    items.push(make('Prepare for 5 bridge climbs', 'mental'));
    items.push(make('Headwind on Queensboro Bridge — tuck in and push', 'mental'));
  } else if (marathonId.includes('chicago')) {
    items.push(make('Wind protection — Chicago is windy, especially lakefront', 'gear'));
    items.push(make('Plan for potential heat — October can be warm', 'mental'));
    items.push(make('Draft in groups on exposed Lake Shore sections', 'mental'));
  } else if (marathonId.includes('london')) {
    items.push(make('Rain gear for start (April showers)', 'gear'));
    items.push(make('Practice on cobblestones (Tower Bridge area)', 'mental'));
    items.push(make('Lucozade Sport at aid stations (not water until later)', 'nutrition'));
  } else if (marathonId.includes('berlin')) {
    items.push(make('Flat and fast — pace yourself, don\'t go out too hard', 'mental'));
    items.push(make('Brandenburg Gate finish — save energy for final push', 'mental'));
    items.push(make('German beer at finish — earned!', 'post_race'));
  } else if (marathonId.includes('tokyo')) {
    items.push(make('Humid conditions likely — extra hydration', 'nutrition'));
    items.push(make('Temperature can vary — layers recommended', 'gear'));
    items.push(make('Amazing crowd support — enjoy the energy', 'mental'));
    items.push(make('Food stations have unique Japanese snacks', 'nutrition'));
  }

  COURSE_SPECIFIC_ITEMS[marathonId] = items;
  return items;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a new checklist, optionally with course-specific items.
 */
export function createChecklist(name: string, marathonId?: string): RaceChecklist {
  const now = new Date().toISOString();
  const items = [...getDefaultItems()];

  if (marathonId) {
    items.push(...getCourseItems(marathonId));
  }

  const checklist: RaceChecklist = {
    id: `checklist_${Date.now()}`,
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
  const all = loadChecklists();
  const checklist = all.find((c) => c.id === checklistId);
  if (!checklist) return false;

  const item = checklist.items.find((i) => i.id === itemId);
  if (!item) return false;

  item.checked = !item.checked;
  checklist.updatedAt = new Date().toISOString();
  saveChecklists(all);
  return item.checked;
}

/**
 * Add a custom item to a checklist.
 */
export function addCustomItem(
  checklistId: string,
  text: string,
  category: ChecklistCategory,
): ChecklistItem | null {
  const all = loadChecklists();
  const checklist = all.find((c) => c.id === checklistId);
  if (!checklist) return null;

  const item: ChecklistItem = {
    id: `custom_${Date.now()}`,
    text,
    checked: false,
    category,
    isCustom: true,
  };

  checklist.items.push(item);
  checklist.updatedAt = new Date().toISOString();
  saveChecklists(all);
  return item;
}

/**
 * Remove an item from a checklist (only custom items can be removed).
 */
export function removeChecklistItem(checklistId: string, itemId: string): boolean {
  const all = loadChecklists();
  const checklist = all.find((c) => c.id === checklistId);
  if (!checklist) return false;

  const idx = checklist.items.findIndex((i) => i.id === itemId && i.isCustom);
  if (idx < 0) return false;

  checklist.items.splice(idx, 1);
  checklist.updatedAt = new Date().toISOString();
  saveChecklists(all);
  return true;
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

/**
 * Get completion percentage for a checklist.
 */
export function getChecklistProgress(checklistId: string): { checked: number; total: number; pct: number } {
  const checklist = getChecklistById(checklistId);
  if (!checklist) return { checked: 0, total: 0, pct: 0 };

  const total = checklist.items.length;
  const checked = checklist.items.filter((i) => i.checked).length;
  return { checked, total, pct: total > 0 ? Math.round((checked / total) * 100) : 0 };
}

/**
 * Reset all items in a checklist to unchecked.
 */
export function resetChecklist(checklistId: string): boolean {
  const all = loadChecklists();
  const checklist = all.find((c) => c.id === checklistId);
  if (!checklist) return false;

  for (const item of checklist.items) {
    item.checked = false;
  }
  checklist.updatedAt = new Date().toISOString();
  saveChecklists(all);
  return true;
}

/**
 * Get items grouped by category.
 */
export function getItemsByCategory(checklistId: string): Record<ChecklistCategory, ChecklistItem[]> {
  const checklist = getChecklistById(checklistId);
  const result: Record<ChecklistCategory, ChecklistItem[]> = {
    gear: [], nutrition: [], logistics: [], morning_of: [], mental: [], post_race: [],
  };
  if (!checklist) return result;

  for (const item of checklist.items) {
    result[item.category].push(item);
  }
  return result;
}
