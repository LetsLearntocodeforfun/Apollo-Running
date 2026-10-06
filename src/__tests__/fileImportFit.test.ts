/**
 * Unit tests for the FIT activity-file decoder (fileImport/fit.ts).
 *
 * Files are produced by the small FIT encoder below (definition and data
 * messages, either byte order, compressed timestamps, developer fields,
 * optional CRCs), so every binary feature the decoder handles is exercised
 * without committing binary fixtures.
 */

import { describe, it, expect } from 'vitest';
import { isFitFile, parseFit } from '@/services/fileImport/fit';
import { FileImportError } from '@/services/fileImport/types';
import type { ParsedActivity } from '@/services/fileImport/types';

// ── A minimal FIT encoder ─────────────────────────────────────────────────────

/** Base types as written in definition messages (multi-byte types carry the 0x80 endian flag). */
const BT = {
  enum: 0x00, sint8: 0x01, uint8: 0x02, sint16: 0x83, uint16: 0x84, sint32: 0x85, uint32: 0x86,
  string: 0x07, uint8z: 0x0a, uint16z: 0x8b, uint32z: 0x8c, byte: 0x0d,
} as const;

/** Byte width by base type number (low 5 bits). */
const WIDTH: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 1, 10: 1, 11: 2, 12: 4, 13: 1 };

/** Invalid ("no value") marker by base type number. */
const INVALID: Record<number, number> = {
  0: 0xff, 1: 0x7f, 2: 0xff, 3: 0x7fff, 4: 0xffff, 5: 0x7fffffff, 6: 0xffffffff, 10: 0, 11: 0, 12: 0, 13: 0xff,
};

/** A field definition: number, base type and, for arrays, strings and odd sizes, the byte size. */
type Field = [num: number, type: number, size?: number];
/** Data-message values by field number; fields left out are written as invalid. */
type Values = Partial<Record<number, number | string>>;

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

/** FIT CRC-16. */
function crc16(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    for (const nibble of [b & 0x0f, b >> 4]) {
      crc = ((crc >> 4) & 0x0fff) ^ CRC_TABLE[crc & 0x0f] ^ CRC_TABLE[nibble];
    }
  }
  return crc;
}

/** One field's bytes: the value (or the invalid marker); array elements after the first are invalid. */
function encodeField([, type, size]: Field, value: number | string | undefined, littleEndian: boolean): Uint8Array {
  const base = type & 0x1f;
  const width = WIDTH[base];
  const bytes = new Uint8Array(size ?? width);
  if (base === 7) {
    bytes.set(new TextEncoder().encode(String(value ?? '')).subarray(0, bytes.length - 1));
    return bytes;
  }
  if (bytes.length % width !== 0) return bytes.fill(0x11); // a size the base type can't fill
  const view = new DataView(bytes.buffer);
  for (let at = 0; at < bytes.length; at += width) {
    const v = at === 0 && typeof value === 'number' ? value : INVALID[base];
    if (width === 1) view.setUint8(at, v & 0xff);
    else if (width === 2) view.setUint16(at, v & 0xffff, littleEndian);
    else view.setUint32(at, v >>> 0, littleEndian);
  }
  return bytes;
}

interface LocalDefinition {
  fields: Field[];
  littleEndian: boolean;
  developerBytes: number;
}

interface DefineOptions {
  bigEndian?: boolean;
  /** Developer fields as [field number, size, developer data index]. */
  dev?: Array<[number, number, number]>;
}

interface BuildOptions {
  headerSize?: 12 | 14;
  /** false writes zero CRCs, which decoders must tolerate. */
  crc?: boolean;
  /** Header data size; defaults to the real size (0 = unknown, as crashed devices leave it). */
  dataSize?: number;
}

/** Builds a FIT file message by message. */
class FitWriter {
  private readonly records: number[] = [];
  private readonly definitions = new Map<number, LocalDefinition>();

  /** Definition message for local type `local`. */
  define(local: number, global: number, fields: Field[], opts: DefineOptions = {}): this {
    const littleEndian = !opts.bigEndian;
    const dev = opts.dev ?? [];
    this.records.push(0x40 | (dev.length > 0 ? 0x20 : 0) | local, 0, littleEndian ? 0 : 1);
    this.records.push(...(littleEndian ? [global & 0xff, global >> 8] : [global >> 8, global & 0xff]));
    this.records.push(fields.length);
    for (const [num, type, size] of fields) this.records.push(num, size ?? WIDTH[type & 0x1f], type);
    if (dev.length > 0) {
      this.records.push(dev.length);
      for (const d of dev) this.records.push(...d);
    }
    const developerBytes = dev.reduce((sum, d) => sum + d[1], 0);
    this.definitions.set(local, { fields, littleEndian, developerBytes });
    return this;
  }

  /** Data message with a normal header. */
  data(local: number, values: Values = {}): this {
    this.records.push(local);
    return this.payload(local, values);
  }

  /** Data message with a compressed-timestamp header (local types 0–3, 5-bit time offset). */
  compressed(local: number, timeOffset: number, values: Values = {}): this {
    this.records.push(0x80 | (local << 5) | (timeOffset & 0x1f));
    return this.payload(local, values);
  }

  /** Arbitrary bytes, e.g. to corrupt the stream. */
  raw(...bytes: number[]): this {
    this.records.push(...bytes);
    return this;
  }

  /** The complete file: header, records and CRC. */
  build(opts: BuildOptions = {}): Uint8Array {
    const headerSize = opts.headerSize ?? 14;
    const crc = (bytes: Uint8Array): number => (opts.crc === false ? 0 : crc16(bytes));
    const file = new Uint8Array(headerSize + this.records.length + 2);
    const view = new DataView(file.buffer);
    file[0] = headerSize;
    file[1] = 0x20; // protocol 2.0
    view.setUint16(2, 2132, true); // profile 21.32
    view.setUint32(4, opts.dataSize ?? this.records.length, true);
    file.set([0x2e, 0x46, 0x49, 0x54], 8); // ".FIT"
    if (headerSize === 14) view.setUint16(12, crc(file.subarray(0, 12)), true);
    file.set(this.records, headerSize);
    const end = headerSize + this.records.length;
    view.setUint16(end, crc(file.subarray(0, end)), true);
    return file;
  }

  private payload(local: number, values: Values): this {
    const def = this.definitions.get(local);
    if (!def) throw new Error(`local message type ${local} is not defined`);
    for (const field of def.fields) this.records.push(...encodeField(field, values[field[0]], def.littleEndian));
    for (let i = 0; i < def.developerBytes; i++) this.records.push(0xa5);
    return this;
  }
}

/** Several FIT files back to back (a chained file). */
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── Profile subset and builders ───────────────────────────────────────────────

/** Seconds from the Unix epoch to the FIT epoch (1989-12-31T00:00:00Z). */
const FIT_EPOCH_SEC = 631065600;
/** 2021-09-08T01:46:40Z as a FIT date_time; its low 5 bits are 0. */
const T0 = 1000000000;
/** FIT date_time → Unix ms, as parseFit reports times. */
const ms = (fitSec: number): number => (fitSec + FIT_EPOCH_SEC) * 1000;
/** Degrees → semicircles. */
const semi = (deg: number): number => Math.round((deg * 2 ** 31) / 180);
/** 0, 1, …, n − 1. */
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

const MESG = { fileId: 0, sport: 12, session: 18, lap: 19, record: 20, deviceInfo: 23, activity: 34 } as const;

const FILE_ID: Field[] = [[0, BT.enum], [1, BT.uint16], [2, BT.uint16], [4, BT.uint32], [8, BT.string, 20]];
const RECORD: Field[] = [
  [253, BT.uint32], [0, BT.sint32], [1, BT.sint32], [5, BT.uint32], [2, BT.uint16],
  [3, BT.uint8], [4, BT.uint8], [6, BT.uint16], [7, BT.uint16],
];
const LAP: Field[] = [
  [253, BT.uint32], [2, BT.uint32], [7, BT.uint32], [8, BT.uint32], [9, BT.uint32], [13, BT.uint16],
  [14, BT.uint16], [15, BT.uint8], [16, BT.uint8], [17, BT.uint8], [21, BT.uint16], [25, BT.enum], [39, BT.enum],
];
const SESSION: Field[] = [
  [253, BT.uint32], [2, BT.uint32], [5, BT.enum], [6, BT.enum], [7, BT.uint32], [8, BT.uint32], [9, BT.uint32],
  [11, BT.uint16], [14, BT.uint16], [15, BT.uint16], [16, BT.uint8], [17, BT.uint8], [18, BT.uint8],
  [20, BT.uint16], [22, BT.uint16], [34, BT.uint16], [35, BT.uint16],
];
const ACTIVITY: Field[] = [[253, BT.uint32], [5, BT.uint32]];
const DEVICE_INFO: Field[] = [[253, BT.uint32], [0, BT.uint8], [2, BT.uint16], [4, BT.uint16], [27, BT.string, 20]];
const SPORT: Field[] = [[0, BT.enum], [1, BT.enum]];

interface FileOptions {
  /** file_id.type; 4 (activity) by default. */
  type?: number;
  manufacturer?: number;
  product?: number;
  productName?: string;
}

interface ActivityOptions extends FileOptions {
  /** First record, FIT date_time. */
  start?: number;
  /** Number of 1 Hz records. */
  seconds?: number;
  sport?: number;
  subSport?: number;
  /** activity.local_timestamp − timestamp; null leaves the activity message out. */
  utcOffset?: number | null;
}

/** A writer starting with file_id on local type 0: a Garmin Forerunner 965 activity by default. */
function fitFile(opts: FileOptions = {}): FitWriter {
  return new FitWriter()
    .define(0, MESG.fileId, FILE_ID)
    .data(0, { 0: opts.type ?? 4, 1: opts.manufacturer ?? 1, 2: opts.product ?? 4315, 4: T0, 8: opts.productName });
}

/** file_id, then `seconds` records at 1 Hz (3 m/s, 140 bpm) on local type 1. */
function recordsWriter(opts: ActivityOptions = {}): FitWriter {
  const start = opts.start ?? T0;
  const w = fitFile(opts).define(1, MESG.record, RECORD);
  for (let i = 0; i < (opts.seconds ?? 10); i++) w.data(1, { 253: start + i, 5: i * 300, 6: 3000, 3: 140 });
  return w;
}

/** recordsWriter plus one lap, a session and (unless `utcOffset` is null) an activity message at UTC+2. */
function activityWriter(opts: ActivityOptions = {}): FitWriter {
  const start = opts.start ?? T0;
  const seconds = opts.seconds ?? 10;
  const end = start + seconds - 1;
  const totals: Values = { 7: (seconds - 1) * 1000, 8: (seconds - 1) * 1000, 9: (seconds - 1) * 300 };
  const w = recordsWriter(opts)
    .define(2, MESG.lap, LAP)
    .data(2, { 253: end, 2: start, ...totals })
    .define(3, MESG.session, SESSION)
    .data(3, { 253: end, 2: start, 5: opts.sport ?? 1, 6: opts.subSport ?? 0, ...totals });
  if (opts.utcOffset !== null) {
    w.define(4, MESG.activity, ACTIVITY).data(4, { 253: end, 5: end + (opts.utcOffset ?? 7200) });
  }
  return w;
}

/** Appends a running session (local type 3) over [start, end], so lone records form an activity. */
function withSession(w: FitWriter, start: number, end: number, values: Values = {}): FitWriter {
  return w.define(3, MESG.session, SESSION).data(3, { 253: end, 2: start, 5: 1, 7: (end - start) * 1000, ...values });
}

/** parseFit, expecting exactly one activity. */
function parseOne(data: Uint8Array): ParsedActivity {
  const activities = parseFit(data);
  expect(activities).toHaveLength(1);
  return activities[0];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('isFitFile', () => {
  it('accepts 12- and 14-byte headers with the .FIT signature', () => {
    expect(isFitFile(activityWriter().build({ headerSize: 14 }))).toBe(true);
    expect(isFitFile(activityWriter().build({ headerSize: 12 }))).toBe(true);
  });

  it('rejects anything else', () => {
    const fit = activityWriter().build();
    const badSize = fit.slice();
    badSize[0] = 13;
    const badSignature = fit.slice();
    badSignature[9] = 0x66; // ".fIT"
    expect(isFitFile(new Uint8Array(0))).toBe(false);
    expect(isFitFile(fit.subarray(0, 11))).toBe(false);
    expect(isFitFile(badSize)).toBe(false);
    expect(isFitFile(badSignature)).toBe(false);
    expect(isFitFile(new TextEncoder().encode('<?xml version="1.0"?><gpx/>'))).toBe(false);
  });
});

describe('parseFit: file structure', () => {
  it('decodes 12- and 14-byte headers alike and ignores CRCs', () => {
    const expected = parseFit(activityWriter().build());
    expect(expected).toHaveLength(1);
    expect(parseFit(activityWriter().build({ headerSize: 12 }))).toEqual(expected);
    expect(parseFit(activityWriter().build({ crc: false }))).toEqual(expected);
    const badCrc = activityWriter().build();
    badCrc[12] ^= 0xff; // header CRC
    badCrc[badCrc.length - 1] ^= 0xff; // file CRC
    expect(parseFit(badCrc)).toEqual(expected);
  });

  it('accepts a view into a larger buffer', () => {
    const file = activityWriter().build();
    expect(parseFit(concat(new Uint8Array(7), file).subarray(7))).toEqual(parseFit(file));
  });

  it('handles several local types and redefinitions of a local type', () => {
    // Local type 0 holds file_id, then records (redefined to add heart rate), then the session.
    const w = new FitWriter()
      .define(0, MESG.fileId, FILE_ID)
      .data(0, { 0: 4, 1: 1, 2: 4315 })
      .define(0, MESG.record, [[253, BT.uint32], [5, BT.uint32]])
      .data(0, { 253: T0, 5: 0 })
      .define(15, MESG.lap, LAP)
      .data(0, { 253: T0 + 1, 5: 300 })
      .define(0, MESG.record, [[253, BT.uint32], [3, BT.uint8], [5, BT.uint32]])
      .data(0, { 253: T0 + 2, 3: 150, 5: 600 })
      .data(15, { 253: T0 + 2, 2: T0, 7: 2000, 9: 600 })
      .define(0, MESG.session, SESSION)
      .data(0, { 253: T0 + 2, 2: T0, 5: 1, 7: 2000, 9: 600 });
    const a = parseOne(w.build());
    expect(a.samples).toEqual([
      { time: ms(T0), distance: 0 },
      { time: ms(T0 + 1), distance: 3 },
      { time: ms(T0 + 2), distance: 6, heartRate: 150 },
    ]);
    expect(a.laps).toEqual([{ startTime: ms(T0), elapsedSec: 2, distance: 6 }]);
    expect(a.totals).toEqual({ elapsedSec: 2, distance: 6 });
  });

  it('decodes big-endian definitions', () => {
    const write = (bigEndian: boolean): Uint8Array => {
      const w = new FitWriter()
        .define(0, MESG.fileId, FILE_ID, { bigEndian })
        .data(0, { 0: 4, 1: 1, 2: 4315 })
        .define(1, MESG.record, RECORD, { bigEndian });
      for (let i = 0; i < 3; i++) {
        w.data(1, { 253: T0 + i, 0: semi(-33.9), 1: semi(151.2), 5: i * 250, 2: 2550, 6: 2500, 7: 300 + i });
      }
      return w
        .define(2, MESG.session, SESSION, { bigEndian })
        .data(2, { 253: T0 + 2, 2: T0, 5: 2, 7: 2000, 9: 500, 14: 2500, 20: 301 })
        .build();
    };
    const big = parseOne(write(true));
    expect(big).toEqual(parseOne(write(false)));
    expect(big).toMatchObject({
      type: 'Ride',
      device: 'Garmin Forerunner 965',
      totals: { elapsedSec: 2, distance: 5, avgSpeed: 2.5, avgPower: 301 },
    });
    expect(big.samples[2]).toMatchObject({ time: ms(T0 + 2), distance: 5, altitude: 10, speed: 2.5, power: 302 });
    expect(big.samples[2].lat).toBeCloseTo(-33.9, 6);
    expect(big.samples[2].lng).toBeCloseTo(151.2, 6);
  });

  it('resolves compressed-timestamp headers, including the 32-second rollover', () => {
    const base = T0 + 30; // low 5 bits: 30
    const w = fitFile()
      .define(1, MESG.record, [[253, BT.uint32], [5, BT.uint32]])
      .data(1, { 253: base, 5: 0 })
      .define(2, MESG.record, [[5, BT.uint32]]) // no timestamp field
      .compressed(2, 31, { 5: 100 }) // base + 1
      .compressed(2, 0, { 5: 200 }) // offset below the last low bits: rolled over to base + 2
      .compressed(2, 1, { 5: 300 }); // base + 3
    const a = parseOne(withSession(w, base, base + 3).build());
    expect(a.samples).toEqual(range(4).map((i) => ({ time: ms(base + i), distance: i })));
  });

  it('skips developer fields and unknown messages', () => {
    const w = fitFile()
      .define(5, 207, [[0, BT.byte, 16], [3, BT.uint8]]) // developer_data_id
      .data(5, { 3: 0 })
      .define(6, 206, [[0, BT.uint8], [1, BT.uint8], [2, BT.uint8], [3, BT.string, 16]]) // field_description
      .data(6, { 0: 0, 1: 0, 2: 2, 3: 'Form Power' })
      .define(1, MESG.record, [[253, BT.uint32], [5, BT.uint32], [3, BT.uint8]], { dev: [[0, 2, 0], [1, 4, 0]] });
    for (let i = 0; i < 3; i++) w.data(1, { 253: T0 + i, 5: i * 100, 3: 120 + i });
    const a = parseOne(withSession(w, T0, T0 + 2).build());
    expect(a.samples).toEqual(range(3).map((i) => ({ time: ms(T0 + i), distance: i, heartRate: 120 + i })));
  });

  it('skips fields whose size does not fit their base type', () => {
    // Seen in COROS files: a 3-byte uint16. Its bytes are skipped and later fields still line up.
    const w = fitFile()
      .define(1, MESG.record, [[253, BT.uint32], [6, BT.uint16, 3], [3, BT.uint8], [5, BT.uint32]])
      .data(1, { 253: T0, 6: 3000, 3: 150, 5: 1000 })
      .data(1, { 253: T0 + 1, 6: 3000, 3: 151, 5: 1300 });
    expect(parseOne(withSession(w, T0, T0 + 1).build()).samples).toEqual([
      { time: ms(T0), heartRate: 150, distance: 10 },
      { time: ms(T0 + 1), heartRate: 151, distance: 13 },
    ]);
  });

  it('reads the first element of array fields', () => {
    const w = fitFile()
      .define(1, MESG.record, [[253, BT.uint32], [3, BT.uint8, 4], [7, BT.uint16, 6]])
      .data(1, { 253: T0, 3: 150, 7: 250 })
      .data(1, { 253: T0 + 1, 3: 151, 7: 251 });
    const [first] = parseOne(withSession(w, T0, T0 + 1).build()).samples;
    expect(first).toEqual({ time: ms(T0), heartRate: 150, power: 250 });
  });

  it('keeps what was decoded before a truncated tail', () => {
    const full = activityWriter({ seconds: 10 }).build();
    // Cut inside the final activity message: records, lap and session are complete.
    const a = parseOne(full.subarray(0, full.length - 6));
    expect(a.samples).toHaveLength(10);
    expect(a.laps).toHaveLength(1);
    expect(a.totals).toMatchObject({ elapsedSec: 9, distance: 27 });
    expect(a.utcOffsetSec).toBeUndefined();

    // Cut 7 bytes into the sixth record: the activity is summarized from five samples.
    const fiveRecords = recordsWriter({ seconds: 5 }).build();
    const b = parseOne(full.subarray(0, fiveRecords.length - 2 + 7));
    expect(b.samples.map((s) => s.time)).toEqual(range(5).map((i) => ms(T0 + i)));
    expect(b).toMatchObject({ startTime: ms(T0), laps: [], totals: { elapsedSec: 4, distance: 12 } });
  });

  it('reads to the end when the header has no data size (crashed recording)', () => {
    expect(parseOne(activityWriter().build({ dataSize: 0 })).samples).toHaveLength(10);
  });

  it('decodes chained files', () => {
    const run = activityWriter({ start: T0, sport: 1 }).build();
    const ride = activityWriter({ start: T0 + 3600, seconds: 20, sport: 2 }).build();
    const activities = parseFit(concat(run, ride));
    expect(activities.map((a) => [a.type, a.startTime, a.samples.length, a.laps.length])).toEqual([
      ['Run', ms(T0), 10, 1],
      ['Ride', ms(T0 + 3600), 20, 1],
    ]);
  });

  it('skips non-activity parts of a chain and repeated copies of an activity', () => {
    const run = activityWriter().build();
    const expected = parseFit(run);
    expect(parseFit(concat(fitFile({ type: 2 }).build(), run))).toEqual(expected);
    expect(parseFit(concat(run, run))).toEqual(expected);
  });
});

describe('parseFit: records', () => {
  it('converts semicircles, scales and offsets to SI units', () => {
    const w = fitFile()
      .define(1, MESG.record, [...RECORD, [53, BT.uint8]])
      .data(1, { 253: T0, 0: 2 ** 29, 1: -(2 ** 30), 5: 123456, 2: 2600, 3: 150, 4: 85, 53: 64, 6: 3456, 7: 250 })
      .data(1, { 253: T0 + 1, 0: semi(45.5), 1: semi(-122.25), 2: 2000 });
    const [s, t] = parseOne(withSession(w, T0, T0 + 1).build()).samples;
    // 2^31 semicircles = 180°. Cadence keeps its 1/128 fraction, in device units (strides/min when running).
    expect(s).toEqual({
      time: ms(T0), lat: 45, lng: -90, distance: 1234.56, altitude: 20, heartRate: 150, cadence: 85.5, speed: 3.456,
      power: 250,
    });
    expect(t.lat).toBeCloseTo(45.5, 6);
    expect(t.lng).toBeCloseTo(-122.25, 6);
    expect(t.altitude).toBe(-100);
  });

  it('leaves invalid values out', () => {
    const w = fitFile()
      .define(1, MESG.record, RECORD)
      .data(1, { 253: T0, 5: 1000 }) // every other field holds its invalid marker
      .data(1, { 253: T0 + 1, 0: 0, 1: 0, 3: 0, 5: 1300 }); // 0,0 = no GPS fix; 0 bpm = no strap
    expect(parseOne(withSession(w, T0, T0 + 1).build()).samples).toEqual([
      { time: ms(T0), distance: 10 },
      { time: ms(T0 + 1), distance: 13 },
    ]);
  });

  it('treats 0 as invalid only for the z base types', () => {
    const w = fitFile()
      .define(1, MESG.record, [[253, BT.uint32], [4, BT.uint8z], [7, BT.uint16z]])
      .data(1, { 253: T0, 4: 0, 7: 0 })
      .define(2, MESG.record, [[253, BT.uint32], [4, BT.uint8], [7, BT.uint16]])
      .data(2, { 253: T0 + 1, 4: 0, 7: 0 });
    expect(parseOne(withSession(w, T0, T0 + 1).build()).samples).toEqual([
      { time: ms(T0) },
      { time: ms(T0 + 1), cadence: 0, power: 0 },
    ]);
  });

  it('prefers enhanced speed and altitude over the plain fields', () => {
    const w = fitFile()
      .define(1, MESG.record, [[253, BT.uint32], [6, BT.uint16], [73, BT.uint32], [2, BT.uint16], [78, BT.uint32]])
      .data(1, { 253: T0, 6: 3000, 73: 3500, 2: 2600, 78: 3000 })
      .data(1, { 253: T0 + 1, 6: 3000, 2: 2600 }); // enhanced fields invalid
    expect(parseOne(withSession(w, T0, T0 + 1).build()).samples).toEqual([
      { time: ms(T0), speed: 3.5, altitude: 100 },
      { time: ms(T0 + 1), speed: 3, altitude: 20 },
    ]);
  });

  it('sorts records into time order and merges records sharing a timestamp', () => {
    // Strava's app writes position and distance as two records per second.
    const w = fitFile()
      .define(1, MESG.record, RECORD)
      .data(1, { 253: T0 + 1, 5: 300 })
      .data(1, { 253: T0, 0: semi(10), 1: semi(20), 2: 2600 })
      .data(1, { 253: T0, 5: 0, 2: 9999 });
    const samples = parseOne(withSession(w, T0, T0 + 1).build()).samples;
    expect(samples.map((s) => [s.time, s.distance, s.altitude])).toEqual([
      [ms(T0), 0, 20],
      [ms(T0 + 1), 3, undefined],
    ]);
    expect(samples[0].lat).toBeCloseTo(10, 6);
  });
});

describe('parseFit: non-activity and broken files', () => {
  it('returns [] for non-activity FIT files, judged by file_id alone', () => {
    // settings, workout, course, weight, monitoring_a, monitoring_daily, monitoring_b
    for (const type of [2, 5, 6, 9, 15, 28, 32]) {
      const file = withSession(recordsWriter({ type }), T0, T0 + 9).build();
      expect(parseFit(file), `file type ${type}`).toEqual([]);
    }
  });

  it('returns [] for an activity file without data', () => {
    expect(parseFit(fitFile().build())).toEqual([]);
  });

  it('throws FileImportError for data that is not FIT', () => {
    expect(() => parseFit(new Uint8Array(0))).toThrow(FileImportError);
    expect(() => parseFit(new Uint8Array(64))).toThrow(FileImportError);
    expect(() => parseFit(new TextEncoder().encode('<?xml version="1.0"?><TrainingCenterDatabase/>'))).toThrow(
      FileImportError,
    );
  });

  it('throws FileImportError for a FIT header followed by garbage or nothing', () => {
    // 0x07 starts a data message of local type 7, which was never defined.
    expect(() => parseFit(new FitWriter().raw(0x07, 0x13, 0x37, 0x00, 0x42).build())).toThrow(FileImportError);
    expect(() => parseFit(new FitWriter().build())).toThrow(FileImportError);
    expect(() => parseFit(activityWriter().build().subarray(0, 14))).toThrow(FileImportError);
  });

  it('throws FileImportError when every time is relative to power-on (no real clock)', () => {
    expect(() => parseFit(activityWriter({ start: 5000 }).build())).toThrow(FileImportError);
  });
});

describe('parseFit: activity metadata', () => {
  it('derives utcOffsetSec from activity.local_timestamp, rounded to 15 minutes', () => {
    const offset = (utcOffset: number | null): number | undefined =>
      parseOne(activityWriter({ utcOffset }).build()).utcOffsetSec;
    expect(offset(7200)).toBe(7200);
    expect(offset(-5 * 3600 - 1)).toBe(-5 * 3600);
    expect(offset(5 * 3600 + 45 * 60)).toBe(20700); // Nepal
    expect(offset(-1)).toBe(0);
    expect(offset(20 * 3600)).toBeUndefined(); // implausible
    expect(offset(null)).toBeUndefined(); // no activity message
  });

  it('fills totals from the session, applying scales', () => {
    const w = recordsWriter()
      .define(3, MESG.session, [...SESSION, [124, BT.uint32], [125, BT.uint32]])
      .data(3, {
        253: T0 + 3600, 2: T0, 5: 1, 6: 0, 7: 3600500, 8: 3500000, 9: 1000050, 11: 700, 14: 2778, 15: 4500,
        124: 2857, 125: 5123, 16: 150, 17: 182, 18: 85, 20: 230, 22: 120, 34: 250, 35: 855,
      });
    expect(parseOne(w.build()).totals).toEqual({
      elapsedSec: 3600.5, movingSec: 3500, distance: 10000.5, calories: 700, avgSpeed: 2.857, maxSpeed: 5.123,
      avgHeartRate: 150, maxHeartRate: 182, avgCadence: 85, avgPower: 230, ascent: 120, normalizedPower: 250,
      trainingLoad: 85.5,
    });
  });

  it('drops averages and calories written as 0 because nothing measured them', () => {
    const w = recordsWriter()
      .define(3, MESG.session, SESSION)
      .data(3, { 253: T0 + 9, 2: T0, 5: 2, 7: 9000, 9: 2700, 11: 0, 16: 0, 17: 0, 18: 0, 20: 0, 34: 0 });
    expect(parseOne(w.build()).totals).toEqual({ elapsedSec: 9, distance: 27 });
  });

  it('derives a missing session start from its timestamp and elapsed time', () => {
    const w = recordsWriter().define(3, MESG.session, SESSION).data(3, { 253: T0 + 9, 5: 1, 7: 12000 });
    expect(parseOne(w.build()).startTime).toBe(ms(T0 - 3));
  });

  it('summarizes files without a session from their records, laps and sport', () => {
    const w = recordsWriter({ seconds: 10 })
      .define(5, MESG.sport, SPORT)
      .data(5, { 0: 2, 1: 6 }) // cycling / indoor_cycling
      .define(2, MESG.lap, LAP)
      .data(2, { 253: T0 + 4, 2: T0, 7: 4000, 8: 4000, 9: 1200, 16: 150, 21: 3 })
      .data(2, { 253: T0 + 9, 2: T0 + 5, 7: 4000, 8: 3000, 9: 1500, 16: 160, 21: 2 });
    expect(parseOne(w.build())).toMatchObject({
      type: 'Ride',
      trainer: true,
      startTime: ms(T0),
      totals: { elapsedSec: 9, movingSec: 7, distance: 27, ascent: 5, maxHeartRate: 160 },
    });
  });

  it('names the device and origin from file_id', () => {
    const identify = (opts: FileOptions): Pick<ParsedActivity, 'device' | 'origin'> => {
      const { device, origin } = parseOne(activityWriter(opts).build());
      return { device, origin };
    };
    expect(identify({ manufacturer: 1, product: 4315 })).toEqual({ device: 'Garmin Forerunner 965', origin: 'GARMIN' });
    expect(identify({ manufacturer: 1, product: 65534 })).toEqual({ device: 'Garmin', origin: 'GARMIN' });
    expect(identify({ manufacturer: 294, productName: 'PACE 3' })).toEqual({ device: 'COROS PACE 3', origin: 'COROS' });
    expect(identify({ manufacturer: 294, productName: 'COROS PACE 2' })).toEqual({ device: 'COROS PACE 2', origin: 'COROS' });
    expect(identify({ manufacturer: 23 })).toEqual({ device: 'Suunto', origin: 'SUUNTO' });
    expect(identify({ manufacturer: 32 })).toEqual({ device: 'Wahoo', origin: 'WAHOO' });
    expect(identify({ manufacturer: 123 })).toEqual({ device: 'Polar', origin: 'POLAR' });
    expect(identify({ manufacturer: 260 })).toEqual({ device: 'Zwift', origin: 'ZWIFT' });
    expect(identify({ manufacturer: 265 })).toEqual({ device: 'Strava', origin: 'STRAVA' });
    expect(identify({ manufacturer: 5555, productName: 'Trainer X' })).toEqual({ device: 'Trainer X' });
    expect(identify({ manufacturer: 5555 })).toEqual({});
  });

  it("takes the recording device's product name from device_info", () => {
    const w = activityWriter({ manufacturer: 32 })
      .define(5, MESG.deviceInfo, DEVICE_INFO)
      .data(5, { 253: T0, 0: 1, 2: 1, 4: 1, 27: 'HRM-Pro' }) // a sensor
      .data(5, { 253: T0, 0: 0, 2: 32, 4: 31, 27: 'ELEMNT BOLT' }); // the recording device
    expect(parseOne(w.build()).device).toBe('Wahoo ELEMNT BOLT');
  });
});

describe('parseFit: sport mapping', () => {
  /** [sport, sub_sport, Apollo type, trainer] with FIT profile enum values. */
  const CASES: Array<[sport: number, subSport: number, type: string, trainer?: true]> = [
    [1, 0, 'Run'], [1, 3, 'TrailRun'], [1, 1, 'Run', true], [1, 45, 'Run', true], [1, 58, 'VirtualRun', true],
    [2, 0, 'Ride'], [2, 58, 'VirtualRide', true], [2, 6, 'Ride', true], [2, 5, 'Ride', true],
    [2, 8, 'MountainBikeRide'], [2, 46, 'GravelRide'], [2, 13, 'TrackRide'], [2, 47, 'EMountainBikeRide'],
    [21, 0, 'EBikeRide'], [5, 17, 'Swim'], [5, 18, 'OpenWaterSwim'], [11, 0, 'Walk'], [17, 0, 'Hike'],
    [10, 20, 'WeightTraining'], [10, 43, 'Yoga'], [10, 44, 'Pilates'], [10, 0, 'Workout'],
    [4, 14, 'Rowing', true], [4, 15, 'Elliptical'], [4, 16, 'StairStepper'], [4, 20, 'WeightTraining'],
    [4, 0, 'Workout'], [15, 0, 'Rowing'], [12, 0, 'NordicSki'], [13, 0, 'AlpineSki'], [14, 0, 'Snowboard'],
    [19, 0, 'Kayaking'], [41, 0, 'Kayaking'], [37, 0, 'StandUpPaddling'], [31, 0, 'RockClimbing'],
    [30, 0, 'InlineSkate'], [33, 0, 'IceSkate'], [35, 0, 'Snowshoe'], [38, 0, 'Surfing'],
    [62, 0, 'HighIntensityIntervalTraining'], [0, 0, 'Workout'], [200, 0, 'Workout'],
  ];

  for (const [sport, subSport, type, trainer] of CASES) {
    it(`maps sport ${sport} / sub_sport ${subSport} to ${type}${trainer ? ' (trainer)' : ''}`, () => {
      const a = parseOne(activityWriter({ sport, subSport }).build());
      expect({ type: a.type, trainer: a.trainer }).toEqual({ type, trainer });
    });
  }

  it('falls back to the sport message when the session has no sport', () => {
    const w = recordsWriter()
      .define(5, MESG.sport, SPORT)
      .data(5, { 0: 1, 1: 3 }) // running / trail
      .define(3, MESG.session, SESSION)
      .data(3, { 253: T0 + 9, 2: T0, 7: 9000 });
    expect(parseOne(w.build()).type).toBe('TrailRun');
  });

  it('treats Zwift recordings as virtual', () => {
    expect(parseOne(activityWriter({ manufacturer: 260, sport: 2 }).build())).toMatchObject({
      type: 'VirtualRide',
      trainer: true,
      origin: 'ZWIFT',
    });
    expect(parseOne(activityWriter({ manufacturer: 260, sport: 1 }).build()).type).toBe('VirtualRun');
  });
});

describe('parseFit: laps', () => {
  it('maps lap fields, preferring enhanced speeds', () => {
    const w = recordsWriter()
      .define(2, MESG.lap, [...LAP, [110, BT.uint32], [111, BT.uint32]])
      .data(2, {
        253: T0 + 4, 2: T0, 7: 4500, 8: 4000, 9: 1234, 13: 2700, 14: 3100, 110: 2742, 111: 3200,
        15: 141, 16: 155, 17: 86, 21: 7,
      })
      .data(2, { 253: T0 + 9, 2: T0 + 5, 7: 4000, 9: 1500, 13: 3000 });
    expect(parseOne(withSession(w, T0, T0 + 9).build()).laps).toEqual([
      {
        startTime: ms(T0), elapsedSec: 4.5, movingSec: 4, distance: 12.34, avgSpeed: 2.742, maxSpeed: 3.2,
        avgHeartRate: 141, maxHeartRate: 155, avgCadence: 86, ascent: 7,
      },
      { startTime: ms(T0 + 5), elapsedSec: 4, distance: 15, avgSpeed: 3 },
    ]);
  });

  it('places laps without start_time by timestamp − elapsed and drops laps without times', () => {
    const w = recordsWriter()
      .define(2, MESG.lap, LAP)
      .data(2, { 253: T0 + 9, 7: 4000, 9: 1500 })
      .define(5, MESG.lap, [[9, BT.uint32]]) // distance only, as a Sigma device writes it
      .data(5, { 9: 100 });
    expect(parseOne(withSession(w, T0, T0 + 9).build()).laps).toEqual([
      { startTime: ms(T0 + 5), elapsedSec: 4, distance: 15 },
    ]);
  });
});

describe('parseFit: multisport', () => {
  /** Run 0–9 s, transition 10–14 s, ride 15–29 s; sessions are written at the end, as devices do. */
  function duathlon(runSessionStart: number = T0): Uint8Array {
    const w = fitFile().define(1, MESG.record, [[253, BT.uint32], [5, BT.uint32]]);
    for (let i = 0; i < 30; i++) w.data(1, { 253: T0 + i, 5: i * 100 });
    return w
      .define(2, MESG.lap, LAP)
      .data(2, { 253: T0 + 9, 2: T0, 7: 9000, 9: 900 })
      .data(2, { 253: T0 + 14, 2: T0 + 10, 7: 4000, 9: 400 })
      .data(2, { 253: T0 + 21, 2: T0 + 15, 7: 6000, 9: 600 })
      .data(2, { 253: T0 + 29, 2: T0 + 22, 7: 7000, 9: 700 })
      .define(3, MESG.session, SESSION)
      .data(3, { 253: T0 + 9, 2: runSessionStart, 5: 1, 7: 9000, 9: 900 })
      .data(3, { 253: T0 + 14, 2: T0 + 10, 5: 3, 7: 4000, 9: 400 })
      .data(3, { 253: T0 + 29, 2: T0 + 15, 5: 2, 7: 14000, 9: 1400 })
      .define(4, MESG.activity, ACTIVITY)
      .data(4, { 253: T0 + 29, 5: T0 + 29 + 3600 })
      .build();
  }

  it('yields one activity per leg with its own samples, laps and totals, dropping transitions', () => {
    const activities = parseFit(duathlon());
    expect(activities).toHaveLength(2);
    const [run, ride] = activities;
    expect(run).toMatchObject({ type: 'Run', startTime: ms(T0), utcOffsetSec: 3600, totals: { elapsedSec: 9, distance: 9 } });
    expect(run.samples.map((s) => s.time)).toEqual(range(10).map((i) => ms(T0 + i)));
    expect(run.laps.map((l) => l.startTime)).toEqual([ms(T0)]);
    expect(ride).toMatchObject({ type: 'Ride', startTime: ms(T0 + 15), utcOffsetSec: 3600, totals: { elapsedSec: 14, distance: 14 } });
    expect(ride.samples.map((s) => s.time)).toEqual(range(15).map((i) => ms(T0 + 15 + i)));
    expect(ride.laps.map((l) => l.startTime)).toEqual([ms(T0 + 15), ms(T0 + 22)]);
  });

  it('gives the first leg the data recorded before its start_time', () => {
    // A fenix 2 wrote its first leg's start_time long after the leg's first lap and record.
    const [run] = parseFit(duathlon(T0 + 5));
    expect(run.startTime).toBe(ms(T0));
    expect(run.samples).toHaveLength(10);
    expect(run.laps).toHaveLength(1);
  });
});

describe('parseFit: performance', () => {
  it('decodes a 2-hour 1 Hz recording quickly', () => {
    const n = 7200;
    const w = fitFile().define(1, MESG.record, RECORD);
    for (let i = 0; i < n; i++) {
      w.data(1, {
        253: T0 + i, 0: semi(47 + i * 1e-5), 1: semi(8 + i * 1e-5), 5: i * 300, 2: 2600 + (i % 50),
        3: 140 + (i % 20), 4: 85, 6: 3000, 7: 250,
      });
    }
    const file = withSession(w, T0, T0 + n - 1, { 9: (n - 1) * 300 }).build();
    const started = Date.now();
    const activities = parseFit(file);
    const elapsedMs = Date.now() - started;
    expect(activities).toHaveLength(1);
    const { samples } = activities[0];
    expect(samples).toHaveLength(n);
    expect(samples[n - 1]).toMatchObject({ time: ms(T0 + n - 1), distance: (n - 1) * 3, heartRate: 140 + ((n - 1) % 20) });
    expect(elapsedMs).toBeLessThan(500);
  });
});
