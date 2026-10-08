/**
 * v1.0.6 (A3, B18) RTL smoke tests for the Activities page: the "Possible
 * duplicates" banner (merge / keep both), hide and unhide through the Hidden
 * filter, and "Delete from this device" behind a confirmation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { persistence } from '@/services/db/persistence';
import { storeActivities, getAllStoredActivities, getStoredActivities } from '@/services/analyticsService';
import type { Activity } from '@/services/activity/types';
import Activities from '@/pages/Activities';

const scheduleEffortRebuild = vi.hoisted(() => vi.fn());
vi.mock('@/services/effortService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/effortService')>()),
  scheduleEffortRebuild,
}));

function run(id: number, startIso: string, distance: number, moving: number, extra: Partial<Activity> = {}): Activity {
  return {
    id,
    name: `Run ${id}`,
    type: 'Run',
    sport_type: 'Run',
    distance,
    moving_time: moving,
    elapsed_time: moving,
    start_date: startIso,
    start_date_local: startIso,
    kudos_count: 0,
    source: 'intervals',
    source_id: `i${id}`,
    ...extra,
  };
}

function renderPage() {
  return render(<MemoryRouter><Activities /></MemoryRouter>);
}

beforeEach(() => {
  persistence.clear();
  scheduleEffortRebuild.mockClear();
});

describe('Activities page: activity management (B18)', () => {
  it('shows no duplicates banner and no Hidden filter when there is nothing to act on', async () => {
    storeActivities([run(1, '2026-10-03T18:00:00Z', 8000, 2700), run(2, '2026-10-05T18:00:00Z', 5000, 1500)]);
    renderPage();
    expect(await screen.findByText('Run 1')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Activities' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Possible duplicates' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Hidden/ })).toBeNull();
  });

  it('merges a duplicate pair, then lists the extra copy under Hidden where it can be unhidden', async () => {
    // Two intervals.icu records of one workout (different provider IDs) both reach the store.
    storeActivities([
      run(1, '2026-10-03T18:00:00Z', 8000, 2700, { average_heartrate: 150 }),
      run(2, '2026-10-03T18:00:40Z', 8050, 2700),
    ]);
    renderPage();
    const banner = await screen.findByRole('region', { name: 'Possible duplicates' });
    const toggle = within(banner).getByRole('button', { name: /1 possible duplicate/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(within(banner).getByRole('button', { name: /^Merge/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Possible duplicates' })).toBeNull());
    expect(getStoredActivities().map((a) => a.id)).toEqual([1]); // the record with heart rate is kept
    expect(scheduleEffortRebuild).toHaveBeenCalled();
    expect(screen.queryByText('Run 2')).toBeNull();

    const hiddenFilter = screen.getByRole('button', { name: /^Hidden/ });
    expect(hiddenFilter.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(hiddenFilter);
    expect(hiddenFilter.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(await screen.findByText('Run 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Unhide' }));
    await waitFor(() => expect(getStoredActivities().map((a) => a.id).sort()).toEqual([1, 2]));
    expect(await screen.findByText('No hidden activities.')).toBeTruthy();
  });

  it('keep both stops suggesting the pair without hiding anything', async () => {
    storeActivities([run(3, '2026-10-04T18:00:00Z', 5000, 1500), run(4, '2026-10-04T18:00:30Z', 5020, 1500)]);
    renderPage();
    const banner = await screen.findByRole('region', { name: 'Possible duplicates' });
    fireEvent.click(within(banner).getByRole('button', { name: /possible duplicate/ }));
    fireEvent.click(within(banner).getByRole('button', { name: /^Keep both/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Possible duplicates' })).toBeNull());
    expect(getStoredActivities()).toHaveLength(2);
  });

  it('hides an activity from its detail view', async () => {
    storeActivities([run(1, '2026-10-03T18:00:00Z', 8000, 2700), run(2, '2026-10-05T18:00:00Z', 5000, 1500)]);
    renderPage();
    fireEvent.click(await screen.findByText('Run 2'));
    fireEvent.click(await screen.findByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.queryByText('Run 2')).toBeNull());
    expect(getAllStoredActivities().find((a) => a.id === 2)?.hidden).toBe(true);
    expect(screen.getByRole('button', { name: /^Hidden/ })).toBeTruthy();
    expect(scheduleEffortRebuild).toHaveBeenCalled();
  });

  it('deletes from this device only after confirmation, and a re-sync does not bring it back', async () => {
    const doomed = run(5, '2026-10-06T18:00:00Z', 10000, 3000);
    storeActivities([run(1, '2026-10-03T18:00:00Z', 8000, 2700), doomed]);
    renderPage();
    fireEvent.click(await screen.findByText('Run 5'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete from this device' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete from this device?' });
    expect(dialog.textContent).toMatch(/won.t come back when you sync or re-import/);
    expect(dialog.textContent).toMatch(/Nothing is deleted from/);
    // Cancel keeps it.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getAllStoredActivities().some((a) => a.id === 5)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete from this device' }));
    const again = await screen.findByRole('dialog', { name: 'Delete from this device?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Delete from this device' }));
    await waitFor(() => expect(screen.queryByText('Run 5')).toBeNull());
    expect(getAllStoredActivities().some((a) => a.id === 5)).toBe(false);
    expect(scheduleEffortRebuild).toHaveBeenCalled();
    // The tombstone makes a later sync skip it.
    expect(storeActivities([doomed]).skippedDeleted).toBe(1);
    expect(getAllStoredActivities().some((a) => a.id === 5)).toBe(false);
  });
});
