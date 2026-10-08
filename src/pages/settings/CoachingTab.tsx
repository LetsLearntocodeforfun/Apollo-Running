/**
 * Settings › Coaching — daily recap, weekly Race Day Readiness, adaptive
 * training recommendations, and a pointer to the Plan page (plan changes
 * happen there; the plan picker can still be reopened from here).
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../../components/ui';
import {
  getCoachingPreferences,
  setCoachingPreferences,
  WEEKDAY_NAMES,
  type CoachingPreferences,
} from '../../services/coachingPreferences';
import { getAdaptivePreferences, setAdaptivePreferences } from '../../services/adaptiveTraining';
import type { AdaptivePreferences } from '../../types/recommendations';
import { setWelcomeCompleted } from '../../services/planProgress';
import { reloadApp } from './appReload';
import { StatusLine, useStatus } from './shared';

export default function CoachingTab() {
  const [coachPrefs, setCoachPrefs] = useState<CoachingPreferences>(() => getCoachingPreferences());
  const [adaptivePrefs, setAdaptivePrefsState] = useState<AdaptivePreferences>(() => getAdaptivePreferences());
  const [confirmPicker, setConfirmPicker] = useState(false);
  const recapStatus = useStatus();
  const adaptiveStatus = useStatus();

  const updateCoaching = (patch: Partial<CoachingPreferences>, message?: string) => {
    const next = { ...coachPrefs, ...patch };
    setCoachingPreferences(next);
    setCoachPrefs(next);
    if (message) recapStatus.success(message);
  };

  const updateAdaptive = (patch: Partial<AdaptivePreferences>, message?: string) => {
    const next = { ...adaptivePrefs, ...patch };
    setAdaptivePreferences(next);
    setAdaptivePrefsState(next);
    if (message) adaptiveStatus.success(message);
  };

  return (
    <>
      <div className="card settings-card settings-card--teal">
        <h2 className="card-title settings-card-title">Recaps</h2>
        <p className="settings-lead">Your daily training recap and weekly Race Day Readiness check-in.</p>

        <div className="settings-row">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={coachPrefs.dailyRecapEnabled}
              onChange={(e) => updateCoaching(
                { dailyRecapEnabled: e.target.checked },
                `Daily recap turned ${e.target.checked ? 'on' : 'off'}.`,
              )}
            />
            <span>Daily training recap</span>
          </label>
          {coachPrefs.dailyRecapEnabled && (
            <span className="settings-inline-field">
              <label htmlFor="settings-recap-time" className="settings-label">Recap time</label>
              <input
                id="settings-recap-time"
                type="time"
                value={coachPrefs.dailyRecapTime}
                onChange={(e) => updateCoaching({ dailyRecapTime: e.target.value })}
                onBlur={() => recapStatus.success(`Daily recap at ${coachPrefs.dailyRecapTime}.`)}
                className="settings-input settings-input--short"
              />
            </span>
          )}
        </div>

        <div className="settings-row">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={coachPrefs.weeklyRecapEnabled}
              onChange={(e) => updateCoaching(
                { weeklyRecapEnabled: e.target.checked },
                `Weekly readiness turned ${e.target.checked ? 'on' : 'off'}.`,
              )}
            />
            <span>Weekly Race Day Readiness</span>
          </label>
          {coachPrefs.weeklyRecapEnabled && (
            <span className="settings-inline-field">
              <label htmlFor="settings-weekly-day" className="settings-label">Day</label>
              <select
                id="settings-weekly-day"
                value={coachPrefs.weeklyRecapDay}
                onChange={(e) => {
                  const day = Number(e.target.value);
                  updateCoaching({ weeklyRecapDay: day }, `Weekly readiness on ${WEEKDAY_NAMES[day] ?? 'the chosen day'}.`);
                }}
                className="settings-select"
              >
                {WEEKDAY_NAMES.map((name, i) => (
                  <option key={name} value={i}>{name}</option>
                ))}
              </select>
            </span>
          )}
        </div>
        <StatusLine status={recapStatus.status} />
      </div>

      <div className="card settings-card settings-card--gold">
        <h2 className="card-title settings-card-title">Adaptive training recommendations</h2>
        <p className="settings-lead">
          Apollo looks at your synced activities and plan progress to suggest adjustments — like easing off when you&apos;re
          overreaching or progressing when you&apos;re ahead of schedule.
        </p>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={adaptivePrefs.enabled}
            onChange={(e) => updateAdaptive(
              { enabled: e.target.checked },
              `Adaptive recommendations turned ${e.target.checked ? 'on' : 'off'}.`,
            )}
          />
          <span>Show adaptive recommendations</span>
        </label>
        {adaptivePrefs.enabled && (
          <div className="settings-grid">
            <div className="settings-field">
              <label htmlFor="settings-adaptive-frequency" className="settings-label">Frequency</label>
              <select
                id="settings-adaptive-frequency"
                value={adaptivePrefs.frequency}
                onChange={(e) => updateAdaptive(
                  { frequency: e.target.value as AdaptivePreferences['frequency'] },
                  'Recommendation frequency saved.',
                )}
                className="settings-select"
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="before_key_workouts">Before key workouts</option>
              </select>
            </div>
            <div className="settings-field">
              <label htmlFor="settings-adaptive-aggressiveness" className="settings-label">Aggressiveness</label>
              <select
                id="settings-adaptive-aggressiveness"
                value={adaptivePrefs.aggressiveness}
                onChange={(e) => updateAdaptive(
                  { aggressiveness: e.target.value as AdaptivePreferences['aggressiveness'] },
                  'Recommendation sensitivity saved.',
                )}
                className="settings-select"
              >
                <option value="conservative">Conservative — fewer, gentler suggestions</option>
                <option value="balanced">Balanced — default sensitivity</option>
                <option value="aggressive">Aggressive — more proactive suggestions</option>
              </select>
            </div>
          </div>
        )}
        <p className="settings-hint">
          Recommendations use your synced activities, plan completion, readiness scores and pace trends. Nothing leaves your device.
        </p>
        <StatusLine status={adaptiveStatus.status} />
      </div>

      <div className="card settings-card">
        <h2 className="card-title settings-card-title">Training plan</h2>
        <p className="settings-lead">
          Your plan, its schedule and any changes to it live on the <Link to="/plan">Plan page</Link>.
        </p>
        <p className="settings-hint">
          To start over with a different plan from the library (Hal Higdon, Hanson&apos;s, Pfitzinger, Nike Run Club, FIRST) or build a
          custom one, reopen the plan picker.
        </p>
        <div className="settings-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setConfirmPicker(true)}>
            Show plan picker again
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmPicker}
        title="Show the plan picker again?"
        message="Apollo reloads and opens the welcome screen so you can choose or build a plan. Your activities and settings stay on this device."
        confirmLabel="Show plan picker"
        onConfirm={() => {
          setConfirmPicker(false);
          setWelcomeCompleted(false);
          reloadApp();
        }}
        onCancel={() => setConfirmPicker(false)}
      />
    </>
  );
}
