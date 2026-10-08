/**
 * "⋯" day menu for plan days (v1.0.6): Move to… / Skip / Convert to an easy run /
 * Convert to rest / Restore original / Undo last change — all through the plan
 * overlay (planOverlay.ts), so built-in plans are never mutated and every change
 * can be undone.
 *
 * Accessible menu-button pattern: the trigger has aria-haspopup/aria-expanded,
 * items are role="menuitem" buttons with roving focus (↑/↓/Home/End), Escape or
 * Tab closes and focus returns to the trigger. Errors from the overlay (e.g.
 * "Completed days can't be changed.") are announced in the menu.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { PlanDay, TrainingPlan } from '../../data/plans';
import {
  getActivePlan,
  getActivePlanInstanceId,
  getDateKeyForDay,
  getRaceDayRef,
  isDayCompleted,
  PLAN_OVERLAY_STORAGE_KEY,
} from '../../services/planProgress';
import {
  convertWorkout,
  getOverlayLog,
  isDayModified,
  moveWorkout,
  restoreDay,
  skipWorkout,
  undoLastChange,
} from '../../services/planOverlay';
import type { DayRef, OverlayResult } from '../../services/planOverlay';
import { persistence } from '../../services/db/persistence';
import { formatDayLabel, workoutSummary, workoutTitle } from './planDisplay';
import './plan.css';

export type DayBadge = 'Skipped' | 'Moved' | 'Changed';

function refKey(weekIndex: number, dayIndex: number): string {
  return `${weekIndex}:${dayIndex}`;
}

/**
 * Badges for every modified day of the active plan instance, keyed 'w:d'
 * ('Skipped' / 'Moved' for swaps / 'Changed' for conversions and adjustments).
 * One overlay read per call, so callers can compute it once per render.
 */
export function getDayBadges(plan: TrainingPlan | null): Map<string, DayBadge> {
  const out = new Map<string, DayBadge>();
  if (!plan) return out;
  const instanceId = getActivePlanInstanceId();
  if (!instanceId) return out;
  let overrides: Record<string, unknown> = {};
  let partners: Record<string, unknown> = {};
  try {
    const raw = persistence.getItem(PLAN_OVERLAY_STORAGE_KEY);
    const store = raw ? (JSON.parse(raw) as Record<string, { dayOverrides?: Record<string, unknown>; swapPartners?: Record<string, unknown> }>) : {};
    overrides = store[instanceId]?.dayOverrides ?? {};
    partners = store[instanceId]?.swapPartners ?? {};
  } catch {
    overrides = {};
  }
  plan.weeks.forEach((week, w) => {
    week.days.forEach((day, d) => {
      const k = refKey(w, d);
      if (day.skipped) out.set(k, 'Skipped');
      else if (Object.prototype.hasOwnProperty.call(overrides, k)) out.set(k, partners[k] ? 'Moved' : 'Changed');
    });
  });
  return out;
}

/** Badge text for a single day (convenience wrapper; prefer getDayBadges in loops). */
export function dayBadgeText(ref: DayRef, day: PlanDay | null | undefined): DayBadge | null {
  if (!day) return null;
  if (day.skipped) return 'Skipped';
  if (!isDayModified(ref)) return null;
  try {
    const instanceId = getActivePlanInstanceId();
    const raw = persistence.getItem(PLAN_OVERLAY_STORAGE_KEY);
    const store = raw ? JSON.parse(raw) : {};
    const partner = instanceId ? store?.[instanceId]?.swapPartners?.[refKey(ref.weekIndex, ref.dayIndex)] : undefined;
    return partner ? 'Moved' : 'Changed';
  } catch {
    return 'Changed';
  }
}

interface MenuAction {
  id: string;
  label: string;
  run: () => OverlayResult;
  success: string;
}

interface MoveTarget {
  weekIndex: number;
  dayIndex: number;
  label: string;
}

export interface DayActionsMenuProps {
  /** The effective plan (getEffectivePlan()). */
  plan: TrainingPlan;
  weekIndex: number;
  dayIndex: number;
  /** Human label for the day, used in accessible names (e.g. "Tue, Oct 6"). */
  dayLabel: string;
  /** Called after a successful change with a short confirmation message. */
  onChanged?: (message: string) => void;
  className?: string;
}

function isEasy(day: PlanDay): boolean {
  return /easy|recovery/i.test(day.note ?? '') || /easy|recovery/i.test(day.label);
}

export function DayActionsMenu({ plan, weekIndex, dayIndex, dayLabel, onChanged, className }: DayActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'move'>('menu');
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const menuId = `day-menu-${uid.replace(/:/g, '')}`;

  const active = getActivePlan();
  const day = plan.weeks[weekIndex]?.days[dayIndex];
  const race = getRaceDayRef(plan);
  const linear = weekIndex * 7 + dayIndex;
  const raceLinear = race.weekIndex * 7 + race.dayIndex;
  const completed = active ? isDayCompleted(active.planId, weekIndex, dayIndex) : false;
  const editable = !!active && !!day && linear < raceLinear && !completed;

  // Recomputed when the menu opens so it reflects the latest overlay.
  const { actions, moveTargets, undoSummary } = useMemo(() => {
    const list: MenuAction[] = [];
    const targets: MoveTarget[] = [];
    let undo: string | null = null;
    if (!open || !day || !active) return { actions: list, moveTargets: targets, undoSummary: undo };
    const ref = { weekIndex, dayIndex };
    const title = workoutTitle(day);
    if (editable) {
      if (day.type !== 'rest') {
        list.push({ id: 'skip', label: 'Skip', run: () => skipWorkout(ref), success: `Skipped ${title.toLowerCase()} on ${dayLabel}.` });
      }
      if (day.type === 'run' && (day.distanceMi ?? 0) > 0 && !isEasy(day)) {
        list.push({ id: 'easy', label: 'Convert to an easy run', run: () => convertWorkout(ref, 'easy'), success: `${dayLabel} is now an easy run.` });
      }
      if (day.type !== 'rest') {
        list.push({ id: 'rest', label: 'Convert to a rest day', run: () => convertWorkout(ref, 'rest'), success: `${dayLabel} is now a rest day.` });
      }
      // Move targets: other days of this week and next week, before race day, not completed.
      for (let w = weekIndex; w <= Math.min(weekIndex + 1, plan.weeks.length - 1); w++) {
        for (let d = 0; d < 7; d++) {
          if (w === weekIndex && d === dayIndex) continue;
          if (w * 7 + d >= raceLinear) continue;
          if (isDayCompleted(active.planId, w, d)) continue;
          const other = plan.weeks[w]?.days[d];
          if (!other) continue;
          const dateKey = getDateKeyForDay(active.startDate, w, d);
          targets.push({ weekIndex: w, dayIndex: d, label: `${formatDayLabel(dateKey)} — ${workoutSummary(other)}` });
        }
      }
    }
    if (!completed && isDayModified(ref)) {
      list.push({ id: 'restore', label: 'Restore original', run: () => restoreDay(ref), success: `Restored the planned workout on ${dayLabel}.` });
    }
    const log = getOverlayLog();
    if (log.length > 0) undo = log[log.length - 1].summary;
    return { actions: list, moveTargets: targets, undoSummary: undo };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plan, weekIndex, dayIndex, dayLabel, editable, completed]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setMode('menu');
    setError(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Focus the first item whenever the menu opens or switches mode.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open, mode]);

  // Close on outside pointer-down.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, close]);

  if (!day || !active) return null;
  const hasAnything = editable || isDayModified({ weekIndex, dayIndex }) || getOverlayLog().length > 0;
  if (!hasAnything) return null;

  const runAction = (run: () => OverlayResult, success: string) => {
    const result = run();
    if (result.ok) {
      close(true);
      onChanged?.(success);
    } else {
      setError(result.error ?? 'That change could not be made.');
    }
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'move') setMode('menu');
      else close(true);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  const title = workoutTitle(day);

  return (
    <div className={`day-actions${className ? ` ${className}` : ''}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="day-actions-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Change ${dayLabel}: ${title}`}
        onClick={() => (open ? close(false) : (setOpen(true), setMode('menu'), setError(null)))}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          className="day-actions-menu"
          aria-label={mode === 'move' ? `Move ${title} to` : `Actions for ${dayLabel}`}
          onKeyDown={onMenuKeyDown}
        >
          {mode === 'menu' ? (
            <>
              {editable && moveTargets.length > 0 && (
                <button type="button" role="menuitem" tabIndex={-1} className="day-actions-item" onClick={() => setMode('move')}>
                  Move to…
                </button>
              )}
              {actions.map((a) => (
                <button key={a.id} type="button" role="menuitem" tabIndex={-1} className="day-actions-item" onClick={() => runAction(a.run, a.success)}>
                  {a.label}
                </button>
              ))}
              {undoSummary && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="day-actions-item day-actions-item--undo"
                  aria-label={`Undo last change: ${undoSummary}`}
                  onClick={() => runAction(undoLastChange, `Undid: ${undoSummary}.`)}
                >
                  Undo last change
                  <span className="day-actions-sub">{undoSummary}</span>
                </button>
              )}
              {!editable && completed && <p className="day-actions-note">Completed days can’t be changed.</p>}
            </>
          ) : (
            <>
              <button type="button" role="menuitem" tabIndex={-1} className="day-actions-item day-actions-item--back" onClick={() => setMode('menu')}>
                <span aria-hidden="true">←</span> Back
              </button>
              {moveTargets.map((t) => (
                <button
                  key={`${t.weekIndex}:${t.dayIndex}`}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="day-actions-item"
                  onClick={() =>
                    runAction(
                      () => moveWorkout({ weekIndex, dayIndex }, { weekIndex: t.weekIndex, dayIndex: t.dayIndex }),
                      `Moved ${title.toLowerCase()} to ${t.label.split(' — ')[0]}.`,
                    )
                  }
                >
                  {t.label}
                </button>
              ))}
            </>
          )}
          {error && (
            <p className="day-actions-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Small "Moved" / "Skipped" / "Changed" badge (text, not colour-only). */
export function DayBadgeChip({ badge }: { badge: DayBadge | null | undefined }) {
  if (!badge) return null;
  return <span className={`day-badge day-badge--${badge.toLowerCase()}`}>{badge}</span>;
}

export default DayActionsMenu;
