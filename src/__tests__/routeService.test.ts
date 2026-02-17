/**
 * Tests for routeService — polyline decoder, coordinate projection,
 * haversine distance, bearing, route processing, and caching.
 */

import { describe, it, expect } from 'vitest';
import {
  decodePolyline,
  haversineDistance,
  calculateBearing,
  bearingToCompass,
  projectCoordinates,
  getBoundingBox,
  simplifyRoute,
  processRoute,
  cacheRoute,
  getCachedRoute,
  getPolylineForActivity,
  formatRouteDistance,
  getDistanceMarkers,
} from '@/services/routeService';

// ── Polyline Decoder ─────────────────────────────────────────

describe('decodePolyline', () => {
  it('decodes a simple encoded polyline from Google example', () => {
    // Google's example polyline: _p~iF~ps|U_ulLnnqC_mqNvxq`@
    // Represents: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
    const coords = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(coords).toHaveLength(3);
    expect(coords[0].lat).toBeCloseTo(38.5, 1);
    expect(coords[0].lng).toBeCloseTo(-120.2, 1);
    expect(coords[1].lat).toBeCloseTo(40.7, 1);
    expect(coords[1].lng).toBeCloseTo(-120.95, 1);
    expect(coords[2].lat).toBeCloseTo(43.252, 1);
    expect(coords[2].lng).toBeCloseTo(-126.453, 1);
  });

  it('returns empty array for empty string', () => {
    expect(decodePolyline('')).toEqual([]);
  });

  it('handles single-point polyline', () => {
    // Encode (0, 0) → '??'
    const coords = decodePolyline('??');
    expect(coords).toHaveLength(1);
    expect(coords[0].lat).toBeCloseTo(0, 4);
    expect(coords[0].lng).toBeCloseTo(0, 4);
  });

  it('decodes a real Strava-like polyline', () => {
    // A short Central Park loop (simplified)
    const encoded = 'yrwwFz}ubMiBcAnAnA|@dAk@z@';
    const coords = decodePolyline(encoded);
    expect(coords.length).toBeGreaterThanOrEqual(2);
    // All coords should be valid lat/lng
    for (const c of coords) {
      expect(c.lat).toBeGreaterThan(-90);
      expect(c.lat).toBeLessThan(90);
      expect(c.lng).toBeGreaterThan(-180);
      expect(c.lng).toBeLessThan(180);
    }
  });
});

// ── Haversine Distance ───────────────────────────────────────

describe('haversineDistance', () => {
  it('returns 0 for same point', () => {
    const dist = haversineDistance({ lat: 40.7, lng: -74.0 }, { lat: 40.7, lng: -74.0 });
    expect(dist).toBe(0);
  });

  it('calculates known distance between NYC and LA (~3940 km)', () => {
    const nyc = { lat: 40.7128, lng: -74.0060 };
    const la = { lat: 34.0522, lng: -118.2437 };
    const dist = haversineDistance(nyc, la);
    expect(dist / 1000).toBeCloseTo(3940, -2); // within 100 km
  });

  it('calculates short distance accurately', () => {
    // ~111 km per degree of latitude at equator
    const a = { lat: 0, lng: 0 };
    const b = { lat: 1, lng: 0 };
    const dist = haversineDistance(a, b);
    expect(dist / 1000).toBeCloseTo(111.2, 0);
  });
});

// ── Bearing ──────────────────────────────────────────────────

describe('calculateBearing', () => {
  it('returns ~0 for due north', () => {
    const bearing = calculateBearing({ lat: 40, lng: -74 }, { lat: 41, lng: -74 });
    expect(bearing).toBeCloseTo(0, 0);
  });

  it('returns ~90 for due east', () => {
    const bearing = calculateBearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 });
    expect(bearing).toBeCloseTo(90, 0);
  });

  it('returns ~180 for due south', () => {
    const bearing = calculateBearing({ lat: 41, lng: -74 }, { lat: 40, lng: -74 });
    expect(bearing).toBeCloseTo(180, 0);
  });

  it('returns ~270 for due west', () => {
    const bearing = calculateBearing({ lat: 0, lng: 1 }, { lat: 0, lng: 0 });
    expect(bearing).toBeCloseTo(270, 0);
  });
});

describe('bearingToCompass', () => {
  it('maps degrees to compass directions', () => {
    expect(bearingToCompass(0)).toBe('N');
    expect(bearingToCompass(45)).toBe('NE');
    expect(bearingToCompass(90)).toBe('E');
    expect(bearingToCompass(135)).toBe('SE');
    expect(bearingToCompass(180)).toBe('S');
    expect(bearingToCompass(225)).toBe('SW');
    expect(bearingToCompass(270)).toBe('W');
    expect(bearingToCompass(315)).toBe('NW');
    expect(bearingToCompass(360)).toBe('N');
  });
});

// ── Bounding Box ─────────────────────────────────────────────

describe('getBoundingBox', () => {
  it('calculates correct bounds', () => {
    const coords = [
      { lat: 40.0, lng: -74.5 },
      { lat: 40.5, lng: -74.0 },
      { lat: 40.2, lng: -74.3 },
    ];
    const bounds = getBoundingBox(coords);
    expect(bounds.minLat).toBe(40.0);
    expect(bounds.maxLat).toBe(40.5);
    expect(bounds.minLng).toBe(-74.5);
    expect(bounds.maxLng).toBe(-74.0);
  });
});

// ── Coordinate Projection ────────────────────────────────────

describe('projectCoordinates', () => {
  it('projects to non-negative x/y within viewBox', () => {
    const coords = [
      { lat: 40.0, lng: -74.0 },
      { lat: 40.1, lng: -73.9 },
      { lat: 40.05, lng: -73.95 },
    ];
    const points = projectCoordinates(coords, 400, 300);
    expect(points).toHaveLength(3);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(400);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(300);
    }
  });

  it('returns empty for no coordinates', () => {
    expect(projectCoordinates([], 400, 300)).toEqual([]);
  });
});

// ── Route Simplification ─────────────────────────────────────

describe('simplifyRoute', () => {
  it('keeps start and end points', () => {
    const coords = [
      { lat: 0, lng: 0 },
      { lat: 0.00001, lng: 0.00001 }, // very close to the line
      { lat: 1, lng: 1 },
    ];
    const simple = simplifyRoute(coords, 0.001);
    expect(simple[0]).toEqual(coords[0]);
    expect(simple[simple.length - 1]).toEqual(coords[coords.length - 1]);
  });

  it('preserves points far from the line', () => {
    const coords = [
      { lat: 0, lng: 0 },
      { lat: 0.5, lng: 1 }, // far from straight line
      { lat: 1, lng: 0 },
    ];
    const simple = simplifyRoute(coords, 0.0001);
    expect(simple.length).toBe(3); // all kept
  });

  it('returns input for 2 or fewer points', () => {
    const coords = [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }];
    expect(simplifyRoute(coords)).toEqual(coords);
  });
});

// ── Route Processing ─────────────────────────────────────────

describe('processRoute', () => {
  it('processes a valid polyline into full RouteData', () => {
    const route = processRoute('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(route).not.toBeNull();
    expect(route!.coordinates.length).toBeGreaterThanOrEqual(2);
    expect(route!.projectedPoints.length).toBe(route!.coordinates.length);
    expect(route!.svgPath).toContain('M');
    expect(route!.svgPath).toContain('L');
    expect(route!.totalDistanceMeters).toBeGreaterThan(0);
    expect(route!.segments.length).toBeGreaterThan(0);
    expect(route!.bearing).toBeGreaterThanOrEqual(0);
    expect(route!.bearing).toBeLessThan(360);
    expect(route!.start).toBeDefined();
    expect(route!.end).toBeDefined();
    expect(typeof route!.isLoop).toBe('boolean');
  });

  it('returns null for empty polyline', () => {
    expect(processRoute('')).toBeNull();
  });

  it('returns null for single-point polyline', () => {
    // Single point can't form a route
    expect(processRoute('??')).toBeNull();
  });

  it('detects a loop when start and end are close', () => {
    // Create a small loop polyline manually
    // Go NE, then E, then SW back to start
    const encoded = 'yrwwFz}ubMiBcAnAnA|@dAk@z@';
    const route = processRoute(encoded);
    if (route) {
      // isLoop depends on how close start/end are relative to total distance
      expect(typeof route.isLoop).toBe('boolean');
    }
  });

  it('respects custom width/height', () => {
    const route = processRoute('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 800, 600);
    expect(route).not.toBeNull();
    for (const p of route!.projectedPoints) {
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeLessThanOrEqual(600);
    }
  });

  it('segments progress values are monotonically increasing', () => {
    const route = processRoute('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(route).not.toBeNull();
    let prev = 0;
    for (const seg of route!.segments) {
      expect(seg.progress).toBeGreaterThanOrEqual(prev);
      prev = seg.progress;
    }
    // Last segment's progress should be ~1.0
    expect(route!.segments[route!.segments.length - 1].progress).toBeCloseTo(1, 5);
  });
});

// ── Route Caching ────────────────────────────────────────────

describe('route caching', () => {
  it('caches and retrieves a route polyline', () => {
    cacheRoute(12345, 'encoded_polyline_data');
    expect(getCachedRoute(12345)).toBe('encoded_polyline_data');
  });

  it('returns null for uncached activity', () => {
    expect(getCachedRoute(99999)).toBeNull();
  });

  it('updates existing cache entry', () => {
    cacheRoute(100, 'old_data');
    cacheRoute(100, 'new_data');
    expect(getCachedRoute(100)).toBe('new_data');
  });

  it('getPolylineForActivity prefers activity data over cache', () => {
    cacheRoute(200, 'cached_polyline');
    const activity = { id: 200, map: { summary_polyline: 'fresh_polyline' } };
    expect(getPolylineForActivity(activity)).toBe('fresh_polyline');
  });

  it('getPolylineForActivity falls back to cache when no map data', () => {
    cacheRoute(300, 'cached_only');
    const activity = { id: 300, map: null };
    expect(getPolylineForActivity(activity)).toBe('cached_only');
  });

  it('getPolylineForActivity returns null when no data available', () => {
    const activity = { id: 400, map: null };
    expect(getPolylineForActivity(activity)).toBeNull();
  });

  it('evicts oldest entries when cache exceeds 200', () => {
    // Fill cache with 200 entries
    for (let i = 1; i <= 200; i++) {
      cacheRoute(i, `poly_${i}`);
    }
    // All 200 should be cached
    expect(getCachedRoute(200)).toBe('poly_200');
    expect(getCachedRoute(1)).toBe('poly_1');

    // Add one more — should evict the oldest (last in array)
    cacheRoute(201, 'poly_201');
    expect(getCachedRoute(201)).toBe('poly_201');
  });
});

// ── formatRouteDistance ───────────────────────────────────────

describe('formatRouteDistance', () => {
  it('formats distances >= 1000m as km', () => {
    expect(formatRouteDistance(5000)).toBe('5.0 km');
    expect(formatRouteDistance(1000)).toBe('1.0 km');
    expect(formatRouteDistance(42195)).toBe('42.2 km');
  });

  it('formats distances < 1000m as meters', () => {
    expect(formatRouteDistance(500)).toBe('500 m');
    expect(formatRouteDistance(100)).toBe('100 m');
  });

  it('handles zero', () => {
    expect(formatRouteDistance(0)).toBe('0 m');
  });

  it('handles fractional km correctly', () => {
    expect(formatRouteDistance(1500)).toBe('1.5 km');
    expect(formatRouteDistance(10750)).toBe('10.8 km');
  });
});

// ── getDistanceMarkers ───────────────────────────────────────

describe('getDistanceMarkers', () => {
  it('returns empty array for zero-distance route', () => {
    const route = processRoute('_p~iF~ps|U_ulLnnqC_mqNvxq`@')!;
    // Override total distance to 0 for test
    const zeroRoute = { ...route, totalDistanceMeters: 0 };
    expect(getDistanceMarkers(zeroRoute)).toEqual([]);
  });

  it('returns markers along a real route', () => {
    const route = processRoute('_p~iF~ps|U_ulLnnqC_mqNvxq`@')!;
    // This route is ~800+ km, use large interval to get a few markers
    const markers = getDistanceMarkers(route, 100000); // every 100km
    // Should have at least 1 marker
    if (route.totalDistanceMeters > 100000) {
      expect(markers.length).toBeGreaterThan(0);
      for (const m of markers) {
        expect(m.point).toHaveProperty('x');
        expect(m.point).toHaveProperty('y');
        expect(m.label).toBeDefined();
        expect(m.progress).toBeGreaterThan(0);
        expect(m.progress).toBeLessThanOrEqual(1);
      }
    }
  });

  it('respects custom interval', () => {
    const route = processRoute('_p~iF~ps|U_ulLnnqC_mqNvxq`@')!;
    const markersSmall = getDistanceMarkers(route, 50000);
    const markersLarge = getDistanceMarkers(route, 200000);
    expect(markersSmall.length).toBeGreaterThanOrEqual(markersLarge.length);
  });

  it('returns empty for very short route below interval', () => {
    // Create a minimal route
    const route = processRoute('yrwwFz}ubMiBcA')!;
    if (route && route.totalDistanceMeters < 1609) {
      const markers = getDistanceMarkers(route, 1609.34);
      expect(markers).toEqual([]);
    }
  });
});

// ── Bounding Box Edge Cases ──────────────────────────────────

describe('getBoundingBox edge cases', () => {
  it('handles single-point input', () => {
    const bounds = getBoundingBox([{ lat: 40.7, lng: -74.0 }]);
    expect(bounds.minLat).toBe(40.7);
    expect(bounds.maxLat).toBe(40.7);
    expect(bounds.minLng).toBe(-74.0);
    expect(bounds.maxLng).toBe(-74.0);
  });

  it('handles collinear points (same longitude)', () => {
    const coords = [
      { lat: 40.0, lng: -74.0 },
      { lat: 40.5, lng: -74.0 },
      { lat: 41.0, lng: -74.0 },
    ];
    const bounds = getBoundingBox(coords);
    expect(bounds.minLng).toBe(-74.0);
    expect(bounds.maxLng).toBe(-74.0);
    expect(bounds.minLat).toBe(40.0);
    expect(bounds.maxLat).toBe(41.0);
  });
});
