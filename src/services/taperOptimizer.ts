/**
 * Taper Optimization Model — based on Banister's fitness-fatigue
 * impulse-response model.
 *
 * Models:
 * - CTL (Chronic Training Load) — 42-day exponentially weighted moving average
 * - ATL (Acute Training Load)   — 7-day exponentially weighted moving average
 * - TSB (Training Stress Balance) = CTL - ATL (form/freshness)
 *
 * Optimal taper: maximize TSB on race day while preserving CTL.
 * Research: Banister (1991), Thomas & Busso (2005), Mujika (2010)
 */

import { persistence } from './db/persistence';

const TAPER_KEY = 'apollo_taper_model';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DailyTrainingLoad {
  date: string; // YYYY-MM-DD
  /** Training stress score — can be from pace/HR/distance */
  tss: number;
  /** Distance in miles */
  distanceMi: number;
  /** Effort type */
  type: 'easy' | 'tempo' | 'long_run' | 'interval' | 'race' | 'rest';
}

export interface FitnessFatigueSnapshot {
  date: string;
  ctl: number; // chronic training load (fitness)
  atl: number; // acute training load (fatigue)
  tsb: number; // training stress balance (form)
}

export interface TaperRecommendation {
  /** Days before race to start taper */
  taperStartDays: number;
  /** Total taper length in days */
  taperLengthDays: number;
  /** Weekly volume reduction schedule */
  weeklyReductions: TaperWeek[];
  /** Key intensity sessions to maintain */
  intensitySessions: string[];
  /** Projected TSB on race day */
  projectedRaceDayTSB: number;
  /** Current fitness (CTL) */
  currentCTL: number;
  /** Current form (TSB) */
  currentTSB: number;
  /** Overall taper summary */
  summary: string;
}

export interface TaperWeek {
  weekNumber: number;
  /** Weeks before race */
  weeksOut: number;
  /** Percentage of peak volume to run */
  volumePct: number;
  /** Total TSS target for the week */
  tssTarget: number;
  /** Guidance */
  guidance: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CTL_DAYS = 42; // fitness time constant
const ATL_DAYS = 7;  // fatigue time constant
const CTL_DECAY = 1 - Math.exp(-1 / CTL_DAYS);
const ATL_DECAY = 1 - Math.exp(-1 / ATL_DAYS);

/** TSB sweet spot for race day: +15 to +25 */
const IDEAL_TSB_MIN = 15;
const IDEAL_TSB_MAX = 25;

// ── Core Model ────────────────────────────────────────────────────────────────

/**
 * Calculate CTL, ATL, TSB for each day from training history.
 */
export function calculateFitnessFatigue(
  history: DailyTrainingLoad[],
): FitnessFatigueSnapshot[] {
  if (history.length === 0) return [];

  // Sort chronologically
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));

  // Fill in rest days (TSS = 0)
  const filled = fillMissingDays(sorted);

  let ctl = 0;
  let atl = 0;
  const snapshots: FitnessFatigueSnapshot[] = [];

  for (const day of filled) {
    ctl = ctl + CTL_DECAY * (day.tss - ctl);
    atl = atl + ATL_DECAY * (day.tss - atl);

    snapshots.push({
      date: day.date,
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      tsb: Math.round((ctl - atl) * 10) / 10,
    });
  }

  return snapshots;
}

/**
 * Get the latest fitness/fatigue snapshot.
 */
export function getCurrentFitness(history: DailyTrainingLoad[]): FitnessFatigueSnapshot | null {
  const snapshots = calculateFitnessFatigue(history);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

// ── Taper Optimization ────────────────────────────────────────────────────────

/**
 * Generate an optimal taper recommendation based on current fitness.
 */
export function generateTaperPlan(
  history: DailyTrainingLoad[],
  raceDateStr: string,
): TaperRecommendation {
  const snapshots = calculateFitnessFatigue(history);
  const current = snapshots.length > 0 ? snapshots[snapshots.length - 1] : { ctl: 50, atl: 50, tsb: 0, date: '' };

  const currentCTL = current.ctl;
  const currentTSB = current.tsb;

  // Determine taper length based on CTL
  const taperLengthDays = calculateOptimalTaperLength(currentCTL);
  const taperStartDays = taperLengthDays;

  // Calculate weekly reductions
  const weeklyReductions = calculateWeeklyReductions(currentCTL, taperLengthDays);

  // Project race day TSB
  const projectedTSB = projectRaceDayTSB(current, taperLengthDays);

  // Intensity maintenance sessions
  const intensitySessions = [
    'Short marathon-pace pickups (4-6 × 1 min at MP) in taper week 1',
    '2-3 × 200m strides at 5K pace twice during taper to maintain neuromuscular sharpness',
    'One 4-mile tempo at marathon pace, 5-7 days before race',
    'Race-week: 2-3 easy shake-out runs with 4 × 100m strides',
  ];

  const summary = buildTaperSummary(taperStartDays, currentCTL, currentTSB, projectedTSB, weeklyReductions);

  return {
    taperStartDays,
    taperLengthDays,
    weeklyReductions,
    intensitySessions,
    projectedRaceDayTSB: projectedTSB,
    currentCTL,
    currentTSB,
    summary,
  };
}

/**
 * Estimate TSS from a run (simplified model when actual TSS isn't available).
 */
export function estimateTSS(
  distanceMi: number,
  durationMin: number,
  type: DailyTrainingLoad['type'],
): number {
  // Base: distance × intensity factor
  const intensityFactors: Record<string, number> = {
    rest: 0,
    easy: 5,
    long_run: 6,
    tempo: 8,
    interval: 10,
    race: 12,
  };

  const factor = intensityFactors[type] || 5;
  const tss = distanceMi * factor;

  // Duration adjustment: longer runs at same distance are harder
  const expectedDuration = distanceMi * 9; // ~9 min/mile average
  const durationFactor = durationMin > 0 ? Math.max(0.8, Math.min(1.3, durationMin / expectedDuration)) : 1;

  return Math.round(tss * durationFactor);
}

// ── Internal ──────────────────────────────────────────────────────────────────

function calculateOptimalTaperLength(ctl: number): number {
  // Higher fitness = longer taper (more fatigue to shed)
  if (ctl >= 100) return 21; // 3 weeks
  if (ctl >= 70) return 16;  // ~2.5 weeks
  if (ctl >= 50) return 14;  // 2 weeks
  return 10; // lower fitness, shorter taper
}

function calculateWeeklyReductions(currentCTL: number, taperDays: number): TaperWeek[] {
  const weeks = Math.ceil(taperDays / 7);
  const peakWeeklyTSS = currentCTL * 7; // approximate peak weekly TSS
  const result: TaperWeek[] = [];

  for (let w = 1; w <= weeks; w++) {
    let volumePct: number;
    let guidance: string;

    if (w === 1) {
      volumePct = 60;
      guidance = 'Cut volume to 60%. Keep 2 quality sessions but shorter. Maintain marathon pace feel.';
    } else if (w === 2) {
      volumePct = 40;
      guidance = 'Cut volume to 40%. One short tempo, one set of strides. Everything else easy.';
    } else {
      volumePct = 25;
      guidance = 'Race week: minimal volume. 2-3 easy shake-outs + strides. Rest and visualize.';
    }

    result.push({
      weekNumber: w,
      weeksOut: weeks - w + 1,
      volumePct,
      tssTarget: Math.round(peakWeeklyTSS * volumePct / 100),
      guidance,
    });
  }

  return result;
}

function projectRaceDayTSB(current: FitnessFatigueSnapshot, taperDays: number): number {
  // Simulate taper with exponentially decreasing TSS
  let ctl = current.ctl;
  let atl = current.atl;

  for (let d = 0; d < taperDays; d++) {
    // Gradually reduce daily TSS during taper
    const progress = d / taperDays;
    const dailyTSS = current.ctl * (0.5 - 0.4 * progress); // from ~50% to ~10% of CTL

    ctl = ctl + CTL_DECAY * (dailyTSS - ctl);
    atl = atl + ATL_DECAY * (dailyTSS - atl);
  }

  return Math.round((ctl - atl) * 10) / 10;
}

function fillMissingDays(sorted: DailyTrainingLoad[]): DailyTrainingLoad[] {
  if (sorted.length <= 1) return sorted;

  const filled: DailyTrainingLoad[] = [];
  const start = new Date(sorted[0].date);
  const end = new Date(sorted[sorted.length - 1].date);

  // Build a map for O(1) lookup
  const dayMap = new Map<string, DailyTrainingLoad>();
  for (const d of sorted) {
    dayMap.set(d.date, d);
  }

  const current = new Date(start);
  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    filled.push(dayMap.get(dateStr) || { date: dateStr, tss: 0, distanceMi: 0, type: 'rest' });
    current.setDate(current.getDate() + 1);
  }

  return filled;
}

function buildTaperSummary(
  taperStartDays: number,
  ctl: number,
  currentTSB: number,
  projectedTSB: number,
  weeks: TaperWeek[],
): string {
  const weekPcts = weeks.map((w) => `Week ${w.weekNumber}: ${w.volumePct}%`).join(', ');
  const tsbStatus = projectedTSB >= IDEAL_TSB_MIN && projectedTSB <= IDEAL_TSB_MAX
    ? 'optimal range'
    : projectedTSB < IDEAL_TSB_MIN
      ? 'slightly under-rested — consider extending taper'
      : 'well-rested';

  return `Start your taper ${taperStartDays} days out. Your current fitness (CTL) is ${ctl.toFixed(0)} with form (TSB) at ${currentTSB.toFixed(0)}. Volume reduction: ${weekPcts}. Maintain 2 short intensity sessions per week to preserve neuromuscular sharpness. Projected race day TSB: ${projectedTSB.toFixed(0)} (${tsbStatus}).`;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function saveTrainingLoad(load: DailyTrainingLoad): void {
  const history = getTrainingLoadHistory();
  const idx = history.findIndex((h) => h.date === load.date);
  if (idx >= 0) {
    history[idx] = load;
  } else {
    history.push(load);
  }
  // Keep last 365 days
  if (history.length > 365) history.splice(0, history.length - 365);
  persistence.setItem(TAPER_KEY, JSON.stringify(history));
}

export function getTrainingLoadHistory(): DailyTrainingLoad[] {
  try {
    const raw = persistence.getItem(TAPER_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
