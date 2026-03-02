/**
 * Training Journal service tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getJournalPreferences,
  setJournalPreferences,
  isJournalEnabled,
  enableJournal,
  disableJournal,
  getJournalEntry,
  saveJournalEntry,
  deleteJournalEntry,
  getAllJournalEntries,
  getRecentJournalEntries,
  getJournalEntriesInRange,
  setMood,
  setEnergy,
  setSleep,
  setRPE,
  setSurface,
  setWeather,
  setNotes,
  getJournalTrends,
  getRPETrends,
  discoverCorrelations,
  getJournalEntryCount,
} from '@/services/trainingJournal';
import type { JournalEntry, MoodRating, EnergyRating, RPERating } from '@/types/journal';
import { persistence } from '@/services/db/persistence';

// Clear storage between tests
beforeEach(() => {
  persistence.clear();
});

// ── Preferences ───────────────────────────────────────────────────────────────

describe('Journal Preferences', () => {
  it('returns default preferences when none saved', () => {
    const prefs = getJournalPreferences();
    expect(prefs.enabled).toBe(false);
    expect(prefs.autoPromptRPE).toBe(false);
    expect(prefs.autoFetchWeather).toBe(false);
    expect(prefs.enabledAt).toBeUndefined();
  });

  it('saves and loads preferences', () => {
    setJournalPreferences({ enabled: true, autoPromptRPE: true });
    const prefs = getJournalPreferences();
    expect(prefs.enabled).toBe(true);
    expect(prefs.autoPromptRPE).toBe(true);
    expect(prefs.autoFetchWeather).toBe(false); // default preserved
    expect(prefs.enabledAt).toBeDefined();
  });

  it('sets enabledAt only on first enable', () => {
    setJournalPreferences({ enabled: true });
    const first = getJournalPreferences().enabledAt;
    expect(first).toBeDefined();

    // Update another field — enabledAt should not change
    setJournalPreferences({ autoPromptRPE: true });
    const second = getJournalPreferences().enabledAt;
    expect(second).toBe(first);
  });

  it('enableJournal / disableJournal helpers work', () => {
    expect(isJournalEnabled()).toBe(false);
    enableJournal();
    expect(isJournalEnabled()).toBe(true);
    disableJournal();
    expect(isJournalEnabled()).toBe(false);
  });
});

// ── CRUD Operations ───────────────────────────────────────────────────────────

describe('Journal CRUD', () => {
  beforeEach(() => enableJournal());

  it('returns null when no entry exists', () => {
    expect(getJournalEntry('2025-01-15')).toBeNull();
  });

  it('saves and retrieves a journal entry', () => {
    saveJournalEntry('2025-01-15', { mood: 4, energy: 3, notes: 'Felt good' });
    const entry = getJournalEntry('2025-01-15');
    expect(entry).not.toBeNull();
    expect(entry!.date).toBe('2025-01-15');
    expect(entry!.mood).toBe(4);
    expect(entry!.energy).toBe(3);
    expect(entry!.notes).toBe('Felt good');
    expect(entry!.updatedAt).toBeDefined();
  });

  it('updates existing entries by merging', () => {
    saveJournalEntry('2025-01-15', { mood: 3 });
    saveJournalEntry('2025-01-15', { energy: 4 });
    const entry = getJournalEntry('2025-01-15');
    expect(entry!.mood).toBe(3); // preserved from first save
    expect(entry!.energy).toBe(4); // added in second save
  });

  it('deletes an entry', () => {
    saveJournalEntry('2025-01-15', { mood: 5 });
    deleteJournalEntry('2025-01-15');
    expect(getJournalEntry('2025-01-15')).toBeNull();
  });

  it('getAllJournalEntries returns descending date order', () => {
    saveJournalEntry('2025-01-10', { mood: 3 });
    saveJournalEntry('2025-01-15', { mood: 4 });
    saveJournalEntry('2025-01-12', { mood: 2 });
    const all = getAllJournalEntries();
    expect(all.map((e) => e.date)).toEqual(['2025-01-15', '2025-01-12', '2025-01-10']);
  });

  it('getRecentJournalEntries limits count', () => {
    for (let i = 1; i <= 20; i++) {
      saveJournalEntry(`2025-01-${String(i).padStart(2, '0')}`, { mood: 3 as MoodRating });
    }
    expect(getRecentJournalEntries(5).length).toBe(5);
  });

  it('getJournalEntriesInRange filters by date', () => {
    saveJournalEntry('2025-01-10', { mood: 3 });
    saveJournalEntry('2025-01-15', { mood: 4 });
    saveJournalEntry('2025-01-20', { mood: 5 });
    const range = getJournalEntriesInRange('2025-01-10', '2025-01-15');
    expect(range.length).toBe(2);
    expect(range[0].date).toBe('2025-01-10'); // ascending
    expect(range[1].date).toBe('2025-01-15');
  });

  it('returns empty arrays when journal is disabled', () => {
    saveJournalEntry('2025-01-15', { mood: 4 }); // saved while enabled
    disableJournal();
    expect(getJournalEntry('2025-01-15')).toBeNull();
    expect(getAllJournalEntries()).toEqual([]);
    expect(getJournalEntriesInRange('2025-01-01', '2025-12-31')).toEqual([]);
  });
});

// ── Quick-Set Helpers ─────────────────────────────────────────────────────────

describe('Quick-Set Helpers', () => {
  beforeEach(() => enableJournal());

  it('setMood creates/updates entry', () => {
    const entry = setMood('2025-01-15', 5);
    expect(entry.mood).toBe(5);
    expect(getJournalEntry('2025-01-15')!.mood).toBe(5);
  });

  it('setEnergy creates/updates entry', () => {
    const entry = setEnergy('2025-01-15', 2);
    expect(entry.energy).toBe(2);
  });

  it('setSleep sets quality and hours', () => {
    const entry = setSleep('2025-01-15', 4, 7.5);
    expect(entry.sleepQuality).toBe(4);
    expect(entry.sleepHours).toBe(7.5);
  });

  it('setRPE creates/updates entry', () => {
    const entry = setRPE('2025-01-15', 7);
    expect(entry.rpe).toBe(7);
  });

  it('setSurface creates/updates entry', () => {
    const entry = setSurface('2025-01-15', 'trail');
    expect(entry.surface).toBe('trail');
  });

  it('setWeather creates/updates entry', () => {
    const entry = setWeather('2025-01-15', { tempF: 45, conditions: 'cloudy' });
    expect(entry.weather!.tempF).toBe(45);
    expect(entry.weather!.conditions).toBe('cloudy');
  });

  it('setNotes creates/updates entry', () => {
    const entry = setNotes('2025-01-15', 'Legs felt heavy');
    expect(entry.notes).toBe('Legs felt heavy');
  });
});

// ── Analytics & Trends ────────────────────────────────────────────────────────

describe('Journal Trends', () => {
  beforeEach(() => enableJournal());

  it('getJournalTrends returns chronological data', () => {
    saveJournalEntry('2025-01-10', { mood: 3, rpe: 5 });
    saveJournalEntry('2025-01-12', { mood: 4, rpe: 6 });
    const trends = getJournalTrends(30);
    expect(trends.length).toBe(2);
    expect(trends[0].date).toBe('2025-01-10'); // chronological
    expect(trends[1].date).toBe('2025-01-12');
    expect(trends[0].mood).toBe(3);
    expect(trends[1].rpe).toBe(6);
  });

  it('getRPETrends filters to RPE-only entries', () => {
    saveJournalEntry('2025-01-10', { mood: 3 }); // no RPE
    saveJournalEntry('2025-01-12', { rpe: 6 });
    saveJournalEntry('2025-01-14', { rpe: 7, mood: 4 });
    const rpeData = getRPETrends();
    expect(rpeData.length).toBe(2);
    expect(rpeData[0].rpe).toBe(6);
    expect(rpeData[1].rpe).toBe(7);
  });

  it('returns empty trends when journal disabled', () => {
    saveJournalEntry('2025-01-10', { mood: 3, rpe: 5 });
    disableJournal();
    expect(getJournalTrends()).toEqual([]);
    expect(getRPETrends()).toEqual([]);
  });
});

// ── Correlation Analysis ──────────────────────────────────────────────────────

describe('Correlation Analysis', () => {
  function makeEntries(count: number, overrides?: Partial<JournalEntry>[]): JournalEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      date: `2025-01-${String(i + 1).padStart(2, '0')}`,
      updatedAt: new Date().toISOString(),
      mood: 3 as MoodRating,
      energy: 3 as EnergyRating,
      sleepHours: 7,
      rpe: 5 as RPERating,
      ...overrides?.[i],
    }));
  }

  it('returns no insights with fewer than 7 entries', () => {
    const entries = makeEntries(5);
    expect(discoverCorrelations(entries)).toEqual([]);
  });

  it('detects sleep-performance correlation', () => {
    // 5 good sleep days + 5 poor sleep days
    const entries = makeEntries(10, [
      { sleepHours: 8 }, { sleepHours: 7.5 }, { sleepHours: 7 },
      { sleepHours: 8 }, { sleepHours: 7 },
      { sleepHours: 5 }, { sleepHours: 5.5 }, { sleepHours: 6 },
      { sleepHours: 5 }, { sleepHours: 6 },
    ]);
    const perfData = entries.map((e, i) => ({
      date: e.date,
      metPlan: i < 5, // good sleep days met plan, poor sleep days did not
      paceMinPerMi: 8.5,
    }));
    const insights = discoverCorrelations(entries, perfData);
    const sleepInsight = insights.find((i) => i.type === 'sleep_performance');
    expect(sleepInsight).toBeDefined();
    expect(sleepInsight!.message).toContain('7h');
  });

  it('detects energy-performance correlation', () => {
    const entries = makeEntries(10, [
      { energy: 5 as EnergyRating }, { energy: 4 as EnergyRating }, { energy: 5 as EnergyRating },
      { energy: 4 as EnergyRating }, { energy: 5 as EnergyRating },
      { energy: 1 as EnergyRating }, { energy: 2 as EnergyRating }, { energy: 1 as EnergyRating },
      { energy: 2 as EnergyRating }, { energy: 1 as EnergyRating },
    ]);
    const perfData = entries.map((e, i) => ({
      date: e.date,
      metPlan: i < 5,
      paceMinPerMi: 8.5,
    }));
    const insights = discoverCorrelations(entries, perfData);
    const energyInsight = insights.find((i) => i.type === 'energy_performance');
    expect(energyInsight).toBeDefined();
    expect(energyInsight!.message).toContain('energy');
  });

  it('detects positive mood streak', () => {
    const entries = makeEntries(7, Array.from({ length: 7 }, () => ({ mood: 5 as MoodRating })));
    const insights = discoverCorrelations(entries);
    const moodInsight = insights.find((i) => i.type === 'mood_streak');
    expect(moodInsight).toBeDefined();
    expect(moodInsight!.message).toContain('great headspace');
  });

  it('detects negative mood streak', () => {
    const entries = makeEntries(7, Array.from({ length: 7 }, () => ({ mood: 1 as MoodRating })));
    const insights = discoverCorrelations(entries);
    const moodInsight = insights.find((i) => i.type === 'mood_streak');
    expect(moodInsight).toBeDefined();
    expect(moodInsight!.message).toContain('low');
  });
});

// ── Entry Count ───────────────────────────────────────────────────────────────

describe('Entry Count', () => {
  it('tracks entry count', () => {
    enableJournal();
    expect(getJournalEntryCount()).toBe(0);
    saveJournalEntry('2025-01-10', { mood: 3 });
    saveJournalEntry('2025-01-11', { mood: 4 });
    expect(getJournalEntryCount()).toBe(2);
  });
});
