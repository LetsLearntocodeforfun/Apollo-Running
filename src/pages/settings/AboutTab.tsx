/**
 * Settings › About — the app version, desktop app updates (check, automatic
 * check/download, progress, Restart & Install), a note for the web build, and
 * a pointer to Data & Privacy.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { APP_VERSION } from '../../version';
import { StatusLine, settingsTabPath, useAppPrefs, useStatus, type Status } from './shared';

type Updater = ElectronAPI['updater'];

/** What the updater is doing, as a sentence for the polite live region (null when idle). */
function describeUpdateState(state: UpdateState | null): Status | null {
  if (!state) return null;
  const version = state.version ? `v${state.version}` : 'A new version';
  switch (state.status) {
    case 'checking':
      return { tone: 'info', text: 'Checking for updates…' };
    case 'available':
      return { tone: 'info', text: `${version} is available.` };
    case 'not-available':
      return { tone: 'success', text: 'You\u2019re on the latest version.' };
    case 'downloading':
      return { tone: 'info', text: 'Downloading the update…' };
    case 'downloaded':
      return { tone: 'success', text: `Update ${version} downloaded — ready to install.` };
    case 'error':
      return { tone: 'error', text: state.error || 'The update failed. Try again later.' };
    default:
      return null;
  }
}

/** Desktop app updates (Electron only). */
function UpdatesCard({ updater }: { updater: Updater }) {
  const [appPrefs, updateAppPrefs] = useAppPrefs();
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const prefsStatus = useStatus();
  const actionStatus = useStatus();

  useEffect(() => {
    let cancelled = false;
    updater.getState()
      .then((state) => { if (!cancelled) setUpdateState(state); })
      .catch(() => { /* the state arrives with the next change event */ });
    const unsubscribe = updater.onStateChanged((state) => {
      if (cancelled) return;
      setUpdateState(state);
      setChecking(false);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [updater]);

  /** Persist the update preferences and reconfigure the main process right away. */
  const applyUpdatePrefs = (patch: { autoCheckUpdates?: boolean; autoDownloadUpdates?: boolean }, message: string) => {
    const next = updateAppPrefs(patch);
    updater.configure({ autoCheck: next.autoCheckUpdates, autoDownload: next.autoDownloadUpdates })
      .then(() => prefsStatus.success(message))
      .catch(() => prefsStatus.error('Saved, but the updater could not apply it until Apollo restarts.'));
  };

  const handleCheck = async () => {
    setChecking(true);
    actionStatus.clear();
    try {
      setUpdateState(await updater.check());
    } catch {
      actionStatus.error('Could not check for updates. Check your internet connection and try again.');
    } finally {
      setChecking(false);
    }
  };

  const handleDownload = async () => {
    actionStatus.clear();
    try {
      setUpdateState(await updater.download());
    } catch {
      actionStatus.error('The update could not be downloaded. Try again later.');
    }
  };

  const handleInstall = async () => {
    actionStatus.clear();
    try {
      await updater.install();
    } catch {
      actionStatus.error('Apollo could not restart to install the update. Quit and reopen Apollo to install it.');
    }
  };

  const progress = updateState?.status === 'downloading' && updateState.downloadProgress != null
    ? Math.max(0, Math.min(100, Math.round(updateState.downloadProgress)))
    : null;

  return (
    <div className="card settings-card settings-card--teal">
      <h2 className="card-title settings-card-title">
        App updates
        <span className="settings-badge settings-badge--success">Recommended</span>
      </h2>
      <p className="settings-lead">
        Apollo checks GitHub for new releases only if you turn on automatic checks or press Check for updates.
        Updates are never forced — you decide when to install.
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={appPrefs.autoCheckUpdates}
          onChange={(e) => {
            const checked = e.target.checked;
            applyUpdatePrefs(
              // Turning off checks also turns off automatic downloads.
              { autoCheckUpdates: checked, autoDownloadUpdates: checked ? appPrefs.autoDownloadUpdates : false },
              `Automatic update checks turned ${checked ? 'on' : 'off'}.`,
            );
          }}
        />
        <span>Check for updates when Apollo opens</span>
      </label>
      {appPrefs.autoCheckUpdates && (
        <label className="settings-check settings-indent">
          <input
            type="checkbox"
            checked={appPrefs.autoDownloadUpdates}
            onChange={(e) => {
              const checked = e.target.checked;
              applyUpdatePrefs({ autoDownloadUpdates: checked }, `Automatic downloads turned ${checked ? 'on' : 'off'}.`);
            }}
          />
          <span>Download updates automatically</span>
        </label>
      )}
      <StatusLine status={prefsStatus.status} />

      <div className="settings-actions">
        <button type="button" className="btn btn-secondary" disabled={checking} onClick={() => { void handleCheck(); }}>
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        {updateState?.status === 'available' && (
          <button type="button" className="btn btn-primary" onClick={() => { void handleDownload(); }}>
            Download {updateState.version ? `v${updateState.version}` : 'update'}
          </button>
        )}
        {updateState?.status === 'downloaded' && (
          <button type="button" className="btn btn-primary" onClick={() => { void handleInstall(); }}>
            Restart &amp; Install
          </button>
        )}
      </div>
      {progress !== null && (
        <div className="settings-progress">
          <progress id="settings-update-progress" max={100} value={progress} aria-label="Update download progress" />
          <span className="settings-muted" aria-hidden="true">{progress}%</span>
        </div>
      )}
      <StatusLine status={actionStatus.status ?? describeUpdateState(updateState)} />
    </div>
  );
}

export default function AboutTab() {
  const updater = typeof window !== 'undefined' ? window.electronAPI?.updater ?? null : null;
  const isDesktop = typeof window !== 'undefined' && !!window.electronAPI;

  return (
    <>
      <div className="card settings-card settings-card--gold">
        <h2 className="card-title settings-card-title">Apollo</h2>
        <dl className="settings-dl">
          <dt>Version</dt>
          <dd className="settings-strong">{APP_VERSION}</dd>
          <dt>Edition</dt>
          <dd>{isDesktop ? 'Desktop app' : 'Web app (runs in your browser)'}</dd>
        </dl>
        <p className="settings-hint">
          What Apollo stores, every service it can contact, backups and deleting everything:{' '}
          <Link to={settingsTabPath('data')}>Settings › Data &amp; Privacy</Link>.
        </p>
      </div>

      {updater ? (
        <UpdatesCard updater={updater} />
      ) : (
        !isDesktop && (
          <div className="card settings-card">
            <h2 className="card-title settings-card-title">Web version</h2>
            <p className="settings-lead">
              You&apos;re using Apollo in a web browser. New versions arrive when you reload the page — there&apos;s nothing to install.
            </p>
            <p className="settings-hint">
              Your data is kept in this browser only. Clearing this site&apos;s data deletes it, so keep a downloaded copy from{' '}
              <Link to={settingsTabPath('data')}>Data &amp; Privacy</Link>.
            </p>
          </div>
        )
      )}
    </>
  );
}
