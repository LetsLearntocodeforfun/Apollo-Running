import { useState, useEffect } from 'react';
import { getActivePlan } from '../services/planProgress';
import { getPlanById } from '../data/plans';
import { getStravaTokens } from '../services/storage';
import {
  calculateRacePrediction,
  calculateTrainingAdherence,
  getSavedPrediction,
  getSavedAdherence,
  type RacePrediction,
  type TrainingAdherence,
} from '../services/racePrediction';
import {
  generateCurrentWeekReadiness,
  getAllReadinessScores,
  type ReadinessScore,
} from '../services/weeklyReadiness';
import {
  generateTodayRecap,
  getRecentRecaps,
  type DailyRecap,
} from '../services/dailyRecap';
import {
  getHRZones,
  getHRProfile,
  setHRProfile,
  getAggregateZoneDistribution,
  getHRTrend,
  type HRZone,
  type HRProfile,
} from '../services/heartRate';
import {
  getCoachingPreferences,
  setCoachingPreferences,
  WEEKDAY_NAMES,
} from '../services/coachingPreferences';

function formatPace(paceMinPerMi: number): string {
  if (!paceMinPerMi) return '—';
  const totalSec = Math.round(paceMinPerMi * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}/mi`;
}

/** Circular gauge component for scores */
function ScoreGauge({ score, size = 120, label, color }: { score: number; size?: number; label: string; color: string }) {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={8} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={8} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
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
      <span style={{ fontSize: '0.82rem', color: 'var(--text-muted)', textAlign: 'center' }}>{label}</span>
    </div>
  );
}

/** HR Zone bar chart */
function ZoneChart({ zones, percentages, totalTimeSec }: { zones: HRZone[]; percentages: number[]; totalTimeSec: number }) {
  const formatTime = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {zones.map((z, i) => (
        <div key={z.zone} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ width: 80, fontSize: '0.82rem', color: 'var(--text-muted)', flexShrink: 0 }}>
            <span style={{ color: z.color, fontWeight: 600 }}>Z{z.zone}</span> {z.name}
          </div>
          <div style={{ flex: 1, height: 20, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', position: 'relative' }}>
            <div style={{
              height: '100%', borderRadius: 4, background: z.color,
              width: `${Math.max(percentages[i], 1)}%`,
              transition: 'width 0.4s ease',
              opacity: 0.85,
            }} />
          </div>
          <span style={{ width: 40, fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'right' }}>
            {percentages[i]}%
          </span>
        </div>
      ))}
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
        Total training time (30d): {formatTime(totalTimeSec)}
      </div>
    </div>
  );
}

/** Mini trend sparkline (simple CSS-based) */
function TrendLine({ scores }: { scores: { week: number; score: number }[] }) {
  if (scores.length < 2) return null;
  const max = Math.max(...scores.map((s) => s.score), 100);
  return (
    <div style={{ display: 'flex', alignItems: 'end', gap: 3, height: 40, marginTop: '0.5rem' }}>
      {scores.map((s) => (
        <div
          key={s.week}
          title={`Week ${s.week}: ${s.score}%`}
          style={{
            flex: 1,
            height: `${(s.score / max) * 100}%`,
            background: s.score >= 80 ? 'var(--accent)' : s.score >= 60 ? '#f0a030' : '#f55',
            borderRadius: '2px 2px 0 0',
            minHeight: 2,
            transition: 'height 0.3s',
          }}
        />
      ))}
    </div>
  );
}

export default function Insights() {
  const [prediction, setPrediction] = useState<RacePrediction | null>(null);
  const [adherence, setAdherence] = useState<TrainingAdherence | null>(null);
  const [readiness, setReadiness] = useState<ReadinessScore | null>(null);
  const [allReadiness, setAllReadiness] = useState<ReadinessScore[]>([]);
  const [todayRecap, setTodayRecap] = useState<DailyRecap | null>(null);
  const [recentRecaps, setRecentRecaps] = useState<DailyRecap[]>([]);
  const [hrProfile, setHRProfileState] = useState<HRProfile>(getHRProfile());
  const [editingHR, setEditingHR] = useState(false);
  const [hrMax, setHRMax] = useState(String(hrProfile.maxHR));
  const [hrResting, setHRResting] = useState(String(hrProfile.restingHR));
  const [tab, setTab] = useState<'overview' | 'hr' | 'recaps' | 'settings'>('overview');

  const stravaConnected = !!getStravaTokens();
  const activePlan = getActivePlan();
  const plan = activePlan ? getPlanById(activePlan.planId) : null;
  useEffect(() => {
    // Load saved data first
    setPrediction(getSavedPrediction());
    setAdherence(getSavedAdherence());
    setAllReadiness(getAllReadinessScores());

    // Generate fresh scores
    if (activePlan && plan) {
      const pred = calculateRacePrediction();
      if (pred) setPrediction(pred);
      const adh = calculateTrainingAdherence();
      if (adh) setAdherence(adh);
      const rdy = generateCurrentWeekReadiness();
      if (rdy) setReadiness(rdy);
      setAllReadiness(getAllReadinessScores());
    }

    const recap = generateTodayRecap();
    if (recap) setTodayRecap(recap);
    setRecentRecaps(getRecentRecaps(7));
  }, []);

  const saveHRProfile = () => {
    const maxVal = parseInt(hrMax, 10);
    const restVal = parseInt(hrResting, 10);
    if (!maxVal || maxVal < 100 || maxVal > 230) return;
    if (!restVal || restVal < 30 || restVal > 120) return;
    const profile: HRProfile = { maxHR: maxVal, restingHR: restVal, source: 'manual', updatedAt: new Date().toISOString() };
    setHRProfile(profile);
    setHRProfileState(profile);
    setEditingHR(false);
  };

  const zones = getHRZones(hrProfile.maxHR);
  const zoneDist = getAggregateZoneDistribution(30);
  const hrTrend = getHRTrend(30);
  const prefs = getCoachingPreferences();

  // Days until race
  let daysUntilRace: number | null = null;
  if (plan && activePlan) {
    const raceWeek = plan.totalWeeks - 1;
    const raceDay = plan.weeks[raceWeek]?.days.findIndex((d) => d.type === 'marathon');
    if (raceDay != null && raceDay >= 0) {
      const startDate = new Date(activePlan.startDate + 'T00:00:00');
      const raceDateObj = new Date(startDate);
      raceDateObj.setDate(raceDateObj.getDate() + raceWeek * 7 + raceDay);
      const todayMid = new Date();
      todayMid.setHours(0, 0, 0, 0);
      daysUntilRace = Math.max(0, Math.round((raceDateObj.getTime() - todayMid.getTime()) / (24 * 60 * 60 * 1000)));
    }
  }

  const gradeColor = (grade: string) => {
    if (grade.startsWith('A')) return '#00c853';
    if (grade.startsWith('B')) return '#4FC3F7';
    if (grade.startsWith('C')) return '#f0a030';
    return '#f55';
  };

  return (
    <div>
      <h1 className="page-title">Insights</h1>

      {/* Tab navigation */}
      <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        {(['overview', 'hr', 'recaps', 'settings'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setTab(t)}
            style={{ textTransform: 'capitalize', fontSize: '0.9rem' }}
          >
            {t === 'hr' ? 'Heart Rate Zones' : t === 'recaps' ? 'Daily Recaps' : t === 'settings' ? 'Coaching Settings' : 'Overview'}
          </button>
        ))}
      </div>

      {/* ═══ OVERVIEW TAB ═══ */}
      {tab === 'overview' && (
        <>
          {!activePlan && (
            <div className="card">
              <p style={{ color: 'var(--text-muted)' }}>Choose a training plan to unlock race predictions, readiness scores, and coaching insights.</p>
            </div>
          )}

          {/* Race Day Countdown + Prediction hero card */}
          {activePlan && plan && (
            <div className="card" style={{
              background: 'linear-gradient(135deg, rgba(0,200,83,0.12) 0%, rgba(0,100,200,0.08) 100%)',
              borderColor: 'var(--accent)',
              borderWidth: 2,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
                <div>
                  <h3 style={{ margin: '0 0 0.25rem', fontSize: '1.2rem' }}>Race Day Prediction</h3>
                  <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.88rem' }}>
                    {plan.name} by {plan.author}
                    {daysUntilRace != null && (
                      <span style={{ marginLeft: '0.75rem', color: 'var(--accent)', fontWeight: 600 }}>
                        {daysUntilRace} days to race
                      </span>
                    )}
                  </p>
                </div>
                {prediction && prediction.trend !== 'stable' && (
                  <span style={{
                    fontSize: '0.78rem',
                    padding: '0.2rem 0.6rem',
                    borderRadius: 999,
                    background: prediction.trend === 'improving' ? 'rgba(0,200,83,0.2)' : 'rgba(255,80,80,0.2)',
                    color: prediction.trend === 'improving' ? 'var(--accent)' : '#f55',
                    fontWeight: 600,
                  }}>
                    {prediction.trend === 'improving' ? '▲ Improving' : '▼ Declining'}
                  </span>
                )}
              </div>

              {prediction ? (
                <div style={{ marginTop: '1.25rem' }}>
                  <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
                    <div>
                      <div style={{ fontSize: '2.5rem', fontWeight: 700, color: 'var(--accent)', lineHeight: 1 }}>
                        {prediction.marathonTimeFormatted}
                      </div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>Marathon</div>
                    </div>
                    <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.3rem', fontWeight: 600 }}>{prediction.halfMarathonFormatted}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Half Marathon</div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.3rem', fontWeight: 600 }}>{prediction.tenKFormatted}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>10K</div>
                      </div>
                      <div style={{ textAlign: 'center' }}>
                        <div style={{ fontSize: '1.3rem', fontWeight: 600 }}>{prediction.fiveKFormatted}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>5K</div>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    <span>VDOT: <strong style={{ color: 'var(--text)' }}>{prediction.vdot}</strong></span>
                    <span>Confidence: <strong style={{ color: 'var(--text)' }}>{prediction.confidence}%</strong></span>
                    <span>Method: {prediction.method.replace(/_/g, ' ')}</span>
                    {prediction.previousMarathonTimeSec && prediction.previousMarathonTimeSec !== prediction.marathonTimeSec && (
                      <span>
                        Prev: {Math.floor(prediction.previousMarathonTimeSec / 3600)}:{String(Math.floor((prediction.previousMarathonTimeSec % 3600) / 60)).padStart(2, '0')}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', marginTop: '1rem', fontSize: '0.9rem' }}>
                  {stravaConnected
                    ? 'Complete at least 3 runs to unlock your race time prediction. Sync your Strava activities to get started.'
                    : 'Connect Strava in Settings to start tracking your runs and building a race prediction.'}
                </p>
              )}
            </div>
          )}

          {/* Score Gauges Row */}
          {activePlan && (adherence || readiness) && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: '1.5rem' }}>
                {adherence && (
                  <ScoreGauge
                    score={adherence.score}
                    label="Training Adherence"
                    color={adherence.score >= 80 ? '#00c853' : adherence.score >= 60 ? '#f0a030' : '#f55'}
                  />
                )}
                {readiness && (
                  <ScoreGauge
                    score={readiness.score}
                    label={`Readiness Wk ${readiness.weekNumber}`}
                    color={gradeColor(readiness.grade)}
                  />
                )}
                {adherence && (
                  <ScoreGauge
                    score={adherence.distanceAdherence}
                    label="Distance Match"
                    color={adherence.distanceAdherence >= 90 ? '#00c853' : adherence.distanceAdherence >= 70 ? '#4FC3F7' : '#f0a030'}
                  />
                )}
                {adherence && (
                  <ScoreGauge
                    score={adherence.consistencyScore}
                    size={100}
                    label="Consistency"
                    color={adherence.consistencyScore >= 80 ? '#00c853' : '#f0a030'}
                  />
                )}
              </div>
            </div>
          )}

          {/* Adherence Details */}
          {adherence && (
            <div className="card">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Training Adherence
                <span style={{
                  fontSize: '0.78rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: 999,
                  background: adherence.rating === 'excellent' ? 'rgba(0,200,83,0.2)' : adherence.rating === 'good' ? 'rgba(79,195,247,0.2)' : 'rgba(240,160,48,0.2)',
                  color: adherence.rating === 'excellent' ? 'var(--accent)' : adherence.rating === 'good' ? '#4FC3F7' : '#f0a030',
                  fontWeight: 600,
                  textTransform: 'capitalize',
                }}>{adherence.rating}</span>
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Days Completed</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 600 }}>{adherence.completedDays} / {adherence.totalScheduledDays}</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Intensity Balance</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 600 }}>{adherence.intensityBalance}%</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Current Streak</div>
                  <div style={{ fontSize: '1.3rem', fontWeight: 600 }}>{adherence.currentStreak} days</div>
                </div>
              </div>
              {adherence.weeklyScores.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Weekly Adherence Trend</div>
                  <TrendLine scores={adherence.weeklyScores} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                    <span>Wk {adherence.weeklyScores[0]?.week}</span>
                    <span>Wk {adherence.weeklyScores[adherence.weeklyScores.length - 1]?.week}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Race Day Readiness */}
          {readiness && (
            <div className="card" style={{ borderLeft: `4px solid ${gradeColor(readiness.grade)}` }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                Race Day Readiness — Week {readiness.weekNumber}
                <span style={{
                  fontSize: '1.5rem',
                  fontWeight: 700,
                  color: gradeColor(readiness.grade),
                }}>{readiness.grade}</span>
                {readiness.trend !== 'stable' && (
                  <span style={{
                    fontSize: '0.78rem',
                    color: readiness.trend === 'improving' ? 'var(--accent)' : '#f55',
                  }}>
                    {readiness.trend === 'improving' ? '▲' : '▼'}
                  </span>
                )}
              </h3>

              {/* Sub-score bars */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1rem' }}>
                {[
                  { label: 'Volume', score: readiness.volumeScore },
                  { label: 'Consistency', score: readiness.consistencyScore },
                  { label: 'Long Run', score: readiness.longRunScore },
                  { label: 'Intensity', score: readiness.intensityScore },
                  { label: 'Recovery', score: readiness.recoveryScore },
                ].map((item) => (
                  <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ width: 80, fontSize: '0.82rem', color: 'var(--text-muted)' }}>{item.label}</span>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                      <div style={{
                        height: '100%', borderRadius: 4,
                        width: `${item.score}%`,
                        background: item.score >= 80 ? 'var(--accent)' : item.score >= 60 ? '#f0a030' : '#f55',
                        transition: 'width 0.4s',
                      }} />
                    </div>
                    <span style={{ width: 32, fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'right' }}>{item.score}</span>
                  </div>
                ))}
              </div>

              {readiness.strengths.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <strong style={{ fontSize: '0.88rem', color: 'var(--accent)' }}>What went well</strong>
                  {readiness.strengths.map((s, i) => (
                    <p key={i} style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{s}</p>
                  ))}
                </div>
              )}

              {readiness.improvements.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <strong style={{ fontSize: '0.88rem', color: '#f0a030' }}>Areas to improve</strong>
                  {readiness.improvements.map((s, i) => (
                    <p key={i} style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{s}</p>
                  ))}
                </div>
              )}

              {readiness.nextWeekTips.length > 0 && (
                <div>
                  <strong style={{ fontSize: '0.88rem', color: '#4FC3F7' }}>Tips for next week</strong>
                  {readiness.nextWeekTips.map((s, i) => (
                    <p key={i} style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{s}</p>
                  ))}
                </div>
              )}

              {readiness.predictedMarathon && (
                <div style={{ marginTop: '0.75rem', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  Predicted marathon: <strong style={{ color: 'var(--text)' }}>{readiness.predictedMarathon}</strong>
                  {readiness.daysUntilRace != null && (
                    <span style={{ marginLeft: '1rem' }}>{readiness.daysUntilRace} days to race</span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Readiness History */}
          {allReadiness.length > 1 && (
            <div className="card">
              <h3>Readiness History</h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {allReadiness.map((r) => (
                  <div key={r.weekNumber} style={{
                    padding: '0.5rem 0.75rem',
                    borderRadius: 8,
                    background: 'var(--bg)',
                    border: '1px solid var(--border)',
                    textAlign: 'center',
                    minWidth: 60,
                  }}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Wk {r.weekNumber}</div>
                    <div style={{ fontSize: '1.2rem', fontWeight: 700, color: gradeColor(r.grade) }}>{r.grade}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{r.score}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Today's Recap (compact) */}
          {todayRecap && todayRecap.grade !== 'rest_day' && (
            <div className="card" style={{
              borderLeft: `4px solid ${todayRecap.grade === 'outstanding' ? '#00c853' : todayRecap.grade === 'strong' ? '#4FC3F7' : todayRecap.grade === 'missed' ? '#f55' : '#f0a030'}`,
            }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                Today&apos;s Recap
                <span style={{
                  fontSize: '0.78rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: 999,
                  background: todayRecap.grade === 'outstanding' ? 'rgba(0,200,83,0.2)' : todayRecap.grade === 'strong' ? 'rgba(79,195,247,0.2)' : todayRecap.grade === 'missed' ? 'rgba(255,80,80,0.2)' : 'rgba(240,160,48,0.2)',
                  color: todayRecap.grade === 'outstanding' ? 'var(--accent)' : todayRecap.grade === 'strong' ? '#4FC3F7' : todayRecap.grade === 'missed' ? '#f55' : '#f0a030',
                  fontWeight: 600,
                  textTransform: 'capitalize',
                }}>{todayRecap.grade}</span>
              </h3>
              {todayRecap.synced && (
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.5rem', fontSize: '0.88rem' }}>
                  <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{todayRecap.actualDistanceMi.toFixed(1)} mi</span>
                  <span style={{ color: 'var(--text-muted)' }}>{formatPace(todayRecap.actualPaceMinPerMi)} pace</span>
                  {todayRecap.avgHR && <span style={{ color: 'var(--text-muted)' }}>{todayRecap.avgHR} bpm avg</span>}
                  {todayRecap.primaryZone && <span style={{ color: 'var(--text-muted)' }}>Zone: {todayRecap.primaryZone}</span>}
                </div>
              )}
              <p style={{ fontSize: '0.88rem', color: 'var(--text)', lineHeight: 1.5, margin: 0, fontStyle: 'italic' }}>
                {todayRecap.coachMessage}
              </p>
            </div>
          )}
        </>
      )}

      {/* ═══ HEART RATE TAB ═══ */}
      {tab === 'hr' && (
        <>
          {/* HR Profile */}
          <div className="card">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              Heart Rate Profile
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Source: {hrProfile.source}
                {hrProfile.updatedAt && ` · ${new Date(hrProfile.updatedAt).toLocaleDateString()}`}
              </span>
            </h3>
            {!editingHR ? (
              <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Max HR</div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#EF5350' }}>{hrProfile.maxHR} bpm</div>
                </div>
                <div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Resting HR</div>
                  <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#4FC3F7' }}>{hrProfile.restingHR} bpm</div>
                </div>
                {hrProfile.lthr && (
                  <div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Lactate Threshold</div>
                    <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#FFA726' }}>{hrProfile.lthr} bpm</div>
                  </div>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => setEditingHR(true)} style={{ fontSize: '0.85rem' }}>
                  Edit
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'end' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Max HR</span>
                  <input type="number" value={hrMax} onChange={(e) => setHRMax(e.target.value)}
                    style={{ width: 80, padding: '0.4rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Resting HR</span>
                  <input type="number" value={hrResting} onChange={(e) => setHRResting(e.target.value)}
                    style={{ width: 80, padding: '0.4rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }} />
                </label>
                <button type="button" className="btn btn-primary" onClick={saveHRProfile} style={{ fontSize: '0.85rem' }}>Save</button>
                <button type="button" className="btn btn-secondary" onClick={() => setEditingHR(false)} style={{ fontSize: '0.85rem' }}>Cancel</button>
              </div>
            )}
            <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '0.75rem 0 0', lineHeight: 1.4 }}>
              Your max HR auto-updates when Strava activities with higher heart rate data are synced. Manually set it here for more accurate zone calculations.
            </p>
          </div>

          {/* Zone Definitions */}
          <div className="card">
            <h3>Running Heart Rate Zones</h3>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: '1rem', lineHeight: 1.4 }}>
              Based on your max HR of {hrProfile.maxHR} bpm. Zones match the standard 5-zone model used by Strava and Garmin.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {zones.map((z) => (
                <div key={z.zone} style={{
                  display: 'flex', alignItems: 'center', gap: '1rem',
                  padding: '0.6rem 1rem', borderRadius: 8,
                  background: 'var(--bg)', border: '1px solid var(--border)',
                }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: z.color, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '0.9rem', color: '#fff', flexShrink: 0 }}>
                    {z.zone}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{z.name}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{z.description}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontWeight: 600 }}>{z.minBpm}–{z.maxBpm}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{z.minPct}–{z.maxPct}%</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Zone Distribution (30 days) */}
          {zoneDist.totalTimeSec > 0 && (
            <div className="card">
              <h3>Zone Distribution (Last 30 Days)</h3>
              <ZoneChart zones={zoneDist.zones} percentages={zoneDist.percentages} totalTimeSec={zoneDist.totalTimeSec} />
              <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: '0.75rem 0 0', lineHeight: 1.4 }}>
                {zoneDist.percentages[0] + zoneDist.percentages[1] >= 60
                  ? 'Good balance — most of your training is in easy/aerobic zones, which builds endurance efficiently.'
                  : 'Consider spending more time in Zone 1-2. The 80/20 rule suggests 80% of training should be easy.'}
              </p>
            </div>
          )}

          {/* HR Trend */}
          {hrTrend.length > 2 && (
            <div className="card">
              <h3>Heart Rate Trend (30 Days)</h3>
              <div style={{ display: 'flex', alignItems: 'end', gap: 4, height: 60 }}>
                {hrTrend.map((pt) => {
                  const pct = hrProfile.maxHR > 0 ? (pt.avgHR / hrProfile.maxHR) * 100 : 50;
                  return (
                    <div
                      key={pt.date}
                      title={`${pt.date}: ${pt.avgHR} bpm`}
                      style={{
                        flex: 1, height: `${pct}%`, minHeight: 4,
                        background: pct > 85 ? '#EF5350' : pct > 75 ? '#FFA726' : '#4FC3F7',
                        borderRadius: '2px 2px 0 0',
                        transition: 'height 0.3s',
                      }}
                    />
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                <span>{hrTrend[0]?.date}</span>
                <span>{hrTrend[hrTrend.length - 1]?.date}</span>
              </div>
            </div>
          )}

          {!stravaConnected && (
            <div className="card">
              <p style={{ color: 'var(--text-muted)' }}>
                Connect <strong>Strava</strong> in Settings to automatically sync heart rate data from your runs. Garmin data is also supported when connected.
              </p>
            </div>
          )}
        </>
      )}

      {/* ═══ RECAPS TAB ═══ */}
      {tab === 'recaps' && (
        <>
          {todayRecap && (
            <div className="card" style={{
              borderLeft: `4px solid ${todayRecap.grade === 'outstanding' ? '#00c853' : todayRecap.grade === 'strong' ? '#4FC3F7' : todayRecap.grade === 'missed' ? '#f55' : todayRecap.grade === 'rest_day' ? 'var(--border)' : '#f0a030'}`,
            }}>
              <h3>Today — {todayRecap.date}</h3>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.75rem' }}>
                <span style={{
                  fontSize: '0.82rem', padding: '0.2rem 0.6rem', borderRadius: 999, fontWeight: 600,
                  textTransform: 'capitalize',
                  background: todayRecap.grade === 'outstanding' ? 'rgba(0,200,83,0.2)' : todayRecap.grade === 'strong' ? 'rgba(79,195,247,0.2)' : todayRecap.grade === 'missed' ? 'rgba(255,80,80,0.2)' : todayRecap.grade === 'rest_day' ? 'rgba(255,255,255,0.06)' : 'rgba(240,160,48,0.2)',
                  color: todayRecap.grade === 'outstanding' ? 'var(--accent)' : todayRecap.grade === 'strong' ? '#4FC3F7' : todayRecap.grade === 'missed' ? '#f55' : todayRecap.grade === 'rest_day' ? 'var(--text-muted)' : '#f0a030',
                }}>{todayRecap.grade.replace('_', ' ')}</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Week {todayRecap.weekNumber}</span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Planned: {todayRecap.plannedWorkout}</span>
              </div>
              {todayRecap.synced && (
                <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
                  <div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Distance</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--accent)' }}>{todayRecap.actualDistanceMi.toFixed(1)} mi</div>
                    {todayRecap.plannedDistanceMi > 0 && (
                      <div style={{ fontSize: '0.72rem', color: todayRecap.metPlan ? 'var(--accent)' : '#f0a030' }}>
                        {todayRecap.distanceDiffMi >= 0 ? '+' : ''}{todayRecap.distanceDiffMi.toFixed(1)} mi ({todayRecap.distanceDiffPct >= 0 ? '+' : ''}{todayRecap.distanceDiffPct.toFixed(0)}%)
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Pace</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{formatPace(todayRecap.actualPaceMinPerMi)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Duration</div>
                    <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{Math.floor(todayRecap.movingTimeSec / 60)}m</div>
                  </div>
                  {todayRecap.avgHR && (
                    <div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Avg HR</div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{todayRecap.avgHR} bpm</div>
                    </div>
                  )}
                  {todayRecap.primaryZone && (
                    <div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Zone</div>
                      <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{todayRecap.primaryZone}</div>
                    </div>
                  )}
                </div>
              )}
              <div style={{ background: 'var(--bg)', borderRadius: 8, padding: '0.75rem 1rem', fontSize: '0.88rem', lineHeight: 1.5, fontStyle: 'italic', color: 'var(--text)' }}>
                {todayRecap.coachMessage}
              </div>
              {todayRecap.predictedMarathon && (
                <div style={{ marginTop: '0.5rem', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  Current marathon prediction: <strong style={{ color: 'var(--accent)' }}>{todayRecap.predictedMarathon}</strong>
                </div>
              )}
            </div>
          )}

          {recentRecaps.length > 1 && (
            <div className="card">
              <h3>Recent Recaps</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {recentRecaps.filter((r) => r.date !== todayRecap?.date).map((r) => (
                  <div key={r.date} style={{
                    display: 'flex', alignItems: 'center', gap: '1rem',
                    padding: '0.6rem 1rem', borderRadius: 8,
                    background: 'var(--bg)', border: '1px solid var(--border)',
                  }}>
                    <div style={{ minWidth: 80 }}>
                      <div style={{ fontSize: '0.82rem', fontWeight: 600 }}>{r.date}</div>
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Wk {r.weekNumber}</div>
                    </div>
                    <span style={{
                      fontSize: '0.72rem', padding: '0.1rem 0.4rem', borderRadius: 999, fontWeight: 600,
                      textTransform: 'capitalize',
                      background: r.grade === 'outstanding' ? 'rgba(0,200,83,0.2)' : r.grade === 'strong' ? 'rgba(79,195,247,0.2)' : r.grade === 'missed' ? 'rgba(255,80,80,0.2)' : 'rgba(240,160,48,0.2)',
                      color: r.grade === 'outstanding' ? 'var(--accent)' : r.grade === 'strong' ? '#4FC3F7' : r.grade === 'missed' ? '#f55' : '#f0a030',
                    }}>{r.grade.replace('_', ' ')}</span>
                    <div style={{ flex: 1, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                      {r.synced ? `${r.actualDistanceMi.toFixed(1)} mi · ${formatPace(r.actualPaceMinPerMi)}` : r.plannedWorkout}
                    </div>
                    {r.metPlan && <span style={{ color: 'var(--accent)', fontSize: '0.82rem' }}>✓</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {recentRecaps.length === 0 && (
            <div className="card">
              <p style={{ color: 'var(--text-muted)' }}>No recaps yet. Recaps are generated after each Strava sync or at your scheduled recap time.</p>
            </div>
          )}
        </>
      )}

      {/* ═══ SETTINGS TAB ═══ */}
      {tab === 'settings' && (
        <>
          <div className="card">
            <h3>Daily Recap</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={prefs.dailyRecapEnabled}
                  onChange={(e) => setCoachingPreferences({ dailyRecapEnabled: e.target.checked })}
                  style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
                />
                <span>Enable daily training recap</span>
              </label>
              {prefs.dailyRecapEnabled && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>Time:</span>
                  <input
                    type="time"
                    value={prefs.dailyRecapTime}
                    onChange={(e) => setCoachingPreferences({ dailyRecapTime: e.target.value })}
                    style={{
                      padding: '0.4rem 0.5rem', borderRadius: 8,
                      border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          <div className="card">
            <h3>Weekly Race Day Readiness</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={prefs.weeklyRecapEnabled}
                  onChange={(e) => setCoachingPreferences({ weeklyRecapEnabled: e.target.checked })}
                  style={{ width: 18, height: 18, accentColor: 'var(--accent)' }}
                />
                <span>Enable weekly readiness score</span>
              </label>
              {prefs.weeklyRecapEnabled && (
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>Show on:</span>
                  <select
                    value={prefs.weeklyRecapDay}
                    onChange={(e) => setCoachingPreferences({ weeklyRecapDay: Number(e.target.value) })}
                    style={{
                      padding: '0.4rem 0.5rem', borderRadius: 8,
                      border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                    }}
                  >
                    {WEEKDAY_NAMES.map((name, i) => (
                      <option key={i} value={i}>{name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '0.5rem' }}>
              Best set to the day after your weekly long run or the end of the training week.
            </p>
          </div>

          <div className="card">
            <h3>About Insights</h3>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.88rem', lineHeight: 1.6 }}>
              <p><strong>Race Day Prediction</strong> uses the VDOT model (Jack Daniels Running Formula) and Riegel formula, blended with your actual training pace data and heart rate efficiency. Predictions improve as you log more runs.</p>
              <p><strong>Training Adherence</strong> measures completion rate, distance accuracy, consistency, and intensity balance against your chosen plan.</p>
              <p><strong>Race Day Readiness</strong> is a weekly composite score evaluating volume, consistency, long run completion, effort appropriateness, and recovery balance.</p>
              <p><strong>Heart Rate Zones</strong> are automatically populated from Strava or Garmin data. Your max HR updates when higher values are detected. Zone analysis helps ensure you&apos;re training at the right intensities.</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
