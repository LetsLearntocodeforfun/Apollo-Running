/**
 * Tests for Pre-Race Checklist Service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createChecklist,
  getAllChecklists,
  getChecklistById,
  toggleChecklistItem,
  addCustomItem,
  removeChecklistItem,
  deleteChecklist,
  getChecklistProgress,
  resetChecklist,
  getItemsByCategory,
  CATEGORY_LABELS,
  CHECKLIST_CATEGORIES,
  computeChecklistProgress,
  getOrCreateChecklistForRace,
  hideChecklistItem,
  unhideChecklistItem,
} from '@/services/raceChecklist';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.removeItem('apollo_race_checklists');
});

// ── Checklist Creation ────────────────────────────────────────────────────────

describe('createChecklist', () => {
  it('should create a checklist with default items', () => {
    const list = createChecklist('Boston 2026');
    expect(list.name).toBe('Boston 2026');
    expect(list.items.length).toBeGreaterThan(20);
    expect(list.id).toBeTruthy();
    expect(list.createdAt).toBeTruthy();
  });

  it('should persist the checklist', () => {
    createChecklist('Test');
    const all = getAllChecklists();
    expect(all.length).toBe(1);
  });

  it('should add course-specific items for Boston', () => {
    const list = createChecklist('Boston', 'boston-marathon-2026');
    expect(list.marathonId).toBe('boston-marathon-2026');
    const hopkinton = list.items.find((i) => i.text.toLowerCase().includes('hopkinton'));
    expect(hopkinton).toBeDefined();
  });

  it('should add course-specific items for NYC', () => {
    const list = createChecklist('NYC', 'nyc-marathon-2026');
    const bridge = list.items.find((i) => i.text.toLowerCase().includes('bridge'));
    expect(bridge).toBeDefined();
  });

  it('should add course-specific items for Chicago', () => {
    const list = createChecklist('Chicago', 'chicago-marathon-2026');
    const wind = list.items.find((i) => i.text.toLowerCase().includes('wind'));
    expect(wind).toBeDefined();
  });

  it('should add course-specific items for Berlin', () => {
    const list = createChecklist('Berlin', 'berlin-marathon-2026');
    const flat = list.items.find((i) => i.text.toLowerCase().includes('flat'));
    expect(flat).toBeDefined();
  });

  it('should have items across all categories', () => {
    const list = createChecklist('Test');
    const categories = new Set(list.items.map((i) => i.category));
    expect(categories.size).toBeGreaterThanOrEqual(5);
  });

  it('should start with all items unchecked', () => {
    const list = createChecklist('Test');
    const checked = list.items.filter((i) => i.checked);
    expect(checked.length).toBe(0);
  });
});

// ── Checklist Retrieval ───────────────────────────────────────────────────────

describe('getChecklistById', () => {
  it('should find a checklist by ID', () => {
    const created = createChecklist('Find Me');
    const found = getChecklistById(created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe('Find Me');
  });

  it('should return undefined for unknown ID', () => {
    expect(getChecklistById('nonexistent')).toBeUndefined();
  });
});

// ── Toggle Items ──────────────────────────────────────────────────────────────

describe('toggleChecklistItem', () => {
  it('should toggle item checked state', () => {
    const list = createChecklist('Test');
    const itemId = list.items[0].id;

    const result = toggleChecklistItem(list.id, itemId);
    expect(result).toBe(true);

    const updated = getChecklistById(list.id)!;
    expect(updated.items[0].checked).toBe(true);
  });

  it('should toggle back to unchecked', () => {
    const list = createChecklist('Test');
    const itemId = list.items[0].id;

    toggleChecklistItem(list.id, itemId); // check
    toggleChecklistItem(list.id, itemId); // uncheck

    const updated = getChecklistById(list.id)!;
    expect(updated.items[0].checked).toBe(false);
  });

  it('should return false for invalid checklist', () => {
    expect(toggleChecklistItem('bad', 'bad')).toBe(false);
  });

  it('should return false for invalid item', () => {
    const list = createChecklist('Test');
    expect(toggleChecklistItem(list.id, 'bad_item')).toBe(false);
  });
});

// ── Custom Items ──────────────────────────────────────────────────────────────

describe('addCustomItem', () => {
  it('should add a custom item to a checklist', () => {
    const list = createChecklist('Test');
    const initialCount = list.items.length;

    const item = addCustomItem(list.id, 'Lucky socks', 'gear');
    expect(item).not.toBeNull();
    expect(item!.isCustom).toBe(true);
    expect(item!.text).toBe('Lucky socks');

    const updated = getChecklistById(list.id)!;
    expect(updated.items.length).toBe(initialCount + 1);
  });

  it('should return null for invalid checklist', () => {
    expect(addCustomItem('bad', 'test', 'gear')).toBeNull();
  });
});

describe('removeChecklistItem', () => {
  it('should remove a custom item', () => {
    const list = createChecklist('Test');
    const item = addCustomItem(list.id, 'Custom gear', 'gear')!;

    const removed = removeChecklistItem(list.id, item.id);
    expect(removed).toBe(true);

    const updated = getChecklistById(list.id)!;
    expect(updated.items.find((i) => i.id === item.id)).toBeUndefined();
  });

  it('should not remove non-custom items', () => {
    const list = createChecklist('Test');
    const defaultItem = list.items.find((i) => !i.isCustom)!;

    const removed = removeChecklistItem(list.id, defaultItem.id);
    expect(removed).toBe(false);
  });
});

// ── Progress ──────────────────────────────────────────────────────────────────

describe('getChecklistProgress', () => {
  it('should start at 0%', () => {
    const list = createChecklist('Test');
    const progress = getChecklistProgress(list.id);
    expect(progress.checked).toBe(0);
    expect(progress.pct).toBe(0);
    expect(progress.total).toBe(list.items.length);
  });

  it('should update after checking items', () => {
    const list = createChecklist('Test');
    toggleChecklistItem(list.id, list.items[0].id);
    toggleChecklistItem(list.id, list.items[1].id);

    const progress = getChecklistProgress(list.id);
    expect(progress.checked).toBe(2);
    expect(progress.pct).toBeGreaterThan(0);
  });

  it('should return 0 for invalid checklist', () => {
    const progress = getChecklistProgress('bad');
    expect(progress.pct).toBe(0);
  });
});

// ── Reset ─────────────────────────────────────────────────────────────────────

describe('resetChecklist', () => {
  it('should uncheck all items', () => {
    const list = createChecklist('Test');
    toggleChecklistItem(list.id, list.items[0].id);
    toggleChecklistItem(list.id, list.items[1].id);

    resetChecklist(list.id);

    const progress = getChecklistProgress(list.id);
    expect(progress.checked).toBe(0);
  });

  it('should return false for invalid checklist', () => {
    expect(resetChecklist('bad')).toBe(false);
  });
});

// ── Delete ────────────────────────────────────────────────────────────────────

describe('deleteChecklist', () => {
  it('should remove a checklist', () => {
    const list = createChecklist('Delete Me');
    expect(deleteChecklist(list.id)).toBe(true);
    expect(getChecklistById(list.id)).toBeUndefined();
    expect(getAllChecklists().length).toBe(0);
  });

  it('should return false for nonexistent checklist', () => {
    expect(deleteChecklist('bad')).toBe(false);
  });
});

// ── Items by Category ─────────────────────────────────────────────────────────

describe('getItemsByCategory', () => {
  it('should group items by category', () => {
    const list = createChecklist('Test');
    const grouped = getItemsByCategory(list.id);

    expect(grouped.gear.length).toBeGreaterThan(0);
    expect(grouped.nutrition.length).toBeGreaterThan(0);
    expect(grouped.logistics.length).toBeGreaterThan(0);
    expect(grouped.morning_of.length).toBeGreaterThan(0);
    expect(grouped.mental.length).toBeGreaterThan(0);
    expect(grouped.post_race.length).toBeGreaterThan(0);
  });

  it('should return empty arrays for invalid checklist', () => {
    const grouped = getItemsByCategory('bad');
    expect(grouped.gear.length).toBe(0);
  });
});

// ── Category Labels ───────────────────────────────────────────────────────────

describe('CATEGORY_LABELS', () => {
  it('should have labels for all categories', () => {
    expect(Object.keys(CATEGORY_LABELS).length).toBe(6);
    expect(CATEGORY_LABELS.gear).toBeTruthy();
    expect(CATEGORY_LABELS.nutrition).toBeTruthy();
  });

  it('CHECKLIST_CATEGORIES lists every labelled category once', () => {
    expect([...CHECKLIST_CATEGORIES].sort()).toEqual(Object.keys(CATEGORY_LABELS).sort());
  });
});

// ── v1.0.6 regressions ────────────────────────────────────────────────────────

describe('L-10: every list gets fresh items', () => {
  it('a second list for the same race starts unchecked', () => {
    const first = createChecklist('Boston A', 'boston');
    const courseItem = first.items.find((i) => i.isCourse)!;
    expect(courseItem).toBeDefined();
    toggleChecklistItem(first.id, courseItem.id);
    toggleChecklistItem(first.id, first.items[0].id);

    const second = createChecklist('Boston B', 'boston');
    expect(second.items.every((i) => !i.checked)).toBe(true);
    expect(getChecklistById(first.id)!.items.find((i) => i.id === courseItem.id)!.checked).toBe(true);
  });

  it('mutating a returned list never leaks into a new list', () => {
    const first = createChecklist('Tokyo A', 'tokyo');
    first.items.forEach((i) => { i.checked = true; i.text = 'mutated'; });
    const second = createChecklist('Tokyo B', 'tokyo');
    expect(second.items.some((i) => i.checked || i.text === 'mutated')).toBe(false);
    expect(second.items.every((i, idx) => i !== first.items[idx])).toBe(true);
  });
});

describe('L-11: collision-free ids', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives rapid custom adds unique ids', () => {
    const list = createChecklist('Test');
    const ids = Array.from({ length: 50 }, (_, n) => addCustomItem(list.id, `Item ${n}`, 'gear')!.id);
    expect(new Set(ids).size).toBe(50);
    expect(getChecklistById(list.id)!.items.filter((i) => i.isCustom)).toHaveLength(50);
  });

  it('gives lists created in the same millisecond unique ids', () => {
    const ids = Array.from({ length: 20 }, () => createChecklist('Same ms').id);
    expect(new Set(ids).size).toBe(20);
  });

  it('falls back safely when crypto.randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', undefined);
    const list = createChecklist('No crypto');
    const ids = Array.from({ length: 30 }, (_, n) => addCustomItem(list.id, `Item ${n}`, 'gear')!.id);
    expect(new Set(ids).size).toBe(30);
    expect(list.id).toMatch(/^checklist_/);
  });

  it('rejects empty custom items', () => {
    const list = createChecklist('Test');
    expect(addCustomItem(list.id, '   ', 'gear')).toBeNull();
    expect(addCustomItem(list.id, '  Gels  ', 'nutrition')!.text).toBe('Gels');
  });

  it('gives duplicate legacy item ids a unique suffix on load', () => {
    persistence.setItem('apollo_race_checklists', JSON.stringify([{
      id: 'legacy', name: 'Legacy', createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
      items: [
        { id: 'custom_1', text: 'A', checked: false, category: 'gear', isCustom: true },
        { id: 'custom_1', text: 'B', checked: false, category: 'gear', isCustom: true },
        { id: 'x', text: 'C', checked: false, category: 'not-a-category', isCustom: true },
        null,
      ],
    }]));
    const list = getChecklistById('legacy')!;
    expect(list.items.map((i) => i.id)).toEqual(['custom_1', 'custom_1~2', 'x']);
    expect(list.items[2].category).toBe('logistics');
    toggleChecklistItem('legacy', 'custom_1');
    const after = getChecklistById('legacy')!;
    expect(after.items[0].checked).toBe(true);
    expect(after.items[1].checked).toBe(false);
  });
});

describe('L-12: course items by stable id, race-week only', () => {
  const allText = (marathonId?: string) =>
    createChecklist('Race', marathonId).items.map((i) => i.text).join('\n');

  it('matches legacy and stable ids to the same course items', () => {
    const legacy = createChecklist('Boston', 'boston-marathon-2026').items.filter((i) => i.isCourse);
    const stable = createChecklist('Boston', 'boston').items.filter((i) => i.isCourse);
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.map((i) => i.text)).toEqual(stable.map((i) => i.text));
  });

  it('gives a custom race that only mentions a major no course items', () => {
    const half = createChecklist('Boston Run Half', 'custom-boston-run-half');
    expect(half.items.some((i) => i.isCourse)).toBe(false);
    expect(half.items.some((i) => i.text.includes('Hopkinton'))).toBe(false);
    expect(createChecklist('NYC 10K', 'nyc-10k-2026').items.some((i) => i.isCourse)).toBe(false);
  });

  it('contains no training tasks', () => {
    for (const id of ['tokyo', 'boston', 'london', 'berlin', 'chicago', 'nyc']) {
      const text = allText(id);
      expect(text).not.toMatch(/practice downhill|practice on cobblestones/i);
    }
  });

  it('fixes the doubtful course facts', () => {
    expect(allText('tokyo')).not.toMatch(/humid/i);
    expect(allText('tokyo')).toMatch(/throwaway layer/i);
    expect(allText('london')).not.toMatch(/lucozade/i);
    expect(allText('london')).toMatch(/official race guide/i);
    const nycQueensboro = createChecklist('NYC', 'nyc').items.filter((i) => /queensboro/i.test(i.text));
    expect(nycQueensboro.length).toBeGreaterThan(0);
    expect(nycQueensboro.every((i) => !/wind/i.test(i.text))).toBe(true);
    expect(allText('nyc')).toMatch(/verrazzano/i);
  });

  it('adds the new race-week defaults', () => {
    const text = allText();
    expect(text).toMatch(/porta-potty/i);
    expect(text).toMatch(/caffeine.*practised/i);
    expect(text).toMatch(/time zones/i);
    expect(text).toMatch(/wave\/corral start time/i);
  });

  it('keeps default text unit-neutral', () => {
    expect(allText('chicago')).not.toMatch(/\bmiles?\b|\bmi\b|°F|\bft\b/);
  });
});

describe('L-13: hide/unhide and get-or-create', () => {
  it('excludes hidden items from progress and category lists', () => {
    const list = createChecklist('Test');
    const target = list.items[0];
    toggleChecklistItem(list.id, target.id);
    const before = getChecklistProgress(list.id);
    expect(before.checked).toBe(1);

    expect(hideChecklistItem(list.id, target.id)).toBe(true);
    const hidden = getChecklistProgress(list.id);
    expect(hidden.total).toBe(before.total - 1);
    expect(hidden.checked).toBe(0);
    expect(getItemsByCategory(list.id)[target.category].some((i) => i.id === target.id)).toBe(false);
    expect(getItemsByCategory(list.id, { includeHidden: true })[target.category]
      .some((i) => i.id === target.id)).toBe(true);

    expect(unhideChecklistItem(list.id, target.id)).toBe(true);
    expect(getChecklistProgress(list.id)).toEqual(before);
  });

  it('does not hide custom items or unknown ids', () => {
    const list = createChecklist('Test');
    const custom = addCustomItem(list.id, 'Mine', 'gear')!;
    expect(hideChecklistItem(list.id, custom.id)).toBe(false);
    expect(hideChecklistItem(list.id, 'nope')).toBe(false);
    expect(hideChecklistItem('bad', list.items[0].id)).toBe(false);
  });

  it('only removes custom items', () => {
    const list = createChecklist('Test');
    expect(removeChecklistItem(list.id, list.items[0].id)).toBe(false);
    expect(getChecklistById(list.id)!.items).toHaveLength(list.items.length);
  });

  it('reset keeps hidden flags and custom items', () => {
    const list = createChecklist('Test');
    const custom = addCustomItem(list.id, 'Mine', 'gear')!;
    toggleChecklistItem(list.id, custom.id);
    hideChecklistItem(list.id, list.items[1].id);
    resetChecklist(list.id);
    const after = getChecklistById(list.id)!;
    expect(after.items.find((i) => i.id === custom.id)!.checked).toBe(false);
    expect(after.items.find((i) => i.id === list.items[1].id)!.hidden).toBe(true);
  });

  it('computeChecklistProgress is pure and handles empty lists', () => {
    expect(computeChecklistProgress({ items: [] })).toEqual({ checked: 0, total: 0, pct: 0 });
    expect(computeChecklistProgress({
      items: [
        { id: 'a', text: 'a', checked: true, category: 'gear', isCustom: false },
        { id: 'b', text: 'b', checked: false, category: 'gear', isCustom: false },
        { id: 'c', text: 'c', checked: true, category: 'gear', isCustom: false, hidden: true },
      ],
    })).toEqual({ checked: 1, total: 2, pct: 50 });
  });

  it('getOrCreateChecklistForRace is idempotent', () => {
    const a = getOrCreateChecklistForRace('boston', 'Boston 2027');
    const b = getOrCreateChecklistForRace('boston', 'Boston again');
    expect(b.id).toBe(a.id);
    expect(getAllChecklists()).toHaveLength(1);
    expect(a.marathonId).toBe('boston');
    expect(a.items.some((i) => i.isCourse)).toBe(true);
  });

  it('getOrCreateChecklistForRace finds a list saved under a legacy id', () => {
    const legacy = createChecklist('Boston 2026', 'boston-marathon-2026');
    toggleChecklistItem(legacy.id, legacy.items[0].id);
    const found = getOrCreateChecklistForRace('boston', 'Boston');
    expect(found.id).toBe(legacy.id);
    expect(found.items[0].checked).toBe(true);
    expect(getOrCreateChecklistForRace('boston-marathon-2026', 'Boston').id).toBe(legacy.id);
    expect(getAllChecklists()).toHaveLength(1);
  });

  it('keeps the generic list separate from race lists', () => {
    const race = getOrCreateChecklistForRace('nyc', 'NYC');
    const generic = getOrCreateChecklistForRace(null, 'Race week');
    expect(generic.id).not.toBe(race.id);
    expect(generic.marathonId).toBeUndefined();
    expect(generic.items.some((i) => i.isCourse)).toBe(false);
    expect(getOrCreateChecklistForRace(null, 'Race week').id).toBe(generic.id);
    expect(getOrCreateChecklistForRace('', 'Race week').id).toBe(generic.id);
    expect(getAllChecklists()).toHaveLength(2);
  });
});
