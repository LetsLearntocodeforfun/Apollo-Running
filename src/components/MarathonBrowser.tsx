import { useState } from 'react';
import { WORLD_MAJOR_MARATHONS } from '../data/worldMajors';
import ElevationChart from './ElevationChart';
import type { MarathonRace } from '../types/raceStrategy';

interface Props {
  customMarathons: MarathonRace[];
  onSelect: (marathon: MarathonRace) => void;
  selectedId?: string;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function difficultyLabel(d: number): { label: string; color: string } {
  if (d <= 2) return { label: 'Very Fast / Easy', color: 'var(--color-success)' };
  if (d <= 4) return { label: 'Moderate', color: 'var(--apollo-gold)' };
  if (d <= 6) return { label: 'Challenging', color: 'var(--apollo-orange)' };
  if (d <= 8) return { label: 'Difficult', color: 'var(--color-error)' };
  return { label: 'Extreme', color: '#e74c3c' };
}

function daysUntilRace(dateStr: string): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const race = new Date(dateStr + 'T00:00:00');
  return Math.ceil((race.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

function MarathonCard({ marathon, isSelected, onSelect }: { marathon: MarathonRace; isSelected: boolean; onSelect: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const diff = difficultyLabel(marathon.course.difficulty);
  const daysUntil = daysUntilRace(marathon.date);
  const isPast = daysUntil < 0;

  return (
    <div
      className="card"
      style={{
        borderColor: isSelected ? 'var(--apollo-gold)' : undefined,
        borderWidth: isSelected ? 2 : 1,
        background: isSelected ? 'rgba(212, 165, 55, 0.04)' : undefined,
        cursor: 'pointer',
        transition: 'all 0.2s',
      }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-md)' }}>{marathon.name}</h3>
            {marathon.isWorldMajor && (
              <span style={{
                fontSize: '0.7rem', fontFamily: 'var(--font-display)', fontWeight: 700,
                background: 'var(--apollo-gold-dim)', color: 'var(--apollo-gold)',
                padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-full)',
                textTransform: 'uppercase', letterSpacing: '0.05em',
              }}>
                World Major
              </span>
            )}
            {marathon.category === 'custom' && (
              <span style={{
                fontSize: '0.7rem', fontFamily: 'var(--font-display)', fontWeight: 600,
                background: 'var(--apollo-teal-dim)', color: 'var(--apollo-teal)',
                padding: '0.15rem 0.5rem', borderRadius: 'var(--radius-full)',
              }}>
                Custom
              </span>
            )}
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginTop: '0.25rem' }}>
            {marathon.city}, {marathon.country}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', marginTop: '0.25rem' }}>
            {formatDate(marathon.date)}
            {!isPast && (
              <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, marginLeft: '0.5rem' }}>
                {daysUntil === 0 ? 'Today!' : `${daysUntil} days away`}
              </span>
            )}
            {isPast && (
              <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                (completed)
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 'var(--text-sm)', color: diff.color, fontWeight: 600, fontFamily: 'var(--font-display)' }}>
            {diff.label}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
            {marathon.course.totalGainFt}ft gain · {marathon.courseType}
          </div>
          {marathon.course.prFriendly && (
            <div style={{ fontSize: '0.68rem', color: 'var(--color-success)', fontWeight: 600, marginTop: '0.15rem' }}>
              PR-friendly course
            </div>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ marginTop: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
          {/* Course description */}
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.6, margin: 0 }}>
            {marathon.courseDescription}
          </p>

          {/* Quick stats */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: '0.75rem', marginTop: '1rem',
          }}>
            {[
              { label: 'Elevation Gain', value: `${marathon.course.totalGainFt} ft` },
              { label: 'Elevation Loss', value: `${marathon.course.totalLossFt} ft` },
              { label: 'Net Change', value: `${marathon.course.netChangeFt > 0 ? '+' : ''}${marathon.course.netChangeFt} ft` },
              { label: 'Temp Range', value: `${marathon.typicalTempF.low}–${marathon.typicalTempF.high}°F` },
              { label: 'Start Time', value: marathon.startTime ?? 'TBA' },
              { label: 'Field Size', value: marathon.fieldSize?.toLocaleString() ?? 'TBA' },
              { label: 'Time Limit', value: marathon.timeLimitHours ? `${marathon.timeLimitHours} hrs` : 'None' },
              { label: 'Aid Stations', value: `${marathon.aidStations.length}` },
            ].map(({ label, value }) => (
              <div key={label} style={{
                background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
                padding: '0.5rem 0.75rem',
              }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {label}
                </div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text)', fontWeight: 600, marginTop: '0.15rem' }}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Elevation Profile */}
          <div style={{ marginTop: '1rem' }}>
            <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Elevation Profile
            </div>
            <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', padding: '0.5rem', border: '1px solid var(--border-subtle)' }}>
              <ElevationChart points={marathon.course.elevationPoints} totalDistanceMi={marathon.distanceMi} />
            </div>
          </div>

          {/* Qualifying info */}
          {marathon.qualifyingInfo && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                Entry Requirements
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.5, margin: 0 }}>
                {marathon.qualifyingInfo}
              </p>
            </div>
          )}

          {/* Tips */}
          {marathon.tips.length > 0 && (
            <div style={{ marginTop: '0.75rem' }}>
              <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                Race Tips
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {marathon.tips.map((tip, i) => (
                  <div key={i} style={{
                    fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
                    padding: '0.4rem 0.6rem', background: 'var(--bg-surface)',
                    borderRadius: 'var(--radius-sm)', lineHeight: 1.5,
                    borderLeft: '2px solid var(--apollo-gold-dark)',
                  }}>
                    {tip}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Select button */}
          <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={(e) => { e.stopPropagation(); onSelect(marathon); }}
            >
              {isSelected ? '✓ Selected' : 'Create Race Strategy'}
            </button>
            {marathon.website && (
              <a
                href={marathon.website}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-secondary"
                onClick={(e) => e.stopPropagation()}
                style={{ textDecoration: 'none' }}
              >
                Official Website ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function MarathonBrowser({ customMarathons, onSelect, selectedId }: Props) {
  const [filter, setFilter] = useState<'all' | 'world-major' | 'custom'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const allMarathons = [...WORLD_MAJOR_MARATHONS, ...customMarathons];
  const filtered = allMarathons.filter((m) => {
    if (filter === 'world-major' && !m.isWorldMajor) return false;
    if (filter === 'custom' && m.category !== 'custom') return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        m.name.toLowerCase().includes(q) ||
        m.city.toLowerCase().includes(q) ||
        m.country.toLowerCase().includes(q)
      );
    }
    return true;
  }).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div>
      {/* Filters */}
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          {(['all', 'world-major', 'custom'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn ${filter === f ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setFilter(f)}
              style={{ fontSize: 'var(--text-sm)', padding: '0.4rem 0.75rem' }}
            >
              {f === 'all' ? 'All Races' : f === 'world-major' ? '⭐ World Majors' : 'Custom'}
            </button>
          ))}
        </div>
        <input
          type="text"
          placeholder="Search by name, city, or country…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            flex: 1, minWidth: 200, padding: '0.5rem 0.75rem',
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
            background: 'var(--bg)', color: 'var(--text)', fontSize: 'var(--text-sm)',
          }}
        />
      </div>

      {/* Marathon list */}
      {filtered.length === 0 && (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <p>No marathons match your filters.</p>
        </div>
      )}
      {filtered.map((m) => (
        <MarathonCard
          key={m.id}
          marathon={m}
          isSelected={selectedId === m.id}
          onSelect={() => onSelect(m)}
        />
      ))}
    </div>
  );
}
