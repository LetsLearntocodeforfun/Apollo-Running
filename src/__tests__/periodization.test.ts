/**
 * Tests for Training Periodization Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  analyzeWeek,
  detectPhases,
  getPeriodization,
  getPhaseCoachingTips,
  cachePeriodization,
  getCachedPeriodization,
} from '@/services/periodization';
import type { TrainingPlan, PlanWeek } from '@/data/plans';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.removeItem('apollo_periodization_cache');
});

// ── Test Helpers ──────────────────────────────────────────────────────────────

function makeWeek(
  weekNumber: number,
  runs: { mi: number; note?: string; type?: 'run' | 'rest' | 'cross' | 'race' | 'marathon' }[],
): PlanWeek {
  const days = runs.map((r) => ({
    type: r.type ?? (r.mi > 0 ? 'run' : 'rest') as PlanWeek['days'][0]['type'],
    label: r.note ? `${r.mi} mi ${r.note}` : r.mi > 0 ? `${r.mi} mi run` : 'Rest',
    distanceMi: r.mi > 0 ? r.mi : undefined,
    note: r.note ?? (r.mi > 0 ? 'Easy' : undefined),
  }));
  // Pad to 7 days
  while (days.length < 7) {
    days.push({ type: 'rest' as const, label: 'Rest', distanceMi: undefined, note: undefined });
  }
  return { weekNumber, days };
}

function make18WeekPlan(): TrainingPlan {
  // Simulated 18-week Novice-style plan:
  // Weeks 1-6: Base (gradual mileage increase, easy runs)
  // Weeks 7-11: Build (tempo/speed workouts introduced)
  // Weeks 12-14: Peak (highest mileage)
  // Weeks 15-17: Taper (mileage drops)
  // Week 18: Race
  return {
    id: 'test-18-week',
    name: 'Test 18-Week Plan',
    author: 'Test',
    description: 'Test plan',
    totalWeeks: 18,
    weeks: [
      // Base: weeks 1-6
      makeWeek(1, [{ mi: 3 }, { mi: 3 }, { mi: 3 }, { mi: 0 }, { mi: 6 }, { mi: 0 }, { mi: 0 }]),     // 15 mi
      makeWeek(2, [{ mi: 3 }, { mi: 3 }, { mi: 3 }, { mi: 0 }, { mi: 7 }, { mi: 0 }, { mi: 0 }]),     // 16 mi
      makeWeek(3, [{ mi: 3 }, { mi: 4 }, { mi: 3 }, { mi: 0 }, { mi: 8 }, { mi: 0 }, { mi: 0 }]),     // 18 mi
      makeWeek(4, [{ mi: 3 }, { mi: 4 }, { mi: 3 }, { mi: 0 }, { mi: 9 }, { mi: 0 }, { mi: 0 }]),     // 19 mi
      makeWeek(5, [{ mi: 4 }, { mi: 4 }, { mi: 3 }, { mi: 0 }, { mi: 10 }, { mi: 0 }, { mi: 0 }]),    // 21 mi
      makeWeek(6, [{ mi: 4 }, { mi: 5 }, { mi: 3 }, { mi: 0 }, { mi: 8 }, { mi: 0 }, { mi: 0 }]),     // 20 mi (step-back)
      // Build: weeks 7-11
      makeWeek(7, [{ mi: 4 }, { mi: 5, note: 'Tempo' }, { mi: 4 }, { mi: 0 }, { mi: 12 }, { mi: 0 }, { mi: 0 }]),  // 25 mi
      makeWeek(8, [{ mi: 4 }, { mi: 6, note: 'Tempo' }, { mi: 4 }, { mi: 0 }, { mi: 14 }, { mi: 0 }, { mi: 0 }]),  // 28 mi
      makeWeek(9, [{ mi: 5 }, { mi: 6, note: 'Speed' }, { mi: 4 }, { mi: 0 }, { mi: 15 }, { mi: 0 }, { mi: 0 }]),  // 30 mi
      makeWeek(10, [{ mi: 5 }, { mi: 7, note: 'Tempo' }, { mi: 5 }, { mi: 0 }, { mi: 13 }, { mi: 0 }, { mi: 0 }]), // 30 mi (step-back)
      makeWeek(11, [{ mi: 5 }, { mi: 7, note: 'Speed' }, { mi: 5 }, { mi: 0 }, { mi: 16 }, { mi: 0 }, { mi: 0 }]), // 33 mi
      // Peak: weeks 12-14
      makeWeek(12, [{ mi: 5 }, { mi: 8, note: 'Tempo' }, { mi: 5 }, { mi: 0 }, { mi: 18, note: 'Long' }, { mi: 0 }, { mi: 0 }]),  // 36 mi
      makeWeek(13, [{ mi: 6 }, { mi: 8, note: 'Marathon Pace' }, { mi: 5 }, { mi: 0 }, { mi: 20, note: 'Long' }, { mi: 0 }, { mi: 0 }]), // 39 mi (peak)
      makeWeek(14, [{ mi: 5 }, { mi: 7, note: 'Speed' }, { mi: 5 }, { mi: 0 }, { mi: 18, note: 'Long' }, { mi: 0 }, { mi: 0 }]),  // 35 mi
      // Taper: weeks 15-17
      makeWeek(15, [{ mi: 4 }, { mi: 6, note: 'Tempo' }, { mi: 4 }, { mi: 0 }, { mi: 12 }, { mi: 0 }, { mi: 0 }]),  // 26 mi
      makeWeek(16, [{ mi: 3 }, { mi: 5 }, { mi: 3 }, { mi: 0 }, { mi: 8 }, { mi: 0 }, { mi: 0 }]),    // 19 mi
      makeWeek(17, [{ mi: 3 }, { mi: 4 }, { mi: 2 }, { mi: 0 }, { mi: 5 }, { mi: 0 }, { mi: 0 }]),    // 14 mi
      // Race: week 18
      makeWeek(18, [{ mi: 2 }, { mi: 3 }, { mi: 0 }, { mi: 0 }, { mi: 0 }, { mi: 26.2, type: 'marathon' }, { mi: 0 }]),
    ],
  };
}

// ── analyzeWeek ───────────────────────────────────────────────────────────────

describe('analyzeWeek', () => {
  it('should calculate total weekly mileage', () => {
    const week = makeWeek(1, [{ mi: 3 }, { mi: 4 }, { mi: 3 }, { mi: 0 }, { mi: 10 }]);
    const profile = analyzeWeek(week);
    expect(profile.totalMiles).toBe(20);
  });

  it('should detect long runs by distance (≥ 13 mi)', () => {
    const week = makeWeek(1, [{ mi: 3 }, { mi: 3 }, { mi: 0 }, { mi: 0 }, { mi: 15 }]);
    const profile = analyzeWeek(week);
    expect(profile.longRunMiles).toBe(15);
  });

  it('should detect long runs by note', () => {
    const week = makeWeek(1, [{ mi: 3 }, { mi: 3 }, { mi: 0 }, { mi: 0 }, { mi: 10, note: 'Long' }]);
    const profile = analyzeWeek(week);
    expect(profile.longRunMiles).toBe(10);
  });

  it('should detect tempo workouts', () => {
    const week = makeWeek(1, [{ mi: 5, note: 'Tempo' }, { mi: 3 }, { mi: 0 }, { mi: 0 }, { mi: 10 }]);
    expect(analyzeWeek(week).hasTempoOrSpeed).toBe(true);
  });

  it('should detect speed workouts', () => {
    const week = makeWeek(1, [{ mi: 5, note: 'Speed' }, { mi: 3 }]);
    expect(analyzeWeek(week).hasTempoOrSpeed).toBe(true);
  });

  it('should detect interval workouts', () => {
    const week = makeWeek(1, [{ mi: 5, note: 'Interval' }, { mi: 3 }]);
    expect(analyzeWeek(week).hasTempoOrSpeed).toBe(true);
  });

  it('should detect marathon pace workouts', () => {
    const week = makeWeek(1, [{ mi: 5, note: 'Marathon Pace' }, { mi: 3 }]);
    expect(analyzeWeek(week).hasMarathonPace).toBe(true);
  });

  it('should detect race weeks', () => {
    const week = makeWeek(18, [{ mi: 2 }, { mi: 26.2, type: 'marathon' }]);
    expect(analyzeWeek(week).isRaceWeek).toBe(true);
  });

  it('should handle all-rest weeks', () => {
    const week = makeWeek(1, [{ mi: 0 }, { mi: 0 }, { mi: 0 }]);
    const profile = analyzeWeek(week);
    expect(profile.totalMiles).toBe(0);
    expect(profile.longRunMiles).toBe(0);
    expect(profile.hasTempoOrSpeed).toBe(false);
    expect(profile.isRaceWeek).toBe(false);
  });
});

// ── detectPhases ──────────────────────────────────────────────────────────────

describe('detectPhases', () => {
  const plan = make18WeekPlan();

  it('should detect all 5 phases for an 18-week plan', () => {
    const phases = detectPhases(plan);
    const names = phases.map((p) => p.name);
    expect(names).toContain('base');
    expect(names).toContain('build');
    expect(names).toContain('peak');
    expect(names).toContain('race');
  });

  it('should assign non-overlapping week ranges', () => {
    const phases = detectPhases(plan);
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i].startWeek).toBeGreaterThan(phases[i - 1].endWeek);
    }
  });

  it('should cover all weeks from 0 to totalWeeks-1', () => {
    const phases = detectPhases(plan);
    expect(phases[0].startWeek).toBe(0);
    expect(phases[phases.length - 1].endWeek).toBe(plan.weeks.length - 1);
  });

  it('should place race as the last phase', () => {
    const phases = detectPhases(plan);
    expect(phases[phases.length - 1].name).toBe('race');
  });

  it('should assign colors and labels to each phase', () => {
    const phases = detectPhases(plan);
    for (const phase of phases) {
      expect(phase.color).toBeTruthy();
      expect(phase.label).toBeTruthy();
      expect(phase.coachingMessage.length).toBeGreaterThan(10);
    }
  });

  it('should handle a minimal 4-week plan', () => {
    const shortPlan: TrainingPlan = {
      id: 'short', name: 'Short', author: 'T', description: '', totalWeeks: 4,
      weeks: [
        makeWeek(1, [{ mi: 3 }, { mi: 3 }, { mi: 6 }]),
        makeWeek(2, [{ mi: 4 }, { mi: 4 }, { mi: 8 }]),
        makeWeek(3, [{ mi: 3 }, { mi: 3 }, { mi: 5 }]),
        makeWeek(4, [{ mi: 2 }, { mi: 26.2, type: 'marathon' }]),
      ],
    };
    const phases = detectPhases(shortPlan);
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(phases[phases.length - 1].name).toBe('race');
  });

  it('should handle empty plan', () => {
    const emptyPlan: TrainingPlan = {
      id: 'empty', name: 'Empty', author: 'T', description: '', totalWeeks: 0, weeks: [],
    };
    expect(detectPhases(emptyPlan)).toEqual([]);
  });
});

// ── getPeriodization ──────────────────────────────────────────────────────────

describe('getPeriodization', () => {
  const plan = make18WeekPlan();

  it('should return current phase for an early week', () => {
    const result = getPeriodization(plan, 2);
    expect(result.currentPhase).not.toBeNull();
    expect(result.currentPhase!.name).toBe('base');
  });

  it('should compute correct overall progress', () => {
    const result = getPeriodization(plan, 8); // week 9 of 18
    expect(result.overallProgressPct).toBe(50);
  });

  it('should detect race week correctly', () => {
    const result = getPeriodization(plan, 17); // last week
    expect(result.currentPhase!.name).toBe('race');
    expect(result.nextPhase).toBeNull();
  });

  it('should return transition message when near phase boundary', () => {
    // Find the last week of base phase
    const phases = detectPhases(plan);
    const basePhase = phases.find((p) => p.name === 'base')!;
    const result = getPeriodization(plan, basePhase.endWeek);
    expect(result.weeksRemainingInPhase).toBe(0);
    if (result.transitionMessage) {
      expect(result.transitionMessage.length).toBeGreaterThan(10);
    }
  });

  it('should show next phase info', () => {
    const result = getPeriodization(plan, 0);
    expect(result.nextPhase).not.toBeNull();
  });

  it('should compute weeks remaining in phase', () => {
    const phases = detectPhases(plan);
    const firstPhase = phases[0];
    const result = getPeriodization(plan, firstPhase.startWeek);
    expect(result.weeksRemainingInPhase).toBe(firstPhase.endWeek - firstPhase.startWeek);
  });

  it('should handle week beyond plan', () => {
    const result = getPeriodization(plan, 20);
    // currentPhase should be null since week is beyond plan
    expect(result.overallProgressPct).toBeGreaterThan(100);
  });
});

// ── getPhaseCoachingTips ──────────────────────────────────────────────────────

describe('getPhaseCoachingTips', () => {
  const weekProfile = {
    weekNumber: 5,
    totalMiles: 30,
    longRunMiles: 16,
    hasTempoOrSpeed: true,
    hasMarathonPace: false,
    isRaceWeek: false,
  };

  it('should return base phase tips', () => {
    const tips = getPhaseCoachingTips('base', weekProfile);
    expect(tips.length).toBeGreaterThanOrEqual(2);
    expect(tips.some((t) => t.category === 'Pacing')).toBe(true);
    expect(tips.some((t) => t.category === 'Volume')).toBe(true);
  });

  it('should return build phase tips', () => {
    const tips = getPhaseCoachingTips('build', weekProfile);
    expect(tips.length).toBeGreaterThanOrEqual(2);
    expect(tips.some((t) => t.category === 'Quality')).toBe(true);
  });

  it('should warn about missing quality in build phase', () => {
    const noQuality = { ...weekProfile, hasTempoOrSpeed: false };
    const tips = getPhaseCoachingTips('build', noQuality);
    expect(tips.some((t) => t.category === 'Missing Workout')).toBe(true);
  });

  it('should return peak phase tips', () => {
    const tips = getPhaseCoachingTips('peak', { ...weekProfile, longRunMiles: 20 });
    expect(tips.length).toBeGreaterThanOrEqual(2);
    expect(tips.some((t) => t.category === 'Fatigue')).toBe(true);
  });

  it('should flag long runs ≥ 18 mi in peak phase', () => {
    const tips = getPhaseCoachingTips('peak', { ...weekProfile, longRunMiles: 20 });
    expect(tips.some((t) => t.category === 'Long Run' && t.tip.includes('20'))).toBe(true);
  });

  it('should return taper phase tips', () => {
    const tips = getPhaseCoachingTips('taper', weekProfile);
    expect(tips.some((t) => t.category === 'Volume')).toBe(true);
    expect(tips.some((t) => t.category === 'Intensity')).toBe(true);
  });

  it('should return race phase tips', () => {
    const tips = getPhaseCoachingTips('race', weekProfile);
    expect(tips.some((t) => t.category === 'Strategy')).toBe(true);
    expect(tips.some((t) => t.category === 'Fueling')).toBe(true);
  });

  it('should include long run tip for base phase when long run exists', () => {
    const tips = getPhaseCoachingTips('base', weekProfile);
    expect(tips.some((t) => t.category === 'Long Run')).toBe(true);
  });

  it('should assign appropriate priority levels', () => {
    const tips = getPhaseCoachingTips('peak', weekProfile);
    const priorities = tips.map((t) => t.priority);
    expect(priorities).toContain('high');
    expect(priorities.every((p) => ['high', 'medium', 'low'].includes(p))).toBe(true);
  });
});

// ── Persistence ───────────────────────────────────────────────────────────────

describe('Periodization persistence', () => {
  it('should cache and retrieve periodization result', () => {
    const plan = make18WeekPlan();
    const result = getPeriodization(plan, 5);
    cachePeriodization(result);
    const cached = getCachedPeriodization();
    expect(cached).not.toBeNull();
    expect(cached!.phases.length).toBe(result.phases.length);
    expect(cached!.currentPhase!.name).toBe(result.currentPhase!.name);
  });

  it('should return null when no cache exists', () => {
    expect(getCachedPeriodization()).toBeNull();
  });
});
