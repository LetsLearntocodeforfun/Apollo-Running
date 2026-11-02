/**
 * Plan chooser for the Plan page (v1.0.6): pick a plan, set the race date
 * (race-date-first placement preview) and start it.
 *
 * The selection is *pending* until "Start plan" / "Switch plan" is pressed — the
 * page keeps showing the current plan while the athlete browses, and Cancel
 * simply discards the pending choice (UI review B1). Restarting a plan whose
 * stored progress belongs to another instance asks for confirmation first
 * ("Progress for this plan will be cleared"), using T2a's previewStartPlan.
 *
 * v1.0.9: search matches every word of the query (name, author, coach, tags,
 * category); a block without a race day is placed by start date without touching
 * the "Advanced: choose a start date" choice; imported plans are marked as
 * imported and unverified, the active one can't be removed, and removing another
 * one asks first (its stored progress is removed with it).
 */

import { useId, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  ALL_BUILT_IN_PLANS,
  CUSTOM_PLAN_ID,
  getImportedPlans,
  getPlanById,
  getPlanStats,
  hasMarathonDay,
  planAttributionLine,
  planMatchesSearch,
  suggestPlansForRunner,
  type PlanStats,
  type TrainingPlan,
} from '../../data/plans';
import {
  downloadPlanJson,
  importAndSavePlan,
  isImportedPlan,
  removeImportedPlan,
} from '../../services/planImportExport';
import { PlanSourceNote } from './PlanSourceNote';
import { getActivePlan, getStoredPlanProgress, previewStartPlan, startPlan } from '../../services/planProgress';
import type { ActivePlan, StartPlanInput, StartPlanPreview } from '../../services/planProgress';
import { formatMiles } from '../../services/unitPreferences';
import { todayKey } from '../../utils/localDate';
import { ConfirmDialog } from '../ui';
import {
  RaceDatePlanSetup,
  initialPlanSetupValue,
  planSetupError,
  planSetupToStartInput,
  readRecentFitness,
} from './RaceDatePlanSetup';
import type { PlanSetupValue } from './RaceDatePlanSetup';
import './plan.css';

/** True when starting would clear stored progress of that plan (ask first). */
export function startNeedsConfirm(preview: StartPlanPreview): boolean {
  return (
    preview.isNewInstance && (preview.clears.completions > 0 || preview.clears.overlay || preview.clears.syncMeta > 0)
  );
}

/** "3 completed days, your moves and skips, 2 activity matches". */
export function describeClears(clears: StartPlanPreview['clears']): string {
  const parts: string[] = [];
  if (clears.completions > 0) parts.push(`${clears.completions} completed day${clears.completions === 1 ? '' : 's'}`);
  if (clears.overlay) parts.push('your moves and skips');
  if (clears.syncMeta > 0) parts.push(`${clears.syncMeta} activity match${clears.syncMeta === 1 ? '' : 'es'}`);
  return parts.length > 0 ? parts.join(', ') : 'saved progress';
}

export interface PlanChooserProps {
  /** 'start' when no plan is active, 'switch' to replace / re-place the active plan. */
  mode: 'start' | 'switch';
  /** Id of the active plan (marked "current"), if any. */
  activePlanId: string | null;
  /** Preselected plan (e.g. a custom plan that was just built). */
  initialPlanId?: string | null;
  /** Called after the plan was started. */
  onStarted: (active: ActivePlan) => void;
  /** Discard the pending choice (switch mode). */
  onCancel?: () => void;
  /** Open the custom plan builder. */
  onBuildCustom: () => void;
  headingLevel?: 2 | 3;
  /** Override "today" (tests). */
  today?: string;
}

type CategoryFilter =
  | 'all'
  | 'recommended'
  | 'first-marathon'
  | 'classic-build'
  | 'high-volume'
  | 'bq-threshold'
  | 'time-run-walk'
  | 'multi-marathon'
  | 'base-recovery'
  | 'custom-imported';

const CATEGORY_FILTERS: readonly { id: CategoryFilter; label: string }[] = [
  { id: 'all', label: 'All plans' },
  { id: 'recommended', label: 'Recommended' },
  { id: 'first-marathon', label: 'First marathon' },
  { id: 'classic-build', label: 'Classic build' },
  { id: 'high-volume', label: 'High volume & doubles' },
  { id: 'bq-threshold', label: 'BQ & threshold' },
  { id: 'time-run-walk', label: 'Time / run-walk' },
  { id: 'multi-marathon', label: 'Multi-marathon' },
  { id: 'base-recovery', label: 'Base & recovery' },
  { id: 'custom-imported', label: 'Custom & imported' },
];

function formatRunDays(stats: PlanStats): string {
  return stats.minRunDays === stats.maxRunDays
    ? `${stats.maxRunDays} run days`
    : `${stats.minRunDays}–${stats.maxRunDays} run days`;
}

function planMeta(p: TrainingPlan, stats: PlanStats): string {
  // v1.0.9: an imported file can't vouch for itself — the attribution line says so
  // ("Imported, not verified by Apollo") and quotes the author it lists.
  return (
    `${planAttributionLine(p)} · ${p.weeks.length} weeks · Peak ${formatMiles(stats.peakMiles, 0)} · ` +
    `${formatRunDays(stats)} · Long ${formatMiles(stats.longestRunMi, 0)}`
  );
}

/** v1.0.9: the “Remove this imported plan?” message, naming the stored progress that goes with it. */
function removeImportedMessage(plan: TrainingPlan): string {
  const stored = getStoredPlanProgress(plan.id);
  const hasProgress = stored.completions > 0 || stored.overlay || stored.syncMeta > 0;
  return (
    `“${plan.name}” will be removed from your plans` +
    (hasProgress ? `, along with its progress: ${describeClears(stored)}` : '') +
    '. You can import its file again later.'
  );
}

function matchesCategoryFilter(
  plan: TrainingPlan,
  filter: CategoryFilter,
  recommendedIds: ReadonlySet<string>,
): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'recommended':
      return recommendedIds.has(plan.id);
    case 'first-marathon':
      return plan.category === 'first-marathon' || plan.tier === 'beginner';
    case 'classic-build':
      return plan.category === 'classic-build' || plan.category === 'masters-longevity';
    case 'high-volume':
      return plan.category === 'high-volume' || !!plan.hasDoubles;
    case 'bq-threshold':
      return plan.category === 'bq-performance' || plan.category === 'threshold-doubles';
    case 'time-run-walk':
      return plan.category === 'time-run-walk' || !!plan.isTimeBased;
    case 'multi-marathon':
      return plan.category === 'multi-marathon';
    case 'base-recovery':
      return plan.category === 'base-recovery';
    case 'custom-imported':
      return plan.id === CUSTOM_PLAN_ID || isImportedPlan(plan);
  }
}

export function PlanChooser({
  mode,
  activePlanId,
  initialPlanId = null,
  onStarted,
  onCancel,
  onBuildCustom,
  headingLevel = 2,
  today,
}: PlanChooserProps) {
  const uid = useId().replace(/:/g, '');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(initialPlanId);
  const [setup, setSetup] = useState<PlanSetupValue>(() => initialPlanSetupValue(today));
  const [error, setError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ input: StartPlanInput; preview: StartPlanPreview } | null>(null);
  /** v1.0.9: imported plan waiting for the "Remove this imported plan?" confirmation. */
  const [removeTarget, setRemoveTarget] = useState<TrainingPlan | null>(null);

  // Smart Plan Finder state
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [daysFilter, setDaysFilter] = useState<number>(0); // 0 = any
  const [importedVersion, setImportedVersion] = useState(0);

  const importedPlans = useMemo(
    () => getImportedPlans(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [importedVersion],
  );
  const custom = getPlanById(CUSTOM_PLAN_ID);
  const allPlans: TrainingPlan[] = useMemo(() => {
    const list: TrainingPlan[] = [...ALL_BUILT_IN_PLANS];
    if (custom) list.push(custom);
    list.push(...importedPlans);
    return list;
  }, [custom, importedPlans]);

  const statsById = useMemo(() => {
    const map = new Map<string, PlanStats>();
    for (const p of allPlans) map.set(p.id, getPlanStats(p));
    return map;
  }, [allPlans]);

  const recentFitness = useMemo(() => readRecentFitness(today), [today]);
  const recommendations = useMemo(() => {
    const weeklyMi = recentFitness?.weeklyMiles ?? 22;
    return suggestPlansForRunner(weeklyMi, daysFilter > 0 ? daysFilter : 4);
  }, [recentFitness, daysFilter]);
  const recommendedIds = useMemo(() => new Set(recommendations.map((r) => r.planId)), [recommendations]);

  const visiblePlans = useMemo(() => {
    return allPlans.filter((p) => {
      if (p.id === pendingPlanId) return true; // Keep active selection visible
      if (!matchesCategoryFilter(p, categoryFilter, recommendedIds)) return false;
      const stats = statsById.get(p.id);
      if (daysFilter > 0 && stats && !(daysFilter >= stats.minRunDays && daysFilter <= stats.maxRunDays)) {
        return false;
      }
      // v1.0.9: every word must match (name, author, coach, tags, category), any case.
      return planMatchesSearch(p, searchQuery);
    });
  }, [allPlans, pendingPlanId, categoryFilter, recommendedIds, statsById, daysFilter, searchQuery]);

  const pendingPlan = pendingPlanId ? (getPlanById(pendingPlanId) ?? null) : null;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const titleId = `plan-chooser-${uid}`;

  const selectPlan = (plan: TrainingPlan) => {
    setPendingPlanId(plan.id);
    setError(null);
    // Non-marathon Base/Recovery/Maintenance blocks start on a date rather than asking for a marathon date.
    // v1.0.9: RaceDatePlanSetup shows such a block a start date field by itself, so only prefill the date
    // here. `useStartDate` stays the athlete's own choice: a marathon plan picked next is placed by race
    // date again, with the late-join check.
    if (!hasMarathonDay(plan)) {
      setSetup((prev) => (prev.startDate ? prev : { ...prev, startDate: today ?? todayKey() }));
    }
  };

  const commit = (input: StartPlanInput) => {
    const next = startPlan(input, today);
    setConfirm(null);
    onStarted(next);
  };

  const handleStart = () => {
    if (!pendingPlanId || !pendingPlan) {
      setError('Choose a plan first.');
      return;
    }
    const input = planSetupToStartInput(pendingPlanId, setup, today);
    if (!input) {
      setError(planSetupError(setup, today, pendingPlan));
      return;
    }
    setError(null);
    const preview = previewStartPlan(input, today);
    if (startNeedsConfirm(preview)) setConfirm({ input, preview });
    else commit(input);
  };

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setImportNotice(null);
    const result = await importAndSavePlan(file);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setImportedVersion((v) => v + 1);
    selectPlan(result.plan);
    const warnSuffix = result.warnings.length > 0 ? ` (${result.warnings[0]})` : '';
    setImportNotice(`Imported “${result.plan.name}” (${result.plan.totalWeeks} weeks).${warnSuffix}`);
  };

  /** v1.0.9: the active plan can't be removed (switch first); removing another imported plan asks first. */
  const handleDeleteImported = (plan: TrainingPlan) => {
    setError(null);
    if (plan.id === activePlanId || getActivePlan()?.planId === plan.id) {
      setImportNotice(
        `“${plan.name}” is your current plan, so it can’t be removed. To remove it, switch to another plan first.`,
      );
      return;
    }
    setImportNotice(null);
    setRemoveTarget(plan);
  };

  const confirmDeleteImported = (plan: TrainingPlan) => {
    setRemoveTarget(null);
    // v1.0.9: removes the plan and forgets its stored progress (nothing left orphaned).
    if (!removeImportedPlan(plan.id)) {
      setImportNotice(`“${plan.name}” wasn’t removed. If it’s your current plan, switch to another plan first.`);
      return;
    }
    setImportedVersion((v) => v + 1);
    if (pendingPlanId === plan.id) setPendingPlanId(null);
    setImportNotice(`Removed imported plan “${plan.name}”.`);
  };

  const startLabel =
    mode === 'start' ? 'Start plan' : pendingPlanId && pendingPlanId === activePlanId ? 'Re-place plan' : 'Switch plan';

  return (
    <section className="card" aria-labelledby={titleId}>
      <Heading id={titleId}>{mode === 'start' ? 'Choose a training plan' : 'Switch plan'}</Heading>
      <p className="plan-setup-muted">
        {mode === 'start'
          ? 'Pick a marathon or base-building plan, import a plan file, or build your own.'
          : 'Nothing changes until you press “Switch plan”. Completed days of your current plan are kept.'}
      </p>

      {/* Plan filter */}
      <div className="plan-finder" role="search" aria-label="Filter training plans">
        <div className="plan-finder-row">
          <div className="plan-finder-search-wrap">
            <label htmlFor={`${uid}-search`} className="sr-only">
              Search plans by coach, method or volume
            </label>
            <input
              id={`${uid}-search`}
              type="search"
              className="plan-finder-search"
              placeholder="Search Higdon, Pfitzinger, Daniels 2Q, Hansons, BQ, doubles…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="plan-finder-days-wrap">
            <label htmlFor={`${uid}-days`} className="sr-only">
              Filter by running days per week
            </label>
            <select
              id={`${uid}-days`}
              className="plan-finder-select"
              value={daysFilter}
              onChange={(e) => setDaysFilter(Number(e.target.value))}
            >
              <option value={0}>Any days/week</option>
              <option value={3}>3 days/week</option>
              <option value={4}>4 days/week</option>
              <option value={5}>5 days/week</option>
              <option value={6}>6 days/week</option>
              <option value={7}>7 days/week</option>
            </select>
          </div>
        </div>

        <div className="plan-finder-pills" role="group" aria-label="Plan category">
          {CATEGORY_FILTERS.map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`plan-finder-pill ${categoryFilter === cat.id ? 'plan-finder-pill--active' : ''}`}
              aria-pressed={categoryFilter === cat.id}
              onClick={() => setCategoryFilter(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <p className="plan-finder-count">
          Showing {visiblePlans.length} of {allPlans.length} plans
          {recentFitness && recentFitness.weeklyMiles !== null
            ? ` · Matched to your recent ~${formatMiles(recentFitness.weeklyMiles, 0)}/week volume`
            : ''}
        </p>
      </div>

      {importNotice && (
        <p className="plan-toast" role="status">
          {importNotice}
        </p>
      )}

      <fieldset className="plan-plan-picker">
        <legend>Plan</legend>
        {visiblePlans.length === 0 ? (
          <p className="plan-setup-muted">
            No plans match those filters.{' '}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                setSearchQuery('');
                setCategoryFilter('all');
                setDaysFilter(0);
              }}
            >
              Reset filters
            </button>
          </p>
        ) : (
          visiblePlans.map((p) => {
            const stats = statsById.get(p.id) ?? getPlanStats(p);
            const isTopMatch = recommendedIds.has(p.id);
            const imported = isImportedPlan(p);
            return (
              <div key={p.id} className="plan-plan-option-row">
                <label className="plan-plan-option">
                  <input
                    type="radio"
                    name={`${uid}-plan`}
                    value={p.id}
                    checked={pendingPlanId === p.id}
                    onChange={() => selectPlan(p)}
                  />
                  <span className="plan-plan-option-content">
                    <span className="plan-plan-option-header">
                      <span className="plan-plan-option-name">
                        {p.name}
                        {p.id === activePlanId ? ' (current)' : ''}
                      </span>
                      {isTopMatch && <span className="plan-tag plan-tag--match">Recommended</span>}
                      {stats.hasDoubles && <span className="plan-tag plan-tag--doubles">AM/PM doubles</span>}
                      {p.isTimeBased && <span className="plan-tag plan-tag--time">Time / run-walk</span>}
                      {(p.category === 'base-recovery' || !stats.isMarathonPlan) && (
                        <span className="plan-tag">Block</span>
                      )}
                      {imported && <span className="plan-tag plan-tag--imported">Imported</span>}
                    </span>
                    <span className="plan-plan-option-meta">{planMeta(p, stats)}</span>
                  </span>
                </label>
                {imported && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm plan-imported-delete"
                    aria-label={`Remove imported plan ${p.name}`}
                    onClick={() => handleDeleteImported(p)}
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })
        )}
      </fieldset>

      <div className="plan-setup-actions">
        <button type="button" className="btn btn-secondary" onClick={onBuildCustom}>
          + Build a custom plan
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.apollo-plan.json,application/json"
          onChange={handleImportFile}
          style={{ display: 'none' }}
          aria-hidden="true"
          tabIndex={-1}
        />
        <button type="button" className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
          Import plan…
        </button>
        {pendingPlan && (
          <button type="button" className="btn btn-ghost" onClick={() => downloadPlanJson(pendingPlan)}>
            Export plan
          </button>
        )}
      </div>

      {pendingPlan && (
        <div className="plan-chooser-setup">
          {pendingPlan.description && <p className="plan-chooser-desc">{pendingPlan.description}</p>}
          <PlanSourceNote plan={pendingPlan} />
          <RaceDatePlanSetup
            plan={pendingPlan}
            value={setup}
            onChange={setSetup}
            idPrefix={`${uid}-setup`}
            today={today}
            onChoosePlan={(id) => {
              const target = getPlanById(id);
              if (target) selectPlan(target);
            }}
          />
        </div>
      )}

      {error && (
        <p className="plan-setup-error" role="alert">
          {error}
        </p>
      )}

      <div className="plan-setup-actions">
        <button type="button" className="btn btn-primary" onClick={handleStart} disabled={!pendingPlan}>
          {startLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      <ConfirmDialog
        open={!!confirm}
        tone="danger"
        title="Restart this plan?"
        message={
          confirm ? `Progress for this plan will be cleared: ${describeClears(confirm.preview.clears)}.` : undefined
        }
        confirmLabel="Restart plan"
        cancelLabel="Keep my progress"
        onConfirm={() => confirm && commit(confirm.input)}
        onCancel={() => setConfirm(null)}
      />

      <ConfirmDialog
        open={!!removeTarget}
        tone="danger"
        title="Remove this imported plan?"
        message={removeTarget ? removeImportedMessage(removeTarget) : undefined}
        confirmLabel="Remove plan"
        cancelLabel="Keep plan"
        onConfirm={() => removeTarget && confirmDeleteImported(removeTarget)}
        onCancel={() => setRemoveTarget(null)}
      />
    </section>
  );
}

export default PlanChooser;
