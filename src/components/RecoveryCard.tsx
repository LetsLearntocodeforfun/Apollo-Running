/**
 * "Recovery" card: last night's sleep, resting HR and HRV from the athlete's
 * watch or ring (Garmin, COROS, Oura… via intervals.icu wellness), turned into
 * a conservative daily recovery status with a one-line training suggestion
 * (services/wellness → getRecoverySnapshot).
 *
 * Self-contained, like PlanCalendarPush: it reads the connection, the
 * wellness-sync preference and the stored data itself, and re-reads them after
 * every wellness sync, so it can sit on any page. `compact` drops the list of
 * reasons and the footer for tighter layouts.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getIntervalsCredentials } from '../services/storage';
import { APP_PREFS_CHANGED_EVENT, getAppPreferences } from '../services/appPreferences';
import {
  getRecoverySnapshot,
  getWellnessSyncState,
  onWellnessUpdated,
  type RecoverySnapshot,
  type RecoveryStatus,
  type WellnessSyncState,
} from '../services/wellness';

const INTERVALS_SETTINGS_URL = 'https://intervals.icu/settings';

export interface RecoveryCardProps {
  /** Tighter layout: no list of reasons, no footer, smaller charts. */
  compact?: boolean;
}

const STATUS_LABEL: Record<RecoveryStatus, string> = {
  good: 'Recovered',
  ok: 'OK',
  caution: 'Caution',
  unknown: 'Not enough data',
};

const STATUS_COLORS: Record<RecoveryStatus, { color: string; background: string }> = {
  good: { color: 'var(--color-success)', background: 'var(--color-success-dim)' },
  ok: { color: 'var(--apollo-teal)', background: 'var(--apollo-teal-dim)' },
  caution: { color: 'var(--color-warning)', background: 'var(--color-warning-dim)' },
  unknown: { color: 'var(--text-muted)', background: 'var(--bg-surface)' },
};

const textStyle = { color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.5 } as const;
const hintStyle = { color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.4 } as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "7:32" (h:mm). */
function formatHMM(secs: number): string {
  const totalMin = Math.round(secs / 60);
  return `${Math.floor(totalMin / 60)}:${pad2(totalMin % 60)}`;
}

/** "+6", "−3", "±0". */
function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0';
}

/** "Oct 4" for a local YYYY-MM-DD key. */
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

/** Screen-reader summary of a sparkline, or null without readings. */
function describeSeries(name: string, unit: string, values: readonly (number | undefined)[]): string | null {
  const nums = values.filter((v): v is number => v !== undefined);
  if (nums.length === 0) return null;
  const latest = Math.round(nums[nums.length - 1]);
  const min = Math.round(Math.min(...nums));
  const max = Math.round(Math.max(...nums));
  const count = `${nums.length} ${nums.length === 1 ? 'reading' : 'readings'}`;
  return `${name} over the last ${values.length} days: ${count} between ${min} and ${max} ${unit}, latest ${latest} ${unit}`;
}

interface SparklineProps {
  /** One value per day, oldest first (undefined on days without data). */
  values: readonly (number | undefined)[];
  color: string;
  label: string;
  /** Shaded normal range. */
  band?: { low: number; high: number };
  /** Dashed reference line (e.g. the 30-day average). */
  reference?: number;
  width: number;
  height: number;
}

/** Tiny dependency-free SVG trend line; days without data are skipped, keeping the timeline spacing. */
function Sparkline({ values, color, label, band, reference, width, height }: SparklineProps) {
  const points = values.flatMap((v, i) => (v === undefined ? [] : [{ i, v }]));
  if (points.length === 0) return null;
  const scale = points.map((p) => p.v);
  if (band) scale.push(band.low, band.high);
  if (reference !== undefined) scale.push(reference);
  let min = Math.min(...scale);
  let max = Math.max(...scale);
  if (max - min < 1) {
    const mid = (min + max) / 2;
    min = mid - 0.5;
    max = mid + 0.5;
  }
  const pad = 3;
  const x = (i: number) => (values.length <= 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (values.length - 1));
  const y = (v: number) => pad + ((max - v) * (height - 2 * pad)) / (max - min);
  const last = points[points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <title>{label}</title>
      {band && (
        <rect
          x={0}
          y={y(band.high)}
          width={width}
          height={Math.max(1, y(band.low) - y(band.high))}
          rx={2}
          style={{ fill: color, opacity: 0.14 }}
        />
      )}
      {reference !== undefined && (
        <line
          x1={0}
          x2={width}
          y1={y(reference)}
          y2={y(reference)}
          strokeWidth={1}
          strokeDasharray="3 3"
          style={{ stroke: 'var(--text-muted)' }}
        />
      )}
      {points.length > 1 && (
        <polyline
          points={points.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')}
          fill="none"
          strokeWidth={1.75}
          strokeLinejoin="round"
          strokeLinecap="round"
          style={{ stroke: color }}
        />
      )}
      <circle cx={x(last.i)} cy={y(last.v)} r={2.5} style={{ fill: color }} />
    </svg>
  );
}

interface StatProps {
  label: string;
  value: string;
  sub: string;
  /** This metric is one of the reasons for the status: highlight it. */
  flagged: boolean;
  compact: boolean;
  children?: ReactNode;
}

function Stat({ label, value, sub, flagged, compact, children }: StatProps) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="label-micro">{label}</div>
      <div className="stat-value" style={{
        color: flagged ? 'var(--color-warning)' : 'var(--text)',
        fontSize: compact ? '1.2rem' : undefined,
      }}>
        {value}
      </div>
      <div className="stat-sub">{sub}</div>
      {children && <div style={{ marginTop: '0.45rem' }}>{children}</div>}
    </div>
  );
}

interface View {
  snapshot: RecoverySnapshot;
  sync: WellnessSyncState;
}

function readView(): View {
  return { snapshot: getRecoverySnapshot(), sync: getWellnessSyncState() };
}

/** Card with today's recovery status from intervals.icu wellness (sleep, resting HR, HRV). */
export default function RecoveryCard({ compact = false }: RecoveryCardProps) {
  const [view, setView] = useState<View>(readView);

  // New wellness data, a changed preference, or coming back to the app (maybe on a new day).
  useEffect(() => {
    const refresh = () => setView(readView());
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    const unsubscribe = onWellnessUpdated(refresh);
    window.addEventListener(APP_PREFS_CHANGED_EVENT, refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      unsubscribe();
      window.removeEventListener(APP_PREFS_CHANGED_EVENT, refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Cheap synchronous reads, re-evaluated whenever the card or its page re-renders.
  const connected = !!getIntervalsCredentials();
  const enabled = getAppPreferences().syncWellness;
  const { snapshot, sync } = view;
  const hasData = connected && enabled && snapshot.daysWithData > 0;
  const colors = STATUS_COLORS[snapshot.status];

  const errorLine = connected && enabled && sync.lastError ? (
    <p style={{ color: 'var(--color-error)', fontSize: '0.82rem', margin: '0.75rem 0 0', lineHeight: 1.4 }}>
      Last wellness sync failed{sync.lastErrorAt ? ` (${formatWhen(sync.lastErrorAt)})` : ''}: {sync.lastError}
    </p>
  ) : null;

  let body: ReactNode;
  if (!connected) {
    body = (
      <p style={{ ...textStyle, margin: 0 }}>
        <Link to="/settings" style={{ fontWeight: 600 }}>Connect intervals.icu in Settings → Data sources</Link>
        {' '}to see sleep, HRV and resting HR.
      </p>
    );
  } else if (!enabled) {
    body = (
      <p style={{ ...textStyle, margin: 0 }}>
        Wellness sync is turned off.{' '}
        <Link to="/settings" style={{ fontWeight: 600 }}>Turn it on in Settings → Data sources</Link>
        {' '}to see sleep, HRV and resting HR here.
      </p>
    );
  } else if (!hasData) {
    body = (
      <>
        <p style={{ ...textStyle, margin: '0 0 0.5rem' }}>
          {sync.lastSyncAt
            ? 'No recent sleep, HRV or resting HR from intervals.icu yet.'
            : 'Apollo reads your sleep, HRV and resting HR from intervals.icu each time it syncs.'}
        </p>
        <p style={{ ...hintStyle, margin: 0 }}>
          To send them from your watch, open{' '}
          <a href={INTERVALS_SETTINGS_URL} target="_blank" rel="noopener noreferrer">intervals.icu → Settings</a>
          {' '}→ Connections and turn on wellness for your device (Garmin: tick <strong>Wellness</strong>).
        </p>
        {errorLine}
      </>
    );
  } else {
    const { sleep, restingHR, hrv, series } = snapshot;
    const asOf = (date: string | undefined) => (date && date !== snapshot.date ? ` · ${formatDay(date)}` : '');
    const chart = { width: compact ? 110 : 140, height: compact ? 26 : 34 };
    const hrvValues = series.map((p) => p.hrv);
    const rhrValues = series.map((p) => p.restingHR);
    const hrvLabel = describeSeries('HRV', 'ms', hrvValues);
    const rhrLabel = describeSeries('Resting HR', 'bpm', rhrValues);

    const sleepSub = sleep
      ? [
        sleep.score !== undefined ? `Score ${Math.round(sleep.score)}` : null,
        sleep.avg7Secs !== undefined ? `7-night avg ${formatHMM(sleep.avg7Secs)}` : null,
      ].filter((s): s is string => !!s).join(' · ') || 'Last night'
      : 'No data from the last 2 nights';

    const rhrSub = !restingHR
      ? 'No data from the last 2 days'
      : restingHR.delta !== undefined && restingHR.baseline !== undefined
        ? `${signed(restingHR.delta)} vs 30-day avg (${Math.round(restingHR.baseline)})`
        : 'Learning your normal range';

    const hrvValue = hrv?.avg7 ?? hrv?.latest;
    const hrvSub = !hrv
      ? 'No data from the last 2 days'
      : [
        hrv.low !== undefined && hrv.high !== undefined
          ? `Normal ${Math.round(hrv.low)}–${Math.round(hrv.high)} ms`
          : 'Learning your normal range',
        hrv.avg7 !== undefined && hrv.latest !== undefined ? `last ${Math.round(hrv.latest)}` : null,
      ].filter((s): s is string => !!s).join(' · ');

    body = (
      <>
        <div role="status" style={{ marginBottom: '1rem' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-md)', color: 'var(--text)' }}>
            {snapshot.headline}
          </div>
          <p style={{ ...textStyle, margin: '0.25rem 0 0' }}>{snapshot.suggestion}</p>
        </div>

        <div style={{
          display: 'grid', gap: compact ? '0.75rem' : '1rem',
          gridTemplateColumns: `repeat(auto-fit, minmax(${compact ? 110 : 140}px, 1fr))`,
        }}>
          <Stat
            label={`Sleep${asOf(sleep?.date)}`}
            value={sleep ? formatHMM(sleep.secs) : '—'}
            sub={sleepSub}
            flagged={!!sleep?.flagged}
            compact={compact}
          />
          <Stat
            label={`Resting HR${asOf(restingHR?.date)}`}
            value={restingHR ? `${restingHR.bpm} bpm` : '—'}
            sub={rhrSub}
            flagged={!!restingHR?.flagged}
            compact={compact}
          >
            {rhrLabel && (
              <Sparkline
                values={rhrValues}
                color="var(--apollo-orange)"
                label={rhrLabel}
                reference={restingHR?.baseline}
                {...chart}
              />
            )}
          </Stat>
          <Stat
            label={hrv?.avg7 !== undefined ? 'HRV · 7-day avg' : `HRV${asOf(hrv?.date)}`}
            value={hrvValue !== undefined ? `${Math.round(hrvValue)} ms` : '—'}
            sub={hrvSub}
            flagged={!!hrv?.flagged}
            compact={compact}
          >
            {hrvLabel && (
              <Sparkline
                values={hrvValues}
                color="var(--apollo-teal)"
                label={hrvLabel}
                band={hrv?.low !== undefined && hrv.high !== undefined ? { low: hrv.low, high: hrv.high } : undefined}
                {...chart}
              />
            )}
          </Stat>
        </div>

        {!compact && snapshot.reasons.length > 0 && (
          <ul style={{
            ...hintStyle, margin: '1rem 0 0', paddingLeft: '1.1rem',
            display: 'flex', flexDirection: 'column', gap: '0.25rem',
          }}>
            {snapshot.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
        {errorLine}
        {!compact && (
          <p style={{ ...hintStyle, margin: '0.75rem 0 0' }}>
            From your watch via intervals.icu{sync.lastSyncAt ? ` · updated ${formatWhen(sync.lastSyncAt)}` : ''}.
            {' '}A guide, not a rule: how you feel counts too.
          </p>
        )}
      </>
    );
  }

  return (
    <div className="card" style={{
      borderLeftWidth: 3, borderLeftStyle: 'solid',
      borderLeftColor: hasData ? colors.color : 'var(--border)',
      ...(compact ? { padding: '1rem 1.25rem' } : {}),
    }}>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--apollo-teal)' }}>Recovery</span>
        {hasData && (
          <span style={{
            fontSize: '0.72rem', background: colors.background, color: colors.color,
            padding: '0.15rem 0.6rem', borderRadius: 'var(--radius-full)', fontWeight: 600,
            fontFamily: 'var(--font-display)',
          }}>
            {STATUS_LABEL[snapshot.status]}
          </span>
        )}
      </h3>
      {body}
    </div>
  );
}
