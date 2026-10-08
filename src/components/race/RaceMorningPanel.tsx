/**
 * Race Morning panel (Race Day hub, v1.0.6).
 *
 * A setup form (wave start time, travel, arrival lead, breakfast size,
 * warm-up) and a vertical alarm → finish → recovery timeline grouped into
 * Pre-race / Race / Post-race, in race-local time with the zone label.
 *
 * - Fuel rows come from `planRaceFueling` (time-based, using the pacing plan
 *   for distances); if it yields nothing, from the strategy's timed
 *   `nutritionPlan` items.
 * - Editing the form only changes local state. "Save setup" writes My Race.
 *   Nothing is persisted as a side effect of rendering.
 */
import { useId, useMemo, useState } from 'react';
import { EmptyState } from '../ui';
import type { RaceDayContext, RacePanelProps } from './types';
import type { MarathonRace } from '../../types/raceStrategy';
import {
  defaultArrivalLeadMin,
  generateRaceDayTimeline,
  parseClockTime,
  type RaceDayTimeline,
  type TimelineCategory,
  type TimelineEvent,
  type TimelineFuelItem,
  type TimelinePhase,
} from '../../services/raceDayTimeline';
import { getMyRace, isHHmm, setMyRace, type MealSize } from '../../services/myRace';
import { formatMassKg, getAthleteProfile, getCarbToleranceGPerHour } from '../../services/athleteProfile';
import { getDistanceUnit } from '../../services/unitPreferences';
import { distanceAtTime, getStrategyDistanceMi } from '../../services/raceStrategy';
import { planRaceFueling } from '../../services/fuelingCalculator';
import './RaceMorning.css';

// ── Types & constants ─────────────────────────────────────────────────────────

interface SetupState {
  /** 24 h 'HH:mm' or '' (unknown). */
  startTime: string;
  wave: string;
  travelMinutes: string;
  /** '' = use the field-size default. */
  arrivalLeadMin: string;
  mealSize: MealSize;
  warmup: boolean;
}

interface Environment {
  unit: 'mi' | 'km';
  weightKg?: number;
  weightText: string | null;
  carbsPerHourG: number;
}

interface FuelSource {
  items: TimelineFuelItem[] | undefined;
  summary: string | null;
}

interface TimelineResult {
  timeline: RaceDayTimeline | null;
  error: string | null;
}

const DEFAULT_TRAVEL_MIN = 30;

const MEAL_OPTIONS: { value: MealSize; label: string }[] = [
  { value: 'light', label: 'Light (~1 g carbs per kg)' },
  { value: 'moderate', label: 'Moderate (~2 g carbs per kg)' },
  { value: 'full', label: 'Full (~3 g carbs per kg)' },
];

const PHASES: { id: TimelinePhase; title: string }[] = [
  { id: 'pre-race', title: 'Pre-race' },
  { id: 'race', title: 'Race' },
  { id: 'post-race', title: 'Post-race' },
];

const CATEGORY_META: Record<TimelineCategory, { icon: string; label: string }> = {
  wake: { icon: '⏰', label: 'Wake' },
  nutrition: { icon: '🍌', label: 'Nutrition' },
  logistics: { icon: '🚌', label: 'Logistics' },
  warmup: { icon: '🏃', label: 'Warm-up' },
  race: { icon: '🏁', label: 'Race' },
  fueling: { icon: '⚡', label: 'Fuel' },
  milestone: { icon: '📍', label: 'Milestone' },
};

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** 'HH:mm' from any accepted clock string ('07:30', '7:30 AM CT'), else ''. */
function toHHmm(value: string | null | undefined): string {
  if (!value) return '';
  if (isHHmm(value)) return value;
  const parsed = parseClockTime(value);
  return parsed ? clockToHHmm(parsed.minutes) : '';
}

function clockToHHmm(clockMinutes: number): string {
  const m = ((Math.round(clockMinutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Non-negative whole minutes from a form field, or undefined when blank/invalid. */
function parseWholeMinutes(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

function sameSetup(a: SetupState, b: SetupState): boolean {
  return (Object.keys(a) as (keyof SetupState)[]).every((k) => a[k] === b[k]);
}

/**
 * Short zone label ('CDT', 'GMT+9') for an IANA zone on the race date,
 * resolved at noon UTC that day so the DST state matches race morning.
 */
function zoneShortLabel(timeZone: string | null | undefined, dateKey: string | null | undefined): string | undefined {
  if (!timeZone || !dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return undefined;
  const [y, m, d] = dateKey.split('-').map(Number);
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date(Date.UTC(y, m - 1, d, 12)));
    return parts.find((p) => p.type === 'timeZoneName')?.value;
  } catch {
    return undefined;
  }
}

function initialSetup(ctx: RaceDayContext, race: MarathonRace): SetupState {
  const saved = getMyRace();
  return {
    startTime: toHHmm(ctx.startTime) || toHHmm(saved.startTime) || toHHmm(race.startTime),
    wave: ctx.wave ?? saved.wave ?? '',
    travelMinutes: String(saved.travelMinutes ?? DEFAULT_TRAVEL_MIN),
    arrivalLeadMin: saved.arrivalLeadMin !== undefined ? String(saved.arrivalLeadMin) : '',
    mealSize: saved.mealSize ?? 'moderate',
    warmup: saved.warmup ?? false,
  };
}

function readEnvironment(): Environment {
  const weightKg = getAthleteProfile().weightKg;
  return {
    unit: getDistanceUnit(),
    weightKg,
    weightText: weightKg ? formatMassKg(weightKg) : null,
    carbsPerHourG: getCarbToleranceGPerHour(),
  };
}

/** Time-based fuel items: `planRaceFueling`, else the strategy's timed nutrition items. */
function buildFuel(ctx: RaceDayContext, race: MarathonRace, carbsPerHourG: number): FuelSource {
  const strategy = ctx.strategy;
  const finishSec = strategy?.targetTimeSec ?? ctx.goalTimeSec ?? 0;
  if (!(finishSec > 0)) return { items: undefined, summary: null };
  const milePaces = strategy?.milePaces ?? [];
  const plan = planRaceFueling({
    finishSec,
    distanceMi: strategy ? getStrategyDistanceMi(strategy) : race.distanceMi,
    carbsPerHourG,
    distanceAtTimeSec: milePaces.length > 0 ? (t) => distanceAtTime(milePaces, t) : undefined,
    aidStations: race.aidStations,
  });
  if (plan.items.length > 0) {
    const gels = plan.items.filter((i) => i.kind === 'gel').length;
    return {
      items: plan.items.map(({ timeSec, distanceMi, label, carbsG, note }) => ({ timeSec, distanceMi, label, carbsG, note })),
      summary: gels > 0
        ? `${gels} gels, one every ${Math.round(plan.gelIntervalMin)} min (${Math.round(plan.targetCarbsPerHourG)} g carbs per hour)`
        : null,
    };
  }
  const timed = (strategy?.nutritionPlan ?? []).filter((n) => typeof n.timeSec === 'number' && Number.isFinite(n.timeSec));
  if (timed.length > 0) {
    return {
      items: timed.map((n) => ({ timeSec: n.timeSec as number, distanceMi: n.mile, label: n.item, carbsG: n.carbsG, note: n.notes || undefined })),
      summary: null,
    };
  }
  return { items: undefined, summary: null };
}

function computeTimeline(o: {
  setup: SetupState;
  ctx: RaceDayContext;
  race: MarathonRace;
  env: Environment;
  tzLabel: string | undefined;
  fuelItems: TimelineFuelItem[] | undefined;
}): TimelineResult {
  const { setup, ctx, race, env } = o;
  if (!setup.startTime) return { timeline: null, error: null };
  if (!parseClockTime(setup.startTime)) {
    return { timeline: null, error: 'Enter a valid start time, e.g. 07:30.' };
  }
  try {
    const timeline = generateRaceDayTimeline({
      raceStartTime: setup.startTime,
      travelMinutes: parseWholeMinutes(setup.travelMinutes) ?? 0,
      arrivalLeadMin: parseWholeMinutes(setup.arrivalLeadMin),
      mealPreference: setup.mealSize,
      includeWarmup: setup.warmup,
      weightKg: env.weightKg,
      projectedFinishSec: ctx.strategy?.targetTimeSec ?? ctx.goalTimeSec ?? 0,
      raceName: race.name,
      raceDate: ctx.raceDate ?? undefined,
      timeZoneLabel: o.tzLabel,
      wave: setup.wave.trim() || undefined,
      distanceMi: ctx.strategy ? getStrategyDistanceMi(ctx.strategy) : race.distanceMi,
      milePaces: ctx.strategy?.milePaces,
      fuelItems: o.fuelItems,
      fieldSize: race.fieldSize,
      unit: env.unit,
    });
    return { timeline, error: null };
  } catch (e) {
    return { timeline: null, error: e instanceof Error ? e.message : 'Could not build the timeline.' };
  }
}

/** Clipboard API first; falls back to a hidden textarea + execCommand('copy'). */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  try {
    const buffer = document.createElement('textarea');
    buffer.value = text;
    buffer.setAttribute('readonly', '');
    buffer.setAttribute('aria-hidden', 'true');
    buffer.className = 'rm-copy-buffer';
    document.body.appendChild(buffer);
    buffer.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    document.body.removeChild(buffer);
    return ok;
  } catch {
    return false;
  }
}

// ── Components ────────────────────────────────────────────────────────────────

/** Race Morning tab of the Race Day hub. */
export default function RaceMorningPanel({ ctx }: RacePanelProps) {
  const headingId = useId();
  if (!ctx.race) {
    return (
      <section className="rm-panel" aria-labelledby={headingId}>
        <h2 id={headingId} className="rm-heading">Race morning</h2>
        <EmptyState icon="⏰" title="Pick your race first">
          Choose your race in My Race to plan race morning: alarm, breakfast, travel, the start area and your race milestones.
        </EmptyState>
      </section>
    );
  }
  return <RaceMorningBody key={ctx.race.id} ctx={ctx} race={ctx.race} headingId={headingId} />;
}

function RaceMorningBody({ ctx, race, headingId }: { ctx: RaceDayContext; race: MarathonRace; headingId: string }) {
  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;
  const [setup, setSetup] = useState<SetupState>(() => initialSetup(ctx, race));
  const [savedSetup, setSavedSetup] = useState<SetupState>(setup);
  const [prevCtxStart, setPrevCtxStart] = useState(ctx.startTime);
  const [setupOpen, setSetupOpen] = useState(true);
  const [saveStatus, setSaveStatus] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [showManualCopy, setShowManualCopy] = useState(false);

  // Follow a start time changed elsewhere in the hub, unless the form has unsaved edits.
  if (ctx.startTime !== prevCtxStart) {
    setPrevCtxStart(ctx.startTime);
    const next = toHHmm(ctx.startTime);
    if (next && next !== setup.startTime && sameSetup(setup, savedSetup)) {
      setSetup({ ...setup, startTime: next });
      setSavedSetup({ ...savedSetup, startTime: next });
    }
  }

  const env = useMemo(readEnvironment, []);
  const tzLabel = useMemo(
    () => zoneShortLabel(ctx.timeZone ?? race.timeZone, ctx.raceDate ?? ctx.today),
    [ctx.timeZone, race.timeZone, ctx.raceDate, ctx.today],
  );
  const fuel = useMemo(() => buildFuel(ctx, race, env.carbsPerHourG), [ctx, race, env.carbsPerHourG]);
  const result = useMemo(
    () => computeTimeline({ setup, ctx, race, env, tzLabel, fuelItems: fuel.items }),
    [setup, ctx, race, env, tzLabel, fuel.items],
  );
  const defaultLead = defaultArrivalLeadMin(race.fieldSize);
  const dirty = !sameSetup(setup, savedSetup);

  const update = <K extends keyof SetupState>(key: K, value: SetupState[K]) => {
    setSetup((s) => ({ ...s, [key]: value }));
    setSaveStatus('');
  };

  const handleSave = () => {
    setMyRace({
      startTime: isHHmm(setup.startTime) ? setup.startTime : undefined,
      wave: setup.wave.trim() || undefined,
      travelMinutes: parseWholeMinutes(setup.travelMinutes) ?? 0,
      arrivalLeadMin: parseWholeMinutes(setup.arrivalLeadMin),
      mealSize: setup.mealSize,
      warmup: setup.warmup,
    });
    setSavedSetup(setup);
    setSaveStatus('Race-morning setup saved.');
  };

  const handleCopy = async () => {
    if (!result.timeline) return;
    const ok = await copyToClipboard(result.timeline.textExport);
    setCopyStatus(ok ? 'Timeline copied to the clipboard.' : "Couldn't copy automatically — select the text below and copy it.");
    setShowManualCopy(!ok);
  };

  const leadHint = `Leave blank for the default: ${defaultLead} min${
    typeof race.fieldSize === 'number' ? ` for a field of about ${race.fieldSize.toLocaleString('en-US')}` : ''
  }.`;

  return (
    <section className="rm-panel" aria-labelledby={headingId}>
      <div className="rm-header">
        <h2 id={headingId} className="rm-heading">Race morning</h2>
        <p className="rm-subtitle">
          {race.name}
          {ctx.raceDate ? ` · ${ctx.raceDate}` : ''}
          {tzLabel ? ` · times in ${tzLabel}` : ''}
        </p>
      </div>

      <div className="rm-card">
        <h3 className="rm-section-title">
          <button
            type="button"
            className="rm-disclosure"
            aria-expanded={setupOpen}
            aria-controls={fieldId('setup')}
            onClick={() => setSetupOpen((open) => !open)}
          >
            <span className="rm-chevron" aria-hidden="true">{setupOpen ? '▾' : '▸'}</span>
            Race-morning setup
          </button>
        </h3>
        <form
          id={fieldId('setup')}
          className="rm-form"
          hidden={!setupOpen}
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div className="rm-field">
            <label htmlFor={fieldId('start')}>Start time (race-local{tzLabel ? `, ${tzLabel}` : ''})</label>
            <input
              id={fieldId('start')}
              type="time"
              value={setup.startTime}
              onChange={(e) => update('startTime', e.target.value)}
            />
          </div>
          <div className="rm-field">
            <label htmlFor={fieldId('wave')}>Wave / corral</label>
            <input
              id={fieldId('wave')}
              type="text"
              maxLength={60}
              placeholder="e.g. Wave 2, Corral D"
              value={setup.wave}
              onChange={(e) => update('wave', e.target.value)}
            />
          </div>
          <div className="rm-field">
            <label htmlFor={fieldId('travel')}>Travel to the start (min)</label>
            <input
              id={fieldId('travel')}
              type="number"
              inputMode="numeric"
              min={0}
              max={600}
              step={5}
              value={setup.travelMinutes}
              onChange={(e) => update('travelMinutes', e.target.value)}
            />
          </div>
          <div className="rm-field">
            <label htmlFor={fieldId('lead')}>At the start area (min before the gun)</label>
            <input
              id={fieldId('lead')}
              type="number"
              inputMode="numeric"
              min={15}
              max={300}
              step={5}
              placeholder={String(defaultLead)}
              aria-describedby={fieldId('lead-hint')}
              value={setup.arrivalLeadMin}
              onChange={(e) => update('arrivalLeadMin', e.target.value)}
            />
            <p id={fieldId('lead-hint')} className="rm-hint">{leadHint}</p>
          </div>
          <div className="rm-field">
            <label htmlFor={fieldId('meal')}>Breakfast size</label>
            <select
              id={fieldId('meal')}
              value={setup.mealSize}
              onChange={(e) => update('mealSize', e.target.value as MealSize)}
            >
              {MEAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <p className="rm-hint">
              {env.weightText
                ? `Grams and fluid amounts use your profile weight (${env.weightText}).`
                : 'Add your weight in your profile to see grams of carbs and mL of fluid.'}
            </p>
          </div>
          <div className="rm-field rm-field--check">
            <input
              id={fieldId('warmup')}
              type="checkbox"
              checked={setup.warmup}
              onChange={(e) => update('warmup', e.target.checked)}
            />
            <label htmlFor={fieldId('warmup')}>Include a short warm-up (ends ~10 min before the gun)</label>
          </div>
          <div className="rm-actions">
            <button type="submit" className="btn btn-primary rm-button">Save setup</button>
            <p className="rm-status" role="status">{saveStatus || (dirty ? 'Unsaved changes' : '')}</p>
          </div>
        </form>
      </div>

      {result.error && <p className="rm-error" role="alert">{result.error}</p>}

      {!result.timeline && !result.error && (
        <EmptyState icon="🕖" title="Add your start time">
          Enter your wave's start time above to build your race-morning timeline.
        </EmptyState>
      )}

      {result.timeline && (
        <TimelineCard
          timeline={result.timeline}
          fuelSummary={fuel.summary}
          copyStatus={copyStatus}
          showManualCopy={showManualCopy}
          onCopy={() => {
            void handleCopy();
          }}
        />
      )}
    </section>
  );
}

function TimelineCard({
  timeline,
  fuelSummary,
  copyStatus,
  showManualCopy,
  onCopy,
}: {
  timeline: RaceDayTimeline;
  fuelSummary: string | null;
  copyStatus: string;
  showManualCopy: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rm-card">
      <div className="rm-timeline-head">
        <h3 className="rm-section-title">Timeline</h3>
        <p className="rm-tz">
          {timeline.timeZoneLabel ? `Times are race-local (${timeline.timeZoneLabel})` : 'Times are race-local'}
        </p>
      </div>
      {fuelSummary && <p className="rm-note">Fuel: {fuelSummary}. Products and details are on the Fuel tab.</p>}
      {timeline.warnings.length > 0 && (
        <ul className="rm-warnings">
          {timeline.warnings.map((w) => (
            <li key={w}>
              <span aria-hidden="true">⚠️ </span>
              <strong>Heads-up:</strong> {w}
            </li>
          ))}
        </ul>
      )}
      {PHASES.map((phase) => {
        const events = timeline.events.filter((e) => e.phase === phase.id);
        if (events.length === 0) return null;
        return (
          <div key={phase.id} className="rm-group">
            <h4 className="rm-group-title">{phase.title}</h4>
            <ol className="rm-list">
              {events.map((e, i) => (
                <TimelineRow key={`${e.offsetSec}-${i}`} event={e} />
              ))}
            </ol>
          </div>
        );
      })}
      <div className="rm-actions">
        <button type="button" className="btn btn-secondary rm-button" onClick={onCopy}>Copy as text</button>
        <p className="rm-status" role="status">{copyStatus}</p>
      </div>
      {showManualCopy && (
        <textarea className="rm-manual-copy" readOnly rows={10} aria-label="Timeline as text" value={timeline.textExport} />
      )}
    </div>
  );
}

function TimelineRow({ event }: { event: TimelineEvent }) {
  const meta = CATEGORY_META[event.category];
  return (
    <li className={`rm-event rm-event--${event.category}`}>
      <time className="rm-time" dateTime={clockToHHmm(event.clockMinutes)}>{event.time}</time>
      <div className="rm-event-body">
        <p className="rm-event-title">
          <span className="rm-icon" aria-hidden="true">{meta.icon}</span>
          <span>{event.title}</span>
          <span className="rm-tag">{meta.label}</span>
        </p>
        <p className="rm-event-desc">{event.description}</p>
      </div>
    </li>
  );
}
