import { useState, useEffect } from 'react';
import { getActivities, type StravaActivity } from '../services/strava';
import { getStravaTokens } from '../services/storage';
import { Link } from 'react-router-dom';
import RouteMap, { RouteMapThumbnail } from '../components/RouteMap';
import { processRoute, getPolylineForActivity, bearingToCompass } from '../services/routeService';
import {
  processActivityEffort,
  getEffortRecognition,
  type AchievementTier,
  type EffortInsight,
} from '../services/effortService';

function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

function formatDistanceMi(m: number): string {
  return `${(m * 0.000621371).toFixed(2)} mi`;
}

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatPaceMi(meters: number, seconds: number): string {
  if (!seconds || !meters) return '—';
  const mi = meters * 0.000621371;
  const minPerMi = (seconds / 60) / mi;
  const totalSec = Math.round(minPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

function formatPaceKm(meters: number, seconds: number): string {
  if (!seconds || !meters) return '—';
  const km = meters / 1000;
  const minPerKm = (seconds / 60) / km;
  const totalSec = Math.round(minPerKm * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/km`;
}

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

const TIER_COLORS: Record<AchievementTier, { label: string; color: string; bg: string }> = {
  gold: { label: 'Gold Split', color: 'var(--apollo-gold)', bg: 'var(--apollo-gold-dim)' },
  silver: { label: 'Silver Split', color: 'var(--text-secondary)', bg: 'rgba(184, 178, 168, 0.12)' },
  bronze: { label: 'Bronze Split', color: '#CD7F32', bg: 'rgba(205, 127, 50, 0.12)' },
};

function TierBadge({ tier }: { tier: AchievementTier }) {
  const c = TIER_COLORS[tier];
  return (
    <span style={{
      fontSize: '0.72rem', fontWeight: 600,
      padding: '0.15rem 0.6rem',
      borderRadius: 'var(--radius-full)',
      background: c.bg,
      color: c.color,
      fontFamily: 'var(--font-display)',
      letterSpacing: '0.02em',
    }}>
      {c.label}
    </span>
  );
}

/** Small colored dot indicating a tier achievement — used in list rows */
function TierDot({ tier }: { tier: AchievementTier }) {
  const color = tier === 'gold' ? 'var(--apollo-gold)' : tier === 'silver' ? 'var(--text-secondary)' : '#CD7F32';
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, marginLeft: '0.4rem', verticalAlign: 'middle',
      boxShadow: tier === 'gold' ? '0 0 6px rgba(212,165,55,0.4)' : 'none',
    }} title={TIER_COLORS[tier].label} />
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
              background: TIER_COLORS[recognition.hrEfficiencyTier].bg,
              color: TIER_COLORS[recognition.hrEfficiencyTier].color,
              fontFamily: 'var(--font-display)',
            }}>
              HR Efficiency {TIER_COLORS[recognition.hrEfficiencyTier].label.split(' ')[0]}
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

/** Expanded detail panel for a single activity with route map */
function ActivityDetail({ activity }: { activity: StravaActivity }) {
  const polyline = getPolylineForActivity(activity);
  const route = polyline ? processRoute(polyline) : null;

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
        <DetailStat label="Distance" value={formatDistanceMi(activity.distance)} sub={formatDistance(activity.distance)} color="var(--apollo-gold)" />
        <DetailStat label="Duration" value={formatDuration(activity.moving_time)}
          sub={activity.elapsed_time > activity.moving_time ? `${formatDuration(activity.elapsed_time)} elapsed` : undefined}
          color="var(--text)" />
        <DetailStat label="Pace" value={formatPaceMi(activity.distance, activity.moving_time)} sub={formatPaceKm(activity.distance, activity.moving_time)} color="var(--apollo-teal)" />
        {activity.total_elevation_gain != null && activity.total_elevation_gain > 0 && (
          <DetailStat label="Elevation" value={`${Math.round(activity.total_elevation_gain * 3.28084)} ft`} sub={`${Math.round(activity.total_elevation_gain)} m`} color="var(--color-success)" />
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
          const list = Array.isArray(data) ? data : [];
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
        <div className="card" style={{
          textAlign: 'center', padding: '2.5rem',
          background: 'linear-gradient(135deg, rgba(212,165,55,0.04) 0%, var(--bg-card) 100%)',
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>🏅</div>
          <h3 style={{ fontSize: 'var(--text-lg)', marginBottom: '0.5rem' }}>Your Hall of Victories</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.25rem', lineHeight: 1.6 }}>
            Connect Strava to see all your activities catalogued here — every run is an achievement.
          </p>
          <Link to="/settings" className="btn btn-primary">Connect Strava</Link>
        </div>
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
                        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: '0.15rem' }}>
                          {formatDate(a.start_date_local)} · {a.sport_type || a.type}
                        </div>
                      </div>

                      {/* Distance & time */}
                      <div style={{ textAlign: 'right', fontSize: 'var(--text-sm)' }}>
                        <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>{formatDistanceMi(a.distance)}</span><br />
                        <span style={{ color: 'var(--text-muted)' }}>{formatDuration(a.moving_time)}</span>
                      </div>

                      {/* Pace & metrics */}
                      <div style={{ textAlign: 'right', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', minWidth: 80 }}>
                        {a.average_speed != null && a.average_speed > 0 ? formatPaceMi(a.distance, a.moving_time) : '—'}
                        {a.total_elevation_gain != null && a.total_elevation_gain > 0 && (
                          <><br /><span style={{ color: 'var(--apollo-teal)' }}>+{Math.round(a.total_elevation_gain * 3.28084)} ft</span></>
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
