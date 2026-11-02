// IndexedDB database via Dexie.js — key-value store backing the persistence layer.
//
// v1.0.7 (PX-04): backup payloads live in their own `backups` table, read only
// when a backup is restored, verified or downloaded. Up to 1.0.6 they were
// `apollo_backup_data_<id>` rows in kvStore, which the persistence layer loads
// into memory at launch (about 10× the size of the data itself). Version 2
// moves those rows into the new table, one at a time, inside the upgrade
// transaction (atomic: a failed upgrade leaves version 1 untouched).

import Dexie, { type Table, type Transaction } from 'dexie';

export interface KVEntry {
  key: string;
  value: string;
  updatedAt: number;
}

/** v1.0.7 (PX-04): one stored backup payload (the JSON the registry checksum covers). */
export interface BackupPayloadEntry {
  /** Backup ID (same as BackupRecord.id). */
  id: string;
  /** The backup JSON, exactly as hashed. */
  json: string;
  updatedAt: number;
}

/** kvStore key prefix of backup payloads written by ≤ 1.0.6. */
export const LEGACY_BACKUP_DATA_PREFIX = 'apollo_backup_data_';

/** Version 1 → 2: move legacy backup payload rows from kvStore into `backups`. */
export async function moveLegacyBackupRows(tx: Transaction): Promise<number> {
  const kv = tx.table<KVEntry, string>('kvStore');
  const backups = tx.table<BackupPayloadEntry, string>('backups');
  const keys = await kv.where('key').startsWith(LEGACY_BACKUP_DATA_PREFIX).primaryKeys();
  let moved = 0;
  for (const key of keys) {
    // One row at a time, so the upgrade never holds every backup in memory.
    const row = await kv.get(key);
    if (row) {
      await backups.put({ id: key.slice(LEGACY_BACKUP_DATA_PREFIX.length), json: row.value, updatedAt: row.updatedAt });
      moved++;
    }
    await kv.delete(key);
  }
  return moved;
}

/** kvStore key of the activity list (the persistence layer's `apollo_activities_store`). */
const ACTIVITIES_STORE_KEY = 'apollo_activities_store';
/** Table used only by unreleased 1.0.9 development builds (normalized activities, deferred to 1.1.0). */
const PRERELEASE_ACTIVITIES_TABLE = 'activities';
/** Same key scheme as db/quarantine.ts (PX-14), so a damaged list found here is listed in Settings. */
const QUARANTINE_PREFIX = 'apollo_quarantine_';
const QUARANTINE_INDEX_KEY = `${QUARANTINE_PREFIX}index`;

type StoredActivity = { id: number; start_date_local?: unknown; start_date?: unknown };

function isStoredActivity(value: unknown): value is StoredActivity {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'number' &&
    Number.isFinite((value as { id: number }).id)
  );
}

function activityDateKey(a: StoredActivity): string {
  const d = typeof a.start_date_local === 'string' ? a.start_date_local : a.start_date;
  return typeof d === 'string' ? d : '';
}

/**
 * Version 3 → 4: development builds of 1.0.9 moved the activity list out of
 * kvStore into an `activities` table. 1.0.9 ships on the 1.0.8 layout instead,
 * so fold any such rows back into `apollo_activities_store` before the table
 * is dropped. Activities already in the kvStore list win on matching IDs; a
 * list that can't be read is quarantined (PX-14), never overwritten.
 * Returns the number of activities taken from the table.
 */
export async function restorePrereleaseActivityRows(tx: Transaction): Promise<number> {
  // `tx.storeNames` lists only the new schema; the native upgrade transaction
  // still sees the table being dropped (Dexie deletes it after this function).
  const nativeStores = Array.from(tx.idbtrans?.objectStoreNames ?? []);
  if (!nativeStores.includes(PRERELEASE_ACTIVITIES_TABLE)) return 0;
  const rows = await tx.table<{ data?: unknown }>(PRERELEASE_ACTIVITIES_TABLE).toArray();
  const restored = rows.map((row) => row?.data).filter(isStoredActivity);
  if (restored.length === 0) return 0;

  const kv = tx.table<KVEntry, string>('kvStore');
  const now = Date.now();
  let existing: StoredActivity[] = [];
  const current = await kv.get(ACTIVITIES_STORE_KEY);
  if (current) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current.value);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      existing = parsed.filter(isStoredActivity);
    } else {
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const quarantineKey = `${QUARANTINE_PREFIX}${ACTIVITIES_STORE_KEY}_${stamp}`;
      await kv.put({ key: quarantineKey, value: current.value, updatedAt: now });
      const indexRow = await kv.get(QUARANTINE_INDEX_KEY);
      let index: unknown[] = [];
      try {
        const parsedIndex: unknown = indexRow ? JSON.parse(indexRow.value) : [];
        if (Array.isArray(parsedIndex)) index = parsedIndex;
      } catch {
        /* unreadable index: start a new one */
      }
      index.push({
        key: quarantineKey,
        originalKey: ACTIVITIES_STORE_KEY,
        quarantinedAt: new Date(now).toISOString(),
        reason: 'not readable when restoring activities from a 1.0.9 development build',
        sizeChars: current.value.length,
      });
      await kv.put({ key: QUARANTINE_INDEX_KEY, value: JSON.stringify(index), updatedAt: now });
    }
  }

  const byId = new Map<number, StoredActivity>();
  for (const a of restored) byId.set(a.id, a);
  for (const a of existing) byId.set(a.id, a); // the kvStore list wins on matching IDs
  const merged = [...byId.values()].sort((a, b) => activityDateKey(b).localeCompare(activityDateKey(a)) || b.id - a.id);
  await kv.put({ key: ACTIVITIES_STORE_KEY, value: JSON.stringify(merged), updatedAt: now });
  return restored.length;
}

export class ApolloDatabase extends Dexie {
  kvStore!: Table<KVEntry, string>;
  backups!: Table<BackupPayloadEntry, string>;

  constructor(name: string = 'ApolloRunning') {
    super(name);
    this.version(1).stores({
      kvStore: 'key',
    });
    this.version(2)
      .stores({
        kvStore: 'key',
        backups: 'id',
      })
      .upgrade(async (tx) => {
        await moveLegacyBackupRows(tx);
      });
    // Schema of unreleased 1.0.9 development builds, declared only so version 4
    // can read and then drop its table. Never used at runtime.
    this.version(3).stores({
      kvStore: 'key',
      backups: 'id',
      activities: 'id, start_date_local, sport_type, source',
    });
    // 1.0.9: back to the 1.0.8 layout (activities live in kvStore), so 1.0.8
    // can still open this database after a downgrade.
    this.version(4)
      .stores({
        kvStore: 'key',
        backups: 'id',
        activities: null,
      })
      .upgrade(async (tx) => {
        await restorePrereleaseActivityRows(tx);
      });
  }
}

export const db = new ApolloDatabase();
