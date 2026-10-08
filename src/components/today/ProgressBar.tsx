export type ProgressTone = 'good' | 'warn' | 'bad';

export interface ProgressBarProps {
  /** Visible label, also the accessible name. */
  label: string;
  /** 0–100 (clamped). */
  pct: number;
  /** Visible value text, e.g. "24.5 / 41.0 km"; also announced as aria-valuetext. */
  valueText: string;
  /** Optional status line under the bar (colour is never the only cue). */
  note?: string;
  tone?: ProgressTone;
}

/** Accessible progress bar: role="progressbar" with value, range and a text label. */
export default function ProgressBar({ label, pct, valueText, note, tone = 'good' }: ProgressBarProps) {
  const value = Math.max(0, Math.min(100, Math.round(Number.isFinite(pct) ? pct : 0)));
  const fillClass = tone === 'good' ? 'today-progress-fill' : `today-progress-fill today-progress-fill--${tone}`;
  return (
    <div className="today-progress">
      <div className="today-progress-head">
        <span className="today-progress-label">{label}</span>
        <span className="today-progress-value">{valueText}</span>
      </div>
      <div
        className="today-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={`${valueText} (${value}%)`}
      >
        <div className={fillClass} style={{ width: `${value}%` }} />
      </div>
      {note && <p className="today-progress-note">{note}</p>}
    </div>
  );
}
