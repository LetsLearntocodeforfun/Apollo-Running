import { useState, useEffect, useId, useCallback, type CSSProperties, type FormEvent } from 'react';
import {
  SHOE_BRANDS,
  SHOE_ROLES,
  SHOE_ROLE_LABELS,
  ShoeValidationError,
  addShoe,
  retireShoe,
  reactivateShoe,
  deleteShoe,
  setDefaultShoe,
  getShoesWithStats,
  getUnassignedRuns,
  assignUnassignedRunsToShoe,
  onShoesChanged,
  formatShoeDistance,
  unitDistanceToMiles,
  defaultMaxDistanceForUnit,
  type ShoeRole,
  type ShoeWithStats,
} from '../services/shoeTracker';
import { onActivitiesUpdated } from '../services/activitySource';
import { getDistanceUnit, unitLabel } from '../services/unitPreferences';
import { ConfirmDialog } from './ui';

export interface ShoeGaragePanelProps {
  /** Optional status callback to surface short confirmations in the page header. */
  onNotice?: (message: string) => void;
}

const INPUT_STYLE: CSSProperties = {
  width: '100%',
  padding: '0.45rem 0.65rem',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border-input)',
  background: 'var(--bg-surface)',
  color: 'var(--text)',
  fontSize: 'var(--text-sm)',
};

const LABEL_STYLE: CSSProperties = {
  display: 'block',
  fontSize: '0.72rem',
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--text-secondary)',
  marginBottom: '0.25rem',
};

const ACTION_BTN_STYLE: CSSProperties = {
  fontSize: '0.75rem',
  padding: '0.32rem 0.65rem',
  minHeight: 30,
};

function wearBarColor(wearPct: number): string {
  if (wearPct >= 100) return 'var(--color-error)';
  if (wearPct >= 80) return 'var(--apollo-gold)';
  return 'var(--apollo-teal)';
}

export default function ShoeGaragePanel({ onNotice }: ShoeGaragePanelProps) {
  const unit = getDistanceUnit();
  const uLabel = unitLabel(unit);

  const [expanded, setExpanded] = useState(false);
  const [shoes, setShoes] = useState<ShoeWithStats[]>(() => getShoesWithStats());
  const [unassignedCount, setUnassignedCount] = useState<number>(() => getUnassignedRuns().length);

  // Add Shoe form state
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [nickname, setNickname] = useState('');
  const [role, setRole] = useState<ShoeRole>('daily');
  const [priorDist, setPriorDist] = useState('0');
  const [maxDist, setMaxDist] = useState(() => String(defaultMaxDistanceForUnit(unit)));
  const [makeDefault, setMakeDefault] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [shoePendingDelete, setShoePendingDelete] = useState<ShoeWithStats | null>(null);

  const panelId = useId();
  const brandId = useId();
  const brandListId = useId();
  const modelId = useId();
  const nicknameId = useId();
  const roleId = useId();
  const priorId = useId();
  const maxId = useId();
  const defaultCheckId = useId();

  const refresh = useCallback(() => {
    setShoes(getShoesWithStats());
    setUnassignedCount(getUnassignedRuns().length);
  }, []);

  useEffect(() => {
    const unsubShoes = onShoesChanged(refresh);
    const unsubActs = onActivitiesUpdated(refresh);
    return () => {
      unsubShoes();
      unsubActs();
    };
  }, [refresh]);

  const activeShoes = shoes.filter((s) => s.status === 'active');
  const retiredShoes = shoes.filter((s) => s.status === 'retired');
  const defaultShoe = activeShoes.find((s) => s.isDefault) ?? null;

  // Highest-wear active shoe at ≥ 80% life (or race-day projection warning)
  const alertShoes = activeShoes.filter(
    (s) => s.wearPct >= 80 || s.degradation.urgency === 'warning' || s.degradation.urgency === 'critical',
  );
  const highestWearAlert = alertShoes.length > 0 ? [...alertShoes].sort((a, b) => b.wearPct - a.wearPct)[0] : null;

  const handleAddShoe = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const parsedPrior = priorDist.trim() === '' ? 0 : Number(priorDist);
    const parsedMax = maxDist.trim() === '' ? defaultMaxDistanceForUnit(unit) : Number(maxDist);

    if (!Number.isFinite(parsedPrior) || parsedPrior < 0) {
      setFormError(`Prior distance (${uLabel}) must be 0 or greater.`);
      return;
    }
    if (!Number.isFinite(parsedMax) || parsedMax <= 0) {
      setFormError(`Max lifespan (${uLabel}) must be greater than 0.`);
      return;
    }

    try {
      const created = addShoe({
        brand,
        model,
        nickname: nickname.trim() || undefined,
        role,
        initialMiles: unitDistanceToMiles(parsedPrior, unit),
        maxMiles: unitDistanceToMiles(parsedMax, unit),
        isDefault: activeShoes.length === 0 ? true : makeDefault,
      });
      setBrand('');
      setModel('');
      setNickname('');
      setRole('daily');
      setPriorDist('0');
      setMaxDist(String(defaultMaxDistanceForUnit(unit)));
      setMakeDefault(false);
      onNotice?.(`Added ${created.name} to your shoe rotation.`);
    } catch (err) {
      if (err instanceof ShoeValidationError) {
        setFormError(err.message);
      } else {
        setFormError('Could not save shoe. Check the fields and try again.');
      }
    }
  };

  const handleAssignUnassigned = (shoe: ShoeWithStats) => {
    const count = assignUnassignedRunsToShoe(shoe.id);
    if (count > 0) {
      onNotice?.(`Assigned ${count} unassigned ${count === 1 ? 'run' : 'runs'} to ${shoe.name}.`);
    } else {
      onNotice?.('No unassigned runs to assign.');
    }
  };

  return (
    <section
      aria-label="Shoe rotation and gear"
      className="card"
      style={{
        marginBottom: '1.25rem',
        padding: '0.9rem 1.25rem',
        borderLeft: highestWearAlert
          ? `3px solid ${highestWearAlert.wearPct >= 100 ? 'var(--color-error)' : 'var(--apollo-gold)'}`
          : undefined,
      }}
    >
      {/* Compact summary bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0, flex: '1 1 240px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', flexWrap: 'wrap' }}>
            <h2
              style={{
                margin: 0,
                fontSize: '0.95rem',
                fontWeight: 700,
                fontFamily: 'var(--font-display)',
                color: 'var(--text)',
              }}
            >
              Shoe rotation &amp; gear
            </h2>

            {highestWearAlert && (
              <span
                style={{
                  fontSize: '0.7rem',
                  fontFamily: 'var(--font-display)',
                  fontWeight: 600,
                  padding: '0.12rem 0.55rem',
                  borderRadius: 'var(--radius-full)',
                  background: highestWearAlert.wearPct >= 100 ? 'var(--color-error-dim)' : 'var(--apollo-gold-dim)',
                  color: highestWearAlert.wearPct >= 100 ? 'var(--color-error-text)' : 'var(--apollo-gold)',
                  border: `1px solid ${highestWearAlert.wearPct >= 100 ? 'var(--color-error)' : 'var(--apollo-gold)'}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {highestWearAlert.wearPct >= 100 ? 'Retire soon' : 'Wear alert'}: {highestWearAlert.name} (
                {highestWearAlert.wearPct}%)
              </span>
            )}
          </div>

          <div
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)',
              marginTop: '0.2rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            {activeShoes.length === 0 ? (
              <span>Track mileage and cushion lifespan across your running shoes.</span>
            ) : (
              <>
                <span>
                  {activeShoes.length} active {activeShoes.length === 1 ? 'shoe' : 'shoes'}
                  {defaultShoe
                    ? ` · Default: ${defaultShoe.name} (${formatShoeDistance(defaultShoe.totalMiles, unit, 1)})`
                    : ''}
                </span>
                {!expanded && activeShoes.length > 1 && (
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.76rem' }}>
                    ·{' '}
                    {activeShoes
                      .filter((s) => !s.isDefault)
                      .map((s) => `${s.name} (${formatShoeDistance(s.totalMiles, unit, 0)})`)
                      .join(', ')}
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-secondary"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((o) => !o)}
          style={{ fontSize: 'var(--text-sm)', minHeight: 34, whiteSpace: 'nowrap' }}
        >
          <span aria-hidden="true">{expanded ? '▾ ' : '▸ '}</span>Manage shoes
        </button>
      </div>

      {/* Collapsible garage body */}
      <div id={panelId} hidden={!expanded} style={{ marginTop: expanded ? '1rem' : 0 }}>
        {/* Active shoes grid */}
        {activeShoes.length > 0 && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(275px, 1fr))',
              gap: '0.85rem',
              marginBottom: '1.1rem',
            }}
          >
            {activeShoes.map((shoe) => {
              const barColor = wearBarColor(shoe.wearPct);
              const clampedPct = Number.isFinite(shoe.wearPct) ? Math.min(100, Math.max(0, shoe.wearPct)) : 0;
              // The bar tops out at 100; screen readers still hear the real wear and distance.
              const wearText = `${shoe.wearPct}% worn: ${formatShoeDistance(shoe.totalMiles, unit, 1)} of ${formatShoeDistance(shoe.maxMiles, unit, 0)}`;
              const brandModel = `${shoe.brand} ${shoe.model}`.trim();
              const showSubtitle = brandModel && brandModel !== shoe.name;
              const isOver = shoe.wearPct >= 100;

              return (
                <div
                  key={shoe.id}
                  style={{
                    background: 'var(--bg-surface)',
                    border: `1px solid ${isOver ? 'var(--color-error)' : 'var(--border)'}`,
                    borderRadius: 'var(--radius-md)',
                    padding: '0.85rem 1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    gap: '0.65rem',
                  }}
                >
                  <div>
                    {/* Card header: Name + Badges */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'flex-start',
                        gap: '0.5rem',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <strong
                          style={{
                            fontFamily: 'var(--font-display)',
                            fontSize: 'var(--text-base)',
                            color: 'var(--text)',
                            display: 'block',
                          }}
                        >
                          {shoe.name}
                        </strong>
                        {showSubtitle && (
                          <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>{brandModel}</span>
                        )}
                      </div>
                      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {shoe.isDefault && (
                          <span
                            style={{
                              fontSize: '0.66rem',
                              fontFamily: 'var(--font-display)',
                              fontWeight: 700,
                              padding: '0.08rem 0.45rem',
                              borderRadius: 'var(--radius-full)',
                              background: 'var(--apollo-gold-dim)',
                              color: 'var(--apollo-gold)',
                              border: '1px solid var(--apollo-gold)',
                            }}
                          >
                            Default
                          </span>
                        )}
                        {shoe.role && (
                          <span
                            style={{
                              fontSize: '0.66rem',
                              fontFamily: 'var(--font-display)',
                              fontWeight: 600,
                              padding: '0.08rem 0.45rem',
                              borderRadius: 'var(--radius-full)',
                              background: 'var(--apollo-teal-dim)',
                              color: 'var(--apollo-teal)',
                            }}
                          >
                            {SHOE_ROLE_LABELS[shoe.role]}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Distance readout */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'baseline',
                        marginTop: '0.6rem',
                        fontSize: 'var(--text-sm)',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: 'var(--font-display)',
                          fontWeight: 700,
                          color: isOver
                            ? 'var(--color-error-text)'
                            : shoe.wearPct >= 80
                              ? 'var(--apollo-gold)'
                              : 'var(--text)',
                        }}
                      >
                        {formatShoeDistance(shoe.totalMiles, unit, 1)}{' '}
                        <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>
                          / {formatShoeDistance(shoe.maxMiles, unit, 0)}
                        </span>
                      </span>
                      <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                        {shoe.wearPct}%
                      </span>
                    </div>

                    {/* Visual wear progress bar */}
                    <div
                      role="progressbar"
                      aria-label={`${shoe.name} wear`}
                      aria-valuenow={clampedPct}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuetext={wearText}
                      style={{
                        height: 7,
                        borderRadius: 'var(--radius-full)',
                        background: isOver ? 'var(--color-error-dim)' : 'var(--bg-elevated)',
                        overflow: 'hidden',
                        marginTop: '0.35rem',
                      }}
                    >
                      <div
                        style={{
                          width: `${clampedPct}%`,
                          height: '100%',
                          background: barColor,
                          borderRadius: 'var(--radius-full)',
                          transition: 'width 0.25s ease',
                        }}
                      />
                    </div>

                    {/* Logged vs Remaining + Run Count */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '0.35rem',
                        marginTop: '0.45rem',
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                      }}
                    >
                      <span>
                        {shoe.runCount} {shoe.runCount === 1 ? 'run' : 'runs'} (
                        {formatShoeDistance(shoe.loggedMiles, unit, 1)} logged
                        {shoe.initialMiles > 0 ? ` + ${formatShoeDistance(shoe.initialMiles, unit, 1)} prior` : ''})
                      </span>
                      <span style={{ color: isOver ? 'var(--color-error-text)' : 'var(--text-secondary)' }}>
                        {isOver
                          ? `${formatShoeDistance(shoe.totalMiles - shoe.maxMiles, unit, 1)} over limit`
                          : `${formatShoeDistance(shoe.remainingMiles, unit, 1)} remaining`}
                      </span>
                    </div>

                    {/* Alert message when approaching/exceeding retirement or race-day projection */}
                    {(shoe.degradation.urgency === 'warning' || shoe.degradation.urgency === 'critical') && (
                      <div
                        style={{
                          marginTop: '0.5rem',
                          fontSize: '0.74rem',
                          lineHeight: 1.4,
                          color:
                            shoe.degradation.urgency === 'critical' ? 'var(--color-error-text)' : 'var(--apollo-gold)',
                        }}
                      >
                        {shoe.degradation.statusMessage}
                      </div>
                    )}
                  </div>

                  {/* Card actions */}
                  <div
                    style={{
                      display: 'flex',
                      gap: '0.4rem',
                      flexWrap: 'wrap',
                      paddingTop: '0.45rem',
                      borderTop: '1px solid var(--border-subtle)',
                    }}
                  >
                    {!shoe.isDefault && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={ACTION_BTN_STYLE}
                        onClick={() => {
                          setDefaultShoe(shoe.id);
                          onNotice?.(`${shoe.name} is now your default shoe.`);
                        }}
                      >
                        Set as default
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={ACTION_BTN_STYLE}
                      disabled={unassignedCount === 0}
                      title={
                        unassignedCount > 0
                          ? `Assign ${unassignedCount} unassigned ${unassignedCount === 1 ? 'run' : 'runs'} to ${shoe.name}`
                          : 'All visible runs already have a shoe assigned'
                      }
                      onClick={() => handleAssignUnassigned(shoe)}
                    >
                      Assign unassigned runs{unassignedCount > 0 ? ` (${unassignedCount})` : ''}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={ACTION_BTN_STYLE}
                      onClick={() => {
                        retireShoe(shoe.id);
                        onNotice?.(`Retired ${shoe.name}.`);
                      }}
                    >
                      Retire
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ ...ACTION_BTN_STYLE, color: 'var(--color-error-text)' }}
                      onClick={() => setShoePendingDelete(shoe)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add Shoe Form */}
        <form
          onSubmit={handleAddShoe}
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '0.9rem 1rem',
          }}
        >
          <div
            style={{
              fontSize: '0.78rem',
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--apollo-gold)',
              marginBottom: '0.65rem',
            }}
          >
            + Add a shoe
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
              gap: '0.65rem',
            }}
          >
            <div>
              <label htmlFor={brandId} style={LABEL_STYLE}>
                Brand
              </label>
              <input
                id={brandId}
                list={brandListId}
                type="text"
                value={brand}
                onChange={(e) => setBrand(e.target.value)}
                placeholder="e.g. Brooks, Nike"
                style={INPUT_STYLE}
              />
              <datalist id={brandListId}>
                {SHOE_BRANDS.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </div>

            <div>
              <label htmlFor={modelId} style={LABEL_STYLE}>
                Model
              </label>
              <input
                id={modelId}
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. Ghost 16"
                style={INPUT_STYLE}
              />
            </div>

            <div>
              <label htmlFor={nicknameId} style={LABEL_STYLE}>
                Nickname (optional)
              </label>
              <input
                id={nicknameId}
                type="text"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                placeholder="e.g. Blue Ghosts"
                style={INPUT_STYLE}
              />
            </div>

            <div>
              <label htmlFor={roleId} style={LABEL_STYLE}>
                Role
              </label>
              <select
                id={roleId}
                value={role}
                onChange={(e) => setRole(e.target.value as ShoeRole)}
                style={INPUT_STYLE}
              >
                {SHOE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {SHOE_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={priorId} style={LABEL_STYLE}>
                Prior distance ({uLabel})
              </label>
              <input
                id={priorId}
                type="number"
                min="0"
                step="0.1"
                value={priorDist}
                onChange={(e) => setPriorDist(e.target.value)}
                style={INPUT_STYLE}
              />
            </div>

            <div>
              <label htmlFor={maxId} style={LABEL_STYLE}>
                Max lifespan ({uLabel})
              </label>
              <input
                id={maxId}
                type="number"
                min="1"
                step="10"
                value={maxDist}
                onChange={(e) => setMaxDist(e.target.value)}
                style={INPUT_STYLE}
              />
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '0.75rem',
              flexWrap: 'wrap',
              marginTop: '0.75rem',
            }}
          >
            <label
              htmlFor={defaultCheckId}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.45rem',
                fontSize: 'var(--text-sm)',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
              }}
            >
              <input
                id={defaultCheckId}
                type="checkbox"
                checked={activeShoes.length === 0 ? true : makeDefault}
                disabled={activeShoes.length === 0}
                onChange={(e) => setMakeDefault(e.target.checked)}
              />
              Default shoe (auto-assigns new runs from today)
            </label>

            <button
              type="submit"
              className="btn btn-primary"
              style={{ fontSize: 'var(--text-sm)', padding: '0.45rem 1rem' }}
            >
              Add shoe
            </button>
          </div>

          {formError && (
            <div
              role="alert"
              style={{
                marginTop: '0.5rem',
                fontSize: 'var(--text-sm)',
                color: 'var(--color-error-text)',
              }}
            >
              {formError}
            </div>
          )}
        </form>

        {/* Retired shoes section */}
        {retiredShoes.length > 0 && (
          <div style={{ marginTop: '1rem' }}>
            <div
              style={{
                fontSize: '0.74rem',
                fontFamily: 'var(--font-display)',
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--text-muted)',
                marginBottom: '0.45rem',
              }}
            >
              Retired shoes ({retiredShoes.length})
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.45rem' }}>
              {retiredShoes.map((shoe) => (
                <li
                  key={shoe.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                    padding: '0.55rem 0.8rem',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-surface)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: 'var(--text-sm)',
                  }}
                >
                  <div>
                    <strong style={{ color: 'var(--text-secondary)' }}>{shoe.name}</strong>
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                      {formatShoeDistance(shoe.totalMiles, unit, 1)} · {shoe.runCount}{' '}
                      {shoe.runCount === 1 ? 'run' : 'runs'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={ACTION_BTN_STYLE}
                      onClick={() => {
                        reactivateShoe(shoe.id);
                        onNotice?.(`Reactivated ${shoe.name}.`);
                      }}
                    >
                      Reactivate
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      style={{ ...ACTION_BTN_STYLE, color: 'var(--color-error-text)' }}
                      onClick={() => setShoePendingDelete(shoe)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={shoePendingDelete !== null}
        title="Delete shoe?"
        tone="danger"
        confirmLabel="Delete shoe"
        message={
          shoePendingDelete ? (
            <p>
              Remove &ldquo;{shoePendingDelete.name}&rdquo; from your gear rotation? Your runs stay untouched; any runs
              assigned to this shoe will revert to unassigned/default.
            </p>
          ) : undefined
        }
        onCancel={() => setShoePendingDelete(null)}
        onConfirm={() => {
          if (shoePendingDelete) {
            const deletedName = shoePendingDelete.name;
            deleteShoe(shoePendingDelete.id);
            setShoePendingDelete(null);
            onNotice?.(`Deleted ${deletedName}.`);
          }
        }}
      />
    </section>
  );
}
