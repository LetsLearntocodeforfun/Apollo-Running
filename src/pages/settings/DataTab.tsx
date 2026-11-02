/**
 * Settings › Data & Privacy — what Apollo stores (and where), every service it
 * can contact, backups (create, download, import, restore) and "Delete all data".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ui';
import {
  estimateStorageUsage,
  isStorageDegraded,
  isStoragePersisted,
  requestPersistentStorage,
  type StorageUsageEstimate,
} from '../../services/storageHealth';
import { getNetworkDestinations } from '../../services/networkInventory';
import {
  BACKUPS_CHANGED_EVENT,
  createBackup,
  downloadBackup,
  downloadCurrentData,
  getBackupConfig,
  getBackupHealth,
  getBackupRecords,
  importFromFile,
  restoreFromBackupDetailed,
  setBackupConfig,
  syncSnapshotToDesktopFolder,
  type BackupConfig,
  type BackupRecord,
} from '../../services/backupService';
import { exportActivitiesCsv, exportJournalCsv, exportSplitsCsv, exportWellnessCsv } from '../../services/csvExport';
import { deleteAllLocalData } from '../../services/dataManager';
import {
  discardQuarantined,
  getQuarantinedEntries,
  getQuarantinedValue,
  onQuarantineChange,
  type QuarantineEntry,
} from '../../services/db/quarantine';
import { normalizeActionResult, type ActionOutcome } from './backupResult';
import { reloadApp } from './appReload';
import { StatusLine, formatCount, formatSize, useStatus } from './shared';

const DELETE_PHRASE = 'DELETE';

/** Friendly names for the largest storage keys (fallback: the key itself). */
const KEY_LABELS: [RegExp, string][] = [
  [/^apollo_quarantine_/, 'Damaged copy (set aside)'],
  [/^apollo_activities_store$/, 'Activities'],
  [/^apollo_backup_data_/, 'Backup copy'],
  [/^apollo_backup_registry$/, 'Backup list'],
  [/^apollo_route_cache$/, 'Route map cache'],
  [/^apollo_wellness/, 'Wellness data'],
  [/^apollo_hr_/, 'Heart-rate history'],
  [/^apollo_athlete_profile$/, 'Athlete profile'],
  [/plan/, 'Training plan data'],
];

function keyLabel(key: string): string {
  return KEY_LABELS.find(([re]) => re.test(key))?.[1] ?? key;
}

function formatBackupTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'Unknown date';
  return new Date(t).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const TRIGGER_LABELS: Record<BackupRecord['trigger'], string> = {
  auto: 'Automatic',
  manual: 'Manual',
  startup: 'At startup',
};

/** One sentence (plus skipped keys) for a restore/import outcome. */
function describeOutcome(outcome: ActionOutcome, action: 'restore' | 'import'): string {
  const fallback = outcome.ok
    ? action === 'restore'
      ? 'Backup restored.'
      : 'Data imported.'
    : action === 'restore'
      ? 'The backup could not be restored.'
      : 'The file could not be imported.';
  const skipped =
    outcome.skippedKeys.length > 0
      ? ` Not ${action === 'restore' ? 'restored' : 'imported'}: ${outcome.skippedKeys.join(', ')}.`
      : '';
  const reloadNote = outcome.ok ? ' Reload Apollo to see the changes.' : '';
  return `${outcome.message ?? fallback}${skipped}${reloadNote}`;
}

type BackupBadge = { label: string; tone: 'neutral' | 'success' | 'warning' | 'error' };

export default function DataTab() {
  const isDesktop = typeof window !== 'undefined' && !!window.electronAPI;
  const hasDesktopBackupFolder = isDesktop && !!window.electronAPI?.backupFolder;
  const destinations = useMemo(() => getNetworkDestinations(isDesktop ? 'desktop' : 'web'), [isDesktop]);
  const defaultContacts = destinations.filter((d) => d.defaultOn);

  const [usage, setUsage] = useState<StorageUsageEstimate | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const storageStatus = useStatus();

  const [backupConfig, setBackupConfigState] = useState<BackupConfig>(() => getBackupConfig());
  const [backupHealth, setBackupHealth] = useState(() => getBackupHealth());
  const [backupRecords, setBackupRecords] = useState<BackupRecord[]>(() => getBackupRecords());
  const [backupBusy, setBackupBusy] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const [pendingRestore, setPendingRestore] = useState<BackupRecord | null>(null);
  const backupStatus = useStatus();

  const [folderState, setFolderState] = useState<DesktopBackupFolderState | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const folderStatus = useStatus();
  const csvStatus = useStatus();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshBackupFolder = useCallback(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI?.backupFolder : undefined;
    if (!api) return;
    void api
      .getState()
      .then((next) => {
        if (mountedRef.current) setFolderState(next);
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  /** U3: health and history are state, recomputed after every action. */
  const refreshBackups = useCallback(() => {
    setBackupConfigState(getBackupConfig());
    setBackupHealth(getBackupHealth());
    setBackupRecords(getBackupRecords());
    refreshBackupFolder();
  }, [refreshBackupFolder]);

  useEffect(() => {
    refreshBackupFolder();
  }, [refreshBackupFolder]);

  useEffect(() => {
    window.addEventListener(BACKUPS_CHANGED_EVENT, refreshBackups);
    return () => window.removeEventListener(BACKUPS_CHANGED_EVENT, refreshBackups);
  }, [refreshBackups]);

  // v1.0.7 (PX-14): damaged copies set aside by the quarantine.
  const [quarantined, setQuarantined] = useState<QuarantineEntry[]>(() => getQuarantinedEntries());
  const [pendingDiscard, setPendingDiscard] = useState<QuarantineEntry | null>(null);
  useEffect(() => {
    const update = () => setQuarantined(getQuarantinedEntries());
    const unsubscribe = onQuarantineChange(update);
    update();
    return unsubscribe;
  }, []);

  const handleDownloadQuarantined = (entry: QuarantineEntry) => {
    const raw = getQuarantinedValue(entry.key);
    if (raw === null) {
      backupStatus.error('That damaged copy is no longer on this device.');
      return;
    }
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `apollo-damaged-${entry.originalKey.replace(/^apollo_/, '')}-${entry.quarantinedAt.slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    backupStatus.success(`Downloaded the damaged copy of ${keyLabel(entry.originalKey)}.`);
  };

  useEffect(() => {
    let cancelled = false;
    void Promise.all([estimateStorageUsage(), isDesktop ? Promise.resolve(null) : isStoragePersisted()]).then(
      ([estimate, isPersisted]) => {
        if (cancelled) return;
        setUsage(estimate);
        setPersisted(isPersisted);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  const dataBytes = usage ? usage.keys.reduce((sum, k) => sum + k.chars * 2, 0) : 0;
  const largestKeys = usage ? usage.keys.slice(0, 8) : [];

  const badge: BackupBadge =
    backupHealth.backupCount === 0 && backupHealth.status !== 'critical'
      ? { label: 'No backup yet', tone: 'neutral' } // U2: neutral for a new user, not a red "At risk"
      : backupHealth.status === 'healthy'
        ? { label: 'Protected', tone: 'success' }
        : backupHealth.status === 'warning'
          ? { label: 'Needs attention', tone: 'warning' }
          : { label: 'At risk', tone: 'error' };

  const updateBackupConfig = (patch: Partial<BackupConfig>, message: string) => {
    setBackupConfig(patch);
    refreshBackups();
    backupStatus.success(message);
  };

  const handleCreateBackup = async () => {
    setBackupBusy(true);
    setNeedsReload(false);
    backupStatus.info('Creating a backup…');
    try {
      const record = await createBackup('manual');
      if (record) backupStatus.success(`Backup created (${formatSize(record.sizeBytes)}).`);
      else backupStatus.error('The backup could not be created. Check that there is free disk space, then try again.');
    } catch (e) {
      backupStatus.error(e instanceof Error ? e.message : 'The backup could not be created.');
    } finally {
      refreshBackups();
      setBackupBusy(false);
    }
  };

  const handleExport = async () => {
    setNeedsReload(false);
    try {
      await downloadCurrentData();
      backupStatus.success('Your data was downloaded as a file. API keys and tokens are never included.');
    } catch (e) {
      backupStatus.error(e instanceof Error ? e.message : 'The download could not be created.');
    }
  };

  const handleDownloadBackup = async (record: BackupRecord) => {
    setNeedsReload(false);
    if (await downloadBackup(record.id))
      backupStatus.success(`Downloaded the backup from ${formatBackupTime(record.createdAt)}.`);
    else backupStatus.error('That backup is no longer on this device.');
  };

  const runImport = async (file: File) => {
    setBackupBusy(true);
    backupStatus.info(`Importing ${file.name}…`);
    try {
      const outcome = normalizeActionResult(await importFromFile(file));
      setNeedsReload(outcome.ok);
      if (outcome.ok) backupStatus.success(describeOutcome(outcome, 'import'));
      else backupStatus.error(describeOutcome(outcome, 'import'));
    } catch (e) {
      setNeedsReload(false);
      backupStatus.error(e instanceof Error ? e.message : 'The file could not be imported.');
    } finally {
      refreshBackups();
      setBackupBusy(false);
    }
  };

  const runRestore = async (record: BackupRecord) => {
    setBackupBusy(true);
    backupStatus.info('Restoring the backup…');
    try {
      const outcome = normalizeActionResult(await restoreFromBackupDetailed(record.id));
      setNeedsReload(outcome.ok);
      if (outcome.ok) backupStatus.success(describeOutcome(outcome, 'restore'));
      else backupStatus.error(describeOutcome(outcome, 'restore'));
    } catch (e) {
      setNeedsReload(false);
      backupStatus.error(e instanceof Error ? e.message : 'The backup could not be restored.');
    } finally {
      refreshBackups();
      setBackupBusy(false);
    }
  };

  const handleRequestPersist = async () => {
    const granted = await requestPersistentStorage();
    setPersisted(granted);
    if (granted) storageStatus.success('Done — your browser will keep Apollo\u2019s data even when space runs low.');
    else storageStatus.error('Your browser declined. Keep a downloaded copy of your data to be safe.');
  };

  const closeDeleteDialog = () => {
    if (deleting) return;
    setDeleteOpen(false);
    setDeleteText('');
    setDeleteError(null);
  };

  const confirmDeleteAll = async () => {
    if (deleting) return;
    if (deleteText.trim() !== DELETE_PHRASE) {
      setDeleteError(`Type ${DELETE_PHRASE} in capital letters to confirm.`);
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAllLocalData();
      reloadApp();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Some data could not be deleted. Try again.');
      setDeleting(false);
    }
  };

  const handleChooseBackupFolder = async () => {
    const api = window.electronAPI?.backupFolder;
    if (!api) return;
    setFolderBusy(true);
    try {
      const reply = await api.chooseFolder();
      setFolderState(reply.state);
      if (reply.canceled) return;
      if (reply.error) {
        folderStatus.error(reply.error);
        return;
      }
      folderStatus.success(
        'Synced backup folder connected. Future backups will mirror compressed .json.gz snapshots there.',
      );
    } catch (e) {
      folderStatus.error(e instanceof Error ? e.message : 'Could not choose backup folder.');
    } finally {
      setFolderBusy(false);
    }
  };

  const handleSyncFolderNow = async () => {
    setFolderBusy(true);
    folderStatus.info('Writing compressed snapshot to synced folder…');
    try {
      const res = await syncSnapshotToDesktopFolder();
      if (res.state) setFolderState(res.state);
      if (res.ok) {
        const name = res.state?.lastFileName ? ` (${res.state.lastFileName})` : '';
        folderStatus.success(`Snapshot synced to folder${name}.`);
      } else if (res.empty) {
        folderStatus.info(res.error ?? 'There\u2019s no Apollo data to back up yet.');
      } else {
        folderStatus.error(res.error ?? 'Could not write snapshot to synced folder.');
      }
    } catch (e) {
      folderStatus.error(e instanceof Error ? e.message : 'Could not write snapshot to synced folder.');
    } finally {
      setFolderBusy(false);
    }
  };

  const handleDisconnectBackupFolder = async () => {
    const api = window.electronAPI?.backupFolder;
    if (!api) return;
    setFolderBusy(true);
    try {
      const next = await api.clearFolder();
      setFolderState(next);
      folderStatus.info('Disconnected synced backup folder. Existing .json.gz snapshots in that folder were kept.');
    } catch (e) {
      folderStatus.error(e instanceof Error ? e.message : 'Could not disconnect backup folder.');
    } finally {
      setFolderBusy(false);
    }
  };

  const handleCsvExport = (run: () => { rowCount: number; filename: string }, singular: string, plural: string) => {
    if (isStorageDegraded()) {
      // v1.0.9: same rule as backups and downloads — never a file that could be missing rows.
      csvStatus.error(
        'Storage is unavailable right now, so Apollo didn\u2019t create a CSV that could be missing data. Restart Apollo and try again.',
      );
      return;
    }
    try {
      const { rowCount, filename } = run();
      if (rowCount === 0) {
        csvStatus.info(`No ${plural} stored on this device yet.`);
      } else {
        csvStatus.success(`Downloaded ${formatCount(rowCount, singular, plural)} as ${filename}.`);
      }
    } catch (e) {
      csvStatus.error(e instanceof Error ? e.message : 'The CSV export could not be created.');
    }
  };

  const recentBackups = backupRecords.slice(-5).reverse();

  return (
    <>
      <div className="card settings-card settings-card--teal">
        <h2 className="card-title settings-card-title">Your data stays on this device</h2>
        <p className="settings-lead">
          Apollo has no account, no server and no analytics. Your training data is stored only in this app on this
          device. It contacts the services listed below only after you connect them.
        </p>
        <h3 className="settings-subheading">Storage</h3>
        {usage === null ? (
          <p className="settings-hint">Measuring storage…</p>
        ) : (
          <>
            <p className="settings-strong">
              {usage.keys.length === 0
                ? 'No training data stored yet.'
                : `About ${formatSize(dataBytes)} of training data on this device.`}
            </p>
            {usage.usageBytes !== null && (
              <p className="settings-hint">
                {isDesktop ? 'This app' : 'This browser'} reports {formatSize(usage.usageBytes)} used
                {usage.quotaBytes !== null ? ` of ${formatSize(usage.quotaBytes)} available` : ''} (including caches).
              </p>
            )}
            {largestKeys.length > 0 && (
              <details className="settings-details">
                <summary>Largest items</summary>
                <ul className="settings-key-list">
                  {largestKeys.map((k) => (
                    <li key={k.key}>
                      <span>{keyLabel(k.key)}</span>
                      {keyLabel(k.key) !== k.key && <code className="settings-code">{k.key}</code>}
                      <span className="settings-muted">{formatSize(k.chars * 2)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        {!isDesktop && persisted === false && (
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                void handleRequestPersist();
              }}
            >
              Ask the browser to keep Apollo&apos;s data
            </button>
          </div>
        )}
        {!isDesktop && persisted === true && (
          <p className="settings-hint">Your browser keeps Apollo&apos;s data even when space runs low.</p>
        )}
        <StatusLine status={storageStatus.status} />
      </div>

      <div className="card settings-card">
        <h2 className="card-title settings-card-title">Services Apollo can contact</h2>
        <p className="settings-lead">
          {defaultContacts.length === 0
            ? 'Nothing is contacted until you turn it on — by connecting a service or switching a feature on.'
            : `Contacted without any action from you: ${defaultContacts.map((d) => d.host).join(', ')}.`}
        </p>
        <div className="settings-table-wrap">
          <table className="settings-table">
            <caption className="sr-only">Every network destination this version of Apollo can contact</caption>
            <thead>
              <tr>
                <th scope="col">Host</th>
                <th scope="col">Purpose</th>
                <th scope="col">When</th>
                <th scope="col">Data sent</th>
                <th scope="col">Contacted by default</th>
              </tr>
            </thead>
            <tbody>
              {destinations.map((d) => (
                <tr key={d.id}>
                  <th scope="row">{d.host}</th>
                  <td>{d.purpose}</td>
                  <td>{d.trigger}</td>
                  <td>{d.dataSent}</td>
                  <td>{d.defaultOn ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`card settings-card settings-card--${badge.tone}`}>
        <h2 className="card-title settings-card-title">
          Backups
          <span className={`settings-badge settings-badge--${badge.tone}`}>{badge.label}</span>
        </h2>
        <p className="settings-lead">{backupHealth.message}</p>

        <div className="settings-row">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={backupConfig.autoBackupEnabled}
              onChange={(e) =>
                updateBackupConfig(
                  { autoBackupEnabled: e.target.checked },
                  `Automatic backups turned ${e.target.checked ? 'on' : 'off'}.`,
                )
              }
            />
            <span>Automatic backups</span>
          </label>
          {backupConfig.autoBackupEnabled && (
            <span className="settings-inline-field">
              <label htmlFor="settings-backup-interval" className="settings-label">
                Every
              </label>
              <select
                id="settings-backup-interval"
                value={backupConfig.intervalHours}
                onChange={(e) => {
                  const hours = Number(e.target.value);
                  updateBackupConfig({ intervalHours: hours }, 'Backup schedule saved.');
                }}
                className="settings-select"
              >
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>2 days</option>
                <option value={168}>1 week</option>
                {![12, 24, 48, 168].includes(backupConfig.intervalHours) && (
                  <option value={backupConfig.intervalHours}>{backupConfig.intervalHours} hours</option>
                )}
              </select>
              <span className="settings-muted">· keeps the latest {backupConfig.maxBackups}</span>
            </span>
          )}
        </div>
        <p className="settings-hint">
          Backups are stored on this device, so they protect against mistakes — not against losing the device. Download
          a copy to keep one elsewhere.
        </p>

        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={backupBusy}
            onClick={() => {
              void handleCreateBackup();
            }}
          >
            {backupBusy ? 'Working…' : 'Create backup now'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={backupBusy}
            onClick={() => {
              void handleExport();
            }}
          >
            Download current data
          </button>
          <label className={`btn btn-secondary settings-file-label${backupBusy ? ' is-disabled' : ''}`}>
            Import from file…
            <input
              type="file"
              accept=".json,.gz,application/json,application/gzip"
              className="sr-only"
              disabled={backupBusy}
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                e.target.value = '';
                if (file) setPendingImport(file);
              }}
            />
          </label>
        </div>
        <p className="settings-hint">
          Downloads and imports are JSON (<code>.json</code> or <code>.json.gz</code>) files. API keys and tokens are
          never included.
        </p>
        <StatusLine status={backupStatus.status}>
          {needsReload && (
            <>
              {' '}
              <button type="button" className="btn btn-secondary settings-inline-button" onClick={reloadApp}>
                Reload now
              </button>
            </>
          )}
        </StatusLine>

        {hasDesktopBackupFolder && (
          <div data-testid="synced-backup-folder">
            <h3 className="settings-subheading">Backup folder</h3>
            {folderState?.folderPath ? (
              <>
                <p className="settings-hint">
                  Folder: <code className="settings-code">{folderState.folderPath}</code>
                  {!folderState.folderReachable ? ' (currently unreachable)' : ''} · keeps the latest{' '}
                  {backupConfig.maxBackups} compressed <code className="settings-code">.json.gz</code> snapshots.
                </p>
                {folderState.lastSyncedAt && (
                  <p className="settings-hint">
                    Last saved {formatBackupTime(folderState.lastSyncedAt)}
                    {folderState.lastFileName ? ` (${folderState.lastFileName})` : ''}.
                  </p>
                )}
              </>
            ) : (
              <p className="settings-hint">
                Optional: mirror compressed backups to an external drive or synced folder on this computer.
              </p>
            )}
            {folderState?.lastError && <p className="settings-error-text">{folderState.lastError}</p>}
            <div className="settings-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={folderBusy || backupBusy}
                onClick={() => {
                  void handleChooseBackupFolder();
                }}
              >
                {folderState?.folderPath ? 'Change folder…' : 'Choose folder…'}
              </button>
              {folderState?.folderPath && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={folderBusy || backupBusy}
                    onClick={() => {
                      void handleSyncFolderNow();
                    }}
                  >
                    {folderBusy ? 'Saving…' : 'Save snapshot now'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={folderBusy || backupBusy}
                    onClick={() => {
                      void handleDisconnectBackupFolder();
                    }}
                  >
                    Disconnect folder
                  </button>
                </>
              )}
            </div>
            <StatusLine status={folderStatus.status} />
          </div>
        )}

        {recentBackups.length > 0 && (
          <>
            <h3 className="settings-subheading">
              Recent backups <span className="settings-muted">({backupRecords.length} on this device)</span>
            </h3>
            <ul className="settings-backup-list">
              {recentBackups.map((r) => {
                const when = formatBackupTime(r.createdAt);
                return (
                  <li key={r.id} className="settings-backup-row">
                    <span className="settings-backup-meta">
                      <span className="settings-strong">{when}</span>
                      <span className="settings-muted">
                        {formatSize(r.sizeBytes)} · {TRIGGER_LABELS[r.trigger] ?? r.trigger}
                      </span>
                      {r.verified ? (
                        <span className="settings-ok">
                          <span aria-hidden="true">✓ </span>Verified
                        </span>
                      ) : (
                        <span className="settings-error-text">Not verified</span>
                      )}
                    </span>
                    <span className="settings-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`Download backup from ${when}`}
                        onClick={() => handleDownloadBackup(r)}
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-label={`Restore backup from ${when}`}
                        disabled={backupBusy}
                        onClick={() => setPendingRestore(r)}
                      >
                        Restore
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <p className="settings-hint">Backups use SHA-256 checksums to detect corruption. Nothing is sent anywhere.</p>
      </div>

      <div className="card settings-card" data-testid="csv-exports-card">
        <h2 className="card-title settings-card-title">Export as CSV</h2>
        <p className="settings-lead">
          Download your training records as standard UTF-8 spreadsheets for your own analysis or archive.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => handleCsvExport(exportActivitiesCsv, 'activity', 'activities')}
          >
            Activities
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => handleCsvExport(exportSplitsCsv, 'split', 'splits')}
          >
            Splits
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => handleCsvExport(exportWellnessCsv, 'wellness record', 'wellness records')}
          >
            Wellness
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => handleCsvExport(exportJournalCsv, 'journal entry', 'journal entries')}
          >
            Training journal
          </button>
        </div>
        <p className="settings-hint">
          Activity and split files include metric and imperial columns. Every file starts with a UTF-8 byte-order mark
          for spreadsheet apps, and text fields are quoted and protected against spreadsheet formulas.
        </p>
        <StatusLine status={csvStatus.status} />
      </div>

      {quarantined.length > 0 && (
        // v1.0.7 (PX-14): damaged values moved aside instead of being overwritten.
        <div className="card settings-card settings-card--warning" data-testid="quarantine-card">
          <h2 className="card-title settings-card-title">Damaged data set aside</h2>
          <p className="settings-lead">
            Apollo couldn&apos;t read this data, so it kept the damaged copy here instead of overwriting it. Download it
            if you want to try recovering it or send it with a bug report, then discard it. It is never included in
            backups or exports.
          </p>
          <ul className="settings-backup-list">
            {quarantined.map((q) => {
              const when = formatBackupTime(q.quarantinedAt);
              const label = keyLabel(q.originalKey);
              return (
                <li key={q.key} className="settings-backup-row">
                  <span className="settings-backup-meta">
                    <span className="settings-strong">{label}</span>
                    <span className="settings-muted">
                      Set aside {when} · {formatSize(q.sizeChars * 2)} · {q.reason}
                    </span>
                  </span>
                  <span className="settings-actions">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-label={`Download damaged copy of ${label} from ${when}`}
                      onClick={() => handleDownloadQuarantined(q)}
                    >
                      Download damaged copy
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-label={`Discard damaged copy of ${label} from ${when}`}
                      onClick={() => setPendingDiscard(q)}
                    >
                      Discard
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="card settings-card settings-card--error settings-danger">
        <h2 className="card-title settings-card-title">Delete all data</h2>
        <p className="settings-lead">
          Permanently removes your activities, training plan, settings, the backups stored in Apollo and your saved
          connections from this device. Files you downloaded are not affected. Download a copy first if you might want
          it later.
          {folderState?.folderPath
            ? ' Apollo also disconnects your synced backup folder; the snapshots already in it stay there until you delete them.'
            : ''}
        </p>
        <div className="settings-actions">
          <button type="button" className="btn ui-btn-danger" onClick={() => setDeleteOpen(true)}>
            Delete all data…
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={pendingImport !== null}
        title="Import data from this file?"
        message={
          pendingImport
            ? `${pendingImport.name} (${formatSize(pendingImport.size)}). Apollo first backs up your current data, then replaces matching data with the file\u2019s contents. API keys and tokens in the file are ignored.`
            : undefined
        }
        confirmLabel="Import"
        onConfirm={() => {
          const file = pendingImport;
          setPendingImport(null);
          if (file) void runImport(file);
        }}
        onCancel={() => setPendingImport(null)}
      />

      <ConfirmDialog
        open={pendingRestore !== null}
        title="Restore this backup?"
        message={
          pendingRestore
            ? `Restore the backup from ${formatBackupTime(pendingRestore.createdAt)}? Apollo first backs up your current data, then replaces it with this backup.`
            : undefined
        }
        confirmLabel="Restore"
        onConfirm={() => {
          const record = pendingRestore;
          setPendingRestore(null);
          if (record) void runRestore(record);
        }}
        onCancel={() => setPendingRestore(null)}
      />

      <ConfirmDialog
        open={pendingDiscard !== null}
        tone="danger"
        title="Discard this damaged copy?"
        message={
          pendingDiscard
            ? `The damaged copy of ${keyLabel(pendingDiscard.originalKey)} set aside ${formatBackupTime(pendingDiscard.quarantinedAt)} will be deleted from this device. Download it first if you might want it. This can't be undone.`
            : undefined
        }
        confirmLabel="Discard"
        onConfirm={() => {
          const entry = pendingDiscard;
          setPendingDiscard(null);
          if (entry) {
            discardQuarantined(entry.key);
            backupStatus.success(`Discarded the damaged copy of ${keyLabel(entry.originalKey)}.`);
          }
        }}
        onCancel={() => setPendingDiscard(null)}
      />

      <ConfirmDialog
        open={deleteOpen}
        tone="danger"
        title="Delete all Apollo data on this device?"
        message={
          'This permanently deletes your activities, training plan, settings, backups stored in Apollo and saved connections (API keys and tokens). It can\u2019t be undone.' +
          (folderState?.folderPath
            ? ' Snapshots already in your synced backup folder are not deleted; Apollo disconnects the folder.'
            : '')
        }
        confirmLabel={deleting ? 'Deleting…' : 'Delete everything'}
        onConfirm={() => {
          void confirmDeleteAll();
        }}
        onCancel={closeDeleteDialog}
      >
        <div className="settings-field settings-dialog-field">
          <label htmlFor="settings-delete-confirm" className="settings-label">
            Type {DELETE_PHRASE} to confirm
          </label>
          <input
            id="settings-delete-confirm"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={deleteText}
            aria-invalid={deleteError ? true : undefined}
            aria-describedby="settings-delete-error"
            onChange={(e) => {
              setDeleteText(e.target.value);
              if (deleteError) setDeleteError(null);
            }}
            className="settings-input"
          />
          <p
            id="settings-delete-error"
            role="status"
            aria-live="polite"
            className="settings-status settings-status--error"
          >
            {deleteError}
          </p>
        </div>
      </ConfirmDialog>
    </>
  );
}
