/**
 * Canonical activity model shared by every data source (intervals.icu, Strava).
 *
 * The shape intentionally mirrors Strava's activity JSON because the analytics
 * engine was originally written against it. Every provider normalizes into
 * this shape so the rest of the app never needs to know where data came from:
 *
 *  - distances in meters, durations in seconds, speeds in m/s
 *  - `start_date` is UTC ISO-8601
 *  - `start_date_local` is the athlete's local wall-clock time formatted like
 *    Strava ("YYYY-MM-DDTHH:MM:SSZ"). The trailing "Z" is NOT a UTC marker —
 *    it is kept for compatibility with existing parsing/formatting code.
 *  - running `average_cadence` is strides per minute (Strava semantics). The UI
 *    doubles it to show steps per minute. Cycling cadence is RPM.
 */

/**
 * Where an activity came from:
 *  - 'intervals' / 'strava' — live sources Apollo syncs from automatically
 *  - 'file' — imported from a FIT/GPX/TCX file or a Strava/Garmin export archive
 */
export type ActivitySource = 'strava' | 'intervals' | 'file';

/** Sources Apollo can connect to and sync from automatically. */
export type LiveActivitySource = Exclude<ActivitySource, 'file'>;

/** A single split (per-km or per-mile). */
export interface ActivitySplit {
  distance: number;             // meters
  elapsed_time: number;         // seconds
  moving_time: number;          // seconds
  average_speed: number;        // m/s
  average_heartrate?: number;   // bpm (may be absent)
  elevation_difference: number; // meters (+ or -)
  split: number;                // 1-indexed split number
  pace_zone?: number;           // Strava pace zone (0-based)
}

/** A lap recorded by the device, created manually, or detected as an interval. */
export interface ActivityLap {
  id: number;
  name: string;
  lap_index: number;            // 0-indexed
  split: number;                // 1-indexed split number
  distance: number;             // meters
  elapsed_time: number;         // seconds
  moving_time: number;          // seconds
  average_speed: number;        // m/s
  max_speed: number;            // m/s
  average_heartrate?: number;   // bpm
  max_heartrate?: number;       // bpm
  average_cadence?: number;     // strides/min for runs (multiply by 2 for steps)
  total_elevation_gain: number; // meters
  start_index: number;
  end_index: number;
  pace_zone?: number;
}

export interface Activity {
  id: number;
  name: string;
  /** Sport type, e.g. Run, TrailRun, VirtualRun, Ride, VirtualRide, Swim, WeightTraining */
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  start_date: string;
  start_date_local: string;
  average_heartrate?: number;
  max_heartrate?: number;
  average_speed?: number;
  max_speed?: number;
  total_elevation_gain?: number;
  average_cadence?: number;
  suffer_score?: number;
  kudos_count: number;
  start_latlng?: [number, number] | null;
  end_latlng?: [number, number] | null;
  map?: {
    id: string;
    summary_polyline: string | null;
    polyline?: string | null;
  } | null;
  /** Per-km splits — only present on detailed fetch */
  splits_metric?: ActivitySplit[];
  /** Per-mile splits — only present on detailed fetch */
  splits_standard?: ActivitySplit[];
  /** Laps — only present on detailed fetch */
  laps?: ActivityLap[];

  // ── Provenance ──────────────────────────────────────────────
  /** Which live source this record was last synced from. Absent on legacy (Strava) records. */
  source?: ActivitySource;
  /** Provider-native ID (e.g. intervals.icu "i12345678" or the Strava activity ID). */
  source_id?: string;
  /** Upstream platform reported by the source, e.g. "GARMIN_CONNECT", "ZWIFT", "WAHOO". */
  origin?: string;

  // ── Cross-training / power metrics ─────────────────────────
  /** Average power in watts (cycling, some running pods). */
  average_watts?: number;
  /** Normalized / weighted average power in watts. */
  weighted_average_watts?: number;
  /** TSS-like training load computed by the source platform (intervals.icu). */
  training_load?: number;
  /** Indoor/trainer activity (Zwift, treadmill, turbo trainer). */
  trainer?: boolean;
  /** Recording device, e.g. "Garmin Forerunner 965" or "Zwift". */
  device_name?: string;
  calories?: number;
}

/** Minimal athlete profile shown in the UI. */
export interface AthleteProfile {
  id: number | string;
  firstname: string;
  lastname: string;
  /** Avatar URL (may be absent). */
  profile?: string;
  /** Which source provided the profile. */
  source: ActivitySource;
}
