import { describe, it, expect, beforeEach } from 'vitest';
import {
  getAthleteProfile,
  updateAthleteProfile,
  clearAthleteProfile,
  sanitizeAthleteProfile,
  getCarbToleranceGPerHour,
  getTemperatureUnit,
  getMassUnit,
  formatTemperatureF,
  formatMassKg,
  onAthleteProfileChanged,
  ATHLETE_PROFILE_KEY,
} from '../services/athleteProfile';
import { persistence } from '../services/db/persistence';
import { setDistanceUnit } from '../services/unitPreferences';

describe('athleteProfile', () => {
  beforeEach(() => {
    clearAthleteProfile();
    setDistanceUnit('mi');
  });

  it('returns an empty profile by default', () => {
    expect(getAthleteProfile()).toEqual({});
    expect(getCarbToleranceGPerHour()).toBe(60);
  });

  it('merges, validates and persists updates', () => {
    updateAthleteProfile({ weightKg: 70.04, recentRace: { distanceM: 21097.5, timeSec: 5400, date: '2026-09-20' } });
    const p = getAthleteProfile();
    expect(p.weightKg).toBe(70);
    expect(p.recentRace).toEqual({ distanceM: 21097.5, timeSec: 5400, date: '2026-09-20' });
    expect(typeof p.updatedAt).toBe('string');
    expect(persistence.getItem(ATHLETE_PROFILE_KEY)).toContain('21097.5');
  });

  it('drops invalid values instead of throwing', () => {
    expect(sanitizeAthleteProfile({ weightKg: -5, birthYear: 1800, carbToleranceGPerHour: 500 })).toEqual({});
    expect(sanitizeAthleteProfile({ recentRace: { distanceM: 5000, timeSec: 1200, date: '2026-02-30' } })).toEqual({});
    expect(sanitizeAthleteProfile('garbage')).toEqual({});
    persistence.setItem(ATHLETE_PROFILE_KEY, '{not json');
    expect(getAthleteProfile()).toEqual({});
  });

  it('clears a field when patched with undefined', () => {
    updateAthleteProfile({ weightKg: 60, caffeine: true });
    updateAthleteProfile({ weightKg: undefined });
    const p = getAthleteProfile();
    expect(p.weightKg).toBeUndefined();
    expect(p.caffeine).toBe(true);
  });

  it('derives temperature and mass units from the distance unit unless set', () => {
    expect(getTemperatureUnit()).toBe('F');
    expect(getMassUnit()).toBe('lb');
    setDistanceUnit('km');
    expect(getTemperatureUnit()).toBe('C');
    expect(getMassUnit()).toBe('kg');
    updateAthleteProfile({ temperatureUnit: 'F' });
    expect(getTemperatureUnit()).toBe('F');
  });

  it('formats temperature and mass', () => {
    expect(formatTemperatureF(64.4, 'C')).toBe('18°C');
    expect(formatTemperatureF(64.4, 'F')).toBe('64°F');
    expect(formatMassKg(70, 'lb')).toBe('154 lb');
    expect(formatMassKg(70, 'kg')).toBe('70 kg');
    expect(formatTemperatureF(Number.NaN)).toBe('—');
  });

  it('notifies subscribers on change', () => {
    let seen: number | undefined;
    const off = onAthleteProfileChanged((p) => { seen = p.weightKg; });
    updateAthleteProfile({ weightKg: 65 });
    off();
    updateAthleteProfile({ weightKg: 66 });
    expect(seen).toBe(65);
  });
});
