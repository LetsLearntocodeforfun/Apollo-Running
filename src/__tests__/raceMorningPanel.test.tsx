/**
 * RTL smoke tests for the Race Morning panel (Race Day hub, v1.0.6).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import RaceMorningPanel from '../components/race/RaceMorningPanel';
import type { RaceDayContext } from '../components/race/types';
import { getMarathonById } from '../data/worldMajors';
import { buildRaceStrategy, importCustomMarathon } from '../services/raceStrategy';
import { getMyRace } from '../services/myRace';

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

function chicagoCtx(): RaceDayContext {
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
  });
}

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

describe('RaceMorningPanel', () => {
  it('shows an empty state when no race is selected', () => {
    render(<RaceMorningPanel ctx={baseCtx()} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Race morning' })).toBeTruthy();
    expect(screen.getByText('Pick your race first')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy as text' })).toBeNull();
  });

  it('asks for a start time when neither the context nor the race has one, then builds the timeline', () => {
    const race = importCustomMarathon({
      name: 'Hometown Marathon',
      city: 'Hometown',
      country: 'USA',
      date: '2026-11-15',
      courseType: 'loop',
    });
    render(<RaceMorningPanel ctx={baseCtx({ race, raceDate: '2026-11-15', goalTimeSec: 4 * 3600 })} />);
    expect(screen.getByText('Add your start time')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy as text' })).toBeNull();

    fireEvent.change(screen.getByLabelText(/Start time/), { target: { value: '08:00' } });
    expect(screen.queryByText('Add your start time')).toBeNull();
    expect(screen.getByText('Gun time — race start')).toBeTruthy();
    expect(screen.getByText('8:00 AM')).toBeTruthy();
    expect(screen.getByText('Times are race-local')).toBeTruthy();
  });

  it('renders the seeded Chicago timeline in race-local time without persisting anything', () => {
    render(<RaceMorningPanel ctx={chicagoCtx()} />);
    expect(screen.getByText('Times are race-local (CDT)')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Pre-race' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Race' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Post-race' })).toBeTruthy();
    const gun = screen.getByText('Gun time — race start').closest('li')!;
    expect(gun.querySelector('time')!.textContent).toBe('7:30 AM');
    expect(gun.textContent).toContain('Your start: Wave 2.');
    // Chicago (47,000 starters) defaults to arriving 120 min early.
    expect(screen.getByText('Arrive at the start area').closest('li')!.querySelector('time')!.textContent).toBe('5:30 AM');
    // Fuel rows come from planRaceFueling (time-based).
    expect(screen.getAllByText(/^Gel \d+/).length).toBeGreaterThan(3);
    expect(screen.getByText(/^5K$/)).toBeTruthy();
    // Rendering must not write My Race.
    expect(getMyRace()).toEqual({});
  });

  it('saves the setup to My Race only when Save is clicked', () => {
    render(<RaceMorningPanel ctx={chicagoCtx()} />);
    fireEvent.change(screen.getByLabelText('Travel to the start (min)'), { target: { value: '45' } });
    fireEvent.change(screen.getByLabelText('Breakfast size'), { target: { value: 'full' } });
    fireEvent.click(screen.getByLabelText(/Include a short warm-up/));
    expect(getMyRace()).toEqual({});
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save setup' }));
    const saved = getMyRace();
    expect(saved.startTime).toBe('07:30');
    expect(saved.wave).toBe('Wave 2');
    expect(saved.travelMinutes).toBe(45);
    expect(saved.mealSize).toBe('full');
    expect(saved.warmup).toBe(true);
    expect(saved.arrivalLeadMin).toBeUndefined();
    expect(screen.getByText('Race-morning setup saved.')).toBeTruthy();
    expect(screen.getByText(/Warmup: easy jog/)).toBeTruthy();
  });

  it('collapses the setup form with an aria-expanded disclosure', () => {
    render(<RaceMorningPanel ctx={chicagoCtx()} />);
    const toggle = screen.getByRole('button', { name: /Race-morning setup/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.hidden).toBe(true);
  });

  it('copies the timeline with the Clipboard API and announces it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<RaceMorningPanel ctx={chicagoCtx()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }));
    await waitFor(() => expect(screen.getByText('Timeline copied to the clipboard.')).toBeTruthy());
    const text = (writeText.mock.calls[0] as unknown[])[0] as string;
    expect(text).toContain('Chicago');
    expect(text).toContain('Times are race-local (CDT)');
  });

  it('falls back to a hidden textarea + execCommand when the Clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
    render(<RaceMorningPanel ctx={chicagoCtx()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }));
    await waitFor(() => expect(screen.getByText('Timeline copied to the clipboard.')).toBeTruthy());
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('.rm-copy-buffer')).toBeNull();
  });

  it('shows the text for manual copying when copying fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => false), configurable: true, writable: true });
    render(<RaceMorningPanel ctx={chicagoCtx()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as text' }));
    await waitFor(() => expect(screen.getByLabelText('Timeline as text')).toBeTruthy());
    expect((screen.getByLabelText('Timeline as text') as HTMLTextAreaElement).value).toContain('RACE DAY TIMELINE');
  });
});
