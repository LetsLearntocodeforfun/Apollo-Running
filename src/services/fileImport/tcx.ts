/**
 * TCX (Garmin Training Center Database v2) activity parser.
 *
 * Each `<Activity Sport="Running|Biking|Other">` becomes one workout —
 * including the legs of a `<MultiSportSession>`; `<Courses>` are ignored.
 * Laps carry the device's own numbers (`TotalTimeSeconds` is timer time,
 * `DistanceMeters`, `Calories`, average / maximum heart rate, cadence and the
 * `LX` extension's `AvgSpeed` / `AvgRunCadence` / `AvgWatts`), which become
 * the activity totals. Trackpoints provide time, position, altitude,
 * cumulative distance, heart rate, cadence and the `TPX` extension's
 * `Speed` / `RunCadence` / `Watts`. The `<Creator><Name>` is the device.
 */

import type { ParsedActivity, ParsedLap, ParsedSample, ParsedTotals } from './types';
import { parseXmlNumber, parseXmlTime, scanXml } from './xml';
import { normalizeSportType, originFromName } from './build';

interface LapState {
  startTime: number;
  totalTime?: number;
  distance?: number;
  maxSpeed?: number;
  calories?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  cadence?: number;
  avgSpeed?: number;
  avgRunCadence?: number;
  avgWatts?: number;
  /** Time / cumulative distance of the lap's first and last trackpoints. */
  firstTime?: number;
  lastTime?: number;
  firstDistance?: number;
  lastDistance?: number;
}

interface ActivityState {
  sport?: string;
  /** Start time from `<Id>`. */
  id: number;
  laps: LapState[];
  samples: ParsedSample[];
  device?: string;
}

interface PointState extends ParsedSample {
  runCadence?: number;
}

function finite(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v);
}

function sumOf(laps: LapState[], pick: (l: LapState) => number | undefined): number | undefined {
  let total = 0;
  let seen = false;
  for (const l of laps) {
    const v = pick(l);
    if (finite(v) && v >= 0) {
      total += v;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

/** Average of a per-lap value weighted by lap timer time (falls back to a plain mean). */
function weightedByTime(laps: LapState[], pick: (l: LapState) => number | undefined): number | undefined {
  let sum = 0;
  let weight = 0;
  let plain = 0;
  let count = 0;
  for (const l of laps) {
    const v = pick(l);
    if (!finite(v) || v <= 0) continue;
    plain += v;
    count++;
    if (finite(l.totalTime) && l.totalTime > 0) {
      sum += v * l.totalTime;
      weight += l.totalTime;
    }
  }
  if (weight > 0) return sum / weight;
  return count ? plain / count : undefined;
}

function maxOf(laps: LapState[], pick: (l: LapState) => number | undefined): number | undefined {
  let max: number | undefined;
  for (const l of laps) {
    const v = pick(l);
    if (finite(v) && v > 0 && (max === undefined || v > max)) max = v;
  }
  return max;
}

function toParsedLaps(laps: LapState[], start: number): ParsedLap[] {
  const out: ParsedLap[] = [];
  let previousEnd = start;
  for (let i = 0; i < laps.length; i++) {
    const l = laps[i];
    const lapStart = finite(l.startTime) ? l.startTime : finite(l.firstTime) ? l.firstTime : previousEnd;
    const next = laps[i + 1];
    const nextStart = next && finite(next.startTime) ? next.startTime : undefined;
    let elapsed: number;
    if (nextStart !== undefined && nextStart > lapStart) elapsed = (nextStart - lapStart) / 1000;
    else if (finite(l.lastTime) && l.lastTime > lapStart) elapsed = (l.lastTime - lapStart) / 1000;
    else elapsed = l.totalTime ?? 0;
    if (finite(l.totalTime) && l.totalTime > elapsed) elapsed = l.totalTime;

    const sampleDistance = finite(l.firstDistance) && finite(l.lastDistance) ? l.lastDistance - l.firstDistance : undefined;
    const distance = finite(l.distance) ? l.distance : sampleDistance !== undefined && sampleDistance > 0 ? sampleDistance : 0;
    const lap: ParsedLap = { startTime: lapStart, elapsedSec: elapsed, distance };
    if (finite(l.totalTime)) lap.movingSec = l.totalTime;
    const avgSpeed = finite(l.avgSpeed) && l.avgSpeed > 0
      ? l.avgSpeed
      : finite(l.totalTime) && l.totalTime > 0 && distance > 0 ? distance / l.totalTime : undefined;
    if (avgSpeed !== undefined) lap.avgSpeed = avgSpeed;
    if (finite(l.maxSpeed) && l.maxSpeed > 0) lap.maxSpeed = l.maxSpeed;
    if (finite(l.avgHeartRate) && l.avgHeartRate > 0) lap.avgHeartRate = l.avgHeartRate;
    if (finite(l.maxHeartRate) && l.maxHeartRate > 0) lap.maxHeartRate = l.maxHeartRate;
    const cadence = finite(l.avgRunCadence) && l.avgRunCadence > 0 ? l.avgRunCadence : l.cadence;
    if (finite(cadence) && cadence > 0) lap.avgCadence = cadence;
    out.push(lap);
    previousEnd = lapStart + elapsed * 1000;
  }
  return out;
}

/** Parse a TCX document into one `ParsedActivity` per `<Activity>`. */
export function parseTcx(text: string): ParsedActivity[] {
  const activities: ParsedActivity[] = [];
  let author: string | undefined;
  let activity: ActivityState | null = null;
  let lap: LapState | null = null;
  let point: PointState | null = null;

  const finishActivity = (a: ActivityState): void => {
    const samples = a.samples;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].time < samples[i - 1].time) {
        samples.sort((x, y) => x.time - y.time);
        break;
      }
    }
    const firstLap = a.laps.find((l) => finite(l.startTime));
    const start = finite(a.id) ? a.id : firstLap ? firstLap.startTime : samples.length ? samples[0].time : NaN;
    if (!finite(start)) return;
    if (samples.length === 0 && a.laps.length === 0) return;

    const laps = toParsedLaps(a.laps, start);
    const totals: ParsedTotals = {};
    const moving = sumOf(a.laps, (l) => l.totalTime);
    if (moving !== undefined && moving > 0) totals.movingSec = moving;
    const distance = sumOf(a.laps, (l) => l.distance);
    if (distance !== undefined && distance > 0) totals.distance = distance;
    const calories = sumOf(a.laps, (l) => l.calories);
    if (calories !== undefined && calories > 0) totals.calories = calories;
    const avgHr = weightedByTime(a.laps, (l) => l.avgHeartRate);
    if (avgHr !== undefined) totals.avgHeartRate = Math.round(avgHr * 10) / 10;
    const maxHr = maxOf(a.laps, (l) => l.maxHeartRate);
    if (maxHr !== undefined) totals.maxHeartRate = maxHr;
    const cadence = weightedByTime(a.laps, (l) => (finite(l.avgRunCadence) && l.avgRunCadence > 0 ? l.avgRunCadence : l.cadence));
    if (cadence !== undefined) totals.avgCadence = Math.round(cadence * 10) / 10;
    const watts = weightedByTime(a.laps, (l) => l.avgWatts);
    if (watts !== undefined) totals.avgPower = Math.round(watts);
    const maxSpeed = maxOf(a.laps, (l) => l.maxSpeed);
    if (maxSpeed !== undefined) totals.maxSpeed = maxSpeed;
    if (samples.length < 2 && laps.length) {
      const last = laps[laps.length - 1];
      const span = (last.startTime + last.elapsedSec * 1000 - start) / 1000;
      if (span > 0) totals.elapsedSec = span;
    }

    const sport = normalizeSportType(a.sport);
    const parsed: ParsedActivity = { type: sport.type, startTime: start, samples, laps, totals };
    if (sport.trainer) parsed.trainer = true;
    if (a.device) parsed.device = a.device;
    activities.push(parsed);
  };

  scanXml(text, {
    open(name, attrs) {
      if (name === 'activity') {
        activity = { sport: attrs.sport, id: NaN, laps: [], samples: [] };
        lap = null;
        point = null;
      } else if (!activity) {
        return;
      } else if (name === 'lap') {
        lap = { startTime: parseXmlTime(attrs.starttime ?? '') };
      } else if (name === 'trackpoint') {
        point = { time: NaN };
      }
    },
    text(value, path) {
      const name = path[path.length - 1];
      const parent = path[path.length - 2];
      if (!activity) {
        if (name === 'name' && parent === 'author') author = value.trim() || undefined;
        return;
      }
      if (point) {
        if (name === 'time') {
          if (parent === 'trackpoint') point.time = parseXmlTime(value);
          return;
        }
        const v = parseXmlNumber(value);
        if (v === undefined) return;
        switch (name) {
          case 'latitudedegrees': point.lat = v; break;
          case 'longitudedegrees': point.lng = v; break;
          case 'altitudemeters': point.altitude = v; break;
          case 'distancemeters': if (parent === 'trackpoint' && v >= 0) point.distance = v; break;
          case 'value': if (parent === 'heartratebpm' && v > 0) point.heartRate = v; break;
          case 'cadence': if (parent === 'trackpoint' && v >= 0) point.cadence = v; break;
          case 'runcadence': if (v >= 0) point.runCadence = v; break;
          case 'speed': if (v >= 0) point.speed = v; break;
          case 'watts': if (v >= 0) point.power = v; break;
        }
        return;
      }
      if (lap) {
        const v = parseXmlNumber(value);
        if (v === undefined) return;
        if (parent === 'lap') {
          switch (name) {
            case 'totaltimeseconds': lap.totalTime = v; break;
            case 'distancemeters': lap.distance = v; break;
            case 'maximumspeed': lap.maxSpeed = v; break;
            case 'calories': lap.calories = v; break;
            case 'cadence': lap.cadence = v; break;
          }
        } else if (name === 'value' && parent === 'averageheartratebpm') {
          lap.avgHeartRate = v;
        } else if (name === 'value' && parent === 'maximumheartratebpm') {
          lap.maxHeartRate = v;
        } else if (name === 'avgspeed') {
          lap.avgSpeed = v;
        } else if (name === 'avgruncadence') {
          lap.avgRunCadence = v;
        } else if (name === 'avgwatts') {
          lap.avgWatts = v;
        }
        return;
      }
      if (name === 'id' && parent === 'activity') activity.id = parseXmlTime(value);
      else if (name === 'name' && parent === 'creator') activity.device = value.trim() || undefined;
    },
    close(name) {
      if (name === 'trackpoint') {
        if (point && activity && Number.isFinite(point.time)) {
          const { runCadence, ...sample } = point;
          if (runCadence !== undefined) sample.cadence = runCadence;
          activity.samples.push(sample);
          if (lap) {
            lap.firstTime ??= sample.time;
            lap.lastTime = sample.time;
            if (sample.distance !== undefined) {
              lap.firstDistance ??= sample.distance;
              lap.lastDistance = sample.distance;
            }
          }
        }
        point = null;
      } else if (name === 'lap') {
        if (lap && activity) activity.laps.push(lap);
        lap = null;
      } else if (name === 'activity') {
        if (activity) finishActivity(activity);
        activity = null;
        lap = null;
        point = null;
      }
    },
  });

  // <Author> (the exporting application) comes last: use it when the device gave no hint.
  const authorOrigin = originFromName(author);
  for (const a of activities) {
    const origin = originFromName(a.device) ?? authorOrigin;
    if (origin) a.origin = origin;
  }
  return activities;
}
