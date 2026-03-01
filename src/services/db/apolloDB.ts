// IndexedDB database via Dexie.js — key-value store backing the persistence layer.

import Dexie, { type Table } from 'dexie';

export interface KVEntry {
  key: string;
  value: string;
  updatedAt: number;
}

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
