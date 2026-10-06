/**
 * Stream helpers for sources whose APIs return raw sample streams
 * (intervals.icu): route polyline encoding and Strava-compatible split
 * derivation, so split analysis and route maps work for every source.
 */

import type { ActivitySplit } from './types';

export type LatLngPair = [number, number];

/** One recorded sample. */
export interface StreamSample {
  /** Seconds since the activity started. */
  t: number;
  /** Cumulative distance in meters. */
  d: number;
  /** Heart rate (bpm). */
  hr?: number;
  /** Altitude (meters). */
  alt?: number;
}

/** A sample interval slower than this counts as stopped (not moving). */
const MOVING_SPEED_MPS = 0.5;
/** Gaps between samples longer than this are pauses (auto-pause / watch stopped). */
const MAX_SAMPLE_GAP_SEC = 60;
/** Strava includes a final partial split; skip only trivial GPS-noise remainders. */
const MIN_FINAL_SPLIT_M = 10;

// ── Polylines ─────────────────────────────────────────────────────────────────

function encodeSigned(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

/** Google encoded polyline (precision 5) — the inverse of routeService.decodePolyline. */
export function encodePolyline(points: LatLngPair[], precision: number = 5): string {
  const factor = Math.pow(10, precision);
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * factor);
    const iLng = Math.round(lng * factor);
    out += encodeSigned(iLat - lastLat) + encodeSigned(iLng - lastLng);
    lastLat = iLat;
    lastLng = iLng;
  }
  return out;
}

/** Keep at most `max` points, evenly spaced, always keeping the first and last. */
export function decimate<T>(points: T[], max: number): T[] {
  if (points.length <= max || max < 2) return points.slice();
  const out: T[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

/** Validate raw [lat, lng] pairs (drops nulls, out-of-range and 0,0 GPS-lock artifacts). */
export function cleanLatLngs(raw: unknown): LatLngPair[] {
  if (!Array.isArray(raw)) return [];
  const out: LatLngPair[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2 || p[0] == null || p[1] == null) continue;
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) continue;
    out.push([lat, lng]);
  }
  return out;
}

// ── Splits ────────────────────────────────────────────────────────────────────

function interpolate(a: number | undefined, b: number | undefined, frac: number): number | undefined {
  if (a != null && b != null) return a + (b - a) * frac;
  return b ?? a;
}

function averageHR(a: StreamSample, b: StreamSample): number | undefined {
  const x = a.hr && a.hr > 0 ? a.hr : undefined;
  const y = b.hr && b.hr > 0 ? b.hr : undefined;
  if (x != null && y != null) return (x + y) / 2;
  return x ?? y;
}

interface SplitAccumulator {
  startT: number;
  startAlt: number | undefined;
  moving: number;
  hrWeighted: number;
  hrTime: number;
}

function finishSplit(
  index: number,
  distance: number,
  endT: number,
  endAlt: number | undefined,
  acc: SplitAccumulator,
): ActivitySplit {
  const elapsed = Math.max(0, Math.round(endT - acc.startT));
  const moving = Math.round(acc.moving) || elapsed;
  const split: ActivitySplit = {
    split: index,
    distance: Math.round(distance * 10) / 10,
    elapsed_time: elapsed,
    moving_time: moving,
    average_speed: moving > 0 ? Math.round((distance / moving) * 1000) / 1000 : 0,
    elevation_difference:
      acc.startAlt != null && endAlt != null ? Math.round((endAlt - acc.startAlt) * 10) / 10 : 0,
  };
  if (acc.hrTime > 0) split.average_heartrate = Math.round((acc.hrWeighted / acc.hrTime) * 10) / 10;
  return split;
}

/**
 * Derive Strava-compatible splits (e.g. every 1000 m or 1609.344 m) from
 * time/distance streams. Boundary crossings are interpolated within a sample
 * interval; moving time excludes stops and pauses; the final partial split is
 * included like Strava does.
 */
export function deriveSplits(samples: StreamSample[], splitMeters: number): ActivitySplit[] {
  const pts = samples.filter((s) => Number.isFinite(s.t) && Number.isFinite(s.d));
  if (pts.length < 2 || !(splitMeters > 0)) return [];

  const splits: ActivitySplit[] = [];
  const origin = pts[0].d;
  let nextBoundary = origin + splitMeters;
  let acc: SplitAccumulator = { startT: pts[0].t, startAlt: pts[0].alt, moving: 0, hrWeighted: 0, hrTime: 0 };

  const addInterval = (dt: number, isMoving: boolean, hr: number | undefined, countsForHR: boolean) => {
    if (dt <= 0) return;
    if (isMoving) acc.moving += dt;
    if (hr != null && countsForHR) {
      acc.hrWeighted += hr * dt;
      acc.hrTime += dt;
    }
  };

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dt = b.t - a.t;
    if (dt <= 0) continue; // duplicate or out-of-order timestamps
    const dd = b.d - a.d;
    const withinGap = dt <= MAX_SAMPLE_GAP_SEC;
    const isMoving = withinGap && dd / dt >= MOVING_SPEED_MPS;
    const hr = averageHR(a, b);

    let segT = a.t;
    let segD = a.d;
    let segAlt = a.alt;
    // A single sample interval can cross one or more split boundaries.
    while (dd > 0 && b.d >= nextBoundary && b.d > segD) {
      const frac = (nextBoundary - segD) / (b.d - segD);
      const crossT = segT + frac * (b.t - segT);
      const crossAlt = interpolate(segAlt, b.alt, frac);
      addInterval(crossT - segT, isMoving, hr, withinGap);
      splits.push(finishSplit(splits.length + 1, splitMeters, crossT, crossAlt, acc));
      acc = { startT: crossT, startAlt: crossAlt, moving: 0, hrWeighted: 0, hrTime: 0 };
      segT = crossT;
      segD = nextBoundary;
      segAlt = crossAlt;
      nextBoundary += splitMeters;
    }
    addInterval(b.t - segT, isMoving, hr, withinGap);
  }

  const last = pts[pts.length - 1];
  const remaining = last.d - (nextBoundary - splitMeters);
  if (remaining >= MIN_FINAL_SPLIT_M) {
    splits.push(finishSplit(splits.length + 1, remaining, last.t, last.alt, acc));
  }
  return splits;
}
