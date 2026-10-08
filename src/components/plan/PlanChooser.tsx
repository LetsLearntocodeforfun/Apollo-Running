/**
 * Plan chooser for the Plan page (v1.0.6): pick a plan, set the race date
 * (race-date-first placement preview) and start it.
 *
 * The selection is *pending* until "Start plan" / "Switch plan" is pressed — the
 * page keeps showing the current plan while the athlete browses, and Cancel
 * simply discards the pending choice (UI review B1). Restarting a plan whose
 * stored progress belongs to another instance asks for confirmation first
 * ("Progress for this plan will be cleared"), using T2a's previewStartPlan.
 */

import { useId, useState } from 'react';
import { BUILT_IN_PLANS, CUSTOM_PLAN_ID, getPlanById } from '../../data/plans';
import type { TrainingPlan } from '../../data/plans';
import { previewStartPlan, startPlan } from '../../services/planProgress';
import type { ActivePlan, StartPlanInput, StartPlanPreview } from '../../services/planProgress';
import { ConfirmDialog } from '../ui';
import {
  RaceDatePlanSetup,
  initialPlanSetupValue,
  planSetupError,
  planSetupToStartInput,
} from './RaceDatePlanSetup';
import type { PlanSetupValue } from './RaceDatePlanSetup';
import './plan.css';

/** True when starting would clear stored progress of that plan (ask first). */
export function startNeedsConfirm(preview: StartPlanPreview): boolean {
  return preview.isNewInstance && (preview.clears.completions > 0 || preview.clears.overlay || preview.clears.syncMeta > 0);
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

function planMeta(p: TrainingPlan): string {
  return `${p.author} · ${p.weeks.length} weeks`;
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
  const [pendingPlanId, setPendingPlanId] = useState<string | null>(initialPlanId);
  const [setup, setSetup] = useState<PlanSetupValue>(() => initialPlanSetupValue(today));
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ input: StartPlanInput; preview: StartPlanPreview } | null>(null);

  const custom = getPlanById(CUSTOM_PLAN_ID);
  const plans: TrainingPlan[] = custom ? [...BUILT_IN_PLANS, custom] : BUILT_IN_PLANS;
  const pendingPlan = pendingPlanId ? getPlanById(pendingPlanId) ?? null : null;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const titleId = `plan-chooser-${uid}`;

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
      setError(planSetupError(setup, today));
      return;
    }
    setError(null);
    const preview = previewStartPlan(input, today);
    if (startNeedsConfirm(preview)) setConfirm({ input, preview });
    else commit(input);
  };

  const startLabel = mode === 'start' ? 'Start plan' : pendingPlanId && pendingPlanId === activePlanId ? 'Re-place plan' : 'Switch plan';

  return (
    <section className="card" aria-labelledby={titleId}>
      <Heading id={titleId}>{mode === 'start' ? 'Choose a training plan' : 'Switch plan'}</Heading>
      <p className="plan-setup-muted">
        {mode === 'start'
          ? 'Pick a plan and your race date — the plan is placed so race day lands on that date.'
          : 'Nothing changes until you press “Switch plan”. Completed days of your current plan are kept.'}
      </p>

      <fieldset className="plan-plan-picker">
        <legend>Plan</legend>
        {plans.map((p) => (
          <label key={p.id} className="plan-plan-option">
            <input
              type="radio"
              name={`${uid}-plan`}
              value={p.id}
              checked={pendingPlanId === p.id}
              onChange={() => {
                setPendingPlanId(p.id);
                setError(null);
              }}
            />
            <span>
              <span className="plan-plan-option-name">
                {p.name}
                {p.id === activePlanId ? ' (current)' : ''}
              </span>
              <span className="plan-plan-option-meta">{planMeta(p)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="plan-setup-actions">
        <button type="button" className="btn btn-secondary" onClick={onBuildCustom}>
          + Build a custom plan
        </button>
      </div>

      {pendingPlan && (
        <div className="plan-chooser-setup">
          <RaceDatePlanSetup plan={pendingPlan} value={setup} onChange={setSetup} idPrefix={`${uid}-setup`} today={today} />
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
        message={confirm ? `Progress for this plan will be cleared: ${describeClears(confirm.preview.clears)}.` : undefined}
        confirmLabel="Restart plan"
        cancelLabel="Keep my progress"
        onConfirm={() => confirm && commit(confirm.input)}
        onCancel={() => setConfirm(null)}
      />
    </section>
  );
}

export default PlanChooser;
