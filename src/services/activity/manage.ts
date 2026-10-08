/**
 * Hide, unhide, delete and merge activities on this device (v1.0.6, B18).
 *
 *  - Hide: the record stays in the store (so syncs merge into it instead of
 *    re-adding it) but analytics, PRs, load and plan matching ignore it.
 *  - Delete: the record is removed and tombstoned, so neither a re-sync nor a
 *    file re-import brings it back (see tombstones.ts).
 *  - Merge duplicates: hides the lesser copy and remembers which record it
 *    was merged into. "Keep both" is remembered so the pair isn't offered again.
 *
 * Every mutation notifies `onActivitiesUpdated` listeners (pages refresh) and
 * `onActivityStoreChanged` subscribers.
 */

import {
  getAllStoredActivities,
  writeActivityStore,
} from '../analyticsService';
import { notifyActivitiesUpdated } from '../activitySource';
import { persistence } from '../db/persistence';
import { addTombstones } from './tombstones';
import { duplicatePairKey, findDuplicateCandidates, type DuplicateCandidate } from './dedupe';
import type { Activity } from './types';

/** Window event fired after a hide / unhide / delete / merge. */
export const ACTIVITY_STORE_CHANGED_EVENT = 'apollo:activity-store-changed';

/** "Keep both" decisions: `${lowId}-${highId}` pair keys. */
export const DUPLICATE_DECISIONS_KEY = 'apollo_duplicate_decisions';

export type ActivityChangeKind = 'hide' | 'unhide' | 'delete' | 'merge';

/** Result of a management action. */
export interface ActivityActionResult {
  ok: boolean;
  error?: string;
}

const listeners = new Set<(kind: ActivityChangeKind, ids: number[]) => void>();

/** Subscribe to hide / unhide / delete / merge. Returns an unsubscribe function. */
export function onActivityStoreChanged(cb: (kind: ActivityChangeKind, ids: number[]) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(kind: ActivityChangeKind, ids: number[]): void {
  for (const l of listeners) {
    try { l(kind, ids); } catch { /* listener errors must not break the action */ }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(new CustomEvent(ACTIVITY_STORE_CHANGED_EVENT, { detail: { kind, ids } }));
    } catch { /* ignore */ }
  }
  const now = new Date().toISOString();
  notifyActivitiesUpdated({
    sources: [], fetched: 0, added: 0, updated: ids.length, full: false, errors: [], startedAt: now, finishedAt: now,
  });
}

function patchActivities(ids: ReadonlySet<number>, patch: (a: Activity) => Activity): number {
  const all = getAllStoredActivities();
  let changed = 0;
  const next = all.map((a) => {
    if (!ids.has(a.id)) return a;
    const updated = patch(a);
    if (updated !== a) changed++;
    return updated;
  });
  if (changed > 0) writeActivityStore(next);
  return changed;
}

/** True when the athlete hid this activity. */
export function isActivityHidden(id: number): boolean {
  return getAllStoredActivities().some((a) => a.id === id && !!a.hidden);
}

/** Hidden activities, newest first (Activities › Hidden filter). */
export function getHiddenActivities(): Activity[] {
  return getAllStoredActivities().filter((a) => !!a.hidden);
}

/** Hide an activity from analytics, PRs, load and plan matching. Idempotent. */
export function hideActivity(id: number, reason: 'user' | 'duplicate' = 'user', duplicateOf?: number): ActivityActionResult {
  if (!getAllStoredActivities().some((a) => a.id === id)) return { ok: false, error: 'Activity not found.' };
  const changed = patchActivities(new Set([id]), (a) => {
    if (a.hidden && a.hidden_reason === reason && a.duplicate_of === duplicateOf) return a;
    const next: Activity = { ...a, hidden: true, hidden_reason: reason };
    if (duplicateOf !== undefined) next.duplicate_of = duplicateOf;
    else delete next.duplicate_of;
    return next;
  });
  if (changed) emit(reason === 'duplicate' ? 'merge' : 'hide', [id]);
  return { ok: true };
}

/** Show a hidden activity again. Idempotent. */
export function unhideActivity(id: number): ActivityActionResult {
  if (!getAllStoredActivities().some((a) => a.id === id)) return { ok: false, error: 'Activity not found.' };
  const changed = patchActivities(new Set([id]), (a) => {
    if (!a.hidden && a.hidden_reason === undefined && a.duplicate_of === undefined) return a;
    const next: Activity = { ...a };
    delete next.hidden;
    delete next.hidden_reason;
    delete next.duplicate_of;
    return next;
  });
  if (changed) emit('unhide', [id]);
  return { ok: true };
}

/**
 * Permanently remove an activity from this device and tombstone it, so syncs
 * and file re-imports skip it. Nothing is deleted upstream.
 */
export function deleteActivity(id: number): ActivityActionResult {
  const all = getAllStoredActivities();
  const target = all.find((a) => a.id === id);
  if (!target) return { ok: false, error: 'Activity not found.' };
  addTombstones([target]);
  writeActivityStore(all.filter((a) => a.id !== id));
  emit('delete', [id]);
  return { ok: true };
}

// ── Duplicates ────────────────────────────────────────────────────────────────

function readDecisions(): Set<string> {
  try {
    const raw = persistence.getItem(DUPLICATE_DECISIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Likely duplicates among visible records, minus pairs the athlete chose to keep. */
export function getDuplicateCandidates(): DuplicateCandidate[] {
  return findDuplicateCandidates(getAllStoredActivities(), { dismissed: readDecisions() });
}

/** Merge a duplicate pair: hide `dropId` and remember it was merged into `keepId`. */
export function mergeDuplicate(keepId: number, dropId: number): ActivityActionResult {
  if (keepId === dropId) return { ok: false, error: 'Pick two different activities.' };
  return hideActivity(dropId, 'duplicate', keepId);
}

/** Remember "keep both" so this pair isn't suggested again. */
export function keepBothDuplicates(idA: number, idB: number): void {
  const decisions = readDecisions();
  const key = duplicatePairKey(idA, idB);
  if (decisions.has(key)) return;
  decisions.add(key);
  persistence.setItem(DUPLICATE_DECISIONS_KEY, JSON.stringify([...decisions]));
}
