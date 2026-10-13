/**
 * Unit tests for workoutTargets.ts
 *
 * Tests the mapping from plan day notes to structured workout targets
 * with VDOT-derived pace ranges, intervals, and coaching guidance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getWorkoutTarget,
  getWorkoutTargetForDay,
  getWeekTargets,
  cacheWeekTargets,
  getCachedTarget,
  getSpeedStructure,
  getTempoStructure,
  parseMarathonPaceMiles,
  parsePlanReps,
  FIRST_TEMPO_OFFSET_SEC,
  MAX_CONTINUOUS_THRESHOLD_MIN,
} from '@/services/workoutTargets';
import { calculateTrainingPaces } from '@/services/paceCalculator';
import { BUILT_IN_PLANS } from '@/data/plans';
import { persistence } from '@/services/db/persistence';

const VDOT_45 = 45; // ~3:35 marathon runner

beforeEach(() => {
  persistence.clear();
});

// ── getWorkoutTarget ──────────────────────────────────────────────────────────

describe('getWorkoutTarget', () => {
  it('should return null for empty note', () => {
    expect(getWorkoutTarget('', VDOT_45)).toBeNull();
  });

  it('should return null for invalid VDOT', () => {
    expect(getWorkoutTarget('Easy', 0)).toBeNull();
    expect(getWorkoutTarget('Easy', -10)).toBeNull();
  });

  describe('Easy workout', () => {
    it('should produce an easy target with correct pace range', () => {
      const target = getWorkoutTarget('Easy', VDOT_45)!;
      expect(target).not.toBeNull();
      expect(target.category).toBe('easy');
      expect(target.targetPaceRange).toBeDefined();
      expect(target.hrZone).toBe(2);
      expect(target.description).toContain('conversational');

      // Easy pace (VDOT 45): ~9:10-9:40/mi range = ~550-580 sec/mi
      expect(target.targetPaceRange!.minSecPerMi).toBeGreaterThan(500);
      expect(target.targetPaceRange!.maxSecPerMi).toBeLessThan(620);
      expect(target.targetPaceRange!.maxSecPerMi).toBeGreaterThan(target.targetPaceRange!.minSecPerMi);
    });

    it('should map "recovery" note to easy category', () => {
      const target = getWorkoutTarget('recovery', VDOT_45)!;
      expect(target.category).toBe('easy');
    });
  });

  describe('Tempo workout', () => {
    it('should produce a tempo target with threshold pace ±5s', () => {
      const target = getWorkoutTarget('Tempo', VDOT_45)!;
      expect(target).not.toBeNull();
      expect(target.category).toBe('tempo');
      expect(target.targetPaceRange).toBeDefined();
      expect(target.hrZone).toBe(4);
      expect(target.description).toContain('threshold');

      // Range should span ~10 sec (±5s tolerance)
      const range = target.targetPaceRange!;
      expect(range.maxSecPerMi - range.minSecPerMi).toBe(10);
    });

    it('should map "marathon pace" note to the marathon_pace category (T-1)', () => {
      const target = getWorkoutTarget('marathon pace', VDOT_45)!;
      expect(target.category).toBe('marathon_pace');
      expect(target.hrZone).toBe(3);
      expect(getWorkoutTarget('Marathon Pace', VDOT_45)!.category).toBe('marathon_pace');
      expect(getWorkoutTarget('MP', VDOT_45)!.category).toBe('marathon_pace');
    });

    it('should include interval structure for long tempos (6+ mi)', () => {
      const target = getWorkoutTarget('Tempo', VDOT_45, 8)!;
      expect(target.intervals).toBeDefined();
      expect(target.intervals!.length).toBe(1);
      expect(target.intervals![0].description).toContain('warmup');
      expect(target.intervals![0].description).toContain('cooldown');
    });

    it('should not include intervals for short tempos', () => {
      const target = getWorkoutTarget('Tempo', VDOT_45, 4)!;
      expect(target.intervals).toBeUndefined();
    });
  });

  describe('Speed workout', () => {
    it('should produce a speed target with interval structure', () => {
      const target = getWorkoutTarget('Speed', VDOT_45)!;
      expect(target).not.toBeNull();
      expect(target.category).toBe('speed');
      expect(target.targetPaceRange).toBeDefined();
      expect(target.hrZone).toBe(5);
      expect(target.intervals).toBeDefined();
      expect(target.intervals!.length).toBe(1);

      // Should have work and rest intervals
      const interval = target.intervals![0];
      expect(interval.workDurationMin).toBeGreaterThan(0);
      expect(interval.restDurationMin).toBeGreaterThan(0);
      expect(interval.repeats).toBeGreaterThan(0);
      expect(interval.description).toContain('800m');
    });

    it('speed pace should be faster than tempo', () => {
      const speed = getWorkoutTarget('Speed', VDOT_45)!;
      const tempo = getWorkoutTarget('Tempo', VDOT_45)!;
      expect(speed.targetPaceRange!.minSecPerMi).toBeLessThan(tempo.targetPaceRange!.minSecPerMi);
    });
  });

  describe('Long run', () => {
    it('should produce a long run target at easy pace', () => {
      const target = getWorkoutTarget('Long', VDOT_45, 16)!;
      const easy = getWorkoutTarget('Easy', VDOT_45)!;
      expect(target.category).toBe('long');
      expect(target.targetPaceRange!.minSecPerMi).toBe(easy.targetPaceRange!.minSecPerMi);
      expect(target.targetPaceRange!.maxSecPerMi).toBe(easy.targetPaceRange!.maxSecPerMi);
    });

    // v1.0.7 (T-11): the MP finish needs a plan day that offers it (experienced plans).
    const EXPERIENCED = { label: 'long run', mpFinish: true };

    it('should add marathon-pace segment for runs 18+ miles', () => {
      const target = getWorkoutTarget('Long', VDOT_45, 20, EXPERIENCED)!;
      expect(target.marathonPaceSegment).toBeDefined();
      expect(target.marathonPaceSegment!.startMile).toBe(14); // 20 - 6
      expect(target.marathonPaceSegment!.endMile).toBe(20);
      expect(target.marathonPaceSegment!.paceSecPerMi).toBeGreaterThan(0);
    });

    it('should add 4-mile MP segment for 18-19 mile runs', () => {
      const target = getWorkoutTarget('Long', VDOT_45, 18, EXPERIENCED)!;
      expect(target.marathonPaceSegment).toBeDefined();
      expect(target.marathonPaceSegment!.startMile).toBe(14); // 18 - 4
    });

    it('should NOT add MP segment for shorter long runs', () => {
      const target = getWorkoutTarget('Long', VDOT_45, 14, EXPERIENCED)!;
      expect(target.marathonPaceSegment).toBeUndefined();
    });

    it('never offers an MP finish on novice long runs or without a plan day (T-11)', () => {
      expect(getWorkoutTarget('Long', VDOT_45, 20)!.marathonPaceSegment).toBeUndefined();
      expect(getWorkoutTarget('Long', VDOT_45, 20, { label: '20 mi long run' })!.marathonPaceSegment).toBeUndefined();
      expect(getWorkoutTarget('Long', VDOT_45, 20)!.description).not.toMatch(/marathon pace/i);
      for (const id of ['hal-higdon-novice-1', 'hal-higdon-novice-2', 'hansons-beginner']) {
        const plan = BUILT_IN_PLANS.find((p) => p.id === id)!;
        for (const week of plan.weeks) {
          for (const day of week.days) {
            expect(getWorkoutTargetForDay(day, VDOT_45)?.marathonPaceSegment, `${id} ${day.label}`).toBeUndefined();
          }
        }
      }
      // Experienced plans keep it on their 18+ mi long runs.
      const pfitz = BUILT_IN_PLANS.find((p) => p.id === 'pfitzinger-18-55')!;
      const twenty = pfitz.weeks.flatMap((w) => w.days).find((d) => d.note === 'Long' && d.distanceMi === 20)!;
      expect(getWorkoutTargetForDay(twenty, VDOT_45)?.marathonPaceSegment).toBeDefined();
    });
  });

  describe("plan's own structure (v1.0.7)", () => {
    const paces = calculateTrainingPaces(VDOT_45)!;

    it("T-10: parses the plan's reps", () => {
      expect(parsePlanReps('8 × 400 m intervals')).toEqual({ repeats: 8, meters: 400, repLabel: '400m', hill: false });
      expect(parsePlanReps('5 × 1 km intervals')).toMatchObject({ repeats: 5, meters: 1000, repLabel: '1 km' });
      expect(parsePlanReps('6 × 1 mi strength')).toMatchObject({ repeats: 6, meters: 1609 });
      expect(parsePlanReps('4 x 1200m')).toMatchObject({ repeats: 4, meters: 1200 });
      expect(parsePlanReps('6 × hill repeats')).toMatchObject({ repeats: 6, meters: null, hill: true });
      expect(parsePlanReps('5 mi speed workout')).toBeNull();
    });

    it("T-10: speed targets keep the plan's reps instead of 800 m", () => {
      const t = getWorkoutTarget('Speed', VDOT_45, 6, { label: '3 × 1600 m intervals' })!;
      expect(t.intervals![0].repeats).toBe(3);
      expect(t.intervals![0].description).toContain('3×1600m');
      expect(t.intervals![0].description).not.toContain('800m');
      // 1600 m at I pace ≈ 1 mile of interval pace; recovery about half the rep for reps over 1 km.
      expect(t.intervals![0].workDurationMin).toBeCloseTo(paces.interval / 60, 0);
      expect(t.intervals![0].restDurationMin).toBeLessThan(t.intervals![0].workDurationMin);
      const fourHundreds = getWorkoutTarget('Speed', VDOT_45, 6, { label: '12 × 400 m speed' })!;
      expect(fourHundreds.intervals![0].repeats).toBe(12);
      expect(fourHundreds.targetPaceRange).toEqual(t.targetPaceRange);
      // No reps in the description → Apollo's default 800s.
      expect(getWorkoutTarget('Speed', VDOT_45, 6, { label: '6 mi speed' })!.intervals![0].description).toContain(
        '800m',
      );
      expect(getSpeedStructure({ label: '6 × hill repeats' }, 6, paces)).toMatchObject({ repeats: 6, repMeters: null });
    });

    it('T-4: FIRST short / mid tempos at 5K pace + 15 / + 30 s/mi', () => {
      const short = getWorkoutTarget('Tempo', VDOT_45, 5, { label: '5 mi with 3 mi short tempo' })!;
      const mid = getWorkoutTarget('Tempo', VDOT_45, 7, { label: '7 mi with 5 mi mid tempo' })!;
      const shortMid = (short.targetPaceRange!.minSecPerMi + short.targetPaceRange!.maxSecPerMi) / 2;
      const midMid = (mid.targetPaceRange!.minSecPerMi + mid.targetPaceRange!.maxSecPerMi) / 2;
      expect(midMid - shortMid).toBe(FIRST_TEMPO_OFFSET_SEC.mid - FIRST_TEMPO_OFFSET_SEC.short);
      // Short tempo is quicker than Daniels T; mid tempo is close to it.
      expect(shortMid).toBeLessThan(paces.threshold);
      expect(Math.abs(midMid - paces.threshold)).toBeLessThan(15);
      expect(short.description).toMatch(/FIRST short tempo/);
      expect(short.intervals![0].description).toBe('1mi warmup → 3mi short tempo → 1mi cooldown');
    });

    it('T-4: long tempos become cruise intervals (≤ 6 × 1 mi), never ~an hour at T', () => {
      const t = getWorkoutTarget('Tempo', VDOT_45, 10)!;
      expect(t.category).toBe('tempo');
      expect(t.intervals![0].repeats).toBe(6);
      expect(t.intervals![0].restDurationMin).toBe(1);
      expect(t.intervals![0].description).toContain('6×1mi at tempo');
      // A tempo block of ≤ 25 min at T stays continuous.
      expect(getTempoStructure(null, 6, paces).style).toBe(
        (4 * paces.threshold) / 60 > MAX_CONTINUOUS_THRESHOLD_MIN ? 'cruise' : 'threshold',
      );
      expect(getTempoStructure(null, 5, paces).style).toBe('threshold');
    });

    it('T-4: every FIRST tempo is a short / mid tempo or a marathon-pace long tempo', () => {
      const first = BUILT_IN_PLANS.find((p) => p.id === 'first')!;
      const thursdays = first.weeks.slice(0, 15).map((w) => w.days[3]);
      for (const day of thursdays) {
        const t = getWorkoutTargetForDay(day, VDOT_45)!;
        if ((day.distanceMi ?? 0) - 2 >= 6) {
          expect(t.category, day.label).toBe('marathon_pace');
          expect(t.intervals![0].description).toContain('at marathon pace');
        } else {
          expect(t.category, day.label).toBe('tempo');
          expect(t.description).toMatch(/^FIRST (short|mid) tempo/);
        }
      }
    });

    it("T-17: marathon-pace targets keep the plan's MP miles", () => {
      expect(parseMarathonPaceMiles({ label: '8 mi tempo at marathon pace', distanceMi: 10 })).toBe(8);
      expect(parseMarathonPaceMiles({ label: '5 mi with 3 at marathon pace', distanceMi: 5 })).toBe(3);
      expect(parseMarathonPaceMiles({ label: '8 mi marathon pace', distanceMi: 8 })).toBeNull();
      const t = getWorkoutTarget('Marathon Pace', VDOT_45, 10, { label: '8 mi tempo at marathon pace' })!;
      expect(t.intervals![0].description).toBe('1mi warmup → 8mi at marathon pace → 1mi cooldown');
      expect(t.intervals![0].targetPaceSecPerMi).toBe(paces.marathon);
    });
  });

  describe('Medium Long run', () => {
    it('should produce medium-long target slightly faster than easy', () => {
      const target = getWorkoutTarget('Medium Long', VDOT_45)!;
      const easy = getWorkoutTarget('Easy', VDOT_45)!;
      expect(target.category).toBe('medium_long');
      expect(target.targetPaceRange!.minSecPerMi).toBeLessThan(easy.targetPaceRange!.minSecPerMi);
    });
  });

  describe('Strength workout', () => {
    it('should produce a strength target between marathon and tempo pace', () => {
      const target = getWorkoutTarget('Strength', VDOT_45)!;
      const tempo = getWorkoutTarget('Tempo', VDOT_45)!;
      const easy = getWorkoutTarget('Easy', VDOT_45)!;
      expect(target.category).toBe('strength');
      expect(target.targetPaceRange!.minSecPerMi).toBeGreaterThan(tempo.targetPaceRange!.minSecPerMi);
      expect(target.targetPaceRange!.maxSecPerMi).toBeLessThan(easy.targetPaceRange!.maxSecPerMi);
    });
  });

  describe('Race day', () => {
    it('should produce a race target around marathon pace', () => {
      const target = getWorkoutTarget('Race day', VDOT_45)!;
      expect(target.category).toBe('race');
      expect(target.description).toContain('race');
    });

    it('should map "Race" note to race category', () => {
      const target = getWorkoutTarget('Race', VDOT_45)!;
      expect(target.category).toBe('race');
    });
  });

  describe('Pace ordering', () => {
    it('should maintain correct pace hierarchy: easy > ML > strength > tempo > speed', () => {
      const easy = getWorkoutTarget('Easy', VDOT_45)!;
      const ml = getWorkoutTarget('Medium Long', VDOT_45)!;
      const str = getWorkoutTarget('Strength', VDOT_45)!;
      const tempo = getWorkoutTarget('Tempo', VDOT_45)!;
      const speed = getWorkoutTarget('Speed', VDOT_45)!;

      // Higher sec/mi = slower
      const easyMid = (easy.targetPaceRange!.minSecPerMi + easy.targetPaceRange!.maxSecPerMi) / 2;
      const mlMid = (ml.targetPaceRange!.minSecPerMi + ml.targetPaceRange!.maxSecPerMi) / 2;
      const strMid = (str.targetPaceRange!.minSecPerMi + str.targetPaceRange!.maxSecPerMi) / 2;
      const tempoMid = (tempo.targetPaceRange!.minSecPerMi + tempo.targetPaceRange!.maxSecPerMi) / 2;
      const speedMid = (speed.targetPaceRange!.minSecPerMi + speed.targetPaceRange!.maxSecPerMi) / 2;

      expect(easyMid).toBeGreaterThan(mlMid);
      expect(mlMid).toBeGreaterThan(strMid);
      expect(strMid).toBeGreaterThan(tempoMid);
      expect(tempoMid).toBeGreaterThan(speedMid);
    });
  });
});

// ── getWeekTargets ────────────────────────────────────────────────────────────

describe('getWeekTargets', () => {
  it('should return targets for all run days in a week', () => {
    const weekDays = [
      { type: 'rest', note: undefined },
      { type: 'run', note: 'Easy', distanceMi: 5 },
      { type: 'run', note: 'Tempo', distanceMi: 6 },
      { type: 'run', note: 'Easy', distanceMi: 4 },
      { type: 'rest', note: undefined },
      { type: 'run', note: 'Easy', distanceMi: 4 },
      { type: 'run', note: 'Long', distanceMi: 14 },
    ];

    const targets = getWeekTargets(weekDays, VDOT_45);
    expect(targets.size).toBe(5); // 5 run days
    expect(targets.has(0)).toBe(false); // rest day
    expect(targets.has(4)).toBe(false); // rest day
    expect(targets.get(1)!.category).toBe('easy');
    expect(targets.get(2)!.category).toBe('tempo');
    expect(targets.get(6)!.category).toBe('long');
  });

  it('should return empty map for invalid VDOT', () => {
    const weekDays = [{ type: 'run', note: 'Easy', distanceMi: 5 }];
    expect(getWeekTargets(weekDays, 0).size).toBe(0);
  });
});

// ── caching ───────────────────────────────────────────────────────────────────

describe('workout target caching', () => {
  it('should cache and retrieve week targets', () => {
    const weekDays = [
      { type: 'run', note: 'Easy', distanceMi: 5 },
      { type: 'run', note: 'Tempo', distanceMi: 6 },
    ];
    const targets = getWeekTargets(weekDays, VDOT_45);
    cacheWeekTargets(3, targets);

    const cached = getCachedTarget(3, 0);
    expect(cached).not.toBeNull();
    expect(cached!.category).toBe('easy');

    const cachedTempo = getCachedTarget(3, 1);
    expect(cachedTempo).not.toBeNull();
    expect(cachedTempo!.category).toBe('tempo');
  });

  it('should return null for uncached targets', () => {
    expect(getCachedTarget(99, 0)).toBeNull();
  });
});
