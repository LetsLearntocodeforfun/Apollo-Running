/**
 * Unit tests for the plan → intervals.icu calendar sync
 * (services/planCalendarSync.ts): the pure workout builder (names,
 * external_ids, units, pace text, sections) and push / removal / auto-sync
 * against a small fake intervals.icu calendar (stubbed fetch — no network).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildPlanWorkouts,
  planExternalId,
  toIcuEvent,
  pushPlanToIntervals,
  removePlanFromIntervals,
  syncPlanCalendarIfChanged,
  getPlanPushState,
  setPlanAutoPush,
  onPlanPushStateChange,
  hasPlanTargetPaces,
  hashPlannedWorkout,
  resolvePlanTrainingPaces,
  isPlanPushRunning,
  AUTO_PUSH_WEEKS,
  type BuildPlanWorkoutsOptions,
  type PlannedWorkout,
} from '@/services/planCalendarSync';
import { IntervalsAuthError, IntervalsHttpError, type IcuEventInput } from '@/services/intervals';
import { setIntervalsCredentials, clearIntervalsCredentials, type IntervalsCredentials } from '@/services/storage';
import { setActivePlan, formatDateKey, getDateForDay } from '@/services/planProgress';
import { calculateTrainingPaces, saveTrainingPaces, type TrainingPaces } from '@/services/paceCalculator';
import { updateAthleteProfile } from '@/services/athleteProfile';
import { setDistanceUnit } from '@/services/unitPreferences';
import { setCustomPlan, CUSTOM_PLAN_ID, type PlanDay, type TrainingPlan } from '@/data/plans';
import { persistence } from '@/services/db/persistence';

const CREDS: IntervalsCredentials = { apiKey: 'secret-key', athleteId: 'i42' };
const STATE_KEY = 'apollo_icu_plan_push';

/** VDOT 45 training paces (sec/mi), fixed so expectations don't depend on the calculator. */
const PACES: TrainingPaces = {
  vdot: 45,
  easy: { min: 537, max: 559 },
  marathon: 496,
  threshold: 465,
  interval: 428,
  repetition: 400,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const REST: PlanDay = { type: 'rest', label: 'Rest' };
const EASY: PlanDay = { type: 'run', label: '5 mi', distanceMi: 5, note: 'Easy' };
const TEMPO: PlanDay = { type: 'run', label: '7 mi tempo', distanceMi: 7, note: 'Tempo' };
const CROSS: PlanDay = { type: 'cross', label: 'Cross' };
const SPEED: PlanDay = { type: 'run', label: '6 mi w/ speed', distanceMi: 6, note: 'Speed' };
/** Pfitzinger-style marathon-pace day: the label says MP, the note says Tempo. */
const PFITZ_MP: PlanDay = { type: 'run', label: '8 mi marathon pace', distanceMi: 8, note: 'Tempo' };
const LONG: PlanDay = { type: 'run', label: '18 mi', distanceMi: 18, note: 'Long' };
const HALF: PlanDay = { type: 'race', label: 'Half Marathon', distanceMi: 13.1, note: 'Race' };
const MARATHON: PlanDay = { type: 'marathon', label: 'Marathon', distanceMi: 26.2, note: 'Race day' };

/** Rest, easy, tempo, cross, speed, marathon pace, long: 6 workouts a week. */
const WEEK: PlanDay[] = [REST, EASY, TEMPO, CROSS, SPEED, PFITZ_MP, LONG];

function makePlan(weeks: PlanDay[][]): TrainingPlan {
  return {
    id: CUSTOM_PLAN_ID,
    name: 'Test plan',
    author: 'Apollo',
    description: '',
    totalWeeks: weeks.length,
    weeks: weeks.map((days, i) => ({ weekNumber: i + 1, days })),
  };
}

function repeatWeek(n: number): PlanDay[][] {
  return Array.from({ length: n }, () => WEEK);
}

const START = '2026-01-05'; // a Monday
const MI: BuildPlanWorkoutsOptions = { from: START, unit: 'mi', paces: PACES, vdot: null };
const KM: BuildPlanWorkoutsOptions = { ...MI, unit: 'km' };

/** The workout built for a single plan day (week 1, day 1). */
function one(day: PlanDay, opts: BuildPlanWorkoutsOptions = MI): PlannedWorkout {
  return buildPlanWorkouts(makePlan([[day]]), START, opts)[0];
}

/** The description without its coaching note: just the step sections. */
function steps(w: PlannedWorkout): string {
  return w.description.split('\n\n').slice(1).join('\n\n');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Builder ───────────────────────────────────────────────────────────────────

describe('buildPlanWorkouts', () => {
  it('creates one workout per non-rest day with stable external_ids and dates', () => {
    const plan = makePlan([WEEK, WEEK]);
    const workouts = buildPlanWorkouts(plan, START, MI);

    expect(workouts).toHaveLength(12);
    expect(workouts[0]).toMatchObject({
      external_id: `apollo:${CUSTOM_PLAN_ID}:2026-01-05:w1d2`,
      date: '2026-01-06',
      category: 'WORKOUT',
      type: 'Run',
      target: 'PACE',
    });
    expect(workouts[11]).toMatchObject({ external_id: `apollo:${CUSTOM_PLAN_ID}:2026-01-05:w2d7`, date: '2026-01-18' });
    // Rest days are skipped.
    const dates = workouts.map((w) => w.date);
    expect(dates).not.toContain('2026-01-05');
    expect(dates).not.toContain('2026-01-12');
    // Same plan instance → same IDs; another start date → another instance.
    expect(buildPlanWorkouts(plan, START, MI).map((w) => w.external_id)).toEqual(workouts.map((w) => w.external_id));
    expect(buildPlanWorkouts(plan, '2026-01-12', { ...MI, from: '2026-01-12' })[0].external_id)
      .toBe(`apollo:${CUSTOM_PLAN_ID}:2026-01-12:w1d2`);
    expect(planExternalId('pfitzinger-18-55', '2026-03-02', 17, 6)).toBe('apollo:pfitzinger-18-55:2026-03-02:w18d7');
  });

  it("names workouts clearly, in the athlete's unit", () => {
    const plan = makePlan([WEEK, [HALF, REST, REST, REST, REST, REST, MARATHON]]);
    expect(buildPlanWorkouts(plan, START, MI).map((w) => w.name)).toEqual([
      'Easy Run · 5 mi', 'Tempo · 7 mi', 'Cross-Training · 45 min', '5 × 800m Intervals',
      'Marathon Pace · 8 mi', 'Long Run · 18 mi', 'Half Marathon Race', 'Marathon Day 🏅',
    ]);
    expect(buildPlanWorkouts(plan, START, KM).map((w) => w.name)).toEqual([
      'Easy Run · 8 km', 'Tempo · 11.3 km', 'Cross-Training · 45 min', '6 × 800m Intervals',
      'Marathon Pace · 12.9 km', 'Long Run · 29 km', 'Half Marathon Race', 'Marathon Day 🏅',
    ]);
    expect(one({ type: 'race', label: 'Race', distanceMi: 6.2, note: 'Race' }).name).toBe('Race · 6.2 mi');
    expect(one({ type: 'run', label: '4 mi recovery', distanceMi: 4, note: 'Easy' }).name).toBe('Recovery Run · 4 mi');
    expect(one({ type: 'run', label: '11 mi', distanceMi: 11, note: 'Medium Long' }).name).toBe('Medium-Long Run · 11 mi');
  });

  it('easy runs: one distance step at the easy-pace range (mi and km)', () => {
    expect(one(EASY).description).toBe('Easy run. Relaxed, conversational effort.\n\n- 5mi 9:19-8:57/mi Pace');
    expect(steps(one(EASY, KM))).toBe('- 8km 5:47-5:34/km Pace');
  });

  it('tempo: easy warm-up, threshold block, easy cool-down', () => {
    expect(one(TEMPO).description).toBe([
      'Tempo. Comfortably hard: short phrases only.',
      'Warmup\n- 1mi 9:19-8:57/mi Pace',
      'Tempo\n- 5mi 7:50-7:40/mi Pace',
      'Cooldown\n- 1mi 9:19-8:57/mi Pace',
    ].join('\n\n'));
    expect(steps(one(TEMPO, KM))).toBe(
      'Warmup\n- 1km 5:47-5:34/km Pace\n\nTempo\n- 9.3km 4:52-4:46/km Pace\n\nCooldown\n- 1km 5:47-5:34/km Pace',
    );
    // Shorter runs get shorter bookends; very short ones none.
    expect(steps(one({ ...TEMPO, distanceMi: 3 }))).toBe(
      'Warmup\n- 0.5mi 9:19-8:57/mi Pace\n\nTempo\n- 2mi 7:50-7:40/mi Pace\n\nCooldown\n- 0.5mi 9:19-8:57/mi Pace',
    );
    expect(steps(one({ ...TEMPO, distanceMi: 2 }))).toBe('Tempo\n- 2mi 7:50-7:40/mi Pace');
  });

  it('speed: warm-up, "Main set Nx" of reps + recovery jogs, cool-down, sized to the planned distance', () => {
    const mi = one(SPEED);
    expect(mi.name).toBe('5 × 800m Intervals');
    expect(steps(mi)).toBe([
      'Warmup\n- 1mi 9:19-8:57/mi Pace',
      'Main set 5x\n- 800mtr 7:13-7:03/mi Pace\n- Recovery jog 3m30',
      'Cooldown\n- 1mi 9:19-8:57/mi Pace',
    ].join('\n\n'));
    expect(steps(one(SPEED, KM))).toContain('Main set 6x\n- 800mtr 4:29-4:23/km Pace\n- Recovery jog 3m30');
    // Short sessions switch to 400 m reps with half-length bookends.
    const short = one({ ...SPEED, distanceMi: 3 });
    expect(short.name).toBe('5 × 400m Intervals');
    expect(steps(short)).toBe([
      'Warmup\n- 0.5mi 9:19-8:57/mi Pace',
      'Main set 5x\n- 400mtr 7:13-7:03/mi Pace\n- Recovery jog 1m45',
      'Cooldown\n- 0.5mi 9:19-8:57/mi Pace',
    ].join('\n\n'));
  });

  it('marathon-pace runs: easy, marathon-pace segment, easy', () => {
    const pfitz = one(PFITZ_MP);
    expect(pfitz.name).toBe('Marathon Pace · 8 mi');
    expect(pfitz.description).toBe([
      'Marathon pace. Controlled and sustainable: rehearse race day.',
      'Warmup\n- 2mi 9:19-8:57/mi Pace',
      'Marathon pace\n- 5mi 8:21-8:11/mi Pace',
      'Cooldown\n- 1mi 9:19-8:57/mi Pace',
    ].join('\n\n'));
    // Custom-builder style day.
    expect(steps(one({ type: 'run', label: '6 mi MP', distanceMi: 6, note: 'Marathon Pace' }))).toBe(
      'Warmup\n- 2mi 9:19-8:57/mi Pace\n\nMarathon pace\n- 3mi 8:21-8:11/mi Pace\n\nCooldown\n- 1mi 9:19-8:57/mi Pace',
    );
    expect(steps(one(PFITZ_MP, KM))).toBe(
      'Warmup\n- 2km 5:47-5:34/km Pace\n\nMarathon pace\n- 9.9km 5:11-5:05/km Pace\n\nCooldown\n- 1km 5:47-5:34/km Pace',
    );
  });

  it("long runs: one easy step, plus the optional marathon-pace finish from Apollo's long-run target", () => {
    expect(one(LONG).description).toBe(
      'Long run. Easy effort; practice your race-day fueling. Optional: last 4 mi at marathon pace (8:16/mi).'
      + '\n\n- 18mi 9:19-8:57/mi Pace',
    );
    const km = one(LONG, KM);
    expect(km.description).toContain('Optional: last 6 km at marathon pace (5:08/km).');
    expect(steps(km)).toBe('- 29km 5:47-5:34/km Pace');
    expect(one({ ...LONG, distanceMi: 12 }).description)
      .toBe('Long run. Easy effort; practice your race-day fueling.\n\n- 12mi 9:19-8:57/mi Pace');
  });

  it('races and marathon day: race pace', () => {
    expect(one(MARATHON).description)
      .toBe('Marathon day! Start controlled, fuel early, finish strong.\n\n- 26.2mi 8:21-8:11/mi Pace');
    expect(steps(one(MARATHON, KM))).toBe('- 42.2km 5:11-5:05/km Pace');
    expect(steps(one(HALF))).toBe('- 13.1mi 8:01-7:51/mi Pace');
    expect(steps(one(HALF, KM))).toBe('- 21.1km 4:59-4:53/km Pace');
  });

  it('cross-training days: a timed "Workout" without pace targets', () => {
    const cross = one(CROSS);
    expect(cross).toMatchObject({ type: 'Workout', name: 'Cross-Training · 45 min', moving_time: 2700 });
    expect(cross.target).toBeUndefined();
    expect(steps(cross)).toBe('- Easy cross-training 45m');
  });

  it('sends plain distance steps when paces are unknown', () => {
    const workouts = buildPlanWorkouts(makePlan([WEEK]), START, { ...MI, paces: null, vdot: null });
    expect(steps(workouts[0])).toBe('- 5mi');
    expect(steps(workouts[1])).toBe('Warmup\n- 1mi\n\nTempo\n- 5mi\n\nCooldown\n- 1mi');
    expect(steps(workouts[3])).toBe('Warmup\n- 1mi\n\nMain set 6x\n- 800mtr\n- Recovery jog 2m30\n\nCooldown\n- 1mi');
    expect(workouts[5].description).toBe('Long run. Easy effort; practice your race-day fueling.\n\n- 18mi');
    for (const w of workouts) expect(w.description).not.toMatch(/Pace$|\/mi/m);
  });

  it('derives paces from the VDOT when only the score is known', () => {
    const plan = makePlan([WEEK]);
    const fromVdot = buildPlanWorkouts(plan, START, { ...MI, paces: null, vdot: 45 });
    expect(fromVdot).toEqual(buildPlanWorkouts(plan, START, { ...MI, paces: calculateTrainingPaces(45), vdot: 45 }));
    expect(steps(fromVdot[0])).toMatch(/^- 5mi \d+:\d{2}-\d+:\d{2}\/mi Pace$/);
  });

  it("writes every step in intervals.icu syntax: slow-fast paces in the athlete's unit, short prompts", () => {
    const STEP = /^- (?:([A-Za-z][A-Za-z -]*) )?(\d+(?:\.\d)?(?:mi|km|mtr)|\d+h(?:\d+m)?|\d+m(?:\d{2})?|\d+s)(?: (\d+):(\d{2})(?:-(\d+):(\d{2}))?\/(mi|km) Pace)?$/;
    const plan = makePlan([WEEK, [HALF, REST, EASY, TEMPO, { ...SPEED, distanceMi: 3 }, REST, MARATHON]]);
    for (const opts of [MI, KM, { ...MI, paces: null }]) {
      for (const w of buildPlanWorkouts(plan, START, opts)) {
        const lines = w.description.split('\n').filter((l) => l.startsWith('-'));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          const m = STEP.exec(line);
          if (!m) throw new Error(`Not intervals.icu step syntax: "${line}"`);
          expect((m[1] ?? '').length).toBeLessThanOrEqual(30);
          if (m[3]) expect(m[7]).toBe(opts.unit);
          if (m[5]) expect(Number(m[3]) * 60 + Number(m[4])).toBeGreaterThan(Number(m[5]) * 60 + Number(m[6]));
        }
      }
    }
  });

  it('limits the output to `from` and `weeks`', () => {
    const plan = makePlan(repeatWeek(3));
    expect(buildPlanWorkouts(plan, START, { ...MI, from: '2026-01-08', weeks: 1 }).map((w) => w.date))
      .toEqual(['2026-01-08', '2026-01-09', '2026-01-10', '2026-01-11', '2026-01-13', '2026-01-14']);
    expect(buildPlanWorkouts(plan, START, { ...MI, weeks: 0 })).toEqual([]);
    expect(buildPlanWorkouts(plan, START, { ...MI, from: '2026-02-01' })).toEqual([]);
  });

  it('estimates moving time from the target paces', () => {
    expect(one(EASY).moving_time).toBe(2760);                                  // 5 mi at ~9:08/mi → 46 min
    expect(one(EASY, { ...MI, paces: null }).moving_time).toBe(2880);          // 5 mi at 9:30/mi → 48 min
    expect(one(MARATHON).moving_time).toBe(13020);                             // 26.2 mi at 8:16/mi → 3:37
  });
});

describe('toIcuEvent', () => {
  it('maps a workout to the intervals.icu event Apollo sends', () => {
    const run = one(EASY);
    expect(toIcuEvent(run)).toEqual({
      category: 'WORKOUT',
      start_date_local: '2026-01-05T00:00:00',
      type: 'Run',
      name: 'Easy Run · 5 mi',
      description: run.description,
      moving_time: 2760,
      external_id: `apollo:${CUSTOM_PLAN_ID}:2026-01-05:w1d1`,
      tags: ['apollo'],
      target: 'PACE',
    });
    expect('target' in toIcuEvent(one(CROSS))).toBe(false);
  });
});

// ── Push / remove / auto against a fake intervals.icu ─────────────────────────

interface Call {
  method: string;
  url: URL;
  body: unknown;
}

function fakeResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

/**
 * Stub fetch with a tiny intervals.icu calendar: bulk upserts store events by
 * external_id, bulk-delete removes them, GET /events lists them all. Set
 * `fail` to answer matching requests with an error status instead.
 */
function mockIntervals() {
  const server = {
    calendar: new Map<string, IcuEventInput>(),
    calls: [] as Call[],
    fail: undefined as ((call: Call) => number | undefined) | undefined,
    upserts: () => server.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/events/bulk')),
    deletes: () => server.calls.filter((c) => c.method === 'PUT' && c.url.pathname.endsWith('/events/bulk-delete')),
    lists: () => server.calls.filter((c) => c.method === 'GET' && c.url.pathname.endsWith('/events')),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    server.calls.push(call);
    const status = server.fail?.(call);
    if (status) return fakeResponse(status);
    const path = call.url.pathname;
    if (call.method === 'POST' && path.endsWith('/events/bulk')) {
      const events = call.body as IcuEventInput[];
      for (const e of events) server.calendar.set(String(e.external_id), e);
      return fakeResponse(200, events.map((e, i) => ({ id: i + 1, ...e })));
    }
    if (call.method === 'PUT' && path.endsWith('/events/bulk-delete')) {
      const ids = (call.body as { external_id: string }[]).map((x) => x.external_id);
      return fakeResponse(200, { eventsDeleted: ids.filter((id) => server.calendar.delete(id)).length });
    }
    if (call.method === 'GET' && path.endsWith('/events')) {
      return fakeResponse(200, [...server.calendar.values()].map((e, i) => ({ id: i + 1, ...e })));
    }
    return fakeResponse(404);
  }));
  return server;
}

function today(): string {
  return formatDateKey(new Date());
}

function addDays(dateKey: string, days: number): string {
  return formatDateKey(getDateForDay(dateKey, 0, days));
}

/** external_ids in a bulk request body. */
function idsIn(call: Call): (string | undefined)[] {
  return (call.body as { external_id?: string }[]).map((e) => e.external_id);
}

function activate(weeks: PlanDay[][], startDate: string): void {
  const plan = makePlan(weeks);
  setCustomPlan(plan);
  setActivePlan({ planId: plan.id, startDate });
}

function calendarEvent(externalId: string, date: string, name: string): IcuEventInput {
  return { category: 'WORKOUT', start_date_local: `${date}T00:00:00`, name, external_id: externalId };
}

describe('pushPlanToIntervals', () => {
  it('upserts today → end of plan by external_id and records the push', async () => {
    setIntervalsCredentials(CREDS);
    const start = today();
    activate([WEEK, WEEK], start);
    const icu = mockIntervals();
    const progress: string[] = [];

    const result = await pushPlanToIntervals({ onProgress: (m) => progress.push(m) });

    expect(result).toEqual({ upserted: 12, deleted: 0, from: start, to: addDays(start, 13) });
    expect(icu.calls).toHaveLength(1); // one bulk upsert; pushes never list the calendar
    const [post] = icu.upserts();
    expect(post.url.pathname).toBe('/api/v1/athlete/i42/events/bulk');
    expect(post.url.searchParams.get('upsert')).toBe('true');
    const events = post.body as IcuEventInput[];
    expect(events).toHaveLength(12);
    expect(events[0]).toMatchObject({
      category: 'WORKOUT',
      type: 'Run',
      name: 'Easy Run · 5 mi',
      target: 'PACE',
      tags: ['apollo'],
      start_date_local: `${addDays(start, 1)}T00:00:00`,
      external_id: planExternalId(CUSTOM_PLAN_ID, start, 0, 1),
    });
    expect(progress).toEqual(['Sending 12 workouts to intervals.icu…']);

    const state = getPlanPushState();
    expect(state.planKey).toBe(`${CUSTOM_PLAN_ID}:${start}`);
    expect(state.pushedIds).toEqual(events.map((e) => e.external_id));
    expect(state.lastPushAt).not.toBeNull();
    expect(state.lastHash).toMatch(/^12-[0-9a-f]{8}$/);
    expect(state.lastError).toBeNull();
    expect(state.lastResult).toEqual(result);
    expect(JSON.parse(persistence.getItem(STATE_KEY) ?? '{}').planKey).toBe(`${CUSTOM_PLAN_ID}:${start}`);
  });

  it('sends only the next N weeks when asked, and never past days', async () => {
    setIntervalsCredentials(CREDS);
    const start = addDays(today(), -7); // week 1 is over
    activate(repeatWeek(3), start);
    const icu = mockIntervals();

    const result = await pushPlanToIntervals({ weeks: 1 });

    expect(result).toEqual({ upserted: 6, deleted: 0, from: today(), to: addDays(today(), 6) });
    const events = icu.upserts()[0].body as IcuEventInput[];
    expect(events.map((e) => e.external_id)).toEqual([1, 2, 3, 4, 5, 6].map((d) => planExternalId(CUSTOM_PLAN_ID, start, 1, d)));
    expect(events.every((e) => e.start_date_local >= `${today()}T00:00:00`)).toBe(true);
    // A partial push can't vouch for the whole auto-update window.
    expect(getPlanPushState().lastHash).toBeNull();
  });

  it('deletes the previous instance when the start date moves', async () => {
    setIntervalsCredentials(CREDS);
    const start = today();
    activate([WEEK, WEEK], start);
    const icu = mockIntervals();
    await pushPlanToIntervals();
    const oldIds = getPlanPushState().pushedIds;

    const moved = addDays(start, 7);
    activate([WEEK, WEEK], moved);
    const progress: string[] = [];
    const result = await pushPlanToIntervals({ onProgress: (m) => progress.push(m) });

    expect(result).toMatchObject({ upserted: 12, deleted: 12, from: moved });
    expect(icu.deletes()[0].url.pathname).toBe('/api/v1/athlete/i42/events/bulk-delete');
    expect(idsIn(icu.deletes()[0])).toEqual(oldIds);
    expect(progress).toContain('Removing 12 outdated workouts…');
    const newIds = getPlanPushState().pushedIds;
    expect(newIds).toHaveLength(12);
    expect(newIds.every((id) => id.includes(`:${moved}:`))).toBe(true);
    expect([...icu.calendar.keys()].sort()).toEqual([...newIds].sort());
  });

  it('deletes a day that became a rest day', async () => {
    setIntervalsCredentials(CREDS);
    const start = today();
    activate([WEEK], start);
    const icu = mockIntervals();
    await pushPlanToIntervals();

    activate([[REST, REST, TEMPO, CROSS, SPEED, PFITZ_MP, LONG]], start); // the easy day is gone
    const result = await pushPlanToIntervals();

    const dropped = planExternalId(CUSTOM_PLAN_ID, start, 0, 1);
    expect(result).toMatchObject({ upserted: 5, deleted: 1 });
    expect(idsIn(icu.deletes()[0])).toEqual([dropped]);
    expect(getPlanPushState().pushedIds).not.toContain(dropped);
    expect(icu.calendar.has(dropped)).toBe(false);
  });

  it('leaves past events alone and never deletes IDs Apollo did not write', async () => {
    setIntervalsCredentials(CREDS);
    const start = today();
    activate([WEEK], start);
    const oldStart = addDays(start, -14);
    const past = planExternalId('old-plan', oldStart, 0, 3);          // 11 days ago
    const upcoming = planExternalId('old-plan', oldStart, 2, 3);      // in 3 days
    persistence.setItem(STATE_KEY, JSON.stringify({ pushedIds: [past, upcoming, 'coach:42'] }));
    const icu = mockIntervals();
    icu.calendar.set(past, calendarEvent(past, addDays(start, -11), 'Done'));
    icu.calendar.set(upcoming, calendarEvent(upcoming, addDays(start, 3), 'Outdated'));
    icu.calendar.set('coach:42', calendarEvent('coach:42', addDays(start, 3), 'Coach session'));

    const result = await pushPlanToIntervals();

    expect(result.deleted).toBe(1);
    expect(icu.deletes()).toHaveLength(1);
    expect(idsIn(icu.deletes()[0])).toEqual([upcoming]);
    expect(icu.calendar.has(past)).toBe(true);
    expect(icu.calendar.has('coach:42')).toBe(true);
  });

  it('fails clearly when intervals.icu is not connected', async () => {
    activate([WEEK], today());
    const icu = mockIntervals();
    await expect(pushPlanToIntervals()).rejects.toThrow(/not connected/);
    expect(icu.calls).toHaveLength(0);
  });

  it('fails clearly without an active plan', async () => {
    setIntervalsCredentials(CREDS);
    const icu = mockIntervals();
    await expect(pushPlanToIntervals()).rejects.toThrow(/No active training plan/);
    expect(icu.calls).toHaveLength(0);
  });

  it('surfaces a rejected key as IntervalsAuthError and stores lastError until the next success', async () => {
    setIntervalsCredentials(CREDS);
    activate([WEEK], today());
    const icu = mockIntervals();
    icu.fail = () => 401;

    await expect(pushPlanToIntervals()).rejects.toBeInstanceOf(IntervalsAuthError);

    const failed = getPlanPushState();
    expect(failed.lastError).toBe(new IntervalsAuthError().message);
    expect(failed.lastErrorAt).not.toBeNull();
    expect(failed.lastPushAt).toBeNull();
    expect(icu.calls).toHaveLength(1); // auth errors are not retried

    icu.fail = undefined;
    await pushPlanToIntervals();
    expect(getPlanPushState()).toMatchObject({ lastError: null, lastErrorAt: null });
  });

  it('keeps outdated IDs for the next push when the clean-up fails', async () => {
    setIntervalsCredentials(CREDS);
    const start = today();
    activate([WEEK], start);
    const icu = mockIntervals();
    await pushPlanToIntervals();
    const oldIds = getPlanPushState().pushedIds;

    activate([WEEK], addDays(start, 1));
    icu.fail = (call) => (call.method === 'PUT' ? 400 : undefined);
    await expect(pushPlanToIntervals()).rejects.toBeInstanceOf(IntervalsHttpError);
    const failed = getPlanPushState();
    expect(failed.lastError).toMatch(/400/);
    expect(failed.pushedIds).toHaveLength(12);
    expect(oldIds.every((id) => failed.pushedIds.includes(id))).toBe(true);

    icu.fail = undefined;
    const result = await pushPlanToIntervals();
    expect(result).toMatchObject({ upserted: 6, deleted: 6 });
    expect(idsIn(icu.deletes()[1])).toEqual(oldIds);
    expect(getPlanPushState().pushedIds).toHaveLength(6);
    expect(getPlanPushState().lastError).toBeNull();
  });
});

describe('removePlanFromIntervals', () => {
  it('deletes upcoming Apollo workouts (pushed here or found on the calendar) and nothing else', async () => {
    setIntervalsCredentials(CREDS);
    const start = today();
    activate([WEEK, WEEK], start);
    const icu = mockIntervals();
    await pushPlanToIntervals();
    setPlanAutoPush(true);
    const otherDevice = planExternalId('hal-higdon-novice-1', start, 0, 2);
    icu.calendar.set(otherDevice, calendarEvent(otherDevice, addDays(start, 2), 'Pushed from another computer'));
    icu.calendar.set('coach:42', calendarEvent('coach:42', addDays(start, 2), 'Coach session'));
    icu.calendar.set('apollo:old:past', calendarEvent('apollo:old:past', addDays(start, -1), 'Yesterday'));

    const removed = await removePlanFromIntervals();

    expect(removed).toBe(13);
    const [list] = icu.lists();
    expect(list.url.pathname).toBe('/api/v1/athlete/i42/events');
    expect(list.url.searchParams.get('oldest')).toBe(start);
    expect(list.url.searchParams.get('newest')).toBe(addDays(start, 400));
    expect(list.url.searchParams.get('category')).toBe('WORKOUT');
    const deleted = idsIn(icu.deletes()[0]);
    expect(deleted).toHaveLength(13);
    expect(deleted).toContain(otherDevice);
    expect(deleted).not.toContain('coach:42');
    expect(deleted).not.toContain('apollo:old:past');
    expect([...icu.calendar.keys()].sort()).toEqual(['apollo:old:past', 'coach:42']);
    expect(getPlanPushState()).toMatchObject({
      enabled: false, pushedIds: [], planKey: null, lastHash: null, lastPushAt: null, lastError: null,
    });
  });

  it('still deletes the workouts it knows about when the calendar listing fails', async () => {
    setIntervalsCredentials(CREDS);
    activate([WEEK], today());
    const icu = mockIntervals();
    await pushPlanToIntervals();
    const known = getPlanPushState().pushedIds;
    icu.fail = (call) => (call.method === 'GET' ? 404 : undefined);

    expect(await removePlanFromIntervals()).toBe(6);
    expect(idsIn(icu.deletes()[0])).toEqual(known);
    expect(icu.calendar.size).toBe(0);
  });

  it('surfaces a rejected key, records the error and keeps the IDs for a retry', async () => {
    setIntervalsCredentials(CREDS);
    activate([WEEK], today());
    const icu = mockIntervals();
    await pushPlanToIntervals();
    icu.fail = () => 401;

    await expect(removePlanFromIntervals()).rejects.toBeInstanceOf(IntervalsAuthError);

    expect(icu.deletes()).toHaveLength(0);
    const state = getPlanPushState();
    expect(state.lastError).toBe(new IntervalsAuthError().message);
    expect(state.pushedIds).toHaveLength(6);
    expect(state.enabled).toBe(false);
  });

  it('fails clearly when intervals.icu is not connected', async () => {
    const icu = mockIntervals();
    await expect(removePlanFromIntervals()).rejects.toThrow(/not connected/);
    expect(icu.calls).toHaveLength(0);
  });
});

describe('syncPlanCalendarIfChanged', () => {
  function enableAuto(weeks: PlanDay[][] = [WEEK, WEEK]) {
    setIntervalsCredentials(CREDS);
    activate(weeks, today());
    setPlanAutoPush(true);
    return mockIntervals();
  }

  it('does nothing unless auto-update is on, intervals.icu is connected and a plan is active', async () => {
    const icu = mockIntervals();
    setIntervalsCredentials(CREDS);
    activate([WEEK], today());
    expect(await syncPlanCalendarIfChanged()).toBeNull(); // auto-update off

    setPlanAutoPush(true);
    setActivePlan(null);
    expect(await syncPlanCalendarIfChanged()).toBeNull(); // no plan

    activate([WEEK], today());
    clearIntervalsCredentials();
    expect(await syncPlanCalendarIfChanged()).toBeNull(); // not connected

    expect(icu.calls).toHaveLength(0);
    expect(getPlanPushState().lastError).toBeNull();
  });

  it('pushes the whole plan for a new plan instance, then no-ops while nothing changed', async () => {
    const icu = enableAuto(repeatWeek(6));

    expect(await syncPlanCalendarIfChanged()).toMatchObject({ status: 'pushed', result: { upserted: 36, deleted: 0 } });
    expect(await syncPlanCalendarIfChanged()).toEqual({ status: 'nothing-changed', result: null });
    expect(await syncPlanCalendarIfChanged()).toEqual({ status: 'nothing-changed', result: null });
    expect(icu.calls).toHaveLength(1);
    const state = getPlanPushState();
    expect(state.lastStatus).toBe('nothing-changed');
    expect(Object.keys(state.pushedHashes).sort()).toEqual([...state.pushedIds].sort());
  });

  it(`re-sends the next ${AUTO_PUSH_WEEKS} weeks when they change (new paces, unit switch)`, async () => {
    const icu = enableAuto(repeatWeek(6));
    await syncPlanCalendarIfChanged();
    const firstHash = getPlanPushState().lastHash;

    saveTrainingPaces(PACES); // Apollo learned the athlete's VDOT → pace targets appear
    // Only workouts whose content changed are re-sent: the cross-training day has no pace targets.
    expect(await syncPlanCalendarIfChanged()).toMatchObject({
      status: 'pushed',
      result: { upserted: 5 * AUTO_PUSH_WEEKS, deleted: 0, to: addDays(today(), AUTO_PUSH_WEEKS * 7 - 1) },
    });
    expect((icu.upserts()[1].body as IcuEventInput[])[0].description).toContain('- 5mi 9:19-8:57/mi Pace');
    expect(getPlanPushState().lastHash).not.toBe(firstHash);

    setDistanceUnit('km');
    expect(await syncPlanCalendarIfChanged()).toMatchObject({ status: 'pushed' });
    expect((icu.upserts()[2].body as IcuEventInput[])[0].name).toBe('Easy Run · 8 km');

    expect(await syncPlanCalendarIfChanged()).toMatchObject({ status: 'nothing-changed' });
    expect(icu.upserts()).toHaveLength(3);
  });

  // v1.0.6: the daily blanket refresh is gone — it overwrote edits the athlete made in intervals.icu.
  it('leaves unchanged workouts alone, even a day later, so edits made in intervals.icu survive', async () => {
    const icu = enableAuto();
    await syncPlanCalendarIfChanged();
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    persistence.setItem(STATE_KEY, JSON.stringify({ ...getPlanPushState(), lastPushAt: dayAgo }));
    const edited = planExternalId(CUSTOM_PLAN_ID, today(), 0, 2);
    const original = icu.calendar.get(edited);
    expect(original?.name).toBe('Tempo · 7 mi');
    icu.calendar.set(edited, { ...(original as IcuEventInput), name: 'My own tempo' });

    expect(await syncPlanCalendarIfChanged()).toEqual({ status: 'nothing-changed', result: null });
    expect(icu.upserts()).toHaveLength(1);
    expect(icu.calendar.get(edited)?.name).toBe('My own tempo');

    // The explicit "Send" (re-push all) still overwrites.
    await pushPlanToIntervals();
    expect(icu.calendar.get(edited)?.name).toBe('Tempo · 7 mi');
  });

  it('re-sends only the workouts that changed and removes days that became rest', async () => {
    const icu = enableAuto();
    await syncPlanCalendarIfChanged();
    const start = today();
    const LONGER: PlanDay = { ...LONG, label: '20 mi', distanceMi: 20 };
    activate([WEEK, [REST, REST, TEMPO, CROSS, SPEED, PFITZ_MP, LONGER]], start);

    expect(await syncPlanCalendarIfChanged()).toMatchObject({ status: 'pushed', result: { upserted: 1, deleted: 1 } });
    expect(idsIn(icu.upserts()[1])).toEqual([planExternalId(CUSTOM_PLAN_ID, start, 1, 6)]);
    expect(idsIn(icu.deletes()[0])).toEqual([planExternalId(CUSTOM_PLAN_ID, start, 1, 1)]);
    const state = getPlanPushState();
    expect(state.pushedIds).toHaveLength(11);
    expect(Object.keys(state.pushedHashes)).toHaveLength(11);
    expect(await syncPlanCalendarIfChanged()).toEqual({ status: 'nothing-changed', result: null });
  });

  it('pushes the full plan and cleans up when the plan instance changes', async () => {
    const icu = enableAuto();
    await syncPlanCalendarIfChanged();
    const oldIds = getPlanPushState().pushedIds;
    const moved = addDays(today(), 7);
    activate([WEEK, WEEK], moved);

    expect(await syncPlanCalendarIfChanged()).toMatchObject({ status: 'pushed', result: { upserted: 12, deleted: 12 } });
    expect(idsIn(icu.deletes()[0])).toEqual(oldIds);
    expect(getPlanPushState().planKey).toBe(`${CUSTOM_PLAN_ID}:${moved}`);
  });

  it('sends the rest of the window after a partial manual push', async () => {
    const icu = enableAuto();
    await pushPlanToIntervals({ weeks: 1 });
    expect(await syncPlanCalendarIfChanged()).toMatchObject({ status: 'pushed', result: { upserted: 6 } });
    expect(idsIn(icu.upserts()[1])).toEqual([1, 2, 3, 4, 5, 6].map((d) => planExternalId(CUSTOM_PLAN_ID, today(), 1, d)));
    expect(icu.upserts()).toHaveLength(2);
  });

  it('adopts a push made before v1.0.6 (no per-workout hashes) instead of re-sending it', async () => {
    const icu = enableAuto();
    await pushPlanToIntervals();
    const s = getPlanPushState();
    persistence.setItem(STATE_KEY, JSON.stringify({
      enabled: s.enabled, lastPushAt: s.lastPushAt, lastHash: s.lastHash, planKey: s.planKey,
      pushedIds: s.pushedIds, lastError: null, lastErrorAt: null, lastResult: s.lastResult,
    }));
    expect(getPlanPushState()).toMatchObject({ pushedHashes: {}, lastStatus: null });

    expect(await syncPlanCalendarIfChanged()).toEqual({ status: 'nothing-changed', result: null });
    expect(icu.upserts()).toHaveLength(1);
    expect(Object.keys(getPlanPushState().pushedHashes)).toHaveLength(12);

    saveTrainingPaces(PACES); // a real change is still sent (cross-training days carry no paces)
    expect(await syncPlanCalendarIfChanged()).toMatchObject({ status: 'pushed', result: { upserted: 10 } });
  });

  it('never throws: records lastError and backs off after a failure', async () => {
    const icu = enableAuto();
    icu.fail = () => 401;

    await expect(syncPlanCalendarIfChanged()).resolves.toMatchObject({
      status: 'error', result: null, error: new IntervalsAuthError().message,
    });
    expect(getPlanPushState()).toMatchObject({ lastError: new IntervalsAuthError().message, lastStatus: 'error' });

    icu.fail = undefined;
    expect(await syncPlanCalendarIfChanged()).toBeNull(); // backing off
    expect(icu.calls).toHaveLength(1);
  });

  it('skips while a push is already running', async () => {
    const icu = enableAuto();
    const manual = pushPlanToIntervals();
    expect(isPlanPushRunning()).toBe(true);
    expect(await syncPlanCalendarIfChanged()).toEqual({ status: 'skipped-in-progress', result: null });
    await manual;
    expect(isPlanPushRunning()).toBe(false);
    expect(icu.upserts()).toHaveLength(1);
    expect(getPlanPushState().lastStatus).toBe('pushed');
  });
});

describe('push state', () => {
  it('persists the auto-update flag and notifies listeners', () => {
    const seen: boolean[] = [];
    const unsubscribe = onPlanPushStateChange((s) => seen.push(s.enabled));
    setPlanAutoPush(true);
    setPlanAutoPush(false);
    unsubscribe();
    setPlanAutoPush(true);

    expect(seen).toEqual([true, false]);
    expect(getPlanPushState().enabled).toBe(true);
    expect(JSON.parse(persistence.getItem(STATE_KEY) ?? '{}').enabled).toBe(true);
  });

  it('ignores corrupt stored state', () => {
    persistence.setItem(STATE_KEY, '{not json');
    expect(getPlanPushState()).toMatchObject({ enabled: false, pushedIds: [], lastError: null });
    persistence.setItem(STATE_KEY, JSON.stringify({ enabled: 'yes', pushedIds: ['a', 3], lastResult: { upserted: 'x' } }));
    expect(getPlanPushState()).toMatchObject({ enabled: false, pushedIds: ['a'], lastResult: null });
    persistence.setItem(STATE_KEY, JSON.stringify({ pushedHashes: { a: 'h1', b: 7, c: '' }, lastStatus: 'bogus' }));
    expect(getPlanPushState()).toMatchObject({ pushedHashes: { a: 'h1' }, lastStatus: null });
    persistence.setItem(STATE_KEY, JSON.stringify({ pushedHashes: ['x'], lastStatus: 'nothing-changed' }));
    expect(getPlanPushState()).toMatchObject({ pushedHashes: {}, lastStatus: 'nothing-changed' });
  });

  it('knows whether pushed workouts will carry pace targets', () => {
    expect(hasPlanTargetPaces()).toBe(false);
    expect(resolvePlanTrainingPaces()).toBeNull();
    saveTrainingPaces(PACES);
    expect(hasPlanTargetPaces()).toBe(true);
    expect(resolvePlanTrainingPaces()).toMatchObject({ vdot: 45, marathon: 496 });
  });

  it('prefers the current VDOT paces over saved ones', () => {
    saveTrainingPaces(PACES);
    updateAthleteProfile({ goalMarathonSec: 3 * 3600 });
    const paces = resolvePlanTrainingPaces();
    expect(paces?.source).toBe('goal');
    expect(paces?.vdot).toBeGreaterThan(50);
  });

  it('gives each workout a content hash that changes only with what is sent', () => {
    const [a] = buildPlanWorkouts(makePlan([[EASY]]), START, MI);
    const [b] = buildPlanWorkouts(makePlan([[EASY]]), START, MI);
    const [c] = buildPlanWorkouts(makePlan([[{ ...EASY, distanceMi: 6 }]]), START, MI);
    expect(hashPlannedWorkout(a)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashPlannedWorkout(a)).toBe(hashPlannedWorkout(b));
    expect(hashPlannedWorkout(a)).not.toBe(hashPlannedWorkout(c));
  });
});
