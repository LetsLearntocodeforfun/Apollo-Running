/**
 * Apollo IndexedDB Database — powered by Dexie.js.
 *
 * Provides robust, structured client-side storage with:
 *   - Much larger capacity than localStorage (~100s of MB vs ~5-10 MB)
 *   - Transaction support and crash-safety
 *   - Survives many browser cache-clear scenarios that wipe localStorage
 *   - Foundation for future structured tables and queries
 *
 * Schema version 1 uses a simple key-value store that mirrors
 * the existing localStorage pattern for a smooth migration.
 */

import Dexie, { type Table } from 'dexie';

export interface KVEntry {
  /** Storage key (primary key) */
  key: string;
  /** JSON-serialized value */
  value: string;
  /** Timestamp of last update (ms since epoch) */
  updatedAt: number;
}

/**
 * ApolloDatabase — Dexie database for Apollo Running.
 *
 * Version 1: Key-value store (mirrors localStorage).
 * Future versions can add structured tables for activities, HR data, etc.
 */
export class ApolloDatabase extends Dexie {
  kvStore!: Table<KVEntry, string>;

  constructor() {
    super('ApolloRunning');
    this.version(1).stores({
      kvStore: 'key',
    });
  }
}

export const db = new ApolloDatabase();
