import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="welcome-flow">
      <div className="welcome-card">
        <h1 className="welcome-title">Page not found</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
          The page you’re looking for doesn’t exist or has been moved.
        </p>
        <Link to="/" className="btn btn-primary">Go to Dashboard</Link>
      </div>
    </div>
  );
}
