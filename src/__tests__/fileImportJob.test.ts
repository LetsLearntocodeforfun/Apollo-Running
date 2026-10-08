/**
 * Tests for what sits between the "Import activity files" card and
 * `importActivityFiles`: the app-wide import job (fileImport/job.ts) — one
 * import at a time, subscriptions, throttled progress, cancellation,
 * unexpected failures and the result headline — and `filesFromDataTransfer`
 * (fileImport/dropped.ts), which turns a drop into files with dropped
 * folders expanded.
 *
 * `importActivityFiles` is mocked (fileImport.test.ts covers it end to end).
 * Drops are fake DataTransfer objects holding fake file system entries,
 * shaped like the ones browsers and Electron hand to a drop handler.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STORED_ACTIVITIES } from '@/services/analyticsService';
import type { ImportFile, ImportOptions, ImportProgress, ImportResult } from '@/services/fileImport';
import { filesFromDataTransfer } from '@/services/fileImport/dropped';
import {
  cancelFileImport,
  describeImportResult,
  dismissFileImportResult,
  getFileImportJob,
  onFileImportJobChange,
  startFileImport,
  type FileImportJob,
} from '@/services/fileImport/job';

const importMock = vi.hoisted(() => vi.fn());

// Only the import itself is faked: dropped.ts keeps the real isImportableFileName.
vi.mock('@/services/fileImport', async (importOriginal: () => Promise<typeof import('@/services/fileImport')>) => ({
  ...(await importOriginal()),
  importActivityFiles: importMock,
}));

// ── The fake import ───────────────────────────────────────────────────────────

/** A call to the mocked `importActivityFiles`: it runs until the test resolves it. */
interface ImportCall {
  files: readonly ImportFile[];
  opts: ImportOptions;
  resolve: (result: ImportResult) => void;
}

const IDLE: FileImportJob = { running: false, cancelling: false, progress: null, result: null };
const RUN_GPX: ImportFile = { name: 'run.gpx', data: new TextEncoder().encode('<gpx/>') };
const RIDE_FIT: ImportFile = { name: 'ride.fit', data: new Uint8Array(14) };

let calls: ImportCall[] = [];
let runs: Promise<ImportResult | null>[] = [];
let unsubscribes: (() => void)[] = [];

/** `startFileImport`, remembered so that no import outlives its test. */
function start(files: readonly ImportFile[]): Promise<ImportResult | null> {
  const run = startFileImport(files);
  runs.push(run);
  return run;
}

/** Subscribe to the job for the rest of the test. */
function watch(listener: (job: FileImportJob) => void): void {
  unsubscribes.push(onFileImportJobChange(listener));
}

/** Report progress from the running import. */
function report(p: ImportProgress): void {
  calls[calls.length - 1].opts.onProgress?.(p);
}

function result(patch: Partial<ImportResult> = {}): ImportResult {
  return { filesRead: 1, activitiesFound: 1, added: 1, updated: 0, dropped: 0, skipped: [], errors: [], cancelled: false, ...patch };
}

function progress(filesDone: number): ImportProgress {
  return {
    phase: 'parsing',
    message: `Reading ${filesDone}.gpx (${filesDone} of 9)…`,
    filesDone,
    filesTotal: 9,
    activitiesFound: filesDone,
  };
}

beforeEach(() => {
  calls = [];
  runs = [];
  importMock.mockReset();
  importMock.mockImplementation((files: readonly ImportFile[], opts: ImportOptions) =>
    new Promise<ImportResult>((resolve) => {
      calls.push({ files, opts, resolve });
    }));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const off of unsubscribes) off();
  unsubscribes = [];
  for (const call of calls) call.resolve(result()); // a failed test must not leave an import running
  await Promise.allSettled(runs);
  dismissFileImportResult();
});

// ── The import job ────────────────────────────────────────────────────────────

describe('file import job', () => {
  it('runs an import and keeps its result until dismissed', async () => {
    const seen: FileImportJob[] = [];
    watch((job) => seen.push(job));
    expect(getFileImportJob()).toEqual(IDLE);

    const run = start([RUN_GPX, RIDE_FIT]);
    expect(importMock).toHaveBeenCalledTimes(1);
    expect(calls[0].files).toEqual([RUN_GPX, RIDE_FIT]);
    expect(calls[0].opts.signal?.aborted).toBe(false);
    expect(getFileImportJob()).toEqual({ ...IDLE, running: true });

    const outcome = result({ filesRead: 2, activitiesFound: 2, added: 2 });
    calls[0].resolve(outcome);
    expect(await run).toBe(outcome);
    expect(getFileImportJob()).toEqual({ ...IDLE, result: outcome });
    expect(seen).toEqual([{ ...IDLE, running: true }, { ...IDLE, result: outcome }]);
    expect(seen[1]).toBe(getFileImportJob()); // subscribers get the current state object

    dismissFileImportResult();
    expect(getFileImportJob()).toEqual(IDLE);
    dismissFileImportResult(); // nothing left to dismiss
    expect(seen).toHaveLength(3);
  });

  it('runs one import at a time', async () => {
    expect(await startFileImport([])).toBeNull();
    expect(importMock).not.toHaveBeenCalled();
    expect(getFileImportJob()).toEqual(IDLE);

    const first = start([RUN_GPX]);
    expect(await startFileImport([RIDE_FIT])).toBeNull(); // refused while the first one runs
    expect(importMock).toHaveBeenCalledTimes(1);
    calls[0].resolve(result());
    await first;

    const second = start([RIDE_FIT]); // a new import replaces the last result
    expect(getFileImportJob()).toEqual({ ...IDLE, running: true });
    calls[1].resolve(result({ added: 0, updated: 1 }));
    await second;
    expect(importMock).toHaveBeenCalledTimes(2);
    expect(calls[1].files).toEqual([RIDE_FIT]);
    expect(getFileImportJob().result).toEqual(result({ added: 0, updated: 1 }));
  });

  it('shows the first progress at once, then the latest at most every 200 ms', async () => {
    vi.useFakeTimers();
    const seen: (ImportProgress | null)[] = [];
    const run = start([RUN_GPX]);
    watch((job) => seen.push(job.progress));

    report(progress(1));
    expect(getFileImportJob().progress).toEqual(progress(1));
    report(progress(2));
    report(progress(3));
    vi.advanceTimersByTime(199);
    expect(getFileImportJob().progress).toEqual(progress(1));
    vi.advanceTimersByTime(1);
    expect(getFileImportJob().progress).toEqual(progress(3)); // 2 was overtaken before its turn
    expect(seen).toEqual([progress(1), progress(3)]);

    vi.advanceTimersByTime(1000); // nothing waiting
    report(progress(4)); // after a pause: shown at once
    expect(seen).toEqual([progress(1), progress(3), progress(4)]);

    report(progress(5)); // waits for its turn…
    calls[0].resolve(result());
    await run;
    expect(vi.getTimerCount()).toBe(0); // …and is dropped when the import ends
    vi.advanceTimersByTime(1000);
    expect(getFileImportJob()).toEqual({ ...IDLE, result: result() });
    expect(seen).toEqual([progress(1), progress(3), progress(4), null]);
  });

  it('cancels through the signal it gave the import, keeping what was read', async () => {
    const seen: FileImportJob[] = [];
    watch((job) => seen.push(job));
    cancelFileImport(); // nothing to cancel
    expect(seen).toEqual([]);

    const run = start([RUN_GPX, RIDE_FIT]);
    const signal = calls[0].opts.signal;
    cancelFileImport();
    expect(signal?.aborted).toBe(true);
    expect(getFileImportJob()).toEqual({ ...IDLE, running: true, cancelling: true });
    cancelFileImport(); // already stopping
    expect(seen).toHaveLength(2);

    const outcome = result({ cancelled: true });
    calls[0].resolve(outcome);
    expect(await run).toBe(outcome);
    expect(getFileImportJob()).toEqual({ ...IDLE, result: outcome });

    const next = start([RIDE_FIT]); // the next import starts afresh
    expect(calls[1].opts.signal?.aborted).toBe(false);
    expect(getFileImportJob().cancelling).toBe(false);
    calls[1].resolve(result());
    await next;
    cancelFileImport(); // finished: nothing to cancel
    expect(calls[1].opts.signal?.aborted).toBe(false);
  });

  it('turns an unexpected failure into an error result', async () => {
    importMock.mockImplementationOnce(() => Promise.reject(new Error('Out of memory')));
    expect(await start([RUN_GPX])).toEqual({
      filesRead: 0,
      activitiesFound: 0,
      added: 0,
      updated: 0,
      dropped: 0,
      skipped: [],
      errors: [{ name: 'Import', message: 'Out of memory' }],
      cancelled: false,
    });
    expect(getFileImportJob()).toMatchObject({ running: false, result: { errors: [{ name: 'Import', message: 'Out of memory' }] } });

    importMock.mockImplementationOnce(() => Promise.reject('storage unavailable')); // not even an Error
    expect((await start([RUN_GPX]))?.errors).toEqual([{ name: 'Import', message: 'The import stopped unexpectedly.' }]);

    const run = start([RIDE_FIT]); // the next import runs normally
    expect(getFileImportJob()).toEqual({ ...IDLE, running: true });
    calls[0].resolve(result());
    expect(await run).toEqual(result());
  });

  it('keeps notifying when a subscriber throws, and stops after unsubscribe', async () => {
    const seen: boolean[] = [];
    watch(() => {
      throw new Error('card unmounted');
    });
    const off = onFileImportJobChange((job) => seen.push(job.running));
    const run = start([RUN_GPX]);
    calls[0].resolve(result());
    await run;
    expect(seen).toEqual([true, false]);

    off();
    dismissFileImportResult();
    expect(getFileImportJob()).toEqual(IDLE);
    expect(seen).toEqual([true, false]);
  });
});

describe('describeImportResult', () => {
  it('leads with what changed', () => {
    expect(describeImportResult(result({ added: 1 }))).toBe('Added 1 activity.');
    expect(describeImportResult(result({ filesRead: 1250, activitiesFound: 1250, added: 1204, updated: 3 })))
      .toBe(`Added ${(1204).toLocaleString()} activities and updated 3 you already had.`);
    expect(describeImportResult(result({ activitiesFound: 2, added: 0, updated: 2 })))
      .toBe('Updated 2 activities you already had.');
    expect(describeImportResult(result({ added: 0, updated: 1 }))).toBe('Updated 1 activity you already had.');
    expect(describeImportResult(result({ activitiesFound: 5, added: 2, cancelled: true })))
      .toBe('Added 2 activities. Import cancelled: everything read before that was saved.');
  });

  it('explains an import that changed nothing', () => {
    expect(describeImportResult(result({ added: 0 }))).toBe('That activity was already in Apollo: nothing new to add.');
    expect(describeImportResult(result({ filesRead: 12, activitiesFound: 12, added: 0 })))
      .toBe('All 12 activities were already in Apollo: nothing new to add.');
    const nothing = { filesRead: 0, activitiesFound: 0, added: 0 };
    expect(describeImportResult(result({ ...nothing, cancelled: true }))).toBe('Import cancelled.');
    expect(describeImportResult(result({ ...nothing, errors: [{ name: 'run.gpx', message: 'Not a GPX file.' }] })))
      .toBe('No activities could be imported from those files.');
    expect(describeImportResult(result({ ...nothing, skipped: [{ name: 'photo.jpg', reason: 'Not an activity file.' }] })))
      .toBe('No activities could be imported from those files.');
    expect(describeImportResult(result(nothing))).toBe('No activities found in those files.');
  });

  it('adds how many older activities the store had no room for', () => {
    // B16: races and PR holders are never trimmed, so the copy no longer says "most recent".
    const kept = `Apollo keeps up to ${MAX_STORED_ACTIVITIES.toLocaleString()} activities (races and personal records always stay)`;
    expect(describeImportResult(result({ activitiesFound: 3, added: 3, dropped: 1 })))
      .toBe(`Added 3 activities. ${kept}, so 1 older one wasn't kept.`);
    expect(describeImportResult(result({ filesRead: 1300, activitiesFound: 1300, added: 1300, dropped: 1204 })))
      .toBe(`Added ${(1300).toLocaleString()} activities. ${kept}, so ${(1204).toLocaleString()} older ones weren't kept.`);
    expect(describeImportResult(result({ activitiesFound: 4, added: 0, updated: 4, dropped: 2 })))
      .toBe(`Updated 4 activities you already had. ${kept}, so 2 older ones weren't kept.`);
    expect(describeImportResult(result({ activitiesFound: 5, added: 2, dropped: 2, cancelled: true })))
      .toBe(`Added 2 activities. Import cancelled: everything read before that was saved. ${kept}, so 2 older ones weren't kept.`);
  });
});

// ── Dropped files and folders ─────────────────────────────────────────────────

/** True while a drop event is dispatched: a DataTransfer reads as empty before and after. */
let dropping = false;

const later = (fn: () => void): void => {
  void Promise.resolve().then(fn);
};
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const names = (files: File[]): string[] => files.map((f) => f.name);

/** A file in a dropped folder. Entries stay readable after the drop; their callbacks come later, as in browsers. */
function fileEntry(path: string, readable = true): FileSystemEntry {
  const file = new File([path], baseName(path));
  return {
    isFile: true,
    isDirectory: false,
    name: baseName(path),
    fullPath: path,
    file: (ok: (f: File) => void, fail: (e: Error) => void) =>
      later(() => (readable ? ok(file) : fail(new Error('NotReadableError')))),
  } as unknown as FileSystemEntry;
}

/** A dropped folder whose reader hands out `batches`, then an empty batch (null: the folder can't be read). */
function folderEntry(path: string, batches: FileSystemEntry[][] | null): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name: baseName(path),
    fullPath: path,
    createReader: () => {
      const queue = batches ? [...batches] : null;
      return {
        readEntries: (ok: (entries: FileSystemEntry[]) => void, fail: (e: Error) => void) =>
          later(() => (queue ? ok(queue.shift() ?? []) : fail(new Error('NotFoundError')))),
      };
    },
  } as unknown as FileSystemEntry;
}

/** A file dropped by itself. */
function fileItem(file: File): DataTransferItem {
  return {
    kind: 'file',
    type: file.type,
    getAsFile: () => (dropping ? file : null),
    webkitGetAsEntry: () =>
      (dropping ? { isFile: true, isDirectory: false, name: file.name, fullPath: `/${file.name}` } : null),
  } as unknown as DataTransferItem;
}

/** A dropped folder (`getAsFile` only gives an empty placeholder for one). */
function folderItem(entry: FileSystemEntry): DataTransferItem {
  return {
    kind: 'file',
    type: '',
    getAsFile: () => (dropping ? new File([], entry.name) : null),
    webkitGetAsEntry: () => (dropping ? entry : null),
  } as unknown as DataTransferItem;
}

/** Dragged text, which can come along with files. */
const TEXT_ITEM = { kind: 'string', type: 'text/plain', getAsFile: () => null, webkitGetAsEntry: () => null } as unknown as DataTransferItem;

/**
 * Drop `items` (or `files`, for a browser without `items`) and collect the
 * files as the card's drop handler does. As with a real DataTransfer, they
 * can only be read while the handler runs.
 */
function drop(items: DataTransferItem[] | undefined, files: File[] = []): Promise<File[]> {
  const data = {
    get items() {
      return dropping ? items : [];
    },
    get files() {
      return dropping ? files : [];
    },
  } as unknown as DataTransfer;
  dropping = true;
  try {
    return filesFromDataTransfer(data);
  } finally {
    dropping = false;
  }
}

describe('filesFromDataTransfer', () => {
  it('keeps every file dropped by itself, in drop order', async () => {
    const run = new File(['<gpx/>'], 'run.gpx');
    const photo = new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' });
    const files = await drop([fileItem(run), TEXT_ITEM, fileItem(photo)]);
    expect(files).toHaveLength(2);
    expect(files[0]).toBe(run);
    expect(files[1]).toBe(photo); // the import explains why it can't use this one
  });

  it('works without file system entries, and without DataTransfer items', async () => {
    const fit = new File(['fit'], 'run.fit');
    const noEntries = { kind: 'file', type: '', getAsFile: () => (dropping ? fit : null) } as unknown as DataTransferItem;
    expect(names(await drop([noEntries]))).toEqual(['run.fit']);
    expect(names(await drop(undefined, [fit]))).toEqual(['run.fit']);
    expect(names(await drop([], [fit]))).toEqual(['run.fit']);
    expect(await drop([TEXT_ITEM])).toEqual([]);
  });

  it('expands dropped folders, keeping only what can be imported', async () => {
    const root = '/export_48151623';
    const strava = folderEntry(root, [
      [
        fileEntry(`${root}/activities.csv`),
        fileEntry(`${root}/profile.csv`),
        folderEntry(`${root}/activities`, [
          [fileEntry(`${root}/activities/1001.gpx`), fileEntry(`${root}/activities/1002.tcx.gz`)],
          [fileEntry(`${root}/activities/1003.fit.gz`), fileEntry(`${root}/activities/._1003.fit.gz`)],
        ]),
        folderEntry(`${root}/media`, [[fileEntry(`${root}/media/0a1b2c.jpg`)]]),
      ],
      [fileEntry(`${root}/older.zip`), fileEntry(`${root}/notes.txt`)], // entries come in batches
    ]);
    const before = new File(['<gpx/>'], 'before.gpx');
    const after = new File(['<tcx/>'], 'after.tcx');

    expect(names(await drop([fileItem(before), folderItem(strava), fileItem(after)]))).toEqual([
      'before.gpx', 'activities.csv', '1001.gpx', '1002.tcx.gz', '1003.fit.gz', 'older.zip', 'after.tcx',
    ]);
  });

  it('skips folders and files it cannot read', async () => {
    const runs = folderEntry('/runs', [[
      fileEntry('/runs/a.gpx'),
      fileEntry('/runs/locked.gpx', false),
      folderEntry('/runs/private', null),
      fileEntry('/runs/b.gpx'),
    ]]);
    expect(names(await drop([folderItem(runs), folderItem(folderEntry('/gone', null))]))).toEqual(['a.gpx', 'b.gpx']);
  });
});
