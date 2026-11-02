import { useId, useMemo, useRef, useState } from 'react';
import ElevationChart from './ElevationChart';
import {
  MAX_COURSE_GPX_BYTES,
  applyGpxCourseToMarathon,
  fitCourseToDistance,
  isMarathonDistanceMi,
  parseCourseGpx,
  type CourseDifficulty,
  type CourseDistanceFit,
  type ParsedGpxCourse,
} from '../services/courseGpxParser';
import {
  MARATHON_MI,
  buildRaceStrategy,
  formatPaceForUnit,
  saveStrategy,
  validateCustomMarathonInput,
  validateGoalTime,
  type CustomMarathonInput,
} from '../services/raceStrategy';
import { getDistanceUnit, paceUnitLabel, type DistanceUnit } from '../services/unitPreferences';
import { cToF, getTemperatureUnit } from '../services/athleteProfile';
import { isValidTimeZone, setMyRace } from '../services/myRace';
import { getRaceDate } from '../services/journey';
import { chooseMyRace } from './race/actions';
import { getDefaultGoalSec } from './race/goal';
import { PACING_STRATEGIES } from './StrategyBuilder';
import { addDays, todayKey } from '../utils/localDate';
import type { MarathonRace, PacingStrategy } from '../types/raceStrategy';
import './race/Strategy.css';

interface Props {
  /** Save the race. May throw a RangeError with a user-facing message. */
  onImport: (input: CustomMarathonInput) => MarathonRace;
  onCancel: () => void;
}

const KM_PER_MI = 1.609344;
const FT_PER_M = 3.28084;

const DIFFICULTY_LABELS: Record<CourseDifficulty, string> = {
  1: 'Flat & fast',
  2: 'Gentle rollers',
  3: 'Moderate hills',
  4: 'Hilly & challenging',
  5: 'Severe climb',
};

function splitHms(sec: number): [number, number, number] {
  const t = Math.max(0, Math.round(Number.isFinite(sec) ? sec : 0));
  return [Math.min(12, Math.floor(t / 3600)), Math.floor((t % 3600) / 60), t % 60];
}

function clampInt(raw: string, lo: number, hi: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected GPX file.'));
    reader.onload = () => {
      const res = reader.result;
      if (res instanceof ArrayBuffer) {
        resolve(new Uint8Array(res));
      } else if (typeof res === 'string') {
        resolve(new TextEncoder().encode(res));
      } else {
        reject(new Error('Could not read the selected GPX file.'));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/** Plain-language note when a course was rescaled to the race distance, or left as measured. */
function describeDistanceFit(fit: CourseDistanceFit, unit: DistanceUnit): string | null {
  // Kilometres go through 3 decimals first, like the course distance itself: the official
  // marathon (26.21875 mi = 42.194988 km) reads 42.20 km, not 42.19 km.
  const fmt = (mi: number) =>
    unit === 'km' ? `${(Math.round(mi * KM_PER_MI * 1000) / 1000).toFixed(2)} km` : `${mi.toFixed(2)} mi`;
  if (!fit.fitted) {
    return `This GPX measures ${fmt(fit.measuredMi)}, more than 3% away from the ${fmt(fit.targetMi)} race distance, so Apollo kept its distances as measured.`;
  }
  const changePct = Math.abs(fit.scale - 1) * 100;
  if (changePct < 0.05) return null;
  return `This GPX measures ${fmt(fit.measuredMi)}. Apollo scaled its distances by ${changePct.toFixed(1)}% so the splits, aid stations and profile finish at ${fmt(fit.targetMi)}.`;
}

/**
 * Length of a course split in the preview table: tenths of a mile, so the last
 * stretch of a marathon reads 0.2 (hundredths for a stub under 0.05 mi), or
 * hundredths of a kilometre.
 */
function formatSplitLength(mi: number, unit: DistanceUnit): string {
  if (unit === 'km') return (mi * KM_PER_MI).toFixed(2);
  return mi >= 0.05 ? mi.toFixed(1) : mi.toFixed(2);
}

/**
 * Add a custom race manually or by uploading a Course GPX (.gpx) file.
 * Inputs follow the athlete's units (km/m/°C or mi/ft/°F) and convert to the
 * stored miles/feet/°F representation.
 */
export default function MarathonImport({ onImport, onCancel }: Props) {
  const unit = getDistanceUnit();
  const paceLabel = paceUnitLabel(unit);
  const tempUnit = getTemperatureUnit();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Bumped on every pick or clear, so a slower earlier read can't overwrite a newer one. */
  const gpxPickRef = useRef(0);
  /** Distance the athlete typed (null until they do): the race distance a new GPX is fitted to. */
  const typedDistanceRef = useRef<string | null>(null);

  const [parsedGpx, setParsedGpx] = useState<ParsedGpxCourse | null>(null);
  const [gpxFileName, setGpxFileName] = useState('');
  const [gpxBusy, setGpxBusy] = useState(false);
  const [showSplitsPreview, setShowSplitsPreview] = useState(false);

  const defaultDistance = unit === 'km' ? '42.2' : '26.2';
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [date, setDate] = useState('');
  const [courseType, setCourseType] = useState<MarathonRace['courseType']>('loop');
  const [distance, setDistance] = useState(defaultDistance);
  const [elevationGain, setElevationGain] = useState('');
  const [elevationLoss, setElevationLoss] = useState('');
  const [startTime, setStartTime] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [tempLow, setTempLow] = useState('');
  const [tempHigh, setTempHigh] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');

  // 1-click Race Strategy builder state (auto-enabled on GPX upload)
  const initialGoal = getDefaultGoalSec(26.2);
  const [h0, m0, s0] = splitHms(initialGoal);
  const [createStrategyNow, setCreateStrategyNow] = useState(false);
  const [goalHours, setGoalHours] = useState(h0);
  const [goalMinutes, setGoalMinutes] = useState(m0);
  const [goalSeconds, setGoalSeconds] = useState(s0);
  const [pacingStrategy, setPacingStrategy] = useState<PacingStrategy>('negative-split');

  const handleGpxFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Reset the input so choosing the same file again still fires a change event.
    input.value = '';
    if (!file) return;
    const pick = ++gpxPickRef.current;

    const fail = (message: string) => {
      setGpxBusy(false);
      setParsedGpx(null);
      setGpxFileName('');
      setShowSplitsPreview(false);
      setError(message);
    };

    if (file.size > MAX_COURSE_GPX_BYTES) {
      fail('Course GPX file exceeds the 15 MB size limit.');
      return;
    }

    // Fit the course to the distance the athlete typed, else this form's marathon default.
    const typedText = typedDistanceRef.current;
    const typed = Number(typedText ?? defaultDistance);
    const typedIsValid = Number.isFinite(typed) && typed > 0;
    const raceDistance = typedIsValid ? typed : Number(defaultDistance);
    const raceDistanceText = typedIsValid && typedText !== null ? typedText : defaultDistance;
    const targetDistanceMi = unit === 'km' ? raceDistance / KM_PER_MI : raceDistance;

    setGpxBusy(true);
    try {
      const bytes = await readFileBytes(file);
      if (pick !== gpxPickRef.current) return;
      const parsed = parseCourseGpx(bytes, { fallbackName: file.name, targetDistanceMi });
      setParsedGpx(parsed);
      setGpxFileName(file.name);
      setError('');

      setName((prev) => (prev.trim() ? prev : parsed.suggestedName));
      setCourseType(parsed.suggestedCourseType);
      // A course that fits keeps the race distance as entered (a marathon finishes at the official
      // 42.195 km); one that doesn't shows the length it measures, which the athlete can edit.
      setDistance(
        parsed.distanceFit.fitted
          ? raceDistanceText
          : unit === 'km'
            ? parsed.distanceKm.toFixed(2)
            : parsed.distanceMi.toFixed(2),
      );
      setElevationGain(unit === 'km' ? String(parsed.elevationGainM) : String(parsed.elevationGainFt));
      setElevationLoss(unit === 'km' ? String(parsed.elevationLossM) : String(parsed.elevationLossFt));
      setDate((prev) => prev || getRaceDate() || addDays(todayKey(), 30));

      const scaledGoal = getDefaultGoalSec(parsed.distanceMi);
      const [gh, gm, gs] = splitHms(scaledGoal);
      setGoalHours(gh);
      setGoalMinutes(gm);
      setGoalSeconds(gs);
      setCreateStrategyNow(true);
    } catch (err) {
      if (pick !== gpxPickRef.current) return;
      fail(err instanceof Error ? err.message : 'Could not parse the selected GPX file.');
    } finally {
      if (pick === gpxPickRef.current) setGpxBusy(false);
    }
  };

  const handleClearGpx = () => {
    gpxPickRef.current++;
    setGpxBusy(false);
    setParsedGpx(null);
    setGpxFileName('');
    setShowSplitsPreview(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const distNumPreview = Number(distance);
  // In miles, rounded the way the race is saved, so the preview always matches the saved course.
  const previewDistanceMi =
    Number.isFinite(distNumPreview) && distNumPreview > 0
      ? Math.round((unit === 'km' ? distNumPreview / KM_PER_MI : distNumPreview) * 1000) / 1000
      : (parsedGpx?.distanceMi ?? 26.2);
  // The preview follows the distance field: a course within ±3% of it finishes exactly there.
  const courseGpx = useMemo(
    () => (parsedGpx ? fitCourseToDistance(parsedGpx, previewDistanceMi) : null),
    [parsedGpx, previewDistanceMi],
  );
  // With a course, a marathon (26.2 mi, 42.2 km or 42.195 km) is the official 42.195 km.
  const previewRaceMi = parsedGpx && isMarathonDistanceMi(previewDistanceMi) ? MARATHON_MI : previewDistanceMi;
  const distanceFitNote = courseGpx ? describeDistanceFit(courseGpx.distanceFit, unit) : null;
  const goalTimeSec = goalHours * 3600 + goalMinutes * 60 + goalSeconds;
  const goalValidationError = createStrategyNow ? validateGoalTime(previewRaceMi, goalTimeSec) : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter a race name.');
      return;
    }
    if (!parsedGpx && !city.trim()) {
      setError('Enter the city.');
      return;
    }
    if (!parsedGpx && !country.trim()) {
      setError('Enter the country.');
      return;
    }

    const distNum = Number(distance);
    const typedMi = Math.round((unit === 'km' ? distNum / KM_PER_MI : distNum) * 1000) / 1000;
    // With a course GPX, a marathon is saved at the official 42.195 km, the distance its course
    // is fitted to; any other distance is saved as typed.
    const raceDistanceMi = parsedGpx && isMarathonDistanceMi(typedMi) ? MARATHON_MI : typedMi;
    // The course saved with the race is fitted to exactly this distance (when within ±3%).
    const raceCourse = parsedGpx ? fitCourseToDistance(parsedGpx, raceDistanceMi) : null;

    const gainNum = elevationGain.trim() === '' ? undefined : Number(elevationGain);
    if (gainNum !== undefined && (!Number.isFinite(gainNum) || gainNum < 0)) {
      setError('Elevation gain must be a positive number.');
      return;
    }
    const lossNum = elevationLoss.trim() === '' ? undefined : Number(elevationLoss);
    if (lossNum !== undefined && (!Number.isFinite(lossNum) || lossNum < 0)) {
      setError('Elevation loss must be a positive number.');
      return;
    }

    const elevationGainFt =
      gainNum === undefined ? raceCourse?.elevationGainFt : Math.round(unit === 'km' ? gainNum * FT_PER_M : gainNum);
    const elevationLossFt =
      lossNum === undefined ? raceCourse?.elevationLossFt : Math.round(unit === 'km' ? lossNum * FT_PER_M : lossNum);

    if (timeZone.trim() && !isValidTimeZone(timeZone.trim())) {
      setError('Time zone must be an IANA name such as America/Chicago.');
      return;
    }
    let typicalTempF: CustomMarathonInput['typicalTempF'];
    if (tempLow.trim() !== '' && tempHigh.trim() !== '') {
      const lo = Number(tempLow);
      const hi = Number(tempHigh);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
        setError('Enter a valid temperature range (low ≤ high).');
        return;
      }
      typicalTempF =
        tempUnit === 'C' ? { low: Math.round(cToF(lo)), high: Math.round(cToF(hi)) } : { low: lo, high: hi };
    }

    const input: CustomMarathonInput = {
      name: name.trim(),
      city: city.trim() || (parsedGpx ? 'GPX Course' : ''),
      country: country.trim() || (parsedGpx ? 'Custom' : ''),
      date,
      courseType,
      distanceMi: raceDistanceMi,
      elevationGainFt,
      elevationLossFt,
      difficulty: raceCourse?.course.difficulty,
      website: website.trim() || undefined,
      notes: notes.trim() || undefined,
      typicalTempF,
      startTime: startTime || undefined,
      timeZone: timeZone.trim() || undefined,
    };

    const problem = validateCustomMarathonInput(input);
    if (problem) {
      setError(unit === 'km' ? problem.replace('between 1 and 200 miles', 'between 1.6 and 320 km') : problem);
      return;
    }

    if (createStrategyNow) {
      const goalProblem = validateGoalTime(raceDistanceMi, goalTimeSec);
      if (goalProblem) {
        setError(goalProblem);
        return;
      }
    }

    try {
      setError('');
      const savedRace = onImport(input);

      let finalRace = savedRace;
      if (raceCourse) {
        const enriched = applyGpxCourseToMarathon(savedRace.id, {
          ...raceCourse,
          distanceMi: raceDistanceMi,
        });
        if (enriched) {
          savedRace.course = enriched.course;
          savedRace.splits = enriched.splits;
          savedRace.aidStations = enriched.aidStations;
          finalRace = enriched;
        }
      }

      if (createStrategyNow) {
        const built = buildRaceStrategy(finalRace.id, goalTimeSec, pacingStrategy);
        if (built) {
          saveStrategy(built);
          chooseMyRace(finalRace);
          setMyRace({ activeStrategyId: built.id });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this race.');
    }
  };

  const id = (s: string) => `${uid}-${s}`;
  const advancedId = id('advanced');
  const elevSuffix = unit === 'km' ? 'm' : 'ft';

  return (
    <section className="card rs-section rs-import" aria-labelledby={id('title')}>
      <p className="rs-eyebrow rs-eyebrow-teal">Import a race</p>
      <h3 id={id('title')} className="rs-race-name">
        Add a custom race
      </h3>
      <p className="rs-muted">
        Import a course GPX file for elevation profile and grade-adjusted pacing, or enter the race details below.
      </p>

      {/* GPX course import */}
      <div
        className="rs-callout"
        style={{ marginTop: 'var(--space-3)', marginBottom: 'var(--space-3)' }}
        aria-busy={gpxBusy}
      >
        <div className="rs-race-card-head" style={{ alignItems: 'center' }}>
          <div className="rs-race-card-main">
            <p className="rs-strong rs-tight">Course GPX file</p>
            <p className="rs-muted rs-small" role="status">
              {gpxBusy
                ? 'Reading the course file…'
                : gpxFileName
                  ? `Loaded ${gpxFileName} (${parsedGpx?.pointCount.toLocaleString() ?? 0} ${parsedGpx?.sourceKind === 'route' ? 'route' : 'track'} points)`
                  : 'Reads course distance, elevation gain and loss, split grades, and aid-station waypoints.'}
            </p>
          </div>
          <div className="rs-actions" style={{ marginTop: 0 }}>
            <input
              ref={fileInputRef}
              id={id('gpx-file')}
              type="file"
              accept=".gpx,application/gpx+xml,application/xml,text/xml"
              onChange={handleGpxFileChange}
              disabled={gpxBusy}
              style={{ display: 'none' }}
            />
            <label
              htmlFor={id('gpx-file')}
              className="btn btn-secondary rs-btn"
              style={{ cursor: gpxBusy ? 'progress' : 'pointer' }}
            >
              {gpxBusy ? 'Reading GPX…' : parsedGpx ? 'Replace GPX file…' : 'Choose GPX file…'}
            </label>
            {parsedGpx && (
              <button type="button" className="btn btn-ghost rs-btn" onClick={handleClearGpx}>
                Clear GPX
              </button>
            )}
          </div>
        </div>

        {courseGpx && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <dl className="rs-stats">
              <div className="rs-stat">
                <dt>Course distance</dt>
                <dd data-testid="gpx-stat-distance">
                  {unit === 'km' ? `${courseGpx.distanceKm.toFixed(2)} km` : `${courseGpx.distanceMi.toFixed(2)} mi`}
                </dd>
              </div>
              <div className="rs-stat">
                <dt>Climb / descent</dt>
                <dd data-testid="gpx-stat-elevation">
                  {courseGpx.hasElevation
                    ? unit === 'km'
                      ? `+${courseGpx.elevationGainM} m / −${courseGpx.elevationLossM} m`
                      : `+${courseGpx.elevationGainFt} ft / −${courseGpx.elevationLossFt} ft`
                    : 'Flat (no elevation tags)'}
                </dd>
              </div>
              <div className="rs-stat">
                <dt>Difficulty</dt>
                <dd data-testid="gpx-stat-difficulty">
                  {courseGpx.difficulty}/5 · {DIFFICULTY_LABELS[courseGpx.difficulty]}
                </dd>
              </div>
              <div className="rs-stat">
                <dt>Splits &amp; aid</dt>
                <dd>
                  {courseGpx.splits.length} splits · {courseGpx.aidStations.length} aid stations
                </dd>
              </div>
            </dl>

            {(distanceFitNote || courseGpx.warnings.length > 0) && (
              <div data-testid="gpx-notes">
                {distanceFitNote && <p className="rs-muted rs-small">{distanceFitNote}</p>}
                {courseGpx.warnings.map((warning) => (
                  <p key={warning} className="rs-muted rs-small">
                    {warning}
                  </p>
                ))}
              </div>
            )}

            <div className="rs-chart">
              <ElevationChart
                points={courseGpx.elevationProfile}
                totalDistanceMi={courseGpx.distanceMi}
                unit={unit}
                height={165}
              />
            </div>

            <button
              type="button"
              className="rs-disclosure rs-disclosure-inline"
              aria-expanded={showSplitsPreview}
              onClick={() => setShowSplitsPreview((v) => !v)}
            >
              <span aria-hidden="true" className="rs-disclosure-icon">
                {showSplitsPreview ? '▾' : '▸'}
              </span>
              {showSplitsPreview ? 'Hide GPX split grades' : `Preview ${courseGpx.splits.length} course splits`}
            </button>

            {showSplitsPreview && (
              <div className="rs-table-wrap" style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table className="rs-table">
                  <thead>
                    <tr>
                      <th scope="col">Split</th>
                      <th scope="col">Distance ({unit})</th>
                      <th scope="col">Net ({elevSuffix})</th>
                      <th scope="col">Grade</th>
                      <th scope="col" className="rs-left">
                        Course cue
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {courseGpx.splits.map((sp) => {
                      const dispNet = Math.round(
                        unit === 'km' ? sp.elevationChangeFt / FT_PER_M : sp.elevationChangeFt,
                      );
                      return (
                        <tr key={sp.splitNumber}>
                          <th scope="row">{sp.splitNumber}</th>
                          <td className="rs-mono">{formatSplitLength(sp.distanceMi, unit)}</td>
                          <td className="rs-mono">
                            {dispNet === 0
                              ? `0 ${elevSuffix}`
                              : `${dispNet > 0 ? '+' : '−'}${Math.abs(dispNet)} ${elevSuffix}`}
                          </td>
                          <td className="rs-mono">
                            {sp.avgGradePct > 0 ? `+${sp.avgGradePct.toFixed(1)}%` : `${sp.avgGradePct.toFixed(1)}%`}
                          </td>
                          <td className="rs-left rs-notes">{sp.notes}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="rs-error rs-error-box">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <div className="rs-grid">
          <div>
            <label className="rs-label" htmlFor={id('name')}>
              Race name (required)
            </label>
            <input
              id={id('name')}
              className="rs-input"
              type="text"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marine Corps Marathon"
              required
            />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('city')}>
              City {parsedGpx ? '(optional)' : '(required)'}
            </label>
            <input
              id={id('city')}
              className="rs-input"
              type="text"
              value={city}
              maxLength={80}
              onChange={(e) => setCity(e.target.value)}
              placeholder="e.g. Washington, D.C."
              required={!parsedGpx}
            />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('country')}>
              Country {parsedGpx ? '(optional)' : '(required)'}
            </label>
            <input
              id={id('country')}
              className="rs-input"
              type="text"
              value={country}
              maxLength={80}
              onChange={(e) => setCountry(e.target.value)}
              placeholder="e.g. United States"
              required={!parsedGpx}
            />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('date')}>
              Race date (required)
            </label>
            <input
              id={id('date')}
              className="rs-input"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('distance')}>
              Distance ({unit})
            </label>
            <input
              id={id('distance')}
              className="rs-input"
              type="number"
              inputMode="decimal"
              value={distance}
              onChange={(e) => {
                typedDistanceRef.current = e.target.value;
                setDistance(e.target.value);
              }}
              step={0.1}
              min={unit === 'km' ? 1.6 : 1}
              max={unit === 'km' ? 320 : 200}
            />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('course')}>
              Course type
            </label>
            <select
              id={id('course')}
              className="rs-input"
              value={courseType}
              onChange={(e) => setCourseType(e.target.value as MarathonRace['courseType'])}
            >
              <option value="loop">Loop</option>
              <option value="point-to-point">Point-to-point</option>
              <option value="out-and-back">Out and back</option>
              <option value="multi-loop">Multi-loop</option>
            </select>
          </div>
          <div>
            <label className="rs-label" htmlFor={id('start')}>
              Start time (optional)
            </label>
            <input
              id={id('start')}
              className="rs-input"
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('tz')}>
              Time zone (optional)
            </label>
            <input
              id={id('tz')}
              className="rs-input"
              type="text"
              value={timeZone}
              maxLength={64}
              onChange={(e) => setTimeZone(e.target.value)}
              placeholder="e.g. America/Chicago"
            />
          </div>
        </div>

        {/* Optional pacing strategy */}
        <div className="card" style={{ padding: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={createStrategyNow}
              onChange={(e) => setCreateStrategyNow(e.target.checked)}
            />
            <span className="rs-strong">Create a pacing strategy for this race</span>
          </label>
          {createStrategyNow && (
            <div className="rs-grid" style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>
              <fieldset className="rs-fieldset" aria-label="Import goal finish time">
                <span className="rs-label">Goal finish time</span>
                <div className="rs-hms">
                  <label>
                    <input
                      type="number"
                      min={0}
                      max={12}
                      value={goalHours}
                      aria-label="Goal hours"
                      aria-invalid={goalValidationError !== null}
                      onChange={(e) => setGoalHours(clampInt(e.target.value, 0, 12))}
                    />
                    h
                  </label>
                  <label>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={goalMinutes}
                      aria-label="Goal minutes"
                      aria-invalid={goalValidationError !== null}
                      onChange={(e) => setGoalMinutes(clampInt(e.target.value, 0, 59))}
                    />
                    m
                  </label>
                  <label>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={goalSeconds}
                      aria-label="Goal seconds"
                      aria-invalid={goalValidationError !== null}
                      onChange={(e) => setGoalSeconds(clampInt(e.target.value, 0, 59))}
                    />
                    s
                  </label>
                </div>
                {goalValidationError ? (
                  <span className="rs-error">{goalValidationError}</span>
                ) : (
                  <span className="rs-help">
                    Average pace {formatPaceForUnit(goalTimeSec / Math.max(0.5, previewRaceMi), unit)}
                    {paceLabel}
                  </span>
                )}
              </fieldset>
              <div>
                <label className="rs-label" htmlFor={id('pacing')}>
                  Pacing style
                </label>
                <select
                  id={id('pacing')}
                  className="rs-input"
                  value={pacingStrategy}
                  onChange={(e) => setPacingStrategy(e.target.value as PacingStrategy)}
                >
                  {PACING_STRATEGIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <span className="rs-help">
                  {parsedGpx ? 'Adjusts mile splits for your GPX climbs & descents.' : 'Even or negative-split pacing.'}
                </span>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className="rs-disclosure rs-disclosure-inline"
          aria-expanded={showAdvanced}
          aria-controls={advancedId}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <span aria-hidden="true" className="rs-disclosure-icon">
            {showAdvanced ? '▾' : '▸'}
          </span>
          More details (optional)
        </button>

        {showAdvanced && (
          <div id={advancedId} className="rs-grid">
            <div>
              <label className="rs-label" htmlFor={id('gain')}>
                Elevation gain ({elevSuffix})
              </label>
              <input
                id={id('gain')}
                className="rs-input"
                type="number"
                inputMode="numeric"
                value={elevationGain}
                onChange={(e) => setElevationGain(e.target.value)}
                placeholder={unit === 'km' ? 'e.g. 150' : 'e.g. 500'}
                min={0}
              />
            </div>
            <div>
              <label className="rs-label" htmlFor={id('loss')}>
                Elevation loss ({elevSuffix})
              </label>
              <input
                id={id('loss')}
                className="rs-input"
                type="number"
                inputMode="numeric"
                value={elevationLoss}
                onChange={(e) => setElevationLoss(e.target.value)}
                placeholder={unit === 'km' ? 'e.g. 150' : 'e.g. 500'}
                min={0}
              />
            </div>
            <div>
              <label className="rs-label" htmlFor={id('tlow')}>
                Typical temperature, low (°{tempUnit})
              </label>
              <input
                id={id('tlow')}
                className="rs-input"
                type="number"
                value={tempLow}
                onChange={(e) => setTempLow(e.target.value)}
                placeholder={tempUnit === 'C' ? 'e.g. 10' : 'e.g. 50'}
              />
            </div>
            <div>
              <label className="rs-label" htmlFor={id('thigh')}>
                Typical temperature, high (°{tempUnit})
              </label>
              <input
                id={id('thigh')}
                className="rs-input"
                type="number"
                value={tempHigh}
                onChange={(e) => setTempHigh(e.target.value)}
                placeholder={tempUnit === 'C' ? 'e.g. 18' : 'e.g. 65'}
              />
            </div>
            <div>
              <label className="rs-label" htmlFor={id('web')}>
                Website (https only)
              </label>
              <input
                id={id('web')}
                className="rs-input"
                type="url"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://…"
              />
            </div>
            <div className="rs-span-all">
              <label className="rs-label" htmlFor={id('notes')}>
                Notes / course description
              </label>
              <textarea
                id={id('notes')}
                className="rs-input"
                value={notes}
                rows={3}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Terrain, hills, logistics…"
              />
            </div>
          </div>
        )}

        <div className="rs-actions">
          <button type="submit" className="btn btn-primary rs-btn">
            {createStrategyNow ? 'Save course & create strategy' : 'Add race'}
          </button>
          <button type="button" className="btn btn-secondary rs-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
