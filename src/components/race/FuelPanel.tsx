/**
 * Fuel tab of the Race Day hub (v1.0.6): race fueling timeline, carb-load
 * planner and safe hydration guidance.
 *
 * Everything is computed from the shared RaceDayContext and the athlete
 * profile. The only writes are explicit Save buttons (carb tolerance, body
 * mass) through `updateAthleteProfile` — nothing is persisted while rendering.
 *
 * v1.0.7: caffeine card driven by the Settings caffeine choice (R-1), a
 * sweat-rate test and salty-sweater flag feeding the fluid ceiling (R-2), the
 * shared race-breakfast rule (R-4), the delivered g/h chip (R-5) and the shared
 * carb range (R-7).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { RaceDayContext, RacePanelProps } from './types';
import type { CarbLoadingDay } from '../../types/nutrition';
import { EmptyState } from '../ui';
import {
  planRaceFueling,
  planCaffeine,
  estimateSweatRate,
  sodiumGuidanceMgPerHour,
  fluidCeilingMlPerHour,
  MAX_PLANNED_FLUID_ML_PER_HOUR,
  CARB_TOLERANCE_MIN_G_PER_HOUR,
  CARB_TOLERANCE_MAX_G_PER_HOUR,
} from '../../services/fuelingCalculator';
import {
  generateCarbLoadingProtocol,
  CARB_LOAD_G_PER_KG_OPTIONS,
  CARB_LOAD_MASS_CAP_KG,
  DEFAULT_CARB_LOAD_G_PER_KG,
  DEFAULT_RACE_BREAKFAST_SIZE,
  RACE_BREAKFAST_RULE_TEXT,
} from '../../services/carbLoading';
import type { RaceBreakfastSize } from '../../services/carbLoading';
import { getMyRace, onMyRaceChanged } from '../../services/myRace';
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
// v1.0.7 (R-7): the shared carb range (was a local 30–90).
const CARB_TOLERANCE_MIN = CARB_TOLERANCE_MIN_G_PER_HOUR;
const CARB_TOLERANCE_MAX = CARB_TOLERANCE_MAX_G_PER_HOUR;
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

/** v1.0.7 (R-4): the race-morning breakfast size (My Race), so both tabs agree. */
function useBreakfastSize(): RaceBreakfastSize {
  const read = () => getMyRace().mealSize ?? DEFAULT_RACE_BREAKFAST_SIZE;
  const [size, setSize] = useState<RaceBreakfastSize>(read);
  useEffect(() => onMyRaceChanged(() => setSize(read())), []);
  return size;
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
      <CaffeineSection ctx={ctx} profile={profile} unit={unit} />
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
            {plan.gelIntervalMin > 0 && (
              <li className="fuel-chip">A gel every {Math.round(plan.gelIntervalMin)} min</li>
            )}
            <li className="fuel-chip">{plan.totalCarbsG} g during the race</li>
            {/* v1.0.7 (R-5): what the plan really delivers over the whole race. */}
            {plan.totalCarbsG > 0 && (
              <li className="fuel-chip">≈ {Math.round(plan.deliveredCarbsPerHourG)} g/h delivered</li>
            )}
            {plan.needsMultipleTransportable && <li className="fuel-chip fuel-chip--warn">Needs glucose + fructose</li>}
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
                    <td>
                      {item.kind === 'pre-race'
                        ? `${Math.round(-item.timeSec / 60)} min before start`
                        : formatRaceClock(item.timeSec)}
                    </td>
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
              {plan.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
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

  useEffect(() => {
    setValue(String(current));
  }, [current]);

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
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
        />
        <button type="submit" className="fuel-button">
          Save
        </button>
      </div>
      <p id={helpId} className="fuel-help">
        Most runners handle 30–60 g per hour. Up to {CARB_TOLERANCE_MAX} g works with glucose + fructose products and a
        trained gut.
      </p>
      {error && (
        <p className="fuel-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="fuel-saved" role="status">
          Saved.
        </p>
      )}
    </form>
  );
}

// ── 1b. Caffeine (v1.0.7, R-1) ───────────────────────────────────────────────

/**
 * Optional caffeine card. Honours the Settings choice: the full plan shows only
 * when the athlete said they use caffeine in races; otherwise a one-line note.
 */
function CaffeineSection({ ctx, profile }: SectionProps) {
  const headingId = useId();
  const finishSec = ctx.strategy?.targetTimeSec ?? ctx.goalTimeSec ?? null;
  const plan = useMemo(
    () => planCaffeine({ enabled: profile.caffeine, weightKg: profile.weightKg, startTime: ctx.startTime, finishSec }),
    [profile.caffeine, profile.weightKg, ctx.startTime, finishSec],
  );

  return (
    <section className="fuel-section" aria-labelledby={headingId}>
      <h3 id={headingId}>Caffeine (optional)</h3>
      {!plan.enabled ? (
        <p className="fuel-help">
          Off. If you already use caffeine in training, tick &ldquo;I use caffeine during races&rdquo; in Settings ›
          Athlete profile to see a dose and timing here.
        </p>
      ) : (
        <>
          {plan.preRace ? (
            <ul className="fuel-notes" aria-label="Caffeine options">
              <li>
                <strong>Before the start:</strong> about {plan.preRace.mg} mg ({plan.preRace.mgPerKg} mg/kg) roughly{' '}
                {plan.preRace.minutesBefore} minutes before the gun
                {plan.preRace.clockTime ? ` (around ${plan.preRace.clockTime})` : ''} — coffee, a tablet or a
                caffeinated gel.
              </li>
              {plan.lateRace && (
                <li>
                  <strong>Or late in the race:</strong> {plan.lateRace.minMg}–{plan.lateRace.maxMg} mg (1–3 mg/kg)
                  {plan.lateRace.fromSec !== null
                    ? ` from about ${formatRaceClock(plan.lateRace.fromSec)} into the race`
                    : ' in the final hour'}
                  , e.g. a caffeinated gel in place of a regular one. If you also took some before the start, keep this
                  to the low end.
                </li>
              )}
            </ul>
          ) : (
            <p className="fuel-help">Add your body mass (Carb loading, below) to get a caffeine dose in milligrams.</p>
          )}
          <aside className="fuel-caution" aria-label="Caffeine cautions">
            <ul className="fuel-notes">
              {plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </aside>
        </>
      )}
    </section>
  );
}

// ── 2. Carb-load planner ─────────────────────────────────────────────────────

function CarbLoadSection({ ctx, profile }: Omit<SectionProps, 'unit'>) {
  const headingId = useId();
  const selectId = useId();
  const [carbsPerKg, setCarbsPerKg] = useState(DEFAULT_CARB_LOAD_G_PER_KG);
  const [includeDay3, setIncludeDay3] = useState(false);
  const breakfastSize = useBreakfastSize();
  const { weightKg } = profile;
  const sex = profile.sex === 'female' || profile.sex === 'male' ? profile.sex : undefined;

  const protocol = useMemo(
    () =>
      weightKg
        ? generateCarbLoadingProtocol({ weightKg, sex }, ctx.raceDate ?? '', { carbsPerKg, includeDay3, breakfastSize })
        : null,
    [weightKg, sex, ctx.raceDate, carbsPerKg, includeDay3, breakfastSize],
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
            {protocol.days.map((day) => (
              <CarbDayCard key={day.daysBefore} day={day} raceDate={ctx.raceDate} />
            ))}
            <RaceMorningCard day={protocol.raceMorning} breakfastAt={breakfastAt} />
          </div>
          <p className="fuel-info">
            Expect the scale to go up by about {formatMassKg(1).split(' ')[0]}–{formatMassKg(2)}: glycogen is stored
            with water. That&apos;s fuel, not fat.
          </p>
          {protocol.massCapped && (
            <p className="fuel-help">
              Targets are capped at the {formatMassKg(CARB_LOAD_MASS_CAP_KG)} level — glycogen storage tracks muscle
              mass rather than body weight.
            </p>
          )}
          {protocol.notes?.map((note) => (
            <p key={note} className="fuel-help">
              {note}
            </p>
          ))}
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
        <strong>{day.targetCarbsG} g</strong> carbs ({day.carbsPerKg} g/kg) · about 3 hours before the start
        {breakfastAt ? ` (around ${breakfastAt})` : ''}
      </p>
      {/* v1.0.7 (R-4): the same rule and breakfast size as the Race Morning tab. */}
      <p className="fuel-help">
        Rule of thumb: {RACE_BREAKFAST_RULE_TEXT}. Breakfast size is set on the Race Morning tab.
      </p>
      {day.meals.map((meal) => (
        <p key={meal.name}>{meal.description}</p>
      ))}
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
        <button type="submit" className="fuel-button">
          Save
        </button>
      </div>
      {error && (
        <p className="fuel-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// ── 3. Safe hydration guidance ───────────────────────────────────────────────

function HydrationSection({ ctx, profile, unit }: SectionProps) {
  const headingId = useId();
  const ceiling = fluidCeilingMlPerHour(profile.sweatRateLPerHour);
  const temps = ctx.race?.typicalTempF;
  const sodium = sodiumGuidanceMgPerHour(profile.saltySweater);
  const sweatTip =
    getMassUnit() === 'lb'
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
          Your upper limit: <strong>{formatFluidMl(ceiling, unit)} per hour</strong> (80% of your measured sweat rate of{' '}
          {profile.sweatRateLPerHour} L/h, never more than {formatFluidMl(MAX_PLANNED_FLUID_ML_PER_HOUR, unit)}).
          It&apos;s a limit, not a target.
        </p>
      ) : (
        <p className="fuel-help">
          Know your sweat rate: weigh yourself before and after a 60-minute run and add what you drank — {sweatTip}. Use
          the sweat test below to get a personal upper limit.
        </p>
      )}
      <SweatTestForm hasRate={ceiling !== null} />
      {temps && (
        <p>
          Typical race-day temperature: {formatTemperatureF(temps.low)}–{formatTemperatureF(temps.high)}. Heat raises
          sweat and sodium losses, and lowers how many carbs your gut can handle.
        </p>
      )}
      <p>
        Sodium: about {sodium.min}–{sodium.max} mg per hour helps in long or hot races
        {profile.saltySweater
          ? ' — you marked yourself as a salty sweater, so aim for the upper part of that. Needs vary a lot: test it on long runs.'
          : ", or more if you're a salty sweater (white streaks on your kit)."}
      </p>
      <SaltySweaterToggle checked={profile.saltySweater === true} />
      <aside className="fuel-caution" aria-label="Over-drinking warning">
        <p>
          <strong>Don&apos;t over-drink.</strong> You shouldn&apos;t gain weight during a race. Drinking far more than
          you sweat can cause exercise-associated hyponatremia (low blood sodium). Warning signs: headache, nausea,
          bloating, confusion, swollen hands or feet. If you notice them, stop drinking water and get medical help.
        </p>
      </aside>
    </section>
  );
}

// ── 3b. Sweat-rate test (v1.0.7, R-2) ─────────────────────────────────────────

/**
 * Sweat test: body mass before/after a run, fluid drunk and duration → L/h,
 * saved to the athlete profile on submit (feeds the personal fluid ceiling).
 */
function SweatTestForm({ hasRate }: { hasRate: boolean }) {
  const baseId = useId();
  const massUnit = getMassUnit();
  const fluidUnit = getDistanceUnit() === 'mi' ? 'oz' : 'mL';
  const [open, setOpen] = useState(!hasRate);
  const [pre, setPre] = useState('');
  const [post, setPost] = useState('');
  const [fluid, setFluid] = useState('');
  const [minutes, setMinutes] = useState('60');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ rate: number; warnings: string[] } | null>(null);

  const toKg = (v: string) => (massUnit === 'lb' ? lbToKg(Number(v)) : Number(v));
  const toL = (v: string) => (v.trim() === '' ? 0 : (fluidUnit === 'oz' ? Number(v) * ML_PER_OZ : Number(v)) / 1000);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!pre.trim() || !post.trim()) {
      setError(`Enter your body mass before and after the run (${massUnit}).`);
      setResult(null);
      return;
    }
    const r = estimateSweatRate({
      preKg: toKg(pre),
      postKg: toKg(post),
      fluidL: toL(fluid),
      durationMin: Number(minutes),
    });
    if (!r.ok) {
      setError(r.error);
      setResult(null);
      return;
    }
    setError(null);
    setResult({ rate: r.sweatRateLPerHour, warnings: r.warnings });
    updateAthleteProfile({ sweatRateLPerHour: r.sweatRateLPerHour });
  };

  if (!open) {
    return (
      <button type="button" className="fuel-button" onClick={() => setOpen(true)}>
        Redo the sweat test
      </button>
    );
  }

  return (
    <form className="fuel-inline-form" onSubmit={onSubmit} noValidate aria-label="Sweat-rate test">
      <p className="fuel-help">
        <strong>Sweat test.</strong> On a run of 45–90 minutes at race effort and similar weather: weigh yourself
        (minimal clothing, after the toilet) before, towel off and weigh again after, and note what you drank.
      </p>
      <div className="fuel-controls">
        <label htmlFor={`${baseId}-pre`}>Before ({massUnit})</label>
        <input
          id={`${baseId}-pre`}
          type="number"
          inputMode="decimal"
          min={1}
          step="0.1"
          value={pre}
          onChange={(e) => setPre(e.target.value)}
        />
        <label htmlFor={`${baseId}-post`}>After ({massUnit})</label>
        <input
          id={`${baseId}-post`}
          type="number"
          inputMode="decimal"
          min={1}
          step="0.1"
          value={post}
          onChange={(e) => setPost(e.target.value)}
        />
        <label htmlFor={`${baseId}-fluid`}>Drank during the run ({fluidUnit})</label>
        <input
          id={`${baseId}-fluid`}
          type="number"
          inputMode="decimal"
          min={0}
          value={fluid}
          onChange={(e) => setFluid(e.target.value)}
        />
        <label htmlFor={`${baseId}-min`}>Run duration (min)</label>
        <input
          id={`${baseId}-min`}
          type="number"
          inputMode="numeric"
          min={30}
          max={300}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </div>
      <button type="submit" className="fuel-button">
        Work out my sweat rate
      </button>
      {error && (
        <p className="fuel-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <p className="fuel-saved">
            Sweat rate: about <strong>{result.rate} L/h</strong> — saved to your profile.
          </p>
          {result.warnings.map((w) => (
            <p key={w} className="fuel-warning">
              {w}
            </p>
          ))}
        </div>
      )}
      <p className="fuel-help">
        This sets an upper limit only. On race day still drink to thirst, and don&apos;t finish heavier than you
        started.
      </p>
    </form>
  );
}

/** v1.0.7 (R-2): salty-sweater flag, saved immediately (an explicit user action). */
function SaltySweaterToggle({ checked }: { checked: boolean }) {
  return (
    <label className="fuel-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => updateAthleteProfile({ saltySweater: e.target.checked })}
      />
      I&apos;m a salty sweater (white salt marks on my kit or face after long runs)
    </label>
  );
}
