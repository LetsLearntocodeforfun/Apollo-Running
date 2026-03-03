/**
 * Training Periodization Service
 *
 * Detects and models the periodization phases of a training plan:
 *   Base → Build → Peak → Taper → Race
 *
 * Phase detection uses mileage trajectory, workout mix, and plan position.
 * Each phase carries coaching context that adapts recommendations.
 *
 * References:
 * - Daniels, J. "Daniels' Running Formula" (periodization chapters)
 * - Pfitzinger, P. "Advanced Marathoning" (mesocycle structure)
 * - Lydiard, A. "Running to the Top" (base → sharpening model)
 */

import type { TrainingPlan, PlanWeek } from '../data/plans';
import { persistence } from './db/persistence';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PhaseName = 'base' | 'build' | 'peak' | 'taper' | 'race';

export interface TrainingPhase {
  name: PhaseName;
  label: string;
  /** 0-based week index where this phase starts (inclusive) */
  startWeek: number;
  /** 0-based week index where this phase ends (inclusive) */
  endWeek: number;
  /** Coaching message for this phase */
  coachingMessage: string;
  /** Color for UI rendering */
  color: string;
}

export interface PeriodizationResult {
  /** All detected phases across the plan */
  phases: TrainingPhase[];
  /** Current phase (based on currentWeek) */
  currentPhase: TrainingPhase | null;
  /** Weeks remaining in current phase */
  weeksRemainingInPhase: number;
  /** Overall plan progress 0-100 */
  overallProgressPct: number;
  /** Next phase (if any) */
  nextPhase: TrainingPhase | null;
  /** Phase transition message (if within 1 week of next phase) */
  transitionMessage: string | null;
}

export interface WeekProfile {
  weekNumber: number;
  totalMiles: number;
  longRunMiles: number;
  hasTempoOrSpeed: boolean;
  hasMarathonPace: boolean;
  isRaceWeek: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PERIODIZATION_KEY = 'apollo_periodization_cache';

const PHASE_COLORS: Record<PhaseName, string> = {
  base: '#4FC3F7',     // light blue
  build: '#66BB6A',    // green
  peak: '#FFA726',     // orange
  taper: '#AB47BC',    // purple
  race: '#EF5350',     // red
};

const PHASE_LABELS: Record<PhaseName, string> = {
  base: 'Base Building',
  build: 'Build Phase',
  peak: 'Peak Training',
  taper: 'Taper',
  race: 'Race Week',
};

const COACHING_MESSAGES: Record<PhaseName, string> = {
  base: 'Focus on building aerobic volume. Keep 80% of runs easy. Consistency matters more than speed right now.',
  build: 'Time to layer in marathon-specific work. Tempo and marathon-pace runs are your priority. Volume continues to climb.',
  peak: 'This is your highest-stress block. Trust the fatigue — fitness is banking. Your hardest long runs happen here.',
  taper: 'Reduce volume but keep some intensity. Your body is absorbing weeks of work. Rest is productive now.',
  race: 'Trust your training. Execute your strategy. The hay is in the barn.',
};

// ── Week Analysis ─────────────────────────────────────────────────────────────

/** Extract a structural profile from a single plan week. */
export function analyzeWeek(week: PlanWeek): WeekProfile {
  let totalMiles = 0;
  let longRunMiles = 0;
  let hasTempoOrSpeed = false;
  let hasMarathonPace = false;
  let isRaceWeek = false;

  for (const day of week.days) {
    const mi = day.distanceMi ?? 0;
    totalMiles += mi;

    if (day.type === 'marathon' || day.type === 'race') {
      isRaceWeek = true;
    }

    const note = (day.note ?? '').toLowerCase();
    const label = (day.label ?? '').toLowerCase();

    // Detect long runs
    if (note.includes('long') || label.includes('long') || mi >= 13) {
      longRunMiles = Math.max(longRunMiles, mi);
    }

    // Detect quality workouts
    if (note.includes('tempo') || note.includes('speed') || note.includes('interval') ||
        label.includes('tempo') || label.includes('speed') || label.includes('interval')) {
      hasTempoOrSpeed = true;
    }

    if (note.includes('marathon') || note.includes('mp') ||
        label.includes('marathon pace') || label.includes('mp run')) {
      hasMarathonPace = true;
    }
  }

  return {
    weekNumber: week.weekNumber,
    totalMiles: Math.round(totalMiles * 10) / 10,
    longRunMiles: Math.round(longRunMiles * 10) / 10,
    hasTempoOrSpeed,
    hasMarathonPace,
    isRaceWeek,
  };
}

// ── Phase Detection ───────────────────────────────────────────────────────────

/**
 * Detect periodization phases from a training plan's structure.
 *
 * Algorithm:
 * 1. Race week: last week with a marathon/race day
 * 2. Taper: 2-3 weeks before race where mileage drops ≥ 20% from peak
 * 3. Peak: highest-mileage weeks (typically 2-4 weeks)
 * 4. Build: weeks between base and peak with increasing quality workouts
 * 5. Base: early weeks with mostly easy running and gradual mileage increase
 */
export function detectPhases(plan: TrainingPlan): TrainingPhase[] {
  const totalWeeks = plan.weeks.length;
  if (totalWeeks === 0) return [];

  const profiles = plan.weeks.map(analyzeWeek);
  const phases: TrainingPhase[] = [];

  // 1. Find race week (last week with marathon/race)
  let raceWeekIdx = totalWeeks - 1;
  for (let i = totalWeeks - 1; i >= 0; i--) {
    if (profiles[i].isRaceWeek) {
      raceWeekIdx = i;
      break;
    }
  }

  // 2. Find peak mileage
  const peakMiles = Math.max(...profiles.slice(0, raceWeekIdx).map((p) => p.totalMiles));

  // 3. Detect taper: consecutive weeks of declining mileage before race
  let taperStart = raceWeekIdx;
  for (let i = raceWeekIdx - 1; i >= 0; i--) {
    if (profiles[i].totalMiles < peakMiles * 0.8) {
      taperStart = i;
    } else {
      break;
    }
  }
  // Taper is minimum 1 week (race week itself if no taper detected)
  if (taperStart === raceWeekIdx && raceWeekIdx > 0) {
    taperStart = raceWeekIdx - 1;
  }

  // 4. Find peak phase: weeks at or near peak mileage
  let peakStart = taperStart - 1;
  const peakThreshold = peakMiles * 0.9;
  while (peakStart > 0 && profiles[peakStart - 1].totalMiles >= peakThreshold) {
    peakStart--;
  }
  // Peak is at least 1 week
  peakStart = Math.max(0, Math.min(peakStart, taperStart - 1));
  const peakEnd = taperStart - 1;

  // 5. Determine base/build split
  // Build starts when quality workouts (tempo/speed) become regular
  const remainingWeeks = peakStart;
  let buildStart: number;

  if (remainingWeeks <= 2) {
    // Very short plan — everything before peak is base
    buildStart = peakStart;
  } else {
    // Find first week that has tempo/speed AND is past the first third
    const oneThird = Math.floor(remainingWeeks / 3);
    buildStart = peakStart; // default: no build phase
    for (let i = oneThird; i < peakStart; i++) {
      if (profiles[i].hasTempoOrSpeed || profiles[i].hasMarathonPace) {
        buildStart = i;
        break;
      }
    }
    // If no quality workouts found, split base/build at midpoint
    if (buildStart >= peakStart) {
      buildStart = Math.floor(remainingWeeks * 0.55);
    }
  }

  // Build phases array
  if (buildStart > 0) {
    phases.push(makePhase('base', 0, buildStart - 1));
  }

  if (buildStart < peakStart) {
    phases.push(makePhase('build', buildStart, peakStart - 1));
  }

  if (peakStart <= peakEnd) {
    phases.push(makePhase('peak', peakStart, peakEnd));
  }

  if (taperStart < raceWeekIdx) {
    phases.push(makePhase('taper', taperStart, raceWeekIdx - 1));
  }

  phases.push(makePhase('race', raceWeekIdx, raceWeekIdx));

  return phases;
}

function makePhase(name: PhaseName, startWeek: number, endWeek: number): TrainingPhase {
  return {
    name,
    label: PHASE_LABELS[name],
    startWeek,
    endWeek,
    coachingMessage: COACHING_MESSAGES[name],
    color: PHASE_COLORS[name],
  };
}

// ── Current Phase Resolution ──────────────────────────────────────────────────

/**
 * Build a full periodization result for the current training state.
 *
 * @param plan - The active training plan
 * @param currentWeek - 0-based current week index
 */
export function getPeriodization(plan: TrainingPlan, currentWeek: number): PeriodizationResult {
  const phases = detectPhases(plan);

  const currentPhase = phases.find(
    (p) => currentWeek >= p.startWeek && currentWeek <= p.endWeek,
  ) ?? null;

  const weeksRemainingInPhase = currentPhase
    ? currentPhase.endWeek - currentWeek
    : 0;

  const overallProgressPct = plan.totalWeeks > 0
    ? Math.round(((currentWeek + 1) / plan.totalWeeks) * 100)
    : 0;

  const currentIdx = currentPhase ? phases.indexOf(currentPhase) : -1;
  const nextPhase = currentIdx >= 0 && currentIdx < phases.length - 1
    ? phases[currentIdx + 1]
    : null;

  let transitionMessage: string | null = null;
  if (nextPhase && weeksRemainingInPhase <= 1) {
    transitionMessage = getTransitionMessage(currentPhase!.name, nextPhase.name);
  }

  return {
    phases,
    currentPhase,
    weeksRemainingInPhase,
    overallProgressPct,
    nextPhase,
    transitionMessage,
  };
}

function getTransitionMessage(from: PhaseName, to: PhaseName): string {
  const transitions: Record<string, string> = {
    'base→build': 'Your aerobic foundation is set. Time to add quality work — tempo and marathon-pace runs will sharpen your fitness.',
    'build→peak': 'Entering your highest-volume block. These weeks are the hardest but most productive. Stay on top of recovery.',
    'peak→taper': 'Peak training is done. Now let your body absorb the work. Reduced volume with maintained intensity is the formula.',
    'taper→race': 'Race week! You\'re ready. Focus on logistics, nutrition, and mental preparation. Trust the training.',
  };
  return transitions[`${from}→${to}`] ?? `Moving from ${PHASE_LABELS[from]} to ${PHASE_LABELS[to]}.`;
}

// ── Phase-Aware Coaching ──────────────────────────────────────────────────────

export interface PhaseCoachingTip {
  category: string;
  tip: string;
  priority: 'high' | 'medium' | 'low';
}

/**
 * Generate phase-specific coaching tips based on training context.
 */
export function getPhaseCoachingTips(
  phase: PhaseName,
  weekProfile: WeekProfile,
): PhaseCoachingTip[] {
  const tips: PhaseCoachingTip[] = [];

  switch (phase) {
    case 'base':
      tips.push({ category: 'Pacing', tip: 'Keep all runs conversational. If you can\'t talk in complete sentences, you\'re running too fast.', priority: 'high' });
      tips.push({ category: 'Volume', tip: 'Increase weekly mileage by no more than 10% per week. Consistency beats heroics.', priority: 'high' });
      if (weekProfile.longRunMiles > 0) {
        tips.push({ category: 'Long Run', tip: `Your long run of ${weekProfile.longRunMiles} mi builds the aerobic engine. Run it easy and stay fueled.`, priority: 'medium' });
      }
      tips.push({ category: 'Recovery', tip: 'Prioritize sleep — this is when adaptation happens. Target 7-9 hours.', priority: 'medium' });
      break;

    case 'build':
      tips.push({ category: 'Quality', tip: 'Quality sessions are king. Nail your tempo and marathon-pace runs; easy days should be genuinely easy.', priority: 'high' });
      if (!weekProfile.hasTempoOrSpeed) {
        tips.push({ category: 'Missing Workout', tip: 'No speed or tempo work this week. Consider adding strides to one easy run.', priority: 'medium' });
      }
      tips.push({ category: 'Nutrition', tip: 'Practice race fueling on long runs. Your gut needs training too.', priority: 'medium' });
      tips.push({ category: 'Volume', tip: `This week totals ${weekProfile.totalMiles} mi. Monitor fatigue — adjust if sleep or mood suffer.`, priority: 'low' });
      break;

    case 'peak':
      tips.push({ category: 'Fatigue', tip: 'Feeling tired is normal in peak training. Trust the process — fitness is accumulating beneath the fatigue.', priority: 'high' });
      tips.push({ category: 'Recovery', tip: 'Extra sleep, foam rolling, and easy-day discipline are non-negotiable now.', priority: 'high' });
      if (weekProfile.longRunMiles >= 18) {
        tips.push({ category: 'Long Run', tip: `${weekProfile.longRunMiles} mi is a cornerstone workout. Practice everything you\'ll do on race day: kit, fueling, pacing.`, priority: 'high' });
      }
      tips.push({ category: 'Mental', tip: 'Visualize your race during long runs. Rehearse mantras for tough miles.', priority: 'low' });
      break;

    case 'taper':
      tips.push({ category: 'Volume', tip: 'Reduced mileage feels strange. Don\'t fill the gap with extra runs — rest is the workout now.', priority: 'high' });
      tips.push({ category: 'Intensity', tip: 'Keep 1-2 short quality sessions per week (strides, short tempo) to stay sharp.', priority: 'high' });
      tips.push({ category: 'Nutrition', tip: 'Begin carb loading 3 days before race day. Target 8-10g carbs/kg/day.', priority: 'medium' });
      tips.push({ category: 'Logistics', tip: 'Finalize race day logistics: travel, bib pickup, gear layout, course familiarization.', priority: 'medium' });
      break;

    case 'race':
      tips.push({ category: 'Strategy', tip: 'Start conservative. The first 5 miles should feel TOO easy. The race begins at mile 20.', priority: 'high' });
      tips.push({ category: 'Fueling', tip: 'Execute your practiced nutrition plan. No experiments on race day.', priority: 'high' });
      tips.push({ category: 'Mental', tip: 'When it hurts, shorten your focus. Don\'t think about the finish — think about the next mile.', priority: 'medium' });
      tips.push({ category: 'Pre-Race', tip: 'Light shake-out 1-2 days before. Morning-of: eat 3 hours before start, sip fluids, stay warm.', priority: 'medium' });
      break;
  }

  return tips;
}

// ── Persistence ───────────────────────────────────────────────────────────────

export function cachePeriodization(result: PeriodizationResult): void {
  persistence.setItem(PERIODIZATION_KEY, JSON.stringify({
    ...result,
    cachedAt: new Date().toISOString(),
  }));
}

export function getCachedPeriodization(): PeriodizationResult | null {
  try {
    const raw = persistence.getItem(PERIODIZATION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
