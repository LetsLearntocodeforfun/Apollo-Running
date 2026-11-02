/**
 * v1.0.9: the contract between the renderer's backups (src/services/backupService.ts,
 * src/services/dataManager.ts) and the main process's synced-folder snapshot
 * validation (electron/security.ts):
 *  - a snapshot built exactly the way the renderer builds it passes, and comes
 *    back byte-for-byte identical, so its checksum still verifies on import;
 *  - main rejects exactly the credential and device-state keys the renderer
 *    never exports (both ways), and agrees with the renderer on every other
 *    `apollo_` key the app uses;
 *  - main's metadata allow-list and ExportPurpose values mirror the renderer's types.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_CREDENTIAL_KEYS,
  SNAPSHOT_DEVICE_STATE_KEYS,
  SNAPSHOT_EXPORT_PURPOSES,
  SNAPSHOT_METADATA_KEYS,
  isDisallowedSnapshotKey,
  validateBackupSnapshotPayload,
} from '../../electron/security';
import { exportAllData, isExcludedFromExport, type BackupMetadata, type ExportPurpose } from '@/services/dataManager';
import { persistence } from '@/services/db/persistence';

const SRC = path.resolve(__dirname, '..');

/** The digest backupService's sha256() produces: SHA-256 of the UTF-8 text, as lowercase hex. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** String members of `const NAME = new Set([...])` in a file under src/ (comments ignored). */
function setLiteralMembers(relativePath: string, name: string): string[] {
  const text = readFileSync(path.join(SRC, relativePath), 'utf8');
  const match = new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*new Set(?:<[^>]*>)?\\(\\[([\\s\\S]*?)\\]\\)`).exec(text);
  if (!match) throw new Error(`Could not find "const ${name} = new Set([...])" in src/${relativePath}`);
  const body = match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
}

/** App source files under src/ (tests excluded). */
function appSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') appSourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** A one-key snapshot payload with valid metadata. */
function snapshotWith(key: string): string {
  return JSON.stringify({
    metadata: {
      exportDate: '2026-11-01T12:00:00.000Z',
      appName: 'Apollo Running',
      version: '1.0.9',
      keyCount: 1,
      purpose: 'backup',
    },
    data: { [key]: '"value"' },
  });
}

describe('renderer → main synced-folder snapshot contract', () => {
  it('accepts a snapshot built exactly like backupService builds it and returns it byte-for-byte', () => {
    // A few athlete keys (quotes, escapes, non-ASCII, a lone surrogate) and keys a backup never contains
    persistence.setItem('apollo_plan', JSON.stringify({ id: 'hal-higdon-novice-1', startDate: '2026-11-02' }));
    persistence.setItem('apollo_shoes', JSON.stringify([{ id: 's1', name: 'Pegasus "41"', km: 412.5 }]));
    persistence.setItem(
      'apollo_athlete_profile',
      JSON.stringify({ name: 'Zoë Ångström', note: 'line 1\nline 2\t🏃 \u2028 cut \ud83d' }),
    );
    persistence.setItem('apollo_distance_unit', 'km');
    persistence.setItem('strava_tokens', '{"access_token":"secret"}');
    persistence.setItem('apollo_route_cache', '{}');
    persistence.setItem('apollo_backup_registry', '[]');
    persistence.setItem('apollo_needs_reconnect', 'true');

    // The same steps as mirrorPayloadToDesktopFolder / syncSnapshotToDesktopFolder:
    const backupData = exportAllData({ purpose: 'backup' });
    const checksum = sha256Hex(JSON.stringify(backupData));
    const payload = JSON.stringify({ ...backupData, metadata: { ...backupData.metadata, checksum } });

    expect(Object.keys(backupData.data)).toEqual([
      'apollo_athlete_profile',
      'apollo_distance_unit',
      'apollo_plan',
      'apollo_shoes',
    ]);
    const result = validateBackupSnapshotPayload(payload);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.json).toBe(payload);

    // importFromFile checks the checksum over the metadata minus checksum, plus the data: still a match.
    const written = JSON.parse(result.json as string) as { metadata: Record<string, unknown>; data: unknown };
    const { checksum: embedded, ...metadata } = written.metadata;
    expect(embedded).toBe(checksum);
    expect(sha256Hex(JSON.stringify({ metadata, data: written.data }))).toBe(checksum);
  });

  it('rejects exactly the credential and device-state keys the renderer never exports, both ways', () => {
    const rendererCredentials = setLiteralMembers('services/db/persistence.ts', 'CREDENTIAL_KEYS');
    const rendererDeviceState = setLiteralMembers('services/dataManager.ts', 'DEVICE_STATE_KEYS');

    // The renderer lists found in the source are the ones isExcludedFromExport really uses.
    // (A new credential key must also be added to the persistence mock in setup.ts.)
    for (const key of [...rendererCredentials, ...rendererDeviceState]) {
      expect(isExcludedFromExport(key), `renderer: ${key}`).toBe(true);
    }
    // Main → renderer: every key main rejects as credential or device state, the renderer excludes too.
    for (const key of [...SNAPSHOT_CREDENTIAL_KEYS, ...SNAPSHOT_DEVICE_STATE_KEYS]) {
      expect(isExcludedFromExport(key), `main: ${key}`).toBe(true);
    }
    // Renderer → main: the lists match exactly, so neither side has a key the other lacks…
    expect([...SNAPSHOT_CREDENTIAL_KEYS].sort()).toEqual([...rendererCredentials].sort());
    expect([...SNAPSHOT_DEVICE_STATE_KEYS].sort()).toEqual([...rendererDeviceState].sort());
    // …and main really refuses a snapshot containing any of them.
    for (const key of [...rendererCredentials, ...rendererDeviceState]) {
      expect(isDisallowedSnapshotKey(key), key).toBe(true);
      expect(validateBackupSnapshotPayload(snapshotWith(key)).ok, key).toBe(false);
    }
  });

  it('agrees with the renderer on every apollo_ key the app uses', () => {
    const keys = new Set<string>();
    for (const file of appSourceFiles(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/['"`](apollo_[A-Za-z0-9_]+)['"`]/g)) keys.add(m[1]);
    }
    // Sanity check, so a wrong path can't make this pass vacuously.
    expect(keys.size).toBeGreaterThan(20);
    expect(keys.has('apollo_activities_store')).toBe(true);
    for (const key of keys) {
      // Main refuses a key exactly when the renderer would never export it (or it is over 128 characters).
      expect(isDisallowedSnapshotKey(key), key).toBe(isExcludedFromExport(key) || key.length > 128);
    }
  });

  it("mirrors the renderer's metadata fields and export purposes", () => {
    // Compile-time half: a new or removed BackupMetadata field or ExportPurpose value fails `tsc` here.
    const rendererMetadataFields = {
      exportDate: true,
      appName: true,
      version: true,
      keyCount: true,
      purpose: true,
      checksum: true,
    } satisfies Record<keyof BackupMetadata | 'checksum', true>;
    const rendererPurposes = { backup: true, export: true } satisfies Record<ExportPurpose, true>;
    expect([...SNAPSHOT_METADATA_KEYS].sort()).toEqual(Object.keys(rendererMetadataFields).sort());
    expect([...SNAPSHOT_EXPORT_PURPOSES].sort()).toEqual(Object.keys(rendererPurposes).sort());
  });
});
