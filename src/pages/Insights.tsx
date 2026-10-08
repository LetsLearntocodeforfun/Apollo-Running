/**
 * Progress page panels (v1.0.6), formerly the Insights page.
 *
 * `src/pages/Progress.tsx` renders these panels as tabs:
 * - {@link OverviewPanel}: race prediction, countdown, adherence, readiness, recovery
 * - {@link HeartRatePanel}: read-only HR profile, zones, 30-day distribution, trend
 * - {@link RecapsPanel}: today's recap and recent recaps
 *
 * Editing the HR profile and the coaching (recap / readiness) preferences
 * moved to Settings. The old "Coaching Settings" tab was removed (B2): it was
 * a duplicate of Settings and its controls snapped back.
 * Every panel re-reads its data when the store changes (B12: refresh after a
 * sync, a plan edit or a completed day) via `useStoreVersion()`.
 *
 * The default export redirects old `/insights` links to the Progress page.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { EmptyState } from '../components/ui';
import ErrorBoundary from '../components/ErrorBoundary';
import RecoveryCard from '../components/RecoveryCard';
import { useStoreVersion } from '../hooks/useStoreVersion';
import { getActivePlan } from '../services/planProgress';
import { getEffectivePlan } from '../services/planOverlay';
import { getJourneyState, type JourneyState } from '../services/journey';
import { isActivitySourceConnected } from '../services/activitySource';
import { getAthleteProfile } from '../services/athleteProfile';
import {
  calculateRacePrediction,
  calculateTrainingAdherence,
  formatTimeSec,
  getSavedAdherence,
  getSavedPrediction,
  getVdotSourceLabel,
  type RacePrediction,
  type TrainingAdherence,
} from '../services/racePrediction';
import {
  generateCurrentWeekReadiness,
  getAllReadinessScores,
  getLatestReadinessScore,
  type ReadinessScore,
} from '../services/weeklyReadiness';
import {
  generateTodayRecap,
  getDailyRecap,
  getRecentRecaps,
  type DailyRecap,
} from '../services/dailyRecap';
import {
  getAggregateZoneDistribution,
  getHRProfile,
  getHRTrend,
  getHRZones,
  type HRProfile,
  type HRZone,
} from '../services/heartRate';
import { formatDuration, formatMiles, formatPaceFromMinPerMi } from '../services/unitPreferences';
import { isDateKey, parseDateKey, todayKey } from '../utils/localDate';

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * State that is computed after mount and again whenever the store version
 * changes (B12). `initial` must be a cheap, side-effect-free read for the
 * first paint; `compute` may save (e.g. `calculateRacePrediction`). Pass
 * module-level functions so their identity is stable.
 */
function useRefreshingState<T>(initial: () => T, compute: () => T): T {
  const version = useStoreVersion();
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    setValue(compute());
  }, [compute, version]);
  return value;
}

/** A pure read that is redone whenever the store version changes (B12). */
function useStoreSnapshot<T>(read: () => T): T {
  const version = useStoreVersion();
  return useMemo(() => {
    void version; // the dependency that triggers the re-read
    return read();
  }, [read, version]);
}

/** Localised label for a YYYY-MM-DD key, e.g. "Mon, Oct 5" (local calendar date). */
function formatDayLabel(key: string, withYear = false): string {
  if (!isDateKey(key)) return key;
  return parseDateKey(key).toLocaleDateString(undefined, withYear
    ? { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }
    : { weekday: 'short', month: 'short', day: 'numeric' });
}

type ScoreBand = 'good' | 'ok' | 'low';

/** Score band used for colour classes; the number is always shown next to it. */
function scoreBand(score: number, good = 80, ok = 60): ScoreBand {
  if (score >= good) return 'good';
  if (score >= ok) return 'ok';
  return 'low';
}

const BAND_COLOR: Record<ScoreBand, string> = {
  good: 'var(--color-success)',
  ok: 'var(--color-warning)',
  low: 'var(--color-error-text)',
};

/** Colour for a readiness letter grade (always rendered with the grade text). */
function gradeColor(grade: string): string {
  if (grade.startsWith('A')) return 'var(--color-success)';
  if (grade.startsWith('B')) return 'var(--apollo-teal)';
  if (grade.startsWith('C')) return 'var(--color-warning)';
  return 'var(--color-error-text)';
}

/** Circular gauge component for scores */
function ScoreGauge({ score, size = 120, label, color }: { score: number; size?: number; label: string; color: string }) {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = circumference - (clamped / 100) * circumference;
  return (
    <div className="progress-gauge">
      <svg width={size} height={size} className="progress-gauge-svg" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={8} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={8} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          className="progress-gauge-arc"
        />
        <text
          x={size / 2} y={size / 2}
          textAnchor="middle" dominantBaseline="central"
          fill="var(--text)" fontSize={size * 0.28} fontWeight={700}
          style={{ transform: 'rotate(90deg)', transformOrigin: `${size / 2}px ${size / 2}px` }}
        >
          {score}
        </text>
      </svg>
      <span className="progress-gauge-label">
        <span className="sr-only">{score} — </span>{label}
      </span>
    </div>
  );
}

/** Mini trend sparkline (simple CSS-based) */
function TrendLine({ scores }: { scores: { week: number; score: number }[] }) {
  if (scores.length < 2) return null;
  const max = Math.max(...scores.map((s) => s.score), 100);
  const summary = scores.map((s) => `week ${s.week}: ${s.score}%`).join(', ');
  return (
    <div className="progress-trendline" role="img" aria-label={`Weekly adherence — ${summary}`}>
      {scores.map((s) => (
        <div
          key={s.week}
          title={`Week ${s.week}: ${s.score}%`}
          className={`progress-trendline-bar is-${scoreBand(s.score)}`}
          style={{ height: `${(s.score / max) * 100}%` }}
        />
      ))}
    </div>
  );
}

// ── Overview: race prediction ─────────────────────────────────────────────────

const CONFIDENCE_LABEL: Record<string, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/** "High" / "Medium" / "Low", falling back to the legacy numeric confidence ("62%"). */
function predictionConfidenceText(p: RacePrediction): string {
  const level = p.confidenceLevel ? CONFIDENCE_LABEL[p.confidenceLevel] : undefined;
  if (level) return level;
  return Number.isFinite(p.confidence) ? `${Math.round(p.confidence)}%` : '—';
}

/** "Recent race" etc.; null for legacy predictions that don't record a source. */
function predictionSourceText(p: RacePrediction): string | null {
  if (p.sourceLabel) return p.sourceLabel;
  if (p.vdotSource) return getVdotSourceLabel(p.vdotSource);
  return null;
}

/** "3:21:00–3:36:00", or null when the prediction has no range (legacy). */
function predictionRangeText(p: RacePrediction): string | null {
  const lo = p.rangeLowSec;
  const hi = p.rangeHighSec;
  if (typeof lo !== 'number' || typeof hi !== 'number' || !(lo > 0) || !(hi > 0)) return null;
  return `${formatTimeSec(Math.min(lo, hi))}–${formatTimeSec(Math.max(lo, hi))}`;
}

/** Change against the previous prediction, e.g. "2:15 faster than the previous prediction (3:32:10)". */
function predictionChangeText(p: RacePrediction): string | null {
  const prev = p.previousMarathonTimeSec;
  if (typeof prev !== 'number' || !(prev > 0)) return null;
  const delta = Math.round(prev - p.marathonTimeSec);
  if (delta === 0) return null;
  const direction = delta > 0 ? 'faster' : 'slower';
  return `${formatTimeSec(Math.abs(delta))} ${direction} than the previous prediction (${formatTimeSec(prev)})`;
}

function TrendChip({ trend }: { trend: string }) {
  if (trend !== 'improving' && trend !== 'declining') return null;
  const up = trend === 'improving';
  return (
    <span className={`progress-chip ${up ? 'is-up' : 'is-down'}`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {up ? 'Improving' : 'Slower'}
    </span>
  );
}

const PREDICTION_EMPTY_COPY =
  'Add a recent race in Settings › Athlete Profile (or sync a race) to see a prediction.';

function PredictionCard({ prediction, goalMarathonSec, computed }: {
  prediction: RacePrediction | null;
  goalMarathonSec: number | null;
  computed: boolean;
}) {
  const titleId = 'progress-prediction-title';
  if (!prediction) {
    // Before the first computation finishes there is nothing to say yet.
    if (!computed) return null;
    return (
      <section className="card" aria-labelledby={titleId}>
        <h2 id={titleId} className="card-title">Race prediction</h2>
        <EmptyState
          icon="⏱️"
          title="No prediction yet"
          action={<Link to="/settings?tab=profile" className="btn btn-secondary">Add a recent race</Link>}
        >
          {PREDICTION_EMPTY_COPY}
        </EmptyState>
      </section>
    );
  }

  const range = predictionRangeText(prediction);
  const source = predictionSourceText(prediction);
  const change = predictionChangeText(prediction);
  const asOf = prediction.asOf && isDateKey(prediction.asOf) ? prediction.asOf : null;

  return (
    <section className="card progress-prediction" aria-labelledby={titleId}>
      <div className="progress-card-head">
        <h2 id={titleId} className="card-title">Race prediction</h2>
        <TrendChip trend={prediction.trend} />
      </div>

      <div className="progress-prediction-main">
        <div>
          <p className="progress-prediction-time">{prediction.marathonTimeFormatted}</p>
          <p className="progress-muted">Predicted marathon</p>
        </div>
        <div className="progress-prediction-side">
          {range && <p className="progress-range">Likely range {range}</p>}
          {goalMarathonSec != null && goalMarathonSec > 0 && (
            <p className="progress-goal">Goal {formatTimeSec(goalMarathonSec)}</p>
          )}
        </div>
      </div>

      <dl className="progress-meta">
        {source ? (
          <div><dt>Source</dt><dd>{source}</dd></div>
        ) : (
          <div><dt>Method</dt><dd>{prediction.method.replace(/_/g, ' ')}</dd></div>
        )}
        <div><dt>Confidence</dt><dd>{predictionConfidenceText(prediction)}</dd></div>
        {asOf && <div><dt>As of</dt><dd>{formatDayLabel(asOf, true)}</dd></div>}
        <div><dt>VDOT</dt><dd>{prediction.vdot}</dd></div>
      </dl>

      {prediction.basis && <p className="progress-basis">{prediction.basis}</p>}

      <h3>Other distances</h3>
      <ul className="progress-distances">
        <li><strong>{prediction.halfMarathonFormatted}</strong><span>Half marathon</span></li>
        <li><strong>{prediction.tenKFormatted}</strong><span>10K</span></li>
        <li><strong>{prediction.fiveKFormatted}</strong><span>5K</span></li>
      </ul>

      {change && <p className="progress-muted progress-change">{change}</p>}
    </section>
  );
}

// ── Overview: countdown ───────────────────────────────────────────────────────

const PHASE_LABEL: Record<string, string> = {
  base: 'Base phase',
  build: 'Build phase',
  peak: 'Peak phase',
  taper: 'Taper',
  race: 'Race week',
};

/** "12 days to race", "Race day is today", "Race was 3 days ago". */
function countdownText(daysToRace: number | null): string | null {
  if (daysToRace === null) return null;
  if (daysToRace > 1) return `${daysToRace} days to race`;
  if (daysToRace === 1) return '1 day to race';
  if (daysToRace === 0) return 'Race day is today';
  const ago = -daysToRace;
  return `Race was ${ago} day${ago === 1 ? '' : 's'} ago`;
}

function CountdownCard({ journey, planAuthor }: { journey: JourneyState; planAuthor: string | null }) {
  const titleId = 'progress-countdown-title';
  if (!journey.planName && journey.daysToRace === null) {
    return (
      <section className="card" aria-labelledby={titleId}>
        <h2 id={titleId} className="card-title">Race countdown</h2>
        <EmptyState
          icon="🗓️"
          title="No training plan yet"
          action={<Link to="/plan" className="btn btn-primary">Choose a plan</Link>}
        >
          Choose a training plan to unlock readiness scores, adherence tracking and a race-day countdown.
        </EmptyState>
      </section>
    );
  }

  const countdown = countdownText(journey.daysToRace);
  const phase = journey.trainingPhase ? PHASE_LABEL[journey.trainingPhase] ?? journey.trainingPhase : null;
  return (
    <section className="card progress-countdown" aria-labelledby={titleId}>
      <h2 id={titleId} className="card-title">Race countdown</h2>
      {countdown && <p className="progress-countdown-days">{countdown}</p>}
      <ul className="progress-facts">
        {journey.planName && <li>{journey.planName}{planAuthor ? ` by ${planAuthor}` : ''}</li>}
        {journey.raceDate && <li>Race day {formatDayLabel(journey.raceDate, true)}</li>}
        {journey.weekIndex !== null && journey.totalWeeks !== null && (
          <li>Week {journey.weekIndex + 1} of {journey.totalWeeks}</li>
        )}
        {phase && <li>{phase}</li>}
      </ul>
    </section>
  );
}

// ── Overview: adherence & readiness ───────────────────────────────────────────

function AdherenceCard({ adherence }: { adherence: TrainingAdherence }) {
  const titleId = 'progress-adherence-title';
  const first = adherence.weeklyScores[0];
  const last = adherence.weeklyScores[adherence.weeklyScores.length - 1];
  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="progress-card-head">
        <h2 id={titleId} className="card-title">Training adherence</h2>
        <span className={`progress-chip is-${adherence.rating === 'excellent' ? 'up' : adherence.rating === 'good' ? 'info' : 'warn'}`}>
          {adherence.rating}
        </span>
      </div>
      <div className="progress-gauges">
        <ScoreGauge score={adherence.score} label="Training adherence" color={BAND_COLOR[scoreBand(adherence.score)]} />
        <ScoreGauge
          score={adherence.distanceAdherence}
          label="Distance match"
          color={BAND_COLOR[scoreBand(adherence.distanceAdherence, 90, 70)]}
        />
        <ScoreGauge
          score={adherence.consistencyScore}
          size={100}
          label="Consistency"
          color={BAND_COLOR[scoreBand(adherence.consistencyScore, 80, 0)]}
        />
      </div>
      <div className="progress-stats">
        <div>
          <div className="progress-stat-label">Days completed</div>
          <div className="progress-stat-value">{adherence.completedDays} / {adherence.totalScheduledDays}</div>
        </div>
        <div>
          <div className="progress-stat-label">Intensity balance</div>
          <div className="progress-stat-value">{adherence.intensityBalance}%</div>
        </div>
        <div>
          <div className="progress-stat-label">Current streak</div>
          <div className="progress-stat-value">{adherence.currentStreak} days</div>
        </div>
      </div>
      {adherence.weeklyScores.length > 1 && (
        <>
          <h3>Weekly adherence trend</h3>
          <TrendLine scores={adherence.weeklyScores} />
          <div className="progress-axis">
            <span>Wk {first?.week}</span>
            <span>Wk {last?.week}</span>
          </div>
        </>
      )}
    </section>
  );
}

function ReadinessCard({ readiness, history }: { readiness: ReadinessScore; history: ReadinessScore[] }) {
  const titleId = 'progress-readiness-title';
  const color = gradeColor(readiness.grade);
  const subScores = [
    { label: 'Volume', score: readiness.volumeScore },
    { label: 'Consistency', score: readiness.consistencyScore },
    { label: 'Long run', score: readiness.longRunScore },
    { label: 'Intensity', score: readiness.intensityScore },
    { label: 'Recovery', score: readiness.recoveryScore },
  ];
  return (
    <section className="card progress-readiness" style={{ borderLeftColor: color }} aria-labelledby={titleId}>
      <div className="progress-card-head">
        <h2 id={titleId} className="card-title">
          Race-day readiness — week {readiness.weekNumber}
        </h2>
        <span className="progress-grade-letter" style={{ color }}>
          <span className="sr-only">Grade </span>{readiness.grade}
        </span>
        {readiness.trend !== 'stable' && (
          <span className={`progress-chip ${readiness.trend === 'improving' ? 'is-up' : 'is-down'}`}>
            <span aria-hidden="true">{readiness.trend === 'improving' ? '▲' : '▼'}</span>{' '}
            {readiness.trend === 'improving' ? 'Improving' : 'Declining'}
          </span>
        )}
      </div>

      <div className="progress-readiness-body">
        <ScoreGauge score={readiness.score} label={`Readiness week ${readiness.weekNumber}`} color={color} />
        <ul className="progress-subscores">
          {subScores.map((item) => (
            <li key={item.label}>
              <span className="progress-subscore-label">{item.label}</span>
              <span className="progress-bar" aria-hidden="true">
                <span className={`progress-bar-fill is-${scoreBand(item.score)}`} style={{ width: `${Math.max(0, Math.min(100, item.score))}%` }} />
              </span>
              <span className="progress-subscore-value">{item.score}</span>
            </li>
          ))}
        </ul>
      </div>

      {readiness.strengths.length > 0 && (
        <div className="progress-notes">
          <h3 className="progress-notes-title is-good">What went well</h3>
          {readiness.strengths.map((s, i) => <p key={i}>{s}</p>)}
        </div>
      )}
      {readiness.improvements.length > 0 && (
        <div className="progress-notes">
          <h3 className="progress-notes-title is-ok">Areas to improve</h3>
          {readiness.improvements.map((s, i) => <p key={i}>{s}</p>)}
        </div>
      )}
      {readiness.nextWeekTips.length > 0 && (
        <div className="progress-notes">
          <h3 className="progress-notes-title is-info">Tips for next week</h3>
          {readiness.nextWeekTips.map((s, i) => <p key={i}>{s}</p>)}
        </div>
      )}

      {history.length > 1 && (
        <>
          <h3>Readiness history</h3>
          <ul className="progress-history">
            {history.map((r) => (
              <li key={r.weekNumber} className="progress-history-item">
                <span className="progress-muted">Wk {r.weekNumber}</span>
                <strong style={{ color: gradeColor(r.grade) }}>{r.grade}</strong>
                <span className="progress-muted">{r.score}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ── Overview panel ────────────────────────────────────────────────────────────

interface OverviewData {
  /** False until the effect recomputed (and saved) the prediction and scores. */
  computed: boolean;
  prediction: RacePrediction | null;
  goalMarathonSec: number | null;
  journey: JourneyState;
  planAuthor: string | null;
  hasPlan: boolean;
  adherence: TrainingAdherence | null;
  readiness: ReadinessScore | null;
  allReadiness: ReadinessScore[];
  connected: boolean;
}

/**
 * Overview data. `fresh` recomputes and saves the prediction, adherence and
 * readiness (explicit, idempotent upserts); otherwise only saved values are read.
 */
function readOverview(fresh: boolean): OverviewData {
  const active = getActivePlan();
  const plan = active ? getEffectivePlan() : null;
  const hasPlan = Boolean(active && plan);
  const prediction = fresh ? calculateRacePrediction() : getSavedPrediction();
  const adherence = hasPlan ? (fresh ? calculateTrainingAdherence() : getSavedAdherence()) : null;
  // Generate the current week first so the history includes it.
  const readiness = hasPlan ? (fresh ? generateCurrentWeekReadiness() : getLatestReadinessScore()) : null;
  const allReadiness = hasPlan ? getAllReadinessScores() : [];
  return {
    computed: fresh,
    prediction,
    goalMarathonSec: getAthleteProfile().goalMarathonSec ?? null,
    journey: getJourneyState(),
    planAuthor: plan?.author ?? null,
    hasPlan,
    adherence,
    readiness,
    allReadiness,
    connected: isActivitySourceConnected(),
  };
}

const readOverviewSnapshot = (): OverviewData => readOverview(false);
const computeOverview = (): OverviewData => readOverview(true);

/** Overview tab: prediction, countdown, adherence, readiness and recovery. */
export function OverviewPanel() {
  const data = useRefreshingState(readOverviewSnapshot, computeOverview);
  return (
    <>
      <PredictionCard prediction={data.prediction} goalMarathonSec={data.goalMarathonSec} computed={data.computed} />
      <CountdownCard journey={data.journey} planAuthor={data.planAuthor} />
      {data.hasPlan && data.adherence && <AdherenceCard adherence={data.adherence} />}
      {data.hasPlan && data.readiness && <ReadinessCard readiness={data.readiness} history={data.allReadiness} />}
      {/* Today's recovery (sleep / HRV / resting HR via intervals.icu) — independent of the plan */}
      {data.connected && (
        <section aria-labelledby="progress-recovery-title">
          <h2 id="progress-recovery-title" className="sr-only">Recovery</h2>
          <ErrorBoundary variant="inline" label="Recovery">
            <RecoveryCard />
          </ErrorBoundary>
        </section>
      )}
    </>
  );
}

// ── Heart rate panel ──────────────────────────────────────────────────────────

/** Plain-language origin of the HR profile values. */
export function hrSourceLabel(source: string | undefined): string {
  switch (source) {
    case 'age-estimate': return 'Estimated from your birth year';
    case 'manual': return 'Set by you';
    case 'intervals': return 'From your intervals.icu activities';
    case 'strava': return 'From your Strava activities';
    case 'garmin': return 'From Garmin';
    case 'file': return 'From imported activity files';
    case 'default':
    case undefined:
    case '':
      return 'Default values (not personalised yet)';
    default: return `From ${source}`;
  }
}

/** HR zone distribution bars (30 days) */
function ZoneChart({ zones, percentages, totalTimeSec }: { zones: HRZone[]; percentages: number[]; totalTimeSec: number }) {
  return (
    <div>
      <ul className="progress-zone-bars">
        {zones.map((z, i) => (
          <li key={z.zone} className="progress-zone-row">
            <span className="progress-zone-name">
              <span className="progress-zone-dot" style={{ background: z.color }} aria-hidden="true" />
              Z{z.zone} {z.name}
            </span>
            <span className="progress-zone-track" aria-hidden="true">
              <span className="progress-zone-fill" style={{ width: `${Math.max(percentages[i] ?? 0, 1)}%`, background: z.color }} />
            </span>
            <span className="progress-zone-pct">{percentages[i] ?? 0}%</span>
          </li>
        ))}
      </ul>
      <p className="progress-muted progress-small">Total training time (30 days): {formatDuration(totalTimeSec)}</p>
    </div>
  );
}

interface HeartRateData {
  profile: HRProfile;
  zones: HRZone[];
  distribution: ReturnType<typeof getAggregateZoneDistribution>;
  trend: ReturnType<typeof getHRTrend>;
}

function readHeartRate(): HeartRateData {
  const profile = getHRProfile();
  return {
    profile,
    zones: getHRZones(profile.maxHR),
    distribution: getAggregateZoneDistribution(30),
    trend: getHRTrend(30),
  };
}

/** Heart Rate tab: read-only profile (edit in Settings), zones, distribution and trend. */
export function HeartRatePanel() {
  const { profile, zones, distribution, trend } = useStoreSnapshot(readHeartRate);
  const hasData = distribution.totalTimeSec > 0 || trend.length > 0;
  const easyShare = (distribution.percentages[0] ?? 0) + (distribution.percentages[1] ?? 0);

  return (
    <>
      <section className="card" aria-labelledby="progress-hr-profile-title">
        <h2 id="progress-hr-profile-title" className="card-title">Heart rate profile</h2>
        <dl className="progress-hr-values">
          <div><dt>Max HR</dt><dd>{profile.maxHR} bpm</dd></div>
          <div><dt>Resting HR</dt><dd>{profile.restingHR} bpm</dd></div>
          {profile.lthr ? <div><dt>Lactate threshold</dt><dd>{profile.lthr} bpm</dd></div> : null}
          <div><dt>Source</dt><dd>{hrSourceLabel(profile.source)}</dd></div>
        </dl>
        <p className="progress-muted progress-small">
          Max HR updates automatically when synced runs reach a higher heart rate.
        </p>
        <Link to="/settings?tab=profile" className="btn btn-secondary progress-link-btn">
          Edit heart rate in Settings
        </Link>
      </section>

      <section className="card" aria-labelledby="progress-hr-zones-title">
        <h2 id="progress-hr-zones-title" className="card-title">Running heart-rate zones</h2>
        <table className="progress-table">
          <caption className="progress-table-caption">
            Based on your max HR of {profile.maxHR} bpm (standard 5-zone model).
          </caption>
          <thead>
            <tr>
              <th scope="col">Zone</th>
              <th scope="col">Purpose</th>
              <th scope="col">Heart rate</th>
              <th scope="col">% of max</th>
            </tr>
          </thead>
          <tbody>
            {zones.map((z) => (
              <tr key={z.zone}>
                <th scope="row">
                  <span className="progress-zone-dot" style={{ background: z.color }} aria-hidden="true" />
                  Z{z.zone} {z.name}
                </th>
                <td>{z.description}</td>
                <td className="progress-num">{z.minBpm}–{z.maxBpm} bpm</td>
                <td className="progress-num">{z.minPct}–{z.maxPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {!hasData && (
        <section className="card" aria-labelledby="progress-hr-empty-title">
          <h2 id="progress-hr-empty-title" className="card-title">Your heart-rate data</h2>
          <EmptyState
            icon="❤️"
            title="No heart-rate data yet"
            action={<Link to="/settings?tab=connections" className="btn btn-primary">Connect a data source</Link>}
          >
            Connect intervals.icu or Strava to sync heart rate from your runs. intervals.icu also brings in
            Garmin, COROS, Polar, Suunto and Wahoo data.
          </EmptyState>
        </section>
      )}

      {distribution.totalTimeSec > 0 && (
        <section className="card" aria-labelledby="progress-hr-dist-title">
          <h2 id="progress-hr-dist-title" className="card-title">Zone distribution (last 30 days)</h2>
          <ZoneChart zones={distribution.zones} percentages={distribution.percentages} totalTimeSec={distribution.totalTimeSec} />
          <p className="progress-muted progress-small">
            {easyShare >= 60
              ? 'Good balance — most of your training is in easy/aerobic zones, which builds endurance efficiently.'
              : 'Consider spending more time in Zone 1-2. The 80/20 rule suggests 80% of training should be easy.'}
          </p>
        </section>
      )}

      {trend.length > 2 && (
        <section className="card" aria-labelledby="progress-hr-trend-title">
          <h2 id="progress-hr-trend-title" className="card-title">Heart-rate trend (30 days)</h2>
          <div
            className="progress-hr-trend"
            role="img"
            aria-label={`Average heart rate per run from ${trend[0].avgHR} bpm on ${formatDayLabel(trend[0].date)} to ${trend[trend.length - 1].avgHR} bpm on ${formatDayLabel(trend[trend.length - 1].date)}`}
          >
            {trend.map((pt) => {
              const pct = profile.maxHR > 0 ? (pt.avgHR / profile.maxHR) * 100 : 50;
              const level = pct > 85 ? 'high' : pct > 75 ? 'mid' : 'low';
              return (
                <div
                  key={`${pt.date}-${pt.avgHR}`}
                  title={`${formatDayLabel(pt.date)}: ${pt.avgHR} bpm`}
                  className={`progress-hr-bar is-${level}`}
                  style={{ height: `${Math.min(100, pct)}%` }}
                />
              );
            })}
          </div>
          <div className="progress-axis">
            <span>{formatDayLabel(trend[0].date)}</span>
            <span>{formatDayLabel(trend[trend.length - 1].date)}</span>
          </div>
        </section>
      )}
    </>
  );
}

// ── Recaps panel ──────────────────────────────────────────────────────────────

const GRADE_CLASS: Record<string, string> = {
  outstanding: 'is-outstanding',
  strong: 'is-strong',
  solid: 'is-solid',
  missed: 'is-missed',
  pending: 'is-pending',
  rest_day: 'is-rest',
};

function GradeChip({ grade }: { grade: string }) {
  return <span className={`progress-grade ${GRADE_CLASS[grade] ?? 'is-solid'}`}>{grade.replace(/_/g, ' ')}</span>;
}

function TodayRecapCard({ recap }: { recap: DailyRecap }) {
  return (
    <section className={`card progress-recap-today ${GRADE_CLASS[recap.grade] ?? ''}`} aria-labelledby="progress-recap-today-title">
      <h2 id="progress-recap-today-title" className="card-title">Today — {formatDayLabel(recap.date)}</h2>
      <div className="progress-recap-tags">
        <GradeChip grade={recap.grade} />
        <span className="progress-muted">Week {recap.weekNumber}</span>
        <span className="progress-muted">Planned: {recap.plannedWorkout}</span>
      </div>
      {recap.synced && (
        <div className="progress-stats">
          <div>
            <div className="progress-stat-label">Distance</div>
            <div className="progress-stat-value">{formatMiles(recap.actualDistanceMi)}</div>
            {recap.plannedDistanceMi > 0 && (
              <div className={`progress-small ${recap.metPlan ? 'progress-good' : 'progress-warn'}`}>
                {recap.distanceDiffMi >= 0 ? '+' : ''}{formatMiles(recap.distanceDiffMi)}{' '}
                ({recap.distanceDiffPct >= 0 ? '+' : ''}{recap.distanceDiffPct.toFixed(0)}%)
                {recap.metPlan ? ' · plan met' : ' · below plan'}
              </div>
            )}
          </div>
          <div>
            <div className="progress-stat-label">Pace</div>
            <div className="progress-stat-value">{formatPaceFromMinPerMi(recap.actualPaceMinPerMi)}</div>
          </div>
          <div>
            <div className="progress-stat-label">Duration</div>
            <div className="progress-stat-value">{formatDuration(recap.movingTimeSec)}</div>
          </div>
          {recap.avgHR ? (
            <div>
              <div className="progress-stat-label">Avg HR</div>
              <div className="progress-stat-value">{recap.avgHR} bpm</div>
            </div>
          ) : null}
          {recap.primaryZone && (
            <div>
              <div className="progress-stat-label">Zone</div>
              <div className="progress-stat-value">{recap.primaryZone}</div>
            </div>
          )}
        </div>
      )}
      <p className="progress-coach">{recap.coachMessage}</p>
    </section>
  );
}

interface RecapsData {
  today: DailyRecap | null;
  /** Recent recaps excluding today, newest first. */
  past: DailyRecap[];
}

/**
 * Recaps data. `fresh` generates (and saves) today's recap; otherwise the saved
 * one is read.
 */
function readRecaps(fresh: boolean): RecapsData {
  const key = todayKey();
  const today = fresh ? generateTodayRecap() : getDailyRecap(key);
  // 1.0.5 rendered the list only for > 1 recaps and the empty message only
  // for 0, so exactly one past recap showed a blank tab. Filter first.
  const past = getRecentRecaps(7).filter((r) => r.date !== key);
  return { today, past };
}

const readRecapsSnapshot = (): RecapsData => readRecaps(false);
const computeRecaps = (): RecapsData => readRecaps(true);

/** Recaps tab: today's recap and the recent ones. */
export function RecapsPanel() {
  const { today, past } = useRefreshingState(readRecapsSnapshot, computeRecaps);
  return (
    <>
      {today && <TodayRecapCard recap={today} />}
      <section className="card" aria-labelledby="progress-recaps-title">
        <h2 id="progress-recaps-title" className="card-title">Recent recaps</h2>
        {past.length > 0 ? (
          <ul className="progress-recap-list">
            {past.map((r) => (
              <li key={r.date} className="progress-recap-item">
                <div className="progress-recap-date">
                  <strong>{formatDayLabel(r.date)}</strong>
                  <span className="progress-muted">Wk {r.weekNumber}</span>
                </div>
                <GradeChip grade={r.grade} />
                <span className="progress-recap-summary">
                  {r.synced ? `${formatMiles(r.actualDistanceMi)} · ${formatPaceFromMinPerMi(r.actualPaceMinPerMi)}` : r.plannedWorkout}
                </span>
                {r.metPlan && (
                  <span className="progress-good progress-small">
                    <span aria-hidden="true">✓</span> Plan met
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon="📝"
            title={today ? 'No earlier recaps yet' : 'No recaps yet'}
            action={<Link to="/settings?tab=coaching" className="btn btn-secondary">Recap settings</Link>}
          >
            Recaps are generated after each activity sync or at your scheduled recap time.
          </EmptyState>
        )}
      </section>
    </>
  );
}

// ── Legacy route ──────────────────────────────────────────────────────────────

/** Old `/insights` page: everything moved to Progress. */
export default function Insights() {
  return <Navigate to="/progress" replace />;
}
