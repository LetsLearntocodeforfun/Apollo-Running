import { useState } from 'react';
import type { CustomMarathonInput } from '../services/raceStrategy';
import type { MarathonRace } from '../types/raceStrategy';

interface Props {
  onImport: (input: CustomMarathonInput) => MarathonRace;
  onCancel: () => void;
}

export default function MarathonImport({ onImport, onCancel }: Props) {
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [date, setDate] = useState('');
  const [courseType, setCourseType] = useState<MarathonRace['courseType']>('loop');
  const [distanceMi, setDistanceMi] = useState(26.2);
  const [elevationGainFt, setElevationGainFt] = useState<number | ''>('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  const [tempLow, setTempLow] = useState<number | ''>(50);
  const [tempHigh, setTempHigh] = useState<number | ''>(65);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Race name is required'); return; }
    if (!city.trim()) { setError('City is required'); return; }
    if (!country.trim()) { setError('Country is required'); return; }
    if (!date) { setError('Race date is required'); return; }

    setError('');
    onImport({
      name: name.trim(),
      city: city.trim(),
      country: country.trim(),
      date,
      courseType,
      distanceMi,
      elevationGainFt: elevationGainFt === '' ? undefined : elevationGainFt,
      website: website.trim() || undefined,
      notes: notes.trim() || undefined,
      typicalTempF: tempLow !== '' && tempHigh !== ''
        ? { low: tempLow, high: tempHigh }
        : undefined,
    });
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-md)',
    border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
    fontSize: 'var(--text-sm)',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
    display: 'block', marginBottom: '0.25rem', fontFamily: 'var(--font-display)',
  };

  return (
    <div className="card" style={{
      background: 'linear-gradient(135deg, rgba(91,181,181,0.06) 0%, var(--bg-card) 100%)',
      position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--apollo-teal-dark), var(--apollo-teal), var(--apollo-teal-dark), transparent)' }} />

      <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--apollo-teal)', marginBottom: '0.25rem' }}>
        Import a Marathon
      </div>
      <h3 style={{ margin: '0 0 0.5rem' }}>Add a Custom Race</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginBottom: '1rem' }}>
        Add any marathon, half marathon, or major race. Once imported, you can build a full race strategy for it.
      </p>

      {error && (
        <div style={{
          background: 'var(--color-error-dim)', border: '1px solid var(--color-error)',
          borderRadius: 'var(--radius-md)', padding: '0.5rem 0.75rem',
          fontSize: 'var(--text-sm)', color: 'var(--color-error)', marginBottom: '0.75rem',
        }}>
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
          <div>
            <label style={labelStyle}>Race Name *</label>
            <input
              type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marine Corps Marathon" style={inputStyle} required
            />
          </div>
          <div>
            <label style={labelStyle}>City *</label>
            <input
              type="text" value={city} onChange={(e) => setCity(e.target.value)}
              placeholder="e.g. Washington, D.C." style={inputStyle} required
            />
          </div>
          <div>
            <label style={labelStyle}>Country *</label>
            <input
              type="text" value={country} onChange={(e) => setCountry(e.target.value)}
              placeholder="e.g. United States" style={inputStyle} required
            />
          </div>
          <div>
            <label style={labelStyle}>Race Date *</label>
            <input
              type="date" value={date} onChange={(e) => setDate(e.target.value)}
              style={inputStyle} required
            />
          </div>
          <div>
            <label style={labelStyle}>Distance (miles)</label>
            <input
              type="number" value={distanceMi} onChange={(e) => setDistanceMi(Number(e.target.value))}
              step={0.1} min={3} max={100} style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Course Type</label>
            <select
              value={courseType}
              onChange={(e) => setCourseType(e.target.value as MarathonRace['courseType'])}
              style={inputStyle}
            >
              <option value="loop">Loop</option>
              <option value="point-to-point">Point-to-Point</option>
              <option value="out-and-back">Out and Back</option>
              <option value="multi-loop">Multi-Loop</option>
            </select>
          </div>
        </div>

        {/* Advanced toggle */}
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            background: 'none', border: 'none', color: 'var(--apollo-teal)',
            cursor: 'pointer', fontSize: 'var(--text-sm)', marginTop: '0.75rem',
            fontFamily: 'var(--font-display)', fontWeight: 600,
          }}
        >
          {showAdvanced ? '▼' : '▶'} Advanced Details (optional)
        </button>

        {showAdvanced && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem', marginTop: '0.5rem' }}>
            <div>
              <label style={labelStyle}>Elevation Gain (ft)</label>
              <input
                type="number" value={elevationGainFt} onChange={(e) => setElevationGainFt(e.target.value ? Number(e.target.value) : '')}
                placeholder="e.g. 500" min={0} max={15000} style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Expected Temp Low (°F)</label>
              <input
                type="number" value={tempLow} onChange={(e) => setTempLow(e.target.value ? Number(e.target.value) : '')}
                placeholder="e.g. 50" style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Expected Temp High (°F)</label>
              <input
                type="number" value={tempHigh} onChange={(e) => setTempHigh(e.target.value ? Number(e.target.value) : '')}
                placeholder="e.g. 65" style={inputStyle}
              />
            </div>
            <div>
              <label style={labelStyle}>Website</label>
              <input
                type="url" value={website} onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://..." style={inputStyle}
              />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Notes / Course Description</label>
              <textarea
                value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Any additional details about the course, terrain, or logistics…"
                rows={3}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-body)' }}
              />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button type="submit" className="btn btn-primary">
            Import Marathon
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
