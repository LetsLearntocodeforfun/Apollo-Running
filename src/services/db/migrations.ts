/**
 * One-time data migrations, recorded in `apollo_migrations` as a JSON object
 * `{ [migrationId]: ISO time it completed }`. Other modules may add their own
 * ids; always read-modify-write through these helpers so entries are kept.
 */

import { persistence } from './persistence';

export const MIGRATIONS_KEY = 'apollo_migrations';

function readMigrations(): Record<string, string> {
  try {
    const raw = persistence.getItem(MIGRATIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      // Tolerate a list of ids.
      return Object.fromEntries(parsed.filter((v): v is string => typeof v === 'string').map((id) => [id, '']));
    }
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** Whether the migration with this id has completed on this device. */
export function hasMigrationRun(id: string): boolean {
  return id in readMigrations();
}

/** Record that a migration completed (keeps every other entry). */
export function markMigrationRun(id: string): void {
  const all = readMigrations();
  all[id] = new Date().toISOString();
  persistence.setItem(MIGRATIONS_KEY, JSON.stringify(all));
}
