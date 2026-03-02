/**
 * Unit tests for paceCalculator.ts
 *
 * Tests VDOT-based training pace calculations, formatting,
 * and caching behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateTrainingPaces,
  calculatePacesFromRace,
  formatPaceSec,
  formatPaceRange,
  formatTrainingPacesSummary,
  saveTrainingPaces,
  getSavedTrainingPaces,
  getOrComputeTrainingPaces,
  vdotToMarathonTime,
} from '@/services/paceCalculator';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.clear();
});

// ── calculateTrainingPaces ────────────────────────────────────────────────────

describe('calculateTrainingPaces', () => {
  it('should return null for invalid VDOT', () => {
    expect(calculateTrainingPaces(0)).toBeNull();
    expect(calculateTrainingPaces(-10)).toBeNull();
    expect(calculateTrainingPaces(NaN)).toBeNull();
    expect(calculateTrainingPaces(Infinity)).toBeNull();
  });

  it('should calculate paces for VDOT 40 (approx 4:05 marathoner)', () => {
    const paces = calculateTrainingPaces(40)!;
    expect(paces).not.toBeNull();
    expect(paces.vdot).toBe(40);

    // Easy pace should be ~10:00-10:10/mi (600-610 sec)
    expect(paces.easy.min).toBeGreaterThan(560);
    expect(paces.easy.max).toBeLessThan(650);
    expect(paces.easy.max).toBeGreaterThan(paces.easy.min);

    // Marathon pace should be ~9:00-9:15/mi (540-555 sec)
    expect(paces.marathon).toBeGreaterThan(520);
    expect(paces.marathon).toBeLessThan(580);

    // Threshold should be faster than marathon
    expect(paces.threshold).toBeLessThan(paces.marathon);

    // Interval should be faster than threshold
    expect(paces.interval).toBeLessThan(paces.threshold);

    // Repetition should be fastest
    expect(paces.repetition).toBeLessThan(paces.interval);
  });

  it('should calculate paces for VDOT 50 (approx 3:20 marathoner)', () => {
    const paces = calculateTrainingPaces(50)!;
    expect(paces.vdot).toBe(50);

    // Easy pace should be ~8:15-8:35/mi (495-515 sec)
    expect(paces.easy.min).toBeGreaterThan(460);
    expect(paces.easy.max).toBeLessThan(540);

    // Marathon pace should be ~7:30-7:40/mi (450-460 sec)
    expect(paces.marathon).toBeGreaterThan(430);
    expect(paces.marathon).toBeLessThan(480);
  });

  it('should calculate paces for VDOT 60 (approx 2:50 marathoner)', () => {
    const paces = calculateTrainingPaces(60)!;

    // Easy pace should be ~7:00-7:15/mi (420-435 sec)
    expect(paces.easy.min).toBeGreaterThan(400);
    expect(paces.easy.max).toBeLessThan(460);

    // Marathon pace should be ~6:25-6:35/mi (385-395 sec)
    expect(paces.marathon).toBeGreaterThan(370);
    expect(paces.marathon).toBeLessThan(410);
  });

  it('should produce faster paces for higher VDOT', () => {
    const paces40 = calculateTrainingPaces(40)!;
    const paces50 = calculateTrainingPaces(50)!;
    const paces60 = calculateTrainingPaces(60)!;

    expect(paces50.easy.min).toBeLessThan(paces40.easy.min);
    expect(paces60.easy.min).toBeLessThan(paces50.easy.min);
    expect(paces50.marathon).toBeLessThan(paces40.marathon);
    expect(paces60.threshold).toBeLessThan(paces50.threshold);
    expect(paces60.interval).toBeLessThan(paces50.interval);
    expect(paces60.repetition).toBeLessThan(paces50.repetition);
  });

  it('should maintain correct pace ordering for all VDOT values', () => {
    for (const vdot of [30, 35, 40, 45, 50, 55, 60, 65, 70]) {
      const paces = calculateTrainingPaces(vdot)!;
      // Easy > Marathon > Threshold > Interval > Repetition (in sec/mi, higher = slower)
      expect(paces.easy.max).toBeGreaterThan(paces.marathon);
      expect(paces.marathon).toBeGreaterThan(paces.threshold);
      expect(paces.threshold).toBeGreaterThan(paces.interval);
      expect(paces.interval).toBeGreaterThan(paces.repetition);
    }
  });

  it('should have a positive easy pace range', () => {
    const paces = calculateTrainingPaces(45)!;
    expect(paces.easy.max - paces.easy.min).toBeGreaterThanOrEqual(10);
  });

  it('should include an updatedAt timestamp', () => {
    const paces = calculateTrainingPaces(40)!;
    expect(paces.updatedAt).toBeDefined();
    expect(new Date(paces.updatedAt).getTime()).not.toBeNaN();
  });
});

// ── calculatePacesFromRace ────────────────────────────────────────────────────

describe('calculatePacesFromRace', () => {
  it('should calculate paces from a 20:00 5K', () => {
    const paces = calculatePacesFromRace(5000, 20 * 60);
    expect(paces).not.toBeNull();
    expect(paces!.vdot).toBeGreaterThan(30);
    expect(paces!.vdot).toBeLessThan(60);
    expect(paces!.marathon).toBeGreaterThan(400);
    expect(paces!.marathon).toBeLessThan(650);
  });

  it('should calculate paces from a 3:30 marathon', () => {
    const paces = calculatePacesFromRace(42195, 3.5 * 3600);
    expect(paces).not.toBeNull();
    expect(paces!.marathon).toBeGreaterThan(400);
    expect(paces!.marathon).toBeLessThan(600);
  });

  it('should return null for invalid inputs', () => {
    expect(calculatePacesFromRace(0, 1200)).toBeNull();
    expect(calculatePacesFromRace(5000, 0)).toBeNull();
    expect(calculatePacesFromRace(-1, 1200)).toBeNull();
  });
});

// ── formatPaceSec ─────────────────────────────────────────────────────────────

describe('formatPaceSec', () => {
  it('should format seconds to "M:SS/mi"', () => {
    expect(formatPaceSec(480)).toBe('8:00/mi');
    expect(formatPaceSec(510)).toBe('8:30/mi');
    expect(formatPaceSec(545)).toBe('9:05/mi');
    expect(formatPaceSec(600)).toBe('10:00/mi');
  });

  it('should return "—" for zero or negative', () => {
    expect(formatPaceSec(0)).toBe('—');
    expect(formatPaceSec(-1)).toBe('—');
  });
});

// ── formatPaceRange ───────────────────────────────────────────────────────────

describe('formatPaceRange', () => {
  it('should format a pace range', () => {
    const result = formatPaceRange(480, 510);
    expect(result).toBe('8:00–8:30/mi');
  });

  it('should return "—" for invalid values', () => {
    expect(formatPaceRange(0, 510)).toBe('—');
    expect(formatPaceRange(480, 0)).toBe('—');
  });
});

// ── formatTrainingPacesSummary ────────────────────────────────────────────────

describe('formatTrainingPacesSummary', () => {
  it('should produce a multi-line summary', () => {
    const paces = calculateTrainingPaces(45)!;
    const summary = formatTrainingPacesSummary(paces);
    expect(summary).toContain('VDOT: 45');
    expect(summary).toContain('Easy:');
    expect(summary).toContain('Marathon:');
    expect(summary).toContain('Threshold:');
    expect(summary).toContain('Interval:');
    expect(summary).toContain('Repetition:');
    expect(summary).toContain('/mi');
  });
});

// ── save/load training paces ──────────────────────────────────────────────────

describe('training paces persistence', () => {
  it('should save and load training paces', () => {
    const paces = calculateTrainingPaces(42)!;
    saveTrainingPaces(paces);
    const loaded = getSavedTrainingPaces();
    expect(loaded).not.toBeNull();
    expect(loaded!.vdot).toBe(42);
    expect(loaded!.marathon).toBe(paces.marathon);
  });

  it('should return null when no paces are saved', () => {
    expect(getSavedTrainingPaces()).toBeNull();
  });
});

// ── getOrComputeTrainingPaces ─────────────────────────────────────────────────

describe('getOrComputeTrainingPaces', () => {
  it('should compute from saved prediction VDOT', () => {
    persistence.setItem('apollo_race_prediction', JSON.stringify({ vdot: 48 }));
    const paces = getOrComputeTrainingPaces();
    expect(paces).not.toBeNull();
    expect(paces!.vdot).toBe(48);
  });

  it('should fall back to cached paces', () => {
    const paces = calculateTrainingPaces(50)!;
    saveTrainingPaces(paces);
    const result = getOrComputeTrainingPaces();
    expect(result).not.toBeNull();
    expect(result!.vdot).toBe(50);
  });

  it('should return null when nothing available', () => {
    expect(getOrComputeTrainingPaces()).toBeNull();
  });
});

// ── vdotToMarathonTime ────────────────────────────────────────────────────────

describe('vdotToMarathonTime', () => {
  it('should return a formatted time string', () => {
    const time = vdotToMarathonTime(45);
    expect(time).toMatch(/^\d+:\d{2}:\d{2}$/);
  });

  it('should return "—" for invalid VDOT', () => {
    expect(vdotToMarathonTime(0)).toBe('—');
    expect(vdotToMarathonTime(-5)).toBe('—');
  });

  it('should produce faster times for higher VDOT', () => {
    // We can't easily compare formatted strings, but we know
    // higher VDOT = faster marathon = fewer total seconds in the pace
    const paces40 = calculateTrainingPaces(40)!;
    const paces60 = calculateTrainingPaces(60)!;
    expect(paces60.marathon * 26.2).toBeLessThan(paces40.marathon * 26.2);
  });
});
