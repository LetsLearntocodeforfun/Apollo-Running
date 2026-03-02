/**
 * Tests for raceEquivalence.ts — Race Equivalence Engine
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeToIdeal,
  convertBetweenConditions,
  normalizeMarathonTime,
  projectTimeInConditions,
} from '@/services/raceEquivalence';

const THREE_HOURS = 3 * 3600;
const THREE_FIFTEEN = 3 * 3600 + 15 * 60;

describe('normalizeToIdeal', () => {
  it('should return faster time when normalizing from hot conditions', () => {
    const result = normalizeToIdeal(THREE_FIFTEEN, {
      tempF: 75,
      humidityPct: 60,
    });
    expect(result.adjustedTimeSec).toBeLessThan(THREE_FIFTEEN);
    expect(result.deltaSec).toBeLessThan(0);
  });

  it('should return approximately same time in ideal conditions', () => {
    const result = normalizeToIdeal(THREE_HOURS, {
      tempF: 55,
      humidityPct: 40,
    });
    // Should be very close to original
    expect(Math.abs(result.deltaSec)).toBeLessThan(30);
  });

  it('should adjust for altitude', () => {
    const result = normalizeToIdeal(THREE_HOURS, {
      tempF: 55,
      humidityPct: 40,
      altitudeFt: 5000,
    });
    // Running at altitude makes you slower — normalized should be faster
    expect(result.adjustedTimeSec).toBeLessThan(THREE_HOURS);
  });

  it('should adjust for wind', () => {
    const result = normalizeToIdeal(THREE_HOURS, {
      tempF: 55,
      humidityPct: 40,
      windMph: 15,
    });
    // Headwind makes you slower — normalized should be faster
    expect(result.adjustedTimeSec).toBeLessThan(THREE_HOURS);
  });

  it('should include adjustment details', () => {
    const result = normalizeToIdeal(THREE_FIFTEEN, {
      tempF: 80,
      humidityPct: 70,
      altitudeFt: 3000,
    });
    expect(result.adjustments.length).toBeGreaterThan(0);
    const tempAdj = result.adjustments.find((a) => a.factor === 'Temperature');
    expect(tempAdj).toBeDefined();
  });

  it('should include a human-readable summary', () => {
    const result = normalizeToIdeal(THREE_FIFTEEN, {
      tempF: 75,
      humidityPct: 60,
    });
    expect(result.summary).toBeTruthy();
    expect(result.summary.length).toBeGreaterThan(20);
  });
});

describe('convertBetweenConditions', () => {
  it('should project slower time when going from cool to hot', () => {
    const result = convertBetweenConditions(
      THREE_HOURS,
      { tempF: 55, humidityPct: 40 },
      { tempF: 80, humidityPct: 70 },
    );
    expect(result.adjustedTimeSec).toBeGreaterThan(THREE_HOURS);
  });

  it('should project faster time when going from hot to cool', () => {
    const result = convertBetweenConditions(
      THREE_HOURS,
      { tempF: 80, humidityPct: 70 },
      { tempF: 55, humidityPct: 40 },
    );
    expect(result.adjustedTimeSec).toBeLessThan(THREE_HOURS);
  });

  it('should be roughly symmetric', () => {
    const coolToHot = convertBetweenConditions(
      THREE_HOURS,
      { tempF: 55, humidityPct: 40 },
      { tempF: 80, humidityPct: 60 },
    );
    const hotToCool = convertBetweenConditions(
      coolToHot.adjustedTimeSec,
      { tempF: 80, humidityPct: 60 },
      { tempF: 55, humidityPct: 40 },
    );
    // Should get roughly back to original
    expect(Math.abs(hotToCool.adjustedTimeSec - THREE_HOURS)).toBeLessThan(60);
  });
});

describe('normalizeMarathonTime', () => {
  it('should return a normalized time and message', () => {
    const result = normalizeMarathonTime(THREE_FIFTEEN, 75, 60);
    expect(result.normalizedSec).toBeLessThan(THREE_FIFTEEN);
    expect(result.normalizedFormatted).toBeTruthy();
    expect(result.message).toBeTruthy();
  });
});

describe('projectTimeInConditions', () => {
  it('should project slower time in hot conditions', () => {
    const result = projectTimeInConditions(THREE_HOURS, {
      tempF: 85,
      humidityPct: 75,
    });
    expect(result.projectedSec).toBeGreaterThan(THREE_HOURS);
    expect(result.projectedFormatted).toBeTruthy();
  });
});
