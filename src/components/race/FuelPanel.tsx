/**
 * Fuel tab of the Race Day hub (v1.0.6): race fueling timeline, carb-load
 * planner and safe hydration guidance.
 *
 * Everything is computed from the shared RaceDayContext and the athlete
 * profile. The only writes are explicit Save buttons (carb tolerance, body
 * mass) through `updateAthleteProfile` — nothing is persisted while rendering.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { RaceDayContext, RacePanelProps } from './types';
import type { CarbLoadingDay } from '../../types/nutrition';
import { EmptyState } from '../ui';
import {
  planRaceFueling,
  fluidCeilingMlPerHour,
  MAX_PLANNED_FLUID_ML_PER_HOUR,
} from '../../services/fuelingCalculator';
import {
  generateCarbLoadingProtocol,
  CARB_LOAD_G_PER_KG_OPTIONS,
  CARB_LOAD_MASS_CAP_KG,
  DEFAULT_CARB_LOAD_G_PER_KG,
} from '../../services/carbLoading';
import {
  getAthleteProfile,
  updateAthleteProfile,
  onAthleteProfileChanged,
  getCarbToleranceGPerHour,
  getMassUnit,
  formatMassKg,
  formatTemperatureF,
  lbToKg,
} from '../../services/athleteProfile';
import type { AthleteProfile } from '../../services/athleteProfile';
import { getDistanceUnit, milesToUnit, unitLabel } from '../../services/unitPreferences';
import type { DistanceUnit } from '../../services/unitPreferences';
import { distanceAtTime, getRaceDistanceMi, getStrategyDistanceMi } from '../../services/raceStrategy';
import { addDays, isDateKey, parseDateKey } from '../../utils/localDate';
import './Fuel.css';

const ML_PER_OZ = 29.5735;
const CARB_TOLERANCE_MIN = 30;
const CARB_TOLERANCE_MAX = 90;
const MASS_LIMITS_KG = { min: 25, max: 250 };

// ── Formatting helpers ───────────────────────────────────────────────────────

/** "400 mL" for km users, "400 mL (14 oz)" for mile users. */
function formatFluidMl(ml: number, unit: DistanceUnit): string {
  const rounded = Math.round(ml / 10) * 10;
  return unit === 'mi' ? `${rounded} mL (${Math.round(ml / ML_PER_OZ)} oz)` : `${rounded} mL`;
}

/** Elapsed race time as h:mm, e.g. "0:25", "1:15". */
function formatRaceClock(sec: number): string {
  const totalMin = Math.round(sec / 60);
  return `${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, '0')}`;
}

function formatDistanceMi(mi: number, unit: DistanceUnit): string {
  return `${milesToUnit(mi, unit).toFixed(1)} ${unitLabel(unit)}`;
}

function formatDayDate(dateKey: string): string {
  return parseDateKey(dateKey).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Race-local 'HH:mm' three hours before a 'HH:mm' start, or null. */
function breakfastTime(startTime: string | null): string | null {
  const m = startTime ? /^(\d{1,2}):(\d{2})$/.exec(startTime) : null;
  if (!m) return null;
  const minutes = (((Number(m[1]) * 60 + Number(m[2]) - 180) % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** The stored athlete profile, refreshed whenever it changes. */
function useAthleteProfile(): AthleteProfile {
  const [profile, setProfile] = useState<AthleteProfile>(() => getAthleteProfile());
  useEffect(() => onAthleteProfileChanged(() => setProfile(getAthleteProfile())), []);
  return profile;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

/** Fuel tab: fueling timeline, carb loading and hydration for the selected race. */
export default function FuelPanel({ ctx }: RacePanelProps) {
  const profile = useAthleteProfile();
  const unit = getDistanceUnit();
  return (
    <div className="fuel-panel">
      <FuelTimelineSection ctx={ctx} profile={profile} unit={unit} />
      <CarbLoadSection ctx={ctx} profile={profile} />
      <HydrationSection ctx={ctx} profile={profile} unit={unit} />
    </div>
  );
}

interface SectionProps {
  ctx: RaceDayContext;
  profile: AthleteProfile;
  unit: DistanceUnit;
}

// ── 1. Race fueling timeline ─────────────────────────────────────────────────

function FuelTimelineSection({ ctx, profile, unit }: SectionProps) {
  const headingId = useId();
  const carbsPerHourG = profile.carbToleranceGPerHour ?? getCarbToleranceGPerHour();
  const { race, strategy } = ctx;
  const finishSec = strategy?.targetTimeSec ?? ctx.goalTimeSec ?? null;
  const distanceMi = strategy ? getStrategyDistanceMi(strategy) : race ? getRaceDistanceMi(race) : null;

  const plan = useMemo(() => {
    if (!race || !finishSec || !distanceMi) return null;
    const milePaces = strategy?.milePaces ?? [];
    return planRaceFueling({
      finishSec,
      distanceMi,
      carbsPerHourG,
      distanceAtTimeSec: milePaces.length > 0 ? (t) => distanceAtTime(milePaces, t) : undefined,
      aidStations: race.aidStations,
    });
  }, [race, strategy, finishSec, distanceMi, carbsPerHourG]);

  return (
    <section className="fuel-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Race fueling</h3>
      <CarbToleranceForm current={carbsPerHourG} />
      {!race ? (
        <EmptyState title="Pick a race to plan your fueling">
          Choose your race and goal time, and this tab works out when to take each gel.
        </EmptyState>
      ) : !plan ? (
        <EmptyState title="Add a goal time">
          Set a goal time or build a pacing strategy to see when to take each gel.
        </EmptyState>
      ) : (
        <>
          <ul className="fuel-chips" aria-label="Fueling summary">
            <li className="fuel-chip">Target {Math.round(plan.targetCarbsPerHourG)} g/h</li>
            {plan.gelIntervalMin > 0 && <li className="fuel-chip">A gel every {Math.round(plan.gelIntervalMin)} min</li>}
            <li className="fuel-chip">{plan.totalCarbsG} g during the race</li>
            {plan.needsMultipleTransportable && (
              <li className="fuel-chip fuel-chip--warn">Needs glucose + fructose</li>
            )}
          </ul>
          <div className="fuel-table-wrap">
            <table className="fuel-table">
              <caption>When to take each gel</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Distance</th>
                  <th scope="col">Item</th>
                  <th scope="col">Carbs</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => (
                  <tr key={`${item.kind}-${item.timeSec}`}>
                    <td>{item.kind === 'pre-race' ? `${Math.round(-item.timeSec / 60)} min before start` : formatRaceClock(item.timeSec)}</td>
                    <td>{item.kind === 'pre-race' ? 'Start' : formatDistanceMi(item.distanceMi, unit)}</td>
                    <td>
                      {item.label}
                      {item.note && <span className="fuel-note"> — {item.note}</span>}
                    </td>
                    <td>{item.carbsG} g</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.notes.length > 0 && (
            <ul className="fuel-notes">
              {plan.notes.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

/** Carb tolerance (g/h) editor; saves to the athlete profile on submit. */
function CarbToleranceForm({ current }: { current: number }) {
  const inputId = useId();
  const helpId = useId();
  const [value, setValue] = useState(String(current));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setValue(String(current)); }, [current]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (!value.trim() || !Number.isFinite(n) || n < CARB_TOLERANCE_MIN || n > CARB_TOLERANCE_MAX) {
      setError(`Enter a value between ${CARB_TOLERANCE_MIN} and ${CARB_TOLERANCE_MAX} g per hour.`);
      setSaved(false);
      return;
    }
    setError(null);
    updateAthleteProfile({ carbToleranceGPerHour: Math.round(n) });
    setSaved(true);
  };

  return (
    <form className="fuel-inline-form" onSubmit={onSubmit} noValidate>
      <label htmlFor={inputId}>Carbs you can handle (g per hour)</label>
      <div className="fuel-inline-row">
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={CARB_TOLERANCE_MIN}
          max={CARB_TOLERANCE_MAX}
          step={5}
          value={value}
          aria-describedby={helpId}
          aria-invalid={error ? true : undefined}
          onChange={(e) => { setValue(e.target.value); setSaved(false); }}
        />
        <button type="submit" className="fuel-button">Save</button>
      </div>
      <p id={helpId} className="fuel-help">
        Most runners handle 30–60 g per hour. Up to 90 g works with glucose + fructose products and a trained gut.
      </p>
      {error && <p className="fuel-error" role="alert">{error}</p>}
      {saved && <p className="fuel-saved" role="status">Saved.</p>}
    </form>
  );
}

// ── 2. Carb-load planner ─────────────────────────────────────────────────────

function CarbLoadSection({ ctx, profile }: Omit<SectionProps, 'unit'>) {
  const headingId = useId();
  const selectId = useId();
  const [carbsPerKg, setCarbsPerKg] = useState(DEFAULT_CARB_LOAD_G_PER_KG);
  const [includeDay3, setIncludeDay3] = useState(false);
  const { weightKg } = profile;
  const sex = profile.sex === 'female' || profile.sex === 'male' ? profile.sex : undefined;

  const protocol = useMemo(
    () => (weightKg
      ? generateCarbLoadingProtocol({ weightKg, sex }, ctx.raceDate ?? '', { carbsPerKg, includeDay3 })
      : null),
    [weightKg, sex, ctx.raceDate, carbsPerKg, includeDay3],
  );
  const breakfastAt = breakfastTime(ctx.startTime);

  return (
    <section className="fuel-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Carb loading</h3>
      {!protocol ? (
        <BodyMassForm />
      ) : (
        <>
          <div className="fuel-controls">
            <label htmlFor={selectId}>Loading target</label>
            <select id={selectId} value={carbsPerKg} onChange={(e) => setCarbsPerKg(Number(e.target.value))}>
              {CARB_LOAD_G_PER_KG_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v} g/kg per day{v === DEFAULT_CARB_LOAD_G_PER_KG ? ' (recommended)' : ''}
                </option>
              ))}
            </select>
            <label className="fuel-check">
              <input type="checkbox" checked={includeDay3} onChange={(e) => setIncludeDay3(e.target.checked)} />
              Include an optional lead-in day (3 days before)
            </label>
          </div>
          <div className="fuel-day-grid">
            {protocol.days.map((day) => <CarbDayCard key={day.daysBefore} day={day} raceDate={ctx.raceDate} />)}
            <RaceMorningCard day={protocol.raceMorning} breakfastAt={breakfastAt} />
          </div>
          <p className="fuel-info">
            Expect the scale to go up by about {formatMassKg(1).split(' ')[0]}–{formatMassKg(2)}: glycogen is stored
            with water.
            That&apos;s fuel, not fat.
          </p>
          {protocol.massCapped && (
            <p className="fuel-help">
              Targets are capped at the {formatMassKg(CARB_LOAD_MASS_CAP_KG)} level — glycogen storage tracks muscle
              mass rather than body weight.
            </p>
          )}
          {protocol.notes?.map((note) => <p key={note} className="fuel-help">{note}</p>)}
        </>
      )}
    </section>
  );
}

function CarbDayCard({ day, raceDate }: { day: CarbLoadingDay; raceDate: string | null }) {
  const dateKey = raceDate && isDateKey(raceDate) ? addDays(raceDate, -day.daysBefore) : null;
  return (
    <article className="fuel-day-card">
      <h4>
        {day.daysBefore} day{day.daysBefore === 1 ? '' : 's'} before{day.optional ? ' (optional)' : ''}
      </h4>
      {dateKey && <p className="fuel-day-date">{formatDayDate(dateKey)}</p>}
      <p className="fuel-day-target">
        <strong>{day.targetCarbsG} g</strong> carbs · {day.carbsPerKg} g/kg
      </p>
      <ul className="fuel-meals">
        {day.meals.map((meal) => (
          <li key={meal.name}>
            <span className="fuel-meal-name">{meal.name}</span> ({meal.carbsG} g): {meal.description}
          </li>
        ))}
      </ul>
      <p className="fuel-help">{day.fiberGuidance}</p>
    </article>
  );
}

function RaceMorningCard({ day, breakfastAt }: { day: CarbLoadingDay; breakfastAt: string | null }) {
  return (
    <article className="fuel-day-card fuel-day-card--race">
      <h4>Race morning</h4>
      <p className="fuel-day-target">
        <strong>{day.targetCarbsG} g</strong> carbs · about 3 hours before the start
        {breakfastAt ? ` (around ${breakfastAt})` : ''}
      </p>
      {day.meals.map((meal) => <p key={meal.name}>{meal.description}</p>)}
      {day.warning && <p className="fuel-warning">{day.warning}</p>}
      <p className="fuel-help">{day.fiberGuidance}</p>
    </article>
  );
}

/** Inline body-mass prompt — carb loading never assumes a default weight. */
function BodyMassForm() {
  const inputId = useId();
  const massUnit = getMassUnit();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    const kg = massUnit === 'lb' ? lbToKg(n) : n;
    if (!value.trim() || !Number.isFinite(kg) || kg < MASS_LIMITS_KG.min || kg > MASS_LIMITS_KG.max) {
      setError(`Enter your body mass in ${massUnit}.`);
      return;
    }
    setError(null);
    updateAthleteProfile({ weightKg: kg });
  };

  return (
    <form className="fuel-inline-form" onSubmit={onSubmit} noValidate>
      <p className="fuel-help">Carb-loading targets are set per kilogram of body mass, so add yours to see them.</p>
      <label htmlFor={inputId}>Body mass ({massUnit})</label>
      <div className="fuel-inline-row">
        <input
          id={inputId}
          type="number"
          inputMode="decimal"
          min={1}
          value={value}
          aria-invalid={error ? true : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="fuel-button">Save</button>
      </div>
      {error && <p className="fuel-error" role="alert">{error}</p>}
    </form>
  );
}

// ── 3. Safe hydration guidance ───────────────────────────────────────────────

function HydrationSection({ ctx, profile, unit }: SectionProps) {
  const headingId = useId();
  const ceiling = fluidCeilingMlPerHour(profile.sweatRateLPerHour);
  const temps = ctx.race?.typicalTempF;
  const sweatTip = getMassUnit() === 'lb'
    ? 'each pound lost is about 16 oz (450 mL) of sweat'
    : 'each kilogram lost is about 1 litre of sweat';

  return (
    <section className="fuel-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Hydration</h3>
      <p className="fuel-lead">
        <strong>Drink to thirst.</strong> Most runners do well with roughly {formatFluidMl(400, unit)} to{' '}
        {formatFluidMl(MAX_PLANNED_FLUID_ML_PER_HOUR, unit)} per hour — less when it&apos;s cool, or if you&apos;re
        smaller or slower.
      </p>
      {ceiling !== null ? (
        <p>
          Your upper limit: <strong>{formatFluidMl(ceiling, unit)} per hour</strong> (80% of your measured sweat rate,
          never more than {formatFluidMl(MAX_PLANNED_FLUID_ML_PER_HOUR, unit)}). It&apos;s a limit, not a target.
        </p>
      ) : (
        <p className="fuel-help">
          Know your sweat rate: weigh yourself before and after a 60-minute run and add what you drank — {sweatTip}.
          Add it to your athlete profile to get a personal upper limit.
        </p>
      )}
      {temps && (
        <p>
          Typical race-day temperature: {formatTemperatureF(temps.low)}–{formatTemperatureF(temps.high)}. Heat raises
          sweat and sodium losses, and lowers how many carbs your gut can handle.
        </p>
      )}
      <p>
        Sodium: about 300–600 mg per hour helps in long or hot races, or if you&apos;re a salty sweater (white streaks
        on your kit).
      </p>
      <aside className="fuel-caution" aria-label="Over-drinking warning">
        <p>
          <strong>Don&apos;t over-drink.</strong> You shouldn&apos;t gain weight during a race. Drinking far more than you
          sweat can cause exercise-associated hyponatremia (low blood sodium). Warning signs: headache, nausea,
          bloating, confusion, swollen hands or feet. If you notice them, stop drinking water and get medical help.
        </p>
      </aside>
    </section>
  );
}
