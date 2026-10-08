/**
 * Settings tabs (v1.0.6): URL tabs, Athlete Profile save/validation,
 * delete-all flow, U1 connect-time sync choices, U7 source-scoped imports,
 * U8 write-only Strava secret and the per-card needs-reconnect banner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../components/ImportActivities', () => ({ default: () => null }));
vi.mock('../pages/settings/appReload', () => ({ reloadApp: vi.fn() }));
vi.mock('../services/dataManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dataManager')>();
  return { ...actual, deleteAllLocalData: vi.fn(() => Promise.resolve()) };
});
vi.mock('../services/activitySource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/activitySource')>();
  return { ...actual, connectIntervals: vi.fn() };
});
vi.mock('../services/autoSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/autoSync')>();
  return { ...actual, runSync: vi.fn() };
});

import Settings from '../pages/Settings';
import { reloadApp } from '../pages/settings/appReload';
import { deleteAllLocalData } from '../services/dataManager';
import { connectIntervals } from '../services/activitySource';
import { runSync, type AutoSyncReport } from '../services/autoSync';
import { getAppPreferences, setAppPreferences } from '../services/appPreferences';
import { getAthleteProfile, updateAthleteProfile } from '../services/athleteProfile';
import { getStravaCredentials, setIntervalsCredentials, setStravaCredentials } from '../services/storage';
import { getNeedsReconnect, setNeedsReconnect } from '../services/connectionHealth';
import { APP_VERSION } from '../version';
import { addDays, todayKey } from '../utils/localDate';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

function renderSettings(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Settings />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const syncReport: AutoSyncReport = {
  summary: {
    sources: ['intervals'], fetched: 3, added: 3, updated: 0, full: true, errors: [],
    startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z',
  },
  results: [],
};

type ConnectedAthlete = Awaited<ReturnType<typeof connectIntervals>>;

beforeEach(() => {
  vi.mocked(reloadApp).mockReset();
  vi.mocked(deleteAllLocalData).mockReset().mockResolvedValue(undefined);
  vi.mocked(connectIntervals).mockReset().mockResolvedValue({ firstname: 'Ana', lastname: 'Runner' } as ConnectedAthlete);
  vi.mocked(runSync).mockReset().mockResolvedValue(syncReport);
});

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('Settings tabs', () => {
  const cases: [string, RegExp][] = [
    ['connections', /Garmin, Zwift/],
    ['sync', /Automatic activity sync/],
    ['profile', /^Units$/],
    ['coaching', /Adaptive training recommendations/],
    ['data', /Your data stays on this device/],
    ['about', /^Apollo$/],
  ];

  it.each(cases)('renders the %s tab from ?tab=', (tab, heading) => {
    renderSettings(`/settings?tab=${tab}`);
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(`settings-tab-${tab}`);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { level: 2, name: heading })).toBeTruthy();
  });

  it('falls back to Connections for a missing or unknown tab', () => {
    renderSettings('/settings?tab=nope');
    expect(screen.getByRole('tab', { name: 'Connections' }).getAttribute('aria-selected')).toBe('true');
  });

  it('clicking a tab swaps the panel and updates ?tab= (keeping other params)', () => {
    renderSettings('/settings?tab=sync&from=today');
    fireEvent.click(screen.getByRole('tab', { name: 'Data & Privacy' }));
    expect(screen.getByRole('heading', { name: /Your data stays on this device/ })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Automatic activity sync/ })).toBeNull();
    const search = new URLSearchParams(screen.getByTestId('location').textContent ?? '');
    expect(search.get('tab')).toBe('data');
    expect(search.get('from')).toBe('today');
  });

  it('About shows the app version and links to Data & Privacy', () => {
    renderSettings('/settings?tab=about');
    expect(screen.getByText(APP_VERSION)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /Data & Privacy/ }).length).toBeGreaterThan(0);
  });

  it('lists network destinations with "Nothing is contacted until you turn it on"', () => {
    renderSettings('/settings?tab=data');
    expect(screen.getByText(/Nothing is contacted until you turn it on/)).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(1);
    expect(within(table).queryByText('Yes')).toBeNull();
  });
});

describe('Athlete Profile', () => {
  it('saves weight (converted from lb), recent race, goal time and carb tolerance', () => {
    updateAthleteProfile({ massUnit: 'lb' });
    renderSettings('/settings?tab=profile');
    const raceDate = addDays(todayKey(), -30);

    fireEvent.change(screen.getByLabelText('Weight (lb)'), { target: { value: '154.3' } });
    fireEvent.change(screen.getByLabelText('Distance'), { target: { value: '10k' } });
    fireEvent.change(screen.getByLabelText('Finish time'), { target: { value: '45:00' } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: raceDate } });
    fireEvent.change(screen.getByLabelText('Goal marathon time (optional)'), { target: { value: '3:30:00' } });
    fireEvent.change(screen.getByLabelText('Carbs you can take per hour (g/h)'), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    const profile = getAthleteProfile();
    expect(profile.weightKg).toBeCloseTo(70, 0);
    expect(profile.recentRace).toMatchObject({ distanceM: 10000, timeSec: 2700, date: raceDate });
    expect(profile.goalMarathonSec).toBe(12600);
    expect(profile.carbToleranceGPerHour).toBe(75);
    expect(screen.getByText('Profile saved.')).toBeTruthy();
  });

  it('shows an inline error and saves nothing when a field is invalid', () => {
    renderSettings('/settings?tab=profile');
    fireEvent.change(screen.getByLabelText(/^Weight/), { target: { value: '70' } });
    const carbs = screen.getByLabelText('Carbs you can take per hour (g/h)');
    fireEvent.change(carbs, { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    expect(carbs.getAttribute('aria-invalid')).toBe('true');
    const errorId = (carbs.getAttribute('aria-describedby') ?? '').split(' ').find((id) => id.endsWith('-error'));
    expect(errorId && document.getElementById(errorId)?.textContent).toBeTruthy();
    const profile = getAthleteProfile();
    expect(profile.weightKg).toBeUndefined();
    expect(profile.carbToleranceGPerHour).toBeUndefined();
    expect(screen.getByText(/Nothing was saved/)).toBeTruthy();
  });
});

describe('Delete all data', () => {
  it('requires typing DELETE, then deletes once and reloads', async () => {
    renderSettings('/settings?tab=data');
    fireEvent.click(screen.getByRole('button', { name: 'Delete all data…' }));
    const dialog = screen.getByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }));
    expect(deleteAllLocalData).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/Type DELETE in capital letters/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }));
    await waitFor(() => expect(reloadApp).toHaveBeenCalledTimes(1));
    expect(deleteAllLocalData).toHaveBeenCalledTimes(1);
  });

  it('shows the error and does not reload when deleting fails', async () => {
    vi.mocked(deleteAllLocalData).mockRejectedValueOnce(new Error('The disk is locked.'));
    renderSettings('/settings?tab=data');
    fireEvent.click(screen.getByRole('button', { name: 'Delete all data…' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Type DELETE to confirm'), { target: { value: 'DELETE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete everything' }));
    expect(await within(dialog).findByText('The disk is locked.')).toBeTruthy();
    expect(reloadApp).not.toHaveBeenCalled();
  });
});

describe('Connections', () => {
  it('U1: default connect choices turn automatic sync on and wellness off (U7: intervals-only import)', async () => {
    renderSettings('/settings?tab=connections');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'key-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect & import history' }));
    await waitFor(() => expect(runSync).toHaveBeenCalled());
    expect(connectIntervals).toHaveBeenCalledWith('key-123', undefined);
    expect(getAppPreferences()).toMatchObject({ autoSyncOnLaunch: true, syncWellness: false });
    expect(runSync).toHaveBeenCalledWith(expect.objectContaining({ full: true, sources: ['intervals'] }));
  });

  it('U1: the opposite choices are applied exactly', async () => {
    setAppPreferences({ autoSyncOnLaunch: true, syncWellness: false });
    renderSettings('/settings?tab=connections');
    fireEvent.click(screen.getByLabelText(/Sync new activities automatically/));
    fireEvent.click(screen.getByLabelText(/Also sync sleep, HRV and resting HR/));
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'key-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect & import history' }));
    await waitFor(() => expect(runSync).toHaveBeenCalled());
    expect(getAppPreferences()).toMatchObject({ autoSyncOnLaunch: false, syncWellness: true });
  });

  it('U1: a failed connect changes no sync preference', async () => {
    vi.mocked(connectIntervals).mockRejectedValueOnce(new Error('Invalid API key'));
    renderSettings('/settings?tab=connections');
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect & import history' }));
    expect(await screen.findByText('Invalid API key')).toBeTruthy();
    expect(getAppPreferences()).toMatchObject({ autoSyncOnLaunch: false, syncWellness: true });
    expect(runSync).not.toHaveBeenCalled();
  });

  it('U8: the saved Strava secret never reaches an input, and an empty field keeps it', () => {
    const secret = 'super-secret-value';
    (window as { electronAPI?: unknown }).electronAPI = {
      secureStorage: {
        set: vi.fn(async () => ({ success: true })),
        get: vi.fn(async () => null),
        remove: vi.fn(async () => ({ success: true })),
        isAvailable: vi.fn(async () => true),
      },
    };
    setStravaCredentials('12345', secret);
    renderSettings('/settings?tab=connections');

    const values = () => Array.from(document.querySelectorAll('input')).map((i) => i.value);
    expect(values()).not.toContain(secret);
    expect(screen.getByText(/saved/, { selector: '.settings-secret-saved' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    const secretInput = screen.getByLabelText('New client secret') as HTMLInputElement;
    expect(secretInput.value).toBe('');
    expect(values()).not.toContain(secret);

    fireEvent.click(screen.getByRole('button', { name: 'Save credentials' }));
    expect(getStravaCredentials()).toEqual({ clientId: '12345', clientSecret: secret });
    expect(values()).not.toContain(secret);
  });

  it('shows a needs-reconnect banner with the reason; Retry clears it and syncs that source', async () => {
    await setIntervalsCredentials({ apiKey: 'k', athleteId: 'i1', athleteName: 'Ana' });
    setNeedsReconnect('intervals', 'intervals.icu rejected the API key (401).');
    renderSettings('/settings?tab=connections');

    expect(screen.getByText(/Reconnect needed/)).toBeTruthy();
    expect(screen.getByText(/rejected the API key \(401\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(runSync).toHaveBeenCalledWith(expect.objectContaining({ sources: ['intervals'] })));
    expect(getNeedsReconnect('intervals')).toBeNull();
    await waitFor(() => expect(screen.queryByText(/Reconnect needed/)).toBeNull());
  });
});
