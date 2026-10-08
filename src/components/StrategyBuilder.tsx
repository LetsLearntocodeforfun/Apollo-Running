import { useMemo, useState } from 'react';
import ElevationChart, { type ElevationHighlight } from './ElevationChart';
import {
  buildRaceStrategy,
  buildUnitSplits,
  courseElevationFtAt,
  DEFAULT_SPLIT_MAGNITUDE_PCT,
  formatDurationSec,
  formatPaceForUnit,
  getRaceDistanceMi,
  getStrategyDistanceMi,
  plannedSplitPct,
  saveStrategy,
  validateGoalTime,
} from '../services/raceStrategy';
import { getDistanceUnit, paceUnitLabel, type DistanceUnit } from '../services/unitPreferences';
import type { MarathonRace, RaceStrategy, PacingStrategy } from '../types/raceStrategy';
import './race/Strategy.css';

const M_PER_FT = 0.3048;

/** Pacing styles offered in the builder. */
export const PACING_STRATEGIES: { value: PacingStrategy; label: string; description: string }[] = [
  { value: 'negative-split', label: 'Negative split', description: 'Start controlled and finish a little faster. A good default for experienced runners.' },
  { value: 'even-split', label: 'Even split', description: 'Equal halves. Pace changes only for hills.' },
  { value: 'effort-based', label: 'Effort-based', description: 'Even effort, not even pace: slower on climbs, with a little late-race fatigue built in.' },
  { value: 'positive-split', label: 'Positive split', description: 'A slightly faster first half. Common for first-timers, rarely best for a PR.' },
];

/** Human label for a pacing style. */
export function pacingLabel(p: PacingStrategy): string {
  return PACING_STRATEGIES.find((s) => s.value === p)?.label ?? p;
}

export interface StrategyBuilderProps {
  marathon: MarathonRace;
  /** Saved strategies for this race. */
  existingStrategies: RaceStrategy[];
  /** Id of the race-day (active) strategy, if any. */
  activeStrategyId?: string | null;
  /** Initial goal (s) for a new strategy. */
  defaultGoalSec: number;
  /** Saved strategy to show first (e.g. from "View" in My strategies). */
  initialStrategyId?: string | null;
  /** Called after the user saved a strategy. */
  onSaved: (strategy: RaceStrategy) => void;
  /** Make a saved strategy the race-day strategy. */
  onSetActive?: (strategyId: string) => void;
}

function clampInt(raw: string, lo: number, hi: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function splitHms(sec: number): [number, number, number] {
  const t = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  return [Math.min(12, Math.floor(t / 3600)), Math.floor((t % 3600) / 60), t % 60];
}

/** Elevation change between two distances, as "+12 m" / "−40 ft" / "0 ft". */
function formatElevChange(ft: number, unit: DistanceUnit): string {
  const v = Math.round(unit === 'km' ? ft * M_PER_FT : ft);
  const suffix = unit === 'km' ? 'm' : 'ft';
  if (v === 0) return `0 ${suffix}`;
  return `${v > 0 ? '+' : '−'}${Math.abs(v)} ${suffix}`;
}

/**
 * Build, preview and save a race strategy (RS-4/5/10/11/12/13). Building is
 * a pure preview; only the "Save strategy" button persists.
 */
export default function StrategyBuilder({
  marathon,
  existingStrategies,
  activeStrategyId,
  defaultGoalSec,
  initialStrategyId,
  onSaved,
  onSetActive,
}: StrategyBuilderProps) {
  const [h0, m0, s0] = splitHms(defaultGoalSec);
  const [hours, setHours] = useState(h0);
  const [minutes, setMinutes] = useState(m0);
  const [seconds, setSeconds] = useState(s0);
  const [pacing, setPacing] = useState<PacingStrategy>('negative-split');
  const [magnitude, setMagnitude] = useState(DEFAULT_SPLIT_MAGNITUDE_PCT);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<RaceStrategy | null>(null);
  const [previewSig, setPreviewSig] = useState('');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [buildError, setBuildError] = useState('');
  const [viewingId, setViewingId] = useState<string | null>(initialStrategyId ?? null);
  const [highlight, setHighlight] = useState<ElevationHighlight | undefined>(undefined);

  const unit = getDistanceUnit();
  const paceLabel = paceUnitLabel(unit);
  const distanceMi = getRaceDistanceMi(marathon);
  const goalSec = hours * 3600 + minutes * 60 + seconds;
  const goalError = validateGoalTime(distanceMi, goalSec);
  const splitPct = plannedSplitPct(pacing, magnitude);
  const sig = `${goalSec}|${pacing}|${magnitude}|${name.trim()}`;
  const stale = preview !== null && sig !== previewSig;
  const ids = useMemo(() => `sb-${marathon.id.replace(/[^a-zA-Z0-9_-]/g, '')}`, [marathon.id]);

  const viewing = viewingId ? existingStrategies.find((s) => s.id === viewingId) ?? null : null;
  const display = viewing ?? preview;

  const handlePreview = () => {
    if (goalError) return;
    const built = buildRaceStrategy(marathon.id, goalSec, pacing, name, { splitMagnitudePct: magnitude });
    if (!built) {
      setBuildError('Could not build a plan for this race and goal.');
      return;
    }
    setBuildError('');
    setPreview(built);
    setPreviewSig(sig);
    setSavedId(null);
    setViewingId(null);
    setStatus('');
  };

  const handleSave = () => {
    if (!preview || stale) return;
    saveStrategy(preview);
    setSavedId(preview.id);
    setStatus('Strategy saved.');
    onSaved(preview);
  };

  const handleSetActive = (id: string) => {
    onSetActive?.(id);
    setStatus('This is now your race-day strategy.');
  };

  const halvesPreview = splitPct !== null && goalSec > 0 && !goalError
    ? (() => {
        const first = goalSec / (2 + splitPct / 100);
        return `First half ${formatDurationSec(first)}, second half ${formatDurationSec(Math.round(goalSec) - Math.round(first))}.`;
      })()
    : null;

  return (
    <div className="rs-builder">
      <div className="rs-race-head">
        <h3 className="rs-race-name">{marathon.name}</h3>
        <p className="rs-muted">
          {[marathon.city, marathon.country].filter(Boolean).join(', ')}
          {marathon.date ? ` · ${marathon.date}` : ''}
          {marathon.dateEstimated ? ' (date to be confirmed)' : ''}
          {` · ${(unit === 'km' ? distanceMi * 1.609344 : distanceMi).toFixed(1)} ${unit}`}
        </p>
      </div>

      {existingStrategies.length > 0 && (
        <section className="card rs-section" aria-labelledby={`${ids}-saved`}>
          <h4 id={`${ids}-saved`} className="rs-eyebrow">Your saved strategies for this race</h4>
          <div className="rs-chip-row">
            {existingStrategies.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`btn ${viewingId === s.id ? 'btn-primary' : 'btn-secondary'} rs-btn`}
                aria-pressed={viewingId === s.id}
                onClick={() => { setViewingId(viewingId === s.id ? null : s.id); setStatus(''); }}
              >
                {formatDurationSec(s.targetTimeSec)} · {pacingLabel(s.pacingStrategy)}
                {activeStrategyId === s.id ? ' · race day' : ''}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="card rs-section rs-form" aria-labelledby={`${ids}-build`}>
        <h4 id={`${ids}-build`} className="rs-eyebrow rs-eyebrow-gold">Build a strategy</h4>
        <div className="rs-grid">
          <fieldset className="rs-fieldset">
            <legend className="rs-label">Goal finish time</legend>
            <div className="rs-hms">
              <label>
                <span className="sr-only">Hours</span>
                <input
                  type="number" inputMode="numeric" min={0} max={12} value={hours}
                  aria-describedby={goalError ? `${ids}-goal-error` : `${ids}-goal-help`}
                  aria-invalid={goalError ? true : undefined}
                  onChange={(e) => setHours(clampInt(e.target.value, 0, 12))}
                />
                <span aria-hidden="true">h</span>
              </label>
              <label>
                <span className="sr-only">Minutes</span>
                <input
                  type="number" inputMode="numeric" min={0} max={59} value={minutes}
                  aria-describedby={goalError ? `${ids}-goal-error` : `${ids}-goal-help`}
                  aria-invalid={goalError ? true : undefined}
                  onChange={(e) => setMinutes(clampInt(e.target.value, 0, 59))}
                />
                <span aria-hidden="true">m</span>
              </label>
              <label>
                <span className="sr-only">Seconds</span>
                <input
                  type="number" inputMode="numeric" min={0} max={59} value={seconds}
                  aria-describedby={goalError ? `${ids}-goal-error` : `${ids}-goal-help`}
                  aria-invalid={goalError ? true : undefined}
                  onChange={(e) => setSeconds(clampInt(e.target.value, 0, 59))}
                />
                <span aria-hidden="true">s</span>
              </label>
            </div>
            {goalError ? (
              <p id={`${ids}-goal-error`} role="alert" className="rs-error">{goalError}</p>
            ) : (
              <p id={`${ids}-goal-help`} className="rs-help">
                Average pace {formatPaceForUnit(goalSec / distanceMi, unit)}{paceLabel}
              </p>
            )}
          </fieldset>

          <div>
            <label className="rs-label" htmlFor={`${ids}-name`}>Strategy name (optional)</label>
            <input
              id={`${ids}-name`}
              type="text"
              className="rs-input"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${marathon.name} — ${formatDurationSec(goalSec)} plan`}
            />
          </div>
        </div>

        <fieldset className="rs-fieldset rs-pacing">
          <legend className="rs-label">Pacing</legend>
          <div className="rs-pacing-grid">
            {PACING_STRATEGIES.map((ps) => (
              <label key={ps.value} className={`rs-pacing-option${pacing === ps.value ? ' is-selected' : ''}`}>
                <input
                  type="radio"
                  name={`${ids}-pacing`}
                  value={ps.value}
                  checked={pacing === ps.value}
                  onChange={() => setPacing(ps.value)}
                />
                <span className="rs-pacing-text">
                  <span className="rs-pacing-title">{ps.label}</span>
                  <span className="rs-pacing-desc">{ps.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {(pacing === 'negative-split' || pacing === 'positive-split') && (
          <div className="rs-magnitude">
            <label className="rs-label" htmlFor={`${ids}-mag`}>Split size (%)</label>
            <input
              id={`${ids}-mag`}
              type="number"
              className="rs-input rs-input-narrow"
              min={0.5} max={5} step={0.5}
              value={magnitude}
              aria-describedby={`${ids}-mag-help`}
              onChange={(e) => {
                const n = Number(e.target.value);
                setMagnitude(Number.isFinite(n) ? Math.min(5, Math.max(0.5, Math.round(n * 2) / 2)) : DEFAULT_SPLIT_MAGNITUDE_PCT);
              }}
            />
            <p id={`${ids}-mag-help`} className="rs-help">
              {pacing === 'negative-split' ? 'Second half this much faster than the first.' : 'Second half this much slower than the first.'}
              {halvesPreview ? ` ${halvesPreview}` : ''}
            </p>
          </div>
        )}

        <div className="rs-actions">
          <button type="button" className="btn btn-primary rs-btn" onClick={handlePreview} disabled={goalError !== null}>
            {preview ? 'Update preview' : 'Preview plan'}
          </button>
          {preview && !stale && savedId !== preview.id && !viewing && (
            <button type="button" className="btn btn-secondary rs-btn" onClick={handleSave}>
              Save strategy
            </button>
          )}
          {onSetActive && display && (viewing || savedId === display.id) && activeStrategyId !== display.id && (
            <button type="button" className="btn btn-secondary rs-btn" onClick={() => handleSetActive(display.id)}>
              Use on race day
            </button>
          )}
        </div>
        {buildError && <p role="alert" className="rs-error">{buildError}</p>}
        {stale && !viewing && <p className="rs-help">Inputs changed. Update the preview before saving.</p>}
        <p role="status" className="rs-status">{status}</p>
      </section>

      {display && (
        <StrategyDetails
          strategy={display}
          marathon={marathon}
          unit={unit}
          isActive={activeStrategyId === display.id}
          isPreview={!viewing && savedId !== display.id}
          highlight={highlight}
          onHighlight={setHighlight}
          idPrefix={ids}
        />
      )}
    </div>
  );
}

interface DetailsProps {
  strategy: RaceStrategy;
  marathon: MarathonRace;
  unit: DistanceUnit;
  isActive: boolean;
  isPreview: boolean;
  highlight?: ElevationHighlight;
  onHighlight: (h: ElevationHighlight | undefined) => void;
  idPrefix: string;
}

function StrategyDetails({ strategy, marathon, unit, isActive, isPreview, highlight, onHighlight, idPrefix }: DetailsProps) {
  const distanceMi = getStrategyDistanceMi(strategy);
  const half = distanceMi / 2;
  const rows = buildUnitSplits(strategy.milePaces, unit, distanceMi);
  const paceLabel = paceUnitLabel(unit);
  const diff = strategy.secondHalfSec - strategy.firstHalfSec;
  const diffWords = diff < 0 ? 'negative split' : diff > 0 ? 'positive split' : 'even';
  const unitWord = unit === 'km' ? 'Km' : 'Mile';

  const summary: { label: string; value: string; gold?: boolean }[] = [
    { label: 'Target', value: formatDurationSec(strategy.targetTimeSec), gold: true },
    { label: 'Average pace', value: `${formatPaceForUnit(strategy.targetTimeSec / distanceMi, unit)}${paceLabel}` },
    { label: 'First half', value: formatDurationSec(strategy.firstHalfSec) },
    { label: 'Second half', value: formatDurationSec(strategy.secondHalfSec) },
    { label: 'Split difference', value: `${formatDurationSec(diff, { signed: true })} (${diffWords})` },
    { label: 'Pacing', value: pacingLabel(strategy.pacingStrategy) },
  ];

  return (
    <div className="rs-details">
      <section className="card rs-section rs-summary" aria-labelledby={`${idPrefix}-plan`}>
        <p className="rs-eyebrow rs-eyebrow-gold">
          {isPreview ? 'Preview (not saved)' : isActive ? 'Race-day strategy' : 'Saved strategy'}
        </p>
        <h4 id={`${idPrefix}-plan`} className="rs-plan-name">{strategy.name}</h4>
        <dl className="rs-stats">
          {summary.map(({ label, value, gold }) => (
            <div key={label} className="rs-stat">
              <dt>{label}</dt>
              <dd className={gold ? 'rs-gold' : undefined} data-testid={`rs-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card rs-section" aria-labelledby={`${idPrefix}-course`}>
        <h4 id={`${idPrefix}-course`} className="rs-eyebrow">Course profile</h4>
        <div className="rs-chart">
          <ElevationChart
            points={marathon.course.elevationPoints}
            totalDistanceMi={distanceMi}
            highlight={highlight}
            unit={unit}
          />
        </div>
      </section>

      <section className="card rs-section rs-table-wrap" aria-labelledby={`${idPrefix}-splits`}>
        <h4 id={`${idPrefix}-splits`} className="rs-eyebrow">{unit === 'km' ? 'Kilometre splits' : 'Mile splits'}</h4>
        <table className="rs-table">
          <caption className="sr-only">
            {unit === 'km' ? 'Kilometre' : 'Mile'} splits for {strategy.name}. Focus a row to highlight it on the course profile.
          </caption>
          <thead>
            <tr>
              <th scope="col">{unitWord}</th>
              <th scope="col">Pace ({paceLabel})</th>
              <th scope="col">Split</th>
              <th scope="col">Elapsed</th>
              <th scope="col">Elevation</th>
              <th scope="col" className="rs-left">Notes</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const prevEndMi = i === 0 ? 0 : rows[i - 1].endMi;
              const isHalf = prevEndMi < half - 1e-9 && half <= row.endMi + 1e-9;
              const partial = row.length < 0.999;
              const elevFt = courseElevationFtAt(marathon, row.endMi) - courseElevationFtAt(marathon, prevEndMi);
              const notes = unit === 'mi'
                ? strategy.milePaces.find((mp) => mp.mile >= row.endMi - 1e-6)?.notes ?? ''
                : strategy.milePaces.filter((mp) => mp.mile > prevEndMi + 1e-9 && mp.mile <= row.endMi + 1e-9).map((mp) => mp.notes).filter(Boolean).join(' · ');
              const select = () => onHighlight({ fromMi: prevEndMi, toMi: row.endMi });
              return (
                <tr
                  key={row.index}
                  tabIndex={0}
                  className={isHalf ? 'rs-row-half' : undefined}
                  onMouseEnter={select}
                  onMouseLeave={() => onHighlight(undefined)}
                  onFocus={select}
                  onBlur={() => onHighlight(undefined)}
                >
                  <th scope="row">
                    {partial ? row.endDistance.toFixed(1) : row.index}
                    {isHalf && <span className="rs-half-tag">Half</span>}
                  </th>
                  <td className="rs-mono rs-gold">{formatDurationSec(row.paceSecPerUnit)}</td>
                  <td className="rs-mono">{formatDurationSec(row.splitSec)}</td>
                  <td className="rs-mono rs-muted">{formatDurationSec(row.cumulativeSec)}</td>
                  <td>{formatElevChange(elevFt, unit)}</td>
                  <td className="rs-left rs-notes">{notes}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card rs-section" aria-labelledby={`${idPrefix}-fuel`}>
        <h4 id={`${idPrefix}-fuel`} className="rs-eyebrow">Fuel plan</h4>
        {strategy.nutritionPlan.length === 0 ? (
          <p className="rs-muted">No fuel stops planned for this race.</p>
        ) : (
          <ul className="rs-fuel-list">
            {strategy.nutritionPlan.map((np, i) => (
              <li key={i} className="rs-fuel-item">
                <span className="rs-fuel-when">
                  {typeof np.timeSec === 'number'
                    ? (np.timeSec < 0 ? 'Before the start' : formatDurationSec(np.timeSec))
                    : '—'}
                  <span className="rs-muted">
                    {np.mile > 0 ? ` · ${(unit === 'km' ? np.mile * 1.609344 : np.mile).toFixed(1)} ${unit}` : ''}
                  </span>
                </span>
                <span>
                  <span className="rs-fuel-item-name">{np.item}</span>
                  <span className="rs-help">{np.notes}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
