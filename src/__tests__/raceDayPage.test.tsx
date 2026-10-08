/**
 * RTL smoke tests for the Race Day hub page (/race, v1.0.6): one h1, tabs in
 * the URL (?tab=), the default tab by days to race, race-date ownership by
 * the active plan (read-only date + mismatch notice linking to the plan),
 * choosing My Race, and no writes on render. Empty and seeded data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import RaceDay from '../pages/RaceDay';
import { getMyRace, setMyRace } from '../services/myRace';
import { setActivePlan } from '../services/planProgress';
import { updateAthleteProfile } from '../services/athleteProfile';
import { buildRaceStrategy, saveStrategy } from '../services/raceStrategy';
import { persistence } from '../services/db/persistence';

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{`${loc.pathname}${loc.search}`}</output>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/race" element={<><RaceDay /><LocationProbe /></>} />
        <Route path="/plan" element={<p>Plan page</p>} />
        <Route path="/settings" element={<p>Settings page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

function selectedTab(): string {
  const tabs = within(screen.getByRole('tablist', { name: 'Race Day sections' })).getAllByRole('tab');
  return tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? '';
}

function snapshot(): string {
  return JSON.stringify(persistence.toRecord());
}

function activatePlan(raceDate: string): void {
  setActivePlan({ planId: 'hal-higdon-novice-1', startDate: '2026-06-22', raceDate });
}

beforeEach(() => {
  // Freeze only Date: today is Thu Oct 8 2026 (Chicago Marathon is Sun Oct 11).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RaceDay page — empty data', () => {
  it('renders one h1, the My race card, the Strategy tab by default, and writes nothing', () => {
    const { container } = renderAt('/race');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe('Race Day');

    expect(screen.getByRole('heading', { level: 2, name: 'My race' })).toBeTruthy();
    expect(screen.getByTestId('rd-countdown').textContent).toBe('No race date yet');
    expect(selectedTab()).toBe('Strategy');
    expect(screen.getByText('Pick your race')).toBeTruthy();

    // No opt-in gate and no flag emoji (RS-14).
    expect(container.textContent).not.toContain('🇺🇸');
    expect(screen.queryByRole('button', { name: /enable/i })).toBeNull();

    // Goal links to the profile settings tab.
    expect(screen.getByRole('link', { name: 'Set a goal' }).getAttribute('href')).toBe('/settings?tab=profile');

    expect(persistence.keys()).toEqual([]);
  });

  it('opens the tab named in ?tab= and keeps tab changes in the URL', () => {
    renderAt('/race?tab=fuel');
    expect(selectedTab()).toBe('Fuel');
    expect(screen.getByRole('heading', { level: 3, name: 'Race fueling' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Race Morning' }));
    expect(selectedTab()).toBe('Race Morning');
    expect(screen.getByTestId('location').textContent).toBe('/race?tab=race-morning');

    fireEvent.click(screen.getByRole('tab', { name: 'Course' }));
    expect(screen.getByTestId('location').textContent).toBe('/race?tab=course');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('raceday-tab-course');
  });

  it('falls back to the default tab for an unknown ?tab=', () => {
    renderAt('/race?tab=weather');
    expect(selectedTab()).toBe('Strategy');
  });

  it('every tab renders on empty data without writing anything except the Race Week checklist', () => {
    for (const tab of ['strategy', 'fuel', 'race-morning', 'course']) {
      const before = snapshot();
      renderAt(`/race?tab=${tab}`);
      expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
      expect(snapshot()).toBe(before);
      cleanup();
    }
    renderAt('/race?tab=race-week');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(selectedTab()).toBe('Race Week');
  });
});

describe('RaceDay page — seeded data', () => {
  it.each([
    ['2026-10-11', 'Race Week', '3 days to go'],
    ['2026-10-25', 'Fuel', '17 days to go (2 weeks)'],
    ['2026-10-08', 'Race Morning', 'Race day!'],
    ['2026-11-15', 'Strategy', '38 days to go (5 weeks)'],
  ])('race on %s → default tab %s', (date, tab, countdown) => {
    setMyRace({ raceId: 'chicago', date });
    renderAt('/race');
    expect(selectedTab()).toBe(tab);
    expect(screen.getByTestId('rd-countdown').textContent).toBe(countdown);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the race, start time with the race-local zone, wave and the profile goal', () => {
    setMyRace({ raceId: 'chicago', date: '2026-10-11', wave: 'Wave 2' });
    updateAthleteProfile({ goalMarathonSec: 3 * 3600 + 45 * 60 });
    renderAt('/race?tab=strategy');
    expect((screen.getByLabelText('Race') as HTMLSelectElement).value).toBe('chicago');
    expect((screen.getByLabelText('Race date') as HTMLInputElement).value).toBe('2026-10-11');
    expect(screen.getByText('7:30 AM CDT · Wave 2')).toBeTruthy();
    expect(screen.getByText('3:45:00')).toBeTruthy();
    expect(screen.getByText(/from your profile/)).toBeTruthy();
  });

  it('does not write on render for the strategy, fuel, race-morning and course tabs', () => {
    setMyRace({ raceId: 'chicago', date: '2026-10-11' });
    updateAthleteProfile({ goalMarathonSec: 4 * 3600 });
    const s = buildRaceStrategy('chicago', 4 * 3600, 'even-split');
    if (!s) throw new Error('fixture');
    saveStrategy(s);
    setMyRace({ activeStrategyId: s.id });

    for (const tab of ['strategy', 'fuel', 'race-morning', 'course']) {
      const before = snapshot();
      renderAt(`/race?tab=${tab}`);
      expect(screen.getByText(s.name, { selector: '.rd-value' })).toBeTruthy();
      expect(snapshot()).toBe(before);
      cleanup();
    }
  });

  it('with an active plan the date is read-only and a different race date links to the plan', () => {
    setMyRace({ raceId: 'chicago' });
    activatePlan('2026-10-18');
    renderAt('/race');
    expect(screen.queryByLabelText('Race date', { selector: 'input' })).toBeNull();
    expect(document.getElementById('rd-race-date')).toBeNull();
    expect(screen.getByText('From your training plan')).toBeTruthy();
    expect(screen.getByText('Sun, Oct 18, 2026')).toBeTruthy();
    expect(screen.getByTestId('rd-countdown').textContent).toBe('10 days to go');
    expect(selectedTab()).toBe('Fuel');

    const note = screen.getByRole('note');
    expect(note.textContent).toContain("Dates don't match.");
    const link = within(note).getByRole('link', { name: 'Open your training plan' });
    expect(link.getAttribute('href')).toBe('/plan');
    fireEvent.click(link);
    expect(screen.getByText('Plan page')).toBeTruthy();
  });

  it('choosing a race writes its date when no plan is active', () => {
    renderAt('/race');
    fireEvent.change(screen.getByLabelText('Race'), { target: { value: 'chicago' } });
    const saved = getMyRace();
    expect(saved).toMatchObject({ raceId: 'chicago', date: '2026-10-11', startTime: '07:30', timeZone: 'America/Chicago' });
    expect(screen.getByTestId('rd-countdown').textContent).toBe('3 days to go');
    expect((screen.getByLabelText('Race date') as HTMLInputElement).value).toBe('2026-10-11');
  });

  it('choosing a race never writes the date while a plan is active', () => {
    activatePlan('2026-10-18');
    renderAt('/race');
    fireEvent.change(screen.getByLabelText('Race'), { target: { value: 'nyc' } });
    const saved = getMyRace();
    expect(saved.raceId).toBe('nyc');
    expect(saved.date).toBeUndefined();
    expect(screen.getByText('Sun, Oct 18, 2026')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('New York City Marathon');
  });

  it('editing the date (no plan) saves it and updates the countdown', () => {
    setMyRace({ raceId: 'chicago' });
    renderAt('/race');
    fireEvent.change(screen.getByLabelText('Race date'), { target: { value: '2026-10-25' } });
    expect(getMyRace().date).toBe('2026-10-25');
    expect(screen.getByTestId('rd-countdown').textContent).toBe('17 days to go (2 weeks)');
  });

  it('the strategy shortcut in the header switches to the Strategy tab', () => {
    setMyRace({ raceId: 'chicago', date: '2026-10-11' });
    renderAt('/race');
    expect(selectedTab()).toBe('Race Week');
    fireEvent.click(screen.getByRole('button', { name: 'Build or choose one' }));
    expect(selectedTab()).toBe('Strategy');
    expect(screen.getByTestId('location').textContent).toBe('/race?tab=strategy');
  });
});
