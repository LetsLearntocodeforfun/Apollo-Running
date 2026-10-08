/**
 * "Add your plan to your calendar" card.
 *
 * Downloads the active plan (overlay applied: moved and skipped workouts on
 * their current dates) as an .ics file for Apple Calendar, Google Calendar or
 * Outlook — one all-day event per workout with distance and target paces in
 * the athlete's unit (services/calendarExport). Works in the browser and in
 * Electron (Blob + `<a download>`).
 *
 * Self-contained: it reads the active plan and connection state itself, so it
 * can sit on the Plan page next to PlanCalendarPush.
 */

import { useEffect, useId, useState } from 'react';
import {
  downloadICS,
  exportActivePlan,
  getActivePlanExportInfo,
  resolveExportPaces,
} from '../services/calendarExport';
import { onPlanOverlayChanged } from '../services/planOverlay';
import { getIntervalsCredentials } from '../services/storage';
import { getDistanceUnit } from '../services/unitPreferences';
import { isDateKey, parseDateKey } from '../utils/localDate';
import { EmptyState } from './ui';
import './PlanCalendarExport.css';

export interface PlanCalendarExportProps {
  /** Heading level of the card title. Default 3 (the card sits under a page or tab h2). */
  headingLevel?: 2 | 3 | 4;
}

type Status = { kind: 'success' | 'error'; text: string } | null;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Oct 12" for a local YYYY-MM-DD key. */
function formatDay(dateKey: string | null): string {
  if (!dateKey || !isDateKey(dateKey)) return dateKey ?? '';
  return parseDateKey(dateKey).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Card with the export options and a "Download .ics" button. */
export default function PlanCalendarExport({ headingLevel = 3 }: PlanCalendarExportProps) {
  const titleId = useId();
  const [includeRestDays, setIncludeRestDays] = useState(false);
  const [fromToday, setFromToday] = useState(true);
  const [status, setStatus] = useState<Status>(null);
  const [, setPlanVersion] = useState(0);

  // Moves, skips and plan switches change what would be exported.
  useEffect(() => onPlanOverlayChanged(() => {
    setPlanVersion((n) => n + 1);
    setStatus(null);
  }), []);

  // Cheap synchronous reads, re-evaluated on every render.
  const info = getActivePlanExportInfo();
  const unit = getDistanceUnit();
  const hasPaces = resolveExportPaces() !== null;
  const intervalsConnected = !!getIntervalsCredentials();
  const Heading = `h${headingLevel}` as 'h2' | 'h3' | 'h4';

  const handleDownload = () => {
    const result = exportActivePlan({ includeRestDays, fromToday });
    if (!result) {
      setStatus({ kind: 'error', text: 'There is no active training plan to export.' });
      return;
    }
    if (result.totalEvents === 0) {
      setStatus({
        kind: 'error',
        text: fromToday
          ? 'No workouts are left from today on. Turn off “From today only” to export the whole plan.'
          : 'This plan has no workouts to export.',
      });
      return;
    }
    if (!downloadICS(result)) {
      setStatus({ kind: 'error', text: 'Downloads aren’t available here. Try again from the desktop app or another browser.' });
      return;
    }
    setStatus({
      kind: 'success',
      text: `Downloaded ${plural(result.totalEvents, 'event')} (${formatDay(result.firstDate)} – ${formatDay(result.lastDate)}). `
        + `Open ${result.fileName} to add them to your calendar.`,
    });
  };

  return (
    <section className="card plan-ics" aria-labelledby={titleId}>
      <Heading id={titleId} className="plan-ics-title">
        <span aria-hidden="true">📅</span> Add your plan to your calendar
      </Heading>
      <p className="plan-ics-text">
        Download an .ics file for Apple Calendar, Google Calendar or Outlook. Each workout becomes an all-day event
        with its distance{hasPaces ? ' and target paces' : ''}.
      </p>

      {!info ? (
        <EmptyState title="No active plan">
          Choose a training plan first, then you can add its workouts to your calendar.
        </EmptyState>
      ) : (
        <>
          <p className="plan-ics-meta">
            {info.planName} · {formatDay(info.startDate)} – {formatDay(info.endDate)} · distances in {unit}
          </p>
          <fieldset className="plan-ics-options">
            <legend className="sr-only">Export options</legend>
            <label className="plan-ics-option">
              <input
                type="checkbox"
                checked={includeRestDays}
                onChange={(e) => { setIncludeRestDays(e.target.checked); setStatus(null); }}
              />
              Include rest days
            </label>
            <label className="plan-ics-option">
              <input
                type="checkbox"
                checked={fromToday}
                onChange={(e) => { setFromToday(e.target.checked); setStatus(null); }}
              />
              From today only
            </label>
          </fieldset>
          <div className="plan-ics-actions">
            <button type="button" className="btn btn-primary" onClick={handleDownload}>
              Download .ics
            </button>
          </div>
          {status && (
            <p
              className={`plan-ics-status plan-ics-status--${status.kind}`}
              role={status.kind === 'error' ? 'alert' : 'status'}
            >
              {status.text}
            </p>
          )}
          {!hasPaces && (
            <p className="plan-ics-hint">
              Target paces are added once Apollo knows your training paces (from your race prediction).
            </p>
          )}
          <p className="plan-ics-hint">
            A calendar file doesn’t update itself: download and import it again after you change your plan.
            Events keep the same IDs, so most calendar apps update them instead of adding duplicates.
          </p>
          {intervalsConnected && (
            <p className="plan-ics-hint plan-ics-hint--push">
              intervals.icu is connected: “Send your plan to your watch” keeps your intervals.icu calendar — and your
              watch — up to date automatically, with structured workouts.
            </p>
          )}
        </>
      )}
    </section>
  );
}
