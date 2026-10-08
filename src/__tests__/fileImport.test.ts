/**
 * End-to-end tests for `importActivityFiles` (fileImport/index.ts): Strava and
 * Garmin export archives, files picked directly, deduplication against
 * records already on the device, idempotent re-imports, progress, plan
 * refresh and notification, cancellation and a full activity store — plus
 * `isImportableFileName`, which picks the files to import out of a folder
 * dropped on the import card.
 *
 * Archives are assembled here (ZIP entries stored, or deflated with stored
 * DEFLATE blocks) from small synthetic GPX / TCX documents. FIT decoding is
 * mocked — a test FIT file is a FIT header followed by the sessions as JSON —
 * because fit.ts has its own tests; everything else runs for real against the
 * in-memory store from setup.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Activity } from '@/services/activity/types';
import { getStoredActivities, MAX_STORED_ACTIVITIES, storeActivities } from '@/services/analyticsService';
import { onActivitiesUpdated, type SyncSummary } from '@/services/activitySource';
import { FILE_ID_OFFSET } from '@/services/fileImport/build';
import { crc32 } from '@/services/fileImport/inflate';
import { importActivityFiles, isImportableFileName, type ImportFile, type ImportProgress } from '@/services/fileImport';
import { describeImportResult } from '@/services/fileImport/job';
import type { ParsedActivity } from '@/services/fileImport/types';

const refreshPlan = vi.hoisted(() => vi.fn((): unknown[] => []));

vi.mock('@/services/autoSync', () => ({ refreshPlanFromStoredActivities: refreshPlan }));

vi.mock('@/services/fileImport/fit', () => ({
  isFitFile: (data: Uint8Array): boolean =>
    data.length >= 14 && data[0] === 14 && String.fromCharCode(data[8], data[9], data[10], data[11]) === '.FIT',
  parseFit: (data: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(data.subarray(14))),
}));

// ── Building test files ───────────────────────────────────────────────────────

const encoder = new TextEncoder();
const bytes = (text: string): Uint8Array => encoder.encode(text);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** DEFLATE data made of stored blocks: valid input for every inflater. */
function deflateStored(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  do {
    const chunk = data.subarray(at, at + 0xffff);
    at += chunk.length;
    const n = chunk.length;
    parts.push(new Uint8Array([at >= data.length ? 1 : 0, n & 0xff, n >> 8, ~n & 0xff, (~n >> 8) & 0xff]), chunk);
  } while (at < data.length);
  return concat(...parts);
}

/** A gzip member wrapping `data`. */
function gzip(data: Uint8Array): Uint8Array {
  const trailer = new Uint8Array(8);
  const view = new DataView(trailer.buffer);
  view.setUint32(0, crc32(data), true);
  view.setUint32(4, data.length, true);
  return concat(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]), deflateStored(data), trailer);
}

interface ZipInput {
  name: string;
  data: Uint8Array | string;
  /** Store with method 8 (deflate) instead of 0. */
  deflate?: boolean;
  /** Uncompressed size written to the headers (to fake a corrupt entry). */
  declaredSize?: number;
}

/** A ZIP archive with UTF-8 names. */
function zip(entries: ZipInput[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = typeof e.data === 'string' ? bytes(e.data) : e.data;
    const body = e.deflate ? deflateStored(data) : data;
    const name = bytes(e.name);
    const crc = crc32(data);
    const size = e.declaredSize ?? data.length;
    const method = e.deflate ? 8 : 0;

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x0800, true);
    l.setUint16(8, method, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, size, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);

    const header = new Uint8Array(46 + name.length);
    const c = new DataView(header.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, method, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    header.set(name, 46);

    parts.push(local, body);
    central.push(header);
    offset += local.length + body.length;
  }
  const directory = concat(...central);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, directory.length, true);
  v.setUint32(16, offset, true);
  return concat(...parts, directory, end);
}

/** A test FIT file for the mocked decoder: the FIT header signature, then the sessions as JSON. */
function fakeFit(sessions: ParsedActivity[]): Uint8Array {
  const header = new Uint8Array(14);
  header[0] = 14;
  header.set(bytes('.FIT'), 8);
  return concat(header, bytes(JSON.stringify(sessions)));
}

/** A FIT session with a sample every 5 s at a steady speed. */
function fitSession(type: string, start: number, minutes: number, speed: number, extra: Partial<ParsedActivity> = {}): ParsedActivity {
  const samples = [];
  for (let s = 0; s <= minutes * 60; s += 5) samples.push({ time: start + s * 1000, distance: s * speed, heartRate: 140 });
  return { type, startTime: start, samples, laps: [], totals: { elapsedSec: minutes * 60 }, ...extra };
}

/** A recorded GPX track: a point every 10 s, heading north at ~2.8 m/s (`step` 0 = standing still). */
function gpx(start: number, minutes: number, trackInfo = '', step = 2.5e-4): string {
  const points: string[] = [];
  for (let i = 0; i <= minutes * 6; i++) {
    const time = new Date(start + i * 10_000).toISOString();
    points.push(`<trkpt lat="${45 + i * step}" lon="7"><ele>${100 + i / 10}</ele><time>${time}</time></trkpt>`);
  }
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<gpx version="1.1" creator="StravaGPX" xmlns="http://www.topografix.com/GPX/1/1">'
    + `<trk>${trackInfo}<trkseg>${points.join('\n')}</trkseg></trk></gpx>`;
}

/** A TCX ride with one lap (Strava's TCX exports start with whitespace before the declaration). */
function tcx(start: number, minutes: number): string {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const points: string[] = [];
  for (let i = 0; i <= minutes * 6; i++) {
    points.push(`<Trackpoint><Time>${iso(start + i * 10_000)}</Time><DistanceMeters>${i * 60}</DistanceMeters>`
      + '<HeartRateBpm><Value>130</Value></HeartRateBpm></Trackpoint>');
  }
  return '          <?xml version="1.0" encoding="UTF-8"?>\n'
    + '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">'
    + `<Activities><Activity Sport="Biking"><Id>${iso(start)}</Id><Lap StartTime="${iso(start)}">`
    + `<TotalTimeSeconds>${minutes * 60}</TotalTimeSeconds><DistanceMeters>${minutes * 360}</DistanceMeters>`
    + `<Track>${points.join('\n')}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
}

/** A gzip stream whose only block uses the reserved block type: corrupt. */
const CORRUPT_GZIP = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

// ── Export fixtures ───────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const RUN_START = Date.UTC(2024, 4, 4, 7, 0, 0);
const RIDE_START = Date.UTC(2024, 4, 5, 17, 30, 0);
const BRICK_START = Date.UTC(2024, 4, 6, 8, 0, 0);
const GARMIN_START = Date.UTC(2024, 5, 1, 5, 30, 0);

/** Strava's activities.csv (repeated column names and a manual entry included, like real exports). */
const STRAVA_CSV = [
  'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Filename,Elapsed Time,Distance',
  '1001,"May 4, 2024, 7:00:00 AM",Sunrise 5K,Run,,1800,5.00,activities/1001.gpx,1800.0,5003.8',
  '1002,"May 5, 2024, 5:30:00 PM","Zwift - Watopia, easy spin",Virtual Ride,,1800,10.80,activities/1002.tcx.gz,1800.0,10800.0',
  '1003,"May 6, 2024, 8:00:00 AM",Brick workout,Run,,3660,16.80,activities/1003.fit.gz,3660.0,16800.0',
  '1004,"May 7, 2024, 6:00:00 PM",Gym,Weight Training,,3600,0.00,,3600.0,0.0',
].join('\n');

/** A Strava "Download your archive" ZIP: a GPX, a gzipped TCX and a gzipped two-sport FIT, plus noise. */
function stravaArchive(): Uint8Array {
  const brick = fakeFit([
    fitSession('Ride', BRICK_START, 20, 8, { utcOffsetSec: 3600, device: 'Forerunner 965', origin: 'GARMIN' }),
    fitSession('Run', BRICK_START + 21 * 60_000, 40, 3, { utcOffsetSec: 3600, device: 'Forerunner 965', origin: 'GARMIN' }),
  ]);
  return zip([
    { name: 'activities.csv', data: STRAVA_CSV, deflate: true },
    { name: 'activities/', data: '' },
    { name: 'activities/1001.gpx', data: gpx(RUN_START, 30, '<name>Morning Run</name><type>running</type>'), deflate: true },
    { name: 'activities/1002.tcx.gz', data: gzip(bytes(tcx(RIDE_START, 30))) },
    { name: 'activities/1003.fit.gz', data: gzip(brick) },
    { name: 'profile.csv', data: 'Athlete ID,Email Address\n42,runner@example.com\n' },
    { name: 'media/0a1b2c.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]) },
    { name: '__MACOSX/activities/._1001.gpx', data: 'Finder metadata' },
  ]);
}

/** A Garmin "Export Your Data" ZIP: FIT uploads in a nested archive, names in summarizedActivities. */
function garminExport(): Uint8Array {
  const summaries = [{
    summarizedActivitiesExport: [
      {
        activityId: 9001, name: 'Paris - Long Run', activityType: 'running', sportType: 'RUNNING',
        beginTimestamp: GARMIN_START, startTimeGmt: GARMIN_START, startTimeLocal: GARMIN_START + 2 * 3_600_000,
      },
      { activityId: 9002, name: 'Pool Swim', activityType: 'lap_swimming', startTimeGmt: GARMIN_START + DAY_MS },
    ],
  }];
  const uploads = zip([{ name: 'runner@example.com_9001.fit', data: fakeFit([fitSession('', GARMIN_START + 3000, 90, 3)]) }]);
  return zip([
    { name: 'DI_CONNECT/DI-Connect-Fitness/runner@example.com_0_summarizedActivities.json', data: JSON.stringify(summaries), deflate: true },
    { name: 'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip', data: uploads },
    { name: 'DI_CONNECT/DI-Connect-Wellness/runner@example.com_sleepData.json', data: '[]' },
  ]);
}

function storedById(): Map<number, Activity> {
  return new Map(getStoredActivities().map((a) => [a.id, a]));
}

let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  refreshPlan.mockReset();
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
});
// ── Helpers ───────────────────────────────────────────────────────────────────

const NOT_AN_ACTIVITY = 'Not an activity file. Choose FIT, GPX or TCX files, or a Strava or Garmin export (.zip).';
const MANUAL_ENTRY = "1 activity was entered manually on Strava without a recording file, so there's nothing to import for them.";

/** A browser File (what the import card passes in), holding a copy of `data`. */
function file(name: string, data: Uint8Array): File {
  return new File([new Uint8Array(data)], name);
}

/** Record the plan refresh (with the store size it saw) and `onActivitiesUpdated` notifications, in order. */
function watchUpdates(): { summaries: SyncSummary[]; events: string[] } {
  const summaries: SyncSummary[] = [];
  const events: string[] = [];
  refreshPlan.mockImplementation(() => {
    events.push(`refresh (${getStoredActivities().length} stored)`);
    return [];
  });
  unsubscribe = onActivitiesUpdated((summary) => {
    summaries.push(summary);
    events.push('notify');
  });
  return { summaries, events };
}

/** A progress event as the UI shows it: phase, message, files done, files total, activities found. */
type ProgressLine = [ImportProgress['phase'], string, number, number | undefined, number];

function progressLog(): { lines: ProgressLine[]; onProgress: (p: ImportProgress) => void } {
  const lines: ProgressLine[] = [];
  return {
    lines,
    onProgress: (p) => {
      lines.push([p.phase, p.message, p.filesDone, p.filesTotal, p.activitiesFound]);
    },
  };
}

// ── Strava archive ────────────────────────────────────────────────────────────

describe('importActivityFiles: Strava archive', () => {
  it('imports every recorded activity with its Strava ID, name and type', async () => {
    const { summaries, events } = watchUpdates();
    const result = await importActivityFiles([file('export_48151623.zip', stravaArchive())]);

    expect(result).toEqual({
      filesRead: 3,
      activitiesFound: 4,
      added: 4,
      updated: 0,
      dropped: 0,
      skipped: [{ name: 'export_48151623.zip › activities.csv', reason: MANUAL_ENTRY }],
      errors: [],
      cancelled: false,
    });

    const stored = storedById();
    expect(stored.size).toBe(4);
    const run = stored.get(1001);
    expect(run).toMatchObject({
      name: 'Sunrise 5K', // activities.csv wins over the GPX track name ("Morning Run")
      type: 'Run',
      sport_type: 'Run',
      distance: 5003.8,
      moving_time: 1800,
      elapsed_time: 1800,
      start_date: '2024-05-04T07:00:00Z',
      start_latlng: [45, 7],
      source: 'file',
      source_id: 'strava:1001',
      origin: 'STRAVA',
    });
    expect(run?.map?.summary_polyline).toBeTruthy();
    expect(run?.splits_metric?.length).toBeGreaterThanOrEqual(5);

    expect(stored.get(1002)).toMatchObject({
      name: 'Zwift - Watopia, easy spin',
      type: 'VirtualRide', // "Virtual Ride" in the CSV; the TCX itself only says "Biking"
      trainer: true,
      distance: 10800,
      moving_time: 1800,
      average_heartrate: 130,
      start_date: '2024-05-05T17:30:00Z',
      map: { id: 'file-1002', summary_polyline: '' },
      start_latlng: null,
      source: 'file',
      source_id: 'strava:1002',
      origin: 'STRAVA',
    });

    // The brick's FIT file holds two sessions: the CSV row describes the longer one (the run)…
    expect(stored.get(1003)).toMatchObject({
      name: 'Brick workout',
      type: 'Run',
      distance: 7200,
      moving_time: 2400,
      elapsed_time: 2400,
      start_date: '2024-05-06T08:21:00Z',
      start_date_local: '2024-05-06T09:21:00Z',
      device_name: 'Forerunner 965',
      source: 'file',
      source_id: 'strava:1003',
      origin: 'GARMIN',
    });
    // …and the bike leg is kept as a file activity of its own.
    const ride = stored.get(FILE_ID_OFFSET + BRICK_START / 1000);
    expect(ride).toMatchObject({
      name: 'Morning Ride',
      type: 'Ride',
      distance: 9600,
      moving_time: 1200,
      start_date: '2024-05-06T08:00:00Z',
      start_date_local: '2024-05-06T09:00:00Z',
      source: 'file',
      source_id: `file:${BRICK_START / 1000}`,
      origin: 'GARMIN',
    });
    expect(ride?.trainer).toBeUndefined();

    // The plan is re-matched against the new activities first, then open pages are told.
    expect(events).toEqual(['refresh (4 stored)', 'notify']);
    expect(summaries).toEqual([{
      sources: ['file'],
      fetched: 4,
      added: 4,
      updated: 0,
      full: false,
      errors: [],
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
    }]);
  });

  it('merges into a legacy Strava record with the same Activity ID, keeping its name, and a re-import changes nothing', async () => {
    const legacy: Activity = {
      id: 1001,
      name: 'Sunrise 5K - new PB!',
      type: 'Run',
      sport_type: 'Run',
      distance: 5004.2,
      moving_time: 1795,
      elapsed_time: 1800,
      start_date: '2024-05-04T07:00:00Z',
      start_date_local: '2024-05-04T09:00:00Z',
      kudos_count: 12,
      average_heartrate: 152.3,
      map: { id: 'a1001', summary_polyline: 'ifs{Fbgnu@' },
    };
    storeActivities([legacy]);
    const { summaries } = watchUpdates();

    const first = await importActivityFiles([file('export.zip', stravaArchive())]);
    expect(first).toMatchObject({ filesRead: 3, activitiesFound: 4, added: 3, updated: 1, errors: [] });
    const stored = storedById();
    expect(stored.size).toBe(4);
    const run = stored.get(1001);
    // What the athlete already sees stays: name, stats, route and the legacy identity…
    expect(run).toMatchObject({
      name: legacy.name,
      distance: 5004.2,
      moving_time: 1795,
      kudos_count: 12,
      average_heartrate: 152.3,
      map: legacy.map,
    });
    expect(run?.source).toBeUndefined();
    expect(run?.source_id).toBeUndefined();
    expect(run?.origin).toBeUndefined();
    // …and the file only fills the gaps.
    expect(run?.splits_metric?.length).toBeGreaterThanOrEqual(5);
    expect(run?.start_latlng).toEqual([45, 7]);

    const before = JSON.stringify(getStoredActivities());
    const second = await importActivityFiles([file('export.zip', stravaArchive())]);
    expect(second).toEqual({
      filesRead: 3,
      activitiesFound: 4,
      added: 0,
      updated: 0,
      dropped: 0,
      skipped: [{ name: 'export.zip › activities.csv', reason: MANUAL_ENTRY }],
      errors: [],
      cancelled: false,
    });
    expect(JSON.stringify(getStoredActivities())).toBe(before);
    expect(refreshPlan).toHaveBeenCalledTimes(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ added: 3, updated: 1 });
  });

  it('re-importing the same export adds nothing and leaves the store untouched', async () => {
    await importActivityFiles([file('export.zip', stravaArchive())]);
    const before = JSON.stringify(getStoredActivities());
    refreshPlan.mockClear();
    const { summaries } = watchUpdates();

    const again = await importActivityFiles([file('export.zip', stravaArchive())]);
    expect(again).toMatchObject({ filesRead: 3, activitiesFound: 4, added: 0, updated: 0, errors: [] });
    expect(JSON.stringify(getStoredActivities())).toBe(before);
    expect(refreshPlan).not.toHaveBeenCalled();
    expect(summaries).toEqual([]);
  });

  it('reports progress as archives are opened and their files read', async () => {
    const { lines, onProgress } = progressLog();
    await importActivityFiles([
      { name: 'export.zip', data: stravaArchive() },
      { name: 'evening.gpx', data: bytes(gpx(RUN_START + 10 * DAY_MS, 20)) },
    ], { onProgress });
    expect(lines).toEqual([
      ['reading', 'Reading export.zip…', 0, 2, 0],
      ['reading', 'Opening export.zip…', 0, 1, 0], // the ZIP is replaced by the files inside…
      ['parsing', 'Reading 1001.gpx (1 of 4)…', 0, 4, 0], // …once they're listed
      ['parsing', 'Reading 1002.tcx.gz (2 of 4)…', 1, 4, 1],
      ['parsing', 'Reading 1003.fit.gz (3 of 4)…', 2, 4, 2],
      ['reading', 'Reading evening.gpx…', 3, 4, 4],
      ['parsing', 'Reading evening.gpx (4 of 4)…', 3, 4, 4],
      ['saving', 'Saving 5 activities…', 4, 4, 5],
      ['saving', 'Updating your training plan…', 4, 4, 5],
    ]);
  });
});

// ── Garmin export ─────────────────────────────────────────────────────────────

describe('importActivityFiles: Garmin export', () => {
  it('reads FIT uploads from the nested archive, named and timed by summarizedActivities', async () => {
    const { lines, onProgress } = progressLog();
    const result = await importActivityFiles([file('garmin_export.zip', garminExport())], { onProgress });

    expect(result).toEqual({
      filesRead: 1,
      activitiesFound: 1,
      added: 1,
      updated: 0,
      dropped: 0,
      skipped: [], // the summary without a file and the wellness data are ignored quietly
      errors: [],
      cancelled: false,
    });
    const startSec = (GARMIN_START + 3000) / 1000;
    expect(getStoredActivities()).toEqual([expect.objectContaining({
      id: FILE_ID_OFFSET + startSec,
      name: 'Paris - Long Run',
      type: 'Run',
      distance: 16200,
      moving_time: 5400,
      start_date: '2024-06-01T05:30:03Z',
      start_date_local: '2024-06-01T07:30:03Z', // the FIT has no local offset: Garmin's local start time supplies it
      source: 'file',
      source_id: `file:${startSec}`,
      origin: 'GARMIN',
    })]);
    expect(lines.map((line) => line[1])).toEqual([
      'Reading garmin_export.zip…',
      'Opening garmin_export.zip…',
      'Opening UploadedFiles_0-_Part1.zip…',
      'Reading runner@example.com_9001.fit…',
      'Saving 1 activity…',
      'Updating your training plan…',
    ]);
  });
});

// ── Picked files ──────────────────────────────────────────────────────────────

describe('importActivityFiles: picked files', () => {
  it('names files from an extracted Strava export by the activities.csv picked with them', async () => {
    const result = await importActivityFiles([
      { name: '1001.gpx', data: bytes(gpx(RUN_START, 30, '<name>Morning Run</name>')) },
      { name: '1002.tcx.gz', data: gzip(bytes(tcx(RIDE_START, 30))) },
      { name: 'activities.csv', data: bytes(STRAVA_CSV) }, // picked last, still read first
    ]);
    expect(result).toEqual({
      filesRead: 2,
      activitiesFound: 2,
      added: 2,
      updated: 0,
      dropped: 0,
      skipped: [{ name: 'activities.csv', reason: MANUAL_ENTRY }],
      errors: [],
      cancelled: false,
    });
    const stored = storedById();
    expect(stored.get(1001)).toMatchObject({ name: 'Sunrise 5K', type: 'Run', source_id: 'strava:1001' });
    expect(stored.get(1002)).toMatchObject({ name: 'Zwift - Watopia, easy spin', type: 'VirtualRide', source_id: 'strava:1002' });
  });

  it('explains every picked file that yields nothing, and keeps importing the rest', async () => {
    const route = '<?xml version="1.0"?><gpx version="1.1" creator="komoot"><rte><name>Loop</name>'
      + '<rtept lat="45.0" lon="7.0"/><rtept lat="45.01" lon="7.0"/></rte></gpx>';
    const course = '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">'
      + '<Courses><Course><Name>Loop</Name><Track><Trackpoint><Time>2024-05-01T07:00:00Z</Time></Trackpoint>'
      + '</Track></Course></Courses></TrainingCenterDatabase>';
    const result = await importActivityFiles([
      { name: 'photo.jpg', data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]) },
      { name: 'route.gpx', data: bytes(route) },
      { name: 'course.tcx', data: bytes(course) },
      { name: 'settings.fit', data: fakeFit([]) },
      { name: 'blip.fit', data: fakeFit([fitSession('Run', RUN_START, 0.5, 0)]) },
      { name: 'broken.gpx.gz', data: CORRUPT_GZIP },
      { name: 'photos.zip', data: zip([{ name: 'IMG_0001.jpg', data: new Uint8Array([0xff, 0xd8]) }]) },
      { name: 'activities.csv', data: bytes('Date,Distance (km)\n2024-05-01,5.0\n') }, // not Strava's
      {
        name: 'mixed.zip',
        data: zip([
          { name: 'runs/ok.gpx', data: gpx(RUN_START + DAY_MS, 30), deflate: true },
          { name: 'runs/bad.gpx', data: gpx(RUN_START + 2 * DAY_MS, 30), deflate: true, declaredSize: 64 },
        ]),
      },
      { name: 'good.gpx', data: bytes(gpx(RUN_START + 3 * DAY_MS, 30)) },
    ]);

    expect(result.skipped).toEqual([
      { name: 'activities.csv', reason: NOT_AN_ACTIVITY }, // metadata is read before everything else
      { name: 'photo.jpg', reason: NOT_AN_ACTIVITY },
      { name: 'route.gpx', reason: 'No timed track points: this looks like a route or course, not a recorded workout.' },
      { name: 'course.tcx', reason: 'No workouts in this TCX file (it may hold a course).' },
      { name: 'settings.fit', reason: 'No workout in this FIT file (it may hold settings, a course or health data).' },
      { name: 'blip.fit', reason: 'Too short to import (under a minute, with no distance).' },
      { name: 'photos.zip', reason: 'No FIT, GPX or TCX files in this ZIP archive.' },
    ]);
    expect(result.errors).toEqual([
      { name: 'broken.gpx.gz', message: 'The compressed data is corrupt or truncated.' },
      {
        name: 'mixed.zip › runs/bad.gpx',
        message: 'The file is corrupt inside the ZIP archive (it holds more data than its header declares).',
      },
    ]);
    expect(result).toMatchObject({ filesRead: 6, activitiesFound: 2, added: 2, updated: 0, cancelled: false });
    expect(getStoredActivities()).toHaveLength(2);
  });

  it('stores a workout picked as both FIT and GPX once, combining what each file knows', async () => {
    const result = await importActivityFiles([
      { name: 'run.fit', data: fakeFit([fitSession('Run', RUN_START, 30, 2.78)]) },
      { name: 'run.gpx', data: bytes(gpx(RUN_START, 30)) },
    ]);
    expect(result).toMatchObject({ filesRead: 2, activitiesFound: 2, added: 1, updated: 0, dropped: 0, errors: [] });
    const stored = getStoredActivities();
    expect(stored).toHaveLength(1);
    expect(stored[0].average_heartrate).toBe(140); // from the FIT file
    expect(stored[0].map?.summary_polyline).toBeTruthy(); // from the GPX file
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────────

describe('importActivityFiles: cancellation', () => {
  it('does nothing when cancelled before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await importActivityFiles([file('export.zip', stravaArchive())], { signal: controller.signal });
    expect(result).toEqual({
      filesRead: 0,
      activitiesFound: 0,
      added: 0,
      updated: 0,
      dropped: 0,
      skipped: [],
      errors: [],
      cancelled: true,
    });
    expect(getStoredActivities()).toEqual([]);
    expect(refreshPlan).not.toHaveBeenCalled();
  });

  it('stops between the files of an archive and keeps what was already read', async () => {
    const controller = new AbortController();
    const { summaries, events } = watchUpdates();
    const messages: string[] = [];
    const result = await importActivityFiles([file('export.zip', stravaArchive())], {
      signal: controller.signal,
      onProgress: (p) => {
        messages.push(p.message);
        if (p.message.startsWith('Reading 1002.tcx.gz')) controller.abort(); // Cancel while the 2nd file is read
      },
    });

    expect(result).toEqual({
      filesRead: 2,
      activitiesFound: 2,
      added: 2,
      updated: 0,
      dropped: 0,
      skipped: [{ name: 'export.zip › activities.csv', reason: MANUAL_ENTRY }],
      errors: [],
      cancelled: true,
    });
    expect([...storedById().keys()].sort((a, b) => a - b)).toEqual([1001, 1002]);
    expect(messages.filter((m) => m.includes('1003'))).toEqual([]);
    expect(events).toEqual(['refresh (2 stored)', 'notify']);
    expect(summaries[0]).toMatchObject({ fetched: 2, added: 2 });
  });

  it('stops between picked files', async () => {
    const controller = new AbortController();
    const result = await importActivityFiles([
      { name: 'a.gpx', data: bytes(gpx(RUN_START, 30)) },
      { name: 'b.gpx', data: bytes(gpx(RUN_START + DAY_MS, 30)) },
      { name: 'c.gpx', data: bytes(gpx(RUN_START + 2 * DAY_MS, 30)) },
    ], {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.message === 'Reading b.gpx…') controller.abort(); // the file being read still finishes
      },
    });
    expect(result).toMatchObject({ filesRead: 2, activitiesFound: 2, added: 2, cancelled: true });
    expect(getStoredActivities()).toHaveLength(2);
  });
});

// ── A full store ──────────────────────────────────────────────────────────────

/** A minimal intervals.icu run, as a sync stores it. */
function syncedRun(n: number, startMs: number): Activity {
  const start = new Date(startMs).toISOString().replace('.000Z', 'Z');
  return {
    id: 50_000_000 + n,
    name: 'Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 8000,
    moving_time: 2700,
    elapsed_time: 2700,
    start_date: start,
    start_date_local: start,
    kudos_count: 0,
    source: 'intervals',
    source_id: `i${n}`,
  };
}

describe('importActivityFiles: a full activity store', () => {
  it('keeps records and the most recent activities, and counts the older ones that no longer fit', async () => {
    // One short of the limit: a run a day from 2011 on, all newer than the files below.
    const synced = Array.from({ length: MAX_STORED_ACTIVITIES - 1 }, (_, n) => syncedRun(n, Date.UTC(2011, 0, 1, 6) + n * DAY_MS));
    expect(storeActivities(synced)).toEqual({
      added: MAX_STORED_ACTIVITIES - 1, updated: 0, dropped: 0, droppedRuns: 0, droppedOther: 0, skippedDeleted: 0,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); // the store warns when it trims
    try {
      // 2010 history: a FIT file with 250 short runs (one full save batch, no records among them),
      // then three identical ~5 km December runs as GPX.
      const history = fakeFit(Array.from({ length: 250 }, (_, k) => fitSession('Run', Date.UTC(2010, 0, 1, 7) + k * DAY_MS, 2, 3)));
      const december = [1, 2, 3].map((day) => ({ name: `dec${day}.gpx`, data: bytes(gpx(Date.UTC(2010, 11, day, 7), 30)) }));
      const result = await importActivityFiles([{ name: 'history.fit', data: history }, ...december]);

      // The first save keeps the newest of the 250 runs. Then the oldest runs go, except records (B16):
      // December 1 is the first ~5 km run, so it holds the 5K PR and stays; December 2 and 3 go.
      // (Before B16 the PR holder was trimmed and only December 3 survived.)
      expect(result).toEqual({
        filesRead: 4,
        activitiesFound: 253,
        added: 253,
        updated: 0,
        dropped: 249 + 3,
        skipped: [],
        errors: [],
        cancelled: false,
      });
      expect(describeImportResult(result)).toBe(
        `Added 253 activities. Apollo keeps up to ${MAX_STORED_ACTIVITIES.toLocaleString()} activities `
          + '(races and personal records always stay), so 252 older ones weren\'t kept.',
      );
      const stored = getStoredActivities();
      expect(stored).toHaveLength(MAX_STORED_ACTIVITIES);
      expect(stored.filter((a) => a.source === 'file').map((a) => a.start_date)).toEqual(['2010-12-01T07:00:00Z']);
      expect(stored[stored.length - 1].start_date).toBe('2010-12-01T07:00:00Z');
      expect(stored[0].start_date).toBe(synced[synced.length - 1].start_date);
      // The oldest synced run (longest and fastest run) is a record too, so it was never a candidate.
      expect(stored.some((a) => a.start_date === synced[0].start_date)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── Robustness ────────────────────────────────────────────────────────────────

describe('importActivityFiles: robustness', () => {
  it('never fails because the plan refresh or a progress listener throws', async () => {
    refreshPlan.mockImplementation(() => {
      throw new Error('plan storage locked');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const summaries: SyncSummary[] = [];
    unsubscribe = onActivitiesUpdated((summary) => {
      summaries.push(summary);
    });
    try {
      const files: ImportFile[] = [{ name: 'run.gpx', data: bytes(gpx(RUN_START, 30)) }];
      const result = await importActivityFiles(files, {
        onProgress: () => {
          throw new Error('progress UI unmounted');
        },
      });
      expect(result).toMatchObject({ filesRead: 1, added: 1, errors: [], cancelled: false });
      expect(refreshPlan).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[Apollo] Plan refresh after file import failed:', expect.any(Error));
      expect(summaries).toHaveLength(1); // pages still refresh
    } finally {
      warn.mockRestore();
    }
  });
});

// ── Dropped folders ───────────────────────────────────────────────────────────

describe('isImportableFileName', () => {
  it('picks activity files, archives and export metadata out of a dropped folder', () => {
    const wanted = [
      'export/activities.csv', 'export/activities/1001.gpx', 'export/activities/1002.TCX.gz', 'run.fit', 'run.fit.gz',
      'garmin.zip', 'DI_CONNECT/DI-Connect-Fitness/me_0_summarizedActivities.json',
    ];
    const ignored = [
      'export/profile.csv', 'export/media/0a1b2c.jpg', 'export/__MACOSX/activities/._1001.gpx', 'export/._run.fit',
      'notes.txt', 'backup.gz', 'DI_CONNECT/DI-Connect-Wellness/me_sleepData.json',
    ];
    expect(wanted.filter((name) => !isImportableFileName(name))).toEqual([]);
    expect(ignored.filter((name) => isImportableFileName(name))).toEqual([]);
  });
});
