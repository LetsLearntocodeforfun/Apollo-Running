import { useEffect, useMemo, useState } from 'react';
import { onActivitiesUpdated } from '../../services/activitySource';
import { getZoneLabel, type TSBZone } from '../../services/pmcChart';
import { formatTsb, getFitnessForm } from './fitnessData';
import './FormChip.css';

export interface FormChipProps {
  /** Single-line variant for tight layouts. */
  compact?: boolean;
}

/** Short zone names for the chip (full names come from getZoneLabel). */
const SHORT_ZONE: Record<TSBZone, string> = {
  overreaching: 'Overreaching',
  productive: 'Productive',
  fresh: 'Fresh',
  peak: 'Race-ready',
  transition: 'Transition',
  detrained: 'Detrained',
};

/**
 * Today-screen "Form" chip: TSB value, zone label (text, not just colour) and
 * a 0-100 readiness score. No recharts — safe for the first-paint bundle.
 * Refreshes when activities change (sync, import, hide/delete).
 */
export default function FormChip({ compact = false }: FormChipProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => onActivitiesUpdated(() => setTick((t) => t + 1)), []);

  // `tick` re-runs the (memoized) computation after a store change.
  const data = useMemo(() => {
    void tick;
    return getFitnessForm();
  }, [tick]);
  const current = data.pmc.current;

  if (!current) {
    return (
      <div className={`form-chip form-chip--empty${compact ? ' form-chip--compact' : ''}`} role="group" aria-label="Form">
        <span className="form-chip-label">Form</span>
        <span className="form-chip-note">Log a few runs to see your form</span>
      </div>
    );
  }

  const zoneName = SHORT_ZONE[current.zone];
  const tsbText = formatTsb(current.tsb);
  const summary = `Form ${tsbText}, ${getZoneLabel(current.zone)}. Readiness ${current.readinessScore} of 100.`;

  return (
    <div
      className={`form-chip form-chip--${current.zone}${compact ? ' form-chip--compact' : ''}`}
      role="group"
      aria-label={summary}
      title={`Fitness (CTL) ${Math.round(current.ctl)} · Fatigue (ATL) ${Math.round(current.atl)} · Form (TSB) ${tsbText}`}
    >
      <span className="form-chip-label" aria-hidden="true">Form</span>
      <span className="form-chip-value" aria-hidden="true">{tsbText}</span>
      <span className="form-chip-zone" aria-hidden="true">
        <span className="form-chip-dot" />
        {zoneName}
      </span>
      {!compact && (
        <span className="form-chip-readiness" aria-hidden="true">
          Readiness <strong>{current.readinessScore}</strong>
        </span>
      )}
      {!compact && data.warmingUp && (
        <span className="form-chip-note" aria-hidden="true">Estimate · building 6-week history</span>
      )}
    </div>
  );
}
