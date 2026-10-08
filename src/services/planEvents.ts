/**
 * Window events emitted by the plan engine (v1.0.6).
 *
 * Kept in a dependency-free module so `planProgress` and `planOverlay` can both
 * dispatch them without importing each other.
 */

/**
 * Fired whenever the *effective* plan may have changed: an overlay edit
 * (move/skip/convert/scale/undo), a new or cleared active plan, or a race-date
 * change. Listen with `onPlanOverlayChanged()` from `planOverlay.ts`.
 */
export const PLAN_OVERLAY_CHANGED_EVENT = 'apollo:plan-overlay-changed';

/** Fired when a day's completion state changes (`setDayCompleted`). */
export const PLAN_PROGRESS_CHANGED_EVENT = 'apollo:plan-progress-changed';

/** Dispatch a plan event on `window` (no-op outside the browser). */
export function emitPlanEvent(name: string, detail?: unknown): void {
  try {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
    window.dispatchEvent(new CustomEvent(name, { detail }));
  } catch {
    // never let a listener failure break a write
  }
}

/** Subscribe to a plan event; returns an unsubscribe function. */
export function onPlanEvent(name: string, cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
  const handler = () => cb();
  window.addEventListener(name, handler);
  return () => window.removeEventListener(name, handler);
}
