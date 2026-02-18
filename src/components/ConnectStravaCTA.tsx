import { Link } from 'react-router-dom';

export default function ConnectStravaCTA({ emoji = '🔗', title = 'Connect Strava', description }: {
  emoji?: string;
  title?: string;
  description?: string;
}) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: '2.5rem' }}>
      <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>{emoji}</div>
      <h3 style={{ margin: '0 0 0.5rem', color: 'var(--strava)' }}>{title}</h3>
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 1.25rem', maxWidth: 420, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 }}>
        {description ?? 'Unlock auto-sync, race predictions, and personalized coaching by connecting your Strava account.'}
      </p>
      <Link to="/settings" className="btn btn-primary">Connect Strava</Link>
    </div>
  );
}
