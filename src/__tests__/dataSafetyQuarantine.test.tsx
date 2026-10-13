/**
 * dataSafetyQuarantine.test.tsx — v1.0.7:
 * - PX-14: a damaged activity store is moved aside under a timestamped key
 *   (not read as empty and overwritten) and surfaced to the athlete.
 * - PX-03: the "Not saved — Retry" banner appears on failed writes, retries,
 *   and clears itself on recovery.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { persistence } from '@/services/db/persistence';
import {
  acknowledgeQuarantines,
  getQuarantinedEntries,
  getUnacknowledgedQuarantines,
  QUARANTINE_PREFIX,
} from '@/services/db/quarantine';
import { getAllStoredActivities, getStoredActivities, storeActivities } from '@/services/analyticsService';
import { exportAllData, isPreservedOnRestore } from '@/services/dataManager';
import { verifyDataIntegrity } from '@/services/backupService';
import { clearStorageDegraded, markStorageDegraded } from '@/services/storageHealth';
import SaveStatusBanner from '@/components/SaveStatusBanner';
import type { StravaActivity } from '@/services/strava';

const STORE = 'apollo_activities_store';

/** Let the deferred quarantine removal (after flush) and notifications run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function run(id: number): StravaActivity {
  return {
    id,
    name: `Run ${id}`,
    type: 'Run',
    sport_type: 'Run',
    distance: 5000,
    moving_time: 1500,
    elapsed_time: 1500,
    total_elevation_gain: 0,
    start_date: '2026-10-01T07:00:00Z',
    start_date_local: '2026-10-01T07:00:00Z',
  } as unknown as StravaActivity;
}

afterEach(() => {
  clearStorageDegraded();
  vi.restoreAllMocks();
});

describe('PX-14: corrupt activity store is quarantined', () => {
  it('moves invalid JSON aside under a timestamped key and removes the original', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const damaged = '[{"id":1,"name":"Run"},{"id":2,"na';
    persistence.setItem(STORE, damaged);

    expect(getAllStoredActivities()).toEqual([]);
    const [entry] = getQuarantinedEntries();
    expect(entry.originalKey).toBe(STORE);
    expect(entry.key).toMatch(new RegExp(`^${QUARANTINE_PREFIX}${STORE}_\\d{4}-\\d{2}-\\d{2}T`));
    expect(entry.reason).toMatch(/JSON/);
    expect(persistence.getItem(entry.key)).toBe(damaged); // raw copy, unchanged

    await settle();
    expect(persistence.getItem(STORE)).toBeNull(); // moved, once the copy committed
    expect(getUnacknowledgedQuarantines()).toHaveLength(1);
  });

  it('a later sync writes a fresh store without touching the quarantined copy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    persistence.setItem(STORE, '{not json');
    expect(getStoredActivities()).toEqual([]);
    const [entry] = getQuarantinedEntries();

    storeActivities([run(1)]);
    await settle();
    expect(getAllStoredActivities().map((a) => a.id)).toEqual([1]);
    expect(persistence.getItem(entry.key)).toBe('{not json');
  });

  it('treats a non-list store as damaged too, and quarantines a given value only once', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    persistence.setItem(STORE, '{"not":"a list"}');
    getAllStoredActivities();
    getAllStoredActivities();
    const entries = getQuarantinedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toMatch(/list/);
  });

  it('does not move anything while storage is degraded (writes are blocked then)', () => {
    markStorageDegraded('test');
    persistence.setItem(STORE, '[{"id":1,"na');
    expect(getAllStoredActivities()).toEqual([]);
    expect(getQuarantinedEntries()).toEqual([]);
    expect(persistence.getItem(STORE)).toBe('[{"id":1,"na');
  });

  it('quarantined copies are device-only: not exported, kept by restore, not reported as corrupt keys', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    persistence.setItem(STORE, '[broken1');
    getAllStoredActivities();
    const [entry] = getQuarantinedEntries();
    expect(Object.keys(exportAllData().data).some((k) => k.startsWith(QUARANTINE_PREFIX))).toBe(false);
    expect(isPreservedOnRestore(entry.key)).toBe(true);
    expect(verifyDataIntegrity()).not.toContain(entry.key);
  });

  it('acknowledging hides the notice but keeps the copy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    persistence.setItem(STORE, '[broken2');
    getAllStoredActivities();
    acknowledgeQuarantines();
    expect(getUnacknowledgedQuarantines()).toEqual([]);
    expect(getQuarantinedEntries()).toHaveLength(1);
  });
});

// ── Banner ────────────────────────────────────────────────────────────────────

type HealthListener = () => void;

/** Drive the (mocked) persistence write health from the test. */
function controlWriteHealth() {
  const p = persistence as unknown as {
    getWriteHealth: () => { ok: boolean; failedKeys: string[] };
    onWriteHealthChange: (l: HealthListener) => () => void;
    retryFailedWrites: () => Promise<number>;
  };
  let failed: string[] = [];
  const listeners = new Set<HealthListener>();
  vi.spyOn(p, 'getWriteHealth').mockImplementation(() => ({ ok: failed.length === 0, failedKeys: [...failed] }));
  vi.spyOn(p, 'onWriteHealthChange').mockImplementation((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  });
  const retry = vi.spyOn(p, 'retryFailedWrites').mockResolvedValue(0);
  return {
    retry,
    setFailed(keys: string[]) {
      failed = keys;
      act(() => {
        for (const l of listeners) l();
      });
    },
  };
}

function renderBanner() {
  return render(
    <MemoryRouter>
      <SaveStatusBanner />
    </MemoryRouter>,
  );
}

describe('PX-03: "Not saved — Retry" banner', () => {
  it('shows nothing while every write is saved', () => {
    controlWriteHealth();
    const { container } = renderBanner();
    expect(container.innerHTML).toBe('');
  });

  it('appears as an alert when a write fails, retries, and clears itself on recovery', async () => {
    const health = controlWriteHealth();
    renderBanner();
    health.setFailed(['apollo_plan', 'apollo_journal']);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Not saved/);
    expect(alert.textContent).toMatch(/2 changes/);

    // Retry still failing → explains what to do.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(health.retry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(alert.textContent).toMatch(/Still not saved/));

    // Recovered → banner disappears without any action.
    health.setFailed([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('retry recovering everything removes the banner', async () => {
    const health = controlWriteHealth();
    health.retry.mockImplementation(async () => {
      health.setFailed([]);
      return 1;
    });
    renderBanner();
    health.setFailed(['apollo_plan']);
    expect(screen.getByRole('alert').textContent).toMatch(/1 change\b/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('surfaces quarantined data with a dismiss button (PX-14)', async () => {
    controlWriteHealth();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderBanner();
    persistence.setItem(STORE, '[broken3');
    act(() => {
      getAllStoredActivities();
    });
    const notice = await screen.findByTestId('quarantine-banner');
    expect(notice.textContent).toMatch(/activity history couldn’t be read/i);
    expect(screen.getByRole('link', { name: 'Restore a backup' }).getAttribute('href')).toBe('/settings?tab=data');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss damaged data message' }));
    await waitFor(() => expect(screen.queryByTestId('quarantine-banner')).toBeNull());
  });
});
