/**
 * Activity management UI (B18): the "Possible duplicates" banner and the
 * Hide / Unhide / Delete-from-this-device actions of an activity's detail.
 *
 * Every mutation goes through services/activity/manage.ts, which notifies
 * `onActivitiesUpdated` listeners (the Activities list refreshes itself), and
 * then schedules a rebuild of the effort recognitions, which depend on which
 * runs are visible.
 */
import { useEffect, useId, useState } from 'react';
import {
  deleteActivity,
  getDuplicateCandidates,
  hideActivity,
  keepBothDuplicates,
  mergeDuplicate,
  unhideActivity,
} from '../../services/activity/manage';
import type { DuplicateCandidate } from '../../services/activity/dedupe';
import { getSourceDisplayName, onActivitiesUpdated, type Activity } from '../../services/activitySource';
import { scheduleEffortRebuild } from '../../services/effortService';
import { formatDistance } from '../../services/unitPreferences';
import { getSportLabel } from '../../services/activity/sports';
import { isDateKey, parseDateKey } from '../../utils/localDate';
import { ConfirmDialog } from '../ui';

/** "Oct 7, 2026 · 07:12" from the activity's local start (never via `new Date(start_date_local)`). */
export function formatActivityStart(a: Activity): string {
  const key = (a.start_date_local ?? '').slice(0, 10);
  if (!isDateKey(key)) return '';
  const date = parseDateKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = (a.start_date_local ?? '').slice(11, 16);
  return time ? `${date} · ${time}` : date;
}

function sourceLabel(a: Activity): string {
  return a.source === 'file' ? 'an imported file' : getSourceDisplayName(a.source);
}

function describeRecord(a: Activity): string {
  const parts = [a.name || getSportLabel(a)];
  if (a.distance > 0) parts.push(formatDistance(a.distance));
  parts.push(`from ${sourceLabel(a)}`);
  return parts.join(' · ');
}

// ── Possible duplicates ──────────────────────────────────────────────────────

export interface DuplicatesBannerProps {
  /** Called with a short confirmation after a merge or "keep both". */
  onNotice?: (message: string) => void;
}

/**
 * Dismissible disclosure listing likely duplicate pairs (same workout stored
 * twice). "Merge" keeps the richer record and hides the other one (it can be
 * unhidden from the Hidden filter); "Keep both" stops suggesting the pair.
 */
export function DuplicatesBanner({ onNotice }: DuplicatesBannerProps) {
  const [candidates, setCandidates] = useState<DuplicateCandidate[]>(() => getDuplicateCandidates());
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const panelId = useId();

  useEffect(() => onActivitiesUpdated(() => setCandidates(getDuplicateCandidates())), []);

  if (dismissed || candidates.length === 0) return null;

  const refresh = (): void => setCandidates(getDuplicateCandidates());
  const merge = (c: DuplicateCandidate): void => {
    const result = mergeDuplicate(c.keep.id, c.drop.id);
    refresh();
    if (!result.ok) {
      onNotice?.(result.error ?? 'Could not merge those activities.');
      return;
    }
    scheduleEffortRebuild();
    onNotice?.('Merged. The extra copy is hidden; find it under Hidden.');
  };
  const keepBoth = (c: DuplicateCandidate): void => {
    keepBothDuplicates(c.keep.id, c.drop.id);
    refresh();
    onNotice?.('Kept both. Apollo won\'t suggest that pair again.');
  };

  const n = candidates.length;
  return (
    <section
      aria-label="Possible duplicates"
      className="card"
      style={{ marginBottom: '1.25rem', borderLeft: '3px solid var(--color-warning)', padding: '0.85rem 1.1rem' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-secondary"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          style={{ fontSize: 'var(--text-sm)', minHeight: 32 }}
        >
          {open ? '▾' : '▸'} {n === 1 ? '1 possible duplicate' : `${n} possible duplicates`}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setDismissed(true)}
          style={{ fontSize: 'var(--text-sm)', minHeight: 32 }}
        >
          Dismiss
        </button>
      </div>
      <div id={panelId} hidden={!open}>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: '0.75rem 0' }}>
          These look like the same workout stored twice. Merging keeps the more detailed record and hides the other,
          so it isn&apos;t counted twice in your stats.
        </p>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.6rem' }}>
          {candidates.map((c) => (
            <li
              key={c.key}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap',
                padding: '0.6rem 0', borderTop: '1px solid var(--border)',
              }}
            >
              <div style={{ minWidth: 0, fontSize: 'var(--text-sm)' }}>
                <strong style={{ display: 'block' }}>{formatActivityStart(c.keep)}</strong>
                <span>Keep: {describeRecord(c.keep)}</span>
                <br />
                <span style={{ color: 'var(--text-muted)' }}>Hide: {describeRecord(c.drop)}</span>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => merge(c)}
                  aria-label={`Merge the ${formatActivityStart(c.keep)} duplicates`}
                  style={{ fontSize: 'var(--text-sm)', minHeight: 32 }}
                >
                  Merge
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => keepBoth(c)}
                  aria-label={`Keep both ${formatActivityStart(c.keep)} activities`}
                  style={{ fontSize: 'var(--text-sm)', minHeight: 32 }}
                >
                  Keep both
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ── Hide / unhide / delete ───────────────────────────────────────────────────

export interface ActivityActionsProps {
  activity: Activity;
  /** Called with a short confirmation after the action (the activity usually leaves the current list). */
  onDone?: (message: string) => void;
}

/** Hide / Unhide and "Delete from this device" for one activity (detail view). */
export function ActivityActions({ activity, onDone }: ActivityActionsProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = activity.name || getSportLabel(activity);
  const upstream = activity.source === 'file' ? 'your files' : getSourceDisplayName(activity.source);

  const finish = (result: { ok: boolean; error?: string }, message: string): void => {
    if (!result.ok) {
      setError(result.error ?? 'Something went wrong.');
      return;
    }
    setError(null);
    scheduleEffortRebuild();
    onDone?.(message);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
      {activity.hidden ? (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: 'var(--text-sm)', minHeight: 32 }}
          onClick={() => finish(unhideActivity(activity.id), `“${label}” is visible again.`)}
        >
          Unhide
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ fontSize: 'var(--text-sm)', minHeight: 32 }}
          title="Hidden activities don't count toward stats, records, training load or plan matching."
          onClick={() => finish(hideActivity(activity.id), `“${label}” is hidden. Find it under Hidden.`)}
        >
          Hide
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary"
        style={{ fontSize: 'var(--text-sm)', minHeight: 32, color: 'var(--color-error)' }}
        onClick={() => setConfirmDelete(true)}
      >
        Delete from this device
      </button>
      {error && <span role="alert" style={{ color: 'var(--color-error)', fontSize: 'var(--text-sm)' }}>{error}</span>}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete from this device?"
        tone="danger"
        confirmLabel="Delete from this device"
        message={(
          <>
            <p>
              “{label}” ({formatActivityStart(activity)}) will be removed from Apollo on this device. It won&apos;t come
              back when you sync or re-import your files.
            </p>
            <p>Nothing is deleted from {upstream}. To keep it but leave it out of your stats, use Hide instead.</p>
          </>
        )}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          finish(deleteActivity(activity.id), `“${label}” was deleted from this device.`);
        }}
      />
    </div>
  );
}
