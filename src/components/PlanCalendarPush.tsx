/**
 * "Send your plan to your watch" card.
 *
 * Writes the active training plan to the athlete's intervals.icu calendar as
 * structured workouts with target paces (services/planCalendarSync).
 * intervals.icu forwards planned workouts to Garmin (the next 7 days, once
 * "Upload planned workouts" is ticked on the Garmin box in intervals.icu →
 * Settings → Connections), COROS, Suunto and Wahoo — and, since December
 * 2025, run workouts to Zwift.
 *
 * Self-contained — it reads the connection, plan and push state itself — so
 * it can sit on the Training page or in Settings. It also warns when the
 * intervals.icu Run threshold pace is missing (services/wellness), because
 * Garmin then shows the workouts with "No Target".
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPlanById } from '../data/plans';
import { getActivePlan } from '../services/planProgress';
import { getIntervalsCredentials } from '../services/storage';
import {
  AUTO_PUSH_WEEKS,
  getPlanPushState,
  hasPlanTargetPaces,
  isPlanPushRunning,
  onPlanPushStateChange,
  pushPlanToIntervals,
  removePlanFromIntervals,
  setPlanAutoPush,
  syncPlanCalendarIfChanged,
  type PlanPushState,
  type PushResult,
} from '../services/planCalendarSync';
import { checkRunThresholdPace, getRunThresholdPaceStatus, onWellnessUpdated } from '../services/wellness';
import { ConfirmDialog } from './ui';

const INTERVALS_SETTINGS_URL = 'https://intervals.icu/settings';

type Action = 'push' | 'auto' | 'remove';

const badgeStyle = {
  fontSize: '0.75rem', background: 'var(--apollo-teal-dim)',
  color: 'var(--apollo-teal)', padding: '0.15rem 0.6rem',
  borderRadius: 'var(--radius-full)', fontWeight: 600,
  fontFamily: 'var(--font-display)',
} as const;

const textStyle = { color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.5 } as const;
const hintStyle = { color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.4 } as const;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Oct 12" for a local YYYY-MM-DD key. */
function formatDay(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return dateKey;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Oct 12, 9:41 AM" for an ISO timestamp. */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function describePush(result: PushResult): string {
  const parts = [result.upserted > 0
    ? `Sent ${plural(result.upserted, 'workout')} (${formatDay(result.from)} – ${formatDay(result.to)})`
    : 'No upcoming workouts to send'];
  if (result.deleted > 0) parts.push(`removed ${plural(result.deleted, 'outdated workout')}`);
  return `${parts.join(' · ')}.`;
}

/**
 * User-facing text for a push status reported by the plan engine
 * (`status` on the auto-sync outcome or on the stored push state).
 */
export function describePushStatus(status: unknown): string | null {
  if (status === 'skipped-in-progress') return 'A push is already running.';
  if (status === 'nothing-changed') return 'Already up to date.';
  return null;
}

/** Status field of an auto-sync outcome, whatever its exact shape (PushResult, status object or null). */
function statusOf(outcome: unknown): unknown {
  return outcome && typeof outcome === 'object' ? (outcome as { status?: unknown }).status : undefined;
}

/** PushResult inside an auto-sync outcome (the outcome itself, or its `result`). */
function pushResultOf(outcome: unknown): PushResult | null {
  if (!outcome || typeof outcome !== 'object') return null;
  const o = outcome as Partial<PushResult> & { result?: unknown };
  if (typeof o.upserted === 'number' && typeof o.from === 'string' && typeof o.to === 'string') return o as PushResult;
  return o.result ? pushResultOf(o.result) : null;
}

function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong while talking to intervals.icu.';
}

/** Card that sends the active plan to intervals.icu (and from there to the athlete's watch). */
export default function PlanCalendarPush() {
  const [pushState, setPushState] = useState<PlanPushState>(() => getPlanPushState());
  const [action, setAction] = useState<Action | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Manual and automatic pushes (e.g. after an activity sync) both update the card.
  useEffect(() => {
    setPushState(getPlanPushState());
    return onPlanPushStateChange(setPushState);
  }, []);

  // The Run threshold pace status is re-read during wellness syncs (and below).
  const [, setPaceCheck] = useState(0);
  useEffect(() => onWellnessUpdated(() => setPaceCheck((n) => n + 1)), []);

  // Cheap synchronous reads: re-evaluated whenever the card or its page re-renders.
  const connected = !!getIntervalsCredentials();
  const active = getActivePlan();
  const plan = active?.planId ? getPlanById(active.planId) : undefined;
  const planKey = plan && active ? `${plan.id}:${active.startDate}` : null;
  const hasPaces = hasPlanTargetPaces();
  const busy = action !== null;
  const sentCurrentPlan = !!pushState.lastPushAt && pushState.planKey === planKey;
  const thresholdPaceMissing = connected && getRunThresholdPaceStatus().missing;
  const storedStatus = describePushStatus((pushState as PlanPushState & { lastStatus?: unknown }).lastStatus);

  // Without a Run threshold pace Garmin shows "No Target": check it (when due) even if wellness sync is off.
  useEffect(() => {
    if (connected) void checkRunThresholdPace();
  }, [connected]);

  async function run(next: Action, firstStep: string, task: () => Promise<string | null>): Promise<void> {
    setAction(next);
    setProgress(firstStep);
    setNotice(null);
    setError(null);
    try {
      const message = await task();
      if (message) setNotice(message);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setAction(null);
      setProgress(null);
    }
  }

  const handleSend = () => {
    if (isPlanPushRunning()) {
      setError(null);
      setNotice(describePushStatus('skipped-in-progress'));
      return;
    }
    void run('push', 'Preparing your workouts…', async () =>
      describePush(await pushPlanToIntervals({ onProgress: setProgress })));
  };

  const handleAutoChange = (enabled: boolean) => {
    setPlanAutoPush(enabled);
    if (!enabled) {
      setError(null);
      setNotice('Automatic updates are off. Workouts already sent stay on your calendar.');
      return;
    }
    void run('auto', 'Checking your intervals.icu calendar…', async () => {
      const outcome: unknown = await syncPlanCalendarIfChanged();
      const statusText = describePushStatus(statusOf(outcome));
      if (statusText) return `Automatic updates are on. ${statusText}`;
      const result = pushResultOf(outcome);
      if (result) return describePush(result);
      // Failures are recorded in the push state and shown below.
      return getPlanPushState().lastError ? null : 'Automatic updates are on. Your calendar is up to date.';
    });
  };

  const handleRemoveConfirmed = () => {
    setConfirmRemove(false);
    void run('remove', 'Removing Apollo workouts…', async () => {
      const removed = await removePlanFromIntervals();
      return removed > 0
        ? `Removed ${plural(removed, 'workout')} from intervals.icu.`
        : 'There were no upcoming Apollo workouts on your intervals.icu calendar.';
    });
  };

  const lastFailure = connected && pushState.lastError
    ? `Last update failed${pushState.lastErrorAt ? ` (${formatWhen(pushState.lastErrorAt)})` : ''}: ${pushState.lastError}`
    : null;
  const shownError = error ?? lastFailure;

  const removeButton = (
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>
      {action === 'remove' ? 'Removing…' : 'Remove Apollo workouts'}
    </button>
  );

  return (
    <div className="card" style={{
      borderLeftWidth: 3, borderLeftStyle: 'solid',
      borderLeftColor: connected && plan ? 'var(--apollo-teal)' : 'var(--border)',
    }}>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--apollo-teal)' }}>Send your plan to your watch</span>
        {connected && pushState.enabled && <span style={badgeStyle}>Auto-update on</span>}
      </h3>
      <p style={{ ...textStyle, margin: '0 0 0.5rem' }}>
        Apollo writes your upcoming workouts, with target paces, to your intervals.icu calendar. intervals.icu can
        forward them to Garmin, COROS, Suunto, Wahoo and Zwift.
      </p>
      <p style={{ ...textStyle, margin: '0 0 1rem' }}>
        To get them on a Garmin watch, open{' '}
        <a href={INTERVALS_SETTINGS_URL} target="_blank" rel="noopener noreferrer">intervals.icu → Settings</a>
        {' '}→ Connections and tick <strong>Upload planned workouts</strong> on the Garmin box. That is a separate
        permission from downloading your activities. intervals.icu then sends the <strong>next 7 days</strong> of
        planned workouts to Garmin, so later weeks appear on the watch as they come into range.
      </p>

      {!connected ? (
        <p style={{ ...textStyle, margin: 0 }}>
          intervals.icu isn&apos;t connected yet.{' '}
          <Link to="/settings?tab=connections" style={{ fontWeight: 600 }}>Connect it in Settings › Connections</Link>
          {' '}(it&apos;s free), then come back here to send your plan.
        </p>
      ) : !plan ? (
        <>
          <p style={{ ...textStyle, margin: '0 0 0.75rem' }}>
            No active training plan. <Link to="/plan" style={{ fontWeight: 600 }}>Choose a plan</Link> and Apollo
            can send its workouts to your calendar.
          </p>
          {pushState.pushedIds.length > 0 && removeButton}
        </>
      ) : (
        <>
          <p style={{ ...hintStyle, margin: '0 0 0.75rem' }}>
            {sentCurrentPlan && pushState.lastPushAt
              ? `${plan.name}: last sent ${formatWhen(pushState.lastPushAt)}`
                + (pushState.lastResult && pushState.lastResult.upserted > 0
                  ? ` · ${plural(pushState.lastResult.upserted, 'workout')} through ${formatDay(pushState.lastResult.to)}.`
                  : '.')
              : `${plan.name} hasn't been sent to intervals.icu yet.`}
            {storedStatus && ` ${storedStatus}`}
            {!hasPaces && (
              <>
                {' '}Workouts go out as plain distances until Apollo knows your training paces.{' '}
                <Link to="/settings?tab=profile">Add a recent race in Settings › Athlete Profile</Link>.
              </>
            )}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={handleSend}>
              {action === 'push' ? 'Sending…' : 'Send plan to intervals.icu'}
            </button>
            {removeButton}
          </div>
          <div style={{ marginTop: '1rem', maxWidth: 560 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: busy ? 'default' : 'pointer', flexWrap: 'wrap' }}>
              <input
                type="checkbox"
                checked={pushState.enabled}
                disabled={busy}
                onChange={(e) => handleAutoChange(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: 'var(--apollo-teal)' }}
              />
              <span style={{ fontWeight: 500 }}>Keep my intervals.icu calendar updated automatically</span>
            </label>
            <p style={{ ...hintStyle, margin: '0.35rem 0 0 1.65rem' }}>
              When your plan, paces or units change, Apollo re-sends the next {AUTO_PUSH_WEEKS} weeks (it checks
              whenever it syncs). Switching plans or start dates replaces the old workouts.
            </p>
          </div>
        </>
      )}

      {/* Always mounted so screen readers announce new messages. */}
      <div role="status" aria-live="polite" style={{ marginTop: progress || notice ? '0.75rem' : 0, fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
        {progress && <div style={{ color: 'var(--text-muted)' }}>{progress}</div>}
        {!progress && notice && <div style={{ color: 'var(--color-success)', fontWeight: 600 }}>{notice}</div>}
      </div>
      {!progress && shownError && (
        <div role="alert" style={{ marginTop: '0.5rem', fontSize: 'var(--text-sm)', lineHeight: 1.5, color: 'var(--color-error-text, var(--color-error))' }}>
          <span aria-hidden="true">⚠ </span>{shownError}
        </div>
      )}

      {thresholdPaceMissing && (
        <div role="note" style={{
          ...textStyle, color: 'var(--text)', margin: '1rem 0 0', padding: '0.6rem 0.75rem',
          background: 'var(--color-warning-dim)', borderLeft: '3px solid var(--color-warning)',
          borderRadius: 'var(--radius-sm)',
        }}>
          Your intervals.icu Run threshold pace isn&apos;t set, so Garmin will show these workouts without pace
          targets. Set it in{' '}
          <a href={INTERVALS_SETTINGS_URL} target="_blank" rel="noopener noreferrer">intervals.icu → Settings → Sport settings</a>
          {' '}(your marathon pace is a reasonable starting point), then use <strong>Remove Apollo workouts</strong> and
          send again.
        </div>
      )}
      <p style={{ ...hintStyle, margin: '1rem 0 0' }}>
        Garmin tip: your watch only shows the pace targets if a Run threshold pace is set in intervals.icu
        (Settings → Sport settings). If you set it after sending, use <strong>Remove Apollo workouts</strong> and
        send your plan again so Garmin gets fresh copies.
      </p>
      <p style={{ ...hintStyle, margin: '0.5rem 0 0' }}>
        Zwift tip: intervals.icu sends run workouts to Zwift too (since December 2025). Zwift sets run targets from
        the 5K time in your Zwift profile, so set it to about your intervals.icu Run threshold pace × 5 km.
        Apollo only changes workouts it created, never your own events or past days.
      </p>

      <ConfirmDialog
        open={confirmRemove}
        title="Remove Apollo workouts?"
        message={(
          <>
            <p style={{ margin: '0 0 0.5rem' }}>
              This removes the workouts Apollo added to your intervals.icu calendar from today on.
            </p>
            <p style={{ margin: 0 }}>
              Past workouts and anything you created yourself stay. Automatic updates will be turned off.
            </p>
          </>
        )}
        confirmLabel="Remove workouts"
        tone="danger"
        onConfirm={handleRemoveConfirmed}
        onCancel={() => setConfirmRemove(false)}
      />
    </div>
  );
}
