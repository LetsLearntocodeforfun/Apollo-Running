/**
 * Taper protection (v1.0.7, L-6): adaptive coaching must never add mileage in
 * the last 3 weeks before race week (the taper) or in race week itself.
 */
import { describe, it, expect } from 'vitest';
import { NO_INCREASE_WEEKS_BEFORE_RACE, lastIncreasableWeek } from '@/services/adaptiveTraining';

describe('taper protection (L-6)', () => {
  it('protects the three weeks before race week and race week itself', () => {
    expect(NO_INCREASE_WEEKS_BEFORE_RACE).toBe(3);
    // 18-week plan: race week is index 17; weeks 14–17 are protected.
    expect(lastIncreasableWeek(18)).toBe(13);
    // 16-week plan (FIRST): race week 15; weeks 12–15 protected.
    expect(lastIncreasableWeek(16)).toBe(11);
  });

  it('very short plans have no week that can take more mileage', () => {
    expect(lastIncreasableWeek(4)).toBe(-1);
    expect(lastIncreasableWeek(5)).toBe(0);
  });
});
