import { useState } from 'react';
import ElevationChart from './ElevationChart';
import { buildRaceStrategy, formatPace, formatTimeSec } from '../services/raceStrategy';
import type { MarathonRace, RaceStrategy, PacingStrategy } from '../types/raceStrategy';

interface Props {
  marathon: MarathonRace;
  existingStrategies: RaceStrategy[];
  onStrategyCreated: (strategy: RaceStrategy) => void;
  onBack: () => void;
}

const PACING_STRATEGIES: { value: PacingStrategy; label: string; description: string }[] = [
  { value: 'negative-split', label: 'Negative Split', description: 'Start conservative, finish strong. Recommended for experienced runners.' },
  { value: 'even-split', label: 'Even Split', description: 'Maintain consistent pace throughout. Adjusted only for elevation.' },
  { value: 'effort-based', label: 'Effort-Based', description: 'Run by perceived effort — even effort, not even pace. Includes fatigue modeling.' },
  { value: 'positive-split', label: 'Positive Split', description: 'Faster first half. Realistic for first-timers. Not recommended for PRs.' },
];

function timeToSeconds(h: number, m: number, s: number): number {
  return h * 3600 + m * 60 + s;
}

export default function StrategyBuilder({ marathon, existingStrategies, onStrategyCreated, onBack }: Props) {
  const [hours, setHours] = useState(3);
  const [minutes, setMinutes] = useState(45);
  const [seconds, setSeconds] = useState(0);
  const [pacingStrategy, setPacingStrategy] = useState<PacingStrategy>('negative-split');
  const [strategyName, setStrategyName] = useState('');
  const [builtStrategy, setBuiltStrategy] = useState<RaceStrategy | null>(null);
  const [highlightMile, setHighlightMile] = useState<number | undefined>(undefined);
  const [showNutrition, setShowNutrition] = useState(false);
  const [viewingExisting, setViewingExisting] = useState<RaceStrategy | null>(null);

  const handleBuild = () => {
    const targetTime = timeToSeconds(hours, minutes, seconds);
    if (targetTime < 7200) return; // minimum 2 hours
    const strategy = buildRaceStrategy(marathon.id, targetTime, pacingStrategy, strategyName);
    if (strategy) {
      setBuiltStrategy(strategy);
      onStrategyCreated(strategy);
    }
  };

  const displayStrategy = viewingExisting ?? builtStrategy;

  return (
    <div>
      {/* Back button and header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1rem' }}>
        <button type="button" className="btn btn-secondary" onClick={onBack} style={{ fontSize: 'var(--text-sm)' }}>
          ← Back to Races
        </button>
        <div>
          <h2 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)' }}>
            {marathon.name}
          </h2>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            {marathon.city}, {marathon.country} · {marathon.date}
          </div>
        </div>
      </div>

      {/* Existing strategies */}
      {existingStrategies.length > 0 && (
        <div className="card">
          <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            Your Saved Strategies
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {existingStrategies.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`btn ${viewingExisting?.id === s.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewingExisting(viewingExisting?.id === s.id ? null : s)}
                style={{ fontSize: 'var(--text-sm)' }}
              >
                {s.targetTimeFormatted} — {s.pacingStrategy.replace('-', ' ')}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Strategy Builder Form */}
      <div className="card" style={{
        background: 'linear-gradient(135deg, rgba(212,165,55,0.06) 0%, var(--bg-card) 100%)',
        position: 'relative', overflow: 'hidden',
      }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--apollo-gold-dark), var(--apollo-gold), var(--apollo-gold-dark), transparent)' }} />

        <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--apollo-gold)', marginBottom: '0.5rem' }}>
          Build Your Race Strategy
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
          {/* Target time */}
          <div>
            <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem' }}>
              Target Finish Time
            </label>
            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
              <input
                type="number" min={2} max={8} value={hours}
                onChange={(e) => setHours(Number(e.target.value))}
                style={{ width: 55, padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', textAlign: 'center' }}
              />
              <span style={{ color: 'var(--text-muted)' }}>h</span>
              <input
                type="number" min={0} max={59} value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                style={{ width: 55, padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', textAlign: 'center' }}
              />
              <span style={{ color: 'var(--text-muted)' }}>m</span>
              <input
                type="number" min={0} max={59} value={seconds}
                onChange={(e) => setSeconds(Number(e.target.value))}
                style={{ width: 55, padding: '0.5rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', textAlign: 'center' }}
              />
              <span style={{ color: 'var(--text-muted)' }}>s</span>
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
              Avg pace: {formatPace(Math.round(timeToSeconds(hours, minutes, seconds) / 26.2))}/mi
            </div>
          </div>

          {/* Strategy name */}
          <div>
            <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', display: 'block', marginBottom: '0.35rem' }}>
              Strategy Name (optional)
            </label>
            <input
              type="text"
              value={strategyName}
              onChange={(e) => setStrategyName(e.target.value)}
              placeholder={`${marathon.name} — ${formatTimeSec(timeToSeconds(hours, minutes, seconds))} Plan`}
              style={{
                width: '100%', padding: '0.5rem', borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                fontSize: 'var(--text-sm)',
              }}
            />
          </div>
        </div>

        {/* Pacing strategy selector */}
        <div style={{ marginTop: '1rem' }}>
          <label style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', display: 'block', marginBottom: '0.5rem' }}>
            Pacing Strategy
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem' }}>
            {PACING_STRATEGIES.map((ps) => (
              <button
                key={ps.value}
                type="button"
                onClick={() => setPacingStrategy(ps.value)}
                style={{
                  textAlign: 'left', padding: '0.75rem', borderRadius: 'var(--radius-md)',
                  border: pacingStrategy === ps.value ? '2px solid var(--apollo-gold)' : '1px solid var(--border)',
                  background: pacingStrategy === ps.value ? 'var(--apollo-gold-dim)' : 'var(--bg)',
                  color: 'var(--text)', cursor: 'pointer', transition: 'all 0.15s',
                }}
              >
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>
                  {ps.label}
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '0.2rem', lineHeight: 1.4 }}>
                  {ps.description}
                </div>
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={handleBuild}
          style={{ marginTop: '1rem' }}
        >
          Build Race Strategy
        </button>
      </div>

      {/* Built Strategy Display */}
      {displayStrategy && (
        <div style={{ marginTop: '0.5rem' }}>
          {/* Summary header */}
          <div className="card" style={{
            background: 'linear-gradient(135deg, rgba(212,165,55,0.08) 0%, var(--bg-card) 100%)',
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--apollo-gold-dark), var(--apollo-gold), var(--apollo-gold-dark), transparent)' }} />
            <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--apollo-gold)', marginBottom: '0.25rem' }}>
              Your Race Plan
            </div>
            <h3 style={{ margin: '0 0 0.75rem', fontSize: 'var(--text-lg)' }}>{displayStrategy.name}</h3>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '0.75rem' }}>
              {[
                { label: 'Target Time', value: displayStrategy.targetTimeFormatted, gold: true },
                { label: 'Avg Pace', value: formatPace(displayStrategy.avgPaceSec) + '/mi' },
                { label: 'First Half', value: formatTimeSec(displayStrategy.firstHalfSec) },
                { label: 'Second Half', value: formatTimeSec(displayStrategy.secondHalfSec) },
                {
                  label: 'Split Diff',
                  value: (() => {
                    const diff = displayStrategy.secondHalfSec - displayStrategy.firstHalfSec;
                    const prefix = diff > 0 ? '+' : '';
                    return `${prefix}${formatTimeSec(Math.abs(diff))}`;
                  })(),
                },
                { label: 'Strategy', value: displayStrategy.pacingStrategy.replace('-', ' ') },
              ].map(({ label, value, gold }) => (
                <div key={label} style={{
                  background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
                  padding: '0.6rem 0.75rem', textAlign: 'center',
                }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontFamily: 'var(--font-display)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {label}
                  </div>
                  <div style={{
                    fontSize: gold ? 'var(--text-lg)' : 'var(--text-md)',
                    color: gold ? 'var(--apollo-gold)' : 'var(--text)',
                    fontWeight: 700, fontFamily: 'var(--font-display)', marginTop: '0.15rem',
                  }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Elevation with pace overlay */}
          <div className="card">
            <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Course Profile with Your Pace Plan
            </div>
            <div style={{ background: 'var(--bg)', borderRadius: 'var(--radius-md)', padding: '0.5rem', border: '1px solid var(--border-subtle)' }}>
              <ElevationChart
                points={marathon.course.elevationPoints}
                totalDistanceMi={marathon.distanceMi}
                highlightMile={highlightMile}
              />
            </div>
          </div>

          {/* Toggle: Pace Table vs Nutrition */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <button
              type="button"
              className={`btn ${!showNutrition ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setShowNutrition(false)}
              style={{ fontSize: 'var(--text-sm)' }}
            >
              Mile-by-Mile Pacing
            </button>
            <button
              type="button"
              className={`btn ${showNutrition ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setShowNutrition(true)}
              style={{ fontSize: 'var(--text-sm)' }}
            >
              Nutrition Plan
            </button>
          </div>

          {/* Pace Table */}
          {!showNutrition && (
            <div className="card" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border)' }}>
                    <th style={thStyle}>Mile</th>
                    <th style={thStyle}>Target Pace</th>
                    <th style={thStyle}>Cumulative</th>
                    <th style={thStyle}>Elevation</th>
                    <th style={{ ...thStyle, textAlign: 'left' }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {displayStrategy.milePaces.map((mp, i) => {
                    const isHalf = mp.mile === 13 || mp.mile === 14;
                    const isHill = Math.abs(mp.elevationChangeFt) > 20;
                    return (
                      <tr
                        key={i}
                        onMouseEnter={() => setHighlightMile(mp.mile)}
                        onMouseLeave={() => setHighlightMile(undefined)}
                        style={{
                          borderBottom: '1px solid var(--border-subtle)',
                          background: isHalf ? 'rgba(212,165,55,0.04)' : undefined,
                          transition: 'background 0.15s',
                          cursor: 'pointer',
                        }}
                      >
                        <td style={tdStyle}>
                          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                            {mp.mile}
                          </span>
                          {mp.mile === 13 && (
                            <span style={{ fontSize: '0.68rem', color: 'var(--apollo-gold)', marginLeft: '0.35rem' }}>
                              Half
                            </span>
                          )}
                        </td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--apollo-gold)' }}>
                          {mp.targetPaceFormatted}
                        </td>
                        <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                          {mp.cumulativeTimeFormatted}
                        </td>
                        <td style={tdStyle}>
                          {mp.elevationChangeFt !== 0 && (
                            <span style={{
                              color: mp.elevationChangeFt > 0 ? 'var(--color-error)' : 'var(--color-success)',
                              fontWeight: isHill ? 600 : 400,
                            }}>
                              {mp.elevationChangeFt > 0 ? '↑' : '↓'}{Math.abs(mp.elevationChangeFt)}ft
                            </span>
                          )}
                          {mp.elevationChangeFt === 0 && (
                            <span style={{ color: 'var(--text-muted)' }}>—</span>
                          )}
                        </td>
                        <td style={{ ...tdStyle, textAlign: 'left', color: 'var(--text-secondary)', fontSize: 'var(--text-xs)' }}>
                          {mp.notes}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Nutrition Plan */}
          {showNutrition && (
            <div className="card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {displayStrategy.nutritionPlan.map((np, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'center', gap: '1rem',
                    padding: '0.6rem 0.75rem', background: 'var(--bg-surface)',
                    borderRadius: 'var(--radius-md)',
                    borderLeft: `3px solid ${np.item.includes('Gel') || np.item.includes('gel') ? 'var(--apollo-orange)' : 'var(--apollo-teal)'}`,
                  }}>
                    <div style={{
                      fontFamily: 'var(--font-mono)', fontWeight: 700,
                      color: 'var(--apollo-gold)', minWidth: '3.5rem',
                    }}>
                      {np.mile === 0 ? 'Pre' : `Mi ${np.mile}`}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{np.item}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{np.notes}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '0.6rem 0.5rem',
  textAlign: 'center',
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  fontSize: '0.72rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-muted)',
};

const tdStyle: React.CSSProperties = {
  padding: '0.5rem',
  textAlign: 'center',
};
