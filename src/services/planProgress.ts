/**
 * Persist which plan is active, start date, and day-by-day completion.
 */

const ACTIVE_PLAN_KEY = 'apollo_active_plan';
const COMPLETED_DAYS_KEY = 'apollo_completed_days';
const WELCOME_COMPLETED_KEY = 'apollo_welcome_completed';

export interface ActivePlan {
  planId: string;
  startDate: string; // YYYY-MM-DD
  raceDate?: string; // YYYY-MM-DD, optional
}

export function getActivePlan(): ActivePlan | null {
  try {
    const raw = localStorage.getItem(ACTIVE_PLAN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setActivePlan(plan: ActivePlan | null): void {
  if (plan) localStorage.setItem(ACTIVE_PLAN_KEY, JSON.stringify(plan));
  else localStorage.removeItem(ACTIVE_PLAN_KEY);
}

/** Completed set is stored as "planId:weekIndex:dayIndex" for the active plan. */
function getCompletedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(COMPLETED_DAYS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveCompletedSet(set: Set<string>): void {
  localStorage.setItem(COMPLETED_DAYS_KEY, JSON.stringify([...set]));
}

function key(planId: string, weekIndex: number, dayIndex: number): string {
  return `${planId}:${weekIndex}:${dayIndex}`;
}

export function isDayCompleted(planId: string, weekIndex: number, dayIndex: number): boolean {
  return getCompletedSet().has(key(planId, weekIndex, dayIndex));
}

export function setDayCompleted(planId: string, weekIndex: number, dayIndex: number, completed: boolean): void {
  const set = getCompletedSet();
  const k = key(planId, weekIndex, dayIndex);
  if (completed) set.add(k);
  else set.delete(k);
  saveCompletedSet(set);
}

export function toggleDayCompleted(planId: string, weekIndex: number, dayIndex: number): boolean {
  const next = !isDayCompleted(planId, weekIndex, dayIndex);
  setDayCompleted(planId, weekIndex, dayIndex, next);
  return next;
}

/** Count completed days for a plan (only keys matching planId). */
export function getCompletedCount(planId: string): number {
  const set = getCompletedSet();
  let n = 0;
  set.forEach((k) => {
    if (k.startsWith(planId + ':')) n++;
  });
  return n;
}

/** Date for a given week/day (0-based) from plan start. */
export function getDateForDay(startDate: string, weekIndex: number, dayIndex: number): Date {
  const start = new Date(startDate + 'T00:00:00');
  const daysOffset = weekIndex * 7 + dayIndex;
  const d = new Date(start);
  d.setDate(d.getDate() + daysOffset);
  return d;
}

/** Week and day index (0-based) for a given date, or null if before start or after plan end. */
export function getWeekDayForDate(
  startDate: string,
  totalWeeks: number,
  date: Date
): { weekIndex: number; dayIndex: number } | null {
  const start = new Date(startDate + 'T00:00:00');
  start.setHours(0, 0, 0, 0);
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const diffMs = d.getTime() - start.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays < 0) return null;
  const totalDays = totalWeeks * 7;
  if (diffDays >= totalDays) return null;
  const weekIndex = Math.floor(diffDays / 7);
  const dayIndex = diffDays % 7;
  return { weekIndex, dayIndex };
}

export function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** First-boot welcome: has the user completed the "pick a plan?" flow (yes or no). */
export function getWelcomeCompleted(): boolean {
  return localStorage.getItem(WELCOME_COMPLETED_KEY) === 'true';
}

export function setWelcomeCompleted(completed: boolean): void {
  if (completed) localStorage.setItem(WELCOME_COMPLETED_KEY, 'true');
  else localStorage.removeItem(WELCOME_COMPLETED_KEY);
}

/** ── Auto-Sync Metadata ── */

const SYNC_META_KEY = 'apollo_sync_meta';
const LAST_SYNC_KEY = 'apollo_last_sync';

export interface SyncMeta {
  stravaActivityId: number;
  actualDistanceMi: number;
  actualPaceMinPerMi: number;
  movingTimeSec: number;
  feedback: string;
  syncedAt: string; // ISO timestamp
}

function getSyncMetaMap(): Record<string, SyncMeta> {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSyncMetaMap(map: Record<string, SyncMeta>): void {
  localStorage.setItem(SYNC_META_KEY, JSON.stringify(map));
}

export function getSyncMeta(planId: string, weekIndex: number, dayIndex: number): SyncMeta | null {
  return getSyncMetaMap()[key(planId, weekIndex, dayIndex)] ?? null;
}

export function setSyncMeta(planId: string, weekIndex: number, dayIndex: number, meta: SyncMeta): void {
  const map = getSyncMetaMap();
  map[key(planId, weekIndex, dayIndex)] = meta;
  saveSyncMetaMap(map);
}

export function getAllSyncMeta(planId: string): { weekIndex: number; dayIndex: number; meta: SyncMeta }[] {
  const map = getSyncMetaMap();
  const results: { weekIndex: number; dayIndex: number; meta: SyncMeta }[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (k.startsWith(planId + ':')) {
      const parts = k.split(':');
      results.push({ weekIndex: Number(parts[1]), dayIndex: Number(parts[2]), meta: v });
    }
  }
  return results;
}

export function getLastSyncTime(): string | null {
  return localStorage.getItem(LAST_SYNC_KEY);
}

export function setLastSyncTime(iso: string): void {
  localStorage.setItem(LAST_SYNC_KEY, iso);
}
