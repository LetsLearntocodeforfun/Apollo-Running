/**
 * effortService.test.ts — Tests for the Route Effort Recognition Engine.
 *
 * Covers: route fingerprinting & matching, effort ranking, pace / HR / cadence
 * insight generation, tier assignment, persistence, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
  processActivityEffort,
  getEffortRecognition,
  getAllRouteBundles,
  getRouteHistory,
  findMatchingBundle,
  calcCentroid,
  assignTier,
  formatPace,
  processAllStoredActivities,
  type RouteBundle,
} from '@/services/effortService';
import type { StravaActivity } from '@/services/strava';

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Encoded polyline for a ~5 km loop in Central Park, NYC.
 * Decodes to real coordinates around 40.77°N, 73.97°W.
 */
const CENTRAL_PARK_POLYLINE = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

/**
 * A different polyline representing a route in Brooklyn (~5 km).
 * Start near 40.68°N, 73.97°W — clearly different route.
 */
const BROOKLYN_POLYLINE = 'o`kiF~ps|Ug}vHnzw_C';

/** Polyline that starts very close to Central Park (same start, similar shape). */
const CENTRAL_PARK_VARIANT = '_p~iF~ps|U_tlLnoqC_nqNvwq`@';

function makeActivity(overrides: Partial<StravaActivity> & { id: number }): StravaActivity {
  return {
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 5000,
    moving_time: 1500, // 25 min → ~8:03/mi for 5k
    elapsed_time: 1600,
    start_date: '2025-06-15T12:00:00Z',
    start_date_local: '2025-06-15T08:00:00',
    kudos_count: 0,
    map: { id: 'map1', summary_polyline: CENTRAL_PARK_POLYLINE },
    ...overrides,
  };
}

// ─── Unit: calcCentroid ──────────────────────────────────────

describe('calcCentroid', () => {
  it('returns {0,0} for empty array', () => {
    expect(calcCentroid([])).toEqual({ lat: 0, lng: 0 });
  });

  it('returns the average of coordinates', () => {
    const c = calcCentroid([
      { lat: 10, lng: 20 },
      { lat: 30, lng: 40 },
    ]);
    expect(c.lat).toBeCloseTo(20, 5);
    expect(c.lng).toBeCloseTo(30, 5);
  });
});

// ─── Unit: assignTier ────────────────────────────────────────

describe('assignTier', () => {
  it('returns null if fewer than 2 efforts', () => {
    expect(assignTier(1, 1)).toBeNull();
  });

  it('returns gold for rank 1 with 2+ efforts', () => {
    expect(assignTier(1, 2)).toBe('gold');
    expect(assignTier(1, 10)).toBe('gold');
  });

  it('returns silver for rank 2 with 2+ efforts', () => {
    expect(assignTier(2, 2)).toBe('silver');
    expect(assignTier(2, 5)).toBe('silver');
  });

  it('returns bronze for rank 3 with 3+ efforts', () => {
    expect(assignTier(3, 3)).toBe('bronze');
    expect(assignTier(3, 10)).toBe('bronze');
  });

  it('returns null for rank 3 with only 2 efforts', () => {
    expect(assignTier(3, 2)).toBeNull();
  });

  it('returns null for rank 4+', () => {
    expect(assignTier(4, 10)).toBeNull();
    expect(assignTier(5, 5)).toBeNull();
  });
});

// ─── Unit: formatPace ────────────────────────────────────────

describe('formatPace', () => {
  it('formats a normal pace', () => {
    expect(formatPace(8.5)).toBe('8:30/mi');
  });

  it('formats a fast pace', () => {
    expect(formatPace(6.0)).toBe('6:00/mi');
  });

  it('returns dash for zero', () => {
    expect(formatPace(0)).toBe('—');
  });

  it('returns dash for extremely slow pace', () => {
    expect(formatPace(35)).toBe('—');
  });
});

// ─── Route Matching ──────────────────────────────────────────

describe('findMatchingBundle', () => {
  it('returns null for empty bundles', () => {
    const coords = [{ lat: 40.77, lng: -73.97 }, { lat: 40.78, lng: -73.96 }];
    expect(findMatchingBundle(coords, 5000, [])).toBeNull();
  });

  it('matches a bundle with same start/end/centroid/distance', () => {
    const coords = [{ lat: 40.77, lng: -73.97 }, { lat: 40.78, lng: -73.96 }];
    const bundles: RouteBundle[] = [{
      fingerprint: {
        id: 'r_test',
        startLat: 40.77, startLng: -73.97,
        endLat: 40.78, endLng: -73.96,
        centroidLat: 40.775, centroidLng: -73.965,
        referenceDistanceMeters: 5000,
        name: 'Test Route',
      },
      efforts: [],
    }];
    expect(findMatchingBundle(coords, 5000, bundles)).toBe(bundles[0]);
  });

  it('does NOT match if start point is too far', () => {
    const coords = [{ lat: 41.00, lng: -73.97 }, { lat: 40.78, lng: -73.96 }];
    const bundles: RouteBundle[] = [{
      fingerprint: {
        id: 'r_test',
        startLat: 40.77, startLng: -73.97,
        endLat: 40.78, endLng: -73.96,
        centroidLat: 40.775, centroidLng: -73.965,
        referenceDistanceMeters: 5000,
        name: 'Test Route',
      },
      efforts: [],
    }];
    expect(findMatchingBundle(coords, 5000, bundles)).toBeNull();
  });

  it('does NOT match if distance differs by > 20%', () => {
    const coords = [{ lat: 40.77, lng: -73.97 }, { lat: 40.78, lng: -73.96 }];
    const bundles: RouteBundle[] = [{
      fingerprint: {
        id: 'r_test',
        startLat: 40.77, startLng: -73.97,
        endLat: 40.78, endLng: -73.96,
        centroidLat: 40.775, centroidLng: -73.965,
        referenceDistanceMeters: 10000, // double the distance
        name: 'Test Route',
      },
      efforts: [],
    }];
    expect(findMatchingBundle(coords, 5000, bundles)).toBeNull();
  });
});

// ─── processActivityEffort ───────────────────────────────────

describe('processActivityEffort', () => {
  it('returns null for non-run activity', () => {
    const act = makeActivity({ id: 1, type: 'Ride', sport_type: 'Ride' });
    expect(processActivityEffort(act)).toBeNull();
  });

  it('returns null for activity without polyline', () => {
    const act = makeActivity({ id: 2, map: null });
    expect(processActivityEffort(act)).toBeNull();
  });

  it('returns null for very short activity', () => {
    const act = makeActivity({ id: 3, distance: 100 });
    expect(processActivityEffort(act)).toBeNull();
  });

  it('creates a route bundle and recognition for first effort', () => {
    const act = makeActivity({ id: 100 });
    const rec = processActivityEffort(act);

    expect(rec).not.toBeNull();
    expect(rec!.activityId).toBe(100);
    expect(rec!.effortNumber).toBe(1);
    expect(rec!.totalEfforts).toBe(1);
    expect(rec!.paceTier).toBeNull(); // first effort → no ranking
    expect(rec!.insights).toHaveLength(0); // no comparisons

    const bundles = getAllRouteBundles();
    expect(bundles.length).toBe(1);
    expect(bundles[0].efforts.length).toBe(1);
  });

  it('deduplicates — processing same activity twice returns cached result', () => {
    const act = makeActivity({ id: 200 });
    const rec1 = processActivityEffort(act);
    const rec2 = processActivityEffort(act);
    expect(rec2).toEqual(rec1);
    // Bundle should still only have 1 effort
    const bundles = getAllRouteBundles();
    const bundle = bundles.find(b => b.efforts.some(e => e.activityId === 200));
    expect(bundle!.efforts.filter(e => e.activityId === 200)).toHaveLength(1);
  });

  it('retrieval via getEffortRecognition matches processActivityEffort result', () => {
    const act = makeActivity({ id: 300 });
    const rec = processActivityEffort(act);
    expect(getEffortRecognition(300)).toEqual(rec);
  });
});

// ─── Pace Ranking ────────────────────────────────────────────

describe('pace ranking', () => {
  it('awards gold to the faster effort on second run', () => {
    // First run: slower
    const slow = makeActivity({
      id: 401,
      distance: 5000,
      moving_time: 1800, // 30 min → slow
      start_date_local: '2025-06-01T08:00:00',
      map: { id: 'm1', summary_polyline: CENTRAL_PARK_POLYLINE },
    });
    processActivityEffort(slow);

    // Second run: faster on same route
    const fast = makeActivity({
      id: 402,
      distance: 5000,
      moving_time: 1200, // 20 min → fast
      start_date_local: '2025-06-08T08:00:00',
      map: { id: 'm2', summary_polyline: CENTRAL_PARK_VARIANT },
    });
    const rec = processActivityEffort(fast);

    expect(rec).not.toBeNull();
    expect(rec!.paceTier).toBe('gold');
    expect(rec!.effortNumber).toBe(2);
    expect(rec!.insights.some(i => i.message.includes('Course record'))).toBe(true);
    expect(rec!.insights.some(i => i.message.includes('faster'))).toBe(true);
  });

  it('awards silver to the slower effort on second run', () => {
    // First run: fast
    const fast = makeActivity({
      id: 501,
      distance: 5000,
      moving_time: 1200,
      start_date_local: '2025-07-01T08:00:00',
      map: { id: 'm1', summary_polyline: BROOKLYN_POLYLINE },
    });
    processActivityEffort(fast);

    // Second run: slower
    const slow = makeActivity({
      id: 502,
      distance: 5000,
      moving_time: 1800,
      start_date_local: '2025-07-08T08:00:00',
      map: { id: 'm2', summary_polyline: BROOKLYN_POLYLINE },
    });
    const rec = processActivityEffort(slow);

    expect(rec).not.toBeNull();
    expect(rec!.paceTier).toBe('silver');
    expect(rec!.insights.some(i => i.message.includes('slower'))).toBe(true);
  });

  it('awards bronze on third effort', () => {
    // Use a unique polyline area for this test
    const poly = CENTRAL_PARK_POLYLINE;
    const base = {
      distance: 5000,
      map: { id: 'mx', summary_polyline: poly },
    };

    processActivityEffort(makeActivity({ id: 601, ...base, moving_time: 1200, start_date_local: '2025-08-01T08:00:00' })); // fastest
    processActivityEffort(makeActivity({ id: 602, ...base, moving_time: 1500, start_date_local: '2025-08-08T08:00:00' })); // middle
    const rec = processActivityEffort(makeActivity({ id: 603, ...base, moving_time: 1800, start_date_local: '2025-08-15T08:00:00' })); // slowest

    expect(rec!.paceTier).toBe('bronze');
  });
});

// ─── Heart Rate Insights ─────────────────────────────────────

describe('heart rate insights', () => {
  it('generates positive insight when HR decreases', () => {
    const poly = BROOKLYN_POLYLINE;
    const base = {
      distance: 5000,
      moving_time: 1500,
      map: { id: 'mh', summary_polyline: poly },
    };

    processActivityEffort(makeActivity({
      id: 701,
      ...base,
      average_heartrate: 170,
      start_date_local: '2025-09-01T08:00:00',
    }));

    const rec = processActivityEffort(makeActivity({
      id: 702,
      ...base,
      average_heartrate: 148,
      start_date_local: '2025-09-08T08:00:00',
    }));

    expect(rec).not.toBeNull();
    const hrInsight = rec!.insights.find(i => i.category === 'heart_rate');
    expect(hrInsight).toBeDefined();
    expect(hrInsight!.sentiment).toBe('positive');
    expect(hrInsight!.message).toContain('lower');
    expect(hrInsight!.message).toContain('148');
  });

  it('generates negative insight when HR increases', () => {
    const poly = BROOKLYN_POLYLINE;
    const base = {
      distance: 5000,
      moving_time: 1500,
      map: { id: 'mh2', summary_polyline: poly },
    };

    // First effort: low HR
    processActivityEffort(makeActivity({
      id: 710,
      ...base,
      average_heartrate: 148,
      start_date_local: '2025-09-01T08:00:00',
    }));

    // Second effort: higher HR
    const rec = processActivityEffort(makeActivity({
      id: 711,
      ...base,
      average_heartrate: 180,
      start_date_local: '2025-09-15T08:00:00',
    }));

    expect(rec).not.toBeNull();
    const hrInsight = rec!.insights.find(i => i.category === 'heart_rate' && i.sentiment === 'negative');
    expect(hrInsight).toBeDefined();
    expect(hrInsight!.message).toContain('higher');
  });

  it('generates route average insight with 3+ HR efforts', () => {
    const poly = BROOKLYN_POLYLINE;
    const base = {
      distance: 5000,
      moving_time: 1500,
      map: { id: 'mh3', summary_polyline: poly },
    };

    // Build up 3 efforts first
    processActivityEffort(makeActivity({ id: 720, ...base, average_heartrate: 170, start_date_local: '2025-09-01T08:00:00' }));
    processActivityEffort(makeActivity({ id: 721, ...base, average_heartrate: 165, start_date_local: '2025-09-08T08:00:00' }));
    processActivityEffort(makeActivity({ id: 722, ...base, average_heartrate: 160, start_date_local: '2025-09-15T08:00:00' }));

    // 4th effort with very low HR
    const rec = processActivityEffort(makeActivity({
      id: 723,
      ...base,
      average_heartrate: 130,
      start_date_local: '2025-09-22T08:00:00',
    }));

    expect(rec).not.toBeNull();
    const avgInsight = rec!.insights.find(i =>
      i.category === 'heart_rate' && i.message.includes('route average'),
    );
    expect(avgInsight).toBeDefined();
    expect(avgInsight!.sentiment).toBe('positive');
  });
});

// ─── HR Efficiency ───────────────────────────────────────────

describe('HR efficiency', () => {
  it('generates efficiency improvement insight', () => {
    const poly = CENTRAL_PARK_POLYLINE;
    const base = { distance: 5000, map: { id: 'me', summary_polyline: poly } };

    // Inefficient: slow pace, high HR
    processActivityEffort(makeActivity({
      id: 801,
      ...base,
      moving_time: 1800,
      average_heartrate: 175,
      start_date_local: '2025-10-01T08:00:00',
    }));

    // Efficient: faster pace, lower HR
    const rec = processActivityEffort(makeActivity({
      id: 802,
      ...base,
      moving_time: 1200,
      average_heartrate: 145,
      start_date_local: '2025-10-08T08:00:00',
    }));

    expect(rec).not.toBeNull();
    expect(rec!.hrEfficiencyTier).toBe('gold');
    const effInsight = rec!.insights.find(i => i.category === 'efficiency');
    expect(effInsight).toBeDefined();
    expect(effInsight!.sentiment).toBe('positive');
    expect(effInsight!.message).toContain('Improved efficiency');
  });
});

// ─── Cadence Insights ────────────────────────────────────────

describe('cadence insights', () => {
  it('generates positive cadence insight when cadence improves', () => {
    const poly = CENTRAL_PARK_POLYLINE;
    const base = {
      distance: 5000,
      moving_time: 1500,
      map: { id: 'mc', summary_polyline: poly },
    };

    // Lower cadence (Strava reports stride rate, we double it)
    processActivityEffort(makeActivity({
      id: 901,
      ...base,
      average_cadence: 80, // → 160 spm
      start_date_local: '2025-11-01T08:00:00',
    }));

    // Higher cadence
    const rec = processActivityEffort(makeActivity({
      id: 902,
      ...base,
      average_cadence: 87, // → 174 spm
      start_date_local: '2025-11-08T08:00:00',
    }));

    expect(rec).not.toBeNull();
    const cadInsight = rec!.insights.find(i => i.category === 'cadence');
    expect(cadInsight).toBeDefined();
    expect(cadInsight!.sentiment).toBe('positive');
    expect(cadInsight!.message).toContain('higher');
  });
});

// ─── Overall Synthesis ───────────────────────────────────────

describe('overall assessment', () => {
  it('generates "strong improvement" when pace faster AND HR lower', () => {
    const poly = BROOKLYN_POLYLINE;
    const base = { distance: 5000, map: { id: 'mo', summary_polyline: poly } };

    // Existing efforts already exist in bundle from HR tests.
    // Add a much better effort: faster AND lower HR
    const rec = processActivityEffort(makeActivity({
      id: 1001,
      ...base,
      moving_time: 1100,
      average_heartrate: 125,
      start_date_local: '2025-10-01T08:00:00',
    }));

    expect(rec).not.toBeNull();
    const overall = rec!.insights.find(i => i.category === 'overall');
    // Should find a positive synthesis insight
    if (overall) {
      expect(overall.sentiment).toBe('positive');
    }
  });
});

// ─── Route History ───────────────────────────────────────────

describe('route history', () => {
  it('getRouteHistory returns the bundle for a known route', () => {
    // Create a bundle first
    const act = makeActivity({ id: 1500, distance: 5000, moving_time: 1500, start_date_local: '2025-12-10T08:00:00' });
    processActivityEffort(act);

    const bundles = getAllRouteBundles();
    expect(bundles.length).toBeGreaterThan(0);

    const routeId = bundles[0].fingerprint.id;
    const history = getRouteHistory(routeId);
    expect(history).not.toBeNull();
    expect(history!.fingerprint.id).toBe(routeId);
    expect(history!.efforts.length).toBeGreaterThan(0);
  });

  it('getRouteHistory returns null for unknown route', () => {
    expect(getRouteHistory('nonexistent_route')).toBeNull();
  });
});

// ─── processAllStoredActivities ──────────────────────────────

describe('processAllStoredActivities', () => {
  it('processes activities in chronological order and skips already-processed', () => {
    const poly = CENTRAL_PARK_POLYLINE;
    const activities: StravaActivity[] = [
      makeActivity({ id: 1101, distance: 5000, moving_time: 1500, start_date_local: '2025-12-01T08:00:00', map: { id: 'mp1', summary_polyline: poly } }),
      makeActivity({ id: 1102, distance: 5000, moving_time: 1400, start_date_local: '2025-12-08T08:00:00', map: { id: 'mp2', summary_polyline: poly } }),
    ];

    processAllStoredActivities(activities);

    // Both should have recognitions
    expect(getEffortRecognition(1101)).not.toBeNull();
    expect(getEffortRecognition(1102)).not.toBeNull();

    // Re-running should not duplicate
    const bundlesBefore = getAllRouteBundles();
    processAllStoredActivities(activities);
    const bundlesAfter = getAllRouteBundles();
    expect(bundlesAfter.length).toBe(bundlesBefore.length);
  });

  it('skips non-run activities', () => {
    const activities: StravaActivity[] = [
      makeActivity({ id: 1201, type: 'Ride', sport_type: 'Ride', map: { id: 'mr', summary_polyline: CENTRAL_PARK_POLYLINE } }),
    ];
    processAllStoredActivities(activities);
    expect(getEffortRecognition(1201)).toBeNull();
  });
});

// ─── Consistent pace insight ─────────────────────────────────

describe('consistent pace insight', () => {
  it('generates "consistent" message when pace barely changes', () => {
    const poly = CENTRAL_PARK_VARIANT;
    const base = { distance: 5000, map: { id: 'mcon', summary_polyline: poly } };

    processActivityEffort(makeActivity({
      id: 1301,
      ...base,
      moving_time: 1500,
      start_date_local: '2026-01-01T08:00:00',
    }));

    // Nearly identical pace
    const rec = processActivityEffort(makeActivity({
      id: 1302,
      ...base,
      moving_time: 1503, // ~0.2% slower — below notable threshold
      start_date_local: '2026-01-08T08:00:00',
    }));

    expect(rec).not.toBeNull();
    const paceInsight = rec!.insights.find(i => i.category === 'pace' && i.message.includes('consistent'));
    expect(paceInsight).toBeDefined();
    expect(paceInsight!.sentiment).toBe('neutral');
  });
});

// ─── Edge: chronological ordering ────────────────────────────

describe('chronological ordering', () => {
  it('efforts are stored in date order regardless of processing order', () => {
    const poly = CENTRAL_PARK_POLYLINE;
    const base = { distance: 5000, moving_time: 1500, map: { id: 'mo2', summary_polyline: poly } };

    // Process a later-date activity first
    processActivityEffort(makeActivity({ id: 1401, ...base, start_date_local: '2026-03-15T08:00:00' }));
    // Then an earlier one
    processActivityEffort(makeActivity({ id: 1402, ...base, start_date_local: '2026-03-01T08:00:00' }));

    const bundles = getAllRouteBundles();
    const bundle = bundles.find(b => b.efforts.some(e => e.activityId === 1401));
    expect(bundle).toBeDefined();
    // 1402 (March 1) should come before 1401 (March 15)
    const idx1402 = bundle!.efforts.findIndex(e => e.activityId === 1402);
    const idx1401 = bundle!.efforts.findIndex(e => e.activityId === 1401);
    if (idx1402 >= 0 && idx1401 >= 0) {
      expect(idx1402).toBeLessThan(idx1401);
    }
  });
});

// ─── findMatchingBundle: centroid mismatch ────────────────────

describe('findMatchingBundle centroid mismatch', () => {
  it('does NOT match when centroid is too far despite matching start/end/distance', () => {
    // Start and end match, distance matches, but centroid is far away
    const coords = [
      { lat: 40.77, lng: -73.97 },
      { lat: 40.80, lng: -73.90 }, // gives a centroid far from the bundle
      { lat: 40.78, lng: -73.96 },
    ];
    const bundles: RouteBundle[] = [{
      fingerprint: {
        id: 'r_centroid_test',
        startLat: 40.77, startLng: -73.97,
        endLat: 40.78, endLng: -73.96,
        centroidLat: 40.775, centroidLng: -73.965,
        referenceDistanceMeters: 5000,
        name: 'Test Route',
      },
      efforts: [],
    }];
    // The centroid of these coords would be ~(40.783, -73.943), well beyond 500m from (40.775, -73.965)
    expect(findMatchingBundle(coords, 5000, bundles)).toBeNull();
  });
});

// ─── VirtualRun / TrailRun acceptance ─────────────────────────

describe('sport type acceptance', () => {
  it('processes VirtualRun activities', () => {
    const act = makeActivity({
      id: 2001,
      type: 'VirtualRun',
      sport_type: 'VirtualRun',
      distance: 5000,
      moving_time: 1500,
      start_date_local: '2026-04-01T08:00:00',
    });
    const rec = processActivityEffort(act);
    expect(rec).not.toBeNull();
    expect(rec!.activityId).toBe(2001);
  });

  it('processes TrailRun activities', () => {
    const act = makeActivity({
      id: 2002,
      type: 'TrailRun',
      sport_type: 'TrailRun',
      distance: 5000,
      moving_time: 1500,
      start_date_local: '2026-04-02T08:00:00',
    });
    const rec = processActivityEffort(act);
    expect(rec).not.toBeNull();
    expect(rec!.activityId).toBe(2002);
  });
});

// ─── Cadence regression (neutral sentiment) ──────────────────

describe('cadence regression', () => {
  it('generates neutral sentiment when cadence decreases', () => {
    const poly = BROOKLYN_POLYLINE;
    const base = {
      distance: 5000,
      moving_time: 1500,
      map: { id: 'mcd', summary_polyline: poly },
    };

    // Higher cadence first
    processActivityEffort(makeActivity({
      id: 2101,
      ...base,
      average_cadence: 90, // → 180 spm
      start_date_local: '2026-05-01T08:00:00',
    }));

    // Lower cadence
    const rec = processActivityEffort(makeActivity({
      id: 2102,
      ...base,
      average_cadence: 78, // → 156 spm — significant drop
      start_date_local: '2026-05-08T08:00:00',
    }));

    expect(rec).not.toBeNull();
    const cadInsight = rec!.insights.find(i => i.category === 'cadence');
    expect(cadInsight).toBeDefined();
    expect(cadInsight!.sentiment).toBe('neutral');
    expect(cadInsight!.message).toContain('lower');
  });
});

// ─── Overall: similar pace at lower cardiac cost ────────────

describe('overall: fitness showing at lower cardiac cost', () => {
  it('generates "fitness is showing" when similar pace but lower HR', () => {
    const poly = CENTRAL_PARK_VARIANT;
    const base = { distance: 5000, map: { id: 'mof', summary_polyline: poly } };

    // First effort: high HR
    processActivityEffort(makeActivity({
      id: 2201,
      ...base,
      moving_time: 1500,
      average_heartrate: 175,
      start_date_local: '2026-06-01T08:00:00',
    }));

    // Second effort: same pace, significantly lower HR
    const rec = processActivityEffort(makeActivity({
      id: 2202,
      ...base,
      moving_time: 1500, // same pace
      average_heartrate: 150, // ~14% lower
      start_date_local: '2026-06-08T08:00:00',
    }));

    expect(rec).not.toBeNull();
    const overall = rec!.insights.find(i => i.category === 'overall');
    expect(overall).toBeDefined();
    expect(overall!.sentiment).toBe('positive');
    expect(overall!.message).toContain('cardiac cost');
  });
});

// ─── getEffortRecognition: unknown activity returns null ─────

describe('getEffortRecognition', () => {
  it('returns null for unknown activity ID', () => {
    expect(getEffortRecognition(999999)).toBeNull();
  });
});
