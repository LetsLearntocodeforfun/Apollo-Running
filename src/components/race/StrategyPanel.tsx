/**
 * Strategy tab of the Race Day hub (v1.0.6). Replaces the old Race Strategy
 * page: no opt-in gate (RS-14), confirm dialogs for deletes (RS-15), a
 * race-day strategy picker, and the builder / browser / import views.
 * Nothing persists on render; every write is a button action.
 */
import { useState } from 'react';
import MarathonBrowser from '../MarathonBrowser';
import StrategyBuilder, { pacingLabel } from '../StrategyBuilder';
import MarathonImport from '../MarathonImport';
import { ConfirmDialog, EmptyState } from '../ui';
import {
  deleteStrategy,
  formatDurationSec,
  formatPaceForUnit,
  getAllMarathons,
  getAllStrategies,
  getMarathon,
  getRaceDistanceMi,
  getStrategiesForMarathon,
  getStrategyDistanceMi,
  importCustomMarathon,
  removeCustomMarathon,
  type CustomMarathonInput,
} from '../../services/raceStrategy';
import { getMyRace, setMyRace } from '../../services/myRace';
import { getDistanceUnit, paceUnitLabel } from '../../services/unitPreferences';
import { getDefaultGoalSec } from './goal';
import type { RacePanelProps } from './types';
import type { MarathonRace, RaceStrategy } from '../../types/raceStrategy';
import './Strategy.css';

export interface StrategyPanelProps extends RacePanelProps {
  /** Make `race` the athlete's My Race (the hub applies the date rules). */
  onChooseRace?: (race: MarathonRace) => void;
  /** Called after a strategy is saved, deleted or made the race-day strategy. */
  onChanged?: () => void;
}

type View = 'build' | 'mine' | 'browse' | 'import';

const VIEWS: { id: View; label: string }[] = [
  { id: 'build', label: 'Build' },
  { id: 'mine', label: 'My strategies' },
  { id: 'browse', label: 'Browse races' },
  { id: 'import', label: 'Import a race' },
];

interface PendingDelete {
  kind: 'strategy' | 'race';
  id: string;
  label: string;
}

/** Strategy tab: build, save and choose the race-day pacing strategy. */
export default function StrategyPanel({ ctx, onChooseRace, onChanged }: StrategyPanelProps) {
  const [view, setView] = useState<View>('build');
  const [selectedRaceId, setSelectedRaceId] = useState<string | null>(null);
  const [initialStrategyId, setInitialStrategyId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [status, setStatus] = useState('');
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const unit = getDistanceUnit();
  const paceLabel = paceUnitLabel(unit);
  const localRace = selectedRaceId ? getMarathon(selectedRaceId) ?? null : null;
  const race = localRace ?? ctx.race;
  const myRaceId = ctx.race?.id ?? null;
  const activeId = getMyRace().activeStrategyId ?? ctx.strategy?.id ?? null;
  const allStrategies = getAllStrategies();
  const customMarathons = getAllMarathons().filter((m) => m.category === 'custom');

  const changed = (message = '') => {
    setStatus(message);
    bump();
    onChanged?.();
  };

  const openBuilder = (raceId: string, strategyId: string | null = null) => {
    setSelectedRaceId(raceId === ctx.race?.id ? null : raceId);
    setInitialStrategyId(strategyId);
    setView('build');
  };

  const handleSetActive = (strategyId: string) => {
    setMyRace({ activeStrategyId: strategyId });
    changed('Race-day strategy updated.');
  };

  const handleImport = (input: CustomMarathonInput): MarathonRace => {
    const m = importCustomMarathon(input); // throws RangeError with a message when invalid
    openBuilder(m.id);
    changed(`${m.name} added.`);
    return m;
  };

  const confirmDelete = () => {
    if (!pending) return;
    const current = getMyRace();
    if (pending.kind === 'strategy') {
      deleteStrategy(pending.id);
      if (current.activeStrategyId === pending.id) setMyRace({ activeStrategyId: undefined });
      if (initialStrategyId === pending.id) setInitialStrategyId(null);
      changed('Strategy deleted.');
    } else {
      const removedStrategyIds = new Set(getStrategiesForMarathon(pending.id).map((s) => s.id));
      removeCustomMarathon(pending.id);
      if (current.raceId === pending.id) setMyRace({ raceId: undefined, activeStrategyId: undefined });
      else if (current.activeStrategyId && removedStrategyIds.has(current.activeStrategyId)) setMyRace({ activeStrategyId: undefined });
      if (selectedRaceId === pending.id) setSelectedRaceId(null);
      changed('Race removed.');
    }
    setPending(null);
  };

  const defaultGoal = race ? getDefaultGoalSec(getRaceDistanceMi(race)) : 0;

  return (
    <div className="rs-panel">
      <h2 className="rs-panel-title">Race strategy</h2>
      <div className="rs-chip-row rs-views" role="group" aria-label="Strategy views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`btn ${view === v.id ? 'btn-primary' : 'btn-secondary'} rs-btn`}
            aria-pressed={view === v.id}
            onClick={() => setView(v.id)}
          >
            {v.label}
            {v.id === 'mine' && allStrategies.length > 0 ? ` (${allStrategies.length})` : ''}
          </button>
        ))}
      </div>
      <p role="status" className="rs-status">{status}</p>

      {view === 'build' && (
        race ? (
          <>
            {localRace && onChooseRace && localRace.id !== myRaceId && (
              <div className="rs-callout">
                <p>You're building a strategy for {localRace.name}, which isn't your race.</p>
                <div className="rs-actions">
                  <button type="button" className="btn btn-secondary rs-btn" onClick={() => { onChooseRace(localRace); setSelectedRaceId(null); }}>
                    Set as my race
                  </button>
                  {ctx.race && (
                    <button type="button" className="btn btn-ghost rs-btn" onClick={() => { setSelectedRaceId(null); setInitialStrategyId(null); }}>
                      Back to {ctx.race.name}
                    </button>
                  )}
                </div>
              </div>
            )}
            <StrategyBuilder
              key={`${race.id}|${initialStrategyId ?? ''}`}
              marathon={race}
              existingStrategies={getStrategiesForMarathon(race.id)}
              activeStrategyId={activeId}
              defaultGoalSec={defaultGoal}
              initialStrategyId={initialStrategyId}
              onSaved={() => changed('')}
              onSetActive={handleSetActive}
            />
          </>
        ) : (
          <EmptyState
            title="Pick your race"
            action={(
              <div className="rs-actions">
                <button type="button" className="btn btn-primary rs-btn" onClick={() => setView('browse')}>Browse races</button>
                <button type="button" className="btn btn-secondary rs-btn" onClick={() => setView('import')}>Import a race</button>
              </div>
            )}
          >
            Choose one of the World Marathon Majors or add your own race to build a pacing plan.
          </EmptyState>
        )
      )}

      {view === 'mine' && (
        <section aria-label="My strategies">
          {allStrategies.length === 0 ? (
            <EmptyState
              title="No strategies yet"
              action={<button type="button" className="btn btn-primary rs-btn" onClick={() => setView(race ? 'build' : 'browse')}>Build a strategy</button>}
            >
              Build a pacing plan for your race, then save it.
            </EmptyState>
          ) : (
            <ul className="rs-strategy-list">
              {allStrategies.map((s: RaceStrategy) => {
                const r = getMarathon(s.marathonId);
                const dist = getStrategyDistanceMi(s) || 26.2;
                const isActive = activeId === s.id;
                return (
                  <li key={s.id} className={`card rs-strategy-item${isActive ? ' is-active' : ''}`}>
                    <div className="rs-strategy-main">
                      <h3 className="rs-strategy-name">{s.name}</h3>
                      <p className="rs-muted rs-tight">{s.marathonName} · {pacingLabel(s.pacingStrategy)}</p>
                      <p className="rs-tight">
                        Target <strong className="rs-gold">{formatDurationSec(s.targetTimeSec)}</strong>
                        {' · '}Average pace {formatPaceForUnit(s.targetTimeSec / dist, unit)}{paceLabel}
                      </p>
                      {isActive && <p className="rs-badge rs-badge-gold">Race-day strategy</p>}
                      {!r && <p className="rs-help">This race is no longer available.</p>}
                    </div>
                    <div className="rs-actions">
                      <button type="button" className="btn btn-secondary rs-btn" disabled={!r}
                        aria-label={`View ${s.name}`} onClick={() => openBuilder(s.marathonId, s.id)}>
                        View
                      </button>
                      {!isActive && (
                        <button type="button" className="btn btn-secondary rs-btn"
                          aria-label={`Use ${s.name} on race day`} onClick={() => handleSetActive(s.id)}>
                          Use on race day
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost rs-btn"
                        aria-label={`Delete ${s.name}`}
                        onClick={() => setPending({ kind: 'strategy', id: s.id, label: s.name })}>
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {customMarathons.length > 0 && (
            <section className="rs-customs" aria-labelledby="rs-customs-title">
              <h3 id="rs-customs-title" className="rs-eyebrow">Custom races</h3>
              <ul className="rs-strategy-list">
                {customMarathons.map((m) => (
                  <li key={m.id} className="card rs-strategy-item">
                    <div className="rs-strategy-main">
                      <p className="rs-strong rs-tight">{m.name}</p>
                      <p className="rs-muted rs-tight">{[m.city, m.country].filter(Boolean).join(', ')} · {m.date}</p>
                    </div>
                    <div className="rs-actions">
                      <button type="button" className="btn btn-ghost rs-btn" aria-label={`Remove ${m.name}`}
                        onClick={() => setPending({ kind: 'race', id: m.id, label: m.name })}>
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </section>
      )}

      {view === 'browse' && (
        <MarathonBrowser
          customMarathons={customMarathons}
          onSelect={(m) => openBuilder(m.id)}
          selectedId={race?.id}
          onChooseRace={onChooseRace}
          myRaceId={myRaceId}
          today={ctx.today}
        />
      )}

      {view === 'import' && (
        <MarathonImport onImport={handleImport} onCancel={() => setView('build')} />
      )}

      <ConfirmDialog
        open={pending !== null}
        tone="danger"
        title={pending?.kind === 'race' ? 'Remove this race?' : 'Delete this strategy?'}
        message={pending?.kind === 'race'
          ? `${pending.label} and every strategy you saved for it will be removed. This can't be undone.`
          : `${pending?.label ?? 'This strategy'} will be deleted. This can't be undone.`}
        confirmLabel={pending?.kind === 'race' ? 'Remove race' : 'Delete strategy'}
        onConfirm={confirmDelete}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
