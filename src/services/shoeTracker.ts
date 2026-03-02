/**
 * Shoe Tracker — manage shoe rotation, mileage accumulation,
 * degradation curves, and race-day retirement alerts.
 *
 * Shoes auto-accumulate mileage from synced activities.
 * Default shoe is assigned unless the user tags an activity to a specific shoe.
 */

import type {
  Shoe,
  ShoeActivity,
  ShoeDegradation,
  ShoeCategory,
} from '../types/shoes';
import { DEFAULT_MAX_MILEAGE } from '../types/shoes';
import { persistence } from './db/persistence';

const SHOES_KEY = 'apollo_shoes';
const SHOE_ACTIVITIES_KEY = 'apollo_shoe_activities';

// ── Shoe Store ────────────────────────────────────────────────────────────────

function getShoeStore(): Shoe[] {
  try {
    const raw = persistence.getItem(SHOES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveShoeStore(shoes: Shoe[]): void {
  persistence.setItem(SHOES_KEY, JSON.stringify(shoes));
}

function getActivityStore(): ShoeActivity[] {
  try {
    const raw = persistence.getItem(SHOE_ACTIVITIES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveActivityStore(activities: ShoeActivity[]): void {
  persistence.setItem(SHOE_ACTIVITIES_KEY, JSON.stringify(activities));
}

// ── Shoe CRUD ─────────────────────────────────────────────────────────────────

/** Generate a short unique ID */
function generateId(): string {
  return `shoe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Add a new shoe */
export function addShoe(shoe: {
  name: string;
  brand: string;
  model: string;
  category: ShoeCategory;
  purchaseDate: string;
  maxMileage?: number;
  isDefault?: boolean;
  notes?: string;
}): Shoe {
  const shoes = getShoeStore();
  const now = new Date().toISOString();

  const newShoe: Shoe = {
    id: generateId(),
    name: shoe.name,
    brand: shoe.brand,
    model: shoe.model,
    category: shoe.category,
    status: 'active',
    purchaseDate: shoe.purchaseDate,
    maxMileage: shoe.maxMileage ?? DEFAULT_MAX_MILEAGE[shoe.category],
    currentMileage: 0,
    isDefault: shoe.isDefault ?? false,
    notes: shoe.notes,
    createdAt: now,
    updatedAt: now,
  };

  // If this is the default, clear other defaults
  if (newShoe.isDefault) {
    for (const s of shoes) {
      s.isDefault = false;
    }
  }

  // Auto-set as default if it's the only active shoe
  if (shoes.filter((s) => s.status === 'active').length === 0) {
    newShoe.isDefault = true;
  }

  shoes.push(newShoe);
  saveShoeStore(shoes);
  return newShoe;
}

/** Update an existing shoe's editable fields */
export function updateShoe(
  id: string,
  updates: Partial<Pick<Shoe, 'name' | 'brand' | 'model' | 'category' | 'maxMileage' | 'isDefault' | 'notes'>>,
): Shoe | null {
  const shoes = getShoeStore();
  const idx = shoes.findIndex((s) => s.id === id);
  if (idx === -1) return null;

  if (updates.isDefault) {
    for (const s of shoes) {
      s.isDefault = false;
    }
  }

  shoes[idx] = {
    ...shoes[idx],
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  saveShoeStore(shoes);
  return shoes[idx];
}

/** Retire a shoe */
export function retireShoe(id: string): Shoe | null {
  const shoes = getShoeStore();
  const shoe = shoes.find((s) => s.id === id);
  if (!shoe) return null;

  shoe.status = 'retired';
  shoe.retiredAt = new Date().toISOString();
  shoe.updatedAt = shoe.retiredAt;

  // If retired shoe was default, pick next active shoe
  if (shoe.isDefault) {
    shoe.isDefault = false;
    const nextActive = shoes.find((s) => s.status === 'active' && s.id !== id);
    if (nextActive) nextActive.isDefault = true;
  }

  saveShoeStore(shoes);
  return shoe;
}

/** Re-activate a previously retired shoe */
export function reactivateShoe(id: string): Shoe | null {
  const shoes = getShoeStore();
  const shoe = shoes.find((s) => s.id === id);
  if (!shoe) return null;

  shoe.status = 'active';
  shoe.retiredAt = undefined;
  shoe.updatedAt = new Date().toISOString();
  saveShoeStore(shoes);
  return shoe;
}

/** Delete a shoe entirely */
export function deleteShoe(id: string): boolean {
  const shoes = getShoeStore();
  const filtered = shoes.filter((s) => s.id !== id);
  if (filtered.length === shoes.length) return false;
  saveShoeStore(filtered);

  // Also remove activity assignments
  const activities = getActivityStore().filter((a) => a.shoeId !== id);
  saveActivityStore(activities);
  return true;
}

// ── Shoe Queries ──────────────────────────────────────────────────────────────

/** Get all shoes */
export function getShoes(): Shoe[] {
  return getShoeStore();
}

/** Get active shoes only */
export function getActiveShoes(): Shoe[] {
  return getShoeStore().filter((s) => s.status === 'active');
}

/** Get retired shoes */
export function getRetiredShoes(): Shoe[] {
  return getShoeStore().filter((s) => s.status === 'retired');
}

/** Get the default shoe */
export function getDefaultShoe(): Shoe | null {
  return getShoeStore().find((s) => s.isDefault && s.status === 'active') ?? null;
}

/** Get a shoe by ID */
export function getShoeById(id: string): Shoe | null {
  return getShoeStore().find((s) => s.id === id) ?? null;
}

// ── Activity Assignment & Mileage ─────────────────────────────────────────────

/**
 * Assign a shoe to an activity and accumulate mileage.
 * If no shoeId is provided, the default shoe is used.
 * Returns the updated shoe or null if no shoe could be assigned.
 */
export function assignShoeToActivity(
  activityKey: string,
  distanceMi: number,
  date: string,
  shoeId?: string,
): Shoe | null {
  const activities = getActivityStore();

  // Check if already assigned
  const existing = activities.find((a) => a.activityKey === activityKey);
  if (existing) return getShoeById(existing.shoeId);

  const targetId = shoeId ?? getDefaultShoe()?.id;
  if (!targetId) return null;

  // Record the assignment
  activities.push({ activityKey, shoeId: targetId, distanceMi, date });
  saveActivityStore(activities);

  // Accumulate mileage on the shoe
  const shoes = getShoeStore();
  const shoe = shoes.find((s) => s.id === targetId);
  if (!shoe) return null;

  shoe.currentMileage = Math.round((shoe.currentMileage + distanceMi) * 100) / 100;
  shoe.updatedAt = new Date().toISOString();
  saveShoeStore(shoes);

  return shoe;
}

/** Get activities for a specific shoe */
export function getShoeActivities(shoeId: string): ShoeActivity[] {
  return getActivityStore()
    .filter((a) => a.shoeId === shoeId)
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Get which shoe was used for an activity */
export function getActivityShoe(activityKey: string): Shoe | null {
  const activity = getActivityStore().find((a) => a.activityKey === activityKey);
  if (!activity) return null;
  return getShoeById(activity.shoeId);
}

// ── Degradation & Alerts ──────────────────────────────────────────────────────

/**
 * Calculate degradation status for a shoe.
 * @param shoeId The shoe to analyze
 * @param raceDate Optional race date (YYYY-MM-DD) for projection alerts
 */
export function calculateDegradation(shoeId: string, raceDate?: string): ShoeDegradation | null {
  const shoe = getShoeById(shoeId);
  if (!shoe) return null;

  const usagePct = Math.round((shoe.currentMileage / shoe.maxMileage) * 100);
  const remainingMiles = Math.max(0, shoe.maxMileage - shoe.currentMileage);

  // Estimate weekly mileage from recent 4 weeks of activity
  const activities = getShoeActivities(shoeId);
  const fourWeeksAgo = new Date();
  fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
  const fourWeeksStr = fourWeeksAgo.toISOString().slice(0, 10);

  const recentMiles = activities
    .filter((a) => a.date >= fourWeeksStr)
    .reduce((sum, a) => sum + a.distanceMi, 0);
  const milesPerWeek = Math.round((recentMiles / 4) * 10) / 10;

  // Project weeks until retirement
  const weeksUntilRetirement =
    milesPerWeek > 0 ? Math.round((remainingMiles / milesPerWeek) * 10) / 10 : null;

  // Check if shoe will exceed limit before race day
  let exceedsBeforeRace = false;
  if (raceDate && milesPerWeek > 0) {
    const now = new Date();
    const race = new Date(raceDate + 'T00:00:00');
    const weeksToRace = Math.max(0, (race.getTime() - now.getTime()) / (7 * 24 * 60 * 60 * 1000));
    const projectedMiles = shoe.currentMileage + milesPerWeek * weeksToRace;
    exceedsBeforeRace = projectedMiles > shoe.maxMileage;
  }

  // Determine urgency
  let urgency: ShoeDegradation['urgency'] = 'ok';
  if (shoe.status === 'retired') {
    urgency = 'retired';
  } else if (usagePct >= 100) {
    urgency = 'critical';
  } else if (usagePct >= 80 || exceedsBeforeRace) {
    urgency = 'warning';
  }

  // Build status message
  const statusMessage = buildStatusMessage(shoe, usagePct, remainingMiles, exceedsBeforeRace, raceDate);

  return {
    shoeId,
    usagePct,
    remainingMiles,
    milesPerWeek,
    weeksUntilRetirement,
    exceedsBeforeRace,
    statusMessage,
    urgency,
  };
}

function buildStatusMessage(
  shoe: Shoe,
  usagePct: number,
  remainingMiles: number,
  exceedsBeforeRace: boolean,
  raceDate?: string,
): string {
  if (shoe.status === 'retired') {
    return `${shoe.name} is retired at ${shoe.currentMileage.toFixed(0)}/${shoe.maxMileage} mi.`;
  }
  if (usagePct >= 100) {
    return `${shoe.name} has exceeded its ${shoe.maxMileage} mi limit (${shoe.currentMileage.toFixed(0)} mi). Time to retire.`;
  }
  if (exceedsBeforeRace && raceDate) {
    return `${shoe.name} — ${shoe.currentMileage.toFixed(0)}/${shoe.maxMileage} mi (${shoe.category}). At current pace, will exceed limit before race day (${raceDate}). Consider replacing.`;
  }
  if (usagePct >= 80) {
    return `${shoe.name} — ${shoe.currentMileage.toFixed(0)}/${shoe.maxMileage} mi (${usagePct}%). Approaching retirement.`;
  }
  return `${shoe.name} — ${shoe.currentMileage.toFixed(0)}/${shoe.maxMileage} mi (${usagePct}%). ${remainingMiles.toFixed(0)} mi remaining.`;
}

/**
 * Check all active shoes for retirement alerts.
 * Returns shoes that need attention (≥80% used or will exceed before race day).
 */
export function checkRetirementAlerts(raceDate?: string): ShoeDegradation[] {
  return getActiveShoes()
    .map((s) => calculateDegradation(s.id, raceDate))
    .filter((d): d is ShoeDegradation => d !== null && (d.urgency === 'warning' || d.urgency === 'critical'));
}

/** Get a summary of all active shoes' statuses */
export function getShoesSummary(raceDate?: string): ShoeDegradation[] {
  return getShoes()
    .map((s) => calculateDegradation(s.id, raceDate))
    .filter((d): d is ShoeDegradation => d !== null);
}
