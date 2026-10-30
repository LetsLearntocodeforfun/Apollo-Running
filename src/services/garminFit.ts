/**
 * Garmin Connect original-file decoding (v1.0.8, DS-01).
 *
 * `GET /download-service/files/activity/{id}` returns a ZIP holding the file
 * the device uploaded: almost always a FIT, or a GPX / TCX for activities
 * imported into Garmin Connect from elsewhere. It is decoded with the same
 * parsers and builder as file imports, so laps, splits, the route and measured
 * heart-rate zones come out exactly as for an imported FIT.
 *
 * Loaded lazily (dynamic import from garmin.ts) so the FIT parser and ZIP
 * reader stay out of the first-screen bundle (scripts/check-bundle.mjs).
 */

import type { Activity } from './activity/types';
import { isRunActivity } from './activity/sports';
import { bestEffortsFromSamples } from './bestEfforts';
import { ZipArchive, bytesSource, isZip } from './fileImport/archive';
import { toActivity } from './fileImport/build';
import { isFitFile, parseFit } from './fileImport/fit';
import { parseGpx } from './fileImport/gpx';
import { gunzip, isGzip } from './fileImport/inflate';
import { parseTcx } from './fileImport/tcx';
import type { ParsedActivity } from './fileImport/types';
import { decodeXmlBytes } from './fileImport/xml';

/** Largest decompressed activity file accepted (ultra-distance FITs are ~20 MB). */
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const ACTIVITY_ENTRY = /\.(?:fit|gpx|tcx)(?:\.gz)?$/i;
const MAC_METADATA_ENTRY = /(?:^|\/)(?:__MACOSX\/|\._)/;
const GPX_ROOT = /<(?:[\w.-]+:)?gpx[\s>/]/i;
const TCX_ROOT = /<(?:[\w.-]+:)?TrainingCenterDatabase[\s>/]/i;
/** Sessions further than this from the summary's start belong to another activity. */
const MAX_START_DELTA_MS = 10 * 60 * 1000;

/** The activity file inside Garmin's download ZIP: FIT preferred, else the first GPX/TCX (or any file). */
async function extractFromZip(bytes: Uint8Array): Promise<Uint8Array | null> {
  const zip = await ZipArchive.open(bytesSource(bytes));
  const candidates = [];
  for await (const entry of zip.entries()) {
    if (entry.isDirectory || entry.encrypted || MAC_METADATA_ENTRY.test(entry.name)) continue;
    candidates.push(entry);
  }
  const rank = (name: string) => (/\.fit(?:\.gz)?$/i.test(name) ? 0 : ACTIVITY_ENTRY.test(name) ? 1 : 2);
  candidates.sort((a, b) => rank(a.name) - rank(b.name));
  return candidates.length ? zip.read(candidates[0], MAX_FILE_BYTES) : null;
}

/** Decode a Garmin download (ZIP, gzip or a bare FIT/GPX/TCX) into parsed workouts. */
export async function parseGarminActivityFile(bytes: Uint8Array): Promise<ParsedActivity[]> {
  let data: Uint8Array | null = bytes;
  if (isZip(data)) data = await extractFromZip(data);
  if (!data) return [];
  if (isGzip(data)) data = await gunzip(data, MAX_FILE_BYTES);
  if (isFitFile(data)) return parseFit(data);
  const head = decodeXmlBytes(data.subarray(0, 4096));
  if (GPX_ROOT.test(head)) return parseGpx(decodeXmlBytes(data));
  if (TCX_ROOT.test(head)) return parseTcx(decodeXmlBytes(data));
  return [];
}

/** The session that matches the summary: closest start time (multisport files hold several). */
function pickSession(sessions: ParsedActivity[], startMs: number): ParsedActivity | null {
  let best: ParsedActivity | null = null;
  let bestDelta = Infinity;
  for (const s of sessions) {
    const delta = Number.isFinite(startMs) ? Math.abs(s.startTime - startMs) : 0;
    if (delta < bestDelta) {
      best = s;
      bestDelta = delta;
    }
  }
  return best && (bestDelta <= MAX_START_DELTA_MS || sessions.length === 1) ? best : null;
}

/**
 * `base` (a Garmin summary already in the store) plus what only the original
 * file has: route, per-km / per-mile splits, device laps, the recording
 * device and stream-based best efforts for runs. Garmin's own summary values
 * (distance, times, heart rate, name, type) are kept. Null when the file holds
 * no matching workout.
 */
export async function buildGarminDetail(base: Activity, bytes: Uint8Array): Promise<Activity | null> {
  const sessions = await parseGarminActivityFile(bytes);
  const session = pickSession(sessions, Date.parse(base.start_date));
  if (!session) return null;
  const built = toActivity(session, {
    fileName: `garmin-${base.source_id ?? base.id}.fit`,
    id: base.id,
    sourceId: base.source_id,
    name: base.name,
    type: base.type,
    origin: base.origin,
  });
  if (!built) return null;

  const detail: Activity = { ...base };
  const poly = built.map?.summary_polyline;
  if (typeof poly === 'string') {
    detail.map = { id: base.map?.id ?? `garmin-${base.source_id ?? base.id}`, summary_polyline: poly };
    detail.start_latlng = built.start_latlng ?? base.start_latlng ?? null;
    detail.end_latlng = built.end_latlng ?? base.end_latlng ?? null;
  }
  if (built.splits_metric?.length) detail.splits_metric = built.splits_metric;
  if (built.splits_standard?.length) detail.splits_standard = built.splits_standard;
  if (built.laps?.length) detail.laps = built.laps;
  if (built.device_name && !base.device_name) detail.device_name = built.device_name;

  // Stream-based efforts are exact (splits only bound them); treadmill distances are estimates.
  if (isRunActivity(base) && !base.trainer) {
    const t0 = session.startTime;
    const samples = session.samples
      .filter((s) => typeof s.distance === 'number' && Number.isFinite(s.distance))
      .map((s) => ({ timeSec: (s.time - t0) / 1000, distanceM: s.distance as number }));
    const efforts = samples.length > 1 ? bestEffortsFromSamples(samples) : [];
    if (efforts.length) detail.best_efforts = efforts;
  }
  return detail;
}
