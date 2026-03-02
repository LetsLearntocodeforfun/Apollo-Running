/**
 * Training Journal — entirely opt-in subjective tracking system.
 *
 * Disabled by default. When enabled, allows per-day journal entries
 * with mood, energy, sleep, RPE, surface type, and free-text notes.
 * Provides correlation analysis between subjective data and performance.
 *
 * Zero UI surfaces unless the user explicitly enables this feature.
 */

import type {
  JournalEntry,
  JournalPreferences,
  MoodRating,
  EnergyRating,
  SleepQualityRating,
  RPERating,
  SurfaceType,
  WeatherEntry,
} from '../types/journal';
import { persistence } from './db/persistence';

const JOURNAL_KEY = 'apollo_training_journal';
const JOURNAL_PREFS_KEY = 'apollo_journal_prefs';

const DEFAULT_PREFS: JournalPreferences = {
  enabled: false,
  autoPromptRPE: false,
  autoFetchWeather: false,
};

// ── Preferences ───────────────────────────────────────────────────────────────

export function getJournalPreferences(): JournalPreferences {
  try {
    const raw = persistence.getItem(JOURNAL_PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function setJournalPreferences(prefs: Partial<JournalPreferences>): void {
  const current = getJournalPreferences();
  const updated = { ...current, ...prefs };
  if (updated.enabled && !current.enabled) {
    updated.enabledAt = new Date().toISOString();
  }
  persistence.setItem(JOURNAL_PREFS_KEY, JSON.stringify(updated));
}

export function isJournalEnabled(): boolean {
  return getJournalPreferences().enabled;
}

export function enableJournal(): void {
  setJournalPreferences({ enabled: true });
}

export function disableJournal(): void {
  setJournalPreferences({ enabled: false });
}

// ── Journal Store ─────────────────────────────────────────────────────────────

function getJournalStore(): Record<string, JournalEntry> {
  try {
    const raw = persistence.getItem(JOURNAL_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveJournalStore(store: Record<string, JournalEntry>): void {
  // Keep last 730 days (2 years)
  const keys = Object.keys(store).sort();
  if (keys.length > 730) {
    for (const old of keys.slice(0, keys.length - 730)) {
      delete store[old];
    }
  }
  persistence.setItem(JOURNAL_KEY, JSON.stringify(store));
}

// ── CRUD Operations ───────────────────────────────────────────────────────────

/** Get a journal entry for a specific date */
export function getJournalEntry(date: string): JournalEntry | null {
  if (!isJournalEnabled()) return null;
  return getJournalStore()[date] ?? null;
}

/** Save or update a journal entry for a date */
export function saveJournalEntry(date: string, entry: Partial<JournalEntry>): JournalEntry {
  const store = getJournalStore();
  const existing = store[date];
  const updated: JournalEntry = {
    ...existing,
    ...entry,
    date,
    updatedAt: new Date().toISOString(),
  };
  store[date] = updated;
  saveJournalStore(store);
  return updated;
}

/** Delete a journal entry */
export function deleteJournalEntry(date: string): void {
  const store = getJournalStore();
  delete store[date];
  saveJournalStore(store);
}

/** Get all journal entries sorted by date descending */
export function getAllJournalEntries(): JournalEntry[] {
  if (!isJournalEnabled()) return [];
  return Object.values(getJournalStore())
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Get recent journal entries */
export function getRecentJournalEntries(count: number = 14): JournalEntry[] {
  return getAllJournalEntries().slice(0, count);
}

/** Get entries in a date range (inclusive) */
export function getJournalEntriesInRange(startDate: string, endDate: string): JournalEntry[] {
  if (!isJournalEnabled()) return [];
  return Object.values(getJournalStore())
    .filter((e) => e.date >= startDate && e.date <= endDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Quick-Set Helpers ─────────────────────────────────────────────────────────

/** Set mood for a date */
export function setMood(date: string, mood: MoodRating): JournalEntry {
  return saveJournalEntry(date, { mood });
}

/** Set energy level for a date */
export function setEnergy(date: string, energy: EnergyRating): JournalEntry {
  return saveJournalEntry(date, { energy });
}

/** Set sleep data for a date */
export function setSleep(date: string, quality: SleepQualityRating, hours?: number): JournalEntry {
  return saveJournalEntry(date, { sleepQuality: quality, sleepHours: hours });
}

/** Set RPE for a date */
export function setRPE(date: string, rpe: RPERating): JournalEntry {
  return saveJournalEntry(date, { rpe });
}

/** Set surface type for a date */
export function setSurface(date: string, surface: SurfaceType): JournalEntry {
  return saveJournalEntry(date, { surface });
}

/** Set weather for a date */
export function setWeather(date: string, weather: WeatherEntry): JournalEntry {
  return saveJournalEntry(date, { weather });
}

/** Set notes for a date */
export function setNotes(date: string, notes: string): JournalEntry {
  return saveJournalEntry(date, { notes });
}

// ── Analytics & Correlations ──────────────────────────────────────────────────

export interface JournalTrend {
  date: string;
  mood?: number;
  energy?: number;
  sleepQuality?: number;
  sleepHours?: number;
  rpe?: number;
}

/** Get mood/energy/sleep/RPE trends for charting */
export function getJournalTrends(days: number = 30): JournalTrend[] {
  if (!isJournalEnabled()) return [];
  const entries = getAllJournalEntries().slice(0, days).reverse(); // chronological
  return entries.map((e) => ({
    date: e.date,
    mood: e.mood,
    energy: e.energy,
    sleepQuality: e.sleepQuality,
    sleepHours: e.sleepHours,
    rpe: e.rpe,
  }));
}

export interface RPETrend {
  date: string;
  rpe: number;
}

/** Get RPE-only trend data for charting */
export function getRPETrends(days: number = 60): RPETrend[] {
  if (!isJournalEnabled()) return [];
  return getAllJournalEntries()
    .filter((e) => e.rpe !== undefined)
    .slice(0, days)
    .reverse()
    .map((e) => ({ date: e.date, rpe: e.rpe! }));
}

export interface CorrelationInsight {
  type: 'sleep_performance' | 'energy_performance' | 'mood_streak' | 'rpe_hr_disconnect';
  message: string;
  confidence: number; // 0-100
}

/**
 * Discover correlations between subjective data and performance.
 * Requires at least 7 entries for meaningful analysis.
 */
export function discoverCorrelations(
  entries: JournalEntry[],
  performanceData?: { date: string; metPlan: boolean; paceMinPerMi: number }[],
): CorrelationInsight[] {
  const insights: CorrelationInsight[] = [];
  if (entries.length < 7) return insights;

  // Sleep → Performance correlation
  if (performanceData && performanceData.length >= 7) {
    const withSleep = entries.filter((e) => e.sleepHours !== undefined);
    if (withSleep.length >= 7) {
      const goodSleepDates = new Set(withSleep.filter((e) => e.sleepHours! >= 7).map((e) => e.date));
      const poorSleepDates = new Set(withSleep.filter((e) => e.sleepHours! < 6.5).map((e) => e.date));

      const goodSleepHits = performanceData.filter((p) => goodSleepDates.has(p.date) && p.metPlan).length;
      const goodSleepTotal = performanceData.filter((p) => goodSleepDates.has(p.date)).length;
      const poorSleepHits = performanceData.filter((p) => poorSleepDates.has(p.date) && p.metPlan).length;
      const poorSleepTotal = performanceData.filter((p) => poorSleepDates.has(p.date)).length;

      if (goodSleepTotal >= 3 && poorSleepTotal >= 3) {
        const goodRate = goodSleepHits / goodSleepTotal;
        const poorRate = poorSleepHits / poorSleepTotal;
        if (goodRate > poorRate + 0.15) {
          insights.push({
            type: 'sleep_performance',
            message: `Your best runs happen when sleep ≥ 7h (${Math.round(goodRate * 100)}% hit targets vs ${Math.round(poorRate * 100)}% with <6.5h).`,
            confidence: Math.min(85, 50 + goodSleepTotal * 3),
          });
        }
      }
    }
  }

  // Energy → Performance correlation
  if (performanceData && performanceData.length >= 7) {
    const withEnergy = entries.filter((e) => e.energy !== undefined);
    if (withEnergy.length >= 7) {
      const highEnergyDates = new Set(withEnergy.filter((e) => e.energy! >= 4).map((e) => e.date));
      const lowEnergyDates = new Set(withEnergy.filter((e) => e.energy! <= 2).map((e) => e.date));

      const highHits = performanceData.filter((p) => highEnergyDates.has(p.date) && p.metPlan).length;
      const highTotal = performanceData.filter((p) => highEnergyDates.has(p.date)).length;
      const lowHits = performanceData.filter((p) => lowEnergyDates.has(p.date) && p.metPlan).length;
      const lowTotal = performanceData.filter((p) => lowEnergyDates.has(p.date)).length;

      if (highTotal >= 3 && lowTotal >= 2) {
        const hiRate = highHits / highTotal;
        const loRate = lowHits / lowTotal;
        if (hiRate > loRate + 0.2) {
          insights.push({
            type: 'energy_performance',
            message: `When energy ≥ 4, you hit ${Math.round(hiRate * 100)}% of workout targets. On low-energy days, just ${Math.round(loRate * 100)}%.`,
            confidence: Math.min(80, 45 + highTotal * 3),
          });
        }
      }
    }
  }

  // Mood streak detection
  const withMood = entries.filter((e) => e.mood !== undefined).sort((a, b) => a.date.localeCompare(b.date));
  if (withMood.length >= 5) {
    const recentMoods = withMood.slice(-7);
    const avgMood = recentMoods.reduce((s, e) => s + e.mood!, 0) / recentMoods.length;
    if (avgMood >= 4) {
      insights.push({
        type: 'mood_streak',
        message: `Your mood has averaged ${avgMood.toFixed(1)}/5 over the last ${recentMoods.length} entries — you're in a great headspace for training.`,
        confidence: 70,
      });
    } else if (avgMood <= 2.5) {
      insights.push({
        type: 'mood_streak',
        message: `Your mood has been low (avg ${avgMood.toFixed(1)}/5) recently. Consider an easy week or rest day to reset mentally.`,
        confidence: 65,
      });
    }
  }

  return insights;
}

/** Get journal entry count (for analytics/display) */
export function getJournalEntryCount(): number {
  return Object.keys(getJournalStore()).length;
}
