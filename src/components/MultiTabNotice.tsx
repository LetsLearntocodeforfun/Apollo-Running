import { useEffect, useState } from 'react';
import type { TabCoordinator, TabState } from '../utils/tabCoordinator';
import './MultiTabNotice.css';

/**
 * v1.0.7 (PX-35): warns when Apollo is open in more than one browser tab, so
 * the tabs don't overwrite each other's changes. Rendered in its own root by
 * main.tsx (web only), so it also covers onboarding.
 */
export default function MultiTabNotice({ coordinator }: { coordinator: TabCoordinator }) {
  const [state, setState] = useState<TabState>(() => coordinator.getState());
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => coordinator.subscribe((next) => {
    setState(next);
    setDismissed(false);
  }), [coordinator]);

  let title = 'Apollo is open in another tab.';
  let message: string | null = null;
  let canDismiss = false;
  if (state.role === 'secondary') {
    message = 'Changes made in two tabs can overwrite each other — close this tab and keep using the other one.';
  } else if (state.role === 'promoted') {
    title = 'The other Apollo tab was closed.';
    message = 'Reload to continue with its latest data.';
  } else if (state.otherTabOpened) {
    message = 'To avoid losing changes, use only one tab at a time.';
    canDismiss = true;
  }
  if (!message || dismissed) return null;

  return (
    <div className="multi-tab-notice" role="alert" data-testid="multi-tab-notice">
      <div className="app-banner app-banner--warning">
        <div className="app-banner-text">
          <strong>{title}</strong> {message}
        </div>
        {state.role !== 'primary' && (
          <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
            Reload
          </button>
        )}
        {canDismiss && (
          <button type="button" className="app-banner-dismiss" onClick={() => setDismissed(true)} aria-label="Dismiss">
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
    </div>
  );
}
