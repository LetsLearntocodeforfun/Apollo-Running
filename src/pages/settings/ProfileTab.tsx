/**
 * Settings › Athlete Profile — display units (applied immediately) and the
 * personal inputs other features rely on: heart rate, weight, a recent race,
 * goal marathon time and race-fueling preferences. Stored in athleteProfile.ts
 * (HR stays in heartRate.ts); this is the only place goal time is edited.
 */

import { useState, type FormEvent } from 'react';
import {
  DEFAULT_CARB_TOLERANCE_G_PER_HOUR,
  getAthleteProfile,
  getMassUnit,
  getTemperatureUnit,
  updateAthleteProfile,
  type MassUnit,
  type TemperatureUnit,
} from '../../services/athleteProfile';
import { getDistanceUnit, setDistanceUnit, type DistanceUnit } from '../../services/unitPreferences';
import { getHRProfile, setHRProfile } from '../../services/heartRate';
import { syncPlanCalendarIfChanged } from '../../services/planCalendarSync';
import { todayKey } from '../../utils/localDate';
import {
  PROFILE_FIELD_ORDER,
  RACE_PRESETS,
  convertDraftUnits,
  draftFromProfile,
  validateProfileDraft,
  type ProfileDraft,
  type ProfileErrors,
  type ProfileField,
  type RaceDistanceChoice,
} from './profileForm';
import { StatusLine, useStatus } from './shared';

/** Element id for a profile field's input. */
const fieldId = (field: ProfileField) => `settings-profile-${field}`;

interface UnitOption<T extends string> {
  value: T;
  label: string;
  detail?: string;
}

interface UnitToggleProps<T extends string> {
  id: string;
  label: string;
  hint: string;
  options: UnitOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/** Two-way unit switch: a labelled group of toggle buttons (aria-pressed). */
function UnitToggle<T extends string>({ id, label, hint, options, value, onChange }: UnitToggleProps<T>) {
  return (
    <div className="settings-unit-group">
      <span id={`${id}-label`} className="settings-label">{label}</span>
      <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className="settings-segmented">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="settings-segment"
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            <span className="settings-segment-main">{o.label}</span>
            {o.detail && <span className="settings-segment-detail">{o.detail}</span>}
          </button>
        ))}
      </div>
      <p id={`${id}-hint`} className="settings-hint">{hint}</p>
    </div>
  );
}

function FieldError({ field, errors }: { field: ProfileField; errors: ProfileErrors }) {
  const error = errors[field];
  return error ? <p id={`${fieldId(field)}-error`} className="settings-field-error">{error}</p> : null;
}

export default function ProfileTab() {
  const unitsStatus = useStatus();
  const saveStatus = useStatus();
  const [distanceUnit, setDistanceUnitState] = useState<DistanceUnit>(() => getDistanceUnit());
  const [temperatureUnit, setTemperatureUnitState] = useState<TemperatureUnit>(() => getTemperatureUnit());
  const [massUnit, setMassUnitState] = useState<MassUnit>(() => getMassUnit());
  const [draft, setDraft] = useState<ProfileDraft>(
    () => draftFromProfile(getAthleteProfile(), getHRProfile(), getMassUnit(), getDistanceUnit()),
  );
  const [errors, setErrors] = useState<ProfileErrors>({});

  const set = <K extends ProfileField>(field: K, value: ProfileDraft[K]) => {
    setDraft((d) => ({ ...d, [field]: value }));
  };

  /** aria wiring for an input: hint(s) plus its inline error. */
  const describe = (field: ProfileField, hintId?: string) => {
    const error = errors[field];
    const ids = [hintId, error ? `${fieldId(field)}-error` : undefined].filter(Boolean).join(' ');
    return {
      id: fieldId(field),
      'aria-invalid': error ? (true as const) : undefined,
      'aria-describedby': ids || undefined,
    };
  };

  /** Re-read units after a change (temperature/mass default from the distance unit). */
  const refreshUnits = () => {
    const from = { mass: massUnit, distance: distanceUnit };
    const to = { mass: getMassUnit(), distance: getDistanceUnit() };
    setDistanceUnitState(to.distance);
    setTemperatureUnitState(getTemperatureUnit());
    setMassUnitState(to.mass);
    setDraft((d) => convertDraftUnits(d, from, to));
  };

  const chooseDistanceUnit = (unit: DistanceUnit) => {
    setDistanceUnit(unit);
    void syncPlanCalendarIfChanged();
    refreshUnits();
    unitsStatus.success(unit === 'km' ? 'Distances and paces now show in kilometers.' : 'Distances and paces now show in miles.');
  };

  const chooseTemperatureUnit = (unit: TemperatureUnit) => {
    updateAthleteProfile({ temperatureUnit: unit });
    refreshUnits();
    unitsStatus.success(`Temperatures now show in °${unit}.`);
  };

  const chooseMassUnit = (unit: MassUnit) => {
    updateAthleteProfile({ massUnit: unit });
    refreshUnits();
    unitsStatus.success(`Weights now show in ${unit}.`);
  };

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    const result = validateProfileDraft(draft, massUnit, distanceUnit);
    setErrors(result.errors);
    if (!result.patch || !result.hr) {
      saveStatus.error('Nothing was saved. Fix the highlighted fields and try again.');
      const first = PROFILE_FIELD_ORDER.find((f) => result.errors[f]);
      if (first) document.getElementById(fieldId(first))?.focus();
      return;
    }
    const currentHR = getHRProfile();
    if (currentHR.maxHR !== result.hr.maxHR || currentHR.restingHR !== result.hr.restingHR) {
      setHRProfile({ ...currentHR, ...result.hr, source: 'manual', updatedAt: new Date().toISOString() });
    }
    const saved = updateAthleteProfile(result.patch);
    setDraft(draftFromProfile(saved, getHRProfile(), massUnit, distanceUnit));
    saveStatus.success('Profile saved.');
  };

  const raceIsCustom = draft.raceDistance === 'custom';

  return (
    <>
      <div className="card settings-card settings-card--gold">
        <h2 className="card-title settings-card-title">Units</h2>
        <p className="settings-lead">Changes apply right away across Apollo.</p>
        <div className="settings-unit-grid">
          <UnitToggle<DistanceUnit>
            id="settings-unit-distance"
            label="Distance and pace"
            hint="Used for every distance, pace and elevation in Apollo."
            value={distanceUnit}
            onChange={chooseDistanceUnit}
            options={[
              { value: 'mi', label: 'Miles', detail: 'min/mi · ft' },
              { value: 'km', label: 'Kilometers', detail: 'min/km · m' },
            ]}
          />
          <UnitToggle<TemperatureUnit>
            id="settings-unit-temperature"
            label="Temperature"
            hint="Used for race-day weather and heat adjustments."
            value={temperatureUnit}
            onChange={chooseTemperatureUnit}
            options={[
              { value: 'F', label: '°F', detail: 'Fahrenheit' },
              { value: 'C', label: '°C', detail: 'Celsius' },
            ]}
          />
          <UnitToggle<MassUnit>
            id="settings-unit-mass"
            label="Body weight"
            hint="Used wherever Apollo shows or asks for your weight."
            value={massUnit}
            onChange={chooseMassUnit}
            options={[
              { value: 'kg', label: 'kg', detail: 'Kilograms' },
              { value: 'lb', label: 'lb', detail: 'Pounds' },
            ]}
          />
        </div>
        <StatusLine status={unitsStatus.status} />
      </div>

      <form noValidate onSubmit={handleSave} aria-label="Athlete profile">
        <div className="card settings-card settings-card--teal">
          <h2 className="card-title settings-card-title">Heart rate &amp; body</h2>
          <div className="settings-grid">
            <div className="settings-field">
              <label htmlFor={fieldId('maxHR')} className="settings-label">Max heart rate (bpm)</label>
              <input
                {...describe('maxHR', 'settings-profile-hr-hint')}
                type="number"
                inputMode="numeric"
                min={100}
                max={230}
                value={draft.maxHR}
                onChange={(e) => set('maxHR', e.target.value)}
                className="settings-input settings-input--short"
              />
              <FieldError field="maxHR" errors={errors} />
            </div>
            <div className="settings-field">
              <label htmlFor={fieldId('restingHR')} className="settings-label">Resting heart rate (bpm)</label>
              <input
                {...describe('restingHR', 'settings-profile-hr-hint')}
                type="number"
                inputMode="numeric"
                min={30}
                max={120}
                value={draft.restingHR}
                onChange={(e) => set('restingHR', e.target.value)}
                className="settings-input settings-input--short"
              />
              <FieldError field="restingHR" errors={errors} />
            </div>
          </div>
          <p id="settings-profile-hr-hint" className="settings-hint">
            Used for heart-rate zones and HR-based fitness estimates. Max HR also updates itself when a synced activity records a higher value.
          </p>

          <div className="settings-grid">
            <div className="settings-field">
              <label htmlFor={fieldId('weight')} className="settings-label">Weight ({massUnit})</label>
              <input
                {...describe('weight', 'settings-profile-weight-hint')}
                type="number"
                inputMode="decimal"
                step="0.1"
                value={draft.weight}
                onChange={(e) => set('weight', e.target.value)}
                className="settings-input settings-input--short"
              />
              <p id="settings-profile-weight-hint" className="settings-hint">Used for fueling, carb-loading and hydration amounts.</p>
              <FieldError field="weight" errors={errors} />
            </div>
            <div className="settings-field">
              <label htmlFor={fieldId('birthYear')} className="settings-label">Birth year (optional)</label>
              <input
                {...describe('birthYear', 'settings-profile-private-hint')}
                type="number"
                inputMode="numeric"
                placeholder="e.g. 1988"
                value={draft.birthYear}
                onChange={(e) => set('birthYear', e.target.value)}
                className="settings-input settings-input--short"
              />
              <FieldError field="birthYear" errors={errors} />
            </div>
            <div className="settings-field">
              <label htmlFor={fieldId('sex')} className="settings-label">Sex (optional)</label>
              <select
                {...describe('sex', 'settings-profile-private-hint')}
                value={draft.sex}
                onChange={(e) => set('sex', e.target.value as ProfileDraft['sex'])}
                className="settings-select"
              >
                <option value="">Not set</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="unspecified">Prefer not to say</option>
              </select>
            </div>
          </div>
          <p id="settings-profile-private-hint" className="settings-hint">
            Optional. Used only to refine estimates; never leaves this device.
          </p>
        </div>

        <div className="card settings-card settings-card--gold">
          <h2 className="card-title settings-card-title">Recent race &amp; goal</h2>
          <fieldset className="settings-fieldset">
            <legend className="settings-label">Recent race result</legend>
            <p id="settings-profile-race-hint" className="settings-hint">
              Used for your VDOT, training paces and race prediction (the most reliable source). Use an all-out race from the last few months.
            </p>
            <div className="settings-grid">
              <div className="settings-field">
                <label htmlFor={fieldId('raceDistance')} className="settings-label">Distance</label>
                <select
                  {...describe('raceDistance', 'settings-profile-race-hint')}
                  value={draft.raceDistance}
                  onChange={(e) => set('raceDistance', e.target.value as RaceDistanceChoice)}
                  className="settings-select"
                >
                  <option value="">No recent race</option>
                  {RACE_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                  <option value="custom">Custom distance</option>
                </select>
                <FieldError field="raceDistance" errors={errors} />
              </div>
              {raceIsCustom && (
                <div className="settings-field">
                  <label htmlFor={fieldId('raceCustom')} className="settings-label">Custom distance ({distanceUnit})</label>
                  <input
                    {...describe('raceCustom')}
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={draft.raceCustom}
                    onChange={(e) => set('raceCustom', e.target.value)}
                    className="settings-input settings-input--short"
                  />
                  <FieldError field="raceCustom" errors={errors} />
                </div>
              )}
              <div className="settings-field">
                <label htmlFor={fieldId('raceTime')} className="settings-label">Finish time</label>
                <input
                  {...describe('raceTime', 'settings-profile-race-time-hint')}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="h:mm:ss or mm:ss"
                  value={draft.raceTime}
                  onChange={(e) => set('raceTime', e.target.value)}
                  className="settings-input settings-input--short"
                />
                <p id="settings-profile-race-time-hint" className="settings-hint">e.g. 1:45:30 or 24:10</p>
                <FieldError field="raceTime" errors={errors} />
              </div>
              <div className="settings-field">
                <label htmlFor={fieldId('raceDate')} className="settings-label">Date</label>
                <input
                  {...describe('raceDate')}
                  type="date"
                  max={todayKey()}
                  value={draft.raceDate}
                  onChange={(e) => set('raceDate', e.target.value)}
                  className="settings-input settings-input--short"
                />
                <FieldError field="raceDate" errors={errors} />
              </div>
              <div className="settings-field">
                <label htmlFor={fieldId('raceName')} className="settings-label">Race name (optional)</label>
                <input
                  {...describe('raceName')}
                  type="text"
                  autoComplete="off"
                  maxLength={80}
                  value={draft.raceName}
                  onChange={(e) => set('raceName', e.target.value)}
                  className="settings-input"
                />
              </div>
            </div>
          </fieldset>

          <div className="settings-field">
            <label htmlFor={fieldId('goalTime')} className="settings-label">Goal marathon time (optional)</label>
            <input
              {...describe('goalTime', 'settings-profile-goal-hint')}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="h:mm:ss"
              value={draft.goalTime}
              onChange={(e) => set('goalTime', e.target.value)}
              className="settings-input settings-input--short"
            />
            <p id="settings-profile-goal-hint" className="settings-hint">Used for Race Day pacing and fueling plans.</p>
            <FieldError field="goalTime" errors={errors} />
          </div>
        </div>

        <div className="card settings-card">
          <h2 className="card-title settings-card-title">Race fueling</h2>
          <div className="settings-field">
            <label htmlFor={fieldId('carbTolerance')} className="settings-label">Carbs you can take per hour (g/h)</label>
            <input
              {...describe('carbTolerance', 'settings-profile-carb-hint')}
              type="number"
              inputMode="numeric"
              min={0}
              max={120}
              placeholder={String(DEFAULT_CARB_TOLERANCE_G_PER_HOUR)}
              value={draft.carbTolerance}
              onChange={(e) => set('carbTolerance', e.target.value)}
              className="settings-input settings-input--short"
            />
            <p id="settings-profile-carb-hint" className="settings-hint">
              Used to size your race fueling plan. Leave empty to use {DEFAULT_CARB_TOLERANCE_G_PER_HOUR} g/h.
            </p>
            <FieldError field="carbTolerance" errors={errors} />
          </div>
          <label className="settings-check">
            <input
              id={fieldId('caffeine')}
              type="checkbox"
              checked={draft.caffeine}
              aria-describedby="settings-profile-caffeine-hint"
              onChange={(e) => set('caffeine', e.target.checked)}
            />
            <span>I use caffeine during races</span>
          </label>
          <p id="settings-profile-caffeine-hint" className="settings-hint settings-indent">Used to add caffeine timing to your fueling plan.</p>
        </div>

        <div className="settings-save-bar">
          <button type="submit" className="btn btn-primary">Save profile</button>
          <StatusLine status={saveStatus.status} />
        </div>
      </form>
    </>
  );
}
