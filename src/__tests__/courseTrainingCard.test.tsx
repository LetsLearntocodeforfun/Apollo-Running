/**
 * RTL smoke tests for CourseTrainingCard (Race Day hub, Course tab).
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import CourseTrainingCard from '../components/race/CourseTrainingCard';
import type { RaceDayContext } from '../components/race/types';
import { getMarathonById } from '../data/worldMajors';
import { setDistanceUnit } from '../services/unitPreferences';

const TODAY = '2027-02-07';

function makeCtx(overrides: Partial<RaceDayContext> = {}): RaceDayContext {
  return {
    race: null,
    raceDate: null,
    startTime: null,
    timeZone: null,
    wave: null,
    goalTimeSec: null,
    strategy: null,
    today: TODAY,
    daysToRace: null,
    ...overrides,
  };
}

function bostonCtx(daysToRace: number | null): RaceDayContext {
  const boston = getMarathonById('boston', TODAY)!; // 2027-04-19
  return makeCtx({ race: boston, raceDate: boston.date, daysToRace });
}

describe('CourseTrainingCard', () => {
  it('shows an empty state when no race is selected', () => {
    render(<CourseTrainingCard ctx={makeCtx()} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Course training' })).toBeTruthy();
    expect(screen.getByText('No race selected')).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('groups Boston workouts ~10 weeks out and toggles the disclosures', () => {
    render(<CourseTrainingCard ctx={bostonCtx(71)} />);

    // Header: difficulty as text + meter, course type, gain/loss in ft
    expect(screen.getByText('7/10 · Hard')).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'Course difficulty' });
    expect(meter.getAttribute('aria-valuenow')).toBe('7');
    expect(screen.getByText('Point-to-point')).toBeTruthy();
    expect(screen.getByText('780 ft')).toBeTruthy();
    expect(screen.getByText('1260 ft')).toBeTruthy();
    expect(screen.getByText('Course-specific plan for Boston Marathon')).toBeTruthy();

    // Three window groups
    const now = screen.getByRole('region', { name: /^Now/ });
    const upcoming = screen.getByRole('region', { name: /^Upcoming/ });
    const passed = screen.getByRole('region', { name: /^Window passed/ });
    expect(within(now).getByRole('heading', { level: 3 }).textContent).toContain('10 weeks out');
    expect(within(now).getByText('Hilly Long Run')).toBeTruthy();
    expect(within(upcoming).getByText('Boston Dress Rehearsal')).toBeTruthy();
    expect(within(passed).getByText('Newton Hills Simulation')).toBeTruthy();
    // Priority badges carry text
    expect(within(now).getAllByText('Essential').length).toBeGreaterThan(0);

    // Disclosures
    for (const name of [/Weekly guidance/, /Taper notes/, /Race-day execution tips/]) {
      const toggle = screen.getByRole('button', { name });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      expect(panel.hidden).toBe(true);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(panel.hidden).toBe(false);
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }
    fireEvent.click(screen.getByRole('button', { name: /Race-day execution tips/ }));
    expect(screen.getByText(/west wind is a tailwind/)).toBeTruthy();
  });

  it('lists everything as upcoming with a note when there is no race date', () => {
    render(<CourseTrainingCard ctx={bostonCtx(null)} />);
    expect(screen.getByText(/Set a race date/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Now/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /^Window passed/ })).toBeNull();
    const upcoming = screen.getByRole('region', { name: /^Upcoming/ });
    expect(within(upcoming).getAllByRole('listitem')).toHaveLength(6);
  });

  it('uses metres and kilometres for km users', () => {
    setDistanceUnit('km');
    const { container } = render(<CourseTrainingCard ctx={bostonCtx(71)} />);
    expect(screen.getByText('238 m')).toBeTruthy();
    expect(screen.getByText('384 m')).toBeTruthy();
    expect(screen.getByText('42.2 km')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\bft\b|\bmi\b|\bmiles?\b/);
  });

  it('shows the generic plan for a custom race', () => {
    const race = { ...getMarathonById('berlin', TODAY)!, id: 'custom-flat-10k-1', name: 'Flat 10K', category: 'custom' as const, isWorldMajor: false, distanceMi: 6.2 };
    render(<CourseTrainingCard ctx={makeCtx({ race, daysToRace: 30 })} />);
    expect(screen.getByText('Based on the Flat 10K course profile')).toBeTruthy();
    expect(screen.getByRole('region', { name: /^Now/ })).toBeTruthy();
  });
});
