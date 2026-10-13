/**
 * v1.0.7 (PX-14): quarantine for stored values that can't be read.
 *
 * A damaged value (e.g. an activity store that is no longer valid JSON) used
 * to be read as empty and then overwritten by the next write, silently losing
 * whatever was in it. Instead it is copied, unchanged, to a timestamped key
 * (`apollo_quarantine_<key>_<time>`) and listed in an index, so the app can
 * tell the athlete and the raw copy stays available for recovery/support.
 *
 * Quarantined copies are device-only: never exported or backed up, and kept by
 * a restore (dataManager.isExcludedFromExport / isPreservedOnRestore).
 */

import { persistence } from './persistence';

/** Key prefix of quarantined copies and of the index. */
export const QUARANTINE_PREFIX = 'apollo_quarantine_';
const QUARANTINE_INDEX_KEY = `${QUARANTINE_PREFIX}index`;

/** Window event dispatched whenever the quarantine list changes. */
export const QUARANTINE_CHANGED_EVENT = 'apollo:quarantine-changed';

export interface QuarantineEntry {
  /** Key holding the raw copy. */
  key: string;
  /** Key the damaged value was read from. */
  originalKey: string;
  /** ISO time it was moved aside. */
  quarantinedAt: string;
  /** Why it couldn't be read. */
  reason: string;
  /** Length of the raw value (UTF-16 chars). */
  sizeChars: number;
  /** True once the athlete has dismissed the notice. */
  acknowledged?: boolean;
}

const listeners = new Set<() => void>();

function emit(): void {
  // Deferred: quarantining can happen while a component renders (store reads).
  queueMicrotask(() => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* a listener must not break storage */
      }
    }
    try {
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(QUARANTINE_CHANGED_EVENT));
    } catch {
      /* no DOM */
    }
  });
}

function readIndex(): QuarantineEntry[] {
  try {
    const raw = persistence.getItem(QUARANTINE_INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (e): e is QuarantineEntry => !!e && typeof e === 'object' && typeof (e as QuarantineEntry).key === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

function writeIndex(entries: QuarantineEntry[]): void {
  persistence.setItem(QUARANTINE_INDEX_KEY, JSON.stringify(entries));
}

/** Filesystem/key-safe timestamp, e.g. 2026-10-13T14-06-01-123Z. */
function stamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Copy a damaged value to a timestamped quarantine key and record it.
 * Does NOT remove the original: the caller removes it once the copy has
 * committed (see analyticsService). Returns the new entry.
 */
export function quarantineCorruptValue(originalKey: string, raw: string, reason: string): QuarantineEntry {
  const now = new Date();
  const entries = readIndex();
  let key = `${QUARANTINE_PREFIX}${originalKey}_${stamp(now)}`;
  for (let n = 2; persistence.getItem(key) !== null; n++) key = `${QUARANTINE_PREFIX}${originalKey}_${stamp(now)}_${n}`;
  const entry: QuarantineEntry = { key, originalKey, quarantinedAt: now.toISOString(), reason, sizeChars: raw.length };
  persistence.setItem(key, raw);
  writeIndex([...entries, entry]);
  console.error(`[Apollo] ${originalKey} could not be read (${reason}); moved it aside to ${key}`);
  emit();
  return entry;
}

/** Every quarantined copy still on this device, oldest first. */
export function getQuarantinedEntries(): QuarantineEntry[] {
  return readIndex().filter((e) => persistence.getItem(e.key) !== null);
}

/** Quarantined copies the athlete hasn't been told about yet (or hasn't dismissed). */
export function getUnacknowledgedQuarantines(): QuarantineEntry[] {
  return getQuarantinedEntries().filter((e) => !e.acknowledged);
}

/** Dismiss the notice for every current entry (the copies are kept). */
export function acknowledgeQuarantines(): void {
  const entries = readIndex();
  if (!entries.some((e) => !e.acknowledged)) return;
  writeIndex(entries.map((e) => ({ ...e, acknowledged: true })));
  emit();
}

/** The raw damaged value of one entry (for download / support). */
export function getQuarantinedValue(key: string): string | null {
  return key.startsWith(QUARANTINE_PREFIX) ? persistence.getItem(key) : null;
}

/** Delete one quarantined copy and its index entry. */
export function discardQuarantined(key: string): void {
  if (!key.startsWith(QUARANTINE_PREFIX) || key === QUARANTINE_INDEX_KEY) return;
  persistence.removeItem(key);
  writeIndex(readIndex().filter((e) => e.key !== key));
  emit();
}

/** Subscribe to quarantine changes. Returns an unsubscribe function. */
export function onQuarantineChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
