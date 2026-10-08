/**
 * RTL smoke tests for the Fuel panel (Race Day hub, v1.0.6): race fueling
 * timeline, carb-load planner and safe hydration guidance.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import FuelPanel from '../components/race/FuelPanel';
import type { RaceDayContext } from '../components/race/types';
import { getMarathonById } from '../data/worldMajors';
import { buildRaceStrategy } from '../services/raceStrategy';
import { getAthleteProfile, updateAthleteProfile } from '../services/athleteProfile';
import { setDistanceUnit } from '../services/unitPreferences';
import { persistence } from '../services/db/persistence';

function baseCtx(overrides: Partial<RaceDayContext> = {}): RaceDayContext {
  return {
    race: null,
    raceDate: null,
    startTime: null,
    timeZone: null,
    wave: null,
    goalTimeSec: null,
    strategy: null,
    today: '2026-10-07',
    daysToRace: null,
    ...overrides,
  };
}

function chicagoCtx(overrides: Partial<RaceDayContext> = {}): RaceDayContext {
  const race = getMarathonById('chicago', '2026-10-07')!;
  const strategy = buildRaceStrategy('chicago', 4 * 3600, 'even-split')!;
  return baseCtx({
    race,
    raceDate: '2026-10-11',
    startTime: '07:30',
    timeZone: 'America/Chicago',
    wave: 'Wave 2',
    goalTimeSec: 4 * 3600,
    strategy,
    daysToRace: 4,
    ...overrides,
  });
}

/** Body rows of the gel timeline table. */
function timelineRows(): HTMLElement[] {
  const table = screen.getByText('When to take each gel').closest('table')!;
  return within(table).getAllByRole('row').slice(1);
}

function cells(row: HTMLElement): string[] {
  return within(row).getAllByRole('cell').map((c) => c.textContent ?? '');
}

function dayCard(name: string | RegExp): HTMLElement {
  return screen.getByRole('heading', { level: 4, name }).closest('article')!;
}

afterEach(() => cleanup());

describe('FuelPanel', () => {
  it('shows empty states and a body-mass prompt with no race or profile, and persists nothing', () => {
    const { container } = render(<FuelPanel ctx={baseCtx()} />);
    expect(screen.getByRole('heading', { level: 3, name: 'Race fueling' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Carb loading' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Hydration' })).toBeTruthy();
    expect(screen.getByText('Pick a race to plan your fueling')).toBeTruthy();
    expect(screen.queryByText('When to take each gel')).toBeNull();
    // No default weight is ever assumed for carb loading.
    expect(screen.getByLabelText('Body mass (lb)')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 4 })).toBeNull();
    expect(screen.getByText('Drink to thirst.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/every aid station/i);
    expect(persistence.keys()).toEqual([]);
  });

  it('asks for a goal time when the race has neither a strategy nor a goal', () => {
    render(<FuelPanel ctx={chicagoCtx({ strategy: null, goalTimeSec: null })} />);
    expect(screen.getByText('Add a goal time')).toBeTruthy();
    expect(screen.queryByText('When to take each gel')).toBeNull();
  });

  it('renders the seeded Chicago timeline on the shared cadence, in miles, without persisting anything', () => {
    render(<FuelPanel ctx={chicagoCtx()} />);
    expect(screen.getByText('Target 60 g/h')).toBeTruthy();
    expect(screen.getByText('A gel every 25 min')).toBeTruthy();
    expect(screen.queryByText('Needs glucose + fructose')).toBeNull();

    const rows = timelineRows();
    expect(cells(rows[0])[0]).toBe('15 min before start');
    expect(cells(rows[0])[2]).toContain('Pre-race gel');
    expect(cells(rows[1])[0]).toBe('0:25');
    expect(cells(rows[1])[2]).toContain('Gel 1');
    for (const row of rows.slice(1)) {
      expect(cells(row)[1]).toMatch(/^\d+\.\d mi$/);
      expect(cells(row)[3]).toBe('25 g');
    }
    // No gel in the final 15 minutes of a 4:00 finish.
    const [h, m] = cells(rows[rows.length - 1])[0].split(':').map(Number);
    expect(h * 60 + m).toBeLessThanOrEqual(225);
    expect(persistence.keys()).toEqual([]);
  });

  it('fuels on even pace from the goal time when there is no strategy', () => {
    render(<FuelPanel ctx={chicagoCtx({ strategy: null })} />);
    const rows = timelineRows();
    expect(rows.length).toBeGreaterThan(5);
    // 25 min into an even-paced 4:00 marathon ≈ 2.7 mi.
    expect(cells(rows[1])[1]).toBe('2.7 mi');
  });

  it('validates and saves carb tolerance, then re-plans at the new rate', () => {
    render(<FuelPanel ctx={chicagoCtx()} />);
    const input = screen.getByLabelText('Carbs you can handle (g per hour)') as HTMLInputElement;
    const save = within(input.closest('form')!).getByRole('button', { name: 'Save' });
    expect(input.value).toBe('60');

    fireEvent.change(input, { target: { value: '120' } });
    fireEvent.click(save);
    expect(screen.getByRole('alert').textContent).toBe('Enter a value between 30 and 90 g per hour.');
    expect(getAthleteProfile().carbToleranceGPerHour).toBeUndefined();

    fireEvent.change(input, { target: { value: '90' } });
    fireEvent.click(save);
    expect(getAthleteProfile().carbToleranceGPerHour).toBe(90);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Saved.');
    expect(screen.getByText('Target 90 g/h')).toBeTruthy();
    expect(screen.getByText('A gel every 17 min')).toBeTruthy();
    expect(screen.getByText('Needs glucose + fructose')).toBeTruthy();
  });

  it('asks for body mass inline, validates it, and builds the carb-load plan once saved', () => {
    render(<FuelPanel ctx={chicagoCtx()} />);
    const input = screen.getByLabelText('Body mass (lb)');
    const form = input.closest('form')!;

    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByRole('alert').textContent).toBe('Enter your body mass in lb.');
    expect(getAthleteProfile().weightKg).toBeUndefined();

    fireEvent.change(input, { target: { value: '154' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(getAthleteProfile().weightKg).toBeCloseTo(69.9, 1);
    expect(screen.queryByLabelText('Body mass (lb)')).toBeNull();
    expect(screen.getByRole('heading', { level: 4, name: '2 days before' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: '1 day before' })).toBeTruthy();
  });

  it('plans carb loading with real dates, a g/kg selector, an optional lead-in day and a race-morning card', () => {
    updateAthleteProfile({ weightKg: 70 });
    const before = getAthleteProfile();
    render(<FuelPanel ctx={chicagoCtx()} />);

    const expectedDate = new Date(2026, 9, 10).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    expect(within(dayCard('1 day before')).getByText(expectedDate)).toBeTruthy();
    // Default 10 g/kg on the two loading days.
    expect(within(dayCard('1 day before')).getByText('700 g')).toBeTruthy();
    expect(within(dayCard('2 days before')).getByText('700 g')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 4, name: /3 days before/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Loading target'), { target: { value: '8' } });
    expect(within(dayCard('1 day before')).getByText('560 g')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Include an optional lead-in day/));
    expect(screen.getByRole('heading', { level: 4, name: '3 days before (optional)' })).toBeTruthy();

    // Race morning: 2.5 g/kg, about 3 h before a 07:30 start.
    const morning = dayCard('Race morning');
    expect(morning.textContent).toContain('175 g');
    expect(morning.textContent).toContain('(around 04:30)');
    expect(screen.getByText(/Expect the scale to go up/).textContent).toContain('about 2–4 lb');

    // Rendering and planner controls never write the profile.
    expect(getAthleteProfile()).toEqual(before);
  });

  it('gives safe hydration guidance: drink to thirst, a personal ceiling and an over-drinking caution', () => {
    updateAthleteProfile({ sweatRateLPerHour: 1.5 });
    const { container } = render(<FuelPanel ctx={chicagoCtx()} />);
    expect(screen.getByText('Drink to thirst.')).toBeTruthy();
    // 80% of 1.5 L/h = 1200 mL/h → capped at 800 mL/h; mile users also see oz.
    expect(screen.getByText(/Your upper limit:/).textContent).toContain('800 mL (27 oz) per hour');
    expect(container.textContent).toContain('42°F–60°F');
    expect(container.textContent).toMatch(/Sodium: about 300–600 mg per hour/);
    const caution = screen.getByRole('complementary', { name: 'Over-drinking warning' });
    expect(caution.textContent).toMatch(/hyponatremia/);
    expect(caution.textContent).toMatch(/headache, nausea/);
    expect(container.textContent).not.toMatch(/every aid station/i);
  });

  it('shows the sweat-test tip when the sweat rate is unknown', () => {
    render(<FuelPanel ctx={chicagoCtx()} />);
    expect(screen.queryByText(/Your upper limit:/)).toBeNull();
    expect(screen.getByText(/Know your sweat rate/).textContent).toContain('each pound lost is about 16 oz (450 mL)');
  });

  it('uses km, mL and °C for km users — no miles, ounces or °F', () => {
    setDistanceUnit('km');
    updateAthleteProfile({ weightKg: 70, sweatRateLPerHour: 0.6 });
    const { container } = render(<FuelPanel ctx={chicagoCtx()} />);
    for (const row of timelineRows().slice(1)) {
      expect(cells(row)[1]).toMatch(/^\d+\.\d km$/);
    }
    // 80% of 0.6 L/h = 480 mL/h.
    expect(screen.getByText(/Your upper limit:/).textContent).toContain('480 mL per hour');
    expect(container.textContent).toContain('6°C–16°C');
    expect(container.textContent).not.toContain('°F');
    expect(container.textContent).not.toMatch(/\boz\b/);
    expect(container.textContent).not.toMatch(/\d mi\b/);
    expect(screen.getByLabelText('Carbs you can handle (g per hour)')).toBeTruthy();
    expect(screen.getByText(/Expect the scale to go up/).textContent).toContain('about 1–2 kg');
  });
});
