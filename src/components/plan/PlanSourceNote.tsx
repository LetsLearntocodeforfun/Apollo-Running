/**
 * Plan source note (v1.0.7): how closely Apollo's version follows the coach's
 * published plan, what differs, and links to the coach's official free plan,
 * book, website or app — plus the independence notice. Shown in the plan
 * chooser, onboarding and the About tab so people always have the legitimate
 * original one click away.
 */

import { PLAN_FIDELITY_LABEL, PLAN_INDEPENDENCE_NOTICE, type TrainingPlan } from '../../data/plans';
import './plan.css';

export interface PlanSourceNoteProps {
  plan: Pick<TrainingPlan, 'name' | 'attribution'>;
  /** Hide the independence notice (when the page shows it once already). */
  hideNotice?: boolean;
  /** Extra class names for layout. */
  className?: string;
}

const SOURCE_KIND_LABEL: Record<string, string> = {
  'free-plan': 'Free official plan',
  book: 'Book',
  website: 'Official website',
  app: 'Official app',
};

export function PlanSourceNote({ plan, hideNotice = false, className }: PlanSourceNoteProps) {
  const a = plan.attribution;
  if (!a) return null;
  return (
    <aside className={`plan-source-note${className ? ` ${className}` : ''}`} aria-label={`About the ${plan.name} plan`}>
      <p className="plan-source-fidelity">
        <span className={`plan-fidelity-badge plan-fidelity-${a.fidelity}`}>{PLAN_FIDELITY_LABEL[a.fidelity]}</span>{' '}
        {a.note}
      </p>
      {a.sources.length > 0 && (
        <ul className="plan-source-links">
          {a.sources.map((s) => (
            <li key={s.url}>
              <span className="plan-source-kind">{SOURCE_KIND_LABEL[s.kind] ?? 'Source'}:</span>{' '}
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.label}
              </a>
            </li>
          ))}
        </ul>
      )}
      {!hideNotice && <p className="plan-source-notice">{PLAN_INDEPENDENCE_NOTICE}</p>}
    </aside>
  );
}

export default PlanSourceNote;
