import { useState, useEffect, useMemo, useId, useRef, type CSSProperties } from 'react';
import {
  getActivities,
  getActivityDetail,
  queryStoredActivities,
  hasActivityData,
  onActivitiesUpdated,
  onSyncStatus,
  isSyncRunning,
  getSourceDisplayName,
  getActivityExternalUrl,
  type Activity,
} from '../services/activitySource';
import {
  isRunActivity,
  isRideActivity,
  getSportCategory,
  getSportCategoryIcon,
  getSportIcon,
  getSportLabel,
} from '../services/activity/sports';
import { estimateActivityLoad } from '../services/crossTraining';
import { getHRProfile } from '../services/heartRate';
import RouteMap, { RouteMapThumbnail } from '../components/RouteMap';
import { processRoute, getPolylineForActivity, bearingToCompass } from '../services/routeService';
import {
  processActivityEffort,
  getEffortRecognition,
  type EffortInsight,
} from '../services/effortService';
import { TIER_CONFIG, TierBadge, TierDot } from '../components/TierBadge';
import ConnectDataSourceCTA from '../components/ConnectDataSourceCTA';
import ImportActivities from '../components/ImportActivities';
import type { ImportResult } from '../services/fileImport';
import { describeImportResult } from '../services/fileImport/job';
import {
  analyzeSplits,
  getCachedSplitAnalysis,
  hasSplitData,
  type SplitAnalysis as SplitAnalysisType,
} from '../services/splitService';
import { SplitAnalysisPanel, SplitSummaryBadge } from '../components/SplitAnalysis';
import {
  formatDistance as fmtDist,
  formatPace as fmtPace,
  formatElevation as fmtElev,
  formatDuration as fmtDur,
  formatSpeed as fmtSpeed,
} from '../services/unitPreferences';

const PAGE_SIZE = 30;

type SportFilter = 'all' | 'run' | 'ride' | 'other';

const SPORT_FILTERS: { key: SportFilter; label: string; icon?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'run', label: 'Runs', icon: getSportCategoryIcon('run') },
  { key: 'ride', label: 'Rides', icon: getSportCategoryIcon('ride') },
  { key: 'other', label: 'Other', icon: getSportCategoryIcon('other') },
];

function sportFilterOf(a: Activity): Exclude<SportFilter, 'all'> {
  if (isRunActivity(a)) return 'run';
  if (isRideActivity(a)) return 'ride';
  return 'other';
}

/** Effort recognition only applies to runs with GPS — the service ignores everything else. */
function processEfforts(list: Activity[]): void {
  for (const a of list) {
    try { processActivityEffort(a); } catch { /* non-critical */ }
  }
}

/** Source-computed training load, or an estimate (HR- or duration-based). */
function getLoadInfo(a: Activity, maxHR: number): { value: number; estimated: boolean } | null {
  const value = Math.round(estimateActivityLoad(a, maxHR));
  if (value <= 0) return null;
  return { value, estimated: !(typeof a.training_load === 'number' && a.training_load > 0) };
}

/** Upstream platform reported by intervals.icu, e.g. "GARMIN_CONNECT" → "Garmin Connect". */
const HIDDEN_ORIGINS = new Set(['UPLOAD', 'OAUTH_CLIENT', 'MANUAL', 'UNKNOWN', 'STRAVA']);
function formatOrigin(origin: string | undefined): string | null {
  if (!origin || HIDDEN_ORIGINS.has(origin.toUpperCase())) return null;
  return origin
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function formatDate(dateStr: string): string {
  // start_date_local is wall-clock time with a trailing "Z" that is NOT UTC — use the calendar date only.
  const day = /^\d{4}-\d{2}-\d{2}/.test(dateStr) ? dateStr.slice(0, 10) : null;
  if (!day) return dateStr;
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

const PILL_STYLE: CSSProperties = {
  fontSize: '0.66rem',
  fontWeight: 600,
  fontFamily: 'var(--font-display)',
  padding: '0.08rem 0.45rem',
  borderRadius: 'var(--radius-full)',
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
};

/** Where the activity was synced from, plus an "Indoor" pill for trainer / Zwift / treadmill sessions. */
function SourceBadges({ activity }: { activity: Activity }) {
  const isIntervals = activity.source === 'intervals';
  const isFile = activity.source === 'file';
  return (
    <>
      <span style={isFile
        ? { ...PILL_STYLE, background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }
        : {
          ...PILL_STYLE,
          background: isIntervals ? 'var(--apollo-teal-dim)' : 'rgba(252, 76, 2, 0.12)',
          color: isIntervals ? 'var(--apollo-teal)' : 'var(--strava)',
        }}>
        {getSourceDisplayName(activity.source)}
      </span>
      {activity.trainer && (
        <span style={{ ...PILL_STYLE, background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}>
          Indoor
        </span>
      )}
    </>
  );
}

interface RowMetric { value: string; unit?: string; color?: string }

/** Up to three compact, sport-appropriate metrics for the list row. */
function getRowMetrics(a: Activity, maxHR: number): RowMetric[] {
  const hr = a.average_heartrate ?? 0;
  const elev = a.total_elevation_gain ?? 0;
  const hrMetric: RowMetric = { value: String(Math.round(hr)), unit: 'bpm', color: 'var(--color-error)' };
  const elevMetric: RowMetric = { value: `+${fmtElev(elev)}`, color: 'var(--apollo-teal)' };
  const out: RowMetric[] = [];

  if (isRunActivity(a)) {
    out.push({ value: (a.average_speed ?? 0) > 0 ? fmtPace(a.distance, a.moving_time) : '—' });
    if (elev > 0) out.push(elevMetric);
    if (hr > 0) out.push(hrMetric);
    return out;
  }

  if (isRideActivity(a)) {
    out.push({ value: fmtSpeed(a.average_speed) });
    const watts = a.average_watts ?? 0;
    const np = a.weighted_average_watts ?? 0;
    if (watts > 0) {
      out.push({ value: `${Math.round(watts)} W`, unit: np > 0 ? `NP ${Math.round(np)}` : undefined, color: 'var(--apollo-orange)' });
    }
    if (hr > 0) out.push(hrMetric);
    else if (elev > 0) out.push(elevMetric);
    return out;
  }

  if (hr > 0) out.push(hrMetric);
  const load = getLoadInfo(a, maxHR);
  if (load) out.push({ value: String(load.value), unit: 'load', color: 'var(--color-warning)' });
  return out.length > 0 ? out : [{ value: '—' }];
}

/** Stat cell for the expanded detail grid */
function DetailStat({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={{
      background: 'var(--bg-surface)',
      borderRadius: 'var(--radius-sm)',
      padding: '0.65rem 0.75rem',
      textAlign: 'center',
    }}>
      <div style={{
        fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--text-muted)', fontFamily: 'var(--font-display)', fontWeight: 500, marginBottom: '0.2rem',
      }}>{label}</div>
      <div style={{
        fontSize: '1.1rem', fontWeight: 700, fontFamily: 'var(--font-display)', color, lineHeight: 1.2,
      }}>{value}</div>
      {sub && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>{sub}</div>}
    </div>
  );
}

const INSIGHT_BORDER: Record<EffortInsight['sentiment'], string> = {
  positive: 'var(--color-success)',
  neutral: 'var(--border)',
  negative: 'var(--color-warning)',
};

/** Data-driven recognition panel shown in the expanded activity detail */
function EffortRecognitionPanel({ activityId }: { activityId: number }) {
  const recognition = getEffortRecognition(activityId);
  if (!recognition) return null;
  if (recognition.insights.length === 0 && !recognition.paceTier && !recognition.hrEfficiencyTier) return null;

  const borderColor = recognition.paceTier === 'gold' ? 'var(--apollo-gold)'
    : recognition.paceTier === 'silver' ? 'var(--text-secondary)'
    : recognition.paceTier === 'bronze' ? '#CD7F32'
    : 'var(--border)';

  return (
    <div style={{
      marginTop: '1rem',
      padding: '0.85rem 1rem',
      background: 'rgba(212, 165, 55, 0.03)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border)',
      borderLeftWidth: 3,
      borderLeftColor: borderColor,
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: recognition.insights.length > 0 ? '0.6rem' : 0,
      }}>
        <span style={{
          fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.08em',
          color: 'var(--text-muted)',
        }}>
          Effort #{recognition.effortNumber} · {recognition.routeName}
        </span>
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          {recognition.paceTier && <TierBadge tier={recognition.paceTier} />}
          {recognition.hrEfficiencyTier && recognition.hrEfficiencyTier !== recognition.paceTier && (
            <span style={{
              fontSize: '0.68rem', fontWeight: 600, padding: '0.12rem 0.5rem',
              borderRadius: 'var(--radius-full)',
              background: TIER_CONFIG[recognition.hrEfficiencyTier].bg,
              color: TIER_CONFIG[recognition.hrEfficiencyTier].color,
              fontFamily: 'var(--font-display)',
            }}>
              HR Efficiency {TIER_CONFIG[recognition.hrEfficiencyTier].label.split(' ')[0]}
            </span>
          )}
        </div>
      </div>

      {/* Insights */}
      {recognition.insights.map((insight, i) => (
        <div key={i} style={{
          fontSize: 'var(--text-sm)',
          color: insight.sentiment === 'positive' ? 'var(--text)' : 'var(--text-secondary)',
          lineHeight: 1.5,
          padding: '0.25rem 0 0.25rem 0.75rem',
          borderLeft: `2px solid ${INSIGHT_BORDER[insight.sentiment]}`,
          marginBottom: i < recognition.insights.length - 1 ? '0.35rem' : 0,
        }}>
          {insight.message}
        </div>
      ))}
    </div>
  );
}

/** Expanded detail panel: route map (any sport with GPS), sport-specific stats, split analysis for runs */
function ActivityDetail({ activity, maxHR }: { activity: Activity; maxHR: number }) {
  const isRun = isRunActivity(activity);
  const isRide = !isRun && isRideActivity(activity);
  const [detail, setDetail] = useState<Activity>(activity);
  const [splitAnalysis, setSplitAnalysis] = useState<SplitAnalysisType | null>(
    () => (isRun ? getCachedSplitAnalysis(activity.id) : null),
  );
  const [loadingDetail, setLoadingDetail] = useState(false);
  const polyline = getPolylineForActivity(detail);
  const route = useMemo(() => (polyline ? processRoute(polyline) : null), [polyline]);

  // Fetch full detail from the source it was synced from: splits (runs) and GPS route (outdoor sessions)
  useEffect(() => {
    let wantSplits = isRun && !getCachedSplitAnalysis(activity.id);
    if (wantSplits && hasSplitData(activity)) {
      const result = analyzeSplits(activity);
      if (result) setSplitAnalysis(result);
      wantSplits = false;
    }
    const wantRoute = !activity.trainer
      && getSportCategory(activity) !== 'strength'
      && !getPolylineForActivity(activity);
    if (!wantSplits && !wantRoute) return;

    let cancelled = false;
    setLoadingDetail(true);
    getActivityDetail(activity)
      .then((detailed) => {
        if (cancelled) return;
        setDetail(detailed);
        if (wantSplits && hasSplitData(detailed)) {
          const result = analyzeSplits(detailed);
          if (result) setSplitAnalysis(result);
        }
        // A newly discovered route enables effort recognition for this run
        if (isRun && detailed.map?.summary_polyline && !activity.map?.summary_polyline) {
          processEfforts([detailed]);
        }
      })
      .catch(() => { /* non-critical — keep showing the summary */ })
      .finally(() => { if (!cancelled) setLoadingDetail(false); });
    return () => { cancelled = true; };
  }, [activity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const a = detail;
  const hr = a.average_heartrate ?? 0;
  const elev = a.total_elevation_gain ?? 0;
  const cadence = a.average_cadence ?? 0;
  const watts = a.average_watts ?? 0;
  const np = a.weighted_average_watts ?? 0;
  const load = getLoadInfo(a, maxHR);
  const externalUrl = getActivityExternalUrl(a);
  const sourceName = getSourceDisplayName(a.source);
  const origin = formatOrigin(a.origin);
  const showRoutePlaceholder = !polyline && getSportCategory(a) !== 'strength';

  return (
    <div style={{ padding: '1rem 0 0.5rem', animation: 'slideUp 0.25s ease' }}>
      {/* Route map — any sport with GPS */}
      {polyline ? (
        <RouteMap activity={a} size="card" colorMode={isRun ? 'apollo' : 'teal'} animate={true} />
      ) : showRoutePlaceholder ? (
        <div style={{
          height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
          color: 'var(--text-muted)', fontSize: 'var(--text-sm)', fontFamily: 'var(--font-display)',
        }}>
          {loadingDetail ? 'Looking for route data…' : a.trainer ? 'Indoor session — no GPS route' : 'No route data for this activity'}
        </div>
      ) : null}

      {/* Stats grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: '0.75rem', marginTop: '0.85rem',
      }}>
        {(isRun || a.distance > 0) && (
          <DetailStat label="Distance" value={fmtDist(a.distance)} color="var(--apollo-gold)" />
        )}
        <DetailStat label="Duration" value={fmtDur(a.moving_time || a.elapsed_time)}
          sub={a.elapsed_time > a.moving_time && a.moving_time > 0 ? `${fmtDur(a.elapsed_time)} elapsed` : undefined}
          color="var(--text)" />
        {isRun && (
          <DetailStat label="Pace" value={fmtPace(a.distance, a.moving_time)} color="var(--apollo-teal)" />
        )}
        {isRide && (
          <DetailStat label="Avg Speed" value={fmtSpeed(a.average_speed)}
            sub={a.max_speed ? `max ${fmtSpeed(a.max_speed)}` : undefined}
            color="var(--apollo-teal)" />
        )}
        {watts > 0 && (
          <DetailStat label="Power" value={`${Math.round(watts)} W`}
            sub={np > 0 ? `NP ${Math.round(np)} W` : 'average'}
            color="var(--apollo-orange)" />
        )}
        {elev > 0 && (
          <DetailStat label="Elevation" value={fmtElev(elev)} color="var(--color-success)" />
        )}
        {hr > 0 && (
          <DetailStat label="Heart Rate" value={`${Math.round(hr)}`}
            sub={a.max_heartrate ? `max ${Math.round(a.max_heartrate)}` : undefined}
            color="var(--color-error)" />
        )}
        {cadence > 0 && (isRun || isRide) && (
          <DetailStat label="Cadence" value={`${Math.round(isRun ? cadence * 2 : cadence)}`}
            sub={isRun ? 'spm' : 'rpm'} color="var(--apollo-orange)" />
        )}
        {route && (
          <DetailStat label="Route" value={route.isLoop ? 'Loop' : bearingToCompass(route.bearing)}
            sub={route.isLoop ? '↻ out & back' : `bearing ${Math.round(route.bearing)}°`}
            color="var(--apollo-cream)" />
        )}
        {load && (!isRun || !load.estimated) && (
          <DetailStat label="Training Load" value={String(load.value)}
            sub={load.estimated ? 'estimated' : undefined} color="var(--color-warning)" />
        )}
        {a.suffer_score != null && a.suffer_score > 0 && (
          <DetailStat label="Suffer Score" value={String(a.suffer_score)} color="var(--color-warning)" />
        )}
        {a.calories != null && a.calories > 0 && (
          <DetailStat label="Calories" value={String(Math.round(a.calories))} sub="kcal" color="var(--text-secondary)" />
        )}
      </div>

      {/* Split analysis (runs only) */}
      {isRun && splitAnalysis && <SplitAnalysisPanel analysis={splitAnalysis} />}
      {isRun && loadingDetail && !splitAnalysis && (
        <div style={{
          marginTop: '0.75rem', padding: '0.6rem', textAlign: 'center',
          color: 'var(--text-muted)', fontSize: 'var(--text-sm)',
        }}>
          <span style={{ animation: 'breathe 2s ease-in-out infinite' }}>Loading split data…</span>
        </div>
      )}

      {/* Effort recognition: data-driven route comparisons & achievements (runs only) */}
      {isRun && <EffortRecognitionPanel activityId={a.id} />}

      {/* Provenance + link to the source platform */}
      <div style={{
        marginTop: '0.85rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: '0.75rem', flexWrap: 'wrap', fontSize: '0.78rem', color: 'var(--text-muted)',
      }}>
        <span>
          {getSportLabel(a)}
          {a.device_name ? ` · ${a.device_name}` : ''}
          {origin ? ` · from ${origin}` : ''}
          {a.source === 'file' ? ' · imported from a file' : ` · synced via ${sourceName}`}
        </span>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontFamily: 'var(--font-display)', fontWeight: 600, textDecoration: 'none' }}
          >
            View on {sourceName} ↗
          </a>
        )}
      </div>
    </div>
  );
}

export default function Activities() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [sportFilter, setSportFilter] = useState<SportFilter>('all');
  const [syncMessage, setSyncMessage] = useState<string | null>(() => (isSyncRunning() ? 'Syncing activities…' : null));
  // Connected now, or history synced earlier (browsable offline). Computed once — it reads the whole store.
  const [available, setAvailable] = useState(hasActivityData);
  // "Import files" panel. The import runs as an app-wide job, so hiding the panel doesn't stop it.
  const [showImport, setShowImport] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const importPanelId = useId();
  const importPanelRef = useRef<HTMLDivElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const maxHR = getHRProfile().maxHR;

  useEffect(() => {
    if (!available) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setError(null);
    // Show the stored page immediately; the facade refreshes from connected sources when stale.
    const cached = queryStoredActivities({ page, per_page: PAGE_SIZE });
    setActivities(cached);
    setLoading(cached.length === 0);
    getActivities({ page, per_page: PAGE_SIZE })
      .then((data) => {
        if (cancelled) return;
        setActivities(data);
        processEfforts(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load activities');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [available, page]);

  // Background syncs store new or edited activities — refresh the current page from the local store.
  useEffect(() => onActivitiesUpdated((summary) => {
    // First data on this device (e.g. a file import): leave the empty state; the effect above loads it.
    if (!available) {
      setAvailable(true);
      // Imported from the empty-state card, which unmounts now: keep the import's progress and result in view.
      if (summary.sources.includes('file')) setShowImport(true);
      return;
    }
    const list = queryStoredActivities({ page, per_page: PAGE_SIZE });
    setActivities(list);
    setError(null);
    processEfforts(list);
  }), [available, page]);

  // Surface sync progress (the first sync imports the full history and can take a while).
  useEffect(() => onSyncStatus((status) => {
    setSyncMessage(status.running ? (status.progress?.message ?? 'Syncing activities…') : null);
  }), []);

  // The header confirmation of a finished import clears itself.
  useEffect(() => {
    if (!importNote) return;
    const timer = window.setTimeout(() => setImportNote(null), 8000);
    return () => window.clearTimeout(timer);
  }, [importNote]);

  /**
   * After a clean import, close the panel (the list refreshes via onActivitiesUpdated) and confirm it in the
   * header. Keep it open, with the result in view, when nothing new came in or there are errors, skipped files
   * or a cancel.
   */
  const handleImported = (result: ImportResult): void => {
    const clean = result.added + result.updated > 0
      && result.errors.length === 0 && result.skipped.length === 0 && !result.cancelled;
    if (!clean) return;
    // The panel is about to unmount: hand keyboard focus back to its toggle instead of dropping it.
    const active = document.activeElement;
    if (!active || active === document.body || importPanelRef.current?.contains(active)) {
      importButtonRef.current?.focus({ preventScroll: true });
    }
    setShowImport(false);
    setImportNote(describeImportResult(result));
  };

  if (!available) {
    return (
      <div>
        <h1 className="page-title">Activities</h1>
        <ConnectDataSourceCTA
          emoji="🏅"
          title="Your Hall of Victories"
          description="Connect a data source or import your files to see every run, ride and workout catalogued here — every session is an achievement."
        />
        {/* No account needed. Once activities land, onActivitiesUpdated swaps this view for the list. */}
        <ImportActivities compact />
      </div>
    );
  }

  const counts: Record<SportFilter, number> = { all: activities.length, run: 0, ride: 0, other: 0 };
  for (const a of activities) counts[sportFilterOf(a)] += 1;
  const visible = sportFilter === 'all' ? activities : activities.filter((a) => sportFilterOf(a) === sportFilter);
  const activeFilterLabel = SPORT_FILTERS.find((f) => f.key === sportFilter)?.label.toLowerCase() ?? 'activities';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)',
          fontWeight: 700, margin: 0, color: 'var(--text)',
        }}>Activities</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <span role="status" style={{
            fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600,
            textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)',
          }}>
            {syncMessage && !loading
              ? <span style={{ color: 'var(--apollo-teal)', textTransform: 'none', letterSpacing: 0 }}>⟳ {syncMessage}</span>
              : importNote
                ? <span style={{ color: 'var(--color-success)', textTransform: 'none', letterSpacing: 0 }}>✓ {importNote}</span>
                : activities.length > 0 ? `${activities.length} ${activities.length === 1 ? 'activity' : 'activities'} loaded` : ''}
          </span>
          <button
            ref={importButtonRef}
            type="button"
            className="btn btn-secondary"
            aria-expanded={showImport}
            aria-controls={showImport ? importPanelId : undefined}
            onClick={() => setShowImport((open) => !open)}
            style={{ fontSize: 'var(--text-sm)' }}
          >
            {showImport ? 'Hide import' : 'Import files'}
          </button>
        </div>
      </div>

      {/* Import activity files (toggled from the header) */}
      {showImport && (
        <div id={importPanelId} ref={importPanelRef}>
          <ImportActivities onImported={handleImported} />
        </div>
      )}

      {/* Sport filter */}
      <div role="group" aria-label="Filter by sport" style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        {SPORT_FILTERS.map((f) => {
          const isActive = sportFilter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setSportFilter(f.key)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                padding: '0.4rem 0.85rem', borderRadius: 'var(--radius-full)',
                border: isActive ? '1px solid var(--apollo-gold)' : '1px solid var(--border)',
                background: isActive ? 'var(--apollo-gold-dim)' : 'var(--bg-elevated)',
                color: isActive ? 'var(--apollo-gold)' : 'var(--text-secondary)',
                fontSize: '0.78rem', fontFamily: 'var(--font-display)', fontWeight: 600,
                cursor: 'pointer', transition: 'all var(--transition-fast)',
              }}
            >
              {f.icon && <span aria-hidden="true">{f.icon}</span>}
              {f.label}
              <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>{counts[f.key]}</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="card" role="alert" style={{ background: 'var(--color-error-dim)', borderColor: 'var(--color-error)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--color-error)', fontWeight: 600 }}>Error:</span> {error}
        </div>
      )}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
          <div style={{ color: 'var(--apollo-gold)', fontSize: '1.2rem', marginBottom: '0.5rem', animation: 'breathe 2s ease-in-out infinite' }}>⚡</div>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>{syncMessage ?? 'Loading your victories…'}</p>
        </div>
      ) : (
        <>
          {visible.length === 0 && !error && (
            <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
              <p style={{ color: 'var(--text-muted)', margin: 0 }}>
                {activities.length === 0
                  ? (page > 1
                    ? 'No more activities.'
                    : 'No activities yet. Your first sync imports your full history — new sessions appear here automatically. Have files or a Strava/Garmin export? Use Import files above.')
                  : `No ${activeFilterLabel} on this page — try another filter or page.`}
              </p>
            </div>
          )}
          {visible.length > 0 && <div className="card" style={{ padding: '0.75rem 1.5rem' }}>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {visible.map((a, idx) => {
                const isExpanded = expandedId === a.id;
                const hasRoute = !!(a.map?.summary_polyline);
                const isRun = isRunActivity(a);
                const recognition = isRun ? getEffortRecognition(a.id) : null;
                const topTier = recognition?.paceTier ?? recognition?.hrEfficiencyTier ?? null;
                const cachedSplits = isRun ? getCachedSplitAnalysis(a.id) : null;
                const metrics = getRowMetrics(a, maxHR);

                return (
                  <li key={a.id} style={{ borderBottom: idx < visible.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    {/* Main row — click to expand */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      onClick={() => setExpandedId(isExpanded ? null : a.id)}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
                        e.preventDefault();
                        setExpandedId(isExpanded ? null : a.id);
                      }}
                      style={{
                        padding: '1rem 0',
                        display: 'grid',
                        gridTemplateColumns: hasRoute ? '64px 1fr auto auto' : '1fr auto auto',
                        gap: '1rem',
                        alignItems: 'center',
                        cursor: 'pointer',
                        transition: 'background var(--transition-fast)',
                        borderRadius: 'var(--radius-sm)',
                        marginLeft: '-0.5rem', marginRight: '-0.5rem',
                        paddingLeft: '0.5rem', paddingRight: '0.5rem',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* Route thumbnail */}
                      {hasRoute && <RouteMapThumbnail activity={a} />}

                      {/* Sport, name & date */}
                      <div style={{ minWidth: 0 }}>
                        <strong style={{
                          fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-base)',
                          display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          <span aria-hidden="true" style={{ marginRight: '0.4rem' }}>{getSportIcon(a)}</span>
                          {a.name || getSportLabel(a)}
                          {topTier && <TierDot tier={topTier} />}
                        </strong>
                        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: '0.15rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                          <span>{formatDate(a.start_date_local)} · {getSportLabel(a)}</span>
                          <SourceBadges activity={a} />
                          {cachedSplits && <SplitSummaryBadge analysis={cachedSplits} />}
                        </div>
                      </div>

                      {/* Distance & time (duration only when there is no distance) */}
                      <div style={{ textAlign: 'right', fontSize: 'var(--text-sm)' }}>
                        {a.distance > 0 ? (
                          <>
                            <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>{fmtDist(a.distance)}</span><br />
                            <span style={{ color: 'var(--text-muted)' }}>{fmtDur(a.moving_time)}</span>
                          </>
                        ) : (
                          <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>{fmtDur(a.moving_time || a.elapsed_time)}</span>
                        )}
                      </div>

                      {/* Sport-specific metrics */}
                      <div style={{ textAlign: 'right', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', minWidth: 80 }}>
                        {metrics.slice(0, 3).map((m, i) => (
                          <div key={i} style={{ whiteSpace: 'nowrap' }}>
                            <span style={m.color ? { color: m.color } : undefined}>{m.value}</span>
                            {m.unit && <span style={{ color: 'var(--text-muted)' }}> {m.unit}</span>}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Expanded detail panel */}
                    {isExpanded && <ActivityDetail activity={a} maxHR={maxHR} />}
                  </li>
                );
              })}
            </ul>
          </div>}
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1.25rem', alignItems: 'center' }}>
            <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ fontSize: 'var(--text-sm)' }}>← Previous</button>
            <span style={{
              color: 'var(--apollo-gold)', fontFamily: 'var(--font-display)',
              fontWeight: 600, fontSize: 'var(--text-sm)',
              padding: '0.35rem 0.75rem', borderRadius: 'var(--radius-sm)',
              background: 'var(--apollo-gold-dim)',
            }}>Page {page}</span>
            <button type="button" className="btn btn-secondary" disabled={activities.length < PAGE_SIZE} onClick={() => setPage((p) => p + 1)} style={{ fontSize: 'var(--text-sm)' }}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
