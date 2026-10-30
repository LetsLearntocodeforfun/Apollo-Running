/**
 * Tests for the Garmin Connect Personal API client (src/services/garmin.ts,
 * v1.0.8 DS-01) with an injected transport: activity mapping, bearer-token
 * minting and caching, 401 renewal, the reconnect flag, retries, pagination
 * and multisport handling, plus connect / disconnect in activitySource.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  GARMIN_ID_OFFSET,
  GARMIN_PAGE_SIZE,
  GarminAuthError,
  GarminUnavailableError,
  forgetGarminToken,
  fromGarminStoreId,
  getGarminDisplayName,
  isGarminTransportAvailable,
  listGarminActivities,
  mapGarminActivity,
  parseJwtExpiry,
  setGarminTransport,
  toGarminStoreId,
  verifyGarminKey,
  type GarminActivitySummary,
  type GarminTransport,
} from '@/services/garmin';
import { getGarminPersonalCredentials, setGarminPersonalCredentials } from '@/services/storage';
import { getNeedsReconnect } from '@/services/connectionHealth';
import { connectGarmin, disconnectSource, isGarminConnected } from '@/services/activitySource';

const KEY = 'test-personal-api-key';
const PROFILE_PATH = '/userprofile-service/userprofile/settings';
const LIST_PATH = '/activitylist-service/activities/search/activities';

function b64url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** A JWT-shaped token expiring `ttlSec` from now; `n` makes each one unique. */
function jwt(n: number, ttlSec = 24 * 3600): string {
  return `${b64url({ alg: 'RS256' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + ttlSec, n })}.sig`;
}

const ok = (body: unknown): GarminProxyReply => ({
  ok: true,
  status: 200,
  retryAfter: null,
  text: JSON.stringify(body),
});
const fail = (status: number, retryAfter: number | null = null): GarminProxyReply => ({
  ok: false,
  status,
  retryAfter,
  text: '{"error":"nope"}',
});

/** In-memory stand-in for the desktop main process. */
class FakeGarmin implements GarminTransport {
  tokenCalls: string[] = [];
  tokens: string[] = [];
  requests: GarminProxyRequest[] = [];
  tokenReplies: GarminTokenReply[] = [];
  replies: GarminProxyReply[] = [];
  fallback: (req: GarminProxyRequest) => GarminProxyReply = () => ok({ displayName: 'Ada Runner' });

  obtainToken(apiKey: string): Promise<GarminTokenReply> {
    this.tokenCalls.push(apiKey);
    const queued = this.tokenReplies.shift();
    if (queued) return Promise.resolve(queued);
    const token = jwt(this.tokenCalls.length);
    this.tokens.push(token);
    return Promise.resolve({ ok: true, status: 200, retryAfter: null, token });
  }

  request(req: GarminProxyRequest): Promise<GarminProxyReply> {
    this.requests.push(req);
    return Promise.resolve(this.replies.shift() ?? this.fallback(req));
  }
}

function summary(id: number, extra: Partial<GarminActivitySummary> = {}): GarminActivitySummary {
  return {
    activityId: id,
    activityName: `Run ${id}`,
    startTimeLocal: '2026-08-31 07:01:18',
    startTimeGMT: '2026-08-31 12:01:18',
    activityType: { typeKey: 'running' },
    distance: 10000,
    duration: 3000,
    ...extra,
  };
}

let fake: FakeGarmin;

beforeEach(() => {
  fake = new FakeGarmin();
  setGarminTransport(fake, { minRequestIntervalMs: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  setGarminTransport(null);
});

describe('mapGarminActivity', () => {
  it('maps a run summary to the canonical model', () => {
    const a = mapGarminActivity(
      summary(21345678901, {
        activityName: 'Morning Run',
        elapsedDuration: 3100,
        movingDuration: 2990,
        elevationGain: 50,
        averageSpeed: 3.35,
        maxSpeed: 4.5,
        averageHR: 150,
        maxHR: 175,
        averageRunningCadenceInStepsPerMinute: 170,
        calories: 700,
        startLatitude: 40.1,
        startLongitude: -75.2,
        endLatitude: 40.2,
        endLongitude: -75.3,
        hasPolyline: true,
      }),
    );
    expect(a).not.toBeNull();
    expect(a).toMatchObject({
      id: GARMIN_ID_OFFSET + 21345678901,
      name: 'Morning Run',
      type: 'Run',
      sport_type: 'Run',
      distance: 10000,
      moving_time: 2990,
      elapsed_time: 3100,
      start_date: '2026-08-31T12:01:18Z',
      start_date_local: '2026-08-31T07:01:18Z',
      average_heartrate: 150,
      max_heartrate: 175,
      average_speed: 3.35,
      average_cadence: 85, // steps/min → strides/min
      calories: 700,
      start_latlng: [40.1, -75.2],
      end_latlng: [40.2, -75.3],
      source: 'garmin',
      source_id: '21345678901',
      origin: 'GARMIN_CONNECT',
    });
    // A GPS track exists, so the route is left for the original file to fill in.
    expect(a?.map).toBeUndefined();
    expect(a?.trainer).toBeUndefined();
  });

  it('marks treadmill runs as indoor with a checked, empty route and a default name', () => {
    const a = mapGarminActivity(
      summary(5, { activityName: '  ', activityType: { typeKey: 'treadmill_running' }, hasPolyline: false }),
    );
    expect(a?.type).toBe('Run');
    expect(a?.trainer).toBe(true);
    expect(a?.map).toEqual({ id: 'garmin-5', summary_polyline: '' });
    expect(a?.name).toBe('Morning Run');
  });

  it('falls back to epoch timestamps and derives the average speed', () => {
    const a = mapGarminActivity({
      activityId: 7,
      beginTimestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
      activityType: { typeKey: 'cycling' },
      distance: 20000,
      duration: 4000,
    });
    expect(a?.start_date).toBe('2026-01-02T03:04:05Z');
    expect(a?.start_date_local).toBe('2026-01-02T03:04:05Z');
    expect(a?.type).toBe('Ride');
    expect(a?.average_speed).toBe(5);
  });

  it('skips records without a usable ID or start time', () => {
    expect(mapGarminActivity(summary(0))).toBeNull();
    expect(mapGarminActivity(summary(-3))).toBeNull();
    expect(mapGarminActivity(summary(1.5))).toBeNull();
    expect(mapGarminActivity(summary(1e14))).toBeNull();
    expect(mapGarminActivity({ ...summary(1), activityId: 'abc' })).toBeNull();
    expect(mapGarminActivity({ ...summary(1), activityId: null })).toBeNull();
    expect(mapGarminActivity({ ...summary(1), startTimeLocal: null, startTimeGMT: null })).toBeNull();
  });
});

describe('Garmin store IDs and tokens', () => {
  it('maps activity IDs into their own range and back', () => {
    expect(toGarminStoreId(123)).toBe(GARMIN_ID_OFFSET + 123);
    expect(toGarminStoreId('123')).toBe(GARMIN_ID_OFFSET + 123);
    expect(toGarminStoreId('12a')).toBeNull();
    expect(fromGarminStoreId(GARMIN_ID_OFFSET + 123)).toBe('123');
    expect(fromGarminStoreId(123)).toBeNull();
    expect(fromGarminStoreId(GARMIN_ID_OFFSET)).toBeNull();
  });

  it('reads a JWT expiry without trusting anything else', () => {
    expect(parseJwtExpiry(`${b64url({ alg: 'none' })}.${b64url({ exp: 1800000000 })}.`)).toBe(1800000000 * 1000);
    expect(parseJwtExpiry(`${b64url({})}.${b64url({ sub: 'x' })}.`)).toBeNull();
    expect(parseJwtExpiry('not-a-jwt')).toBeNull();
    expect(parseJwtExpiry('a.@@@.c')).toBeNull();
  });
});

describe('Garmin requests', () => {
  beforeEach(async () => {
    await setGarminPersonalCredentials({ apiKey: KEY, displayName: 'Ada Runner' });
  });

  it('mints one token, reuses it and keeps it for the saved key', async () => {
    await getGarminDisplayName();
    await getGarminDisplayName();
    expect(fake.tokenCalls).toEqual([KEY]);
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.every((r) => r.accessToken === fake.tokens[0])).toBe(true);
    expect(fake.requests[0]).toMatchObject({ path: PROFILE_PATH, accept: 'json' });

    // A new session (memory cleared) uses the cached token from the encrypted store.
    expect(getGarminPersonalCredentials()?.accessToken).toBe(fake.tokens[0]);
    forgetGarminToken();
    await getGarminDisplayName();
    expect(fake.tokenCalls).toHaveLength(1);
  });

  it('mints a new token when the cached one is about to expire', async () => {
    await setGarminPersonalCredentials({
      apiKey: KEY,
      accessToken: jwt(99, 1800),
      accessTokenExpiresAt: Date.now() + 30 * 60 * 1000,
    });
    await getGarminDisplayName();
    expect(fake.tokenCalls).toHaveLength(1);
    expect(fake.requests[0].accessToken).toBe(fake.tokens[0]);
  });

  it('renews the token once after a 401', async () => {
    fake.replies.push(fail(401));
    expect(await getGarminDisplayName()).toBe('Ada Runner');
    expect(fake.tokenCalls).toHaveLength(2);
    expect(fake.requests.map((r) => r.accessToken)).toEqual(fake.tokens);
    expect(getNeedsReconnect('garmin')).toBeNull();
  });

  it('flags the saved key for reconnect when Garmin keeps rejecting it', async () => {
    fake.replies.push(fail(401), fail(401));
    await expect(getGarminDisplayName()).rejects.toBeInstanceOf(GarminAuthError);
    expect(getNeedsReconnect('garmin')?.reason).toMatch(/personal API key/);
  });

  it('flags the saved key when the token endpoint rejects it', async () => {
    fake.tokenReplies.push({ ok: false, status: 401, retryAfter: null });
    await expect(getGarminDisplayName()).rejects.toBeInstanceOf(GarminAuthError);
    expect(getNeedsReconnect('garmin')).not.toBeNull();
    expect(fake.requests).toHaveLength(0);
  });

  it('retries server errors, then succeeds', async () => {
    vi.useFakeTimers();
    fake.replies.push(fail(503));
    const result = getGarminDisplayName();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toBe('Ada Runner');
    expect(fake.requests).toHaveLength(2);
  });

  it('pages through activity lists, skipping multisport parents and duplicates', async () => {
    const page1 = Array.from({ length: GARMIN_PAGE_SIZE }, (_, i) => summary(1000 + i));
    const page2 = [
      ...Array.from({ length: GARMIN_PAGE_SIZE - 3 }, (_, i) => summary(2000 + i)),
      summary(1039), // overlaps page 1 (an activity was added meanwhile)
      summary(3000, { isParent: true, activityType: { typeKey: 'multi_sport' } }),
      summary(3001, { parentId: 3000, activityType: { typeKey: 'cycling' } }),
    ];
    const page3 = [summary(3002, { parentId: 3000 }), summary(4000, { isParent: true })];
    fake.replies.push(ok(page1), ok(page2), ok(page3));

    const pages: number[] = [];
    const list = await listGarminActivities({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      onPage: (n) => pages.push(n),
    });

    expect(fake.requests).toHaveLength(3);
    expect(fake.requests.map((r) => r.query?.start)).toEqual([0, GARMIN_PAGE_SIZE, 2 * GARMIN_PAGE_SIZE]);
    expect(fake.requests[0]).toMatchObject({
      path: LIST_PATH,
      query: { limit: GARMIN_PAGE_SIZE, startDate: '2026-01-01', endDate: '2026-12-31', excludeChildren: false },
    });
    expect(pages).toEqual([GARMIN_PAGE_SIZE, 2 * GARMIN_PAGE_SIZE, 2 * GARMIN_PAGE_SIZE + 2]);
    expect(list.rawCount).toBe(2 * GARMIN_PAGE_SIZE + 2);
    const ids = list.activities.map((a) => a.source_id);
    expect(ids).not.toContain('3000'); // parent with legs in the batch
    expect(ids).toEqual(expect.arrayContaining(['3001', '3002', '4000'])); // legs, and a parent without legs
    expect(new Set(ids).size).toBe(ids.length);
    expect(list.rawIds).toContain('3000');
  });
});

describe('Garmin key checks and availability', () => {
  it("doesn't flag reconnect when an unsaved key is rejected", async () => {
    fake.tokenReplies.push({ ok: false, status: 401, retryAfter: null });
    await expect(verifyGarminKey('wrong-key')).rejects.toBeInstanceOf(GarminAuthError);
    expect(getNeedsReconnect('garmin')).toBeNull();
  });

  it('asks for a key before calling Garmin', async () => {
    await expect(verifyGarminKey('   ')).rejects.toThrow(/Paste your Garmin personal API key/);
    expect(fake.tokenCalls).toHaveLength(0);
  });

  it('is unavailable without the desktop transport', async () => {
    setGarminTransport(null);
    expect(isGarminTransportAvailable()).toBe(false);
    await expect(verifyGarminKey(KEY)).rejects.toBeInstanceOf(GarminUnavailableError);
    await expect(connectGarmin(KEY)).rejects.toBeInstanceOf(GarminUnavailableError);
  });
});

describe('connectGarmin / disconnectSource', () => {
  it('saves a verified key with its expiry, and disconnect removes it', async () => {
    const before = Date.now();
    const athlete = await connectGarmin(`  ${KEY}  `, { keyValidDays: 90 });
    expect(athlete).toMatchObject({ firstname: 'Ada', lastname: 'Runner', source: 'garmin' });
    expect(isGarminConnected()).toBe(true);

    const saved = getGarminPersonalCredentials();
    expect(saved?.apiKey).toBe(KEY);
    expect(saved?.displayName).toBe('Ada Runner');
    const expires = Date.parse(saved?.keyExpiresAt ?? '');
    expect(expires - before).toBeGreaterThanOrEqual(90 * 86_400_000 - 1000);
    expect(expires - before).toBeLessThanOrEqual(90 * 86_400_000 + 60_000);

    disconnectSource('garmin');
    expect(isGarminConnected()).toBe(false);
    expect(getGarminPersonalCredentials()).toBeNull();
  });

  it('ignores an implausible key validity', async () => {
    await connectGarmin(KEY, { keyValidDays: 10_000 });
    expect(getGarminPersonalCredentials()?.keyExpiresAt).toBeUndefined();
  });

  it('saves nothing when Garmin rejects the key', async () => {
    fake.tokenReplies.push({ ok: false, status: 401, retryAfter: null });
    await expect(connectGarmin(KEY)).rejects.toBeInstanceOf(GarminAuthError);
    expect(isGarminConnected()).toBe(false);
  });
});
