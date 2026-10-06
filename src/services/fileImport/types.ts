/**
 * Shared contract for activity file import (FIT, GPX, TCX and export archives).
 *
 * Every parser produces `ParsedActivity` records — a neutral, sample-level
 * description of one workout — and `build.ts` converts them into Apollo's
 * canonical `Activity` (splits, laps, route polyline, moving time, IDs…), so
 * imported workouts flow through the same analytics as synced ones.
 *
 * Units: SI throughout (meters, seconds, m/s, degrees). Times are absolute UTC
 * milliseconds since the Unix epoch.
 */

/** One recorded sample (a FIT `record`, a GPX `trkpt`, a TCX `Trackpoint`). */
export interface ParsedSample {
  /** Absolute UTC time, ms since the Unix epoch. */
  time: number;
  /** Latitude in degrees (WGS84). */
  lat?: number;
  /** Longitude in degrees (WGS84). */
  lng?: number;
  /** Cumulative distance in meters as recorded by the device (derived from GPS when absent). */
  distance?: number;
  /** Altitude in meters. */
  altitude?: number;
  /** Heart rate in bpm. */
  heartRate?: number;
  /**
   * Cadence exactly as the file stores it: RPM for cycling; for running, FIT
   * and Garmin TCX/GPX store strides (single-leg cycles) per minute. Some
   * exporters write steps per minute — build.ts normalizes running cadence.
   */
  cadence?: number;
  /** Speed in m/s. */
  speed?: number;
  /** Power in watts. */
  power?: number;
}

/** A lap as recorded by the device (auto-lap, manual lap button, workout step). */
export interface ParsedLap {
  /** Lap start, UTC ms. */
  startTime: number;
  /** Wall-clock duration of the lap in seconds. */
  elapsedSec: number;
  /** Timer (moving) time in seconds, excluding pauses, when the file records it. */
  movingSec?: number;
  /** Lap distance in meters. */
  distance: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  /** Same units as `ParsedSample.cadence`. */
  avgCadence?: number;
  /** Elevation gain in meters. */
  ascent?: number;
  name?: string;
}

/** Totals reported by the device — preferred over values derived from samples. */
export interface ParsedTotals {
  elapsedSec?: number;
  /** Timer (moving) time in seconds, excluding pauses. */
  movingSec?: number;
  distance?: number;
  ascent?: number;
  calories?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  /** Same units as `ParsedSample.cadence`. */
  avgCadence?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgPower?: number;
  normalizedPower?: number;
  /** TSS-like load reported by the device, if any. */
  trainingLoad?: number;
}

/** One workout extracted from a file (a FIT file can hold several sessions). */
export interface ParsedActivity {
  /**
   * Strava / intervals.icu style sport type: Run, TrailRun, VirtualRun, Ride,
   * VirtualRide, MountainBikeRide, GravelRide, EBikeRide, Swim, Walk, Hike,
   * WeightTraining, Rowing, Workout, …
   */
  type: string;
  /** Indoor / trainer / treadmill activity. */
  trainer?: boolean;
  /** Start time, UTC ms. */
  startTime: number;
  /**
   * Athlete's local-time offset from UTC in seconds when the file records it
   * (FIT `activity.local_timestamp − timestamp`). When absent, build.ts uses
   * the importing computer's time zone.
   */
  utcOffsetSec?: number;
  /** Name stored in the file (GPX `<name>`), if any. */
  name?: string;
  /** Samples in chronological order (may be empty for manual / pool workouts). */
  samples: ParsedSample[];
  laps: ParsedLap[];
  totals: ParsedTotals;
  /** Recording device, e.g. "Garmin Forerunner 965", "COROS PACE 3", "Zwift". */
  device?: string;
  /** Upstream platform / manufacturer, e.g. GARMIN, COROS, SUUNTO, POLAR, WAHOO, ZWIFT, STRAVA. */
  origin?: string;
}

/** A file that could not be imported. */
export class FileImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileImportError';
  }
}
