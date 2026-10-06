/**
 * ZIP reading for activity export archives (Strava "Download your archive",
 * Garmin "Export Your Data") plus the archive metadata Apollo uses to name
 * imported activities.
 *
 * Exports can be several gigabytes, so archives are read with random access
 * through a `ByteSource` (a `File`/`Blob` is sliced on demand): only the end
 * record, the central directory (streamed in chunks) and the entries actually
 * imported are ever loaded into memory.
 *
 * Supported: ZIP64 (end record, locator and extra fields), UTF-8 names (flag
 * bit 11 or the Info-ZIP Unicode Path extra field) with a CP437 fallback,
 * stored and deflated entries (CRC-checked), archives with prepended data,
 * and nested ZIPs — Garmin keeps uploaded FIT files in
 * `DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_*.zip`. A stored nested
 * archive is read in place through an offset-shifted source (no copy); a
 * deflated one has to be inflated into memory first. Directories are skipped;
 * encrypted entries and exotic compression methods are reported as errors.
 */

import { FileImportError } from './types';
import { OutputLimitError, crc32, inflateRaw } from './inflate';

// ── Byte sources ──────────────────────────────────────────────────────────────

/** Random-access, read-only view of a file, blob or byte array. */
export interface ByteSource {
  /** Total size in bytes. */
  readonly size: number;
  /** Read up to `length` bytes at `offset` (clamped to the end of the source). */
  read(offset: number, length: number): Promise<Uint8Array>;
}

function clampRange(size: number, offset: number, length: number): [number, number] {
  const start = Math.max(0, Math.min(size, Math.floor(offset)));
  const end = Math.max(start, Math.min(size, start + Math.max(0, Math.floor(length))));
  return [start, end];
}

function readBlob(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  // Older engines: Blob#arrayBuffer is missing but FileReader exists.
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** A `File`/`Blob` read lazily with `blob.slice()` — nothing is loaded up front. */
export function blobSource(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(offset, length) {
      const [start, end] = clampRange(blob.size, offset, length);
      if (end <= start) return new Uint8Array(0);
      return new Uint8Array(await readBlob(blob.slice(start, end)));
    },
  };
}

/** An in-memory byte array (reads return views, not copies). */
export function bytesSource(data: Uint8Array): ByteSource {
  return {
    size: data.length,
    async read(offset, length) {
      const [start, end] = clampRange(data.length, offset, length);
      return data.subarray(start, end);
    },
  };
}

/** A window of another source, e.g. a stored ZIP nested inside a ZIP. */
export function sliceSource(source: ByteSource, offset: number, length: number): ByteSource {
  const base = Math.max(0, Math.min(source.size, offset));
  const size = Math.max(0, Math.min(length, source.size - base));
  return {
    size,
    read(o, l) {
      const [start, end] = clampRange(size, o, l);
      return source.read(base + start, end - start);
    },
  };
}

/** Read a whole source into memory. */
export function readAll(source: ByteSource): Promise<Uint8Array> {
  return source.read(0, source.size);
}

// ── Little-endian helpers ─────────────────────────────────────────────────────

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

/** 64-bit little-endian integer (exact up to 2^53, far beyond any real archive). */
function u64(b: Uint8Array, at: number): number {
  return u32(b, at) + u32(b, at + 4) * 0x100000000;
}

// ── Text decoding ─────────────────────────────────────────────────────────────

/** CP437 (the historic ZIP name encoding) characters for bytes 0x80–0xFF. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
  '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

let utf8Decoder: TextDecoder | null = null;

/** Decode UTF-8 (invalid sequences become U+FFFD). */
export function decodeUtf8(bytes: Uint8Array): string {
  utf8Decoder ??= new TextDecoder('utf-8');
  return utf8Decoder.decode(bytes);
}

/** Decode a CP437 byte string (ZIP names without the UTF-8 flag). */
export function decodeCp437(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
  }
  return out;
}

// ── ZIP structures ────────────────────────────────────────────────────────────

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIZE = 56;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
/** The central directory is streamed in windows of this size. */
const CENTRAL_DIRECTORY_CHUNK = 1 << 20;
/** Largest entry `read()` inflates by default. */
const DEFAULT_MAX_ENTRY_BYTES = 0x7fffffff;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const EXTRA_ZIP64 = 0x0001;
const EXTRA_UNICODE_PATH = 0x7075;

/** Compression methods Apollo can read. */
export const ZIP_STORED = 0;
export const ZIP_DEFLATED = 8;

/** One file or directory listed in a ZIP's central directory. */
export interface ZipEntry {
  /** Path inside the archive with '/' separators, e.g. "activities/123.fit.gz". */
  readonly name: string;
  /** Compression method (0 = stored, 8 = deflate). */
  readonly method: number;
  readonly compressedSize: number;
  /** Uncompressed size in bytes. */
  readonly size: number;
  readonly crc32: number;
  /** Absolute offset of the entry's local header within the archive's source. */
  readonly offset: number;
  readonly isDirectory: boolean;
  /** Password-protected entries cannot be read. */
  readonly encrypted: boolean;
}

function corrupt(detail: string): FileImportError {
  return new FileImportError(`The ZIP archive is corrupt or incomplete (${detail}).`);
}

function parseCentralEntry(b: Uint8Array, o: number, shift: number): ZipEntry {
  const flags = u16(b, o + 8);
  const method = u16(b, o + 10);
  const crc = u32(b, o + 16);
  let compressedSize = u32(b, o + 20);
  let size = u32(b, o + 24);
  const nameLen = u16(b, o + 28);
  const extraLen = u16(b, o + 30);
  let offset = u32(b, o + 42);
  const nameBytes = b.subarray(o + CENTRAL_HEADER_SIZE, o + CENTRAL_HEADER_SIZE + nameLen);
  const extra = b.subarray(o + CENTRAL_HEADER_SIZE + nameLen, o + CENTRAL_HEADER_SIZE + nameLen + extraLen);

  let name: string | null = null;
  for (let p = 0; p + 4 <= extra.length;) {
    const id = u16(extra, p);
    const len = u16(extra, p + 2);
    const body = p + 4;
    const bodyEnd = body + len;
    if (bodyEnd > extra.length) break;
    if (id === EXTRA_ZIP64) {
      // Only the fields whose 32-bit header value is saturated are present, in this order.
      let q = body;
      if (size === 0xffffffff && q + 8 <= bodyEnd) { size = u64(extra, q); q += 8; }
      if (compressedSize === 0xffffffff && q + 8 <= bodyEnd) { compressedSize = u64(extra, q); q += 8; }
      if (offset === 0xffffffff && q + 8 <= bodyEnd) offset = u64(extra, q);
    } else if (id === EXTRA_UNICODE_PATH && len >= 5 && extra[body] === 1) {
      // Info-ZIP Unicode Path: valid only while the stored name is unchanged (CRC matches).
      if (u32(extra, body + 1) === crc32(nameBytes)) name = decodeUtf8(extra.subarray(body + 5, bodyEnd));
    }
    p = bodyEnd;
  }
  if (name === null) name = flags & FLAG_UTF8 ? decodeUtf8(nameBytes) : decodeCp437(nameBytes);
  name = name.replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');

  return {
    name,
    method,
    compressedSize,
    size,
    crc32: crc,
    offset: offset + shift,
    isDirectory: name.endsWith('/'),
    encrypted: (flags & FLAG_ENCRYPTED) !== 0,
  };
}

/** Lazily-read ZIP archive. Open with `ZipArchive.open(source)`. */
export class ZipArchive {
  private constructor(
    /** The bytes of this archive. */
    readonly source: ByteSource,
    /** Entry count from the end record (may be wrapped mod 65536 by old non-ZIP64 writers). */
    readonly entryCount: number,
    private readonly cdStart: number,
    private readonly cdSize: number,
    /** Bytes prepended to the archive (self-extractors); added to every recorded offset. */
    private readonly shift: number,
  ) {}

  /** Locate the end record(s) and central directory. Reads at most ~64 KB plus a few headers. */
  static async open(source: ByteSource): Promise<ZipArchive> {
    const size = source.size;
    if (size < EOCD_SIZE) throw new FileImportError('Not a ZIP archive (the file is too small).');
    const tailLen = Math.min(size, EOCD_SIZE + MAX_COMMENT + ZIP64_LOCATOR_SIZE);
    const tailStart = size - tailLen;
    const tail = await source.read(tailStart, tailLen);

    // The end record is followed only by its variable-length comment: scan backwards.
    let at = -1;
    for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && u32(tail, i) === SIG_EOCD) {
        if (i + EOCD_SIZE + u16(tail, i + 20) <= tail.length) {
          at = i;
          break;
        }
      }
    }
    if (at < 0) throw new FileImportError('Not a ZIP archive (or the download is incomplete).');

    let disk = u16(tail, at + 4);
    let cdDisk = u16(tail, at + 6);
    let count = u16(tail, at + 10);
    let cdSize = u32(tail, at + 12);
    let cdOffset = u32(tail, at + 16);
    /** Absolute position of the record that directly follows the central directory. */
    let recordPos = tailStart + at;

    const locAt = at - ZIP64_LOCATOR_SIZE;
    if (locAt >= 0 && u32(tail, locAt) === SIG_ZIP64_LOCATOR) {
      const recorded = u64(tail, locAt + 8);
      // Usually the ZIP64 end record sits right before the locator; try the recorded
      // offset first, then that position (which survives prepended data).
      for (const pos of [recorded, tailStart + locAt - ZIP64_EOCD_SIZE]) {
        if (pos < 0 || pos + ZIP64_EOCD_SIZE > size) continue;
        const rec = await source.read(pos, ZIP64_EOCD_SIZE);
        if (rec.length === ZIP64_EOCD_SIZE && u32(rec, 0) === SIG_ZIP64_EOCD) {
          disk = u32(rec, 16);
          cdDisk = u32(rec, 20);
          count = u64(rec, 32);
          cdSize = u64(rec, 40);
          cdOffset = u64(rec, 48);
          recordPos = pos;
          break;
        }
      }
    }
    if (disk !== 0 || cdDisk !== 0) {
      throw new FileImportError('Split ZIP archives (.z01, .z02…) are not supported. Please import the archive as a single .zip file.');
    }

    let shift = recordPos - (cdOffset + cdSize);
    if (shift < 0) throw corrupt('central directory out of range');
    if (count > 0 || cdSize > 0) {
      // Either data was prepended (offsets are shifted) or there's padding before the end record.
      const probe = await source.read(cdOffset, 4);
      if (probe.length === 4 && u32(probe, 0) === SIG_CENTRAL) shift = 0;
      else if (shift > 0) {
        const shifted = await source.read(cdOffset + shift, 4);
        if (shifted.length !== 4 || u32(shifted, 0) !== SIG_CENTRAL) throw corrupt('central directory not found');
      } else {
        throw corrupt('central directory not found');
      }
    }
    return new ZipArchive(source, count, cdOffset + shift, cdSize, shift);
  }

  /**
   * Iterate the central directory lazily (read in ~1 MB windows), so archives
   * with hundreds of thousands of entries never need the whole listing in memory.
   */
  async *entries(): AsyncGenerator<ZipEntry, void, undefined> {
    const end = this.cdStart + this.cdSize;
    let pos = this.cdStart;
    let buf: Uint8Array = new Uint8Array(0);
    let bufStart = pos;
    const ensure = async (n: number): Promise<boolean> => {
      if (pos + n <= bufStart + buf.length) return true;
      if (pos + n > end) return false;
      buf = await this.source.read(pos, Math.min(end - pos, Math.max(n, CENTRAL_DIRECTORY_CHUNK)));
      bufStart = pos;
      return buf.length >= n;
    };
    while (pos < end) {
      if (!(await ensure(CENTRAL_HEADER_SIZE))) break;
      let o = pos - bufStart;
      if (u32(buf, o) !== SIG_CENTRAL) break;
      const total = CENTRAL_HEADER_SIZE + u16(buf, o + 28) + u16(buf, o + 30) + u16(buf, o + 32);
      if (!(await ensure(total))) throw corrupt('truncated central directory');
      o = pos - bufStart;
      yield parseCentralEntry(buf, o, this.shift);
      pos += total;
    }
  }

  /** Offset of an entry's data (after its local header, whose extra field may differ from the central one). */
  private async dataStart(entry: ZipEntry): Promise<number> {
    const h = await this.source.read(entry.offset, LOCAL_HEADER_SIZE);
    if (h.length < LOCAL_HEADER_SIZE || u32(h, 0) !== SIG_LOCAL) throw corrupt(`bad local header for ${entry.name}`);
    return entry.offset + LOCAL_HEADER_SIZE + u16(h, 26) + u16(h, 28);
  }

  /** Read and decompress one entry, verifying its size and CRC-32. */
  async read(entry: ZipEntry, maxBytes: number = DEFAULT_MAX_ENTRY_BYTES): Promise<Uint8Array> {
    if (entry.isDirectory) return new Uint8Array(0);
    if (entry.encrypted) throw new FileImportError('Password-protected ZIP entries are not supported.');
    if (entry.method !== ZIP_STORED && entry.method !== ZIP_DEFLATED) {
      throw new FileImportError(`Unsupported ZIP compression method (${entry.method}). Re-create the archive with standard ZIP compression.`);
    }
    if (entry.size > maxBytes) throw new FileImportError('The file is too large to import.');
    const start = await this.dataStart(entry);
    const raw = await this.source.read(start, entry.compressedSize);
    if (raw.length !== entry.compressedSize) throw corrupt(`truncated data for ${entry.name}`);
    let data: Uint8Array;
    try {
      // Never inflate past the declared size, so a crafted entry (zip bomb) can't exhaust memory.
      data = entry.method === ZIP_STORED ? raw : await inflateRaw(raw, entry.size, entry.size);
    } catch (err) {
      if (err instanceof OutputLimitError) {
        throw new FileImportError('The file is corrupt inside the ZIP archive (it holds more data than its header declares).');
      }
      throw err;
    }
    if (data.length !== entry.size || crc32(data) !== entry.crc32) {
      throw new FileImportError('The file is corrupt inside the ZIP archive (checksum mismatch).');
    }
    return data;
  }

  /**
   * Open a ZIP stored inside this one. Stored entries are read in place
   * (offset-shifted source, no copy); deflated ones are inflated into memory.
   */
  async openNested(entry: ZipEntry, maxBytes: number = DEFAULT_MAX_ENTRY_BYTES): Promise<ZipArchive> {
    if (entry.method === ZIP_STORED && !entry.encrypted) {
      const start = await this.dataStart(entry);
      return ZipArchive.open(sliceSource(this.source, start, entry.compressedSize));
    }
    return ZipArchive.open(bytesSource(await this.read(entry, maxBytes)));
  }
}

/** True when `data` starts like a ZIP archive (local header or empty-archive end record). */
export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b
    && ((data[2] === 3 && data[3] === 4) || (data[2] === 5 && data[3] === 6));
}

// ── Archive metadata: CSV ─────────────────────────────────────────────────────

/**
 * Parse RFC 4180 CSV: quoted fields may contain commas, line breaks and
 * doubled quotes; CRLF, LF and CR line endings; a leading BOM is ignored.
 * Lenient with text between a closing quote and the next delimiter. Blank
 * lines come back as `['']`.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (i >= n) return rows;
  let row: string[] = [];
  for (;;) {
    let field = '';
    if (text.charCodeAt(i) === 34 /* " */) {
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) {
          field += text.slice(j); // unterminated quote: take the rest
          j = n;
          break;
        }
        field += text.slice(j, q);
        if (text.charCodeAt(q + 1) === 34) {
          field += '"';
          j = q + 2;
          continue;
        }
        j = q + 1;
        break;
      }
      i = j;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === 44 || c === 10 || c === 13) break;
        field += text[i++];
      }
    } else {
      let j = i;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (c === 44 || c === 10 || c === 13) break;
        j++;
      }
      field = text.slice(i, j);
      i = j;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      break;
    }
    const delimiter = text.charCodeAt(i++);
    if (delimiter === 44 /* , */) {
      if (i >= n) {
        row.push('');
        rows.push(row);
        break;
      }
      continue;
    }
    if (delimiter === 13 && text.charCodeAt(i) === 10) i++;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }
  return rows;
}

// ── Archive metadata: Strava ──────────────────────────────────────────────────

/** How Strava identifies an activity, from the archive's `activities.csv`. */
export interface StravaArchiveRow {
  /** Strava activity ID. */
  id: number;
  name?: string;
  /** Activity type as Strava displays it, e.g. "Run", "Virtual Ride", "Weight Training". */
  type?: string;
}

/** Strava `activities.csv`, indexed by activity file. */
export interface StravaActivitiesIndex {
  /** Rows keyed by `archiveFileKey(Filename)`. */
  byFile: Map<string, StravaArchiveRow>;
  /** Rows without an activity file (manual entries) — nothing to import for those. */
  withoutFile: number;
}

/**
 * Key used to match an archive path with a CSV `Filename`: the lower-cased
 * base name without a trailing ".gz" ("activities/123.fit.gz" → "123.fit"),
 * so matching survives re-zipped folders and decompressed files.
 */
export function archiveFileKey(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase();
  return base.endsWith('.gz') ? base.slice(0, -3) : base;
}

/**
 * Parse Strava's `activities.csv`. Columns are matched by header name; the
 * export repeats some names ("Distance", "Elapsed Time"…), so the FIRST
 * "Activity ID", "Activity Name", "Activity Type" and "Filename" are used.
 * Returns null when the CSV is not a Strava activity list.
 */
export function parseStravaActivitiesCsv(text: string): StravaActivitiesIndex | null {
  const rows = parseCsv(text);
  if (rows.length === 0) return null;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idCol = header.indexOf('activity id');
  const fileCol = header.indexOf('filename');
  if (idCol < 0 || fileCol < 0) return null;
  const nameCol = header.indexOf('activity name');
  const typeCol = header.indexOf('activity type');

  const byFile = new Map<string, StravaArchiveRow>();
  let withoutFile = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const idText = (row[idCol] ?? '').trim();
    if (!/^\d+$/.test(idText)) continue;
    const id = Number(idText);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const file = (row[fileCol] ?? '').trim();
    if (!file) {
      withoutFile++;
      continue;
    }
    const name = nameCol >= 0 ? (row[nameCol] ?? '').trim() : '';
    const type = typeCol >= 0 ? (row[typeCol] ?? '').trim() : '';
    byFile.set(archiveFileKey(file), { id, name: name || undefined, type: type || undefined });
  }
  return { byFile, withoutFile };
}

// ── Archive metadata: Garmin ──────────────────────────────────────────────────

/** One activity from Garmin's `…_summarizedActivities.json`. */
export interface GarminActivitySummary {
  /** Start time, UTC ms. */
  start: number;
  name?: string;
  /** Garmin activity type key, e.g. "running", "treadmill_running", "lap_swimming". */
  type?: string;
  /** Local-time offset in seconds, when both GMT and local start times are present. */
  utcOffsetSec?: number;
}

/** Epoch value in ms from a number (s or ms) or a date string ("2019-06-30 11:27:12" is UTC). */
function epochMs(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : undefined;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const s = v.trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return epochMs(Number(s));
  const iso = s.replace(' ', 'T');
  const t = Date.parse(/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(t) ? t : undefined;
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Extract activity summaries from a parsed `summarizedActivities` JSON
 * (`[{ summarizedActivitiesExport: [...] }]` in current exports). Defensive:
 * unknown shapes yield an empty list. Sorted by start time.
 */
export function parseGarminSummaries(json: unknown): GarminActivitySummary[] {
  const out: GarminActivitySummary[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const gmt = epochMs(o.startTimeGmt) ?? epochMs(o.startTimeGMT);
    const start = epochMs(o.beginTimestamp) ?? gmt;
    if (start === undefined) {
      // A wrapper such as `{ summarizedActivitiesExport: [...] }`: look inside its lists.
      for (const value of Object.values(o)) if (Array.isArray(value)) visit(value, depth + 1);
      return;
    }
    const local = epochMs(o.startTimeLocal);
    let utcOffsetSec: number | undefined;
    if (local !== undefined) {
      const offset = Math.round((local - (gmt ?? start)) / 1000);
      if (Math.abs(offset) <= 14 * 3600) utcOffsetSec = offset;
    }
    const activityType = o.activityType;
    const typeKey = typeof activityType === 'string'
      ? nonEmpty(activityType)
      : activityType && typeof activityType === 'object'
        ? nonEmpty((activityType as Record<string, unknown>).typeKey)
        : undefined;
    out.push({
      start,
      name: nonEmpty(o.name) ?? nonEmpty(o.activityName),
      type: typeKey ?? nonEmpty(o.sportType),
      utcOffsetSec,
    });
  };
  visit(json, 0);
  return out.sort((a, b) => a.start - b.start);
}

/** The summary whose start is closest to `startMs`, within `toleranceMs` (list sorted by start). */
export function findGarminSummary(
  list: GarminActivitySummary[],
  startMs: number,
  toleranceMs: number = 120_000,
): GarminActivitySummary | undefined {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].start < startMs) lo = mid + 1;
    else hi = mid;
  }
  let best: GarminActivitySummary | undefined;
  let bestDiff = Infinity;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= list.length) continue;
    const diff = Math.abs(list[i].start - startMs);
    if (diff < bestDiff) {
      best = list[i];
      bestDiff = diff;
    }
  }
  return bestDiff <= toleranceMs ? best : undefined;
}
