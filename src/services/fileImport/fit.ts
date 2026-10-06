/**
 * FIT activity-file decoder (Garmin, COROS, Suunto, Wahoo, Polar, Zwift…).
 *
 * Turns the binary Flexible and Interoperable Data Transfer format into
 * neutral `ParsedActivity` records — one per FIT `session` — for build.ts.
 * Self-contained: a single forward pass over a DataView using field offsets
 * precomputed per definition message, with no per-byte allocations, so Garmin
 * exports holding thousands of files stay fast.
 *
 * Only the messages Apollo needs are decoded (file_id, sport, session, lap,
 * record, device_info, activity); everything else is skipped by size.
 * Non-activity files (settings, monitoring, sleep, courses, workouts…) are
 * recognized from their leading file_id message and yield no activities.
 *
 * Devices are sloppy, so decoding is lenient: CRCs are not verified, a
 * truncated tail keeps everything decoded before it, header sizes 12 and 14
 * are both accepted, chained FIT files (several files back to back) are
 * decoded in sequence, and a file without a session message is summarized
 * from its records and laps.
 *
 * Field numbers, scales and enums follow the Garmin FIT SDK profile (21.x).
 */

import { FileImportError } from './types';
import type { ParsedActivity, ParsedLap, ParsedSample, ParsedTotals } from './types';

// ── Format constants ──────────────────────────────────────────────────────────

/** Seconds from the Unix epoch to the FIT epoch, 1989-12-31T00:00:00Z. */
const FIT_EPOCH_SEC = 631065600;
/** Positions are signed 32-bit semicircles: 2^31 semicircles = 180°. */
const DEG_PER_SEMICIRCLE = 180 / 2147483648;
/** Every file's data block is followed by a 2-byte CRC. */
const CRC_SIZE = 2;
/**
 * date_time values below 0x10000000 are seconds since the device powered on
 * (old watches without a clock fix), not UTC; such times can't be dated.
 */
const MIN_CLOCK_TIME_MS = (0x10000000 + FIT_EPOCH_SEC) * 1000;
/** `file_id.type` of activity files; no other file type holds workouts. */
const FILE_TYPE_ACTIVITY = 4;
/** `sport` of multisport transition sessions (T1/T2). */
const SPORT_TRANSITION = 3;
/** Plausible local-time offsets are within ±14 h, in 15-minute steps. */
const MAX_UTC_OFFSET_SEC = 14 * 3600;
const UTC_OFFSET_STEP_SEC = 15 * 60;
/**
 * A lap starting this close before the next session belongs to it (rounding);
 * kept small, as multisport transitions can last only a few seconds.
 */
const LAP_START_SLACK_MS = 1000;

/** Global message numbers (profile `mesg_num`) of the messages Apollo reads. */
const MESG_FILE_ID = 0;
const MESG_SPORT = 12;
const MESG_SESSION = 18;
const MESG_LAP = 19;
const MESG_RECORD = 20;
const MESG_DEVICE_INFO = 23;
const MESG_ACTIVITY = 34;

/** Field number of `timestamp` in every message that has one. */
const FIELD_TIMESTAMP = 253;

/** Byte size of each base type, indexed by base type number (low 5 bits). */
const BASE_TYPE_SIZE: readonly number[] = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];
const BASE_STRING = 7;
const BASE_BYTE = 13;

// ── Low-level reading ─────────────────────────────────────────────────────────

/** Where one field sits inside a data message. */
interface FieldLayout {
  /** Byte offset from the start of the message payload. */
  offset: number;
  size: number;
  /** Base type number (0–16). */
  type: number;
}

/** A local message definition, precomputed for fast data-message reads. */
interface MessageDef {
  global: number;
  littleEndian: boolean;
  /** Payload bytes of each data message, developer fields included. */
  size: number;
  /** Layouts indexed by field number (sparse); fields of unusable size are left out. */
  fields: Array<FieldLayout | undefined>;
}

/** True when a FIT file header starts at `pos`. */
function isFitAt(data: Uint8Array, pos: number): boolean {
  if (pos < 0 || pos + 12 > data.length) return false;
  const headerSize = data[pos];
  return (headerSize === 12 || headerSize === 14)
    && pos + headerSize <= data.length
    && data[pos + 8] === 0x2e   // '.'
    && data[pos + 9] === 0x46   // 'F'
    && data[pos + 10] === 0x49  // 'I'
    && data[pos + 11] === 0x54; // 'T'
}

/**
 * Parses the definition message whose content starts at `p` (after the record
 * header). Returns the definition and the position after it, or undefined when
 * it does not fit before `end`.
 */
function readDefinition(
  data: Uint8Array,
  p: number,
  end: number,
  hasDeveloperFields: boolean,
): { def: MessageDef; next: number } | undefined {
  if (p + 5 > end) return undefined;
  const littleEndian = data[p + 1] === 0;
  const global = littleEndian ? data[p + 2] | (data[p + 3] << 8) : (data[p + 2] << 8) | data[p + 3];
  const count = data[p + 4];
  let q = p + 5;
  if (q + count * 3 > end) return undefined;
  const fields: Array<FieldLayout | undefined> = [];
  let size = 0;
  for (let i = 0; i < count; i++, q += 3) {
    const fieldSize = data[q + 1];
    const type = data[q + 2] & 0x1f;
    const typeSize = BASE_TYPE_SIZE[type];
    // Sizes that are not a whole number of base-type values can't be decoded.
    if (typeSize !== undefined && fieldSize >= typeSize && fieldSize % typeSize === 0) {
      fields[data[q]] = { offset: size, size: fieldSize, type };
    }
    size += fieldSize;
  }
  if (hasDeveloperFields) {
    if (q >= end) return undefined;
    const devCount = data[q++];
    if (q + devCount * 3 > end) return undefined;
    // Developer fields are never read; only their bytes are skipped.
    for (let i = 0; i < devCount; i++, q += 3) size += data[q + 1];
  }
  return { def: { global, littleEndian, size, fields }, next: q };
}

/**
 * First value of a numeric field, or undefined when the field is absent,
 * holds its base type's invalid marker, or is not numeric (string, 64-bit).
 */
function readNumber(view: DataView, base: number, def: MessageDef, num: number): number | undefined {
  const f = def.fields[num];
  if (!f) return undefined;
  const p = base + f.offset;
  const le = def.littleEndian;
  let v: number;
  switch (f.type) {
    case 0: case 2: case BASE_BYTE: v = view.getUint8(p); return v === 0xff ? undefined : v;
    case 1: v = view.getInt8(p); return v === 0x7f ? undefined : v;
    case 3: v = view.getInt16(p, le); return v === 0x7fff ? undefined : v;
    case 4: v = view.getUint16(p, le); return v === 0xffff ? undefined : v;
    case 5: v = view.getInt32(p, le); return v === 0x7fffffff ? undefined : v;
    case 6: v = view.getUint32(p, le); return v === 0xffffffff ? undefined : v;
    case 8: v = view.getFloat32(p, le); return Number.isFinite(v) ? v : undefined;
    case 9: v = view.getFloat64(p, le); return Number.isFinite(v) ? v : undefined;
    case 10: v = view.getUint8(p); return v === 0 ? undefined : v;
    case 11: v = view.getUint16(p, le); return v === 0 ? undefined : v;
    case 12: v = view.getUint32(p, le); return v === 0 ? undefined : v;
    default: return undefined;
  }
}

let utf8: TextDecoder | undefined;

/** A NUL-terminated UTF-8 string field, trimmed; undefined when empty or absent. */
function readString(data: Uint8Array, base: number, def: MessageDef, num: number): string | undefined {
  const f = def.fields[num];
  if (!f || f.type !== BASE_STRING) return undefined;
  const start = base + f.offset;
  const limit = start + f.size;
  let end = start;
  while (end < limit && data[end] !== 0) end++;
  if (end === start) return undefined;
  utf8 ??= new TextDecoder('utf-8');
  const text = utf8.decode(data.subarray(start, end)).replace(/\uFFFD/g, '').trim();
  return text || undefined;
}

/** Applies a profile scale and offset: raw / scale − offset. */
function scaled(raw: number | undefined, scale: number, offset: number = 0): number | undefined {
  // (raw − offset·scale) / scale avoids float noise such as 513.4 − 500 = 13.39999….
  return raw === undefined ? undefined : (raw - offset * scale) / scale;
}

/** Integer cadence plus its 1/128 fractional part, when the device records one. */
function withFraction(whole: number | undefined, fraction128: number | undefined): number | undefined {
  return whole === undefined ? undefined : whole + (fraction128 ?? 0) / 128;
}

/** Integer meters plus a 1/100 fractional part, when the device records one. */
function withCentimeters(meters: number | undefined, cm: number | undefined): number | undefined {
  return meters === undefined ? undefined : meters + (cm ?? 0) / 100;
}

/** FIT date_time (seconds since the FIT epoch) → Unix ms. */
function fitTimeMs(fitSeconds: number): number {
  return (fitSeconds + FIT_EPOCH_SEC) * 1000;
}

/** Copy of `o` without its undefined properties. */
function defined<T extends object>(o: T): T {
  const out = {} as T;
  for (const key in o) {
    if (o[key] !== undefined) out[key] = o[key];
  }
  return out;
}

/**
 * Devices write 0 for averages they didn't measure (heart rate without a strap,
 * power without a meter, calories they don't compute): treat 0 as absent.
 */
function positive(v: number | undefined): number | undefined {
  return v !== undefined && v > 0 ? v : undefined;
}

// ── Message decoding ──────────────────────────────────────────────────────────

/** A session message. */
interface SessionInfo {
  /** Start, UTC ms. */
  start?: number;
  sport?: number;
  subSport?: number;
  totals: ParsedTotals;
}

/** A lap message. */
interface LapInfo {
  lap: ParsedLap;
  /** End, UTC ms. */
  end: number;
  calories?: number;
  sport?: number;
  subSport?: number;
}

/** Everything Apollo uses from a FIT file (all chained parts). */
interface FitContent {
  /** Data messages decoded, of any type. */
  messages: number;
  /** Decoding stopped early on a malformed or truncated record. */
  broken: boolean;
  /** A (chained) file's file_id named a non-activity type; its records were skipped. */
  nonActivity: boolean;
  manufacturer?: number;
  product?: number;
  productName?: string;
  /** product_name of the recording device (device_info with device_index 0). */
  creatorName?: string;
  /** Activity-profile sport (sport message), for sessions that lack one. */
  sport?: number;
  subSport?: number;
  /** Validated activity.local_timestamp − timestamp. */
  utcOffsetSec?: number;
  sessions: SessionInfo[];
  laps: LapInfo[];
  samples: ParsedSample[];
  /** Running total of the legacy compressed_speed_distance record field. */
  packedDistance?: { last: number; total: number };
}

/**
 * Legacy record field 8 (compressed_speed_distance, older Garmin devices):
 * 12-bit speed in 1/100 m/s and a 12-bit rolling distance in 1/16 m.
 * Fills whichever of speed / distance the record lacks.
 */
function readPackedSpeedDistance(data: Uint8Array, p: number, f: FieldLayout, c: FitContent, s: ParsedSample): void {
  if (f.size < 3) return;
  const q = p + f.offset;
  const b0 = data[q];
  const b1 = data[q + 1];
  const b2 = data[q + 2];
  if ((b0 & b1 & b2) === 0xff) return; // invalid
  const raw = (b1 >> 4) | (b2 << 4);
  const acc = c.packedDistance ?? (c.packedDistance = { last: raw, total: raw });
  acc.total += (raw - acc.last) & 0xfff; // rolls over every 256 m
  acc.last = raw;
  if (s.speed === undefined) s.speed = (b0 | ((b1 & 0x0f) << 8)) / 100;
  if (s.distance === undefined) s.distance = acc.total / 16;
}

/** record → one sample. Records without a time can't be placed and are dropped. */
function readRecord(data: Uint8Array, view: DataView, p: number, def: MessageDef, ts: number | undefined, c: FitContent): void {
  if (ts === undefined) return;
  const s: ParsedSample = { time: fitTimeMs(ts) };
  const lat = readNumber(view, p, def, 0);
  const lng = readNumber(view, p, def, 1);
  // 0,0 is a GPS-lock artifact, not a position.
  if (lat !== undefined && lng !== undefined && (lat !== 0 || lng !== 0)) {
    const latDeg = lat * DEG_PER_SEMICIRCLE;
    const lngDeg = lng * DEG_PER_SEMICIRCLE;
    if (Math.abs(latDeg) <= 90 && Math.abs(lngDeg) <= 180) {
      s.lat = latDeg;
      s.lng = lngDeg;
    }
  }
  const distance = readNumber(view, p, def, 5);
  if (distance !== undefined) s.distance = distance / 100;
  const altitude = readNumber(view, p, def, 78) ?? readNumber(view, p, def, 2);
  if (altitude !== undefined) s.altitude = (altitude - 2500) / 5;
  const heartRate = readNumber(view, p, def, 3);
  if (heartRate) s.heartRate = heartRate;
  const cadence = readNumber(view, p, def, 4);
  if (cadence !== undefined) s.cadence = withFraction(cadence, readNumber(view, p, def, 53));
  const speed = readNumber(view, p, def, 73) ?? readNumber(view, p, def, 6);
  if (speed !== undefined) s.speed = speed / 1000;
  const power = readNumber(view, p, def, 7);
  if (power !== undefined) s.power = power;
  const packed = def.fields[8];
  if (packed && (s.speed === undefined || s.distance === undefined)) readPackedSpeedDistance(data, p, packed, c, s);
  c.samples.push(s);
}

/** session → device totals and start time. */
function readSession(view: DataView, p: number, def: MessageDef, ts: number | undefined, c: FitContent): void {
  const n = (num: number): number | undefined => readNumber(view, p, def, num);
  const totals = defined<ParsedTotals>({
    elapsedSec: scaled(n(7), 1000),
    movingSec: scaled(n(8), 1000),
    distance: scaled(n(9), 100),
    ascent: withCentimeters(n(22), n(199)),
    calories: positive(n(11)),
    avgHeartRate: positive(n(16)),
    maxHeartRate: positive(n(17)),
    avgCadence: positive(withFraction(n(18), n(92))),
    avgSpeed: scaled(n(124) ?? n(14), 1000),
    maxSpeed: scaled(n(125) ?? n(15), 1000),
    avgPower: positive(n(20)),
    normalizedPower: positive(n(34)),
    trainingLoad: positive(scaled(n(35), 10)),
  });
  const startTime = n(2);
  let start = startTime === undefined ? undefined : fitTimeMs(startTime);
  // Without start_time, the session ends at its timestamp.
  if (start === undefined && ts !== undefined && totals.elapsedSec !== undefined) {
    start = fitTimeMs(ts) - totals.elapsedSec * 1000;
  }
  c.sessions.push({ start, sport: n(5), subSport: n(6), totals });
}

/** lap → a device lap. Laps that can't be placed in time are dropped. */
function readLap(view: DataView, p: number, def: MessageDef, ts: number | undefined, c: FitContent): void {
  const n = (num: number): number | undefined => readNumber(view, p, def, num);
  const elapsedSec = scaled(n(7), 1000);
  const startTime = n(2);
  const end = ts === undefined ? undefined : fitTimeMs(ts);
  let start = startTime === undefined ? undefined : fitTimeMs(startTime);
  if (start === undefined && end !== undefined && elapsedSec !== undefined) start = end - elapsedSec * 1000;
  if (start === undefined) return;
  const lap = defined<ParsedLap>({
    startTime: start,
    elapsedSec: elapsedSec ?? (end !== undefined ? Math.max(0, (end - start) / 1000) : 0),
    movingSec: scaled(n(8), 1000),
    distance: scaled(n(9), 100) ?? 0,
    avgSpeed: scaled(n(110) ?? n(13), 1000),
    maxSpeed: scaled(n(111) ?? n(14), 1000),
    avgHeartRate: positive(n(15)),
    maxHeartRate: positive(n(16)),
    avgCadence: positive(withFraction(n(17), n(80))),
    ascent: withCentimeters(n(21), n(156)),
  });
  c.laps.push({
    lap,
    end: end ?? start + lap.elapsedSec * 1000,
    calories: n(11),
    sport: n(25),
    subSport: n(39),
  });
}

/** activity → the athlete's UTC offset (local_timestamp − timestamp), if plausible. */
function readActivity(view: DataView, p: number, def: MessageDef, ts: number | undefined, c: FitContent): void {
  const local = readNumber(view, p, def, 5);
  if (ts === undefined || local === undefined) return;
  const offset = Math.round((local - ts) / UTC_OFFSET_STEP_SEC) * UTC_OFFSET_STEP_SEC;
  if (Math.abs(offset) <= MAX_UTC_OFFSET_SEC) c.utcOffsetSec = offset === 0 ? 0 : offset; // never −0
}

/** device_info of the recording device (device_index 0; other indexes are sensors). */
function readDeviceInfo(data: Uint8Array, view: DataView, p: number, def: MessageDef, c: FitContent): void {
  if (readNumber(view, p, def, 0) !== 0) return;
  c.creatorName ??= readString(data, p, def, 27);
  c.manufacturer ??= readNumber(view, p, def, 2);
  c.product ??= readNumber(view, p, def, 4);
}

/** file_id → device identity. Returns false when this is not an activity file. */
function readFileId(data: Uint8Array, view: DataView, p: number, def: MessageDef, c: FitContent): boolean {
  const type = readNumber(view, p, def, 0);
  if (type !== undefined && type !== FILE_TYPE_ACTIVITY) return false;
  c.manufacturer ??= readNumber(view, p, def, 1);
  c.product ??= readNumber(view, p, def, 2);
  c.productName ??= readString(data, p, def, 8);
  return true;
}

/** sport → the activity profile's sport (first one wins). */
function readSport(view: DataView, p: number, def: MessageDef, c: FitContent): void {
  if (c.sport !== undefined) return;
  c.sport = readNumber(view, p, def, 0);
  c.subSport = readNumber(view, p, def, 1);
}

type StreamEnd = 'end' | 'skip' | 'broken';

/**
 * Decodes the records of one FIT file, from `start` to `end`, into `c`.
 * Returns 'skip' as soon as file_id shows a non-activity file, and 'broken'
 * on a malformed or truncated record (everything before it is kept).
 */
function decodeRecords(data: Uint8Array, view: DataView, start: number, end: number, c: FitContent): StreamEnd {
  const defs: Array<MessageDef | undefined> = [];
  let lastTs = -1;
  let p = start;
  while (p < end) {
    const header = data[p++];
    if ((header & 0xc0) === 0x40) {
      const parsed = readDefinition(data, p, end, (header & 0x20) !== 0);
      if (!parsed) return 'broken';
      defs[header & 0x0f] = parsed.def;
      p = parsed.next;
      continue;
    }
    const compressed = (header & 0x80) !== 0;
    const def = defs[compressed ? (header >> 5) & 0x03 : header & 0x0f];
    if (!def || p + def.size > end) return 'broken';
    let ts = readNumber(view, p, def, FIELD_TIMESTAMP);
    if (ts === undefined && compressed && lastTs >= 0) {
      // 5-bit offset from the last full timestamp, rolling over every 32 s.
      const offset = header & 0x1f;
      const previous = lastTs & 0x1f;
      ts = lastTs - previous + offset + (offset < previous ? 0x20 : 0);
    }
    if (ts !== undefined) lastTs = ts;
    c.messages++;
    switch (def.global) {
      case MESG_RECORD: readRecord(data, view, p, def, ts, c); break;
      case MESG_FILE_ID: if (!readFileId(data, view, p, def, c)) return 'skip'; break;
      case MESG_LAP: readLap(view, p, def, ts, c); break;
      case MESG_SESSION: readSession(view, p, def, ts, c); break;
      case MESG_ACTIVITY: readActivity(view, p, def, ts, c); break;
      case MESG_DEVICE_INFO: readDeviceInfo(data, view, p, def, c); break;
      case MESG_SPORT: readSport(view, p, def, c); break;
      default: break;
    }
    p += def.size;
  }
  return 'end';
}

/** Decodes every chained FIT file in `data` (the caller has checked the first header). */
function decodeFit(data: Uint8Array): FitContent {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const c: FitContent = { messages: 0, broken: false, nonActivity: false, sessions: [], laps: [], samples: [] };
  let pos = 0;
  while (isFitAt(data, pos)) {
    const start = pos + data[pos];
    const dataSize = view.getUint32(pos + 4, true);
    let end = start + dataSize;
    // A device that crashed mid-recording may leave the size unset (0) or past
    // the end of the file: read whatever is there. Nothing can be chained after.
    const sizeKnown = dataSize > 0 && end <= data.length;
    if (!sizeKnown) end = data.length - start > CRC_SIZE ? data.length : start;
    const result = decodeRecords(data, view, start, end, c);
    if (result === 'skip') c.nonActivity = true;
    if (result === 'broken') {
      c.broken = true;
      break;
    }
    if (!sizeKnown) break;
    pos = end + CRC_SIZE;
  }
  return c;
}

// ── Sports & devices ──────────────────────────────────────────────────────────

/** Apollo sport type of a session, and whether it was recorded indoors. */
interface SportInfo {
  type: string;
  trainer?: boolean;
}

/** Looks up an optional key in a sparse table. */
function lookup<T>(table: Readonly<Record<number, T | undefined>>, key: number | undefined): T | undefined {
  return key === undefined ? undefined : table[key];
}

/** Types by FIT `sport` for sports whose sub_sport doesn't change the type. */
const SPORT_TYPES: Readonly<Record<number, string | undefined>> = {
  7: 'Soccer', 8: 'Tennis', 12: 'NordicSki', 14: 'Snowboard', 16: 'Hike' /* mountaineering */,
  17: 'Hike', 19: 'Kayaking' /* paddling */, 25: 'Golf', 30: 'InlineSkate', 31: 'RockClimbing',
  32: 'Sail', 33: 'IceSkate', 35: 'Snowshoe', 37: 'StandUpPaddling', 38: 'Surfing',
  41: 'Kayaking', 43: 'Windsurf', 44: 'Kitesurf', 62: 'HighIntensityIntervalTraining',
  65: 'Wheelchair', 66: 'Wheelchair', 88: 'Canoeing',
};

/** Types by sub_sport for sport = training (10). */
const TRAINING_TYPES: Readonly<Record<number, string | undefined>> = {
  20: 'WeightTraining', 43: 'Yoga', 44: 'Pilates', 70: 'HighIntensityIntervalTraining',
};

/** Types by sub_sport for sport = fitness_equipment (4). */
const EQUIPMENT_TYPES: Readonly<Record<number, SportInfo | undefined>> = {
  1: { type: 'Run', trainer: true },      // treadmill
  45: { type: 'Run', trainer: true },     // indoor_running
  5: { type: 'Ride', trainer: true },     // spin
  6: { type: 'Ride', trainer: true },     // indoor_cycling
  14: { type: 'Rowing', trainer: true },  // indoor_rowing
  15: { type: 'Elliptical' },
  16: { type: 'StairStepper' },           // stair_climbing
  20: { type: 'WeightTraining' },         // strength_training
};

/** Types by sub_sport for sport = cycling (2); anything else is a Ride. */
const CYCLING_TYPES: Readonly<Record<number, SportInfo | undefined>> = {
  5: { type: 'Ride', trainer: true },     // spin
  6: { type: 'Ride', trainer: true },     // indoor_cycling
  8: { type: 'MountainBikeRide' },        // mountain
  9: { type: 'MountainBikeRide' },        // downhill
  12: { type: 'Handcycle' },              // hand_cycling
  13: { type: 'TrackRide' },              // track_cycling
  28: { type: 'EBikeRide' },              // e_bike_fitness
  46: { type: 'GravelRide' },             // gravel_cycling
  47: { type: 'EMountainBikeRide' },      // e_bike_mountain
  88: { type: 'Handcycle', trainer: true }, // indoor_hand_cycling
  127: { type: 'EMountainBikeRide' },     // e_bike_enduro
};

/** sub_sport values. */
const SUB_TREADMILL = 1;
const SUB_TRAIL = 3;
const SUB_INDOOR_ROWING = 14;
const SUB_OPEN_WATER = 18;
const SUB_INDOOR_WALKING = 27;
const SUB_BACKCOUNTRY = 37;
const SUB_INDOOR_RUNNING = 45;
const SUB_E_BIKE_MOUNTAIN = 47;
const SUB_VIRTUAL = 58;
const SUB_E_BIKE_ENDURO = 127;

/** Manufacturers that only record virtual (indoor) rides and runs: Zwift, MyWhoosh. */
const VIRTUAL_PLATFORMS: ReadonlySet<number> = new Set([144, 260, 331]);

/** Strava-style type for a FIT sport / sub_sport pair (FIT profile enums). */
function sportInfo(sport: number | undefined, sub: number | undefined, manufacturer: number | undefined): SportInfo {
  const virtual = sub === SUB_VIRTUAL || (manufacturer !== undefined && VIRTUAL_PLATFORMS.has(manufacturer));
  switch (sport) {
    case 1: // running
      if (virtual) return { type: 'VirtualRun', trainer: true };
      if (sub === SUB_TREADMILL || sub === SUB_INDOOR_RUNNING) return { type: 'Run', trainer: true };
      return { type: sub === SUB_TRAIL ? 'TrailRun' : 'Run' };
    case 2: // cycling
      if (virtual) return { type: 'VirtualRide', trainer: true };
      return lookup(CYCLING_TYPES, sub) ?? { type: 'Ride' };
    case 21: // e_biking
      return { type: sub === SUB_E_BIKE_MOUNTAIN || sub === SUB_E_BIKE_ENDURO ? 'EMountainBikeRide' : 'EBikeRide' };
    case 5: // swimming
      return { type: sub === SUB_OPEN_WATER ? 'OpenWaterSwim' : 'Swim' };
    case 11: // walking
      return sub === SUB_INDOOR_WALKING ? { type: 'Walk', trainer: true } : { type: 'Walk' };
    case 10: // training
      return { type: lookup(TRAINING_TYPES, sub) ?? 'Workout' };
    case 4: // fitness_equipment
      return lookup(EQUIPMENT_TYPES, sub) ?? { type: 'Workout' };
    case 15: // rowing
      return sub === SUB_INDOOR_ROWING ? { type: 'Rowing', trainer: true } : { type: 'Rowing' };
    case 13: // alpine_skiing
      return { type: sub === SUB_BACKCOUNTRY ? 'BackcountrySki' : 'AlpineSki' };
    default:
      return { type: lookup(SPORT_TYPES, sport) ?? 'Workout' };
  }
}

/** Upstream origin and display label by FIT manufacturer id. */
interface Brand {
  origin: string;
  label: string;
}

const BRANDS: Readonly<Record<number, Brand | undefined>> = {
  1: { origin: 'GARMIN', label: 'Garmin' },
  2: { origin: 'GARMIN', label: 'Garmin' },      // garmin_fr405_antfs
  23: { origin: 'SUUNTO', label: 'Suunto' },
  32: { origin: 'WAHOO', label: 'Wahoo' },
  40: { origin: 'CONCEPT2', label: 'Concept2' },
  70: { origin: 'SIGMA', label: 'Sigma' },
  71: { origin: 'TOMTOM', label: 'TomTom' },
  89: { origin: 'TACX', label: 'Tacx' },
  95: { origin: 'STRYD', label: 'Stryd' },
  123: { origin: 'POLAR', label: 'Polar' },
  129: { origin: 'COROS', label: 'COROS' },      // coros_byte
  144: { origin: 'ZWIFT', label: 'Zwift' },      // zwift_byte
  260: { origin: 'ZWIFT', label: 'Zwift' },
  265: { origin: 'STRAVA', label: 'Strava' },
  267: { origin: 'BRYTON', label: 'Bryton' },
  281: { origin: 'TRAINERROAD', label: 'TrainerRoad' },
  289: { origin: 'HAMMERHEAD', label: 'Hammerhead' },
  294: { origin: 'COROS', label: 'COROS' },
  331: { origin: 'MYWHOOSH', label: 'MyWhoosh' },
  340: { origin: 'PELOTON', label: 'Peloton' },
  348: { origin: 'HUAWEI', label: 'Huawei' },
};

/** Garmin devices write a product id rather than a name: common models by `garmin_product`. */
const GARMIN_PRODUCTS: Readonly<Record<number, string | undefined>> = {
  // Forerunner
  717: 'Forerunner 405', 782: 'Forerunner 50', 988: 'Forerunner 60', 1018: 'Forerunner 310XT',
  1124: 'Forerunner 110', 1328: 'Forerunner 910XT', 1345: 'Forerunner 610', 1436: 'Forerunner 70',
  1482: 'Forerunner 10', 1623: 'Forerunner 620', 1632: 'Forerunner 220', 1765: 'Forerunner 920XT',
  1903: 'Forerunner 15', 2148: 'Forerunner 25', 2153: 'Forerunner 225', 2156: 'Forerunner 630',
  2157: 'Forerunner 230', 2158: 'Forerunner 735XT', 2431: 'Forerunner 235', 2503: 'Forerunner 35',
  2691: 'Forerunner 935', 2886: 'Forerunner 645', 2888: 'Forerunner 645 Music', 2891: 'Forerunner 30',
  3076: 'Forerunner 245', 3077: 'Forerunner 245 Music', 3113: 'Forerunner 945', 3282: 'Forerunner 45',
  3589: 'Forerunner 745', 3652: 'Forerunner 945 LTE', 3869: 'Forerunner 55', 3990: 'Forerunner 255 Music',
  3991: 'Forerunner 255S Music', 3992: 'Forerunner 255', 3993: 'Forerunner 255S', 4024: 'Forerunner 955',
  4257: 'Forerunner 265', 4258: 'Forerunner 265S', 4315: 'Forerunner 965', 4432: 'Forerunner 165',
  4433: 'Forerunner 165 Music', 4565: 'Forerunner 970', 4570: 'Forerunner 570', 4574: 'Forerunner 570',
  4814: 'Forerunner 170 Music', 4815: 'Forerunner 170',
  // fēnix, epix, Enduro
  1551: 'Fenix', 1967: 'Fenix 2', 2050: 'Fenix 3', 2413: 'Fenix 3 HR', 2432: 'Fenix Chronos',
  2544: 'Fenix 5S', 2604: 'Fenix 5X', 2697: 'Fenix 5', 2900: 'Fenix 5S Plus', 3110: 'Fenix 5 Plus',
  3111: 'Fenix 5X Plus', 3287: 'Fenix 6S', 3288: 'Fenix 6S', 3289: 'Fenix 6', 3290: 'Fenix 6',
  3291: 'Fenix 6X', 3905: 'Fenix 7S', 3906: 'Fenix 7', 3907: 'Fenix 7X', 4374: 'Fenix 7S Pro',
  4375: 'Fenix 7 Pro', 4376: 'Fenix 7X Pro', 4595: 'Fenix 7 Pro', 4532: 'Fenix 8', 4533: 'Fenix 8',
  4534: 'Fenix 8', 4536: 'Fenix 8', 4631: 'Fenix 8 Pro', 4666: 'Fenix E', 1988: 'Epix',
  3943: 'Epix Gen 2', 4312: 'Epix Pro', 4313: 'Epix Pro', 4314: 'Epix Pro', 3638: 'Enduro',
  4341: 'Enduro 2', 4575: 'Enduro 3',
  // Instinct, Venu, vívoactive
  3466: 'Instinct Solar', 3888: 'Instinct 2', 3889: 'Instinct 2S', 4155: 'Instinct Crossover',
  4394: 'Instinct 2X', 4583: 'Instinct E', 4584: 'Instinct E', 4585: 'Instinct 3', 4586: 'Instinct 3',
  4587: 'Instinct 3', 4759: 'Instinct 3', 3226: 'Venu', 3703: 'Venu 2', 3704: 'Venu 2S',
  3851: 'Venu 2 Plus', 4260: 'Venu 3', 4261: 'Venu 3S', 4603: 'Venu X1', 4643: 'Venu 4', 4644: 'Venu 4S',
  3600: 'Venu Sq', 3596: 'Venu Sq Music', 4115: 'Venu Sq 2', 4116: 'Venu Sq 2 Music',
  1907: 'Vivoactive', 2337: 'Vivoactive HR', 2700: 'Vivoactive 3', 2988: 'Vivoactive 3 Music',
  3066: 'Vivoactive 3 Music', 3224: 'Vivoactive 4S', 3225: 'Vivoactive 4', 4426: 'Vivoactive 5',
  4625: 'Vivoactive 6',
  // Edge
  1036: 'Edge 500', 1169: 'Edge 800', 1325: 'Edge 200', 1561: 'Edge 510', 1567: 'Edge 810',
  1836: 'Edge 1000', 2067: 'Edge 520', 2530: 'Edge 820', 2713: 'Edge 1030', 2909: 'Edge 130',
  3011: 'Edge Explore', 3112: 'Edge 520 Plus', 3121: 'Edge 530', 3122: 'Edge 830', 3558: 'Edge 130 Plus',
  3570: 'Edge 1030 Plus', 3843: 'Edge 1040', 4061: 'Edge 540', 4062: 'Edge 840', 4169: 'Edge Explore 2',
  4440: 'Edge 1050', 4633: 'Edge 550', 4634: 'Edge 850', 4655: 'Edge MTB',
};

/** Recording device, e.g. "Garmin Forerunner 965", "COROS PACE 3", or just the brand. */
function deviceName(c: FitContent, brand: Brand | undefined): string | undefined {
  const garminModel = c.manufacturer === 1 ? lookup(GARMIN_PRODUCTS, c.product) : undefined;
  const model = c.productName ?? c.creatorName ?? garminModel;
  if (!model) return brand?.label;
  if (!brand || model.toLowerCase().startsWith(brand.label.toLowerCase())) return model;
  return `${brand.label} ${model}`;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

/** False for device-relative times (see MIN_CLOCK_TIME_MS), which can't be dated. */
function isClockTime(ms: number): boolean {
  return ms >= MIN_CLOCK_TIME_MS;
}

/** Sample channels, merged when several records share one timestamp. */
const SAMPLE_CHANNELS = ['lat', 'lng', 'distance', 'altitude', 'heartRate', 'cadence', 'speed', 'power'] as const;

/**
 * Datable samples in time order, one per timestamp. Some apps (Strava's) split
 * an instant over two records, devices occasionally repeat a timestamp, and
 * chained copies of a file repeat every record: such records are merged, the
 * first value of each channel winning.
 */
function timeline(samples: ParsedSample[]): ParsedSample[] {
  let sorted = samples;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].time < samples[i - 1].time) {
      sorted = samples.slice().sort((a, b) => a.time - b.time); // stable: ties keep file order
      break;
    }
  }
  const out: ParsedSample[] = [];
  let last: ParsedSample | undefined;
  for (const s of sorted) {
    if (!isClockTime(s.time)) continue;
    if (last !== undefined && last.time === s.time) {
      for (const key of SAMPLE_CHANNELS) {
        if (last[key] === undefined && s[key] !== undefined) last[key] = s[key];
      }
    } else {
      out.push(s);
      last = s;
    }
  }
  return out;
}

/** The same lap written twice (chained copies of one file). */
function sameLap(a: LapInfo, b: LapInfo): boolean {
  return a.lap.startTime === b.lap.startTime && a.end === b.end && a.lap.distance === b.lap.distance;
}

/** Datable laps by start time, without repeats. */
function lapTimeline(laps: LapInfo[]): LapInfo[] {
  const sorted = laps
    .filter((l) => isClockTime(l.lap.startTime))
    .sort((a, b) => a.lap.startTime - b.lap.startTime);
  return sorted.filter((l, i) => i === 0 || !sameLap(sorted[i - 1], l));
}

/** Total of a lap value, when every lap records it. */
function sumOf(laps: LapInfo[], pick: (l: LapInfo) => number | undefined): number | undefined {
  if (laps.length === 0) return undefined;
  let total = 0;
  for (const l of laps) {
    const v = pick(l);
    if (v === undefined) return undefined;
    total += v;
  }
  return total;
}

/** Maximum of a lap value over the laps that record it. */
function maxOf(laps: LapInfo[], pick: (l: LapInfo) => number | undefined): number | undefined {
  let best: number | undefined;
  for (const l of laps) {
    const v = pick(l);
    if (v !== undefined && (best === undefined || v > best)) best = v;
  }
  return best;
}

/**
 * Stand-in session for files that have records or laps but no session message
 * (old or crashed recordings). Its sport comes from the laps or the file's
 * sport message, like any session that lacks one.
 */
function synthesizeSession(samples: ParsedSample[], laps: LapInfo[]): SessionInfo | undefined {
  let start = samples.length > 0 ? samples[0].time : Infinity;
  let end = samples.length > 0 ? samples[samples.length - 1].time : -Infinity;
  for (const l of laps) {
    start = Math.min(start, l.lap.startTime);
    end = Math.max(end, l.end);
  }
  if (!(end > start)) return undefined; // no data, or a single instant
  let lastDistance: number | undefined;
  for (let i = samples.length - 1; i >= 0 && lastDistance === undefined; i--) lastDistance = samples[i].distance;
  return {
    start,
    totals: defined<ParsedTotals>({
      elapsedSec: (end - start) / 1000,
      movingSec: sumOf(laps, (l) => l.lap.movingSec),
      distance: lastDistance ?? sumOf(laps, (l) => l.lap.distance),
      ascent: sumOf(laps, (l) => l.lap.ascent),
      calories: sumOf(laps, (l) => l.calories),
      maxHeartRate: maxOf(laps, (l) => l.lap.maxHeartRate),
      maxSpeed: maxOf(laps, (l) => l.lap.maxSpeed),
    }),
  };
}

/** The same session written twice (chained copies of one file). */
function sameSession(a: SessionInfo, b: SessionInfo): boolean {
  return a.start === b.start && a.sport === b.sport && a.subSport === b.subSport
    && a.totals.elapsedSec === b.totals.elapsedSec && a.totals.distance === b.totals.distance;
}

/** A session with a definite, datable start (UTC ms). */
interface PlacedSession {
  info: SessionInfo;
  start: number;
}

/**
 * Sessions that can be placed in time, by start, without repeats. A lone
 * session without start_time begins with the data (`dataStart`).
 */
function placeSessions(sessions: SessionInfo[], dataStart: number | undefined): PlacedSession[] {
  const placed: PlacedSession[] = [];
  for (const info of sessions) {
    const start = info.start ?? (sessions.length === 1 ? dataStart : undefined);
    if (start === undefined || !isClockTime(start)) continue;
    if (placed.some((p) => sameSession(p.info, info))) continue;
    placed.push({ info, start });
  }
  return placed.sort((a, b) => a.start - b.start);
}

/** Sport and sub_sport, as FIT enums. */
interface FitSport {
  sport?: number;
  subSport?: number;
}

/** A session's sport; its laps, then (single-session files) the sport message, fill gaps. */
function resolveSport(info: SessionInfo, laps: LapInfo[], c: FitContent, single: boolean): FitSport {
  const sources: FitSport[] = [info, ...laps];
  if (single) sources.push(c);
  const sport = sources.find((s) => s.sport !== undefined)?.sport;
  const subSport = sources.find((s) => s.sport === sport && s.subSport !== undefined)?.subSport;
  return { sport, subSport };
}

/** Fields shared by every activity of a file. */
type FileFields = Pick<ParsedActivity, 'utcOffsetSec' | 'device' | 'origin'>;

/** The file's UTC offset, recording device and upstream origin (absent when unknown). */
function fileFields(c: FitContent): FileFields {
  const brand = lookup(BRANDS, c.manufacturer);
  return defined<FileFields>({ utcOffsetSec: c.utcOffsetSec, device: deviceName(c, brand), origin: brand?.origin });
}

/** One session with its own samples and laps as a ParsedActivity. */
function sessionActivity(
  c: FitContent,
  session: PlacedSession,
  samples: ParsedSample[],
  laps: LapInfo[],
  single: boolean,
  shared: FileFields,
): ParsedActivity {
  const { sport, subSport } = resolveSport(session.info, laps, c, single);
  const { type, trainer } = sportInfo(sport, subSport, c.manufacturer);
  // Some devices write a start_time later than the leg's first lap or record.
  const startTime = Math.min(
    session.start,
    laps.length > 0 ? laps[0].lap.startTime : Infinity,
    samples.length > 0 ? samples[0].time : Infinity,
  );
  const activity: ParsedActivity = {
    type,
    startTime,
    samples,
    laps: laps.map((l) => l.lap),
    totals: session.info.totals,
    ...shared,
  };
  if (trainer) activity.trainer = true;
  return activity;
}

/** A session holding nothing — no samples, laps, time or distance (a false start). */
function isEmptySession(info: SessionInfo, samples: ParsedSample[], laps: LapInfo[]): boolean {
  return samples.length === 0 && laps.length === 0
    && (info.totals.elapsedSec ?? 0) <= 0 && (info.totals.distance ?? 0) <= 0;
}

/** True when the file holds data stamped with device-relative times. */
function hasRelativeTimes(c: FitContent): boolean {
  return c.sessions.some((s) => s.start !== undefined && !isClockTime(s.start))
    || c.laps.some((l) => !isClockTime(l.lap.startTime))
    || c.samples.some((s) => !isClockTime(s.time));
}

/**
 * One ParsedActivity per session. Sessions split the file's timeline at their
 * starts: each owns the samples and laps up to the next session's start, and
 * the first also owns anything recorded before it (some devices write a
 * start_time later than the leg's first lap). Multisport transitions take
 * their slice but are not workouts.
 */
function buildActivities(c: FitContent): ParsedActivity[] {
  const samples = timeline(c.samples);
  const laps = lapTimeline(c.laps);
  let sessions = c.sessions;
  if (sessions.length === 0) {
    const synthetic = synthesizeSession(samples, laps);
    if (synthetic) sessions = [synthetic];
  }
  const dataStart = Math.min(
    samples.length > 0 ? samples[0].time : Infinity,
    laps.length > 0 ? laps[0].lap.startTime : Infinity,
  );
  const placed = placeSessions(sessions, Number.isFinite(dataStart) ? dataStart : undefined);
  const onlyTransitions = placed.every((p) => p.info.sport === SPORT_TRANSITION);
  const shared = fileFields(c);
  const activities: ParsedActivity[] = [];
  let nextSample = 0;
  let nextLap = 0;
  placed.forEach((session, i) => {
    const until = i + 1 < placed.length ? placed[i + 1].start : Infinity;
    const firstSample = nextSample;
    while (nextSample < samples.length && samples[nextSample].time < until) nextSample++;
    const firstLap = nextLap;
    while (nextLap < laps.length && laps[nextLap].lap.startTime < until - LAP_START_SLACK_MS) nextLap++;
    if (session.info.sport === SPORT_TRANSITION && !onlyTransitions) return;
    const own = samples.slice(firstSample, nextSample);
    const ownLaps = laps.slice(firstLap, nextLap);
    if (isEmptySession(session.info, own, ownLaps)) return;
    activities.push(sessionActivity(c, session, own, ownLaps, placed.length === 1, shared));
  });
  if (activities.length === 0 && hasRelativeTimes(c)) {
    throw new FileImportError('FIT file has no real date or time (recorded by a device without a clock)');
  }
  return activities;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** True when `data` starts with a FIT file header (size 12 or 14, ".FIT" signature). */
export function isFitFile(data: Uint8Array): boolean {
  return isFitAt(data, 0);
}

/**
 * Decodes a FIT file into one `ParsedActivity` per session: a multisport file
 * yields one per leg (transitions are dropped), each with the samples and laps
 * of its time range. Returns [] for non-activity FIT files (settings,
 * monitoring, sleep, courses, workouts…) and for activity files without data.
 *
 * Values are kept as the device recorded them: running cadence is in strides
 * per minute, and samples may lack distance, position or any other channel.
 * Records sharing a timestamp are merged into one sample.
 *
 * @throws FileImportError when `data` is not a FIT file, is corrupt before any
 *   activity data, or holds only device-relative times that can't be dated.
 */
export function parseFit(data: Uint8Array): ParsedActivity[] {
  if (!isFitFile(data)) throw new FileImportError('Not a FIT file');
  const content = decodeFit(data);
  const hasData = content.sessions.length > 0 || content.laps.length > 0 || content.samples.length > 0;
  if (!hasData && !content.nonActivity && (content.broken || content.messages === 0)) {
    throw new FileImportError('Corrupt FIT file: no readable activity data');
  }
  return buildActivities(content);
}
