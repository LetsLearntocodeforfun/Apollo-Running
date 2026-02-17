/**
 * routeService.ts — Route decoding, analytics, and local caching for Apollo Running.
 *
 * Decodes Google Encoded Polylines (used by Strava) into lat/lng arrays,
 * computes route analytics (bounding box, distance segments, bearing),
 * projects coordinates to SVG-friendly x/y points, and caches routes locally.
 */

import { persistence } from './db/persistence';

// ─── Types ───────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface RouteSegment {
  from: LatLng;
  to: LatLng;
  /** Cumulative distance in meters from the start of the route. */
  cumulativeMeters: number;
  /** Segment distance in meters. */
  segmentMeters: number;
  /** Normalized position along route (0–1). */
  progress: number;
}

export interface RouteData {
  /** Decoded lat/lng coordinate array. */
  coordinates: LatLng[];
  /** Projected x/y points normalized to a viewBox. */
  projectedPoints: Point[];
  /** SVG path `d` attribute string. */
  svgPath: string;
  /** Route bounding box in geographic coordinates. */
  bounds: BoundingBox;
  /** Total route distance in meters (haversine). */
  totalDistanceMeters: number;
  /** Route segments with cumulative/segment distances. */
  segments: RouteSegment[];
  /** Compass bearing from start to end (degrees, 0=N, 90=E). */
  bearing: number;
  /** Start coordinate. */
  start: LatLng;
  /** End coordinate. */
  end: LatLng;
  /** Whether this is an out-and-back or loop (end within 15% of start distance). */
  isLoop: boolean;
}

// ─── Polyline Decoder ────────────────────────────────────────

/**
 * Decode a Google Encoded Polyline string into an array of LatLng coordinates.
 * Reference: https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded: string): LatLng[] {
  const coordinates: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    // Decode latitude
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    // Decode longitude
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return coordinates;
}

// ─── Haversine Distance ──────────────────────────────────────

const EARTH_RADIUS_M = 6_371_000;

/** Calculate distance between two coordinates in meters (haversine formula). */
export function haversineDistance(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// ─── Bearing ─────────────────────────────────────────────────

/** Calculate initial bearing from point A to point B (degrees, 0=N). */
export function calculateBearing(a: LatLng, b: LatLng): number {
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

/** Convert bearing degrees to a compass direction label. */
export function bearingToCompass(degrees: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(degrees / 45) % 8];
}

// ─── Coordinate Projection ───────────────────────────────────

/**
 * Project lat/lng coordinates to normalized x/y points within a viewBox.
 * Uses equirectangular projection with latitude correction (cosine).
 * Returns points normalized to 0–width / 0–height with padding.
 */
export function projectCoordinates(
  coords: LatLng[],
  width: number,
  height: number,
  padding: number = 0.1
): Point[] {
  if (coords.length === 0) return [];

  const bounds = getBoundingBox(coords);
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const cosLat = Math.cos(toRad(midLat));

  // Apply longitude correction for latitude
  const lngSpan = (bounds.maxLng - bounds.minLng) * cosLat;
  const latSpan = bounds.maxLat - bounds.minLat;

  // Prevent division by zero for single-point or straight-line routes
  const effectiveLngSpan = Math.max(lngSpan, 0.0001);
  const effectiveLat = Math.max(latSpan, 0.0001);

  // Calculate scale to fit both dimensions with aspect ratio preserved
  const paddedWidth = width * (1 - 2 * padding);
  const paddedHeight = height * (1 - 2 * padding);
  const scaleX = paddedWidth / effectiveLngSpan;
  const scaleY = paddedHeight / effectiveLat;
  const scale = Math.min(scaleX, scaleY);

  // Center the route in the viewport
  const offsetX = (width - effectiveLngSpan * scale) / 2;
  const offsetY = (height - effectiveLat * scale) / 2;

  return coords.map((c) => ({
    x: offsetX + (c.lng - bounds.minLng) * cosLat * scale,
    y: offsetY + (bounds.maxLat - c.lat) * scale, // Flip Y (SVG origin top-left)
  }));
}

// ─── Route Building ──────────────────────────────────────────

/** Calculate bounding box for a coordinate array. */
export function getBoundingBox(coords: LatLng[]): BoundingBox {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;
  for (const c of coords) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lng < minLng) minLng = c.lng;
    if (c.lng > maxLng) maxLng = c.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/** Simplify a coordinate array using the Ramer-Douglas-Peucker algorithm. */
export function simplifyRoute(coords: LatLng[], epsilon: number = 0.00005): LatLng[] {
  if (coords.length <= 2) return coords;

  // Find the point with the maximum distance from the line start→end
  let maxDist = 0;
  let maxIdx = 0;
  const start = coords[0];
  const end = coords[coords.length - 1];

  for (let i = 1; i < coords.length - 1; i++) {
    const d = perpendicularDistance(coords[i], start, end);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyRoute(coords.slice(0, maxIdx + 1), epsilon);
    const right = simplifyRoute(coords.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  return [start, end];
}

function perpendicularDistance(point: LatLng, lineStart: LatLng, lineEnd: LatLng): number {
  const dx = lineEnd.lng - lineStart.lng;
  const dy = lineEnd.lat - lineStart.lat;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((point.lng - lineStart.lng) ** 2 + (point.lat - lineStart.lat) ** 2);
  const t = Math.max(0, Math.min(1, ((point.lng - lineStart.lng) * dx + (point.lat - lineStart.lat) * dy) / lenSq));
  const projLng = lineStart.lng + t * dx;
  const projLat = lineStart.lat + t * dy;
  return Math.sqrt((point.lng - projLng) ** 2 + (point.lat - projLat) ** 2);
}

/** Build route segments with cumulative distance data. */
function buildSegments(coords: LatLng[]): { segments: RouteSegment[]; totalDistance: number } {
  const segments: RouteSegment[] = [];
  let cumulative = 0;

  for (let i = 1; i < coords.length; i++) {
    const segDist = haversineDistance(coords[i - 1], coords[i]);
    cumulative += segDist;
    segments.push({
      from: coords[i - 1],
      to: coords[i],
      cumulativeMeters: cumulative,
      segmentMeters: segDist,
      progress: 0, // Set after total is known
    });
  }

  for (const seg of segments) {
    seg.progress = cumulative > 0 ? seg.cumulativeMeters / cumulative : 0;
  }

  return { segments, totalDistance: cumulative };
}

/** Build an SVG path `d` string from projected points. */
function buildSvgPath(points: Point[]): string {
  if (points.length === 0) return '';
  const parts = [`M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`];
  for (let i = 1; i < points.length; i++) {
    parts.push(`L ${points[i].x.toFixed(2)} ${points[i].y.toFixed(2)}`);
  }
  return parts.join(' ');
}

// ─── Main API ────────────────────────────────────────────────

/** Default SVG viewBox dimensions. */
const DEFAULT_WIDTH = 400;
const DEFAULT_HEIGHT = 300;

/**
 * Process an encoded polyline into a full RouteData object.
 * This is the main entry point for route visualization.
 */
export function processRoute(
  encodedPolyline: string,
  width: number = DEFAULT_WIDTH,
  height: number = DEFAULT_HEIGHT,
): RouteData | null {
  if (!encodedPolyline) return null;

  const raw = decodePolyline(encodedPolyline);
  if (raw.length < 2) return null;

  // Simplify for performance (summary polylines are already simplified, but just in case)
  const coordinates = raw.length > 500 ? simplifyRoute(raw, 0.00003) : raw;
  const bounds = getBoundingBox(coordinates);
  const projectedPoints = projectCoordinates(coordinates, width, height);
  const svgPath = buildSvgPath(projectedPoints);
  const { segments, totalDistance } = buildSegments(coordinates);

  const start = coordinates[0];
  const end = coordinates[coordinates.length - 1];
  const bearing = calculateBearing(start, end);
  const startEndDist = haversineDistance(start, end);
  const isLoop = totalDistance > 0 && startEndDist / totalDistance < 0.15;

  return {
    coordinates,
    projectedPoints,
    svgPath,
    bounds,
    totalDistanceMeters: totalDistance,
    segments,
    bearing,
    start,
    end,
    isLoop,
  };
}

// ─── Local Caching ───────────────────────────────────────────

const ROUTE_CACHE_KEY = 'apollo_route_cache';
const MAX_CACHED_ROUTES = 200;

interface RouteCacheEntry {
  activityId: number;
  polyline: string;
  cachedAt: number;
}

function getRouteCache(): RouteCacheEntry[] {
  try {
    const raw = persistence.getItem(ROUTE_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setRouteCache(entries: RouteCacheEntry[]): void {
  persistence.setItem(ROUTE_CACHE_KEY, JSON.stringify(entries));
}

/** Cache a route polyline for an activity. */
export function cacheRoute(activityId: number, polyline: string): void {
  const cache = getRouteCache();
  const existing = cache.findIndex((e) => e.activityId === activityId);
  if (existing >= 0) {
    cache[existing].polyline = polyline;
    cache[existing].cachedAt = Date.now();
  } else {
    cache.unshift({ activityId, polyline, cachedAt: Date.now() });
    // Evict oldest entries beyond the limit
    if (cache.length > MAX_CACHED_ROUTES) cache.length = MAX_CACHED_ROUTES;
  }
  setRouteCache(cache);
}

/** Retrieve a cached route polyline for an activity. */
export function getCachedRoute(activityId: number): string | null {
  const cache = getRouteCache();
  const entry = cache.find((e) => e.activityId === activityId);
  return entry?.polyline ?? null;
}

/** Get the polyline for an activity: from the activity object or local cache. */
export function getPolylineForActivity(activity: { id: number; map?: { summary_polyline: string | null } | null }): string | null {
  // Prefer the polyline from the activity data
  const fromActivity = activity.map?.summary_polyline;
  if (fromActivity) {
    // Cache it locally for future offline access
    cacheRoute(activity.id, fromActivity);
    return fromActivity;
  }
  // Fall back to local cache
  return getCachedRoute(activity.id);
}

// ─── Route Stats Formatting ─────────────────────────────────

export function formatRouteDistance(meters: number): string {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

/** Get distance markers along a route (every km or mile). */
export function getDistanceMarkers(
  route: RouteData,
  intervalMeters: number = 1609.34, // 1 mile
): { point: Point; label: string; progress: number }[] {
  const markers: { point: Point; label: string; progress: number }[] = [];
  if (route.totalDistanceMeters === 0) return markers;

  let nextMarker = intervalMeters;
  let markerCount = 1;

  for (const seg of route.segments) {
    while (nextMarker <= seg.cumulativeMeters && markerCount <= 50) {
      const progress = nextMarker / route.totalDistanceMeters;
      // Interpolate position
      const segStart = seg.cumulativeMeters - seg.segmentMeters;
      const t = seg.segmentMeters > 0 ? (nextMarker - segStart) / seg.segmentMeters : 0;
      const idx = route.segments.indexOf(seg);
      const fromPt = route.projectedPoints[idx];
      const toPt = route.projectedPoints[idx + 1];
      if (fromPt && toPt) {
        markers.push({
          point: { x: fromPt.x + (toPt.x - fromPt.x) * t, y: fromPt.y + (toPt.y - fromPt.y) * t },
          label: `${markerCount}`,
          progress,
        });
      }
      markerCount++;
      nextMarker += intervalMeters;
    }
  }

  return markers;
}
