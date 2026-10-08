import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="card not-found">
      <h1 className="page-title">Page not found</h1>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
        The page you’re looking for doesn’t exist or has been moved.
      </p>
      <Link to="/" className="btn btn-primary">Go to Today</Link>
    </div>
  );
}
