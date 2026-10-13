/**
 * dataSafetyFollowups.test.tsx — v1.0.7 follow-ups:
 * - PX-03/PX-04: backup payloads are never orphaned. initBackupSystem relists
 *   unlisted payloads on every launch, and createBackup fails when the backup
 *   list itself couldn't be saved.
 * - PX-14: Settings › Data lists quarantined copies with Download / Discard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { persistence } from '@/services/db/persistence';
import { listBackupPayloadIds, putBackupPayload } from '@/services/db/backupStore';
import { getQuarantinedEntries, quarantineCorruptValue } from '@/services/db/quarantine';
import {
  createBackup,
  getBackupRecords,
  getLastBackupError,
  initBackupSystem,
  reconcileBackupRegistry,
  restoreFromBackup,
} from '@/services/backupService';
import DataTab from '@/pages/settings/DataTab';

const REGISTRY_KEY = 'apollo_backup_registry';

function payload(exportDate: string, data: Record<string, string>): string {
  return JSON.stringify({
    metadata: { exportDate, appName: 'Apollo Running', version: '1.0.7', keyCount: Object.keys(data).length },
    data,
  });
}

let captured: Blob | null = null;
let downloadName = '';

beforeEach(() => {
  captured = null;
  downloadName = '';
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    captured = b;
    return 'blob:test';
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { downloadName = this.download; };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (persistence.failedWrites as Set<string>).clear();
});

describe('orphaned backup payloads are relisted', () => {
  it('reconcileBackupRegistry lists unlisted payloads (restorable) and deletes unreadable ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await putBackupPayload('backup_1791800000000_aaaa', payload('2026-10-12T00:00:00.000Z', { apollo_plan: '{"id":"half"}' }));
    await putBackupPayload('backup_1791800000001_bad', '{"metadata": {"trunc');

    expect(await reconcileBackupRegistry()).toBe(1);
    const [record] = getBackupRecords();
    expect(record).toMatchObject({ id: 'backup_1791800000000_aaaa', verified: true, note: 'Recovered', keyCount: 1 });
    expect(await listBackupPayloadIds()).toEqual(['backup_1791800000000_aaaa']);

    // The relisted backup passes its (recomputed) checksum on restore.
    persistence.setItem('apollo_plan', '{"id":"full"}');
    expect(await restoreFromBackup(record.id)).toBe(true);
    expect(persistence.getItem('apollo_plan')).toBe('{"id":"half"}');

    // Nothing left to do the second time.
    expect(await reconcileBackupRegistry()).toBe(0);
  });

  it('initBackupSystem relists orphans on every launch, after the 1.0.6 compaction already ran', async () => {
    persistence.setItem('apollo_migrations', JSON.stringify({ 'backup-compaction-1.0.6': '2026-01-01T00:00:00Z' }));
    persistence.setItem('apollo_backup_config', JSON.stringify({ autoBackupEnabled: false }));
    await putBackupPayload('backup_1791800000000_orph', payload('2026-10-12T00:00:00.000Z', { apollo_x: '"1"' }));
    await initBackupSystem({ schedule: false });
    expect(getBackupRecords().map((r) => r.id)).toEqual(['backup_1791800000000_orph']);
  });

  it('createBackup reports failure when the backup list could not be saved', async () => {
    persistence.setItem('apollo_plan', '{"id":"half"}');
    vi.spyOn(persistence, 'flush').mockImplementation(async () => {
      (persistence.failedWrites as Set<string>).add(REGISTRY_KEY);
    });
    expect(await createBackup('manual')).toBeNull();
    expect(getLastBackupError()?.message).toMatch(/backup list could not be saved/);
    // The payload is kept, so the next launch can relist it.
    expect((await listBackupPayloadIds()).length).toBe(1);
  });
});

describe('Settings › Data: damaged data set aside', () => {
  function renderDataTab() {
    return render(
      <MemoryRouter>
        <DataTab />
      </MemoryRouter>,
    );
  }

  it('is hidden when nothing was quarantined', () => {
    renderDataTab();
    expect(screen.queryByTestId('quarantine-card')).toBeNull();
  });

  it('downloads the raw damaged copy and discards it after confirming', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const entry = quarantineCorruptValue('apollo_activities_store', '[{"id":1,"na', 'not valid JSON');
    renderDataTab();
    const card = screen.getByTestId('quarantine-card');
    expect(card.textContent).toMatch(/Activities/);
    expect(card.textContent).toMatch(/not valid JSON/);

    fireEvent.click(within(card).getByRole('button', { name: /^Download damaged copy of Activities/ }));
    expect(await captured!.text()).toBe('[{"id":1,"na');
    expect(downloadName).toMatch(/^apollo-damaged-activities_store-\d{4}-\d{2}-\d{2}\.json$/);

    // Cancel keeps it.
    fireEvent.click(within(card).getByRole('button', { name: /^Discard damaged copy/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(persistence.getItem(entry.key)).not.toBeNull();

    // Confirm deletes it and the card disappears.
    fireEvent.click(within(screen.getByTestId('quarantine-card')).getByRole('button', { name: /^Discard damaged copy/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard' }));
    expect(persistence.getItem(entry.key)).toBeNull();
    expect(getQuarantinedEntries()).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId('quarantine-card')).toBeNull());
  });
});
