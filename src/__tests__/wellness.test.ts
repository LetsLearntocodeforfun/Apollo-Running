/**
 * Unit tests for wellness & recovery (services/wellness.ts): normalization,
 * the local store and incremental sync against a stubbed intervals.icu (no
 * network), the Run threshold-pace status, HR profile updates and the
 * recovery model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  normalizeWellness,
  syncWellness,
  getWellnessForDate,
  getWellnessRange,
  getWellnessSyncState,
  getSuggestedSleepHours,
  onWellnessUpdated,
  getRunThresholdPaceStatus,
  checkRunThresholdPace,
  refreshRunSportSettings,
  computeRecoverySnapshot,
  getRecoverySnapshot,
  type WellnessRecord,
  type WellnessSyncResult,
} from '@/services/wellness';
import type { IcuSportSettings, IcuWellness } from '@/services/intervals';
import { clearIntervalsCredentials, setIntervalsCredentials, type IntervalsCredentials } from '@/services/storage';
import { setAppPreferences } from '@/services/appPreferences';
import { getHRProfile, setHRProfile, type HRProfile } from '@/services/heartRate';
import { persistence } from '@/services/db/persistence';

// ── Fixtures & helpers ────────────────────────────────────────────────────────

/** "Now" in every test: Monday Oct 5 2026, 09:30 local time. */
const NOW = new Date(2026, 9, 5, 9, 30, 0);
const TODAY = '2026-10-05';
const HOUR = 60 * 60 * 1000;

/** TODAY shifted by whole days (YYYY-MM-DD). */
function day(offset: number): string {
  return new Date(Date.UTC(2026, 9, 5) + offset * 24 * HOUR).toISOString().slice(0, 10);
}

const CREDS: IntervalsCredentials = { apiKey: 'key', athleteId: 'i42', connectedAt: '2026-09-01T08:00:00.000Z' };

const RUN: IcuSportSettings = {
  id: 2, types: ['Run', 'VirtualRun', 'TrailRun'], lthr: 168, max_hr: 188, threshold_pace: 4, pace_units: 'MINS_KM',
};
const RIDE: IcuSportSettings = { id: 1, types: ['Ride', 'VirtualRide'], lthr: 160, max_hr: 180 };

const DEFAULT_PROFILE: HRProfile = { maxHR: 190, restingHR: 60, source: 'default', updatedAt: '' };

async function connect(creds: IntervalsCredentials = CREDS): Promise<void> {
  await setIntervalsCredentials(creds);
}

function row(offset: number, fields: Omit<IcuWellness, 'id'>): IcuWellness {
  return { id: day(offset), ...fields };
}

// Same fetch stub as intervals.test.ts.
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

/** Stub global fetch; the handler receives the parsed URL of each request. */
function mockFetch(handler: (url: URL) => FakeReply): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    calls.push(url);
    return fakeResponse(handler(url));
  }));
  return calls;
}

/** intervals.icu stand-in: wellness rows (none by default) and sport settings (Ride + Run by default). */
function mockIcu(server: { wellness?: (url: URL) => FakeReply; sport?: () => FakeReply } = {}) {
  const calls = mockFetch((url) => {
    if (url.pathname.endsWith('/wellness')) return server.wellness ? server.wellness(url) : { body: [] };
    if (url.pathname.endsWith('/sport-settings')) return server.sport ? server.sport() : { body: [RIDE, RUN] };
    return { status: 404 };
  });
  return {
    calls,
    wellnessCalls: () => calls.filter((u) => u.pathname.endsWith('/wellness')),
    sportCalls: () => calls.filter((u) => u.pathname.endsWith('/sport-settings')),
  };
}

const HRV_CYCLE = [50, 55, 60, 65, 70];
const RHR_CYCLE = [47, 48, 49];

/** Repeating test pattern by day offset (stable across tests). */
function cycle(values: readonly number[], offset: number, shift = 0): number {
  const n = values.length;
  return values[(((offset + shift) % n) + n) % n];
}

/**
 * `days` days of steady wellness ending today: HRV 50–70 ms (60 today; normal
 * range ≈ 56–63 ms), resting HR 47–49 bpm (30-day mean 48; 47 today) and
 * 7 h 30 m of sleep every night. `tweak` overrides fields per day.
 */
function history(days: number, tweak: (offset: number) => Partial<WellnessRecord> = () => ({})): WellnessRecord[] {
  const out: WellnessRecord[] = [];
  for (let offset = -(days - 1); offset <= 0; offset++) {
    out.push({
      date: day(offset),
      hrv: cycle(HRV_CYCLE, offset, 2),
      restingHR: cycle(RHR_CYCLE, offset),
      sleepSecs: 7.5 * 3600,
      ...tweak(offset),
    });
  }
  return out;
}

beforeEach(() => {
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Normalization ─────────────────────────────────────────────────────────────

describe('normalizeWellness', () => {
  it('keeps plausible values and rounds counts', () => {
    expect(normalizeWellness({
      id: '2026-10-04', updated: '2026-10-04T07:12:00Z', restingHR: 47.6, hrv: 62.5, hrvSDNN: 80, sleepSecs: 27000.4,
      sleepScore: 84, sleepQuality: 2, avgSleepingHR: 52, readiness: 71, weight: 70.2, vo2max: 54, steps: 9876,
      soreness: 1, fatigue: 2, stress: 3, mood: 2,
    })).toEqual({
      date: '2026-10-04', updated: '2026-10-04T07:12:00Z', restingHR: 48, hrv: 62.5, hrvSDNN: 80, sleepSecs: 27000,
      sleepScore: 84, sleepQuality: 2, avgSleepingHR: 52, readiness: 71, weight: 70.2, vo2max: 54, steps: 9876,
      soreness: 1, fatigue: 2, stress: 3, mood: 2,
    });
  });

  it('drops 0/null placeholders, implausible values and values copied from settings', () => {
    expect(normalizeWellness({
      id: '2026-10-04', restingHR: 52, tempRestingHR: true, weight: 70, tempWeight: true,
      hrv: 0, sleepSecs: null, sleepScore: 0, steps: 0, avgSleepingHR: 400, readiness: Number.NaN, sleepQuality: 9,
    })).toBeNull();
    expect(normalizeWellness({ id: '2026-10-04T00:00:00', restingHR: 300, hrv: 1000, sleepSecs: 30000 }))
      .toEqual({ date: '2026-10-04', sleepSecs: 30000 });
  });

  it('rejects records without a usable date', () => {
    expect(normalizeWellness(null)).toBeNull();
    expect(normalizeWellness(undefined)).toBeNull();
    expect(normalizeWellness({ id: 'yesterday', hrv: 60 })).toBeNull();
  });
});

// ── Store & sync ──────────────────────────────────────────────────────────────

describe('syncWellness', () => {
  it('stores normalized records from a first sync of the last 365 days', async () => {
    await connect();
    const icu = mockIcu({
      wellness: () => ({ body: [
        row(-2, { restingHR: 48, hrv: 61.2, sleepSecs: 27300, sleepScore: 82, updated: '2026-10-03T07:00:00Z' }),
        row(-1, { restingHR: 0, hrv: 0, sleepSecs: 0, weight: 0 }),
        row(0, { restingHR: 46, tempRestingHR: true, hrv: 58, sleepSecs: 25200 }),
      ] }),
    });

    expect(await syncWellness()).toEqual({ fetched: 2 });

    const [call] = icu.wellnessCalls();
    expect(call.pathname).toBe('/api/v1/athlete/i42/wellness');
    expect(call.searchParams.get('oldest')).toBe(day(-364));
    expect(call.searchParams.get('newest')).toBe(TODAY);
    expect(getWellnessForDate(day(-2))).toEqual({
      date: day(-2), restingHR: 48, hrv: 61.2, sleepSecs: 27300, sleepScore: 82, updated: '2026-10-03T07:00:00Z',
    });
    expect(getWellnessForDate(day(-1))).toBeNull();
    expect(getWellnessForDate(TODAY)).toEqual({ date: TODAY, hrv: 58, sleepSecs: 25200 });
    expect(getWellnessRange(day(-30), TODAY).map((r) => r.date)).toEqual([day(-2), TODAY]);
    expect(getWellnessSyncState()).toEqual({
      lastSyncAt: NOW.toISOString(), lastFullSyncAt: NOW.toISOString(), lastError: null, lastErrorAt: null,
      days: 2, latestDate: TODAY,
    });
    expect(getSuggestedSleepHours(TODAY)).toBe(7);
    expect(getSuggestedSleepHours(day(-2))).toBe(7.6);
    expect(getSuggestedSleepHours(day(-10))).toBeNull();
  });

  it('syncs incrementally from a week before the newest day, mirroring changes in that window', async () => {
    await connect();
    let rows = [row(-20, { restingHR: 50 }), row(-3, { restingHR: 49 }), row(-2, { hrv: 60 })];
    const icu = mockIcu({ wellness: () => ({ body: rows }) });
    await syncWellness();

    // Day −3 was deleted in intervals.icu, day −2 edited, day −1 added.
    rows = [row(-2, { hrv: 70 }), row(-1, { sleepSecs: 28000 })];
    expect(await syncWellness()).toEqual({ fetched: 2 });

    const second = icu.wellnessCalls()[1];
    expect(second.searchParams.get('oldest')).toBe(day(-9));
    expect(second.searchParams.get('newest')).toBe(TODAY);
    expect(getWellnessRange(day(-30), TODAY)).toEqual([
      { date: day(-20), restingHR: 50 },
      { date: day(-2), hrv: 70 },
      { date: day(-1), sleepSecs: 28000 },
    ]);
    expect(getWellnessSyncState().lastFullSyncAt).toBe(NOW.toISOString());
  });

  it('re-reads the whole year when asked for a full sync', async () => {
    await connect();
    const icu = mockIcu({ wellness: () => ({ body: [row(-1, { hrv: 60 })] }) });
    await syncWellness();
    await syncWellness({ full: true });
    await syncWellness();
    expect(icu.wellnessCalls().map((u) => u.searchParams.get('oldest'))).toEqual([day(-364), day(-364), day(-8)]);
  });

  it('keeps about 400 days, trimming older records', async () => {
    persistence.setItem('apollo_wellness', JSON.stringify({
      [day(-401)]: { date: day(-401), restingHR: 50 },
      [day(-399)]: { date: day(-399), restingHR: 51 },
      [day(-200)]: { date: day(-200), restingHR: 52 },
    }));
    await connect();
    mockIcu({ wellness: () => ({ body: [row(-1, { restingHR: 49 })] }) });
    await syncWellness();
    // −401 is past the 400-day limit; −200 is inside the re-read year, which intervals.icu no longer has.
    expect(getWellnessRange('2000-01-01', TODAY).map((r) => r.date)).toEqual([day(-399), day(-1)]);
  });

  it('is skipped while intervals.icu is not connected or wellness sync is off', async () => {
    const icu = mockIcu();
    const listener = vi.fn();
    const unsubscribe = onWellnessUpdated(listener);
    try {
      expect(await syncWellness()).toEqual({ fetched: 0, skipped: 'not_connected' });
      await connect();
      setAppPreferences({ syncWellness: false });
      expect(await syncWellness()).toEqual({ fetched: 0, skipped: 'disabled' });
    } finally {
      unsubscribe();
    }
    expect(icu.calls).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
    expect(getWellnessSyncState().lastSyncAt).toBeNull();
  });

  it('never throws on a rejected key: the error is recorded and reported', async () => {
    await connect();
    const icu = mockIcu({ wellness: () => ({ status: 401 }) });
    const seen: WellnessSyncResult[] = [];
    const unsubscribe = onWellnessUpdated((r) => seen.push(r));
    let result: WellnessSyncResult;
    try {
      result = await syncWellness();
    } finally {
      unsubscribe();
    }
    expect(result.fetched).toBe(0);
    expect(result.error).toMatch(/rejected the API key/);
    expect(seen).toEqual([result]);
    expect(icu.wellnessCalls()).toHaveLength(1);
    expect(icu.sportCalls()).toHaveLength(0);
    expect(getWellnessSyncState()).toMatchObject({
      lastSyncAt: null, lastError: result.error, lastErrorAt: NOW.toISOString(), days: 0,
    });
  });

  it('never throws on server errors, and the next successful sync clears the error', async () => {
    await connect();
    let down = true;
    const icu = mockIcu({
      // Retry-After: 0.001 s keeps the transport's two retries instant.
      wellness: () => (down ? { status: 500, headers: { 'Retry-After': '0.001' } } : { body: [row(0, { hrv: 60 })] }),
    });
    expect(await syncWellness()).toEqual({ fetched: 0, error: 'intervals.icu error 500' });
    expect(icu.wellnessCalls()).toHaveLength(3);
    expect(getWellnessSyncState().lastError).toBe('intervals.icu error 500');

    down = false;
    expect(await syncWellness()).toEqual({ fetched: 1 });
    expect(getWellnessSyncState()).toMatchObject({ lastError: null, lastErrorAt: null, days: 1 });
  });

  it('returns at once when cancelled before it starts', async () => {
    await connect();
    const icu = mockIcu();
    const controller = new AbortController();
    controller.abort();
    expect(await syncWellness({ signal: controller.signal })).toEqual({ fetched: 0, error: 'Wellness sync was cancelled.' });
    expect(icu.calls).toHaveLength(0);
  });

  it('shares one request between overlapping syncs', async () => {
    await connect();
    const icu = mockIcu({ wellness: () => ({ body: [row(0, { hrv: 60 })] }) });
    const [a, b] = await Promise.all([syncWellness(), syncWellness()]);
    expect(a).toEqual({ fetched: 1 });
    expect(b).toBe(a);
    expect(icu.wellnessCalls()).toHaveLength(1);
  });

  it('starts over when a different athlete connects', async () => {
    await connect();
    let rows = [row(-380, { restingHR: 50 }), row(-1, { restingHR: 51 })];
    const icu = mockIcu({ wellness: () => ({ body: rows }) });
    await syncWellness();
    expect(getWellnessSyncState().days).toBe(2);

    await connect({ apiKey: 'other', athleteId: 'i99', connectedAt: '2026-10-05T09:00:00.000Z' });
    rows = [row(0, { restingHR: 60 })];
    await syncWellness();

    const second = icu.wellnessCalls()[1];
    expect(second.pathname).toBe('/api/v1/athlete/i99/wellness');
    expect(second.searchParams.get('oldest')).toBe(day(-364));
    expect(getWellnessRange('2000-01-01', TODAY)).toEqual([{ date: TODAY, restingHR: 60 }]);
  });

  it('notifies listeners after each sync until they unsubscribe', async () => {
    await connect();
    mockIcu({ wellness: () => ({ body: [row(-1, { hrv: 58 }), row(0, { hrv: 60 })] }) });
    const listener = vi.fn();
    const unsubscribe = onWellnessUpdated(listener);
    await syncWellness();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ fetched: 2 });
    unsubscribe();
    await syncWellness();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('feeds the stored data to getRecoverySnapshot', async () => {
    await connect();
    mockIcu({ wellness: () => ({ body: [
      row(-1, { hrv: 60, restingHR: 48, sleepSecs: 27000 }),
      row(0, { hrv: 62, restingHR: 47, sleepSecs: 27500, sleepScore: 88 }),
    ] }) });
    await syncWellness();
    const snap = getRecoverySnapshot();
    expect(snap).toMatchObject({ date: TODAY, status: 'unknown', daysWithData: 2 });
    expect(snap.reasons[0]).toMatch(/Need about a week of data/);
    expect(snap.sleep).toEqual({ date: TODAY, secs: 27500, score: 88, flagged: false });
  });
});

// ── HR profile ────────────────────────────────────────────────────────────────

describe('HR profile from intervals.icu', () => {
  it('fills resting HR (14-day median), max HR and LTHR', async () => {
    await connect();
    mockIcu({
      wellness: () => ({ body: [
        row(-20, { restingHR: 40 }),
        row(-4, { restingHR: 50 }), row(-3, { restingHR: 47 }), row(-2, { restingHR: 52 }),
        row(-1, { restingHR: 48 }), row(0, { restingHR: 49 }),
      ] }),
    });
    await syncWellness();
    expect(getHRProfile()).toEqual({ maxHR: 188, restingHR: 49, lthr: 168, source: 'intervals', updatedAt: NOW.toISOString() });
  });

  it('needs at least 3 resting HR readings', async () => {
    await connect();
    mockIcu({
      wellness: () => ({ body: [row(-1, { restingHR: 50 }), row(0, { restingHR: 48 })] }),
      sport: () => ({ body: [] }),
    });
    await syncWellness();
    expect(getHRProfile()).toEqual(DEFAULT_PROFILE);
  });

  it('never changes a profile entered manually', async () => {
    const manual: HRProfile = { maxHR: 201, restingHR: 41, lthr: 175, source: 'manual', updatedAt: '2026-01-01T00:00:00.000Z' };
    setHRProfile(manual);
    await connect();
    mockIcu({ wellness: () => ({ body: [row(-2, { restingHR: 50 }), row(-1, { restingHR: 50 }), row(0, { restingHR: 50 })] }) });
    await syncWellness();
    expect(getHRProfile()).toEqual(manual);
  });

  it('ignores an implausible max HR and keeps raises from harder runs', async () => {
    await connect();
    let run: IcuSportSettings = { ...RUN, max_hr: 250, lthr: 0 };
    mockIcu({ sport: () => ({ body: [run] }) });
    await syncWellness();
    expect(getHRProfile()).toEqual(DEFAULT_PROFILE);

    run = { ...RUN, max_hr: 188 };
    await refreshRunSportSettings();
    expect(getHRProfile()).toMatchObject({ maxHR: 188, lthr: 168, source: 'intervals' });

    // A harder run raised it on this device (heartRate.buildHRDataFromActivity)…
    setHRProfile({ ...getHRProfile(), maxHR: 192 });
    // …and re-reading the unchanged sport settings doesn't undo that…
    await refreshRunSportSettings();
    expect(getHRProfile().maxHR).toBe(192);
    // …but a new value set in intervals.icu is copied.
    run = { ...RUN, max_hr: 195 };
    await refreshRunSportSettings();
    expect(getHRProfile().maxHR).toBe(195);
  });
});

// ── Run threshold pace ────────────────────────────────────────────────────────

describe('getRunThresholdPaceStatus', () => {
  it('is unknown until the sport settings were read', async () => {
    expect(getRunThresholdPaceStatus()).toEqual({ known: false, missing: false });
    await connect();
    expect(getRunThresholdPaceStatus()).toEqual({ known: false, missing: false });
  });

  it('is known, with the pace in sec/km, once read', async () => {
    await connect();
    const icu = mockIcu({ sport: () => ({ body: [RIDE, { ...RUN, threshold_pace: 4 }] }) });
    await syncWellness();
    expect(icu.sportCalls()).toHaveLength(1);
    expect(icu.sportCalls()[0].pathname).toBe('/api/v1/athlete/i42/sport-settings');
    expect(getRunThresholdPaceStatus()).toEqual({ known: true, missing: false, secPerKm: 250 });

    clearIntervalsCredentials();
    expect(getRunThresholdPaceStatus()).toEqual({ known: false, missing: false });
  });

  it('is missing when the Run threshold pace is 0 or absent, or there are no Run settings', async () => {
    await connect();
    const variants: IcuSportSettings[][] = [
      [RIDE, { ...RUN, threshold_pace: 0 }],
      [{ id: 2, types: ['Run'], lthr: 168, max_hr: 188 }],
      [{ ...RUN, threshold_pace: null }],
      [RIDE],
    ];
    for (const body of variants) {
      mockIcu({ sport: () => ({ body }) });
      expect(await refreshRunSportSettings()).toEqual({ ok: true });
      expect(getRunThresholdPaceStatus()).toEqual({ known: false, missing: true });
    }
  });

  it('stays unknown, not missing, when reading the sport settings failed', async () => {
    await connect();
    mockIcu({ sport: () => ({ status: 404 }) });
    const result = await refreshRunSportSettings();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not find/);
    expect(getRunThresholdPaceStatus()).toEqual({ known: false, missing: false });
  });

  it('is re-read hourly while missing and daily once set', async () => {
    await connect();
    let pace = 0;
    const icu = mockIcu({ sport: () => ({ body: [{ ...RUN, threshold_pace: pace }] }) });
    const at = (ms: number) => vi.setSystemTime(new Date(NOW.getTime() + ms));

    await syncWellness();
    expect(icu.sportCalls()).toHaveLength(1);
    expect(getRunThresholdPaceStatus().missing).toBe(true);

    at(0.5 * HOUR);
    await syncWellness();
    expect(icu.sportCalls()).toHaveLength(1);

    pace = 4.2; // the athlete sets it in intervals.icu
    at(1.1 * HOUR);
    await syncWellness();
    expect(icu.sportCalls()).toHaveLength(2);
    expect(getRunThresholdPaceStatus()).toEqual({ known: true, missing: false, secPerKm: 238.1 });

    at(1.1 * HOUR + 23 * HOUR);
    await syncWellness();
    expect(icu.sportCalls()).toHaveLength(2);

    at(1.1 * HOUR + 24 * HOUR);
    await syncWellness();
    expect(icu.sportCalls()).toHaveLength(3);
  });

  it('can be checked on demand with wellness sync off, and again after reconnecting', async () => {
    await connect();
    setAppPreferences({ syncWellness: false });
    const icu = mockIcu({ sport: () => ({ body: [{ ...RUN, threshold_pace: 0 }] }) });
    const listener = vi.fn();
    const unsubscribe = onWellnessUpdated(listener);
    try {
      expect(await checkRunThresholdPace()).toEqual({ known: false, missing: true });
      expect(icu.sportCalls()).toHaveLength(1);
      expect(icu.wellnessCalls()).toHaveLength(0);
      expect(listener).toHaveBeenCalledWith({ fetched: 0 });
      // Wellness sync is off, so the HR profile is left alone.
      expect(getHRProfile()).toEqual(DEFAULT_PROFILE);

      // Not due again yet.
      expect(await checkRunThresholdPace()).toEqual({ known: false, missing: true });
      expect(icu.sportCalls()).toHaveLength(1);

      // A new connection makes the cached answer stale: it's read again right away.
      await connect({ ...CREDS, connectedAt: '2026-10-05T09:00:00.000Z' });
      expect(getRunThresholdPaceStatus()).toEqual({ known: false, missing: false });
      expect(await checkRunThresholdPace()).toEqual({ known: false, missing: true });
      expect(icu.sportCalls()).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });
});

// ── Recovery model ────────────────────────────────────────────────────────────

describe('computeRecoverySnapshot', () => {
  it('needs about a week of data before rating anything', () => {
    const none = computeRecoverySnapshot([], TODAY);
    expect(none).toMatchObject({ status: 'unknown', headline: 'No recovery data yet', daysWithData: 0 });
    expect(none.reasons[0]).toMatch(/Need about a week/);

    // Very short sleep on day 3 is reported, but never rated "caution" on so little data.
    const few = computeRecoverySnapshot(history(3, (o) => (o === 0 ? { sleepSecs: 4 * 3600 } : {})), TODAY);
    expect(few).toMatchObject({
      status: 'unknown',
      headline: 'Learning your normal ranges',
      suggestion: 'Train as planned and go by feel for now.',
      daysWithData: 3,
    });
    expect(few.reasons[0]).toBe('Need about a week of data to learn your normal ranges (3 of 7 days so far).');
    expect(few.reasons).toContain('You slept only 4h 00m.');
  });

  it('is unknown when nothing arrived in the last 2 days', () => {
    const snap = computeRecoverySnapshot(history(30), day(3));
    expect(snap).toMatchObject({ status: 'unknown', headline: 'No recent recovery data', daysWithData: 30 });
    expect(snap.sleep).toBeUndefined();
    expect(snap.restingHR).toBeUndefined();
  });

  it('is good when HRV and resting HR are in their normal ranges', () => {
    const snap = computeRecoverySnapshot(history(60), TODAY);
    expect(snap).toMatchObject({
      status: 'good', headline: 'Well recovered', suggestion: 'Train as planned.', date: TODAY, daysWithData: 60,
    });
    expect(snap.hrv).toMatchObject({ date: TODAY, latest: 60, position: 'within', baselineDays: 60, flagged: false });
    expect(snap.hrv!.low!).toBeLessThan(snap.hrv!.avg7!);
    expect(snap.hrv!.avg7!).toBeLessThan(snap.hrv!.high!);
    expect(snap.restingHR).toEqual({ date: TODAY, bpm: 47, baseline: 48, delta: -1, flagged: false });
    expect(snap.sleep).toEqual({ date: TODAY, secs: 27000, avg7Secs: 27000, flagged: false });
    expect(snap.reasons).toEqual([
      'You slept 7h 30m.',
      'Resting HR is 47 bpm, in line with your 30-day average (48).',
      'HRV 7-day average (59 ms) is within your normal range (56–63 ms).',
    ]);
  });

  it('suggests an easy day when HRV is below normal and resting HR is up', () => {
    const snap = computeRecoverySnapshot(history(60, (o) => ({
      ...(o >= -6 ? { hrv: 53 } : {}),
      ...(o === 0 ? { restingHR: 54 } : {}),
    })), TODAY);
    expect(snap.status).toBe('caution');
    expect(snap.headline).toBe('Take it easy today');
    expect(snap.suggestion).toBe(
      'HRV is below your normal range and resting HR is up 6 bpm: keep today easy or swap the workout with a rest day.',
    );
    expect(snap.hrv).toMatchObject({ avg7: 53, position: 'below', flagged: true });
    expect(snap.restingHR).toMatchObject({ bpm: 54, baseline: 48, delta: 6, flagged: true });
    expect(snap.reasons[0]).toMatch(/^HRV 7-day average is 53 ms, below your normal range \(\d+–\d+ ms\)\.$/);
    expect(snap.reasons[1]).toBe('Resting HR is 54 bpm, 6 bpm above your 30-day average (48).');
  });

  it('rates one moderate signal "ok" and one strong signal "caution"', () => {
    const hrvLow = computeRecoverySnapshot(history(60, (o) => (o >= -6 ? { hrv: 53 } : {})), TODAY);
    expect(hrvLow).toMatchObject({ status: 'ok', headline: 'Mostly recovered' });
    expect(hrvLow.suggestion).toBe(
      'HRV is below your normal range: train as planned, but back off if your warm-up feels harder than usual.',
    );

    const hrvVeryLow = computeRecoverySnapshot(history(60, (o) => (o >= -6 ? { hrv: 45 } : {})), TODAY);
    expect(hrvVeryLow.status).toBe('caution');
    expect(hrvVeryLow.suggestion).toBe(
      'HRV is well below your normal range: keep today easy or swap the workout with a rest day.',
    );

    const rhrAt = (bpm: number) => computeRecoverySnapshot(history(60, (o) => (o === 0 ? { restingHR: bpm } : {})), TODAY);
    expect(rhrAt(52).status).toBe('good');
    expect(rhrAt(52).reasons).toContain('Resting HR is 52 bpm, slightly above your 30-day average (48).');
    expect(rhrAt(53).status).toBe('ok');
    expect(rhrAt(53).suggestion).toMatch(/^Resting HR is up 5 bpm: train as planned/);
    expect(rhrAt(59).status).toBe('caution');
    expect(rhrAt(59).suggestion).toMatch(/^Resting HR is up 11 bpm: keep today easy/);
  });

  it('explains short sleep against the 7 h floor and the 7-night average', () => {
    const sleptFor = (secs: number) =>
      computeRecoverySnapshot(history(60, (o) => (o === 0 ? { sleepSecs: secs } : {})), TODAY);

    const short = sleptFor(5 * 3600 + 40 * 60);
    expect(short.status).toBe('ok');
    expect(short.sleep).toMatchObject({ secs: 20400, avg7Secs: 27000, flagged: true });
    expect(short.reasons[0]).toBe('You slept 5h 40m, 1h 50m less than your 7-night average (7h 30m).');
    expect(short.suggestion).toBe(
      'Sleep was short (5h 40m): train as planned, but back off if your warm-up feels harder than usual.',
    );

    const belowUsual = sleptFor(6 * 3600 + 20 * 60);
    expect(belowUsual.status).toBe('ok');
    expect(belowUsual.reasons[0]).toBe('You slept 6h 20m, 1h 10m less than your 7-night average (7h 30m).');

    const littleUnder = sleptFor(6 * 3600 + 45 * 60);
    expect(littleUnder.status).toBe('good');
    expect(littleUnder.sleep?.flagged).toBe(false);
    expect(littleUnder.reasons).toContain('You slept 6h 45m, a little under 7 hours.');

    const veryShort = sleptFor(4.5 * 3600);
    expect(veryShort.status).toBe('caution');
    expect(veryShort.suggestion).toBe('You slept only 4h 30m: keep today easy or swap the workout with a rest day.');
  });

  it('lists strong signals first and counts high self-reported fatigue or soreness', () => {
    const tired = computeRecoverySnapshot(history(60, (o) => (o === 0 ? { fatigue: 3 } : {})), TODAY);
    expect(tired.status).toBe('ok');
    expect(tired.suggestion).toBe(
      'You logged high fatigue: train as planned, but back off if your warm-up feels harder than usual.',
    );

    const rough = computeRecoverySnapshot(history(60, (o) => ({
      ...(o >= -6 ? { hrv: 53 } : {}),
      ...(o === 0 ? { sleepSecs: 4 * 3600 + 15 * 60, fatigue: 3, soreness: 4, stress: 2 } : {}),
    })), TODAY);
    expect(rough.status).toBe('caution');
    expect(rough.suggestion).toBe('You slept only 4h 15m, HRV is below your normal range and you logged high fatigue '
      + 'and soreness: keep today easy or swap the workout with a rest day.');
  });

  it('notes a single low HRV reading without acting on it', () => {
    const snap = computeRecoverySnapshot(history(60, (o) => (o === 0 ? { hrv: 48 } : {})), TODAY);
    expect(snap.status).toBe('good');
    expect(snap.hrv).toMatchObject({ latest: 48, position: 'within', flagged: false });
    expect(snap.reasons).toContain("Your latest HRV reading (48 ms) was low, but one reading on its own isn't a concern.");
  });

  it('says "no warning signs" rather than "good" without an HRV or resting-HR baseline', () => {
    const sleepOnly: WellnessRecord[] = history(10).map(({ date, sleepSecs }) => ({ date, sleepSecs }));
    const snap = computeRecoverySnapshot(sleepOnly, TODAY);
    expect(snap).toMatchObject({ status: 'ok', headline: 'No warning signs', suggestion: 'Train as planned.' });
    expect(snap.hrv).toBeUndefined();
    expect(snap.restingHR).toBeUndefined();
  });

  it('returns a 14-day series for the sparklines, oldest first, with gaps', () => {
    const records = history(20, (o) => (o === 0 ? { hrv: undefined } : {})).filter((r) => r.date !== day(-5));
    records.push({ date: day(1), hrv: 10 }); // in the future: ignored
    const { series } = computeRecoverySnapshot(records, TODAY);

    expect(series.map((p) => p.date)).toEqual(Array.from({ length: 14 }, (_, i) => day(i - 13)));
    expect(series[0]).toEqual({
      date: day(-13), hrv: cycle(HRV_CYCLE, -13, 2), restingHR: cycle(RHR_CYCLE, -13), sleepHours: 7.5,
    });
    expect(series[8]).toEqual({ date: day(-5) });
    expect(series[13]).toEqual({ date: TODAY, restingHR: 47, sleepHours: 7.5 });
  });
});
