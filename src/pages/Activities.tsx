import { useState, useEffect } from 'react';
import { getActivities, getActivityDetail, type StravaActivity } from '../services/strava';
import { getStravaTokens } from '../services/storage';
import RouteMap, { RouteMapThumbnail } from '../components/RouteMap';
import { processRoute, getPolylineForActivity, bearingToCompass } from '../services/routeService';
import {
  processActivityEffort,
  getEffortRecognition,
  type EffortInsight,
} from '../services/effortService';
import { TIER_CONFIG, TierBadge, TierDot } from '../components/TierBadge';
import ConnectStravaCTA from '../components/ConnectStravaCTA';
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
} from '../services/unitPreferences';

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
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

/** Expanded detail panel for a single activity with route map and split analysis */
function ActivityDetail({ activity }: { activity: StravaActivity }) {
  const polyline = getPolylineForActivity(activity);
  const route = polyline ? processRoute(polyline) : null;
  const [splitAnalysis, setSplitAnalysis] = useState<SplitAnalysisType | null>(
    () => getCachedSplitAnalysis(activity.id),
  );
  const [loadingSplits, setLoadingSplits] = useState(false);

  // Auto-load split data if not cached
  useEffect(() => {
    if (splitAnalysis) return;
    if (hasSplitData(activity)) {
      // Activity already has split data (from detail fetch)
      const result = analyzeSplits(activity);
      if (result) setSplitAnalysis(result);
      return;
    }
    // Fetch detailed activity to get splits
    let cancelled = false;
    setLoadingSplits(true);
    getActivityDetail(activity.id)
      .then((detailed) => {
        if (cancelled) return;
        if (hasSplitData(detailed)) {
          const result = analyzeSplits(detailed);
          if (result) setSplitAnalysis(result);
        }
      })
      .catch(() => { /* non-critical */ })
      .finally(() => { if (!cancelled) setLoadingSplits(false); });
    return () => { cancelled = true; };
  }, [activity.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: '1rem 0 0.5rem', animation: 'slideUp 0.25s ease' }}>
      {/* Route map */}
      {polyline ? (
        <RouteMap activity={activity} size="card" colorMode="apollo" animate={true} />
      ) : (
        <div style={{
          height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
          color: 'var(--text-muted)', fontSize: 'var(--text-sm)', fontFamily: 'var(--font-display)',
        }}>
          No route data for this activity
        </div>
      )}

      {/* Stats grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
        gap: '0.75rem', marginTop: '0.85rem',
      }}>
        <DetailStat label="Distance" value={fmtDist(activity.distance)} color="var(--apollo-gold)" />
        <DetailStat label="Duration" value={fmtDur(activity.moving_time)}
          sub={activity.elapsed_time > activity.moving_time ? `${fmtDur(activity.elapsed_time)} elapsed` : undefined}
          color="var(--text)" />
        <DetailStat label="Pace" value={fmtPace(activity.distance, activity.moving_time)} color="var(--apollo-teal)" />
        {activity.total_elevation_gain != null && activity.total_elevation_gain > 0 && (
          <DetailStat label="Elevation" value={fmtElev(activity.total_elevation_gain)} color="var(--color-success)" />
        )}
        {activity.average_heartrate != null && activity.average_heartrate > 0 && (
          <DetailStat label="Heart Rate" value={`${Math.round(activity.average_heartrate)}`}
            sub={activity.max_heartrate ? `max ${Math.round(activity.max_heartrate)}` : undefined}
            color="var(--color-error)" />
        )}
        {activity.average_cadence != null && activity.average_cadence > 0 && (
          <DetailStat label="Cadence" value={`${Math.round(activity.average_cadence * 2)}`} sub="spm" color="var(--apollo-orange)" />
        )}
        {route && (
          <DetailStat label="Route" value={route.isLoop ? 'Loop' : bearingToCompass(route.bearing)}
            sub={route.isLoop ? '↻ out & back' : `bearing ${Math.round(route.bearing)}°`}
            color="var(--apollo-cream)" />
        )}
        {activity.suffer_score != null && activity.suffer_score > 0 && (
          <DetailStat label="Suffer Score" value={String(activity.suffer_score)} color="var(--color-warning)" />
        )}
      </div>

      {/* Split analysis */}
      {splitAnalysis && <SplitAnalysisPanel analysis={splitAnalysis} />}
      {loadingSplits && (
        <div style={{
          marginTop: '0.75rem', padding: '0.6rem', textAlign: 'center',
          color: 'var(--text-muted)', fontSize: 'var(--text-sm)',
        }}>
          <span style={{ animation: 'breathe 2s ease-in-out infinite' }}>Loading split data…</span>
        </div>
      )}

      {/* Effort recognition: data-driven route comparisons & achievements */}
      <EffortRecognitionPanel activityId={activity.id} />
    </div>
  );
}

export default function Activities() {
  const [activities, setActivities] = useState<StravaActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const connected = !!getStravaTokens();

  useEffect(() => {
    if (!connected) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setError(null);
    setLoading(true);
    getActivities({ page, per_page: 30 })
      .then((data) => {
        if (!cancelled) {
          const list = data;
          setActivities(list);
          // Process effort recognitions for loaded activities
          for (const a of list) {
            try { processActivityEffort(a); } catch { /* non-critical */ }
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [connected, page]);

  if (!connected) {
    return (
      <div>
        <h1 className="page-title">Activities</h1>
        <ConnectStravaCTA
          emoji="🏅"
          title="Your Hall of Victories"
          description="Connect Strava to see all your activities catalogued here — every run is an achievement."
        />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.75rem', flexWrap: 'wrap', gap: '1rem' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)',
          fontWeight: 700, margin: 0, color: 'var(--text)',
        }}>Activities</h1>
        <span style={{
          fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)',
        }}>
          {activities.length > 0 ? `${activities.length} runs loaded` : ''}
        </span>
      </div>

      {error && (
        <div className="card" style={{ background: 'var(--color-error-dim)', borderColor: 'var(--color-error)', borderLeftWidth: 3, borderLeftStyle: 'solid' }}>
          <span style={{ color: 'var(--color-error)', fontWeight: 600 }}>Error:</span> {error}
        </div>
      )}

      {loading ? (
        <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
          <div style={{ color: 'var(--apollo-gold)', fontSize: '1.2rem', marginBottom: '0.5rem', animation: 'breathe 2s ease-in-out infinite' }}>⚡</div>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Loading your victories…</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: '0.75rem 1.5rem' }}>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {activities.map((a, idx) => {
                const isExpanded = expandedId === a.id;
                const hasRoute = !!(a.map?.summary_polyline);
                const recognition = getEffortRecognition(a.id);
                const topTier = recognition?.paceTier ?? recognition?.hrEfficiencyTier ?? null;
                const cachedSplits = getCachedSplitAnalysis(a.id);

                return (
                  <li key={a.id} style={{ borderBottom: idx < activities.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    {/* Main row — click to expand */}
                    <div
                      onClick={() => setExpandedId(isExpanded ? null : a.id)}
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

                      {/* Name & date */}
                      <div style={{ minWidth: 0 }}>
                        <strong style={{
                          fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-base)',
                          display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {a.name || a.type}
                          {topTier && <TierDot tier={topTier} />}
                        </strong>
                        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: '0.15rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                          <span>{formatDate(a.start_date_local)} · {a.sport_type || a.type}</span>
                          {cachedSplits && <SplitSummaryBadge analysis={cachedSplits} />}
                        </div>
                      </div>

                      {/* Distance & time */}
                      <div style={{ textAlign: 'right', fontSize: 'var(--text-sm)' }}>
                        <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>{fmtDist(a.distance)}</span><br />
                        <span style={{ color: 'var(--text-muted)' }}>{fmtDur(a.moving_time)}</span>
                      </div>

                      {/* Pace & metrics */}
                      <div style={{ textAlign: 'right', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', minWidth: 80 }}>
                        {a.average_speed != null && a.average_speed > 0 ? fmtPace(a.distance, a.moving_time) : '—'}
                        {a.total_elevation_gain != null && a.total_elevation_gain > 0 && (
                          <><br /><span style={{ color: 'var(--apollo-teal)' }}>+{fmtElev(a.total_elevation_gain)}</span></>
                        )}
                        {a.average_heartrate != null && a.average_heartrate > 0 && (
                          <><br /><span style={{ color: 'var(--color-error)' }}>{Math.round(a.average_heartrate)}</span> bpm</>
                        )}
                      </div>
                    </div>

                    {/* Expanded detail panel */}
                    {isExpanded && <ActivityDetail activity={a} />}
                  </li>
                );
              })}
            </ul>
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1.25rem', alignItems: 'center' }}>
            <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} style={{ fontSize: 'var(--text-sm)' }}>← Previous</button>
            <span style={{
              color: 'var(--apollo-gold)', fontFamily: 'var(--font-display)',
              fontWeight: 600, fontSize: 'var(--text-sm)',
              padding: '0.35rem 0.75rem', borderRadius: 'var(--radius-sm)',
              background: 'var(--apollo-gold-dim)',
            }}>Page {page}</span>
            <button type="button" className="btn btn-secondary" disabled={activities.length < 30} onClick={() => setPage((p) => p + 1)} style={{ fontSize: 'var(--text-sm)' }}>Next →</button>
          </div>
        </>
      )}
    </div>
  );
}
