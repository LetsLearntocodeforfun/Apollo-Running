/**
 * Import workouts from activity files and export archives — Apollo's
 * account-free way to bring in training history.
 *
 * Accepts what athletes actually have on disk:
 *  - FIT, GPX and TCX files from any watch or app, optionally gzipped
 *    (`.fit.gz`, `.gpx.gz`, `.tcx.gz`);
 *  - Strava's "Download your archive" ZIP — `activities.csv` maps every file
 *    in `activities/` to its Strava activity ID, name and type. Those
 *    activities keep the Strava ID, so they merge with legacy Strava copies
 *    already on the device;
 *  - Garmin's "Export Your Data" ZIP — FIT files sit in nested
 *    `DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_*.zip` archives and
 *    `*summarizedActivities*.json` supplies Garmin Connect's names and types,
 *    matched by start time;
 *  - the extracted contents of either export (an `activities.csv` picked
 *    together with the activity files still names them).
 *
 * Formats are recognized by content first (FIT header, ZIP / gzip magic,
 * `<gpx`, `<TrainingCenterDatabase`) and by file extension second. Archives
 * are read with random access, so multi-gigabyte exports never have to fit in
 * memory. Activities are stored in batches through the regular store, where
 * file copies have the lowest priority: they only fill gaps (splits, laps,
 * routes) in copies synced from intervals.icu or Strava. The import yields to
 * the event loop regularly so the UI stays responsive, reports progress, and
 * stops between files when its AbortSignal fires.
 */

import type { Activity } from '../activity/types';
import { storeActivities } from '../analyticsService';
import { notifyActivitiesUpdated } from '../activitySource';
import { refreshPlanFromStoredActivities } from '../autoSync';
import {
  ZIP_STORED,
  ZipArchive,
  archiveFileKey,
  blobSource,
  bytesSource,
  decodeUtf8,
  findGarminSummary,
  isZip,
  parseGarminSummaries,
  parseStravaActivitiesCsv,
  readAll,
  type ByteSource,
  type GarminActivitySummary,
  type StravaArchiveRow,
  type ZipEntry,
} from './archive';
import { normalizeSportType, toActivity, type ToActivityOptions } from './build';
import { isFitFile, parseFit } from './fit';
import { parseGpx } from './gpx';
import { gunzip, isGzip } from './inflate';
import { parseTcx } from './tcx';
import { FileImportError, type ParsedActivity } from './types';
import { decodeXmlBytes } from './xml';

// ── Public types ──────────────────────────────────────────────────────────────

/** A file to import: a browser / Electron `File`, or raw bytes with a name. */
export type ImportFile = File | { name: string; data: Uint8Array };

/** Progress of a running import. */
export interface ImportProgress {
  /** 'reading' opens files and scans archives, 'parsing' decodes activity files, 'saving' stores activities. */
  phase: 'reading' | 'parsing' | 'saving';
  /** Status line for the UI, e.g. "Reading 123.fit.gz (120 of 3,412)…". */
  message: string;
  /** Activity files processed so far. */
  filesDone: number;
  /** Activity files discovered so far (grows as archives are opened). */
  filesTotal?: number;
  /** Activities decoded so far. */
  activitiesFound: number;
}

/** What an import did. */
export interface ImportResult {
  /** Activity files read and decoded (archives themselves are not counted). */
  filesRead: number;
  /** Usable activities found in those files. */
  activitiesFound: number;
  /** Activities that were new to Apollo. */
  added: number;
  /** Activities already on the device that gained data (e.g. splits, laps or a route). */
  updated: number;
  /**
   * Oldest activities removed from the device to stay within the store's limit
   * (`MAX_STORED_ACTIVITIES`), possibly including some of those just added.
   */
  dropped: number;
  /** Picked files without an importable workout, with the reason. Archive noise is ignored quietly. */
  skipped: { name: string; reason: string }[];
  /** Files that could not be read. */
  errors: { name: string; message: string }[];
  /** True when the AbortSignal stopped the import; activities decoded before that are still saved. */
  cancelled: boolean;
}

/** Options for `importActivityFiles`. */
export interface ImportOptions {
  /** Called as files are read, decoded and saved. */
  onProgress?: (p: ImportProgress) => void;
  /** Stops the import between files; activities decoded so far are kept. */
  signal?: AbortSignal;
}

// ── Limits ────────────────────────────────────────────────────────────────────

/** Activities per `storeActivities` call (each call rewrites the whole store). */
const SAVE_BATCH_SIZE = 250;
/** Leading bytes read to recognize a file's format. */
const SNIFF_BYTES = 4096;
/** Control returns to the UI at least this often while importing (ms). */
const YIELD_INTERVAL_MS = 25;
/** Largest activity file decoded (uncompressed) — far beyond any real recording. */
const MAX_ACTIVITY_FILE_BYTES = 512 * 1024 * 1024;
/** Largest compressed archive-inside-an-archive that is inflated into memory. */
const MAX_NESTED_ARCHIVE_BYTES = 1024 * 1024 * 1024;
/** Largest metadata file (activities.csv, summarizedActivities.json) read. */
const MAX_METADATA_BYTES = 256 * 1024 * 1024;
/** ZIPs inside ZIPs are followed this deep (Garmin exports need one level). */
const MAX_ARCHIVE_DEPTH = 2;

const NOT_AN_ACTIVITY = 'Not an activity file. Choose FIT, GPX or TCX files, or a Strava or Garmin export (.zip).';
const TOO_SHORT = 'Too short to import (under a minute, with no distance).';
const TOO_LARGE = 'The file is too large to import.';

// ── Format detection ──────────────────────────────────────────────────────────

type ActivityFormat = 'fit' | 'gpx' | 'tcx';
type FileKind = ActivityFormat | 'zip' | 'gzip';

const EXTENSION_KINDS: Record<string, FileKind | undefined> = {
  fit: 'fit', gpx: 'gpx', tcx: 'tcx', zip: 'zip', gz: 'gzip',
};
/** Activity files inside archives: .fit / .gpx / .tcx, optionally gzipped (Strava). */
const ACTIVITY_ENTRY = /\.(?:fit|gpx|tcx)(?:\.gz)?$/i;
const ARCHIVE_ENTRY = /\.zip$/i;
/** Finder metadata in ZIPs made on a Mac: `__MACOSX/…` folders and `._name` files. */
const MAC_METADATA_ENTRY = /(?:^|\/)(?:__MACOSX\/|\._)/;
const GPX_ROOT = /<(?:[\w.-]+:)?gpx[\s>/]/i;
const TCX_ROOT = /<(?:[\w.-]+:)?TrainingCenterDatabase[\s>/]/i;

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function kindFromExtension(name: string): FileKind | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? EXTENSION_KINDS[match[1].toLowerCase()] : undefined;
}

/** Recognize a file from its leading bytes. */
function sniffKind(head: Uint8Array): FileKind | undefined {
  if (isFitFile(head)) return 'fit';
  if (isZip(head)) return 'zip';
  if (isGzip(head)) return 'gzip';
  const text = decodeXmlBytes(head);
  const gpx = text.search(GPX_ROOT);
  const tcx = text.search(TCX_ROOT);
  if (gpx >= 0 && (tcx < 0 || gpx < tcx)) return 'gpx';
  return tcx >= 0 ? 'tcx' : undefined;
}

/** A decoded activity file. */
interface DecodedFile {
  format: ActivityFormat;
  activities: ParsedActivity[];
}

/**
 * Decode one activity file, gzip-wrapped or not. Returns null when the bytes
 * aren't an activity file; throws FileImportError when they're corrupt.
 */
async function decodeActivityFile(data: Uint8Array, name: string): Promise<DecodedFile | null> {
  let bytes = data;
  let fileName = name;
  if (isGzip(bytes)) {
    bytes = await gunzip(bytes, MAX_ACTIVITY_FILE_BYTES);
    fileName = fileName.replace(/\.gz$/i, '');
  }
  if (bytes.length > MAX_ACTIVITY_FILE_BYTES) throw new FileImportError(TOO_LARGE);
  const kind = sniffKind(bytes.subarray(0, SNIFF_BYTES)) ?? kindFromExtension(fileName);
  if (kind === 'fit') return { format: 'fit', activities: parseFit(bytes) };
  if (kind === 'gpx') return { format: 'gpx', activities: parseGpx(decodeXmlBytes(bytes)) };
  if (kind === 'tcx') return { format: 'tcx', activities: parseTcx(decodeXmlBytes(bytes)) };
  return null;
}

/** Why a picked activity file yielded nothing. */
function emptyReason(format: ActivityFormat): string {
  if (format === 'fit') return 'No workout in this FIT file (it may hold settings, a course or health data).';
  if (format === 'gpx') return 'No timed track points: this looks like a route or course, not a recorded workout.';
  return 'No workouts in this TCX file (it may hold a course).';
}

// ── Archive metadata ──────────────────────────────────────────────────────────

type MetadataKind = 'strava' | 'garmin';

/** Strava's `activities.csv` or Garmin's `…summarizedActivities.json`. */
function metadataKind(path: string): MetadataKind | undefined {
  const base = baseName(path).toLowerCase();
  if (base === 'activities.csv') return 'strava';
  if (base.endsWith('.json') && base.includes('summarizedactivities')) return 'garmin';
  return undefined;
}

/** What is known about the activities of an archive (nested archives inherit it). */
interface ImportContext {
  /** Strava `activities.csv` rows keyed by `archiveFileKey`. */
  strava?: Map<string, StravaArchiveRow>;
  /** Garmin Connect activity summaries, sorted by start. */
  garmin?: GarminActivitySummary[];
  /** Platform assumed for files that don't name one (GARMIN inside a Garmin export). */
  origin?: string;
}

/** The workout a Strava `activities.csv` row describes: the longest when a file holds several. */
function primaryIndex(list: ParsedActivity[]): number {
  let best = 0;
  let bestDuration = -1;
  list.forEach((p, i) => {
    const samples = Array.isArray(p.samples) ? p.samples : [];
    const span = samples.length >= 2 ? (samples[samples.length - 1].time - samples[0].time) / 1000 : 0;
    const duration = p.totals?.elapsedSec ?? p.totals?.movingSec ?? span;
    if (duration > bestDuration) {
      best = i;
      bestDuration = duration;
    }
  });
  return best;
}

/** A sport from Garmin metadata, unless it's only a generic label ("other", "multi_sport"). */
function specificSport(raw: string | undefined): string | undefined {
  const sport = normalizeSportType(raw);
  return sport.type && sport.type !== 'Workout' ? raw : undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Raw bytes rather than a File. Checked by brand, not `instanceof Uint8Array`,
 * which is false for an array made in another realm (an iframe, or Node's
 * TextEncoder under Vitest's jsdom environment) and would send it to blobSource.
 */
function isBytesFile(file: ImportFile): file is { name: string; data: Uint8Array } {
  const data = (file as { data?: unknown }).data;
  return ArrayBuffer.isView(data) && Object.prototype.toString.call(data) === '[object Uint8Array]';
}

function sourceOf(file: ImportFile): ByteSource {
  return isBytesFile(file) ? bytesSource(file.data) : blobSource(file);
}

function describeError(err: unknown): string {
  if (err instanceof FileImportError) return err.message;
  const detail = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return detail ? `The file could not be read (${detail}).` : 'The file could not be read.';
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ── Import session ────────────────────────────────────────────────────────────

/** State of one `importActivityFiles` call. */
class ImportSession {
  readonly result: ImportResult = {
    filesRead: 0,
    activitiesFound: 0,
    added: 0,
    updated: 0,
    dropped: 0,
    skipped: [],
    errors: [],
    cancelled: false,
  };
  private pending: Activity[] = [];
  private filesDone = 0;
  private filesTotal = 0;
  private lastYield = Date.now();
  /** Saving failed (e.g. storage full): nothing more can be imported. */
  private halted = false;

  constructor(private readonly opts: ImportOptions) {}

  async run(files: readonly ImportFile[]): Promise<ImportResult> {
    const startedAt = new Date().toISOString();
    try {
      const inputs = files.filter((f): f is ImportFile => !!f);
      const context: ImportContext = {};
      const activityInputs: ImportFile[] = [];
      // Metadata first, so a picked `activities.csv` names the activity files picked with it.
      for (const file of inputs) {
        const name = file.name || 'Unnamed file';
        const kind = metadataKind(name);
        if (!kind) {
          activityInputs.push(file);
          continue;
        }
        const source = sourceOf(file);
        const loaded = await this.loadMetadata(kind, name, source.size, () => readAll(source), context);
        if (!loaded) this.skip(name, NOT_AN_ACTIVITY);
      }
      this.filesTotal = activityInputs.length;
      for (const file of activityInputs) {
        if (this.shouldStop()) break;
        await this.importFile(file, context);
        await this.breathe(true);
      }
    } catch (err) {
      // Defensive: per-file failures are caught below, so this is a bug — report it, keep what was found.
      this.result.errors.push({ name: 'Import', message: describeError(err) });
    }
    this.save();
    this.finish(startedAt);
    return this.result;
  }

  /** True when the import must stop: cancelled by the user, or saving failed. */
  private shouldStop(): boolean {
    if (this.opts.signal?.aborted) this.result.cancelled = true;
    return this.result.cancelled || this.halted;
  }

  private progress(phase: ImportProgress['phase'], message: string): void {
    if (!this.opts.onProgress) return;
    try {
      this.opts.onProgress({
        phase,
        message,
        filesDone: this.filesDone,
        filesTotal: this.filesTotal > 0 ? this.filesTotal : undefined,
        activitiesFound: this.result.activitiesFound,
      });
    } catch {
      /* a failing progress listener must not break the import */
    }
  }

  /** Let the UI render (and the user click Cancel) at least every YIELD_INTERVAL_MS. */
  private async breathe(force = false): Promise<void> {
    if (!force && Date.now() - this.lastYield < YIELD_INTERVAL_MS) return;
    await yieldToEventLoop();
    this.lastYield = Date.now();
  }

  private skip(name: string, reason: string): void {
    this.result.skipped.push({ name, reason });
  }

  private fail(name: string, err: unknown): void {
    this.result.errors.push({ name, message: describeError(err) });
  }

  /** One file picked by the user: an activity file, an archive, or something else. */
  private async importFile(file: ImportFile, context: ImportContext): Promise<void> {
    const name = file.name || 'Unnamed file';
    const source = sourceOf(file);
    this.progress('reading', `Reading ${name}…`);
    let kind: FileKind | undefined;
    try {
      kind = sniffKind(await source.read(0, SNIFF_BYTES)) ?? kindFromExtension(name);
    } catch (err) {
      this.fail(name, err);
      this.filesDone++;
      return;
    }
    if (kind === 'zip') {
      this.filesTotal--; // replaced by the activity files inside
      await this.importArchive(() => ZipArchive.open(source), name, context, 0);
      return;
    }
    if (!kind) {
      this.skip(name, NOT_AN_ACTIVITY);
      this.filesDone++;
      return;
    }
    if (source.size > MAX_ACTIVITY_FILE_BYTES) {
      this.fail(name, new FileImportError(TOO_LARGE));
      this.filesDone++;
      return;
    }
    await this.importActivityFile(name, name, () => readAll(source), context, true);
  }

  /**
   * Import every activity file in a ZIP: metadata first (Strava CSV, Garmin
   * summaries), then FIT / GPX / TCX entries, then nested archives.
   */
  private async importArchive(
    open: () => Promise<ZipArchive>,
    label: string,
    parent: ImportContext,
    depth: number,
  ): Promise<void> {
    this.progress('reading', `Opening ${baseName(label)}…`);
    let zip: ZipArchive;
    try {
      zip = await open();
    } catch (err) {
      this.fail(label, err);
      return;
    }

    // Pass 1: classify entries from the central directory — no file data is read yet.
    const activityEntries: ZipEntry[] = [];
    const archives: ZipEntry[] = [];
    const metadata: { entry: ZipEntry; kind: MetadataKind }[] = [];
    let garminLayout = false;
    let listingFailed = false;
    try {
      for await (const entry of zip.entries()) {
        if (this.shouldStop()) return;
        if (entry.isDirectory || MAC_METADATA_ENTRY.test(entry.name)) continue;
        if (/^DI_CONNECT\//i.test(entry.name)) garminLayout = true;
        const kind = metadataKind(entry.name);
        if (kind) metadata.push({ entry, kind });
        else if (ACTIVITY_ENTRY.test(entry.name)) activityEntries.push(entry);
        else if (ARCHIVE_ENTRY.test(entry.name) && depth < MAX_ARCHIVE_DEPTH) archives.push(entry);
        await this.breathe();
      }
    } catch (err) {
      // Keep going with the entries listed before the damage.
      listingFailed = true;
      this.fail(label, err);
    }
    if (depth === 0 && !listingFailed && activityEntries.length === 0 && archives.length === 0) {
      this.skip(label, 'No FIT, GPX or TCX files in this ZIP archive.');
      return;
    }

    const context: ImportContext = { ...parent };
    if (garminLayout && !context.origin) context.origin = 'GARMIN';
    for (const { entry, kind } of metadata) {
      if (this.shouldStop()) return;
      await this.loadMetadata(kind, `${label} › ${entry.name}`, entry.size, () => zip.read(entry, MAX_METADATA_BYTES), context);
    }

    this.filesTotal += activityEntries.length;
    for (const entry of activityEntries) {
      if (this.shouldStop()) return;
      const read = (): Promise<Uint8Array> => zip.read(entry, MAX_ACTIVITY_FILE_BYTES);
      await this.importActivityFile(`${label} › ${entry.name}`, entry.name, read, context, false);
      await this.breathe();
    }

    for (const entry of archives) {
      if (this.shouldStop()) return;
      const nestedLabel = `${label} › ${entry.name}`;
      if (entry.method !== ZIP_STORED && entry.size > MAX_NESTED_ARCHIVE_BYTES) {
        const outer = baseName(label);
        this.fail(nestedLabel, new FileImportError(
          `This archive is too large to read inside ${outer}. Unzip ${outer} and import ${baseName(entry.name)} directly.`,
        ));
        continue;
      }
      await this.importArchive(() => zip.openNested(entry, MAX_NESTED_ARCHIVE_BYTES), nestedLabel, context, depth + 1);
    }
  }

  /**
   * Read archive metadata into `context` (defensively: unreadable metadata
   * only costs names). Returns false when the file isn't what its name suggests.
   */
  private async loadMetadata(
    kind: MetadataKind,
    label: string,
    size: number,
    read: () => Promise<Uint8Array>,
    context: ImportContext,
  ): Promise<boolean> {
    if (size > MAX_METADATA_BYTES) return false;
    try {
      const text = decodeUtf8(await read());
      if (kind === 'strava') {
        const index = parseStravaActivitiesCsv(text);
        if (!index) return false;
        const rows = new Map(context.strava ?? []);
        for (const [key, row] of index.byFile) rows.set(key, row);
        context.strava = rows;
        if (index.withoutFile > 0) {
          this.skip(label, `${plural(index.withoutFile, 'activity was', 'activities were')} entered manually on Strava without a recording file, so there's nothing to import for them.`);
        }
        return true;
      }
      const summaries = parseGarminSummaries(JSON.parse(text) as unknown);
      if (summaries.length === 0) return false;
      context.garmin = [...(context.garmin ?? []), ...summaries].sort((a, b) => a.start - b.start);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read, decode and convert one activity file. Files picked directly get a
   * `skipped` entry when they hold no usable workout; archive entries that
   * turn out not to be workouts are ignored quietly.
   */
  private async importActivityFile(
    label: string,
    path: string,
    read: () => Promise<Uint8Array>,
    context: ImportContext,
    direct: boolean,
  ): Promise<void> {
    const position = this.filesTotal > 1
      ? ` (${(this.filesDone + 1).toLocaleString()} of ${this.filesTotal.toLocaleString()})`
      : '';
    this.progress('parsing', `Reading ${baseName(path)}${position}…`);
    try {
      const decoded = await decodeActivityFile(await read(), path);
      if (!decoded) {
        if (direct) this.skip(label, NOT_AN_ACTIVITY);
      } else {
        this.result.filesRead++;
        const found = this.collect(decoded.activities, label, path, context);
        if (found === 0 && direct) this.skip(label, decoded.activities.length ? TOO_SHORT : emptyReason(decoded.format));
      }
    } catch (err) {
      this.fail(label, err);
    }
    this.filesDone++;
    if (this.pending.length >= SAVE_BATCH_SIZE) this.save();
  }

  /** Convert decoded workouts into activities (named via archive metadata) and queue them for saving. */
  private collect(parsed: ParsedActivity[], label: string, path: string, context: ImportContext): number {
    const stravaRow = context.strava?.get(archiveFileKey(path));
    const primary = stravaRow ? primaryIndex(parsed) : -1;
    let found = 0;
    parsed.forEach((p, i) => {
      let workout = p;
      const opts: ToActivityOptions = { fileName: label };
      if (stravaRow && i === primary) {
        // Strava's ID lets the import merge with legacy Strava copies of the same activity.
        opts.id = stravaRow.id;
        opts.sourceId = `strava:${stravaRow.id}`;
        opts.name = stravaRow.name;
        opts.type = stravaRow.type;
        opts.origin = p.origin || 'STRAVA';
      } else {
        // A multisport file's legs would all match the parent's summary, so only single workouts use it.
        const summary = parsed.length === 1 && context.garmin?.length
          ? findGarminSummary(context.garmin, p.startTime)
          : undefined;
        if (summary) {
          opts.name = summary.name;
          opts.type = specificSport(summary.type);
          if (p.utcOffsetSec === undefined && summary.utcOffsetSec !== undefined) {
            workout = { ...p, utcOffsetSec: summary.utcOffsetSec };
          }
        }
        if (!p.origin && context.origin) opts.origin = context.origin;
      }
      const activity = toActivity(workout, opts);
      if (activity) {
        this.pending.push(activity);
        found++;
      }
    });
    this.result.activitiesFound += found;
    return found;
  }

  /** Store queued activities (deduplicated against everything already on the device). */
  private save(): void {
    if (this.pending.length === 0 || this.halted) return;
    const batch = this.pending;
    this.pending = [];
    this.progress('saving', `Saving ${plural(batch.length, 'activity', 'activities')}…`);
    try {
      const { added, updated, dropped } = storeActivities(batch);
      this.result.added += added;
      this.result.updated += updated;
      this.result.dropped += dropped;
    } catch (err) {
      this.halted = true;
      const detail = err instanceof Error && err.message ? ` (${err.message})` : '';
      this.result.errors.push({
        name: 'Saving activities',
        message: `Apollo couldn't save the imported activities${detail}. Free up some disk space and try again.`,
      });
    }
  }

  /** Re-match the training plan, then tell open pages — exactly like after a sync. */
  private finish(startedAt: string): void {
    const { added, updated, activitiesFound } = this.result;
    if (added + updated === 0) return;
    this.progress('saving', 'Updating your training plan…');
    try {
      refreshPlanFromStoredActivities();
    } catch (err) {
      console.warn('[Apollo] Plan refresh after file import failed:', err);
    }
    notifyActivitiesUpdated({
      sources: ['file'],
      fetched: activitiesFound,
      added,
      updated,
      full: false,
      errors: [],
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Import workouts from FIT / GPX / TCX files (optionally gzipped) and from
 * Strava or Garmin export archives into the local activity store.
 *
 * Never throws: unreadable files are listed in `errors`, picked files without
 * a workout in `skipped`. When anything was added or updated, the training
 * plan is re-matched and then `onActivitiesUpdated` listeners are notified,
 * as after a sync. Cancelling via `signal` stops between files and keeps
 * everything decoded up to that point. When the store is full, its oldest
 * activities make room and are counted in `dropped`.
 */
export async function importActivityFiles(
  files: readonly ImportFile[],
  opts: ImportOptions = {},
): Promise<ImportResult> {
  return new ImportSession(opts).run(files);
}

/**
 * True for file names worth importing from a folder: activity files
 * (optionally gzipped), ZIP archives and export metadata (`activities.csv`,
 * `…summarizedActivities….json`) — not Finder `._` files. The import card
 * uses it to pick the relevant files out of a dropped folder, such as an
 * extracted Strava or Garmin export, by the same rules archives are scanned with.
 */
export function isImportableFileName(path: string): boolean {
  if (MAC_METADATA_ENTRY.test(path)) return false;
  return ACTIVITY_ENTRY.test(path) || ARCHIVE_ENTRY.test(path) || metadataKind(path) !== undefined;
}
