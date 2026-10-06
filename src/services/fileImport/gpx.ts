/**
 * GPX 1.0 / 1.1 activity parser.
 *
 * Every `<trk>` becomes one workout. Track points need a `<time>` — routes and
 * courses (no timestamps) yield nothing. Sensor data is read from any
 * extension flavour, whatever the namespace prefix: Garmin
 * TrackPointExtension (`gpxtpx:hr`, `gpxtpx:cad`, `gpxtpx:speed`), Cluetrust
 * `gpxdata:*`, Garmin power (`pwr:PowerInWatts`), plain `<power>` /
 * `<heartrate>` / `<cadence>`, and GPX 1.0 `<speed>`.
 *
 * Sport comes from `<trk><type>`: Garmin keys ("running", "trail_running"),
 * Strava's numeric codes ("9" = Run, "1" = Ride) or names ("Run"). Without a
 * recognizable type, a sport word in the track name ("Running 6/15/19") is
 * used; otherwise the track gets `type: ''` and build.ts infers the sport
 * from its speed.
 */

import type { ParsedActivity, ParsedSample } from './types';
import { parseXmlNumber, parseXmlTime, scanXml } from './xml';
import { normalizeSportType, originFromName } from './build';

/** Extension element names (lower-cased local names) for each sensor channel. */
const HEART_RATE_TAGS = new Set(['hr', 'heartrate', 'heart_rate', 'heartratebpm']);
const CADENCE_TAGS = new Set(['cad', 'cadence', 'runcadence']);
const POWER_TAGS = new Set(['power', 'watts', 'powerinwatts']);
const SPEED_TAGS = new Set(['speed']);

interface TrackState {
  name?: string;
  type?: string;
  samples: ParsedSample[];
}

/** Sport words apps put in track names, e.g. Runkeeper's "Running 6/15/19 7:35 am". */
const NAME_SPORTS: [RegExp, string][] = [
  [/\btrail\s*run/i, 'TrailRun'],
  [/\b(?:run|running|jog|jogging)\b/i, 'Run'],
  [/\b(?:ride|riding|cycling|bike|biking)\b/i, 'Ride'],
  [/\b(?:walk|walking)\b/i, 'Walk'],
  [/\b(?:hike|hiking)\b/i, 'Hike'],
];

/** Sport named in a track name, or ''. */
function sportFromName(name: string | undefined): string {
  if (!name) return '';
  for (const [pattern, type] of NAME_SPORTS) if (pattern.test(name)) return type;
  return '';
}

function byTime(a: ParsedSample, b: ParsedSample): number {
  return a.time - b.time;
}

/** Parse a GPX document into one `ParsedActivity` per timed `<trk>`. */
export function parseGpx(text: string): ParsedActivity[] {
  const activities: ParsedActivity[] = [];
  let creator: string | undefined;
  let track: TrackState | null = null;
  let point: ParsedSample | null = null;

  const finishTrack = (t: TrackState): void => {
    const samples = t.samples;
    if (samples.length < 2) return;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].time < samples[i - 1].time) {
        samples.sort(byTime); // stable: keeps recording order for equal timestamps
        break;
      }
    }
    const sport = normalizeSportType(t.type);
    const activity: ParsedActivity = {
      type: sport.type || sportFromName(t.name),
      startTime: samples[0].time,
      samples,
      laps: [],
      totals: {},
    };
    if (sport.trainer) activity.trainer = true;
    if (t.name) activity.name = t.name;
    const origin = originFromName(creator);
    if (origin) activity.origin = origin;
    activities.push(activity);
  };

  scanXml(text, {
    open(name, attrs, path) {
      if (name === 'gpx' && path.length === 1) {
        creator = attrs.creator?.trim() || undefined;
      } else if (name === 'trk') {
        track = { samples: [] };
      } else if (name === 'trkpt' && track) {
        const p: ParsedSample = { time: NaN };
        const lat = parseXmlNumber(attrs.lat ?? '');
        const lng = parseXmlNumber(attrs.lon ?? '');
        if (lat !== undefined && lng !== undefined) {
          p.lat = lat;
          p.lng = lng;
        }
        point = p;
      }
    },
    text(value, path) {
      const name = path[path.length - 1];
      const parent = path[path.length - 2];
      if (point) {
        if (parent === 'trkpt' && name === 'time') {
          point.time = parseXmlTime(value);
          return;
        }
        const v = parseXmlNumber(value);
        if (v === undefined) return;
        if (parent === 'trkpt' && name === 'ele') point.altitude = v;
        else if (HEART_RATE_TAGS.has(name)) {
          if (v > 0) point.heartRate = v;
        } else if (CADENCE_TAGS.has(name)) {
          if (v >= 0) point.cadence = v;
        } else if (POWER_TAGS.has(name)) {
          if (v >= 0) point.power = v;
        } else if (SPEED_TAGS.has(name)) {
          if (v >= 0) point.speed = v;
        }
      } else if (track && parent === 'trk') {
        if (name === 'name') track.name = value.trim() || undefined;
        else if (name === 'type') track.type = value.trim() || undefined;
      }
    },
    close(name) {
      if (name === 'trkpt') {
        if (point && track && Number.isFinite(point.time)) track.samples.push(point);
        point = null;
      } else if (name === 'trk') {
        if (track) finishTrack(track);
        track = null;
        point = null;
      }
    },
  });
  return activities;
}
