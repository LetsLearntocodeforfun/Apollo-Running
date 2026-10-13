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
  }
}

export const db = new ApolloDatabase();
