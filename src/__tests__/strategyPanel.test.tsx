/**
 * RTL tests for the Strategy tab of the Race Day hub (v1.0.6): StrategyPanel,
 * StrategyBuilder and MarathonBrowser. Covers the empty state and no opt-in
 * gate (RS-14), preview-then-save (RS-5), goal validation (RS-11), split size
 * and halves (RS-4), the split-difference sign (RS-12), km tables (RS-10),
 * the chart highlight (RS-13), confirm-before-delete (RS-15) and keyboard-
 * accessible race cards.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import StrategyPanel from '../components/race/StrategyPanel';
import type { RaceDayContext } from '../components/race/types';
import {
  buildRaceStrategy,
  getAllStrategies,
  getMarathon,
  getStrategyById,
  importCustomMarathon,
  saveStrategy,
} from '../services/raceStrategy';
import { getMyRace, setMyRace } from '../services/myRace';
import { setDistanceUnit } from '../services/unitPreferences';
import { persistence } from '../services/db/persistence';
import type { RaceStrategy } from '../types/raceStrategy';

const TODAY = '2026-10-08';

function ctxFor(raceId: string | null, overrides: Partial<RaceDayContext> = {}): RaceDayContext {
  const race = raceId ? getMarathon(raceId) ?? null : null;
  return {
    race,
    raceDate: race?.date ?? null,
    startTime: race?.startTime ?? null,
    timeZone: race?.timeZone ?? null,
    wave: null,
    goalTimeSec: null,
    strategy: null,
    today: TODAY,
    daysToRace: null,
    ...overrides,
  };
}

function saved(raceId: string, goalSec: number, name: string, pacing: RaceStrategy['pacingStrategy'] = 'even-split'): RaceStrategy {
  const s = buildRaceStrategy(raceId, goalSec, pacing, name);
  if (!s) throw new Error('fixture: strategy did not build');
  saveStrategy(s);
  return s;
}

function goalInputs(): { h: HTMLInputElement; m: HTMLInputElement; s: HTMLInputElement } {
  const group = screen.getByRole('group', { name: 'Goal finish time' });
  const [h, m, s] = within(group).getAllByRole('spinbutton') as HTMLInputElement[];
  return { h, m, s };
}

function stat(name: string): string {
  return screen.getByTestId(`rs-stat-${name}`).textContent ?? '';
}

function splitRows(): HTMLElement[] {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1);
}

function viewButton(name: string | RegExp): HTMLElement {
  return within(screen.getByRole('group', { name: 'Strategy views' })).getByRole('button', { name });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 8, 12, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StrategyPanel — empty', () => {
  it('asks to pick a race, has no opt-in gate and writes nothing', () => {
    const { container } = render(<StrategyPanel ctx={ctxFor(null)} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Race strategy' })).toBeTruthy();
    expect(screen.getByText('Pick your race')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /enable/i })).toBeNull();
    expect(container.textContent).not.toContain('🇺🇸');
    expect(persistence.keys()).toEqual([]);
  });
});

describe('StrategyBuilder via StrategyPanel', () => {
  it('previews a Boston 4:00 even split with equal halves and saves only on Save (RS-1, RS-5)', () => {
    const onChanged = vi.fn();
    render(<StrategyPanel ctx={ctxFor('boston')} onChanged={onChanged} />);
    const { h, m, s } = goalInputs();
    expect([h.value, m.value, s.value]).toEqual(['4', '0', '0']); // default goal without profile/prediction

    fireEvent.click(screen.getByRole('radio', { name: /Even split/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    expect(screen.getByText('Preview (not saved)')).toBeTruthy();
    expect(stat('first-half')).toBe('2:00:00');
    expect(stat('second-half')).toBe('2:00:00');
    expect(stat('split-difference')).toBe('0:00 (even)');
    expect(stat('target')).toBe('4:00:00');
    expect(screen.getByRole('columnheader', { name: 'Mile' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Pace (/mi)' })).toBeTruthy();
    expect(splitRows()).toHaveLength(27);

    // Nothing is saved by previewing.
    expect(getAllStrategies()).toHaveLength(0);
    expect(persistence.getItem('apollo_race_strategies')).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save strategy' }));
    const all = getAllStrategies();
    expect(all).toHaveLength(1);
    expect(all[0].marathonId).toBe('boston');
    expect(all[0].targetTimeSec).toBe(14400);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Save strategy' })).toBeNull();
    expect(screen.getByText('Saved strategy')).toBeTruthy();
    expect(viewButton('My strategies (1)')).toBeTruthy();
  });

  it('negative split: the split size shows the halves, and the difference is signed (RS-4, RS-12)', () => {
    render(<StrategyPanel ctx={ctxFor('boston')} />);
    expect((screen.getByRole('radio', { name: /Negative split/ }) as HTMLInputElement).checked).toBe(true);
    const size = screen.getByLabelText('Split size (%)') as HTMLInputElement;
    expect(size.value).toBe('1.5');
    expect(screen.getByText(/First half 2:00:54, second half 1:59:06\./)).toBeTruthy();

    fireEvent.change(size, { target: { value: '3' } });
    expect(screen.getByText(/First half 2:01:50, second half 1:58:10\./)).toBeTruthy();
    fireEvent.change(size, { target: { value: '9' } });
    expect(size.value).toBe('5'); // clamped
    fireEvent.change(size, { target: { value: '1.5' } });

    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    expect(stat('first-half')).toBe('2:00:54');
    expect(stat('second-half')).toBe('1:59:06');
    expect(stat('split-difference')).toBe('−1:48 (negative split)');

    // Changing an input makes the preview stale: no Save until it's updated.
    fireEvent.change(size, { target: { value: '2' } });
    expect(screen.getByText('Inputs changed. Update the preview before saving.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save strategy' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Update preview' }));
    expect(screen.getByRole('button', { name: 'Save strategy' })).toBeTruthy();
    expect(getAllStrategies()).toHaveLength(0);
  });

  it('positive split difference is "+" and worded as a positive split', () => {
    render(<StrategyPanel ctx={ctxFor('boston')} />);
    fireEvent.click(screen.getByRole('radio', { name: /Positive split/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    expect(stat('split-difference')).toMatch(/^\+\d+:\d{2} \(positive split\)$/);
  });

  it('rejects a 1:00:00 marathon inline and disables Preview (RS-11); inputs are clamped', () => {
    render(<StrategyPanel ctx={ctxFor('boston')} />);
    const { h, m } = goalInputs();
    fireEvent.change(h, { target: { value: '1' } });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/world record/i);
    expect(h.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: 'Preview plan' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(h, { target: { value: '40' } });
    expect(h.value).toBe('12');
    fireEvent.change(m, { target: { value: '75' } });
    expect(m.value).toBe('59');
    fireEvent.change(h, { target: { value: '3' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Preview plan' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('builds a 1:45 half marathon with halves at 6.55 mi', () => {
    const half = importCustomMarathon({
      name: 'Harvest Half', city: 'Portland', country: 'USA', date: '2026-11-15', courseType: 'loop', distanceMi: 13.1,
    });
    render(<StrategyPanel ctx={ctxFor(half.id)} />);
    const { h, m, s } = goalInputs();
    fireEvent.change(h, { target: { value: '1' } });
    fireEvent.change(m, { target: { value: '45' } });
    fireEvent.change(s, { target: { value: '0' } });
    expect(screen.getByText(/Average pace 8:01\/mi/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Even split/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    expect(stat('first-half')).toBe('52:30');
    expect(stat('second-half')).toBe('52:30');
    expect(splitRows()).toHaveLength(14);
  });

  it('km users get a 43-row km table with /km paces and metres (RS-10)', () => {
    setDistanceUnit('km');
    render(<StrategyPanel ctx={ctxFor('boston')} />);
    expect(screen.getByText(/Average pace \d+:\d{2}\/km/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Even split/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));

    expect(screen.getByText('Kilometre splits')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Km' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Pace (/km)' })).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: 'Mile' })).toBeNull();
    const rows = splitRows();
    expect(rows).toHaveLength(43);
    expect(within(rows[42]).getByRole('rowheader').textContent).toBe('42.2');
    for (const row of rows) {
      const elevation = within(row).getAllByRole('cell')[3].textContent ?? '';
      expect(elevation).toMatch(/^(0|[+−]\d+) m$/);
    }
    expect(stat('average-pace')).toMatch(/\/km$/);
  });

  it('focusing a split row highlights it on the course profile; the Half tag marks 13.1 mi (RS-13)', () => {
    render(<StrategyPanel ctx={ctxFor('boston')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview plan' }));
    expect(screen.queryByTestId('elevation-highlight')).toBeNull();
    const rows = splitRows();
    expect(rows[19].getAttribute('tabindex')).toBe('0');
    fireEvent.focus(rows[19]);
    expect(screen.getByTestId('elevation-highlight')).toBeTruthy();
    fireEvent.blur(rows[19]);
    expect(screen.queryByTestId('elevation-highlight')).toBeNull();

    const halfRows = rows.filter((r) => r.className.includes('rs-row-half'));
    expect(halfRows).toHaveLength(1);
    expect(within(halfRows[0]).getByRole('rowheader').textContent).toBe('14Half');
    expect(within(rows[26]).getByRole('rowheader').textContent).toBe('26.2');
  });
});

describe('My strategies', () => {
  it('"Use on race day" sets the My Race strategy', () => {
    const a = saved('boston', 14400, 'Plan A');
    const b = saved('boston', 13800, 'Plan B', 'negative-split');
    const onChanged = vi.fn();
    render(<StrategyPanel ctx={ctxFor('boston')} onChanged={onChanged} />);
    fireEvent.click(viewButton('My strategies (2)'));
    fireEvent.click(screen.getByRole('button', { name: 'Use Plan B on race day' }));
    expect(getMyRace().activeStrategyId).toBe(b.id);
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Use Plan B on race day' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Use Plan A on race day' })).toBeTruthy();
    expect(getStrategyById(a.id)).toBeTruthy();
  });

  it('deleting a strategy asks first and deletes only after confirming (RS-15)', () => {
    const s = saved('boston', 14400, 'Boston A');
    setMyRace({ raceId: 'boston', activeStrategyId: s.id });
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<StrategyPanel ctx={ctxFor('boston', { strategy: s })} />);
    fireEvent.click(viewButton('My strategies (1)'));
    expect(screen.getByText('Race-day strategy')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Boston A' }));
    let dialog = screen.getByRole('dialog', { name: 'Delete this strategy?' });
    expect(getStrategyById(s.id)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getStrategyById(s.id)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete Boston A' }));
    dialog = screen.getByRole('dialog', { name: 'Delete this strategy?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete strategy' }));
    expect(getStrategyById(s.id)).toBeUndefined();
    expect(getMyRace().activeStrategyId).toBeUndefined();
    expect(getMyRace().raceId).toBe('boston');
    expect(screen.getByText('No strategies yet')).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('removing a custom race asks first and clears it from My Race', () => {
    const race = importCustomMarathon({
      name: 'Harvest Half', city: 'Portland', country: 'USA', date: '2026-11-15', courseType: 'loop', distanceMi: 13.1,
    });
    const s = saved(race.id, 6300, 'Half plan');
    setMyRace({ raceId: race.id, activeStrategyId: s.id });
    render(<StrategyPanel ctx={ctxFor(race.id, { strategy: s })} />);
    fireEvent.click(viewButton('My strategies (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Harvest Half' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this race?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove race' }));
    expect(getMarathon(race.id)).toBeUndefined();
    expect(getStrategyById(s.id)).toBeUndefined();
    expect(getMyRace().raceId).toBeUndefined();
    expect(getMyRace().activeStrategyId).toBeUndefined();
  });
});

describe('MarathonBrowser in the Strategy tab', () => {
  it('race headers are buttons with aria-expanded/aria-controls; copy has no Majors count', () => {
    const { container } = render(<StrategyPanel ctx={ctxFor(null)} onChooseRace={vi.fn()} />);
    fireEvent.click(viewButton('Browse races'));

    const header = screen.getByRole('button', { name: /Boston Marathon/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    const controls = header.getAttribute('aria-controls') ?? '';
    expect(controls).not.toBe('');
    expect(document.getElementById(controls)).toBeNull();
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    const details = document.getElementById(controls);
    expect(details).toBeTruthy();
    for (const link of within(details as HTMLElement).queryAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(/^https:\/\//);
    }
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');

    expect(screen.getByRole('button', { name: 'World Marathon Majors' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/\b(six|seven|6|7)\s+(World\s+)?Marathon\s+Majors/i);
    expect(screen.getAllByText(/date to be confirmed/).length).toBeGreaterThan(0);
  });

  it('building for a race that is not My Race offers "Set as my race"', () => {
    const onChooseRace = vi.fn();
    render(<StrategyPanel ctx={ctxFor('boston')} onChooseRace={onChooseRace} />);
    fireEvent.click(viewButton('Browse races'));
    const chicagoCard = screen.getByRole('button', { name: /Chicago Marathon/ }).closest('article') as HTMLElement;
    fireEvent.click(within(chicagoCard).getByRole('button', { name: 'Build a strategy' }));

    expect(screen.getByText(/which isn't your race/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Set as my race' }));
    expect(onChooseRace).toHaveBeenCalledTimes(1);
    expect(onChooseRace.mock.calls[0][0].id).toBe('chicago');
  });
});
