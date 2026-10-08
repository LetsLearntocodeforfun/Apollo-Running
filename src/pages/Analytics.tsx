import { useState, useEffect, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, Cell, ScatterChart, Scatter,
} from 'recharts';
import {
  getActivities,
  getStoredActivities,
  isActivitySourceConnected,
  hasActivityData,
  onActivitiesUpdated,
  type Activity,
} from '../services/activitySource';
import { isRunActivity, getSportCategoryColor, getSportCategoryLabel, SPORT_CATEGORIES, type SportCategory } from '../services/activity/sports';
import { summarizeBySport, weeklySportVolume, formatHoursMinutes, type WeeklySportVolume } from '../services/crossTraining';
import { getHRProfile } from '../services/heartRate';
import {
  calculateSummaryStats, calculateWeeklyMileage,
  calculatePaceProgression,
  detectPersonalRecords, calculateConsistency, calculateStreaks,
  calculateHREfficiency, weekOverWeek, formatWeekCompareValue,
  type ConsistencyDay, type HREfficiencyPoint,
} from '../services/analyticsService';
import LoadingScreen from '../components/LoadingScreen';
import ConnectDataSourceCTA from '../components/ConnectDataSourceCTA';
import FitnessFormChart from '../components/fitness/FitnessFormChart';
import { EmptyState } from '../components/ui';
import {
  getDistanceUnit,
  metersToUnit,
  unitLabel,
  paceUnitLabel,
  milesToUnit,
  formatDuration,
  formatDistanceShort,
  formatElevation,
} from '../services/unitPreferences';
import { addDays, daysBetween, isDateKey, todayKey } from '../utils/localDate';

// ─── Time Period ─────────────────────────────────────────────

type TimePeriod = '7d' | '30d' | '90d' | '6mo' | 'all';

const PERIODS: { id: TimePeriod; label: string }[] = [
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: '90d', label: '90D' },
  { id: '6mo', label: '6 Mo' },
  { id: 'all', label: 'All' },
];

/** Calendar days in the period, today included. "All" starts at the earliest stored activity (B9). */
function periodDays(period: TimePeriod, earliestKey: string | null, today: string): number {
  switch (period) {
    case '7d': return 7;
    case '30d': return 30;
    case '90d': return 90;
    case '6mo': return 182;
    case 'all': return earliestKey ? Math.max(7, daysBetween(earliestKey, today) + 1) : 7;
  }
}

/** `start_date_local` carries a fake "Z" (local wall time): compare its calendar date only. */
function activityKey(a: Activity): string {
  return (a.start_date_local ?? '').slice(0, 10);
}

function earliestActivityKey(activities: Activity[]): string | null {
  let min: string | null = null;
  for (const a of activities) {
    const k = activityKey(a);
    if (isDateKey(k) && (min === null || k < min)) min = k;
  }
  return min;
}

/** Activities in the last `days` calendar days (today included). */
function filterByDays(activities: Activity[], days: number, today: string): Activity[] {
  const from = addDays(today, -(days - 1));
  return activities.filter((a) => {
    const k = activityKey(a);
    return k >= from && k <= today;
  });
}

/** The `days`-long window just before the current one (for period-over-period deltas). */
function previousDays(activities: Activity[], days: number, today: string): Activity[] {
  const to = addDays(today, -days);
  const from = addDays(today, -(2 * days - 1));
  return activities.filter((a) => {
    const k = activityKey(a);
    return k >= from && k <= to;
  });
}

function formatShortDate(dateKey: string): string {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Recharts paints SVG attributes, so resolve `var(--x, #hex)` to its hex fallback. */
function sportChartColor(category: SportCategory): string {
  const color = getSportCategoryColor(category);
  return color.match(/#[0-9a-fA-F]{3,8}/)?.[0] ?? color;
}

// ─── Chart Colors ────────────────────────────────────────────

const GOLD = '#D4A537';
const GOLD_LIGHT = '#E8C05A';
const TEAL = '#5BB5B5';
const SUCCESS = '#2ECC71';
const ORANGE = '#E07B30';
const AXIS = { fill: '#8A8478', fontSize: 11 };
const KM_PER_MI = 1.609344;

// ─── Formatters ──────────────────────────────────────────────

/** min/mi value → "m:ss" in the athlete's pace unit (no suffix, for chart axes). */
function fmtPace(v: number): string {
  if (!v || v > 20) return '—';
  const paceInUnit = getDistanceUnit() === 'km' ? v / KM_PER_MI : v;
  const totalSec = Math.round(paceInUnit * 60);
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

/** Signed pace change in min/mi (negative = faster) → "−0:12 /km" (B10). */
function fmtPaceDelta(deltaMinPerMi: number): string {
  const perUnit = getDistanceUnit() === 'km' ? deltaMinPerMi / KM_PER_MI : deltaMinPerMi;
  const totalSec = Math.round(Math.abs(perUnit) * 60);
  const sign = perUnit < 0 ? '\u2212' : '+';
  return `${sign}${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')} ${paceUnitLabel()}`;
}

function fmtMiles(v: number): string {
  return milesToUnit(v).toFixed(1);
}

/** Explicit value kinds for chart tooltips, instead of sniffing series names (B6). */
type SeriesKind = 'pace' | 'distance' | 'hours' | 'count';

function formatSeriesValue(kind: SeriesKind | undefined, v: number): string {
  switch (kind) {
    case 'pace': return `${fmtPace(v)} ${paceUnitLabel()}`;
    case 'distance': return `${v.toFixed(1)} ${unitLabel()}`;
    case 'hours': return `${v.toFixed(1)} h`;
    case 'count': return String(Math.round(v));
    default: return v.toFixed(1);
  }
}

// ─── Stat Card ───────────────────────────────────────────────

function StatCard({ label, value, sub, delta, deltaLabel, deltaGood, unit }: {
  label: string; value: string; sub?: string;
  /** Percentage change vs the previous period. */
  delta?: number | null;
  /** Pre-formatted change (e.g. pace "−0:12 /km"); shown instead of `delta`. */
  deltaLabel?: string | null;
  /** Whether the `deltaLabel` change is an improvement (colour + arrow). */
  deltaGood?: boolean;
  unit?: string;
}) {
  const showPct = !deltaLabel && delta != null && Math.round(delta) !== 0;
  const good = deltaLabel ? !!deltaGood : (delta ?? 0) > 0;
  return (
    <div style={{
      flex: '1 1 160px', background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: '1.1rem 1.2rem',
    }}>
      <div style={{
        fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase',
        letterSpacing: '0.07em', fontFamily: 'var(--font-display)', fontWeight: 500,
        marginBottom: '0.4rem',
      }}>{label}</div>
      <div style={{
        fontSize: '1.6rem', fontWeight: 700, color: 'var(--apollo-gold)',
        fontFamily: 'var(--font-display)', lineHeight: 1.1,
      }}>
        {value}{unit && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginLeft: '0.25rem' }}>{unit}</span>}
      </div>
      {(deltaLabel || showPct) && (
        <div style={{ fontSize: '0.75rem', marginTop: '0.3rem', fontWeight: 600, color: good ? SUCCESS : ORANGE }}>
          <span aria-hidden="true">{good ? '↑' : '↓'} </span>
          {deltaLabel ?? `${Math.abs(Math.round(delta!))}%`}
          <span className="sr-only"> {good ? 'better' : 'worse'} than the previous period</span>
        </div>
      )}
      {sub && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{sub}</div>}
    </div>
  );
}

// ─── Chart Card Wrapper ──────────────────────────────────────

function ChartCard({ title, subtitle, summary, children, height = 280 }: {
  title: string; subtitle?: string;
  /** Text alternative for the chart (screen readers). */
  summary: string;
  children: ReactNode; height?: number;
}) {
  return (
    <figure className="card" style={{ padding: '1.25rem 1.5rem', margin: 0 }}>
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--text)' }}>{title}</h2>
        {subtitle && <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>{subtitle}</p>}
      </div>
      <div style={{ width: '100%', height }} aria-hidden="true">
        {children}
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

// ─── Custom Tooltip ──────────────────────────────────────────

interface TooltipEntry { name: string; value: number; color: string; dataKey?: unknown }

function CustomTooltip({ active, payload, label, kinds, defaultKind }: {
  active?: boolean; payload?: TooltipEntry[]; label?: string;
  kinds?: Record<string, SeriesKind>; defaultKind?: SeriesKind;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={{
      background: 'var(--apollo-navy-light)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem',
      fontSize: '0.78rem', color: 'var(--text)', boxShadow: 'var(--shadow-md)',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>{label}</div>
      {payload.map((p, i) => {
        const kind = (typeof p.dataKey === 'string' ? kinds?.[p.dataKey] : undefined) ?? defaultKind;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.15rem' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
            <span style={{ color: 'var(--text-muted)' }}>{p.name}:</span>
            <span style={{ fontWeight: 600 }}>{typeof p.value === 'number' ? formatSeriesValue(kind, p.value) : p.value}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Consistency Heatmap ─────────────────────────────────────

function ConsistencyHeatmap({ data }: { data: ConsistencyDay[] }) {
  if (data.length === 0) return null;

  const maxMiles = Math.max(...data.map(d => d.miles), 1);
  const weeks: ConsistencyDay[][] = [];
  let currentWeek: ConsistencyDay[] = [];

  // Pad start to align to Monday
  const firstDate = new Date(data[0].date + 'T00:00:00');
  const startDay = firstDate.getDay();
  const padDays = startDay === 0 ? 6 : startDay - 1;
  for (let i = 0; i < padDays; i++) {
    currentWeek.push({ date: '', miles: -1, runCount: 0 });
  }

  for (const day of data) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push({ date: '', miles: -1, runCount: 0 });
    weeks.push(currentWeek);
  }

  const dayLabels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  return (
    <div style={{ display: 'flex', gap: '0.15rem' }} aria-hidden="true">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', marginRight: '0.3rem' }}>
        {dayLabels.map((l, i) => (
          <div key={i} style={{
            width: 14, height: 14, fontSize: '0.6rem', color: 'var(--text-muted)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{l}</div>
        ))}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
          {week.map((day, di) => {
            if (day.miles < 0) return <div key={di} style={{ width: 14, height: 14 }} />;
            const intensity = day.miles > 0 ? Math.min(day.miles / maxMiles, 1) : 0;
            const bg = intensity === 0
              ? 'rgba(255,255,255,0.04)'
              : `rgba(212, 165, 55, ${0.15 + intensity * 0.65})`;
            return (
              <div
                key={di}
                title={day.date ? `${day.date}: ${fmtMiles(day.miles)} ${unitLabel()}` : ''}
                style={{ width: 14, height: 14, borderRadius: 2, background: bg }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Derived view ────────────────────────────────────────────

/** Longest window the heatmap shows (53 weeks) — wider grids stop being readable. */
const MAX_HEATMAP_DAYS = 371;
/** Longest window the weekly charts show (3 years of bars). */
const MAX_CHART_WEEKS = 156;

function computeView(activities: Activity[], days: number, today: string) {
  const periodActs = filterByDays(activities, days, today);
  const prevActs = previousDays(activities, days, today);
  const weeks = Math.min(Math.ceil(days / 7), MAX_CHART_WEEKS);
  const heatmapDays = Math.min(days, MAX_HEATMAP_DAYS);
  const consistency = calculateConsistency(activities, heatmapDays);
  const maxHR = getHRProfile().maxHR;
  return {
    periodActs,
    weeks,
    heatmapCapped: heatmapDays < days,
    stats: calculateSummaryStats(periodActs, prevActs),
    weeklyMileage: calculateWeeklyMileage(activities, weeks).map((w) => ({
      ...w,
      distance: Math.round(metersToUnit(w.distanceM) * 10) / 10,
    })),
    paceProgression: calculatePaceProgression(activities, weeks),
    consistency,
    streaks: calculateStreaks(consistency),
    hrEfficiency: calculateHREfficiency(activities, days),
    wow: weekOverWeek(activities),
    crossSummary: summarizeBySport(periodActs, { maxHR }).filter((s) => s.category !== 'run'),
    sportVolume: weeklySportVolume(activities, Math.min(Math.max(weeks, 4), 52), maxHR),
  };
}

// ─── Main Analytics Page ─────────────────────────────────────

export interface AnalyticsProps {
  /**
   * Rendered inside another page (Progress › Trends): no page title, no
   * page-level loading/connect wrappers, sections start at h2. The Fitness &
   * Form chart is left to its own Progress tab.
   */
  embedded?: boolean;
}

export default function Analytics({ embedded = false }: AnalyticsProps) {
  const [period, setPeriod] = useState<TimePeriod>('30d');
  const [loading, setLoading] = useState(true);
  const [allActivities, setAllActivities] = useState<Activity[]>([]);

  const connected = isActivitySourceConnected();
  // Stored history stays viewable after disconnecting (computed once — reads the whole store)
  const [available, setAvailable] = useState(hasActivityData);
  // Only set when the sync failed and nothing is stored yet (the facade throws only then)
  const [syncError, setSyncError] = useState<string | null>(null);

  // Load stored history right away, then refresh from connected sources (the facade only syncs when stale)
  useEffect(() => {
    if (!available) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setAllActivities(getStoredActivities());
    if (!connected) {
      setLoading(false);
      return;
    }

    (async () => {
      setLoading(true);
      setSyncError(null);
      try {
        await getActivities({ page: 1, per_page: 1 });
        if (!cancelled) setAllActivities(getStoredActivities());
      } catch (e) {
        // Keep showing stored data
        if (!cancelled) setSyncError(e instanceof Error ? e.message : 'Could not sync activities.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [connected, available]);

  // Any source added/updated activities (sync, file import, hide/delete) → recompute
  useEffect(() => onActivitiesUpdated(() => {
    setAvailable(true);
    setSyncError(null);
    setAllActivities(getStoredActivities());
  }), []);

  const today = todayKey();
  const earliest = useMemo(() => earliestActivityKey(allActivities), [allActivities]);
  const days = periodDays(period, earliest, today);
  const view = useMemo(
    () => (allActivities.length > 0 ? computeView(allActivities, days, today) : null),
    [allActivities, days, today],
  );
  // All-time records don't depend on the period
  const personalRecords = useMemo(() => detectPersonalRecords(allActivities), [allActivities]);

  const connectLink = <Link to="/settings?tab=connections">connect a data source</Link>;

  if (!available) {
    if (embedded) {
      return (
        <EmptyState
          icon="📊"
          title="No training data yet"
          action={<Link className="btn btn-primary" to="/settings?tab=connections">Connect a data source</Link>}
        >
          Connect Strava or intervals.icu, or import activity files, to see weekly distance, pace trends, personal records and more.
        </EmptyState>
      );
    }
    return (
      <div>
        <h1 className="page-title">Analytics</h1>
        <ConnectDataSourceCTA
          emoji="📊"
          title="Legendary Analytics"
          description="Connect a data source to unlock comprehensive training analytics — weekly mileage trends, pace progression, fitness and form, cross-training volume, personal records, and more."
        />
      </div>
    );
  }

  if (loading && allActivities.length === 0) {
    if (embedded) {
      return <p role="status" style={{ color: 'var(--text-muted)' }}>Analyzing your training data…</p>;
    }
    return <LoadingScreen message="Analyzing your training data…" />;
  }

  const recentRuns = view ? view.periodActs.filter(isRunActivity).slice(0, 20) : [];
  const gridCols = 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))';

  const periodPicker = (
    <div role="group" aria-label="Time period" style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
      {PERIODS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          aria-pressed={period === id}
          onClick={() => setPeriod(id)}
          style={{
            minHeight: 32, padding: '0.4rem 0.75rem', borderRadius: 'var(--radius-sm)',
            border: period === id ? '1px solid var(--apollo-gold)' : '1px solid var(--border)',
            background: period === id ? 'var(--apollo-gold-dim)' : 'var(--bg-elevated)',
            color: period === id ? 'var(--apollo-gold)' : 'var(--text-secondary)',
            fontSize: '0.78rem', fontFamily: 'var(--font-display)', fontWeight: 600,
            cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.03em',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* ── Header / toolbar ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          {!embedded && (
            <h1 style={{
              fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)',
              fontWeight: 700, margin: 0, color: 'var(--text)',
            }}>Analytics</h1>
          )}
          {!connected && (
            <p style={{ color: 'var(--text-muted)', margin: '0.25rem 0 0', fontSize: 'var(--text-sm)' }}>
              Showing saved history — {connectLink} to keep it up to date.
            </p>
          )}
        </div>
        {periodPicker}
      </div>

      {/* ── Fitness & Form (replaces the old acute:chronic chart; Progress shows it in its own tab) ── */}
      {!embedded && <FitnessFormChart />}

      {view && (
        <>
          {/* ── Summary Stats ── */}
          <section aria-label="Period summary" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <StatCard label={`Total ${getDistanceUnit() === 'km' ? 'Kilometers' : 'Miles'}`} value={fmtMiles(view.stats.totalMiles)} delta={view.stats.milesDelta} />
            <StatCard label="Total Time" value={formatDuration(view.stats.totalTime)} delta={view.stats.timeDelta} />
            <StatCard
              label="Avg Pace"
              value={fmtPace(view.stats.avgPace)}
              unit={paceUnitLabel()}
              deltaLabel={view.stats.paceDelta != null && Math.abs(view.stats.paceDelta) >= 1 / 120 ? fmtPaceDelta(view.stats.paceDelta) : null}
              deltaGood={(view.stats.paceDelta ?? 0) < 0}
            />
            <StatCard label="Runs" value={String(view.stats.runCount)} />
            {view.stats.avgHR && <StatCard label="Avg HR" value={String(view.stats.avgHR)} unit="bpm" />}
            <StatCard label="Elevation" value={formatElevation(view.stats.totalElevation)} />
          </section>

          {/* ── Week-over-Week ── */}
          {view.wow.length > 0 && (
            <section className="card" style={{ padding: '1rem 1.25rem' }}>
              <h2 style={{ fontSize: '0.75rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', margin: '0 0 0.75rem' }}>
                This Week vs Last Week
              </h2>
              <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                {view.wow.map(w => (
                  <div key={w.label} style={{ flex: '1 1 100px', textAlign: 'center' }}>
                    <div style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--text)' }}>
                      {formatWeekCompareValue(w.kind, w.current)}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{w.label}</div>
                    {w.delta !== 0 && (
                      <div style={{ fontSize: '0.7rem', fontWeight: 600, marginTop: '0.15rem', color: w.delta > 0 ? SUCCESS : ORANGE }}>
                        <span aria-hidden="true">{w.delta > 0 ? '↑' : '↓'}</span>
                        <span className="sr-only">{w.delta > 0 ? 'up' : 'down'} </span>
                        {Math.abs(w.delta)}% vs {formatWeekCompareValue(w.kind, w.previous)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Weekly Distance Chart (display units, B4) ── */}
          {view.weeklyMileage.length > 1 && (() => {
            const pts = view.weeklyMileage;
            const current = pts[pts.length - 1];
            const prior = pts.slice(0, -1);
            const avg = prior.reduce((s, p) => s + p.distance, 0) / prior.length;
            const peak = pts.reduce((m, p) => (p.distance > m.distance ? p : m), pts[0]);
            const u = unitLabel();
            return (
              <ChartCard
                title="Weekly Distance"
                subtitle={`Last ${pts.length} weeks (${u}), Monday to Sunday`}
                summary={`This week so far: ${current.distance.toFixed(1)} ${u}. Average of the previous ${prior.length} weeks: ${avg.toFixed(1)} ${u}. Biggest week: ${peak.distance.toFixed(1)} ${u}, week of ${peak.weekLabel}.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pts} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="weekLabel" tick={AXIS} />
                    <YAxis tick={AXIS} />
                    <Tooltip content={<CustomTooltip kinds={{ distance: 'distance' }} />} />
                    <Bar dataKey="distance" name={`Distance (${u})`} radius={[4, 4, 0, 0]}>
                      {pts.map((_, index) => (
                        <Cell key={index} fill={index === pts.length - 1 ? GOLD_LIGHT : GOLD} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            );
          })()}

          <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: '1.25rem' }}>
            {/* Pace Progression (distance-weighted, B5) */}
            {view.paceProgression.length > 1 && (() => {
              const pts = view.paceProgression;
              const first = pts[0];
              const last = pts[pts.length - 1];
              return (
                <ChartCard
                  title="Pace Progression"
                  subtitle={`Average pace per week (min${paceUnitLabel()}), weighted by distance`}
                  summary={`Average pace went from ${fmtPace(first.avgPace)} to ${fmtPace(last.avgPace)} ${paceUnitLabel()} between the weeks of ${first.weekLabel} and ${last.weekLabel}.`}
                  height={240}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={pts} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="weekLabel" tick={AXIS} />
                      <YAxis tick={AXIS} tickFormatter={(v: number) => fmtPace(v)} reversed domain={['auto', 'auto']} />
                      <Tooltip content={<CustomTooltip kinds={{ avgPace: 'pace', fastestPace: 'pace' }} />} />
                      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#B8B2A8' }} />
                      <Line type="monotone" dataKey="avgPace" name="Avg Pace" stroke={GOLD} strokeWidth={2} dot={{ r: 3, fill: GOLD }} />
                      <Line type="monotone" dataKey="fastestPace" name="Fastest Run" stroke={TEAL} strokeWidth={1.5} dot={{ r: 2, fill: TEAL }} strokeDasharray="4 4" />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartCard>
              );
            })()}

            {/* HR Efficiency Scatter (outdoor runs only) */}
            {view.hrEfficiency.length > 3 && (() => {
              const pts = view.hrEfficiency;
              return (
                <ChartCard
                  title="Heart Rate Efficiency"
                  subtitle="Pace vs heart rate for outdoor runs — faster pace at the same HR means improving fitness"
                  summary={`${pts.length} outdoor runs with heart rate between ${formatShortDate(pts[0].date)} and ${formatShortDate(pts[pts.length - 1].date)}. The five most recent runs are highlighted.`}
                  height={240}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <ScatterChart margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis
                        type="number" dataKey="avgHR" name="Avg HR" tick={AXIS}
                        label={{ value: 'Avg HR (bpm)', position: 'insideBottom', offset: -2, style: { fill: '#8A8478', fontSize: 10 } }}
                      />
                      <YAxis
                        type="number" dataKey="pace" name="Pace" tick={AXIS}
                        tickFormatter={(v: number) => fmtPace(v)}
                        reversed
                        label={{ value: `Pace (min${paceUnitLabel()})`, angle: -90, position: 'insideLeft', offset: 15, style: { fill: '#8A8478', fontSize: 10 } }}
                      />
                      <Tooltip
                        content={({ active, payload }) => {
                          if (!active || !payload || !payload.length) return null;
                          const d = payload[0]?.payload as HREfficiencyPoint;
                          return (
                            <div style={{
                              background: 'var(--apollo-navy-light)', border: '1px solid var(--border)',
                              borderRadius: 'var(--radius-sm)', padding: '0.5rem 0.7rem',
                              fontSize: '0.78rem', color: 'var(--text)',
                            }}>
                              <div style={{ fontWeight: 600, marginBottom: '0.2rem' }}>{d.activityName}</div>
                              <div>{formatShortDate(d.date)} · {fmtPace(d.pace)} {paceUnitLabel()} · {d.avgHR} bpm</div>
                            </div>
                          );
                        }}
                      />
                      <Scatter data={pts} fill={GOLD} fillOpacity={0.7}>
                        {pts.map((_, i) => (
                          <Cell key={i} fill={i >= pts.length - 5 ? GOLD_LIGHT : GOLD} fillOpacity={i >= pts.length - 5 ? 1 : 0.5} />
                        ))}
                      </Scatter>
                    </ScatterChart>
                  </ResponsiveContainer>
                </ChartCard>
              );
            })()}
          </div>

          {/* ── Cross-Training (selected period) ── */}
          {view.crossSummary.length > 0 && (() => {
            const volume = view.sportVolume;
            const volumeCategories = SPORT_CATEGORIES.filter(c => volume.some(w => w.hours[c] > 0));
            const thisWeekHours = volume.length > 0
              ? volumeCategories.reduce((s, c) => s + (volume[volume.length - 1].hours[c] ?? 0), 0)
              : 0;
            return (
              <>
                <section className="card" style={{ padding: '1.25rem 1.5rem' }}>
                  <h2 style={{ margin: '0 0 1rem', fontSize: 'var(--text-md)' }}>
                    <span style={{ color: 'var(--apollo-teal)' }}>Cross-Training</span>
                  </h2>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    {view.crossSummary.map(s => (
                      <div key={s.category} style={{
                        flex: '1 1 160px', background: 'var(--bg)', border: '1px solid var(--border)',
                        borderLeft: `3px solid ${getSportCategoryColor(s.category)}`,
                        borderRadius: 'var(--radius-md)', padding: '0.9rem 1.1rem',
                      }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--font-display)', fontWeight: 500, marginBottom: '0.35rem' }}>
                          <span aria-hidden="true">{s.icon}</span> {s.label}
                        </div>
                        <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-display)', lineHeight: 1.1 }}>
                          {formatHoursMinutes(s.movingTimeSec)}
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                          {[
                            `${s.count} session${s.count === 1 ? '' : 's'}`,
                            s.distanceMeters > 0 ? formatDistanceShort(s.distanceMeters) : null,
                            s.trainingLoad > 0 ? `Load ${Math.round(s.trainingLoad)}` : null,
                          ].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
                {volume.length > 1 && volumeCategories.length > 0 && (
                  <ChartCard
                    title="Weekly Hours by Sport"
                    subtitle={`Hours per week, last ${volume.length} weeks`}
                    summary={`Hours per week by sport (${volumeCategories.map(getSportCategoryLabel).join(', ')}) for the last ${volume.length} weeks. This week so far: ${thisWeekHours.toFixed(1)} hours.`}
                    height={260}
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={volume} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                        <XAxis dataKey="weekLabel" tick={AXIS} />
                        <YAxis tick={AXIS} />
                        <Tooltip content={<CustomTooltip defaultKind="hours" />} />
                        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#B8B2A8' }} />
                        {volumeCategories.map(c => (
                          <Bar
                            key={c}
                            dataKey={(w: WeeklySportVolume) => w.hours[c]}
                            name={getSportCategoryLabel(c)}
                            stackId="hours"
                            fill={sportChartColor(c)}
                            fillOpacity={0.85}
                          />
                        ))}
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartCard>
                )}
              </>
            );
          })()}

          {/* ── Consistency + Personal Records ── */}
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: '1.25rem' }}>
            {view.consistency.length > 7 && (
              <section className="card" style={{ padding: '1.25rem 1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                  <h2 style={{ margin: 0, fontSize: 'var(--text-md)' }}>Consistency{view.heatmapCapped ? ' (last 12 months)' : ''}</h2>
                  <div style={{ display: 'flex', gap: '1rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    <span><strong style={{ color: 'var(--apollo-gold)' }}>{view.streaks.current}</strong> day streak</span>
                    <span><strong style={{ color: 'var(--text)' }}>{view.streaks.longest}</strong> longest</span>
                    <span><strong style={{ color: 'var(--text)' }}>{view.streaks.runsPerWeek}</strong> runs/wk</span>
                  </div>
                </div>
                <div style={{ overflowX: 'auto', paddingBottom: '0.25rem' }}>
                  <ConsistencyHeatmap data={view.consistency} />
                </div>
                <p className="sr-only">
                  {`Ran on ${view.consistency.filter((d) => d.runCount > 0).length} of the last ${view.consistency.length} days.`}
                </p>
                <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem', fontSize: '0.68rem', color: 'var(--text-muted)' }} aria-hidden="true">
                  <span>Less</span>
                  {[0, 0.2, 0.4, 0.6, 0.8].map((v, i) => (
                    <span key={i} style={{
                      width: 12, height: 12, borderRadius: 2,
                      background: v === 0 ? 'rgba(255,255,255,0.04)' : `rgba(212,165,55,${0.15 + v * 0.65})`,
                    }} />
                  ))}
                  <span>More</span>
                </div>
              </section>
            )}

            {personalRecords.length > 0 && (
              <section className="card" style={{ padding: '1.25rem 1.5rem' }}>
                <h2 style={{ margin: '0 0 1rem', fontSize: 'var(--text-md)' }}>
                  <span style={{ color: 'var(--apollo-gold)' }}>Personal Records</span>
                </h2>
                <ul style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', listStyle: 'none', margin: 0, padding: 0 }}>
                  {personalRecords.map((pr) => (
                    <li key={`${pr.category}-${pr.label}`} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0.65rem 0.85rem', borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg)', border: '1px solid var(--border)',
                    }}>
                      <div>
                        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{pr.label}</div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{pr.activityName} · {formatShortDate(pr.date)}</div>
                      </div>
                      <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '1.1rem', color: 'var(--apollo-gold)' }}>
                        {pr.value}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          {/* ── Recent Runs Table ── */}
          {recentRuns.length > 0 && (
            <section className="card" style={{ padding: '1.25rem 1.5rem' }}>
              <h2 style={{ margin: '0 0 1rem', fontSize: 'var(--text-md)' }}>Recent Runs</h2>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      {['Date', 'Name', 'Distance', 'Time', 'Pace', 'HR', 'Elev'].map(h => (
                        <th key={h} scope="col" style={{
                          textAlign: 'left', padding: '0.5rem 0.6rem',
                          fontSize: 'var(--text-xs)', textTransform: 'uppercase',
                          letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 500,
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.map(a => {
                      const mi = a.distance / 1609.344;
                      const paceMinPerMi = a.distance > 0 && a.moving_time > 0 ? (a.moving_time / 60) / mi : 0;
                      return (
                        <tr key={`${a.source ?? 'strava'}-${a.id}`} style={{ borderBottom: '1px solid var(--border)' }}>
                          <td style={{ padding: '0.6rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                            {formatShortDate(activityKey(a))}
                          </td>
                          <td style={{ padding: '0.6rem', fontFamily: 'var(--font-display)', fontWeight: 500 }}>{a.name}</td>
                          <td style={{ padding: '0.6rem', color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>{formatDistanceShort(a.distance)}</td>
                          <td style={{ padding: '0.6rem', color: 'var(--text-secondary)' }}>{formatDuration(a.moving_time)}</td>
                          <td style={{ padding: '0.6rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-display)' }}>{fmtPace(paceMinPerMi)} {paceUnitLabel()}</td>
                          <td style={{ padding: '0.6rem', color: a.average_heartrate ? 'var(--color-error)' : 'var(--text-muted)' }}>
                            {a.average_heartrate ? `${Math.round(a.average_heartrate)}` : '—'}
                          </td>
                          <td style={{ padding: '0.6rem', color: 'var(--apollo-teal)' }}>
                            {a.total_elevation_gain ? `+${formatElevation(a.total_elevation_gain)}` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}

      {/* ── Empty state ── */}
      {allActivities.length === 0 && !loading && (
        <div className="card" role={syncError ? 'alert' : undefined} style={{ textAlign: 'center', padding: '2rem' }}>
          <p style={{ color: syncError ? 'var(--color-error)' : 'var(--text-muted)' }}>
            {syncError
              ? `Couldn\u2019t sync your activities: ${syncError}`
              : 'No activities found yet. Once your connected data source syncs, your analytics will appear here.'}
          </p>
        </div>
      )}
    </div>
  );
}
