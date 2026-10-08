/**
 * Settings › Sync — automatic activity sync, the while-open interval and
 * wellness (sleep, HRV, resting HR) sync. Everything here is off unless the
 * athlete turns it on (here, or when connecting intervals.icu).
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { isActivitySourceConnected, isIntervalsConnected } from '../../services/activitySource';
import { BACKGROUND_SYNC_OPTIONS } from '../../services/appPreferences';
import { syncWellness } from '../../services/wellness';
import { StatusLine, settingsTabPath, useAppPrefs, useStatus } from './shared';

function backgroundSyncLabel(minutes: number): string {
  if (minutes <= 0) return 'Only when Apollo opens';
  if (minutes === 60) return 'Every hour';
  if (minutes > 60 && minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/** Offered intervals, keeping a custom stored value selectable. */
function backgroundSyncChoices(current: number): number[] {
  const options = [...BACKGROUND_SYNC_OPTIONS];
  if (!options.includes(current)) options.push(current);
  return options.sort((a, b) => a - b);
}

export default function SyncTab() {
  const [appPrefs, updateAppPrefs] = useAppPrefs();
  const [hasSource] = useState(() => isActivitySourceConnected());
  const [intervalsConnected] = useState(() => isIntervalsConnected());
  const activityStatus = useStatus();
  const wellnessStatus = useStatus();

  return (
    <>
      <div className="card settings-card settings-card--teal">
        <h2 className="card-title settings-card-title">Automatic activity sync</h2>
        <p className="settings-lead">
          Nothing syncs in the background unless you turn it on here or choose it when connecting a service.
          You can always sync by hand from Settings › Connections.
        </p>
        {!hasSource && (
          <p className="settings-callout">
            Connect a service first:{' '}
            <Link to={settingsTabPath('connections')}>Settings › Connections › intervals.icu › Connect &amp; import history</Link>.
          </p>
        )}
        <label className="settings-check">
          <input
            type="checkbox"
            checked={appPrefs.autoSyncOnLaunch}
            aria-describedby="settings-auto-sync-hint"
            onChange={(e) => {
              const checked = e.target.checked;
              updateAppPrefs({ autoSyncOnLaunch: checked });
              activityStatus.success(`Automatic activity sync turned ${checked ? 'on' : 'off'}.`);
            }}
          />
          <span>Sync new activities automatically when Apollo opens and while it runs</span>
        </label>
        <p id="settings-auto-sync-hint" className="settings-hint settings-indent">
          Syncs every connected service when Apollo opens and, while it&apos;s open, on the schedule below — so each day&apos;s
          runs, rides and other workouts arrive on their own.
        </p>
        <div className="settings-row settings-indent">
          <label htmlFor="settings-background-sync" className="settings-label">Sync while open</label>
          <select
            id="settings-background-sync"
            value={appPrefs.backgroundSyncMinutes}
            disabled={!appPrefs.autoSyncOnLaunch}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              updateAppPrefs({ backgroundSyncMinutes: minutes });
              activityStatus.success(`Sync while open: ${backgroundSyncLabel(minutes).toLowerCase()}.`);
            }}
            className="settings-select"
          >
            {backgroundSyncChoices(appPrefs.backgroundSyncMinutes).map((minutes) => (
              <option key={minutes} value={minutes}>{backgroundSyncLabel(minutes)}</option>
            ))}
          </select>
        </div>
        <StatusLine status={activityStatus.status} />
      </div>

      <div className="card settings-card">
        <h2 className="card-title settings-card-title">Wellness data</h2>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={appPrefs.syncWellness}
            aria-describedby="settings-wellness-hint"
            onChange={(e) => {
              const checked = e.target.checked;
              updateAppPrefs({ syncWellness: checked });
              wellnessStatus.success(`Wellness sync turned ${checked ? 'on' : 'off'}.`);
              if (checked && intervalsConnected) void syncWellness();
            }}
          />
          <span>Also sync sleep, HRV and resting HR (wellness data)</span>
        </label>
        <p id="settings-wellness-hint" className="settings-hint settings-indent">
          From intervals.icu, whenever activities sync. Powers the Recovery card and fills in your heart-rate profile.
          Your watch platform must share wellness with intervals.icu — for Garmin, allow <strong>Download wellness data</strong>.
          {!intervalsConnected && ' Only works while intervals.icu is connected.'}
        </p>
        <StatusLine status={wellnessStatus.status} />
      </div>

      <p className="settings-note">
        Sending your training plan to intervals.icu (and your watch) is set up on the <Link to="/plan">Plan page</Link>.
      </p>
    </>
  );
}
