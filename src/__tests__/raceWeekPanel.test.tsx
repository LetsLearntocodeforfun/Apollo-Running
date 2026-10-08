/**
 * RTL smoke tests for the Race Week tab (v1.0.6): RaceWeekPanel →
 * RaceChecklistPanel + RaceCardPanel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import RaceWeekPanel from '@/components/race/RaceWeekPanel';
import type { RaceDayContext } from '@/components/race/types';
import { buildRaceStrategy, getMarathon } from '@/services/raceStrategy';
import { getAllChecklists } from '@/services/raceChecklist';
import { getRaceCardPrefs } from '@/services/raceCard';
import { setDistanceUnit } from '@/services/unitPreferences';

function emptyCtx(): RaceDayContext {
  return {
    race: null,
    raceDate: null,
    startTime: null,
    timeZone: null,
    wave: null,
    goalTimeSec: null,
    strategy: null,
    today: '2027-04-01',
    daysToRace: null,
  };
}

function bostonCtx(): RaceDayContext {
  const race = getMarathon('boston');
  const strategy = buildRaceStrategy('boston', 4 * 3600, 'even-split');
  if (!race || !strategy) throw new Error('Boston fixture unavailable');
  return {
    race,
    raceDate: '2027-04-19',
    startTime: '10:50',
    timeZone: 'America/New_York',
    wave: '3',
    goalTimeSec: 4 * 3600,
    strategy,
    today: '2027-04-12',
    daysToRace: 7,
  };
}

const progressText = () => document.querySelector('.race-week-progress-text')?.textContent ?? '';
const previewHtml = () => screen.getByTitle('Race card preview').getAttribute('srcdoc') ?? '';

beforeEach(() => {
  setDistanceUnit('mi');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RaceWeekPanel', () => {
  it('renders a generic checklist and the strategy empty state without a race', () => {
    render(<RaceWeekPanel ctx={emptyCtx()} />);

    expect(screen.getByRole('heading', { level: 2, name: 'Race week checklist' })).toBeTruthy();
    expect(screen.getByText(/No race selected/)).toBeTruthy();
    expect(progressText()).toMatch(/^0 of \d+ done \(0%\)$/);

    const lists = getAllChecklists();
    expect(lists).toHaveLength(1);
    expect(lists[0].marathonId).toBeUndefined();

    expect(screen.getByText('Save a race strategy on the Strategy tab first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull();
    expect(screen.queryByTitle('Race card preview')).toBeNull();
  });

  it('does not create a second list on re-render', () => {
    const { rerender } = render(<RaceWeekPanel ctx={emptyCtx()} />);
    rerender(<RaceWeekPanel ctx={emptyCtx()} />);
    expect(getAllChecklists()).toHaveLength(1);
  });

  it('shows course items, print/download and a sandboxed preview for a seeded race', () => {
    render(<RaceWeekPanel ctx={bostonCtx()} />);

    expect(getAllChecklists()[0].marathonId).toBe('boston');
    const logistics = screen.getByRole('button', { name: /^Logistics/ });
    expect(logistics.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(logistics);
    expect(logistics.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(logistics.getAttribute('aria-controls')!)!;
    expect(within(body).getByRole('checkbox', { name: /Hopkinton/ })).toBeTruthy();

    expect(screen.getByRole('heading', { level: 2, name: 'Race card' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /print/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /download html/i })).toBeTruthy();
    const preview = screen.getByTitle('Race card preview');
    expect(preview.tagName).toBe('IFRAME');
    expect(preview.getAttribute('sandbox')).toBe('');
    expect(previewHtml()).toContain('Boston');
    expect(previewHtml()).toContain('/mi');
    expect(previewHtml()).toContain('Wave 3');
  });

  it('checks, adds, removes, hides and resets checklist items', () => {
    render(<RaceWeekPanel ctx={emptyCtx()} />);
    const total = Number(/of (\d+)/.exec(progressText())![1]);

    const gear = screen.getByRole('button', { name: /^Gear & Equipment/ });
    fireEvent.click(gear);
    const body = document.getElementById(gear.getAttribute('aria-controls')!)!;

    // Check an item
    fireEvent.click(within(body).getByRole('checkbox', { name: /Race shoes/ }));
    expect(progressText()).toBe(`1 of ${total} done (${Math.round(100 / total)}%)`);
    expect(gear.textContent).toMatch(/1\/\d+/);

    // Add and remove a custom item
    const input = within(body).getByLabelText('New item for Gear & Equipment');
    fireEvent.change(input, { target: { value: 'Lucky socks' } });
    fireEvent.click(within(body).getByRole('button', { name: /Add item to Gear & Equipment/ }));
    expect(within(body).getByText('Lucky socks')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('');
    expect(progressText()).toMatch(new RegExp(`of ${total + 1} done`));
    fireEvent.click(within(body).getByRole('button', { name: 'Remove: Lucky socks' }));
    expect(within(body).queryByText('Lucky socks')).toBeNull();

    // Hide a default item: excluded from progress, listed under "Show hidden"
    fireEvent.click(within(body).getByRole('button', { name: /^Hide: Socks/ }));
    expect(progressText()).toMatch(new RegExp(`of ${total - 1} done`));
    const showHidden = screen.getByRole('button', { name: 'Show hidden (1)' });
    expect(within(body).queryByText(/^Socks/)).toBeNull();
    fireEvent.click(showHidden);
    expect(showHidden.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(body).getByRole('button', { name: /^Unhide: Socks/ }));
    expect(screen.queryByRole('button', { name: /Show hidden/ })).toBeNull();

    // Reset behind a confirmation
    fireEvent.click(screen.getByRole('button', { name: 'Reset checklist' }));
    expect(screen.getByText('Reset checklist?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset', hidden: true }));
    expect(progressText()).toBe(`0 of ${total} done (0%)`);
    expect(screen.queryByText('Reset checklist?')).toBeNull();
  }, 60_000); // the heaviest RTL test (many role queries over the full checklist); slow on CI runners

  it('cancelling the reset keeps checked items', () => {
    render(<RaceWeekPanel ctx={emptyCtx()} />);
    const gear = screen.getByRole('button', { name: /^Gear & Equipment/ });
    fireEvent.click(gear);
    fireEvent.click(screen.getByRole('checkbox', { name: /Race shoes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset checklist' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', hidden: true }));
    expect(progressText()).toMatch(/^1 of/);
  });

  it('saves emergency contact and mantras only on Save, escaping them in the preview', () => {
    render(<RaceWeekPanel ctx={bostonCtx()} />);
    const save = screen.getByRole('button', { name: 'Save details' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Sam <b>Lee</b>' } });
    fireEvent.change(screen.getByLabelText('Contact phone'), { target: { value: '+1 555 0100' } });
    fireEvent.change(screen.getByLabelText('Mantra at mile 13'), { target: { value: 'Halfway — stay calm' } });

    expect(previewHtml()).toContain('Sam &lt;b&gt;Lee&lt;/b&gt;');
    expect(previewHtml()).not.toContain('<b>Lee</b>');
    expect(previewHtml()).toContain('Halfway — stay calm');
    expect(getRaceCardPrefs().emergencyContact).toBeUndefined();

    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    const prefs = getRaceCardPrefs();
    expect(prefs.emergencyContact).toEqual({ name: 'Sam <b>Lee</b>', phone: '+1 555 0100' });
    expect(prefs.defaultMantras?.[13]).toBe('Halfway — stay calm');
    expect(screen.getByRole('status').textContent).toMatch(/saved/i);
    expect(save.disabled).toBe(true);
  });

  it('shows km to km users', () => {
    setDistanceUnit('km');
    render(<RaceWeekPanel ctx={bostonCtx()} />);
    expect(screen.getByLabelText('Mantra at km 21')).toBeTruthy();
    expect(screen.queryByLabelText(/Mantra at mile/)).toBeNull();
    expect(previewHtml()).toContain('/km');
    expect(screen.getByText(/goal 4:00:00 · \d+:\d{2}\/km/)).toBeTruthy();
  });

  it('prints through a hidden iframe (no window.open) and downloads via a link', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const urlApi = URL as unknown as Record<string, unknown>;
    const hadCreate = 'createObjectURL' in URL;
    const prevCreate = urlApi.createObjectURL;
    const prevRevoke = urlApi.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:race-card'), configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });

    try {
      render(<RaceWeekPanel ctx={bostonCtx()} />);
      fireEvent.click(screen.getByRole('button', { name: /print/i }));
      expect(openSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('status').textContent).toMatch(/print/i);

      fireEvent.click(screen.getByRole('button', { name: /download html/i }));
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status').textContent).toBe('Race card downloaded.');
    } finally {
      document.querySelectorAll('iframe[data-apollo-print-frame]').forEach((f) => f.remove());
      if (hadCreate) {
        Object.defineProperty(URL, 'createObjectURL', { value: prevCreate, configurable: true, writable: true });
        Object.defineProperty(URL, 'revokeObjectURL', { value: prevRevoke, configurable: true, writable: true });
      } else {
        delete urlApi.createObjectURL;
        delete urlApi.revokeObjectURL;
      }
    }
  });
});
