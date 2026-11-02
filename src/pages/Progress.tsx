/**
 * Progress (v1.0.6): the old Analytics and Insights pages merged into one
 * tabbed page — Overview · Fitness & Form · Trends · Heart Rate · Recaps.
 *
 * - The selected tab lives in `?tab=` (deep links; /analytics and /insights
 *   redirect here). Unknown values fall back to Overview.
 * - Only the active panel renders (the charts are heavy).
 * - Panels refresh when the store changes (B12) via `useStoreVersion()`.
 */
import { useMemo, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabPanel } from '../components/ui';
import ConnectDataSourceCTA from '../components/ConnectDataSourceCTA';
import ErrorBoundary from '../components/ErrorBoundary';
import FitnessFormChart from '../components/fitness/FitnessFormChart';
import Analytics from './Analytics';
import { HeartRatePanel, OverviewPanel, RecapsPanel } from './Insights';
import { useStoreVersion } from '../hooks/useStoreVersion';
import { hasActivityData, isActivitySourceConnected } from '../services/activitySource';
import {
  buildAerobicDurabilityOverview,
  formatEfficiencyFactor,
  type DecouplingRating,
} from '../services/aerobicDecoupling';
import { getRaceDate } from '../services/journey';
import { formatDuration, formatMiles, getDistanceUnit } from '../services/unitPreferences';
import { isDateKey, parseDateKey } from '../utils/localDate';
import './Progress.css';

type ProgressTab = 'overview' | 'fitness' | 'trends' | 'heart-rate' | 'recaps';

/** Tab ids are linked from other pages; don't rename them. */
const TABS: { id: ProgressTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'fitness', label: 'Fitness & Form' },
  { id: 'trends', label: 'Trends' },
  { id: 'heart-rate', label: 'Heart Rate' },
  { id: 'recaps', label: 'Recaps' },
];

const ID_PREFIX = 'progress';
const MAX_RECENT_STEADY_RUNS = 8;

/** The Analytics page in embedded mode (no page title of its own). */
const AnalyticsView: ComponentType<{ embedded?: boolean }> = Analytics;

function isProgressTab(value: string | null): value is ProgressTab {
  return TABS.some((t) => t.id === value);
}

function formatRunDate(key: string): string {
  if (!isDateKey(key)) return key;
  return parseDateKey(key).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatSignedPct(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function ratingChipVariant(rating: DecouplingRating): string {
  switch (rating) {
    case 'excellent':
      return 'is-up';
    case 'good':
      return 'is-info';
    case 'moderate':
      return 'is-warn';
    case 'high':
      return 'is-down';
  }
}

function ratingLabel(rating: DecouplingRating): string {
  switch (rating) {
    case 'excellent':
      return 'Excellent';
    case 'good':
      return 'Coupled';
    case 'moderate':
      return 'Moderate drift';
    case 'high':
      return 'High drift';
  }
}

function decouplingAccentColor(pct: number): string {
  if (pct <= 3.5) return 'var(--color-success)';
  if (pct <= 5.0) return 'var(--apollo-teal)';
  if (pct <= 8.0) return 'var(--color-warning)';
  return 'var(--color-error-text)';
}

/**
 * Aerobic Durability (`Pa:HR` & Efficiency Factor) card.
 * Evaluates cardiac drift and aerobic efficiency strictly on steady-state runs (>= 40 min)
 * with valid per-split heart-rate data.
 */
export function AerobicDurabilitySection() {
  const version = useStoreVersion();
  const { durability, unit } = useMemo(() => {
    void version;
    return {
      durability: buildAerobicDurabilityOverview(),
      unit: getDistanceUnit(),
    };
  }, [version]);

  const {
    steadyRuns,
    longRuns,
    avgLongRunDecouplingPct,
    avgSteadyDecouplingPct,
    longRunCoupled,
    latestEF,
    efChangePct,
    efTrend,
  } = durability;

  const recentRows = steadyRuns.slice(0, MAX_RECENT_STEADY_RUNS);

  return (
    <section className="card" aria-labelledby="progress-durability-title" data-testid="aerobic-durability-section">
      <div className="progress-card-head">
        <h2 id="progress-durability-title" className="card-title">
          Aerobic Durability (Pa:HR &amp; Efficiency Factor)
        </h2>
        {longRunCoupled !== null && (
          <span
            className={`progress-chip ${longRunCoupled ? 'is-up' : 'is-warn'}`}
            style={{ textTransform: 'none' }}
            data-testid="decoupling-readiness-badge"
          >
            {longRunCoupled ? '≤ 5% Coupled' : '> 5% Cardiac Drift'}
          </span>
        )}
      </div>

      <p className="progress-intro">
        Aerobic decoupling (<strong>Pa:HR</strong>) compares first-half vs. second-half{' '}
        <strong>Efficiency Factor</strong> (speed in m/min divided by heart rate) on continuous steady runs, with the
        halves split by moving time. Holding Pa:HR at or below 5% on long runs signals marathon-ready aerobic
        durability.
      </p>

      {steadyRuns.length === 0 ? (
        <p className="progress-muted" data-testid="aerobic-durability-empty">
          No steady-state runs (≥ 40 min) with heart-rate splits stored yet. Sync or import steady easy and long runs
          with heart-rate data to track Pa:HR cardiac drift and Efficiency Factor (m/min/bpm).
        </p>
      ) : (
        <>
          <div className="progress-stats">
            <div>
              <div className="progress-stat-label">Long-Run Pa:HR (≥ 60m)</div>
              {avgLongRunDecouplingPct !== null ? (
                <>
                  <div
                    className="progress-stat-value progress-num"
                    style={{ color: decouplingAccentColor(avgLongRunDecouplingPct) }}
                  >
                    {formatSignedPct(avgLongRunDecouplingPct)}
                  </div>
                  <div className="progress-small progress-muted">
                    {longRuns.length} steady long {longRuns.length === 1 ? 'run' : 'runs'} ·{' '}
                    {longRunCoupled ? '≤ 5% coupled base' : 'aim for ≤ 5%'}
                  </div>
                </>
              ) : (
                <>
                  <div className="progress-stat-value progress-num" style={{ color: 'var(--text-secondary)' }}>
                    {avgSteadyDecouplingPct !== null ? formatSignedPct(avgSteadyDecouplingPct) : '—'}
                  </div>
                  <div className="progress-small progress-muted">
                    40–59m steady avg · log a 60m+ long run for marathon badge
                  </div>
                </>
              )}
            </div>

            <div>
              <div className="progress-stat-label">Latest Efficiency Factor</div>
              <div
                className="progress-stat-value progress-num"
                style={{ color: 'var(--apollo-gold)' }}
                data-testid="latest-ef-value"
              >
                {formatEfficiencyFactor(latestEF, false)}{' '}
                <span className="progress-small" style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>
                  m/min/bpm
                </span>
              </div>
              <div className="progress-small progress-muted">Higher EF = more ground covered per heartbeat</div>
            </div>

            <div>
              <div className="progress-stat-label">EF Trend</div>
              {efTrend === 'rising' && efChangePct !== null && (
                <>
                  <div className="progress-stat-value progress-num" style={{ color: 'var(--apollo-teal)' }}>
                    ▲ Rising ({formatSignedPct(efChangePct)})
                  </div>
                  <div className="progress-small progress-muted">Faster aerobic pace at the same heart rate</div>
                </>
              )}
              {efTrend === 'stable' && efChangePct !== null && (
                <>
                  <div className="progress-stat-value progress-num" style={{ color: 'var(--text)' }}>
                    → Steady ({formatSignedPct(efChangePct)})
                  </div>
                  <div className="progress-small progress-muted">Consistent aerobic economy across steady runs</div>
                </>
              )}
              {efTrend === 'declining' && efChangePct !== null && (
                <>
                  <div className="progress-stat-value progress-num" style={{ color: 'var(--color-warning)' }}>
                    ▼ Dipping ({formatSignedPct(efChangePct)})
                  </div>
                  <div className="progress-small progress-muted">
                    Check heat, hydration, or cumulative training fatigue
                  </div>
                </>
              )}
              {efTrend === 'insufficient' && (
                <>
                  <div className="progress-stat-value" style={{ color: 'var(--text-secondary)' }}>
                    Baseline
                  </div>
                  <div className="progress-small progress-muted">Log 2+ steady runs to track EF progression</div>
                </>
              )}
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="progress-table">
              <caption className="progress-table-caption">
                Recent steady aerobic runs ≥ 40 min (interval and varied-pace workouts excluded).
              </caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Run</th>
                  <th scope="col">Distance</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Avg HR</th>
                  <th scope="col">EF (m/min/bpm)</th>
                  <th scope="col">Pa:HR</th>
                </tr>
              </thead>
              <tbody>
                {recentRows.map((run) => (
                  <tr key={run.activityId}>
                    <td className="progress-num">{formatRunDate(run.date)}</td>
                    <th scope="row">{run.activityName}</th>
                    <td className="progress-num">{formatMiles(run.distanceMi, 1, unit)}</td>
                    <td className="progress-num">{formatDuration(run.movingTimeSec)}</td>
                    <td className="progress-num">{run.avgHR} bpm</td>
                    <td className="progress-num" style={{ color: 'var(--apollo-gold)' }}>
                      {formatEfficiencyFactor(run.efOverall, false)}
                    </td>
                    <td className="progress-num">
                      <span
                        className={`progress-chip ${ratingChipVariant(run.rating)}`}
                        style={{ textTransform: 'none' }}
                      >
                        {formatSignedPct(run.decouplingPct)} · {ratingLabel(run.rating)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** Fitness & Form tab: CTL / ATL / TSB chart with the race date marked. */
function FitnessPanel() {
  const version = useStoreVersion();
  const raceDate = useMemo(() => {
    void version; // re-read the race date when the plan changes
    return getRaceDate();
  }, [version]);
  return (
    <section className="card" aria-labelledby="progress-fitness-title">
      <h2 id="progress-fitness-title" className="card-title">
        Fitness &amp; Form
      </h2>
      <p className="progress-intro">
        Fitness is your long-term training load, fatigue the load of the last week, and form the difference between
        them. Aim to reach race day with positive form.
      </p>
      <FitnessFormChart raceDate={raceDate} />
    </section>
  );
}

function ActivePanel({ tab }: { tab: ProgressTab }) {
  switch (tab) {
    case 'fitness':
      return <FitnessPanel />;
    case 'trends':
      return <AnalyticsView embedded />;
    case 'heart-rate':
      return (
        <>
          <HeartRatePanel />
          <AerobicDurabilitySection />
        </>
      );
    case 'recaps':
      return <RecapsPanel />;
    default:
      return <OverviewPanel />;
  }
}

/** The Progress page (route `/progress`). */
export default function Progress() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: ProgressTab = isProgressTab(requested) ? requested : 'overview';
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? 'Overview';

  const version = useStoreVersion();
  const showConnect = useMemo(() => {
    void version; // re-check after a sync or import
    return !isActivitySourceConnected() && !hasActivityData();
  }, [version]);

  const selectTab = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="progress-page">
      <h1 className="page-title">Progress</h1>

      {showConnect && (
        <ConnectDataSourceCTA description="Connect a data source or import activity files to see fitness, trends, heart-rate zones and recaps. A race prediction only needs a recent race in Settings › Athlete Profile." />
      )}

      <Tabs label="Progress sections" tabs={TABS} value={tab} onChange={selectTab} idPrefix={ID_PREFIX} />
      <TabPanel idPrefix={ID_PREFIX} id={tab}>
        <ErrorBoundary variant="inline" label={activeLabel} resetKey={tab}>
          <ActivePanel tab={tab} />
        </ErrorBoundary>
      </TabPanel>
    </div>
  );
}
