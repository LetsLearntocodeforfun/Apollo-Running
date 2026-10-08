import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /**
   * 'page' (default): full-screen fallback for the app root.
   * 'inline': a compact card for one section or route, so a failing card
   * doesn't take over the whole window. It offers "Try again".
   */
  variant?: 'page' | 'inline';
  /** Name of the section for the inline message, e.g. "Recovery". */
  label?: string;
  /** When this value changes (e.g. the route), a caught error is cleared. */
  resetKey?: unknown;
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
    console.error('[Apollo] Uncaught error:', error);
    console.error('[Apollo] Component stack:', errorInfo.componentStack);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null });
    }
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
  };

  private copyDetails = () => {
    const err = this.state.error;
    const text = err ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : 'Unknown error';
    void navigator.clipboard?.writeText(text).catch(() => { /* clipboard unavailable */ });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    if (this.props.variant === 'inline') {
      const what = this.props.label ? `${this.props.label} couldn’t be shown.` : 'This section couldn’t be shown.';
      return (
        <div className="card error-inline" role="alert">
          <p className="error-inline-title">{what}</p>
          <p className="error-inline-text">
            Your data is safe on this device. {this.state.error?.message ? `(${this.state.error.message})` : ''}
          </p>
          <button type="button" className="btn btn-secondary" onClick={this.reset}>
            Try again
          </button>
        </div>
      );
    }

    return (
      <div className="welcome-flow">
        <div className="welcome-card" role="alert">
          <h1 className="welcome-title">Something went wrong</h1>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>
            Apollo ran into an error. Your training data is stored on this device and is safe — reloading usually fixes this.
          </p>
          {this.state.error && (
            <pre style={{ fontSize: '0.8rem', color: 'var(--text-muted)', overflow: 'auto', marginBottom: '1rem' }}>
              {this.state.error.message}
            </pre>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload Apollo
            </button>
            <button type="button" className="btn btn-secondary" onClick={this.copyDetails}>
              Copy error details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
