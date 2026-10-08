/**
 * v1.0.6 (U): Progress page (Analytics + Insights merged).
 * Covers the tab/URL state, the race-prediction card (v1.0.6 fields and
 * legacy objects), B2 (no Coaching tab), B12 (refresh after store events)
 * and the 1.0.5 Recaps bug (exactly one past recap showed a blank tab).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { RacePrediction } from '../services/racePrediction';
import type { DailyRecap } from '../services/dailyRecap';
import { persistence } from '../services/db/persistence';
import { updateAthleteProfile } from '../services/athleteProfile';
import { addDays, todayKey } from '../utils/localDate';
import Progress from '../pages/Progress';

const { calculateRacePrediction } = vi.hoisted(() => ({
  calculateRacePrediction: vi.fn<() => RacePrediction | null>(() => null),
}));

vi.mock('../services/racePrediction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/racePrediction')>();
  return { ...actual, calculateRacePrediction };
});

vi.mock('../components/fitness/FitnessFormChart', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ raceDate }: { raceDate?: string | null }) =>
      createElement('div', { 'data-testid': 'fitness-chart-stub' }, `raceDate:${String(raceDate)}`),
  };
});

vi.mock('../pages/Analytics', async () => {
  const { createElement } = await import('react');
  return {
    default: ({ embedded }: { embedded?: boolean }) =>
      createElement('div', { 'data-testid': 'analytics-stub' }, `embedded:${String(embedded)}`),
  };
});

vi.mock('../components/RecoveryCard', async () => {
  const { createElement } = await import('react');
  return { default: () => createElement('div', { 'data-testid': 'recovery-stub' }) };
});

const PREDICTION_EMPTY =
  'Add a recent race in Settings › Athlete Profile (or sync a race) to see a prediction.';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderProgress(entry = '/progress') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/progress" element={<Progress />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function legacyPrediction(overrides: Partial<RacePrediction> = {}): RacePrediction {
  return {
    marathonTimeSec: 14400,
    marathonTimeFormatted: '4:00:00',
    confidence: 62,
    vdot: 38,
    method: 'daniels_riegel_blend',
    halfMarathonTimeSec: 6900,
    halfMarathonFormatted: '1:55:00',
    tenKTimeSec: 3200,
    tenKFormatted: '53:20',
    fiveKTimeSec: 1540,
    fiveKFormatted: '25:40',
    updatedAt: '2026-09-01T08:00:00.000Z',
    trend: 'stable',
    ...overrides,
  };
}

function recap(date: string, overrides: Partial<DailyRecap> = {}): DailyRecap {
  return {
    date,
    plannedWorkout: 'Easy run',
    plannedDistanceMi: 5,
    actualDistanceMi: 0,
    actualPaceMinPerMi: 0,
    movingTimeSec: 0,
    completed: false,
    synced: false,
    distanceDiffMi: 0,
    distanceDiffPct: 0,
    metPlan: false,
    exceededPlan: false,
    weekNumber: 3,
    weeklyMileage: null,
    coachMessage: 'Keep it easy.',
    grade: 'solid',
    generatedAt: `${date}T20:00:00.000Z`,
    ...overrides,
  };
}

beforeEach(() => {
  calculateRacePrediction.mockReset();
  calculateRacePrediction.mockImplementation(() => null);
});

describe('Progress page', () => {
  it('renders the title, the five tabs and the prediction empty state with no data', () => {
    renderProgress();
    expect(screen.getByRole('heading', { level: 1, name: 'Progress' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Overview', 'Fitness & Form', 'Trends', 'Heart Rate', 'Recaps']);
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(PREDICTION_EMPTY)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a recent race' }).getAttribute('href')).toBe('/settings?tab=profile');
    // No plan: the countdown offers a way to pick one instead of a dead end.
    expect(screen.getByRole('link', { name: 'Choose a plan' }).getAttribute('href')).toBe('/plan');
    // No source and no stored activities: the connect CTA is shown above the tabs.
    expect(screen.getByRole('heading', { level: 2, name: 'Connect your training data' })).toBeTruthy();
  });

  it('shows the v1.0.6 prediction fields: range, source, confidence, basis, trend and goal', () => {
    updateAthleteProfile({ goalMarathonSec: 3 * 3600 + 20 * 60 });
    calculateRacePrediction.mockImplementation(() => legacyPrediction({
      marathonTimeSec: 12600,
      marathonTimeFormatted: '3:30:00',
      confidence: 80,
      vdot: 45.2,
      method: 'daniels_vdot',
      trend: 'improving',
      previousMarathonTimeSec: 12735,
      rangeLowSec: 12300,
      rangeHighSec: 13020,
      vdotSource: 'recent_race',
      sourceLabel: 'Recent race',
      confidenceLevel: 'high',
      basis: 'Based on your 10K of 46:40 on Sep 20.',
      asOf: '2026-09-20',
    }));
    renderProgress();
    expect(screen.getByText('3:30:00')).toBeTruthy();
    expect(screen.getByText('Likely range 3:25:00–3:37:00')).toBeTruthy();
    expect(screen.getByText('Recent race')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('Based on your 10K of 46:40 on Sep 20.')).toBeTruthy();
    expect(screen.getByText('2:15 faster than the previous prediction (3:32:15)')).toBeTruthy();
    expect(screen.getByText('Improving')).toBeTruthy();
    // The goal is shown next to the prediction, never instead of it.
    expect(screen.getByText('Goal 3:20:00')).toBeTruthy();
    expect(screen.queryByText(PREDICTION_EMPTY)).toBeNull();
  });

  it('renders a legacy prediction without the optional fields (confidence falls back to %)', () => {
    calculateRacePrediction.mockImplementation(() => legacyPrediction());
    renderProgress();
    expect(screen.getByText('4:00:00')).toBeTruthy();
    expect(screen.getByText('62%')).toBeTruthy();
    expect(screen.getByText('daniels riegel blend')).toBeTruthy();
    expect(screen.queryByText(/Likely range/)).toBeNull();
    expect(screen.queryByText(/^Goal /)).toBeNull();
  });

  it('deep-links to Trends (embedded Analytics) and Fitness, and keeps the tab in the URL', () => {
    renderProgress('/progress?tab=trends&period=90');
    expect(screen.getByTestId('analytics-stub').textContent).toBe('embedded:true');
    expect(screen.getByRole('tab', { name: 'Trends' }).getAttribute('aria-selected')).toBe('true');

    fireEvent.click(screen.getByRole('tab', { name: 'Fitness & Form' }));
    const search = new URLSearchParams(screen.getByTestId('location').textContent?.split('?')[1] ?? '');
    expect(search.get('tab')).toBe('fitness');
    expect(search.get('period')).toBe('90'); // other params are kept
    expect(screen.getByTestId('fitness-chart-stub').textContent).toBe('raceDate:null');
    // Only the active panel renders.
    expect(screen.queryByTestId('analytics-stub')).toBeNull();
  });

  it('renders the Fitness tab directly from ?tab=fitness', () => {
    renderProgress('/progress?tab=fitness');
    expect(screen.getByTestId('fitness-chart-stub')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Fitness & Form' })).toBeTruthy();
  });

  it('falls back to Overview for an unknown ?tab value', () => {
    renderProgress('/progress?tab=bogus');
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(PREDICTION_EMPTY)).toBeTruthy();
  });

  it('lists exactly one past recap instead of a blank tab (1.0.5 regression)', () => {
    const date = addDays(todayKey(), -2);
    persistence.setItem('apollo_daily_recaps', JSON.stringify({
      [date]: recap(date, { plannedWorkout: 'Tempo 6', grade: 'strong' }),
    }));
    renderProgress('/progress?tab=recaps');
    const region = screen.getByRole('region', { name: 'Recent recaps' });
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);
    expect(within(region).getByText('Tempo 6')).toBeTruthy();
    expect(within(region).getByText('strong')).toBeTruthy();
    expect(screen.queryByText('No recaps yet')).toBeNull();
  });

  it('shows the recaps empty state with a link to the recap settings', () => {
    renderProgress('/progress?tab=recaps');
    const region = screen.getByRole('region', { name: 'Recent recaps' });
    expect(within(region).getByText('No recaps yet')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Recap settings' }).getAttribute('href')).toBe('/settings?tab=coaching');
  });

  it('has no Coaching tab (B2) and the Heart Rate tab links to Settings for editing', () => {
    renderProgress('/progress?tab=heart-rate');
    expect(screen.queryByRole('tab', { name: /coaching/i })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('link', { name: 'Edit heart rate in Settings' }).getAttribute('href')).toBe('/settings?tab=profile');
    // Read-only: no inputs, a real zones table, and a connect prompt without HR data.
    expect(screen.queryByRole('spinbutton')).toBeNull();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').length).toBe(4);
    expect(within(table).getAllByRole('rowheader').length).toBe(5);
    expect(screen.getByText('Default values (not personalised yet)')).toBeTruthy();
    const empty = screen.getByRole('region', { name: 'Your heart-rate data' });
    expect(within(empty).getByRole('link', { name: 'Connect a data source' }).getAttribute('href')).toBe('/settings?tab=connections');
  });

  it('labels an age-estimated HR profile in plain language', () => {
    persistence.setItem('apollo_hr_profile', JSON.stringify({ maxHR: 185, restingHR: 52, source: 'age-estimate', updatedAt: '' }));
    renderProgress('/progress?tab=heart-rate');
    expect(screen.getByText('Estimated from your birth year')).toBeTruthy();
    expect(screen.getByText('185 bpm')).toBeTruthy();
    expect(screen.getByText('52 bpm')).toBeTruthy();
  });

  it('recomputes the prediction after a store event (B12)', () => {
    renderProgress();
    expect(screen.getByText(PREDICTION_EMPTY)).toBeTruthy();
    const callsBefore = calculateRacePrediction.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    calculateRacePrediction.mockImplementation(() => legacyPrediction({ marathonTimeFormatted: '3:59:00', marathonTimeSec: 14340 }));
    act(() => {
      window.dispatchEvent(new CustomEvent('apollo:plan-overlay-changed'));
    });
    expect(calculateRacePrediction.mock.calls.length).toBe(callsBefore + 1);
    expect(screen.getByText('3:59:00')).toBeTruthy();
    expect(screen.queryByText(PREDICTION_EMPTY)).toBeNull();
  });
});
