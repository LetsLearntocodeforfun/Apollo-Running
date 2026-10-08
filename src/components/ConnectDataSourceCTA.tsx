import { Link } from 'react-router-dom';

/**
 * Prompt shown when no activity data source is connected yet.
 * intervals.icu is the free default (it relays Garmin Connect, Zwift, Wahoo,
 * COROS, Suunto, Polar…); Strava is supported as an optional source.
 */
export default function ConnectDataSourceCTA({ emoji = '🔗', title = 'Connect your training data', description }: {
  emoji?: string;
  title?: string;
  description?: string;
}) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '2.5rem' }}>
      <div aria-hidden="true" style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>{emoji}</div>
      <h2 className="card-title" style={{ margin: '0 0 0.5rem', color: 'var(--apollo-teal)' }}>{title}</h2>
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 0.75rem', maxWidth: 440, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
        {description ?? 'Unlock auto-sync, race predictions, and personalized coaching. Apollo imports your full history and keeps it in sync automatically.'}
      </p>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', margin: '0 0 1.25rem', maxWidth: 440, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 }}>
        Free with <strong style={{ color: 'var(--text)' }}>intervals.icu</strong> — works with Garmin, Zwift, Wahoo, COROS, Suunto &amp; Polar. Strava also supported. Or import activity files — no account needed.
      </p>
      <Link to="/settings?tab=connections" className="btn btn-primary">Connect a data source</Link>
    </div>
  );
}
