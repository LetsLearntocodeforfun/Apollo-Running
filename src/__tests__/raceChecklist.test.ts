/**
 * Tests for Pre-Race Checklist Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
});
