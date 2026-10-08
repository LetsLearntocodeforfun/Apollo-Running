import { useState } from 'react';
import { getWorldMajors } from '../data/worldMajors';
import ElevationChart from './ElevationChart';
import { safeWebsite } from '../services/raceStrategy';
import { getDistanceUnit, type DistanceUnit } from '../services/unitPreferences';
import { formatTemperatureF } from '../services/athleteProfile';
import { daysBetween, isDateKey, parseDateKey, todayKey } from '../utils/localDate';
import type { MarathonRace } from '../types/raceStrategy';
import './race/Strategy.css';

interface Props {
  customMarathons: MarathonRace[];
  /** Open the strategy builder for a race. */
  onSelect: (marathon: MarathonRace) => void;
  selectedId?: string;
  /** Make a race the athlete's My Race (optional). */
  onChooseRace?: (marathon: MarathonRace) => void;
  /** Id of the current My Race, if any. */
  myRaceId?: string | null;
  /** Today's date key (defaults to the local date). */
  today?: string;
}

/** "Sunday, October 11, 2026" from a YYYY-MM-DD key (no UTC shift). */
function formatDate(dateKey: string): string {
  if (!isDateKey(dateKey)) return 'Date to be announced';
  return parseDateKey(dateKey).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function difficultyLabel(d: number): { label: string; tone: string } {
  if (d <= 2) return { label: 'Fast / flat', tone: 'rs-tone-good' };
  if (d <= 4) return { label: 'Moderate', tone: 'rs-tone-gold' };
  if (d <= 6) return { label: 'Challenging', tone: 'rs-tone-warn' };
  if (d <= 8) return { label: 'Difficult', tone: 'rs-tone-bad' };
  return { label: 'Extreme', tone: 'rs-tone-bad' };
}

function formatElev(ft: number, unit: DistanceUnit, signed = false): string {
  const v = Math.round(unit === 'km' ? ft * 0.3048 : ft);
  const sign = signed && v > 0 ? '+' : signed && v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toLocaleString()} ${unit === 'km' ? 'm' : 'ft'}`;
}

const COURSE_TYPE_LABEL: Record<MarathonRace['courseType'], string> = {
  'loop': 'Loop',
  'point-to-point': 'Point-to-point',
  'out-and-back': 'Out and back',
  'multi-loop': 'Multi-loop',
};

function MarathonCard({
  marathon, isSelected, isMyRace, onSelect, onChooseRace, today,
}: {
  marathon: MarathonRace;
  isSelected: boolean;
  isMyRace: boolean;
  onSelect: () => void;
  onChooseRace?: () => void;
  today: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const unit = getDistanceUnit();
  const diff = difficultyLabel(marathon.course.difficulty);
  const daysUntil = isDateKey(marathon.date) ? daysBetween(today, marathon.date) : null;
  const panelId = `race-details-${marathon.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const website = safeWebsite(marathon.website);
  const distance = `${(unit === 'km' ? marathon.distanceMi * 1.609344 : marathon.distanceMi).toFixed(1)} ${unit}`;

  return (
    <article className={`card rs-race-card${isSelected ? ' is-selected' : ''}`}>
      <div className="rs-race-card-head">
        <div className="rs-race-card-main">
          <h3 className="rs-race-card-title">
            <button
              type="button"
              className="rs-disclosure"
              aria-expanded={expanded}
              aria-controls={panelId}
              onClick={() => setExpanded((v) => !v)}
            >
              <span aria-hidden="true" className="rs-disclosure-icon">{expanded ? '▾' : '▸'}</span>
              {marathon.name}
            </button>
          </h3>
          <div className="rs-badges">
            {marathon.isWorldMajor && <span className="rs-badge rs-badge-gold">World Marathon Major</span>}
            {marathon.category === 'custom' && <span className="rs-badge rs-badge-teal">Custom</span>}
            {isMyRace && <span className="rs-badge rs-badge-gold">My race</span>}
          </div>
          <p className="rs-muted rs-tight">{[marathon.city, marathon.country].filter(Boolean).join(', ')}</p>
          <p className="rs-muted rs-tight">
            {formatDate(marathon.date)}
            {marathon.dateEstimated && <span className="rs-note"> (date to be confirmed)</span>}
            {daysUntil !== null && daysUntil >= 0 && (
              <span className="rs-gold rs-strong"> · {daysUntil === 0 ? 'Today' : `${daysUntil} day${daysUntil === 1 ? '' : 's'} away`}</span>
            )}
            {daysUntil !== null && daysUntil < 0 && <span> · past</span>}
          </p>
        </div>
        <div className="rs-race-card-side">
          <p className={`rs-strong rs-tight ${diff.tone}`}>{diff.label} ({marathon.course.difficulty}/10)</p>
          <p className="rs-muted rs-tight rs-small">
            {distance} · {formatElev(marathon.course.totalGainFt, unit)} gain · {COURSE_TYPE_LABEL[marathon.courseType] ?? marathon.courseType}
          </p>
          {marathon.course.prFriendly && <p className="rs-tone-good rs-small rs-tight">PR-friendly course</p>}
        </div>
      </div>

      <div className="rs-actions">
        <button type="button" className="btn btn-primary rs-btn" onClick={onSelect} aria-pressed={isSelected}>
          {isSelected ? 'Building strategy' : 'Build a strategy'}
        </button>
        {onChooseRace && !isMyRace && (
          <button type="button" className="btn btn-secondary rs-btn" onClick={onChooseRace}>
            Set as my race
          </button>
        )}
      </div>

      {expanded && (
        <div id={panelId} className="rs-race-details">
          <p className="rs-body">{marathon.courseDescription}</p>
          <dl className="rs-stats">
            {[
              { label: 'Elevation gain', value: formatElev(marathon.course.totalGainFt, unit) },
              { label: 'Elevation loss', value: formatElev(marathon.course.totalLossFt, unit) },
              { label: 'Net change', value: formatElev(marathon.course.netChangeFt, unit, true) },
              { label: 'Typical temperature', value: `${formatTemperatureF(marathon.typicalTempF.low)} to ${formatTemperatureF(marathon.typicalTempF.high)}` },
              { label: 'Start time', value: marathon.startTime ? `${marathon.startTime}${marathon.timeZone ? ` (${marathon.timeZone.replace(/_/g, ' ')})` : ''}` : 'To be announced' },
              { label: 'Field size', value: marathon.fieldSize ? marathon.fieldSize.toLocaleString() : 'Unknown' },
              { label: 'Time limit', value: marathon.timeLimitHours ? `${marathon.timeLimitHours} h` : 'None published' },
              { label: 'Aid stations', value: String(marathon.aidStations.length) },
            ].map(({ label, value }) => (
              <div key={label} className="rs-stat">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>

          <h4 className="rs-eyebrow">Elevation profile</h4>
          <div className="rs-chart">
            <ElevationChart points={marathon.course.elevationPoints} totalDistanceMi={marathon.distanceMi} unit={unit} />
          </div>

          {marathon.qualifyingInfo && (
            <>
              <h4 className="rs-eyebrow">Entry requirements</h4>
              <p className="rs-body">{marathon.qualifyingInfo}</p>
            </>
          )}

          {marathon.tips.length > 0 && (
            <>
              <h4 className="rs-eyebrow">Race tips</h4>
              <ul className="rs-tips">
                {marathon.tips.map((tip, i) => <li key={i}>{tip}</li>)}
              </ul>
            </>
          )}

          {website && (
            <p>
              <a href={website} target="_blank" rel="noopener noreferrer" className="btn btn-secondary rs-btn">
                Official website<span aria-hidden="true"> ↗</span>
              </a>
            </p>
          )}
        </div>
      )}
    </article>
  );
}

/** Browse the World Marathon Majors (dated to their next edition) and custom races. */
export default function MarathonBrowser({ customMarathons, onSelect, selectedId, onChooseRace, myRaceId, today = todayKey() }: Props) {
  const [filter, setFilter] = useState<'all' | 'world-major' | 'custom'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const allMarathons = [...getWorldMajors(today), ...customMarathons];
  const q = searchQuery.trim().toLowerCase();
  const filtered = allMarathons
    .filter((m) => {
      if (filter === 'world-major' && !m.isWorldMajor) return false;
      if (filter === 'custom' && m.category !== 'custom') return false;
      if (!q) return true;
      return m.name.toLowerCase().includes(q) || m.city.toLowerCase().includes(q) || m.country.toLowerCase().includes(q);
    })
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const FILTERS: { key: typeof filter; label: string }[] = [
    { key: 'all', label: 'All races' },
    { key: 'world-major', label: 'World Marathon Majors' },
    { key: 'custom', label: 'Custom' },
  ];

  return (
    <div className="rs-browser">
      <div className="rs-filters">
        <div className="rs-chip-row" role="group" aria-label="Filter races">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`btn ${filter === key ? 'btn-primary' : 'btn-secondary'} rs-btn`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="rs-search">
          <span className="sr-only">Search races</span>
          <input
            type="search"
            className="rs-input"
            placeholder="Search by name, city or country"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
      </div>

      {filtered.length === 0 && (
        <div className="card rs-empty-card">
          <p>No races match your filters.</p>
        </div>
      )}
      {filtered.map((m) => (
        <MarathonCard
          key={m.id}
          marathon={m}
          isSelected={selectedId === m.id}
          isMyRace={!!myRaceId && myRaceId === m.id}
          onSelect={() => onSelect(m)}
          onChooseRace={onChooseRace ? () => onChooseRace(m) : undefined}
          today={today}
        />
      ))}
    </div>
  );
}
