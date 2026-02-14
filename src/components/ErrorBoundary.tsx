import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Apollo ErrorBoundary:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="welcome-flow">
          <div className="welcome-card">
            <h1 className="welcome-title">Something went wrong</h1>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>
              We’ve run into an error. Try refreshing the page.
            </p>
            {this.state.error && (
              <pre style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'auto', marginBottom: '1rem' }}>
                {this.state.error.message}
              </pre>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
