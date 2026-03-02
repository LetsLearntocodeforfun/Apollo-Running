/**
 * Unit tests for workoutTargets.ts
 *
 * Tests the mapping from plan day notes to structured workout targets
 * with VDOT-derived pace ranges, intervals, and coaching guidance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getWorkoutTarget,
  getWeekTargets,
  cacheWeekTargets,
  getCachedTarget,
} from '@/services/workoutTargets';
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

    it('should map "marathon pace" note to tempo category', () => {
      const target = getWorkoutTarget('marathon pace', VDOT_45)!;
      expect(target.category).toBe('tempo');
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

    it('should add marathon-pace segment for runs 18+ miles', () => {
      const target = getWorkoutTarget('Long', VDOT_45, 20)!;
      expect(target.marathonPaceSegment).toBeDefined();
      expect(target.marathonPaceSegment!.startMile).toBe(14); // 20 - 6
      expect(target.marathonPaceSegment!.endMile).toBe(20);
      expect(target.marathonPaceSegment!.paceSecPerMi).toBeGreaterThan(0);
    });

    it('should add 4-mile MP segment for 18-19 mile runs', () => {
      const target = getWorkoutTarget('Long', VDOT_45, 18)!;
      expect(target.marathonPaceSegment).toBeDefined();
      expect(target.marathonPaceSegment!.startMile).toBe(14); // 18 - 4
    });

    it('should NOT add MP segment for shorter long runs', () => {
      const target = getWorkoutTarget('Long', VDOT_45, 14)!;
      expect(target.marathonPaceSegment).toBeUndefined();
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
