/**
 * Unit tests for the intervals.icu client (services/intervals.ts):
 * field mapping into Apollo's activity model, the HTTP endpoints and the
 * calendar writes (with a stubbed fetch — no network).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mapIntervalsActivity,
  toStoreId,
  fromStoreId,
  toStravaStyleLocal,
  listIntervalsActivities,
  getIntervalsAthlete,
  getIntervalsRoute,
  getIntervalsActivityDetail,
  sendIntervals,
  upsertIntervalsEvents,
  deleteIntervalsEventsByExternalId,
  listIntervalsEvents,
  fetchIntervalsWellness,
  fetchIntervalsSportSettings,
  IntervalsAuthError,
  IntervalsHttpError,
  INTERVALS_ID_OFFSET,
  type IcuActivity,
  type IcuEventInput,
} from '@/services/intervals';
import { setIntervalsCredentials, type IntervalsCredentials } from '@/services/storage';
import { decodePolyline } from '@/services/routeService';

const CREDS: IntervalsCredentials = { apiKey: 'secret-key', athleteId: 'i42' };

interface FakeReply { status?: number; body?: unknown; headers?: Record<string, string> }

function fakeResponse({ status = 200, body, headers = {} }: FakeReply): Response {
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

interface FetchCall {
  url: URL;
  headers: Record<string, string>;
  /** HTTP method ('GET' when the init has none). */
  method: string;
  /** Parsed JSON request body, if any. */
  body: unknown;
  /** Keys of the RequestInit (checks the exact request shape). */
  initKeys: string[];
}

/** Stub global fetch; the handler receives the parsed URL (and method/body) of each request. */
function mockFetch(handler: (url: URL, req: { method: string; body: unknown }) => FakeReply) {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, headers: init?.headers ?? {}, method, body, initKeys: Object.keys(init ?? {}).sort() });
    return fakeResponse(handler(url, { method, body }));
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const garminRun: IcuActivity = {
  id: 'i123456',
  name: 'Lunch Tempo',
  type: 'Run',
  start_date_local: '2024-05-12T12:31:02',
  start_date: '2024-05-12T17:31:02Z',
  distance: 10012.5,
  moving_time: 2890,
  elapsed_time: 2950,
  total_elevation_gain: 42,
  average_speed: 3.46,
  max_speed: 5.1,
  average_heartrate: 158,
  max_heartrate: 176,
  average_cadence: 172,
  icu_training_load: 81,
  trainer: false,
  device_name: 'Garmin Forerunner 965',
  calories: 640,
  source: 'GARMIN_CONNECT',
};

// ── Mapping ───────────────────────────────────────────────────────────────────

describe('mapIntervalsActivity', () => {
  it('maps a Garmin run into the canonical model', () => {
    const a = mapIntervalsActivity(garminRun)!;
    expect(a.id).toBe(INTERVALS_ID_OFFSET + 123456);
    expect(a.source).toBe('intervals');
    expect(a.source_id).toBe('i123456');
    expect(a.origin).toBe('GARMIN_CONNECT');
    expect(a.type).toBe('Run');
    expect(a.sport_type).toBe('Run');
    expect(a.start_date_local).toBe('2024-05-12T12:31:02Z');
    expect(a.start_date).toBe('2024-05-12T17:31:02Z');
    expect(a.distance).toBe(10012.5);
    expect(a.moving_time).toBe(2890);
    expect(a.elapsed_time).toBe(2950);
    expect(a.average_heartrate).toBe(158);
    expect(a.training_load).toBe(81);
    expect(a.device_name).toBe('Garmin Forerunner 965');
    expect(a.trainer).toBe(false);
  });

  it('stores running cadence as strides/min (Strava semantics)', () => {
    expect(mapIntervalsActivity(garminRun)!.average_cadence).toBe(86);
    expect(mapIntervalsActivity({ ...garminRun, average_cadence: 86 })!.average_cadence).toBe(86);
  });

  it('maps a Zwift ride with power and keeps cycling cadence in rpm', () => {
    const ride = mapIntervalsActivity({
      id: 'i777', type: 'VirtualRide', start_date_local: '2024-06-01T18:05:00',
      distance: 32000, moving_time: 3600, average_cadence: 88,
      icu_average_watts: 205, icu_weighted_avg_watts: 221, trainer: true,
      device_name: 'Zwift', source: 'ZWIFT',
    })!;
    expect(ride.type).toBe('VirtualRide');
    expect(ride.average_cadence).toBe(88);
    expect(ride.average_watts).toBe(205);
    expect(ride.weighted_average_watts).toBe(221);
    expect(ride.trainer).toBe(true);
    expect(ride.origin).toBe('ZWIFT');
    // Speed derived from distance / time when the API omits it
    expect(ride.average_speed).toBeCloseTo(32000 / 3600, 5);
    // Missing name → time-of-day default, like Strava
    expect(ride.name).toBe('Evening Virtual Ride');
  });

  it('skips Strava-imported records and incomplete ones', () => {
    expect(mapIntervalsActivity({ ...garminRun, source: 'STRAVA' })).toBeNull();
    expect(mapIntervalsActivity({ ...garminRun, type: null })).toBeNull();
    expect(mapIntervalsActivity({ ...garminRun, start_date_local: undefined })).toBeNull();
  });

  it('drops empty optional fields instead of storing undefined/0 placeholders', () => {
    const a = mapIntervalsActivity({ id: 5, type: 'WeightTraining', start_date_local: '2024-01-02T06:00:00' })!;
    expect(a.distance).toBe(0);
    expect('average_heartrate' in a).toBe(false);
    expect('average_watts' in a).toBe(false);
    expect(a.name).toBe('Morning Strength Training');
  });
});

describe('ID and date helpers', () => {
  it('maps intervals.icu IDs into their own numeric range and back', () => {
    expect(toStoreId('i12345')).toBe(INTERVALS_ID_OFFSET + 12345);
    expect(toStoreId(12345)).toBe(INTERVALS_ID_OFFSET + 12345);
    expect(fromStoreId(toStoreId('i12345'))).toBe('i12345');
    expect(toStoreId('abc')).toBeGreaterThanOrEqual(INTERVALS_ID_OFFSET * 2);
    expect(toStoreId('abc')).toBe(toStoreId('abc'));
  });

  it('formats local times like Strava', () => {
    expect(toStravaStyleLocal('2024-05-12T07:31:02')).toBe('2024-05-12T07:31:02Z');
    expect(toStravaStyleLocal('2024-05-12T07:31')).toBe('2024-05-12T07:31:00Z');
    expect(toStravaStyleLocal('2024-05-12')).toBe('2024-05-12T00:00:00Z');
  });
});

// ── Endpoints ─────────────────────────────────────────────────────────────────

describe('listIntervalsActivities', () => {
  it('requests the date window with Basic auth and maps the results', async () => {
    const calls = mockFetch(() => ({ body: [garminRun, { ...garminRun, id: 'i9', source: 'STRAVA' }] }));
    const list = await listIntervalsActivities({ oldest: '2024-05-01', newest: '2024-05-31' }, CREDS);

    expect(list).toHaveLength(1);
    expect(list[0].source_id).toBe('i123456');
    expect(calls).toHaveLength(1);
    const { url, headers } = calls[0];
    expect(url.origin + url.pathname).toBe('https://intervals.icu/api/v1/athlete/i42/activities');
    expect(url.searchParams.get('oldest')).toBe('2024-05-01');
    expect(url.searchParams.get('newest')).toBe('2024-05-31');
    expect(url.searchParams.get('fields')).toContain('icu_training_load');
    expect(headers.Authorization).toBe('Basic ' + btoa('API_KEY:secret-key'));
  });

  it('uses the saved credentials by default', async () => {
    setIntervalsCredentials({ apiKey: 'saved', athleteId: '0' });
    const calls = mockFetch(() => ({ body: [] }));
    await listIntervalsActivities({ oldest: '2024-01-01' });
    expect(calls[0].url.pathname).toBe('/api/v1/athlete/0/activities');
    expect(calls[0].headers.Authorization).toBe('Basic ' + btoa('API_KEY:saved'));
  });

  it('fails clearly when not connected', async () => {
    await expect(listIntervalsActivities({ oldest: '2024-01-01' })).rejects.toThrow(/not connected/);
  });

  it('throws IntervalsAuthError for a rejected key without retrying', async () => {
    const calls = mockFetch(() => ({ status: 401 }));
    await expect(listIntervalsActivities({ oldest: '2024-01-01' }, CREDS)).rejects.toBeInstanceOf(IntervalsAuthError);
    expect(calls).toHaveLength(1);
  });

  it('retries server errors, honouring Retry-After', async () => {
    let n = 0;
    mockFetch(() => (++n < 2 ? { status: 503, headers: { 'Retry-After': '1' } } : { body: [garminRun] }));
    await expect(listIntervalsActivities({ oldest: '2024-01-01' }, CREDS)).resolves.toHaveLength(1);
    expect(n).toBe(2);
  });
});

describe('getIntervalsAthlete', () => {
  it('returns the profile of the key owner', async () => {
    mockFetch(() => ({ body: { id: 'i42', firstname: 'Marc', lastname: 'C', profile_medium: 'https://x/y.png' } }));
    const athlete = await getIntervalsAthlete({ apiKey: 'k', athleteId: '0' });
    expect(athlete).toEqual({ id: 'i42', firstname: 'Marc', lastname: 'C', profile: 'https://x/y.png', source: 'intervals' });
  });

  it('splits a single display name', async () => {
    mockFetch(() => ({ body: { id: 'i42', name: 'Marc van Copeland' } }));
    const athlete = await getIntervalsAthlete(CREDS);
    expect(athlete.firstname).toBe('Marc');
    expect(athlete.lastname).toBe('van Copeland');
  });
});

describe('getIntervalsRoute', () => {
  const latlngs = [[45.5231, -122.6765], [45.5241, -122.6775], [null, null], [45.5251, -122.6785]];

  it('encodes the GPS track as polylines', async () => {
    const calls = mockFetch(() => ({ body: { bounds: [], latlngs } }));
    const route = await getIntervalsRoute('i123', CREDS);
    expect(calls[0].url.pathname).toBe('/api/v1/activity/i123/map');
    const points = decodePolyline(route.summaryPolyline);
    expect(points).toHaveLength(3);
    expect(points[2].lat).toBeCloseTo(45.5251, 5);
    expect(route.polyline).toBe(route.summaryPolyline);
    expect(route.start).toEqual([45.5231, -122.6765]);
    expect(route.end).toEqual([45.5251, -122.6785]);
  });

  it('treats a missing map as "no GPS"', async () => {
    mockFetch(() => ({ status: 404 }));
    expect(await getIntervalsRoute('i1', CREDS)).toEqual({ summaryPolyline: '', polyline: '', start: null, end: null });
    mockFetch(() => ({ body: '' }));
    expect((await getIntervalsRoute('i1', CREDS)).summaryPolyline).toBe('');
  });
});

describe('getIntervalsActivityDetail', () => {
  it('adds laps, derived splits and the route while keeping the store ID', async () => {
    const time = Array.from({ length: 501 }, (_, i) => i * 5);        // 0..2500 s
    const distance = time.map((t) => t * 4);                           // 4 m/s → 10 km
    mockFetch((url) => {
      if (url.pathname.endsWith('/streams.json')) {
        return { body: [{ type: 'time', data: time }, { type: 'distance', data: distance }, { type: 'heartrate', data: time.map(() => 150) }] };
      }
      if (url.pathname.endsWith('/map')) return { body: { latlngs: [[45.1, -122.1], [45.2, -122.2]] } };
      return {
        body: {
          ...garminRun,
          name: 'Renamed on intervals.icu',
          icu_intervals: [
            { type: 'WORK', distance: 1000, moving_time: 240, average_heartrate: 165, average_cadence: 180, start_index: 0, end_index: 48 },
            { type: 'RECOVERY', distance: 400, moving_time: 150, start_index: 48, end_index: 78 },
            { type: 'WORK', label: 'Hill', distance: 1000, moving_time: 250, start_index: 78, end_index: 128 },
          ],
        },
      };
    });

    const base = { ...mapIntervalsActivity(garminRun)!, id: 999 };
    const detail = await getIntervalsActivityDetail(base, CREDS);

    expect(detail.id).toBe(999);
    expect(detail.name).toBe('Renamed on intervals.icu');
    expect(detail.laps?.map((l) => l.name)).toEqual(['Interval 1', 'Recovery', 'Hill']);
    expect(detail.laps?.[0].average_cadence).toBe(90);
    expect(detail.laps?.[1].average_speed).toBeCloseTo(400 / 150, 5);
    expect(detail.splits_metric).toHaveLength(10);
    expect(detail.splits_metric?.[0].elapsed_time).toBe(250);
    expect(detail.splits_metric?.[0].average_heartrate).toBe(150);
    expect(detail.splits_standard).toHaveLength(7);
    expect(detail.map?.summary_polyline).toBeTruthy();
    expect(detail.start_latlng).toEqual([45.1, -122.1]);
  });

  it('skips streams and maps for indoor sessions without distance', async () => {
    const calls = mockFetch(() => ({ body: { id: 'i5', type: 'WeightTraining', start_date_local: '2024-01-02T06:00:00', icu_intervals: [] } }));
    const base = mapIntervalsActivity({ id: 'i5', type: 'WeightTraining', start_date_local: '2024-01-02T06:00:00' })!;
    const detail = await getIntervalsActivityDetail(base, CREDS);
    expect(calls).toHaveLength(1);
    expect(detail.laps).toBeUndefined();
    expect(detail.splits_metric).toBeUndefined();
  });
});

// ── Writes & calendar events ─────────────────────────────────────────────────

function plannedEvent(n: number): IcuEventInput {
  return {
    category: 'WORKOUT',
    start_date_local: '2026-10-12T00:00:00',
    type: 'Run',
    name: `Easy Run ${n}`,
    description: '- 5mi',
    external_id: `apollo:test:${n}`,
  };
}

describe('sendIntervals', () => {
  it('sends a JSON body with Basic auth and returns the parsed response', async () => {
    const calls = mockFetch(() => ({ body: { ok: true } }));
    const res = await sendIntervals<{ ok: boolean }>('PUT', '/athlete/i42/thing', { a: 1 }, CREDS);
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url.href).toBe('https://intervals.icu/api/v1/athlete/i42/thing');
    expect(call.method).toBe('PUT');
    expect(call.body).toEqual({ a: 1 });
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers.Authorization).toBe('Basic ' + btoa('API_KEY:secret-key'));
  });

  it('leaves the shape of GET requests unchanged', async () => {
    const calls = mockFetch(() => ({ body: [] }));
    await listIntervalsActivities({ oldest: '2024-01-01' }, CREDS);
    expect(calls[0].initKeys).toEqual(['headers', 'signal']);
    expect(calls[0].headers['Content-Type']).toBeUndefined();
  });

  it('does not retry a plain POST after a server error (it might have been applied)', async () => {
    const calls = mockFetch(() => ({ status: 502 }));
    await expect(sendIntervals('POST', '/athlete/i42/x', {}, CREDS)).rejects.toBeInstanceOf(IntervalsHttpError);
    expect(calls).toHaveLength(1);
  });

  it('retries idempotent writes after a server error', async () => {
    let n = 0;
    mockFetch(() => (++n < 2 ? { status: 503, headers: { 'Retry-After': '1' } } : { body: { done: 1 } }));
    await expect(sendIntervals('PUT', '/athlete/i42/x', [], CREDS)).resolves.toEqual({ done: 1 });
    expect(n).toBe(2);
  });

  it('retries any write after 429 (the request was not processed)', async () => {
    let n = 0;
    mockFetch(() => (++n < 2 ? { status: 429, headers: { 'Retry-After': '1' } } : { body: { done: 1 } }));
    await expect(sendIntervals('POST', '/athlete/i42/x', {}, CREDS)).resolves.toEqual({ done: 1 });
    expect(n).toBe(2);
  });

  it('throws IntervalsAuthError for a rejected key', async () => {
    const calls = mockFetch(() => ({ status: 403 }));
    await expect(sendIntervals('DELETE', '/athlete/i42/x', undefined, CREDS)).rejects.toBeInstanceOf(IntervalsAuthError);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBeUndefined();
  });
});

describe('upsertIntervalsEvents', () => {
  it('bulk-upserts by external_id in chunks of 100 and returns the saved events', async () => {
    const calls = mockFetch((_url, req) => ({
      body: (req.body as IcuEventInput[]).map((e, i) => ({ id: i + 1, external_id: e.external_id })),
    }));
    const events = Array.from({ length: 150 }, (_, i) => plannedEvent(i));
    const saved = await upsertIntervalsEvents(events, CREDS);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.method).toBe('POST');
      expect(call.url.pathname).toBe('/api/v1/athlete/i42/events/bulk');
      expect(call.url.searchParams.get('upsert')).toBe('true');
      expect(call.headers['Content-Type']).toBe('application/json');
    }
    expect((calls[0].body as IcuEventInput[]).length).toBe(100);
    expect((calls[1].body as IcuEventInput[]).length).toBe(50);
    expect((calls[1].body as IcuEventInput[])[0]).toEqual(events[100]);
    expect(saved).toHaveLength(150);
    expect(saved[149].external_id).toBe('apollo:test:149');
  });

  it('sends nothing for an empty list', async () => {
    const calls = mockFetch(() => ({ body: [] }));
    expect(await upsertIntervalsEvents([], CREDS)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('refuses events without an external_id (repeats would duplicate them)', async () => {
    const calls = mockFetch(() => ({ body: [] }));
    await expect(upsertIntervalsEvents([{ ...plannedEvent(1), external_id: undefined }], CREDS)).rejects.toThrow(/external_id/);
    expect(calls).toHaveLength(0);
  });

  it('retries server errors because the upsert is idempotent', async () => {
    let n = 0;
    mockFetch(() => (++n < 2 ? { status: 500, headers: { 'Retry-After': '1' } } : { body: [{ id: 1, external_id: 'apollo:test:1' }] }));
    await expect(upsertIntervalsEvents([plannedEvent(1)], CREDS)).resolves.toHaveLength(1);
    expect(n).toBe(2);
  });

  it('uses the saved credentials by default', async () => {
    setIntervalsCredentials({ apiKey: 'saved', athleteId: '0' });
    const calls = mockFetch(() => ({ body: [] }));
    await upsertIntervalsEvents([plannedEvent(1)]);
    expect(calls[0].url.pathname).toBe('/api/v1/athlete/0/events/bulk');
    expect(calls[0].headers.Authorization).toBe('Basic ' + btoa('API_KEY:saved'));
  });
});

describe('deleteIntervalsEventsByExternalId', () => {
  it('bulk-deletes unique external_ids and returns the count', async () => {
    const calls = mockFetch(() => ({ body: { eventsDeleted: 2 } }));
    expect(await deleteIntervalsEventsByExternalId(['apollo:a', 'apollo:b', 'apollo:a', ''], CREDS)).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url.pathname).toBe('/api/v1/athlete/i42/events/bulk-delete');
    expect(calls[0].body).toEqual([{ external_id: 'apollo:a' }, { external_id: 'apollo:b' }]);
  });

  it('chunks large deletes and falls back to the chunk size without a count', async () => {
    const calls = mockFetch(() => ({ body: '' }));
    const ids = Array.from({ length: 120 }, (_, i) => `apollo:x:${i}`);
    expect(await deleteIntervalsEventsByExternalId(ids, CREDS)).toBe(120);
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 20]);
  });

  it('sends nothing when there is nothing to delete', async () => {
    const calls = mockFetch(() => ({ body: { eventsDeleted: 0 } }));
    expect(await deleteIntervalsEventsByExternalId([], CREDS)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe('listIntervalsEvents', () => {
  it('requests the date window and categories', async () => {
    const calls = mockFetch(() => ({ body: [{ id: 7, external_id: 'apollo:x', start_date_local: '2026-10-12T00:00:00' }] }));
    const events = await listIntervalsEvents({ oldest: '2026-10-01', newest: '2026-10-31', category: ['WORKOUT', 'NOTE'] }, CREDS);
    expect(events).toEqual([{ id: 7, external_id: 'apollo:x', start_date_local: '2026-10-12T00:00:00' }]);
    const { url, method } = calls[0];
    expect(method).toBe('GET');
    expect(url.pathname).toBe('/api/v1/athlete/i42/events');
    expect(url.searchParams.get('oldest')).toBe('2026-10-01');
    expect(url.searchParams.get('newest')).toBe('2026-10-31');
    expect(url.searchParams.get('category')).toBe('WORKOUT,NOTE');
  });

  it('omits the category filter when not given and tolerates unexpected bodies', async () => {
    const calls = mockFetch(() => ({ body: { unexpected: true } }));
    expect(await listIntervalsEvents({ oldest: '2026-10-01', newest: '2026-10-02' }, CREDS)).toEqual([]);
    expect(calls[0].url.searchParams.has('category')).toBe(false);
  });
});

// ── Wellness & sport settings ─────────────────────────────────────────────────

describe('fetchIntervalsWellness', () => {
  it('requests the date window with the wellness fields and keeps only dated records', async () => {
    const day = { id: '2026-10-04', restingHR: 47, hrv: 62.5, sleepSecs: 27000, sleepScore: 84 };
    const calls = mockFetch(() => ({ body: [day, { restingHR: 50 }, null, 'junk', { id: 7 }] }));
    const rows = await fetchIntervalsWellness({ oldest: '2026-09-05', newest: '2026-10-04' }, CREDS);

    expect(rows).toEqual([day]);
    expect(calls).toHaveLength(1);
    const { url, method, headers } = calls[0];
    expect(method).toBe('GET');
    expect(url.pathname).toBe('/api/v1/athlete/i42/wellness');
    expect(url.searchParams.get('oldest')).toBe('2026-09-05');
    expect(url.searchParams.get('newest')).toBe('2026-10-04');
    expect(url.searchParams.get('fields')?.split(',')).toEqual(expect.arrayContaining([
      'id', 'restingHR', 'hrv', 'sleepSecs', 'sleepScore', 'readiness', 'tempRestingHR', 'tempWeight',
    ]));
    expect(headers.Authorization).toBe('Basic ' + btoa('API_KEY:secret-key'));
  });

  it('uses the saved credentials (athlete 0 = the key owner) by default', async () => {
    setIntervalsCredentials({ apiKey: 'saved', athleteId: '0' });
    const calls = mockFetch(() => ({ body: [] }));
    expect(await fetchIntervalsWellness({ oldest: '2026-10-01', newest: '2026-10-02' })).toEqual([]);
    expect(calls[0].url.pathname).toBe('/api/v1/athlete/0/wellness');
    expect(calls[0].headers.Authorization).toBe('Basic ' + btoa('API_KEY:saved'));
  });

  it('tolerates unexpected bodies and rejects a bad key without retrying', async () => {
    mockFetch(() => ({ body: { unexpected: true } }));
    expect(await fetchIntervalsWellness({ oldest: '2026-10-01', newest: '2026-10-02' }, CREDS)).toEqual([]);

    const calls = mockFetch(() => ({ status: 401 }));
    await expect(fetchIntervalsWellness({ oldest: '2026-10-01', newest: '2026-10-02' }, CREDS))
      .rejects.toBeInstanceOf(IntervalsAuthError);
    expect(calls).toHaveLength(1);
  });
});

describe('fetchIntervalsSportSettings', () => {
  it('reads the per-sport settings and drops malformed entries', async () => {
    const run = { id: 3, types: ['Run', 'VirtualRun', 'TrailRun'], lthr: 168, max_hr: 189, threshold_pace: 4.2, pace_units: 'MINS_KM' };
    const calls = mockFetch(() => ({ body: [{ id: 1, types: ['Ride', 'VirtualRide'] }, run, null, [1, 2]] }));
    expect(await fetchIntervalsSportSettings(CREDS)).toEqual([{ id: 1, types: ['Ride', 'VirtualRide'] }, run]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.pathname).toBe('/api/v1/athlete/i42/sport-settings');
  });

  it('returns an empty list for unexpected bodies and fails clearly when not connected', async () => {
    mockFetch(() => ({ body: { unexpected: true } }));
    expect(await fetchIntervalsSportSettings(CREDS)).toEqual([]);
    await expect(fetchIntervalsSportSettings()).rejects.toThrow(/not connected/);
  });

  it('maps a missing athlete to IntervalsHttpError without retrying', async () => {
    const calls = mockFetch(() => ({ status: 404 }));
    await expect(fetchIntervalsSportSettings(CREDS)).rejects.toBeInstanceOf(IntervalsHttpError);
    expect(calls).toHaveLength(1);
  });
});
