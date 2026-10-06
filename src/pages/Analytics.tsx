import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
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
import { summarizeBySport, weeklySportVolume, formatHoursMinutes, type SportSummary, type WeeklySportVolume } from '../services/crossTraining';
import { getHRProfile } from '../services/heartRate';
import {
  calculateSummaryStats, calculateWeeklyMileage,
  calculatePaceProgression, calculateTrainingLoad,
  detectPersonalRecords, calculateConsistency, calculateStreaks,
  calculateHREfficiency, weekOverWeek,
  type SummaryStats, type WeeklyMileagePoint, type PaceProgressionPoint,
  type TrainingLoadData, type PersonalRecord, type ConsistencyDay,
  type HREfficiencyPoint, type WeekCompare,
} from '../services/analyticsService';
import LoadingScreen from '../components/LoadingScreen';
import ConnectDataSourceCTA from '../components/ConnectDataSourceCTA';
import {
  getDistanceUnit,
  metersToUnit,
  unitLabel,
  paceUnitLabel,
  milesToUnit,
  formatDuration,
  formatDistanceShort,
} from '../services/unitPreferences';

// ─── Time Period ─────────────────────────────────────────────

type TimePeriod = '7d' | '30d' | '90d' | '6mo' | 'all';

function periodDays(period: TimePeriod): number {
  switch (period) {
    case '7d': return 7;
    case '30d': return 30;
    case '90d': return 90;
    case '6mo': return 182;
    case 'all': return 365 * 3;
  }
}

function filterByPeriod(activities: Activity[], period: TimePeriod): Activity[] {
  const days = periodDays(period);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return activities.filter(a => new Date(a.start_date_local) >= cutoff);
}

function previousPeriod(activities: Activity[], period: TimePeriod): Activity[] {
  const days = periodDays(period);
  const cutoffEnd = new Date();
  cutoffEnd.setDate(cutoffEnd.getDate() - days);
  const cutoffStart = new Date(cutoffEnd);
  cutoffStart.setDate(cutoffStart.getDate() - days);
  return activities.filter(a => {
    const d = new Date(a.start_date_local);
    return d >= cutoffStart && d < cutoffEnd;
  });
}

/** `start_date_local` ends in a "Z" that isn't UTC — format its calendar date only. */
function formatShortDate(startDateLocal: string): string {
  const [y, m, d] = startDateLocal.slice(0, 10).split('-').map(Number);
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

// ─── Formatters ──────────────────────────────────────────────

/** Format min/mi pace value to user-preferred unit (no suffix for chart axes). */
function fmtPace(v: number): string {
  if (!v || v > 20) return '—';
  const unit = getDistanceUnit();
  const paceInUnit = unit === 'km' ? v / 1.60934 : v;
  const totalSec = Math.round(paceInUnit * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function fmtMiles(v: number): string {
  return milesToUnit(v).toFixed(1);
}

// ─── Stat Card ───────────────────────────────────────────────

function StatCard({ label, value, sub, delta, unit }: {
  label: string; value: string; sub?: string;
  delta?: number | null; unit?: string;
}) {
  return (
    <div style={{
      flex: '1 1 160px', background: 'var(--bg)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)', padding: '1.1rem 1.2rem',
      transition: 'all var(--transition-base)',
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
      {delta != null && delta !== 0 && (
        <div style={{
          fontSize: '0.75rem', marginTop: '0.3rem', fontWeight: 600,
          color: delta > 0 ? SUCCESS : ORANGE,
        }}>
          {delta > 0 ? '↑' : '↓'} {Math.abs(Math.round(delta))}%
        </div>
      )}
      {sub && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{sub}</div>}
    </div>
  );
}

// ─── Chart Card Wrapper ──────────────────────────────────────

function ChartCard({ title, subtitle, children, height = 280 }: {
  title: string; subtitle?: string; children: React.ReactNode; height?: number;
}) {
  return (
    <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
      <div style={{ marginBottom: '1rem' }}>
        <h3 style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--text)' }}>{title}</h3>
        {subtitle && <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>{subtitle}</p>}
      </div>
      <div style={{ width: '100%', height }}>
        {children}
      </div>
    </div>
  );
}

// ─── Custom Tooltip ──────────────────────────────────────────

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={{
      background: 'var(--apollo-navy-light)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem',
      fontSize: '0.78rem', color: 'var(--text)',
      boxShadow: 'var(--shadow-md)',
    }}>
      <div style={{ fontWeight: 600, marginBottom: '0.3rem', color: 'var(--text-secondary)' }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.15rem' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--text-muted)' }}>{p.name}:</span>
          <span style={{ fontWeight: 600 }}>{typeof p.value === 'number' ? (p.name.toLowerCase().includes('pace') ? fmtPace(p.value) : p.value.toFixed(1)) : p.value}</span>
        </div>
      ))}
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
    <div style={{ display: 'flex', gap: '0.15rem' }}>
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
                style={{
                  width: 14, height: 14, borderRadius: 2,
                  background: bg,
                  transition: 'background 0.2s',
                  cursor: day.date ? 'default' : 'auto',
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ─── Main Analytics Page ─────────────────────────────────────

export default function Analytics() {
  const [period, setPeriod] = useState<TimePeriod>('30d');
  const [loading, setLoading] = useState(true);
  const [allActivities, setAllActivities] = useState<Activity[]>([]);

  // Derived state
  const [stats, setStats] = useState<SummaryStats | null>(null);
  const [weeklyMileage, setWeeklyMileage] = useState<WeeklyMileagePoint[]>([]);
  const [paceProgression, setPaceProgression] = useState<PaceProgressionPoint[]>([]);
  const [trainingLoad, setTrainingLoad] = useState<TrainingLoadData[]>([]);
  const [personalRecords, setPersonalRecords] = useState<PersonalRecord[]>([]);
  const [consistency, setConsistency] = useState<ConsistencyDay[]>([]);
  const [streaks, setStreaks] = useState<{ longest: number; current: number; runsPerWeek: number }>({ longest: 0, current: 0, runsPerWeek: 0 });
  const [hrEfficiency, setHREfficiency] = useState<HREfficiencyPoint[]>([]);
  const [wow, setWow] = useState<WeekCompare[]>([]);
  const [crossSummary, setCrossSummary] = useState<SportSummary[]>([]);
  const [sportVolume, setSportVolume] = useState<WeeklySportVolume[]>([]);

  const connected = isActivitySourceConnected();
  // Stored history stays viewable after disconnecting (computed once — reads the whole store)
  const [available, setAvailable] = useState(hasActivityData);
  // Only set when the sync failed and nothing is stored yet (the facade throws only then)
  const [syncError, setSyncError] = useState<string | null>(null);

  const computeAnalytics = useCallback((acts: Activity[], p: TimePeriod) => {
    const periodActs = filterByPeriod(acts, p);
    const prevActs = previousPeriod(acts, p);

    setStats(calculateSummaryStats(periodActs, prevActs));

    const weeks = Math.ceil(periodDays(p) / 7);
    setWeeklyMileage(calculateWeeklyMileage(acts, weeks));
    setPaceProgression(calculatePaceProgression(acts, weeks));
    setTrainingLoad(calculateTrainingLoad(acts, Math.max(periodDays(p), 56)));
    setPersonalRecords(detectPersonalRecords(acts));

    const conDays = calculateConsistency(acts, periodDays(p));
    setConsistency(conDays);
    setStreaks(calculateStreaks(conDays));
    setHREfficiency(calculateHREfficiency(acts, periodDays(p)));
    setWow(weekOverWeek(acts));

    // Cross-training (rides, swims, strength…) for the selected period
    const maxHR = getHRProfile().maxHR;
    setCrossSummary(summarizeBySport(periodActs, { maxHR }).filter(s => s.category !== 'run'));
    setSportVolume(weeklySportVolume(acts, Math.min(Math.max(weeks, 4), 52), maxHR));
  }, []);

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

  // Any source added/updated activities (e.g. a background sync or a file import) → recompute
  useEffect(() => onActivitiesUpdated(() => {
    setAvailable(true);
    setSyncError(null);
    setAllActivities(getStoredActivities());
  }), []);

  // Recompute when period or data changes
  useEffect(() => {
    if (allActivities.length > 0) {
      computeAnalytics(allActivities, period);
    }
  }, [period, allActivities, computeAnalytics]);

  if (!available) {
    return (
      <div>
        <h1 className="page-title">Analytics</h1>
        <ConnectDataSourceCTA
          emoji="📊"
          title="Legendary Analytics"
          description="Connect a data source to unlock comprehensive training analytics — weekly mileage trends, pace progression, training load, cross-training volume, personal records, and more."
        />
      </div>
    );
  }

  if (loading && allActivities.length === 0) {
    return <LoadingScreen message="Analyzing your training data…" />;
  }

  const recentRuns = filterByPeriod(allActivities, period).filter(isRunActivity).slice(0, 20);

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)',
            fontWeight: 700, margin: 0, color: 'var(--text)',
          }}>Analytics</h1>
          {!connected && (
            <p style={{ color: 'var(--text-muted)', margin: '0.25rem 0 0', fontSize: 'var(--text-sm)' }}>
              Showing saved history — <Link to="/settings">connect a data source</Link> to keep it up to date.
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {(['7d', '30d', '90d', '6mo', 'all'] as TimePeriod[]).map(p => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              style={{
                padding: '0.4rem 0.75rem', borderRadius: 'var(--radius-sm)',
                border: period === p ? '1px solid var(--apollo-gold)' : '1px solid var(--border)',
                background: period === p ? 'var(--apollo-gold-dim)' : 'var(--bg-elevated)',
                color: period === p ? 'var(--apollo-gold)' : 'var(--text-secondary)',
                fontSize: '0.78rem', fontFamily: 'var(--font-display)', fontWeight: 600,
                cursor: 'pointer', transition: 'all var(--transition-fast)',
                textTransform: 'uppercase', letterSpacing: '0.03em',
              }}
            >
              {p === '6mo' ? '6 Mo' : p === 'all' ? 'All' : p.replace('d', 'D')}
            </button>
          ))}
        </div>
      </div>

      {/* ── Summary Stats ── */}
      {stats && (
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
          <StatCard label={`Total ${unitLabel() === 'mi' ? 'Miles' : 'Kilometers'}`} value={fmtMiles(stats.totalMiles)} delta={stats.milesDelta} />
          <StatCard label="Total Time" value={formatDuration(stats.totalTime)} delta={stats.timeDelta} />
          <StatCard label="Avg Pace" value={fmtPace(stats.avgPace)} unit={paceUnitLabel()} delta={stats.paceDelta != null ? (stats.paceDelta < 0 ? Math.abs(stats.paceDelta * 10) : -stats.paceDelta * 10) : null} />
          <StatCard label="Runs" value={String(stats.runCount)} />
          {stats.avgHR && <StatCard label="Avg HR" value={String(stats.avgHR)} unit="bpm" />}
          <StatCard label="Elevation" value={String(Math.round(getDistanceUnit() === 'km' ? stats.totalElevation : stats.totalElevation * 3.28084))} unit={getDistanceUnit() === 'km' ? 'm' : 'ft'} />
        </div>
      )}

      {/* ── Week-over-Week ── */}
      {wow.length > 0 && (
        <div className="card" style={{ padding: '1rem 1.25rem' }}>
          <div style={{ fontSize: '0.7rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            This Week vs Last Week
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
            {wow.map(w => (
              <div key={w.label} style={{ flex: '1 1 100px', textAlign: 'center' }}>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--text)' }}>
                  {w.current} <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{w.unit}</span>
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{w.label}</div>
                {w.delta !== 0 && (
                  <div style={{
                    fontSize: '0.7rem', fontWeight: 600, marginTop: '0.15rem',
                    color: w.delta > 0 ? SUCCESS : ORANGE,
                  }}>
                    {w.delta > 0 ? '↑' : '↓'}{Math.abs(w.delta)}% vs {w.previous}{w.unit ? ` ${w.unit}` : ''}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Weekly Mileage Chart ── */}
      {weeklyMileage.length > 1 && (
        <ChartCard title="Weekly Mileage" subtitle={`Last ${weeklyMileage.length} weeks`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weeklyMileage} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="weekLabel" tick={{ fill: '#8A8478', fontSize: 11 }} />
              <YAxis tick={{ fill: '#8A8478', fontSize: 11 }} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="miles" name="Miles" radius={[4, 4, 0, 0]}>
                {weeklyMileage.map((_, index) => (
                  <Cell key={index} fill={index === weeklyMileage.length - 1 ? GOLD_LIGHT : GOLD} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── Two-column: Pace + Training Load ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1.25rem' }}>

        {/* Pace Progression */}
        {paceProgression.length > 1 && (
          <ChartCard title="Pace Progression" subtitle={`Average pace per week (min${paceUnitLabel()})`} height={240}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={paceProgression} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="weekLabel" tick={{ fill: '#8A8478', fontSize: 11 }} />
                <YAxis
                  tick={{ fill: '#8A8478', fontSize: 11 }}
                  tickFormatter={(v: number) => fmtPace(v)}
                  reversed
                  domain={['auto', 'auto']}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#B8B2A8' }} />
                <Line type="monotone" dataKey="avgPace" name="Avg Pace" stroke={GOLD} strokeWidth={2} dot={{ r: 3, fill: GOLD }} />
                <Line type="monotone" dataKey="fastestPace" name="Fastest" stroke={TEAL} strokeWidth={1.5} dot={{ r: 2, fill: TEAL }} strokeDasharray="4 4" />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>
        )}

        {/* Training Load */}
        {trainingLoad.length > 2 && (
          <ChartCard title="Training Load" subtitle="Acute (7d) vs Chronic (28d), incl. cross-training — ratio 0.8–1.3 is optimal" height={240}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trainingLoad} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="date" tick={{ fill: '#8A8478', fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis tick={{ fill: '#8A8478', fontSize: 11 }} />
                <Tooltip content={<CustomTooltip />} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, color: '#B8B2A8' }} />
                <Area type="monotone" dataKey="chronic" name="Chronic (28d)" stroke="#5BB5B5" fill="#5BB5B5" fillOpacity={0.15} strokeWidth={1.5} />
                <Area type="monotone" dataKey="acute" name="Acute (7d)" stroke={GOLD} fill={GOLD} fillOpacity={0.2} strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        )}
      </div>

      {/* ── Cross-Training (selected period) ── */}
      {crossSummary.length > 0 && (() => {
        const volumeCategories = SPORT_CATEGORIES.filter(c => sportVolume.some(w => w.hours[c] > 0));
        return (
          <>
            <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
              <h3 style={{ margin: '0 0 1rem' }}>
                <span style={{ color: 'var(--apollo-teal)' }}>Cross-Training</span>
              </h3>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {crossSummary.map(s => (
                  <div key={s.category} style={{
                    flex: '1 1 160px', background: 'var(--bg)', border: '1px solid var(--border)',
                    borderLeft: `3px solid ${getSportCategoryColor(s.category)}`,
                    borderRadius: 'var(--radius-md)', padding: '0.9rem 1.1rem',
                  }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'var(--font-display)', fontWeight: 500, marginBottom: '0.35rem' }}>
                      {s.icon} {s.label}
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
            </div>
            {sportVolume.length > 1 && volumeCategories.length > 0 && (
              <ChartCard title="Weekly Hours by Sport" subtitle={`Hours per week, last ${sportVolume.length} weeks`} height={260}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sportVolume} margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="weekLabel" tick={{ fill: '#8A8478', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#8A8478', fontSize: 11 }} />
                    <Tooltip content={<CustomTooltip />} />
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

      {/* ── HR Efficiency Scatter ── */}
      {hrEfficiency.length > 3 && (
        <ChartCard title="Heart Rate Efficiency" subtitle="Pace vs Heart Rate — lower pace at same HR = improving fitness" height={260}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 5, right: 10, bottom: 5, left: -10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis
                type="number" dataKey="avgHR" name="Avg HR"
                tick={{ fill: '#8A8478', fontSize: 11 }}
                label={{ value: 'Avg HR (bpm)', position: 'insideBottom', offset: -2, style: { fill: '#8A8478', fontSize: 10 } }}
              />
              <YAxis
                type="number" dataKey="pace" name="Pace"
                tick={{ fill: '#8A8478', fontSize: 11 }}
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
                      <div>{d.date} · {fmtPace(d.pace)}{paceUnitLabel()} · {d.avgHR} bpm</div>
                    </div>
                  );
                }}
              />
              <Scatter data={hrEfficiency} fill={GOLD} fillOpacity={0.7}>
                {hrEfficiency.map((_, i) => (
                  <Cell key={i} fill={i >= hrEfficiency.length - 5 ? GOLD_LIGHT : GOLD} fillOpacity={i >= hrEfficiency.length - 5 ? 1 : 0.5} r={i >= hrEfficiency.length - 5 ? 5 : 3} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </ChartCard>
      )}

      {/* ── Two-column: Consistency + Personal Records ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '1.25rem' }}>

        {/* Consistency Heatmap */}
        {consistency.length > 7 && (
          <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0 }}>Consistency</h3>
              <div style={{ display: 'flex', gap: '1rem', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                <span><strong style={{ color: 'var(--apollo-gold)' }}>{streaks.current}</strong> day streak</span>
                <span><strong style={{ color: 'var(--text)' }}>{streaks.longest}</strong> longest</span>
                <span><strong style={{ color: 'var(--text)' }}>{streaks.runsPerWeek}</strong> runs/wk</span>
              </div>
            </div>
            <div style={{ overflowX: 'auto', paddingBottom: '0.25rem' }}>
              <ConsistencyHeatmap data={consistency} />
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem', fontSize: '0.68rem', color: 'var(--text-muted)' }}>
              <span>Less</span>
              {[0, 0.2, 0.4, 0.6, 0.8].map((v, i) => (
                <span key={i} style={{
                  width: 12, height: 12, borderRadius: 2,
                  background: v === 0 ? 'rgba(255,255,255,0.04)' : `rgba(212,165,55,${0.15 + v * 0.65})`,
                }} />
              ))}
              <span>More</span>
            </div>
          </div>
        )}

        {/* Personal Records */}
        {personalRecords.length > 0 && (
          <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
            <h3 style={{ margin: '0 0 1rem' }}>
              <span style={{ color: 'var(--apollo-gold)' }}>Personal Records</span>
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {personalRecords.map((pr, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '0.65rem 0.85rem', borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg)', border: '1px solid var(--border)',
                  transition: 'border-color var(--transition-fast)',
                }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{pr.label}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{pr.activityName} · {pr.date}</div>
                  </div>
                  <div style={{
                    fontFamily: 'var(--font-display)', fontWeight: 700,
                    fontSize: '1.1rem', color: 'var(--apollo-gold)',
                  }}>
                    {pr.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Recent Runs Table ── */}
      {recentRuns.length > 0 && (
        <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
          <h3 style={{ margin: '0 0 1rem' }}>Recent Runs</h3>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Date', 'Name', 'Distance', 'Time', 'Pace', 'HR', 'Elev'].map(h => (
                    <th key={h} style={{
                      textAlign: 'left', padding: '0.5rem 0.6rem',
                      fontSize: 'var(--text-xs)', textTransform: 'uppercase',
                      letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 500,
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentRuns
                  .map(a => {
                    const dist = metersToUnit(a.distance);
                    const mi = a.distance / 1609.344;
                    const paceMinPerMi = a.distance > 0 && a.moving_time > 0 ? (a.moving_time / 60) / mi : 0;
                    return (
                      <tr key={`${a.source ?? 'strava'}-${a.id}`} style={{ borderBottom: '1px solid var(--border)', transition: 'background var(--transition-fast)' }}>
                        <td style={{ padding: '0.6rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                          {formatShortDate(a.start_date_local)}
                        </td>
                        <td style={{ padding: '0.6rem', fontFamily: 'var(--font-display)', fontWeight: 500 }}>{a.name}</td>
                        <td style={{ padding: '0.6rem', color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>{dist.toFixed(1)} {unitLabel()}</td>
                        <td style={{ padding: '0.6rem', color: 'var(--text-secondary)' }}>{formatDuration(a.moving_time)}</td>
                        <td style={{ padding: '0.6rem', color: 'var(--text-secondary)', fontFamily: 'var(--font-display)' }}>{fmtPace(paceMinPerMi)}{paceUnitLabel()}</td>
                        <td style={{ padding: '0.6rem', color: a.average_heartrate ? 'var(--color-error)' : 'var(--text-muted)' }}>
                          {a.average_heartrate ? `${Math.round(a.average_heartrate)}` : '—'}
                        </td>
                        <td style={{ padding: '0.6rem', color: 'var(--apollo-teal)' }}>
                          {a.total_elevation_gain ? `+${Math.round(getDistanceUnit() === 'km' ? a.total_elevation_gain : a.total_elevation_gain * 3.28084)}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
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
