/**
 * "Import activity files" card: Apollo's account-free way to bring in
 * training history.
 *
 * Takes FIT, GPX and TCX files from any watch or app (gzipped too), whole
 * Strava ("Download your archive") and Garmin ("Export Your Data") ZIP
 * exports, and folders holding either — dropped on the card or picked with
 * "Choose files" — and imports them with services/fileImport. Files are read
 * on this device; nothing is uploaded.
 *
 * Self-contained, so it can sit in Settings, on the Activities page and in
 * onboarding. The import itself is the app-wide job in fileImport/job.ts: it
 * keeps going when the athlete leaves the page, and every mounted card shows
 * the same progress and result. Pages refresh through `onActivitiesUpdated`,
 * as after a sync.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { ChangeEvent, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ImportResult } from '../services/fileImport';
import { filesFromDataTransfer } from '../services/fileImport/dropped';
import {
  cancelFileImport,
  describeImportResult,
  dismissFileImportResult,
  getFileImportJob,
  onFileImportJobChange,
  startFileImport,
} from '../services/fileImport/job';

/** Props of the `ImportActivities` card. */
export interface ImportActivitiesProps {
  /** Tighter layout for onboarding and empty states: the export how-to folds into a disclosure. */
  compact?: boolean;
  /** Called with the result when an import started from this card finishes (cancelled ones too). */
  onImported?: (result: ImportResult) => void;
}

/** What the file picker offers (`.gz` covers `.fit.gz`, `.gpx.gz` and `.tcx.gz`). */
const ACCEPT = '.fit,.gpx,.tcx,.zip,.gz';
/** Problems listed under the result (the rest are only counted). */
const MAX_LISTED_ISSUES = 200;

const badgeStyle = {
  fontSize: '0.72rem', background: 'var(--apollo-teal-dim)',
  color: 'var(--apollo-teal)', padding: '0.15rem 0.6rem',
  borderRadius: 'var(--radius-full)', fontWeight: 600,
  fontFamily: 'var(--font-display)',
} as const;
const textStyle = { color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.5 } as const;
const hintStyle = { color: 'var(--text-muted)', fontSize: '0.82rem', lineHeight: 1.4 } as const;
const summaryStyle = {
  cursor: 'pointer', color: 'var(--apollo-gold)', fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-display)', fontWeight: 600,
} as const;

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function hasFiles(e: ReactDragEvent<HTMLElement>): boolean {
  return Array.from(e.dataTransfer.types).includes('Files');
}

// ── Card ──────────────────────────────────────────────────────────────────────

/** Card that imports activity files and Strava / Garmin exports into Apollo, no account needed. */
export default function ImportActivities({ compact = false, onImported }: ImportActivitiesProps) {
  const current = useSyncExternalStore(onFileImportJobChange, getFileImportJob, getFileImportJob);
  const [dragging, setDragging] = useState(false);
  const [zoneFocused, setZoneFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const dragDepth = useRef(0);
  const cancelFocused = useRef(false);
  const mounted = useRef(false);
  const onImportedRef = useRef(onImported);
  const hintId = useId();
  const busy = current.running;

  useEffect(() => {
    onImportedRef.current = onImported;
  }, [onImported]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Files dropped next to the zone must not replace the app with the file (the browser and Electron default).
  useEffect(() => {
    const guard = (e: DragEvent): void => {
      if (e.defaultPrevented || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  // Cancel disappears when the import ends: keep keyboard focus in the card.
  useEffect(() => {
    if (busy || !cancelFocused.current) return;
    cancelFocused.current = false;
    chooseRef.current?.focus({ preventScroll: true });
  }, [busy]);

  const start = (files: File[]): void => {
    if (files.length === 0) return;
    void startFileImport(files).then((result) => {
      if (result && mounted.current) onImportedRef.current?.(result);
    });
  };

  const openPicker = (): void => {
    if (!busy) inputRef.current?.click();
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ''; // so the same files can be chosen again
    start(files);
  };

  const onZoneKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openPicker();
  };

  const onDragEnter = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = busy ? 'none' : 'copy';
  };

  const onDragLeave = (e: ReactDragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (busy) return;
    void filesFromDataTransfer(e.dataTransfer).then(start);
  };

  const dismiss = (): void => {
    dismissFileImportResult();
    chooseRef.current?.focus();
  };

  const progress = busy ? current.progress : null;
  const result = busy ? null : current.result;
  const fraction = progress?.filesTotal ? Math.min(1, progress.filesDone / progress.filesTotal) : undefined;
  const statusText = busy
    ? current.cancelling ? 'Stopping after the current file…' : progress?.message ?? 'Starting the import…'
    : result ? describeImportResult(result) : '';
  const issues = result
    ? [
      ...result.errors.map((e) => ({ name: e.name, text: e.message, error: true })),
      ...result.skipped.map((s) => ({ name: s.name, text: s.reason, error: false })),
    ]
    : [];
  const issuesLabel = result
    ? [
      result.errors.length ? plural(result.errors.length, 'error', 'errors') : '',
      result.skipped.length ? plural(result.skipped.length, 'skipped file', 'skipped files') : '',
    ].filter(Boolean).join(' and ')
    : '';

  const howTo = (
    <ul style={{ ...textStyle, margin: compact ? '0.5rem 0 0' : '0 0 1rem', paddingLeft: '1.25rem' }}>
      <li style={{ marginBottom: '0.35rem' }}>
        <strong style={{ color: 'var(--text)' }}>Strava archive:</strong> Strava → Settings → My Account → Download or
        Delete Your Account → Request your archive.
      </li>
      <li style={{ marginBottom: '0.35rem' }}>
        <strong style={{ color: 'var(--text)' }}>Garmin export:</strong> Garmin account → Data Management → Export Your
        Data.
      </li>
      <li>
        Each emails you a link to a ZIP file (it can take a while to arrive). Drop the ZIP here as it is: no need to
        unzip it.
      </li>
    </ul>
  );

  return (
    <div className="card" style={{
      borderLeftWidth: 3, borderLeftStyle: 'solid', borderLeftColor: 'var(--apollo-teal)',
      ...(compact ? { padding: '1.1rem 1.25rem' } : {}),
    }}>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', ...(compact ? { marginBottom: '0.6rem' } : {}) }}>
        <span style={{ color: 'var(--apollo-teal)' }}>Import activity files</span>
        <span style={badgeStyle}>No account needed</span>
      </h3>
      <p style={{ ...textStyle, margin: '0 0 0.75rem' }}>
        Works without an account. Add FIT, GPX or TCX files from any watch or app (Garmin, COROS, Suunto, Polar,
        Wahoo, Apple Watch, Zwift…), or move your full history over with a Strava or Garmin export.
      </p>
      {compact ? (
        <details style={{ margin: '0 0 0.75rem' }}>
          <summary style={summaryStyle}>How to export your full history</summary>
          {howTo}
        </details>
      ) : howTo}

      <div
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-disabled={busy}
        aria-describedby={hintId}
        onClick={openPicker}
        onKeyDown={onZoneKeyDown}
        onFocus={() => setZoneFocused(true)}
        onBlur={() => setZoneFocused(false)}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          border: `2px dashed ${dragging ? 'var(--apollo-teal)' : zoneFocused ? 'var(--apollo-gold)' : 'var(--border-strong)'}`,
          borderRadius: 'var(--radius-md)',
          background: dragging ? 'var(--apollo-teal-dim)' : 'var(--bg-surface)',
          boxShadow: zoneFocused ? '0 0 0 3px var(--apollo-gold-dim)' : 'none',
          outline: 'none',
          padding: compact ? '1rem' : '1.5rem 1rem',
          textAlign: 'center',
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
          transition: 'border-color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast)',
        }}
      >
        <div aria-hidden="true" style={{ fontSize: compact ? '1.4rem' : '1.75rem', lineHeight: 1, marginBottom: '0.5rem' }}>📂</div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, color: 'var(--text)' }}>
          {busy ? 'Importing…' : dragging ? 'Drop to import' : 'Drop files, folders or a ZIP export here'}
        </div>
        <div id={hintId} style={{ ...hintStyle, marginTop: '0.25rem' }}>
          FIT, GPX or TCX files (gzipped too) and Strava or Garmin ZIP exports. Click or press Enter to choose files.
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginTop: '0.75rem' }}>
        <button ref={chooseRef} type="button" className="btn btn-primary" onClick={openPicker} disabled={busy}>
          Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          onChange={onInputChange}
          tabIndex={-1}
          aria-hidden="true"
          style={{ display: 'none' }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginTop: statusText ? '0.75rem' : 0 }}>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{
            ...textStyle, flex: '1 1 16rem', minWidth: 0, overflowWrap: 'anywhere',
            color: 'var(--text)', fontWeight: result ? 600 : 400,
          }}
        >
          {statusText}
        </div>
        {busy && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={cancelFileImport}
            aria-disabled={current.cancelling}
            onFocus={() => {
              cancelFocused.current = true;
            }}
            onBlur={(e) => {
              if (e.relatedTarget) cancelFocused.current = false;
            }}
          >
            {current.cancelling ? 'Stopping…' : 'Cancel'}
          </button>
        )}
      </div>

      {busy && (
        <>
          <div aria-hidden="true" style={{
            height: 6, marginTop: '0.6rem', overflow: 'hidden',
            background: 'var(--bg-elevated)', borderRadius: 'var(--radius-full)',
          }}>
            <div style={{
              height: '100%', borderRadius: 'var(--radius-full)', background: 'var(--apollo-teal)',
              width: fraction === undefined ? '100%' : `${Math.max(2, Math.round(fraction * 100))}%`,
              opacity: fraction === undefined ? 0.3 : 1,
              transition: 'width var(--transition-base)',
            }} />
          </div>
          <p style={{ ...hintStyle, margin: '0.5rem 0 0' }}>
            {progress && progress.activitiesFound > 0
              ? `${plural(progress.activitiesFound, 'activity', 'activities')} found so far. `
              : ''}
            You can keep using Apollo while this runs.
          </p>
        </>
      )}

      {result && (
        <div style={{ marginTop: '0.75rem' }}>
          <dl style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', margin: 0 }}>
            {[
              { label: 'Added', value: result.added, color: 'var(--color-success)' },
              { label: 'Updated', value: result.updated, color: 'var(--apollo-teal)' },
              // The headline explains these: the store keeps the most recent MAX_STORED_ACTIVITIES.
              ...(result.dropped > 0 ? [{ label: 'Not kept', value: result.dropped, color: 'var(--color-warning)' }] : []),
              { label: 'Skipped', value: result.skipped.length, color: 'var(--text-secondary)' },
              { label: 'Errors', value: result.errors.length, color: result.errors.length ? 'var(--color-error)' : 'var(--text-secondary)' },
            ].map((stat) => (
              <div key={stat.label}>
                <dt className="label-micro">{stat.label}</dt>
                <dd style={{
                  margin: 0, fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--text-lg)',
                  color: stat.color, fontVariantNumeric: 'tabular-nums',
                }}>
                  {stat.value.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
          {issues.length > 0 && (
            <details style={{ marginTop: '0.75rem' }}>
              <summary style={summaryStyle}>Show {issuesLabel}</summary>
              <ul style={{ ...textStyle, margin: '0.5rem 0 0', paddingLeft: '1.25rem', maxHeight: '16rem', overflowY: 'auto' }}>
                {issues.slice(0, MAX_LISTED_ISSUES).map((issue, i) => (
                  <li key={i} style={{ marginBottom: '0.3rem', overflowWrap: 'anywhere' }}>
                    <span style={{ fontWeight: 600, color: issue.error ? 'var(--color-error)' : 'var(--text)' }}>{issue.name}</span>
                    {': '}
                    {issue.text}
                  </li>
                ))}
              </ul>
              {issues.length > MAX_LISTED_ISSUES && (
                <p style={{ ...hintStyle, margin: '0.35rem 0 0' }}>
                  …and {(issues.length - MAX_LISTED_ISSUES).toLocaleString()} more.
                </p>
              )}
            </details>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={dismiss}
            style={{ marginTop: '0.5rem', padding: '0.35rem 0.6rem', fontSize: 'var(--text-xs)' }}
          >
            Dismiss
          </button>
        </div>
      )}

      <p style={{ ...hintStyle, margin: '1rem 0 0' }}>
        {compact
          ? 'Files are read on this device and never uploaded.'
          : 'Files are read on this device and never uploaded. Importing the same files again won\'t create duplicates, '
            + 'and activities already synced from intervals.icu or Strava are matched rather than copied.'}
      </p>
    </div>
  );
}
