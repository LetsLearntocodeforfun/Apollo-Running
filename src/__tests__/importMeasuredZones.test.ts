/**
 * v1.0.7 (L-11): imported runs with heart-rate samples count as measured time
 * in zone right away, without orphan HR records for duplicates the store drops.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { persistence } from '@/services/db/persistence';
import { toActivity } from '@/services/fileImport/build';
import type { ParsedSample } from '@/services/fileImport/types';
import { getAggregateZoneDistribution, getHRHistory, getMeasuredTimeInZones, setHRProfile } from '@/services/heartRate';
import { storeActivities } from '@/services/analyticsService';
import { refreshPlanFromStoredActivities } from '@/services/autoSync';

// 2026-10-06 07:00 local.
const T0 = new Date(2026, 9, 6, 7, 0, 0).getTime();

function samples(hrAt: (s: number) => number | undefined): ParsedSample[] {
  const out: ParsedSample[] = [];
  for (let s = 0; s <= 2400; s += 5) out.push({ time: T0 + s * 1000, distance: s * 3, heartRate: hrAt(s) });
  return out;
}

beforeEach(() => {
  persistence.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 7, 12, 0, 0));
  setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('measured zones from file imports (L-11)', () => {
  it('keeps the zones aside without creating an HR record at build time', () => {
    // 20 min at 150 bpm (Z3), 20 min at 170 bpm (Z4).
    const a = toActivity(
      { type: 'Run', startTime: T0, samples: samples((s) => (s < 1200 ? 150 : 170)), laps: [], totals: {} },
      { fileName: 'run.fit' },
    )!;
    expect(getMeasuredTimeInZones(a.id)).toEqual([0, 0, 1200, 1200, 0]);
    expect(getHRHistory()).toEqual([]);
  });

  it('runs without heart rate, and non-runs, store nothing', () => {
    const noHr = toActivity(
      { type: 'Run', startTime: T0, samples: samples(() => undefined), laps: [], totals: {} },
      { fileName: 'a.gpx' },
    )!;
    expect(getMeasuredTimeInZones(noHr.id)).toBeNull();
    const ride = toActivity(
      { type: 'Ride', startTime: T0 + 86_400_000, samples: samples(() => 150), laps: [], totals: {} },
      { fileName: 'b.fit' },
    )!;
    expect(getMeasuredTimeInZones(ride.id)).toBeNull();
  });

  it('after the import is stored, the HR capture saves the run as measured', () => {
    const a = toActivity(
      { type: 'Run', startTime: T0, samples: samples((s) => (s < 1200 ? 150 : 170)), laps: [], totals: {} },
      { fileName: 'run.fit' },
    )!;
    storeActivities([a]);
    refreshPlanFromStoredActivities();
    const rec = getHRHistory().find((h) => h.activityId === a.id)!;
    expect(rec.zoneSource).toBe('measured');
    expect(rec.timeInZones).toEqual([0, 0, 1200, 1200, 0]);
    expect(getAggregateZoneDistribution(30).estimated).toBe(false);
  });
});
