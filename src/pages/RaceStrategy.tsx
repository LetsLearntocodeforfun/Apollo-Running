import { useState, useCallback } from 'react';
import MarathonBrowser from '../components/MarathonBrowser';
import StrategyBuilder from '../components/StrategyBuilder';
import MarathonImport from '../components/MarathonImport';
import {
  isRaceStrategyEnabled,
  enableRaceStrategy,
  getAllMarathons,
  getStrategiesForMarathon,
  importCustomMarathon,
  removeCustomMarathon,
  getAllStrategies,
  deleteStrategy,
} from '../services/raceStrategy';
import { WORLD_MAJOR_MARATHONS } from '../data/worldMajors';
import type { MarathonRace } from '../types/raceStrategy';

type View = 'browse' | 'strategy' | 'import' | 'my-strategies';

export default function RaceStrategyPage() {
  const [enabled, setEnabled] = useState(isRaceStrategyEnabled);
  const [view, setView] = useState<View>('browse');
  const [selectedMarathon, setSelectedMarathon] = useState<MarathonRace | null>(null);
  const [, forceUpdate] = useState(0);

  const customMarathons = getAllMarathons().filter((m) => m.category === 'custom');
  const allStrategies = getAllStrategies();

  const handleEnable = () => {
    enableRaceStrategy();
    setEnabled(true);
  };

  const handleSelectMarathon = useCallback((marathon: MarathonRace) => {
    setSelectedMarathon(marathon);
    setView('strategy');
  }, []);

  const handleStrategyCreated = useCallback(() => {
    forceUpdate((n) => n + 1);
  }, []);

  const handleImport = useCallback((input: Parameters<typeof importCustomMarathon>[0]) => {
    const marathon = importCustomMarathon(input);
    setSelectedMarathon(marathon);
    setView('strategy');
    forceUpdate((n) => n + 1);
    return marathon;
  }, []);

  const handleDeleteCustom = useCallback((id: string) => {
    removeCustomMarathon(id);
    if (selectedMarathon?.id === id) {
      setSelectedMarathon(null);
      setView('browse');
    }
    forceUpdate((n) => n + 1);
  }, [selectedMarathon]);

  const handleDeleteStrategy = useCallback((id: string) => {
    deleteStrategy(id);
    forceUpdate((n) => n + 1);
  }, []);

  // ── Opt-in Screen ──

  if (!enabled) {
    return (
      <div>
        <h1 className="page-title">Race Strategy</h1>
        <div className="card" style={{
          textAlign: 'center', padding: '3rem 2rem',
          background: 'linear-gradient(135deg, rgba(212,165,55,0.06) 0%, var(--bg-card) 100%)',
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, var(--apollo-gold-dark), var(--apollo-gold), var(--apollo-gold-dark), transparent)' }} />

          <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>🏅</div>
          <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--apollo-gold)', marginBottom: '0.75rem' }}>
            New Feature
          </div>
          <h2 style={{ margin: '0 0 0.75rem', fontFamily: 'var(--font-display)', fontSize: 'var(--text-xl)' }}>
            Race Strategy Planner
          </h2>
          <p style={{ color: 'var(--text-secondary)', maxWidth: 540, margin: '0 auto 1.5rem', lineHeight: 1.6, fontSize: 'var(--text-sm)' }}>
            Plan your dream race with course-specific pacing strategies. Browse all six World Marathon Majors
            with detailed elevation profiles, mile-by-mile pacing, and nutrition planning — or import any
            other marathon and build a strategy for it.
          </p>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '0.75rem', maxWidth: 600, margin: '0 auto 1.5rem', textAlign: 'left',
          }}>
            {[
              { icon: '🌍', title: 'World Majors', desc: 'Boston, London, Berlin, Chicago, NYC, Tokyo — full course data' },
              { icon: '📈', title: 'Elevation Profiles', desc: 'See every hill, descent, and flat before race day' },
              { icon: '⏱️', title: 'Mile-by-Mile Pacing', desc: 'Grade-adjusted pacing with multiple strategy options' },
              { icon: '🥤', title: 'Nutrition Planning', desc: 'Gel timing, hydration, and aid station mapping' },
              { icon: '📋', title: 'Import Any Race', desc: 'Add any marathon and build a custom strategy' },
              { icon: '💡', title: 'Race Tips', desc: 'Course-specific advice from experienced runners' },
            ].map(({ icon, title, desc }) => (
              <div key={title} style={{
                background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)',
                padding: '0.75rem', border: '1px solid var(--border-subtle)',
              }}>
                <div style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>{icon}</div>
                <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--text-sm)' }}>{title}</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '0.15rem', lineHeight: 1.4 }}>{desc}</div>
              </div>
            ))}
          </div>

          <button type="button" className="btn btn-primary" onClick={handleEnable} style={{ fontSize: 'var(--text-md)', padding: '0.75rem 2rem' }}>
            Enable Race Strategy
          </button>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)', marginTop: '0.75rem' }}>
            You can disable this feature anytime from Settings.
          </p>
        </div>
      </div>
    );
  }

  // ── Enabled: Main Feature ──

  return (
    <div>
      <h1 className="page-title">Race Strategy</h1>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        {([
          { key: 'browse' as View, label: '🌍 Browse Races', count: WORLD_MAJOR_MARATHONS.length + customMarathons.length },
          { key: 'my-strategies' as View, label: '📋 My Strategies', count: allStrategies.length },
          { key: 'import' as View, label: '➕ Import Race' },
        ]).map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            className={`btn ${view === key ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setView(key); if (key !== 'strategy') setSelectedMarathon(null); }}
            style={{ fontSize: 'var(--text-sm)' }}
          >
            {label}
            {count != null && (
              <span style={{
                marginLeft: '0.4rem', fontSize: '0.68rem',
                background: view === key ? 'rgba(0,0,0,0.15)' : 'var(--apollo-gold-dim)',
                color: view === key ? 'var(--text)' : 'var(--apollo-gold)',
                padding: '0.1rem 0.4rem', borderRadius: 'var(--radius-full)',
                fontWeight: 700,
              }}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Browse view */}
      {view === 'browse' && (
        <MarathonBrowser
          customMarathons={customMarathons}
          onSelect={handleSelectMarathon}
          selectedId={selectedMarathon?.id}
        />
      )}

      {/* Strategy builder view */}
      {view === 'strategy' && selectedMarathon && (
        <StrategyBuilder
          marathon={selectedMarathon}
          existingStrategies={getStrategiesForMarathon(selectedMarathon.id)}
          onStrategyCreated={handleStrategyCreated}
          onBack={() => setView('browse')}
        />
      )}

      {/* Import view */}
      {view === 'import' && (
        <MarathonImport
          onImport={handleImport}
          onCancel={() => setView('browse')}
        />
      )}

      {/* My Strategies view */}
      {view === 'my-strategies' && (
        <div>
          {allStrategies.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
              <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>📋</div>
              <p style={{ color: 'var(--text-muted)' }}>
                No strategies yet. Browse races and build your first race strategy!
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setView('browse')} style={{ marginTop: '0.5rem' }}>
                Browse Races
              </button>
            </div>
          ) : (
            <div>
              {allStrategies.map((s) => {
                const marathon = getAllMarathons().find((m) => m.id === s.marathonId);
                return (
                  <div key={s.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
                    <div>
                      <h3 style={{ margin: 0, fontSize: 'var(--text-md)' }}>{s.name}</h3>
                      <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginTop: '0.15rem' }}>
                        {s.marathonName} · {s.pacingStrategy.replace('-', ' ')}
                      </div>
                      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.35rem', fontSize: 'var(--text-sm)' }}>
                        <span>
                          <span style={{ color: 'var(--text-muted)' }}>Target: </span>
                          <span style={{ color: 'var(--apollo-gold)', fontWeight: 600, fontFamily: 'var(--font-display)' }}>
                            {s.targetTimeFormatted}
                          </span>
                        </span>
                        <span>
                          <span style={{ color: 'var(--text-muted)' }}>Avg pace: </span>
                          <span style={{ fontFamily: 'var(--font-mono)' }}>
                            {Math.floor(s.avgPaceSec / 60)}:{(s.avgPaceSec % 60).toString().padStart(2, '0')}/mi
                          </span>
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          if (marathon) {
                            setSelectedMarathon(marathon);
                            setView('strategy');
                          }
                        }}
                        style={{ fontSize: 'var(--text-sm)' }}
                      >
                        View
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => handleDeleteStrategy(s.id)}
                        style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Custom marathons management */}
          {customMarathons.length > 0 && (
            <div style={{ marginTop: '1.5rem' }}>
              <div style={{ fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                Custom Imported Races
              </div>
              {customMarathons.map((m) => (
                <div key={m.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 1rem' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{m.name}</span>
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem', fontSize: 'var(--text-sm)' }}>
                      {m.city}, {m.country} · {m.date}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => handleDeleteCustom(m.id)}
                    style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
