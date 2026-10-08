import { useId, useState } from 'react';
import { validateCustomMarathonInput, type CustomMarathonInput } from '../services/raceStrategy';
import { getDistanceUnit } from '../services/unitPreferences';
import { cToF, getTemperatureUnit } from '../services/athleteProfile';
import { isValidTimeZone } from '../services/myRace';
import type { MarathonRace } from '../types/raceStrategy';
import './race/Strategy.css';

interface Props {
  /** Save the race. May throw a RangeError with a user-facing message. */
  onImport: (input: CustomMarathonInput) => MarathonRace;
  onCancel: () => void;
}

const KM_PER_MI = 1.609344;
const FT_PER_M = 3.28084;

/**
 * Add a custom race. Inputs follow the athlete's units (km/m/°C or mi/ft/°F)
 * and are converted to the stored miles/feet/°F. Validation errors show inline.
 */
export default function MarathonImport({ onImport, onCancel }: Props) {
  const unit = getDistanceUnit();
  const tempUnit = getTemperatureUnit();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [date, setDate] = useState('');
  const [courseType, setCourseType] = useState<MarathonRace['courseType']>('loop');
  const [distance, setDistance] = useState(unit === 'km' ? '42.2' : '26.2');
  const [elevationGain, setElevationGain] = useState('');
  const [startTime, setStartTime] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [tempLow, setTempLow] = useState('');
  const [tempHigh, setTempHigh] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Enter a race name.'); return; }
    if (!city.trim()) { setError('Enter the city.'); return; }
    if (!country.trim()) { setError('Enter the country.'); return; }
    const distNum = Number(distance);
    const distanceMi = unit === 'km' ? distNum / KM_PER_MI : distNum;
    const gainNum = elevationGain.trim() === '' ? undefined : Number(elevationGain);
    if (gainNum !== undefined && (!Number.isFinite(gainNum) || gainNum < 0)) { setError('Elevation gain must be a positive number.'); return; }
    const elevationGainFt = gainNum === undefined ? undefined : Math.round(unit === 'km' ? gainNum * FT_PER_M : gainNum);
    if (timeZone.trim() && !isValidTimeZone(timeZone.trim())) { setError('Time zone must be an IANA name such as America/Chicago.'); return; }
    let typicalTempF: CustomMarathonInput['typicalTempF'];
    if (tempLow.trim() !== '' && tempHigh.trim() !== '') {
      const lo = Number(tempLow);
      const hi = Number(tempHigh);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) { setError('Enter a valid temperature range (low ≤ high).'); return; }
      typicalTempF = tempUnit === 'C' ? { low: Math.round(cToF(lo)), high: Math.round(cToF(hi)) } : { low: lo, high: hi };
    }

    const input: CustomMarathonInput = {
      name: name.trim(),
      city: city.trim(),
      country: country.trim(),
      date,
      courseType,
      distanceMi: Math.round(distanceMi * 1000) / 1000,
      elevationGainFt,
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
    try {
      setError('');
      onImport(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this race.');
    }
  };

  const id = (s: string) => `${uid}-${s}`;
  const advancedId = id('advanced');

  return (
    <section className="card rs-section rs-import" aria-labelledby={id('title')}>
      <p className="rs-eyebrow rs-eyebrow-teal">Import a race</p>
      <h3 id={id('title')} className="rs-race-name">Add a custom race</h3>
      <p className="rs-muted">
        Add any marathon, half marathon or other race, then build a strategy for it. Without a course file the profile is flat.
      </p>

      {error && <p role="alert" className="rs-error rs-error-box">{error}</p>}

      <form onSubmit={handleSubmit} noValidate>
        <div className="rs-grid">
          <div>
            <label className="rs-label" htmlFor={id('name')}>Race name (required)</label>
            <input id={id('name')} className="rs-input" type="text" value={name} maxLength={120}
              onChange={(e) => setName(e.target.value)} placeholder="e.g. Marine Corps Marathon" required />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('city')}>City (required)</label>
            <input id={id('city')} className="rs-input" type="text" value={city} maxLength={80}
              onChange={(e) => setCity(e.target.value)} placeholder="e.g. Washington, D.C." required />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('country')}>Country (required)</label>
            <input id={id('country')} className="rs-input" type="text" value={country} maxLength={80}
              onChange={(e) => setCountry(e.target.value)} placeholder="e.g. United States" required />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('date')}>Race date (required)</label>
            <input id={id('date')} className="rs-input" type="date" value={date}
              onChange={(e) => setDate(e.target.value)} required />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('distance')}>Distance ({unit})</label>
            <input id={id('distance')} className="rs-input" type="number" inputMode="decimal" value={distance}
              onChange={(e) => setDistance(e.target.value)} step={0.1} min={unit === 'km' ? 1.6 : 1} max={unit === 'km' ? 320 : 200} />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('course')}>Course type</label>
            <select id={id('course')} className="rs-input" value={courseType}
              onChange={(e) => setCourseType(e.target.value as MarathonRace['courseType'])}>
              <option value="loop">Loop</option>
              <option value="point-to-point">Point-to-point</option>
              <option value="out-and-back">Out and back</option>
              <option value="multi-loop">Multi-loop</option>
            </select>
          </div>
          <div>
            <label className="rs-label" htmlFor={id('start')}>Start time (optional)</label>
            <input id={id('start')} className="rs-input" type="time" value={startTime}
              onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <label className="rs-label" htmlFor={id('tz')}>Time zone (optional)</label>
            <input id={id('tz')} className="rs-input" type="text" value={timeZone} maxLength={64}
              onChange={(e) => setTimeZone(e.target.value)} placeholder="e.g. America/Chicago" />
          </div>
        </div>

        <button
          type="button"
          className="rs-disclosure rs-disclosure-inline"
          aria-expanded={showAdvanced}
          aria-controls={advancedId}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <span aria-hidden="true" className="rs-disclosure-icon">{showAdvanced ? '▾' : '▸'}</span>
          More details (optional)
        </button>

        {showAdvanced && (
          <div id={advancedId} className="rs-grid">
            <div>
              <label className="rs-label" htmlFor={id('gain')}>Elevation gain ({unit === 'km' ? 'm' : 'ft'})</label>
              <input id={id('gain')} className="rs-input" type="number" inputMode="numeric" value={elevationGain}
                onChange={(e) => setElevationGain(e.target.value)} placeholder={unit === 'km' ? 'e.g. 150' : 'e.g. 500'} min={0} />
            </div>
            <div>
              <label className="rs-label" htmlFor={id('tlow')}>Typical temperature, low (°{tempUnit})</label>
              <input id={id('tlow')} className="rs-input" type="number" value={tempLow}
                onChange={(e) => setTempLow(e.target.value)} placeholder={tempUnit === 'C' ? 'e.g. 10' : 'e.g. 50'} />
            </div>
            <div>
              <label className="rs-label" htmlFor={id('thigh')}>Typical temperature, high (°{tempUnit})</label>
              <input id={id('thigh')} className="rs-input" type="number" value={tempHigh}
                onChange={(e) => setTempHigh(e.target.value)} placeholder={tempUnit === 'C' ? 'e.g. 18' : 'e.g. 65'} />
            </div>
            <div>
              <label className="rs-label" htmlFor={id('web')}>Website (https only)</label>
              <input id={id('web')} className="rs-input" type="url" value={website}
                onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" />
            </div>
            <div className="rs-span-all">
              <label className="rs-label" htmlFor={id('notes')}>Notes / course description</label>
              <textarea id={id('notes')} className="rs-input" value={notes} rows={3} maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Terrain, hills, logistics…" />
            </div>
          </div>
        )}

        <div className="rs-actions">
          <button type="submit" className="btn btn-primary rs-btn">Add race</button>
          <button type="button" className="btn btn-secondary rs-btn" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}
