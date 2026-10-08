/**
 * The app-wide file import job behind the "Import activity files" card.
 *
 * One import runs at a time. It lives outside React, so it keeps going when
 * the athlete leaves the page that started it, and every subscriber — each
 * mounted import card, or anything else that wants to show progress — sees
 * the same state. Progress is throttled for the UI (an import reports every
 * file); the result stays until it is dismissed or the next import starts.
 */

import { MAX_STORED_ACTIVITIES } from '../analyticsService';
import { importActivityFiles, type ImportFile, type ImportProgress, type ImportResult } from './index';

/** State of the file import job. */
export interface FileImportJob {
  /** An import is running. */
  running: boolean;
  /** Cancel was requested: the import stops after the file it is reading. */
  cancelling: boolean;
  /** Latest (throttled) progress of the running import. */
  progress: ImportProgress | null;
  /** Outcome of the last import, until dismissed or replaced. */
  result: ImportResult | null;
}

/** Progress reaches subscribers at most this often (ms). */
const PROGRESS_INTERVAL_MS = 200;

let job: FileImportJob = { running: false, cancelling: false, progress: null, result: null };
let controller: AbortController | null = null;
const listeners = new Set<(job: FileImportJob) => void>();

function update(patch: Partial<FileImportJob>): void {
  job = { ...job, ...patch };
  for (const listener of listeners) {
    try {
      listener(job);
    } catch {
      /* a failing subscriber must not break the import */
    }
  }
}

/** Current state: a new object after every change, so it can be compared by reference. */
export function getFileImportJob(): FileImportJob {
  return job;
}

/** Subscribe to job changes. Returns an unsubscribe function. */
export function onFileImportJobChange(listener: (job: FileImportJob) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Import `files` (see `importActivityFiles`) unless an import is already
 * running. Resolves with the result — also kept in the job state — or with
 * null when nothing was started.
 */
export async function startFileImport(files: readonly ImportFile[]): Promise<ImportResult | null> {
  if (job.running || files.length === 0) return null;
  const abort = new AbortController();
  controller = abort;
  update({ running: true, cancelling: false, progress: null, result: null });

  const throttle: { timer?: ReturnType<typeof setTimeout>; shownAt: number; latest: ImportProgress | null } = {
    shownAt: 0,
    latest: null,
  };
  const show = (): void => {
    throttle.timer = undefined;
    throttle.shownAt = Date.now();
    if (throttle.latest && job.running) update({ progress: throttle.latest });
  };

  let result: ImportResult;
  try {
    result = await importActivityFiles(files, {
      signal: abort.signal,
      onProgress: (p) => {
        throttle.latest = p;
        if (throttle.timer !== undefined) return;
        const wait = PROGRESS_INTERVAL_MS - (Date.now() - throttle.shownAt);
        if (wait <= 0) show();
        else throttle.timer = setTimeout(show, wait);
      },
    });
  } catch (err) {
    // importActivityFiles reports problems in its result and never throws: this is a last resort.
    const message = err instanceof Error && err.message ? err.message : 'The import stopped unexpectedly.';
    result = {
      filesRead: 0,
      activitiesFound: 0,
      added: 0,
      updated: 0,
      dropped: 0,
      skipped: [],
      errors: [{ name: 'Import', message }],
      cancelled: false,
    };
  } finally {
    if (throttle.timer !== undefined) clearTimeout(throttle.timer);
    controller = null;
  }
  update({ running: false, cancelling: false, progress: null, result });
  return result;
}

/** Stop the running import after the file it is reading; everything read so far is kept. */
export function cancelFileImport(): void {
  if (!controller || job.cancelling) return;
  controller.abort();
  update({ cancelling: true });
}

/** Forget the last result (ignored while an import is running). */
export function dismissFileImportResult(): void {
  if (!job.running && job.result) update({ result: null });
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** What the import changed, or why it changed nothing. */
function headline(r: ImportResult): string {
  const changes: string[] = [];
  if (r.added > 0) changes.push(`Added ${plural(r.added, 'activity', 'activities')}`);
  if (r.updated > 0) {
    changes.push(r.added > 0
      ? `updated ${r.updated.toLocaleString()} you already had`
      : `Updated ${plural(r.updated, 'activity', 'activities')} you already had`);
  }
  if (changes.length > 0) {
    const text = `${changes.join(' and ')}.`;
    return r.cancelled ? `${text} Import cancelled: everything read before that was saved.` : text;
  }
  if (r.activitiesFound === 1) return 'That activity was already in Apollo: nothing new to add.';
  if (r.activitiesFound > 1) {
    return `All ${plural(r.activitiesFound, 'activity', 'activities')} were already in Apollo: nothing new to add.`;
  }
  if (r.cancelled) return 'Import cancelled.';
  if (r.errors.length > 0 || r.skipped.length > 0) return 'No activities could be imported from those files.';
  return 'No activities found in those files.';
}

/**
 * Outcome of an import in a sentence, e.g. "Added 1,204 activities and
 * updated 3 you already had." When the store's limit pushed out older
 * activities, a second sentence says how many. The store trims other sports
 * first and never trims races or personal records (B16), so the copy doesn't
 * promise "the most recent" activities.
 */
export function describeImportResult(r: ImportResult): string {
  const text = headline(r);
  if (!(r.dropped > 0)) return text;
  const older = r.dropped === 1 ? 'older one wasn\'t' : 'older ones weren\'t';
  return `${text} Apollo keeps up to ${MAX_STORED_ACTIVITIES.toLocaleString()} activities `
    + `(races and personal records always stay), so ${r.dropped.toLocaleString()} ${older} kept.`;
}
