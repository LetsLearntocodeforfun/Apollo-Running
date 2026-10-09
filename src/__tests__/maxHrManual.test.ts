/**
 * Manual max HR (v1.0.7, L-10): a max HR the athlete entered must never be
 * overwritten by one activity's reading; profiles that aren't manual still
 * auto-raise within the spike guard.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildHRDataFromActivity, getHRProfile, setHRProfile } from '@/services/heartRate';
import { persistence } from '@/services/db/persistence';

describe('max HR auto-update (L-10)', () => {
  beforeEach(() => {
    persistence.removeItem('apollo_hr_profile');
  });

  it('keeps a manually entered max HR', () => {
    setHRProfile({ maxHR: 182, restingHR: 50, source: 'manual', updatedAt: '2026-01-01T00:00:00Z' });
    buildHRDataFromActivity(1, '2026-10-01', 150, 195, 3600, undefined, 'intervals');
    expect(getHRProfile()).toMatchObject({ maxHR: 182, source: 'manual' });
  });

  it('still raises a non-manual max HR within the spike guard', () => {
    setHRProfile({ maxHR: 182, restingHR: 50, source: 'intervals', updatedAt: '2026-01-01T00:00:00Z' });
    buildHRDataFromActivity(2, '2026-10-01', 150, 190, 3600, undefined, 'intervals');
    expect(getHRProfile().maxHR).toBe(190);
  });

  it('ignores implausible spikes', () => {
    setHRProfile({ maxHR: 180, restingHR: 50, source: 'intervals', updatedAt: '2026-01-01T00:00:00Z' });
    buildHRDataFromActivity(3, '2026-10-01', 150, 225, 3600, undefined, 'intervals'); // > +15%
    expect(getHRProfile().maxHR).toBe(180);
  });
});
