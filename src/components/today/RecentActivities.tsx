import { Link } from 'react-router-dom';
import type { Activity } from '../../services/activitySource';
import { getSportIcon, getSportLabel, isRideActivity, isRunActivity } from '../../services/activity/sports';
import { getEffortRecognition } from '../../services/effortService';
import { formatDistanceShort, formatDuration, formatPace, formatSpeed } from '../../services/unitPreferences';
import { dateKeyFromLocalIso } from '../../utils/localDate';
import { RouteMapThumbnail } from '../RouteMap';
import { TIER_CONFIG } from '../TierBadge';
import { formatMediumDate } from '../plan/planDisplay';

export interface RecentActivitiesProps {
  activities: Activity[];
  /** A sync or first load is in progress (message shown while the list is empty). */
  busyMessage: string | null;
}

const MAX_ROWS = 5;

/** Distance · duration · pace (runs) or speed (rides); duration only for sports without distance. */
function activityStatsLine(a: Activity): string {
  if (!(a.distance > 0)) return formatDuration(a.moving_time || a.elapsed_time);
  const parts = [formatDistanceShort(a.distance), formatDuration(a.moving_time)];
  if ((a.average_speed ?? 0) > 0) {
    if (isRunActivity(a)) parts.push(formatPace(a.distance, a.moving_time));
    else if (isRideActivity(a)) parts.push(formatSpeed(a.average_speed));
  }
  return parts.join(' · ');
}

/** "Oct 7, 2026" from `start_date_local` (its trailing Z isn't UTC — calendar date only). */
function activityDate(a: Activity): string {
  const key = dateKeyFromLocalIso(a.start_date_local);
  return key ? formatMediumDate(key) : '';
}

/** Achievement tier of a run (gold/silver/bronze), if any. */
function runTier(a: Activity) {
  if (!isRunActivity(a)) return null;
  const rec = getEffortRecognition(a.id);
  return rec?.paceTier ?? rec?.hrEfficiencyTier ?? null;
}

/** The five most recent activities from any source (synced or imported). */
export default function RecentActivities({ activities, busyMessage }: RecentActivitiesProps) {
  return (
    <section className="card" aria-labelledby="today-recent-title">
      <h2 id="today-recent-title" className="today-section-title">Recent activities</h2>
      {activities.length === 0 ? (
        busyMessage
          ? <p role="status" className="today-muted">{busyMessage}</p>
          : <p className="today-muted">No activities yet. Get out there and train!</p>
      ) : (
        <ul className="today-recent-list">
          {activities.slice(0, MAX_ROWS).map((a) => {
            const tier = runTier(a);
            const hasMap = !!a.map?.summary_polyline;
            return (
              <li key={`${a.source ?? 'strava'}-${a.id}`} className={`today-recent-item${hasMap ? ' today-recent-item--map' : ''}`}>
                {hasMap && <RouteMapThumbnail activity={a} />}
                <div>
                  <span className="today-recent-name">
                    <span aria-hidden="true">{getSportIcon(a)} </span>
                    {a.name || getSportLabel(a)}
                    {tier && (
                      <span className={`today-tier-dot today-tier-dot--${tier}`} role="img" aria-label={TIER_CONFIG[tier].label} title={TIER_CONFIG[tier].label} />
                    )}
                  </span>
                  <span className="today-recent-meta">
                    {activityDate(a)} · {getSportLabel(a)}{a.trainer ? ' · Indoor' : ''}
                  </span>
                </div>
                <span className="today-recent-stats">{activityStatsLine(a)}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="today-actions">
        <Link to="/activities" className="btn btn-secondary">View all activities</Link>
      </div>
    </section>
  );
}
