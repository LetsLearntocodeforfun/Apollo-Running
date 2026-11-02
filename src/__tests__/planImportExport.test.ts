/**
 * Tests for `.apollo-plan.json` open plan schema import/export, strict validation,
 * prototype-pollution & untrusted-URL guards, and AM/PM doubles watch/ICS parity.
 * v1.0.9: v1-only schema, unverified imported attribution, invisible-character
 * stripping, race-day semantics and distance caps, add-only saving (unique ids),
 * the active-plan delete guard, removal that leaves no orphaned progress, and an
 * export → import round trip of every built-in plan.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { persistence } from '../services/db/persistence';
import {
  ALL_BUILT_IN_PLANS,
  SUPPLEMENTAL_PLANS,
  createCustomPlanFromScratch,
  getPlanById,
  getImportedPlans,
  deleteImportedPlan,
  planAttributionLine,
  planFidelityLabel,
  type TrainingPlan,
} from '../data/plans';
import {
  MAX_IMPORTED_DAY_MI,
  MAX_IMPORTED_WEEK_MI,
  PLAN_EXPORT_FORMAT,
  parseImportedPlanJson,
  serializePlanToJson,
  importAndSavePlanText,
  isImportedPlan,
  removeImportedPlan,
} from '../services/planImportExport';
import { buildPlanWorkouts } from '../services/planCalendarSync';
import { generateCalendarEvents, generateICS } from '../services/calendarExport';
import {
  getActivePlan,
  getPlanRaceDayRef,
  getStoredPlanProgress,
  isDayCompleted,
  previewStartPlan,
  setDayCompleted,
  setSyncMeta,
  startPlan,
} from '../services/planProgress';
import { getEffectiveDay, skipWorkout } from '../services/planOverlay';

describe('planImportExport (.apollo-plan.json)', () => {
  beforeEach(() => {
    persistence.clear();
  });

  it('round-trips a built-in plan with AM/PM doubles and time-based fields', () => {
    const original = getPlanById('pfitzinger-18-70')!;
    const json = serializePlanToJson(original);
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe(PLAN_EXPORT_FORMAT);

    const res = importAndSavePlanText(json);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.id.startsWith('imported-')).toBe(true);
    expect(isImportedPlan(res.plan)).toBe(true);
    expect(res.plan.totalWeeks).toBe(18);
    expect(res.plan.hasDoubles).toBe(true);
    expect(getPlanById(res.plan.id)?.name).toBe(original.name);
    expect(getImportedPlans()).toHaveLength(1);

    deleteImportedPlan(res.plan.id);
    expect(getImportedPlans()).toHaveLength(0);
    expect(getPlanById(res.plan.id)).toBeUndefined();
  });

  it('rejects prototype pollution, non-7-day weeks, out-of-range lengths, and strips untrusted URLs', () => {
    expect(parseImportedPlanJson('{"__proto__":{"polluted":true}}').ok).toBe(false);
    expect(parseImportedPlanJson('{"weeks":[]}').ok).toBe(false);

    // 4 weeks with a look-alike untrusted URL in attribution
    const fourWeeks = Array.from({ length: 4 }, (_, i) => ({
      weekNumber: i + 1,
      days: [
        { type: 'rest', label: 'Rest' },
        { type: 'run', label: '5 mi easy', distanceMi: 5, note: 'Easy' },
        { type: 'run', label: '6 mi tempo', distanceMi: 6, note: 'Tempo' },
        {
          type: 'run',
          label: '4 mi recovery',
          distanceMi: 4,
          note: 'Recovery',
          secondary: { label: '3 mi PM', distanceMi: 3, note: 'Recovery' },
        },
        { type: 'rest', label: 'Rest' },
        { type: 'run', label: '5 mi easy', distanceMi: 5, note: 'Easy' },
        i === 3
          ? { type: 'marathon', label: 'Marathon', distanceMi: 26.2, note: 'Race' }
          : { type: 'run', label: '14 mi long run', distanceMi: 14, note: 'Long' },
      ],
    }));
    const raw = JSON.stringify({
      name: 'Coach Club Block',
      author: 'Local Track Club',
      weeks: fourWeeks,
      attribution: {
        coach: 'Local Track Club',
        fidelity: 'method',
        note: 'Custom club marathon block.',
        sources: [{ label: 'Untrusted site', url: 'https://evil.example.com/plan', kind: 'website' }],
      },
    });
    const res = parseImportedPlanJson(raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Untrusted external links are stripped so Electron external link allow-list stays airtight
    expect(res.plan.attribution?.sources).toEqual([]);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it('emits distinct AM and PM workouts for watch sync and .ics export when a plan has doubles', () => {
    const plan = getPlanById('pfitzinger-18-70')!;
    const active = startPlan({ planId: plan.id, raceDate: '2027-04-18' }, '2026-10-07');
    const workouts = buildPlanWorkouts(plan, active.startDate, {
      unit: 'mi',
      paces: null,
      vdot: 54,
      from: '2026-10-07',
    });
    const pmWorkouts = workouts.filter((w) => w.external_id.endsWith(':pm'));
    expect(pmWorkouts.length).toBeGreaterThan(0);
    expect(pmWorkouts[0].name).toMatch(/^PM /);

    // .ics export emits separate UIDs for AM and PM sessions on the same date
    const events = generateCalendarEvents(plan, active.startDate, { today: '2026-10-07' });
    const uids = events.map((e) => e.uid);
    expect(new Set(uids).size).toBe(uids.length);
    expect(uids.some((u) => u.endsWith('-pm@apollo-running'))).toBe(true);
    const ics = generateICS(events, plan.name);
    expect(ics).toContain('SUMMARY:PM ');
  });
});

// ── v1.0.9 fixtures ──────────────────────────────────────────────────────────

const TODAY = '2026-11-02'; // a Monday
const REST = { type: 'rest', label: 'Rest' };
const MARATHON = { type: 'marathon', label: 'Marathon', distanceMi: 26.2, note: 'Race' };
const run = (mi: number, extra: Record<string, unknown> = {}) => ({
  type: 'run',
  label: `${mi} mi easy`,
  distanceMi: mi,
  note: 'Easy',
  ...extra,
});
/** A 7-day week (default: a 24 mi training week). */
const week = (days: unknown[] = [REST, run(4), run(5), run(4), REST, run(3), run(8)]) => ({ days });
/** A race week ending in the marathon on Sunday. */
const raceWeek = () => week([REST, run(4), run(3), run(3), REST, run(2), MARATHON]);
/** An `.apollo-plan.json` text: the v1 envelope around `plan`, or the bare plan object. */
const planFile = (plan: Record<string, unknown>, envelope: Record<string, unknown> | null = {}) =>
  JSON.stringify(envelope ? { schema: PLAN_EXPORT_FORMAT, format: PLAN_EXPORT_FORMAT, ...envelope, plan } : plan);
/** Zero-width and bidi control characters that must never survive an import. */
const INVISIBLE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

function imported(text: string): TrainingPlan {
  const res = importAndSavePlanText(text);
  if (!res.ok) throw new Error(`import failed: ${res.error}`);
  return res.plan;
}

function parseError(text: string): string {
  const res = parseImportedPlanJson(text);
  expect(res.ok).toBe(false);
  return res.ok ? '' : res.error;
}

describe('v1.0.9: import never replaces a plan', () => {
  it('a second plan with the same name gets a -2 id (and a “(2)” name); the first is untouched', () => {
    const first = imported(planFile({ name: 'My Plan', weeks: [week(), raceWeek()] }));
    const second = imported(planFile({ name: 'My Plan', weeks: [week()] }));
    const third = imported(planFile({ name: 'my plan', weeks: [week(), week(), raceWeek()] }));
    expect([first.id, second.id, third.id]).toEqual(['imported-my-plan', 'imported-my-plan-2', 'imported-my-plan-3']);
    expect([first.name, second.name, third.name]).toEqual(['My Plan', 'My Plan (2)', 'my plan (3)']);
    expect(getImportedPlans().map((p) => [p.id, p.weeks.length])).toEqual([
      ['imported-my-plan', 2],
      ['imported-my-plan-2', 1],
      ['imported-my-plan-3', 3],
    ]);
    expect(getPlanById('imported-my-plan')?.weeks).toHaveLength(2);
  });

  it('keeps the active imported plan when a file with the same name is imported again', () => {
    const plan = imported(planFile({ name: 'Club Build', weeks: [week(), week(), raceWeek()] }));
    startPlan({ planId: plan.id, raceDate: '2027-01-31' }, TODAY);
    const again = imported(planFile({ name: 'Club Build', weeks: [week()] }));
    expect(again.id).not.toBe(plan.id);
    expect(getActivePlan()?.planId).toBe(plan.id);
    expect(getPlanById(plan.id)?.weeks).toHaveLength(3);
  });

  it('a file asking for an id that is already stored gets the next free one', () => {
    imported(planFile({ id: 'imported-club', name: 'Club Plan', weeks: [week()] }));
    const other = imported(planFile({ id: 'imported-club', name: 'Other Plan', weeks: [week()] }));
    expect(other.id).toBe('imported-club-2');
    expect(other.name).toBe('Other Plan');
    expect(getImportedPlans()).toHaveLength(2);
  });

  it('deleteImportedPlan refuses the active plan and removes inactive ones', () => {
    const a = imported(planFile({ name: 'Plan A', weeks: [week()] }));
    const b = imported(planFile({ name: 'Plan B', weeks: [week()] }));
    startPlan({ planId: a.id, startDate: TODAY }, TODAY);
    expect(deleteImportedPlan(a.id)).toBe(false);
    expect(getPlanById(a.id)).toBeDefined();
    expect(deleteImportedPlan(b.id)).toBe(true);
    expect(getPlanById(b.id)).toBeUndefined();
    expect(deleteImportedPlan('imported-not-there')).toBe(false);
  });
});

describe('v1.0.9: removing an imported plan leaves nothing orphaned', () => {
  const syncMeta = {
    activityId: 7,
    actualDistanceMi: 4,
    actualPaceMinPerMi: 9,
    movingTimeSec: 2160,
    feedback: 'Nice and easy.',
    syncedAt: '2026-11-03T18:00:00.000Z',
  };

  it('refuses the active plan and keeps its progress', () => {
    const plan = imported(planFile({ name: 'Plan A', weeks: [week(), week()] }));
    startPlan({ planId: plan.id, startDate: TODAY }, TODAY);
    setDayCompleted(plan.id, 0, 1, true);
    expect(removeImportedPlan(plan.id)).toBe(false);
    expect(getPlanById(plan.id)).toBeDefined();
    expect(isDayCompleted(plan.id, 0, 1)).toBe(true);
    expect(removeImportedPlan('imported-not-there')).toBe(false);
  });

  it('forgets its progress, so a later plan that gets the same id starts clean', () => {
    const first = imported(planFile({ name: 'Club Plan', weeks: [week(), week()] }));
    startPlan({ planId: first.id, startDate: TODAY }, TODAY);
    setDayCompleted(first.id, 0, 1, true);
    setSyncMeta(first.id, 0, 1, syncMeta);
    expect(skipWorkout({ weekIndex: 1, dayIndex: 2 }).ok).toBe(true);
    expect(getStoredPlanProgress(first.id)).toEqual({ completions: 1, syncMeta: 1, overlay: true });

    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2027-04-25' }, TODAY);
    expect(removeImportedPlan(first.id)).toBe(true);
    expect(getPlanById(first.id)).toBeUndefined();
    expect(getStoredPlanProgress(first.id)).toEqual({ completions: 0, syncMeta: 0, overlay: false });

    // A different file with the same name gets the freed id — and none of the old plan's progress.
    const second = imported(planFile({ name: 'Club Plan', weeks: [week(), week(), week()] }));
    expect(second.id).toBe(first.id);
    expect(previewStartPlan({ planId: second.id, startDate: TODAY }, TODAY)).toMatchObject({
      isNewInstance: true,
      clears: { completions: 0, syncMeta: 0, overlay: false },
    });
    startPlan({ planId: second.id, startDate: TODAY }, TODAY);
    expect(isDayCompleted(second.id, 0, 1)).toBe(false);
    expect(getEffectiveDay({ weekIndex: 1, dayIndex: 2 })?.skipped).toBeFalsy();
  });

  it('leaves the progress of other plans alone, ids that share a prefix included', () => {
    const a = imported(planFile({ name: 'My Plan', weeks: [week()] }));
    const b = imported(planFile({ name: 'My Plan', weeks: [week()] }));
    expect([a.id, b.id]).toEqual(['imported-my-plan', 'imported-my-plan-2']);
    startPlan({ planId: b.id, startDate: TODAY }, TODAY);
    setDayCompleted(b.id, 0, 1, true);
    startPlan({ planId: a.id, startDate: TODAY }, TODAY);
    setDayCompleted(a.id, 0, 2, true);
    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2027-04-25' }, TODAY);
    setDayCompleted('hal-higdon-novice-1', 0, 1, true);

    expect(removeImportedPlan(a.id)).toBe(true);
    expect(isDayCompleted(a.id, 0, 2)).toBe(false);
    expect(isDayCompleted(b.id, 0, 1)).toBe(true);
    expect(isDayCompleted('hal-higdon-novice-1', 0, 1)).toBe(true);
    expect(getPlanById(b.id)).toBeDefined();
  });
});

describe('v1.0.9: import validation', () => {
  it.each([['apollo.training-plan.v99'], ['apollo.training-plan.v2'], ['training-plan'], [42], [null]])(
    'rejects a file that declares schema %s',
    (schema) => {
      const error = parseError(planFile({ name: 'X', weeks: [week()] }, { schema }));
      expect(error).toMatch(/Apollo reads apollo\.training-plan\.v1 plan files/);
      if (typeof schema === 'string') expect(error).toContain(`“${schema}”`);
    },
  );

  it('checks `format` too, and reads a bare v1 plan object that declares neither', () => {
    expect(parseError(planFile({ name: 'X', weeks: [week()] }, { format: 'apollo.training-plan.v3' }))).toMatch(
      /“apollo\.training-plan\.v3”/,
    );
    expect(parseImportedPlanJson(planFile({ name: 'X', weeks: [week()] })).ok).toBe(true);
    expect(parseImportedPlanJson(planFile({ name: 'X', weeks: [week()] }, null)).ok).toBe(true);
  });

  it('also checks a format declared inside the wrapped plan object', () => {
    const wrapped = (plan: Record<string, unknown>) =>
      JSON.stringify({ plan: { name: 'X', weeks: [week()], ...plan } });
    expect(parseError(wrapped({ schema: 'apollo.training-plan.v99' }))).toMatch(/“apollo\.training-plan\.v99”/);
    expect(parseError(planFile({ name: 'X', weeks: [week()], format: 'v2' }))).toMatch(/“v2”/);
    expect(parseImportedPlanJson(wrapped({ schema: PLAN_EXPORT_FORMAT })).ok).toBe(true);
    expect(parseImportedPlanJson(wrapped({})).ok).toBe(true);
  });

  it('labels every imported plan as imported and not verified by Apollo (list line and badge)', () => {
    const listed = imported(
      planFile({
        name: 'Official Novice',
        author: 'Hal Higdon',
        weeks: [week(), raceWeek()],
        attribution: { coach: 'Hal Higdon', fidelity: 'published-schedule', note: 'Endorsed.', sources: [] },
      }),
    );
    expect(planAttributionLine(listed)).toBe('Imported, not verified by Apollo · author listed as “Hal Higdon”');
    expect(planFidelityLabel(listed)).toBe('Imported plan');
    const anonymous = imported(planFile({ name: 'No Author', weeks: [week()] }));
    expect(planAttributionLine(anonymous)).toBe('Imported, not verified by Apollo');
    expect(planFidelityLabel(anonymous)).toBe('Imported plan');
    // Built-in plans keep their own lines and badges.
    const novice = getPlanById('hal-higdon-novice-1')!;
    expect(planAttributionLine(novice)).toBe('Follows Hal Higdon’s published schedule');
    expect(planFidelityLabel(novice)).toBe('Follows the published schedule');
    expect(planAttributionLine(getPlanById('apollo-base-8')!)).toBe('Designed by Apollo Coaching Lab');
  });

  it('shows every imported plan as unverified and representative — a file cannot claim a published schedule', () => {
    const res = parseImportedPlanJson(
      planFile({
        name: 'Official Novice',
        author: 'Hal Higdon',
        weeks: [week(), raceWeek()],
        attribution: {
          coach: 'Hal Higdon',
          fidelity: 'published-schedule',
          note: 'The official plan, endorsed by Hal Higdon.',
          sources: [{ label: 'Site', url: 'https://example.com', kind: 'website' }],
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.author).toBe('Hal Higdon');
    expect(res.plan.attribution).toEqual({
      coach: 'Hal Higdon',
      fidelity: 'representative',
      note: expect.stringContaining('not verified by Apollo'),
      sources: [],
    });
    expect(res.plan.attribution?.note).toContain('“Hal Higdon”');
    expect(res.plan.attribution?.note).not.toMatch(/endorsed by Hal Higdon/);
    expect(planAttributionLine(res.plan)).not.toMatch(/published schedule|method/);
    expect(res.warnings[0]).toMatch(/can’t verify/);

    for (const fidelity of ['method', 'original', 'made-up']) {
      const claimed = parseImportedPlanJson(
        planFile({ name: 'P', author: 'Coach', weeks: [week()], attribution: { coach: 'Someone Famous', fidelity } }),
      );
      expect(claimed.ok && claimed.plan.attribution).toMatchObject({ coach: 'Coach', fidelity: 'representative' });
    }

    const anonymous = parseImportedPlanJson(planFile({ name: 'No Author', weeks: [week()] }));
    expect(anonymous.ok).toBe(true);
    if (!anonymous.ok) return;
    expect(anonymous.plan.author).toBe('Unknown author');
    expect(anonymous.plan.attribution).toMatchObject({ fidelity: 'representative', sources: [] });
    expect(anonymous.plan.attribution?.note).toMatch(/doesn’t list an author/);
  });

  it('strips zero-width and bidi control characters from every string', () => {
    const res = parseImportedPlanJson(
      planFile(
        {
          name: 'Hal\u202EnodgiH Plan\u200B',
          author: '\u2066Hal\u200D Higdon\u2069\uFEFF',
          description: 'De\u200Escription\u061C',
          tags: ['\u2060tag', '\u200B'],
          weeks: [
            week([
              REST,
              run(4, {
                type: 'r\u200Bun',
                label: 'E\u200Fasy\u202C',
                note: 'Te\u200Bmpo',
                runWalkRatio: '4:1\u2064',
                secondary: { label: 'PM\u202A jog', distanceMi: 3, note: 'Ea\u200Bsy' },
              }),
              run(5),
              run(4),
              REST,
              run(3),
              run(8),
            ]),
          ],
        },
        { schema: 'apollo.training-plan.v1\u200B' },
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.stringify(res.plan)).not.toMatch(INVISIBLE);
    expect(res.plan.name).toBe('HalnodgiH Plan');
    expect(res.plan.author).toBe('Hal Higdon');
    expect(res.plan.tags).toEqual(['tag']);
    expect(res.plan.weeks[0].days[1]).toMatchObject({
      type: 'run',
      label: 'Easy',
      note: 'Tempo',
      runWalkRatio: '4:1',
      secondary: { label: 'PM jog', note: 'Easy' },
    });
    // Rejected values are echoed without them too.
    expect(
      parseError(
        planFile({ name: 'X', weeks: [week([{ type: 'spr\u202Eint' }, REST, REST, REST, REST, REST, REST])] }),
      ),
    ).not.toMatch(INVISIBLE);
  });

  it('rejects more than one marathon day (the reviewer probe: seven 99-mile marathons)', () => {
    const probe = JSON.stringify({
      name: 'X',
      weeks: [{ days: Array.from({ length: 7 }, () => ({ type: 'marathon', distanceMi: 99 })) }],
    });
    expect(parseImportedPlanJson(probe).ok).toBe(false);
    const sevenMarathons = JSON.stringify({ name: 'X', weeks: [{ days: Array.from({ length: 7 }, () => MARATHON) }] });
    expect(parseError(sevenMarathons)).toMatch(/7 marathon days/);
    expect(
      parseError(planFile({ name: 'X', weeks: [week([REST, MARATHON, REST, REST, REST, REST, MARATHON])] })),
    ).toMatch(/2 marathon days/);
  });

  it('accepts a marathon only as the last day of the last week', () => {
    expect(parseError(planFile({ name: 'X', weeks: [raceWeek(), week()] }))).toMatch(/Week 1, Day 7 is a marathon/);
    const saturdayRace = week([REST, run(4), run(3), run(3), REST, MARATHON, REST]);
    expect(parseError(planFile({ name: 'X', weeks: [week(), saturdayRace] }))).toMatch(/Week 2, Day 6 is a marathon/);
    expect(parseImportedPlanJson(planFile({ name: 'Race plan', weeks: [week(), raceWeek()] })).ok).toBe(true);
    // A block without a race day stays importable.
    expect(parseImportedPlanJson(planFile({ name: 'Base block', weeks: [week(), week()] })).ok).toBe(true);
  });

  it(`caps a day at ${MAX_IMPORTED_DAY_MI} mi, PM run included`, () => {
    const day = (d: unknown) => planFile({ name: 'X', weeks: [week([REST, d, REST, REST, REST, REST, REST])] });
    expect(parseError(day(run(51)))).toMatch(/Must be 0–50 miles/);
    expect(parseError(day(run(30, { secondary: { distanceMi: 25, note: 'Recovery' } })))).toMatch(
      /adds up to 55 miles with its PM run/,
    );
    expect(parseImportedPlanJson(day(run(50))).ok).toBe(true);
  });

  it('requires a marathon day to be 26.2 mi', () => {
    const withMarathon = (m: Record<string, unknown>) =>
      planFile({ name: 'X', weeks: [week([REST, run(4), run(3), run(3), REST, run(2), m])] });
    expect(parseError(withMarathon({ type: 'marathon', distanceMi: 30 }))).toMatch(/must be 26\.2 miles/);
    expect(parseError(withMarathon({ type: 'marathon', distanceMi: 13.1 }))).toMatch(/must be 26\.2 miles/);
    for (const m of [
      { type: 'marathon' },
      { type: 'marathon', distanceMi: 26.2 },
      { type: 'marathon', distanceMi: 26.21875 },
    ]) {
      const res = parseImportedPlanJson(withMarathon(m));
      expect(res.ok && res.plan.weeks[0].days[6].distanceMi).toBe(26.2);
    }
  });

  it(`caps a week at ${MAX_IMPORTED_WEEK_MI} mi`, () => {
    const heavy = (mi: number) => planFile({ name: 'X', weeks: [week(Array.from({ length: 7 }, () => run(mi)))] });
    expect(parseError(heavy(30))).toMatch(/Week 1 adds up to 210 miles\. A week can have at most 200 miles/);
    expect(parseImportedPlanJson(heavy(28)).ok).toBe(true);
  });
});

describe('v1.0.9: export → import round trip of every built-in plan', () => {
  it('re-imports all built-in plans (blocks without a race day included) without replacing any', () => {
    expect(ALL_BUILT_IN_PLANS.length).toBeGreaterThanOrEqual(33);
    const builtInIds = new Set(ALL_BUILT_IN_PLANS.map((p) => p.id));
    for (const original of ALL_BUILT_IN_PLANS) {
      const res = importAndSavePlanText(serializePlanToJson(original));
      expect(res.ok, `${original.id}: ${res.ok ? '' : res.error}`).toBe(true);
      if (!res.ok) continue;
      const plan = res.plan;
      expect(isImportedPlan(plan)).toBe(true);
      expect(builtInIds.has(plan.id)).toBe(false);
      expect(plan.attribution).toMatchObject({ fidelity: 'representative', sources: [] });
      expect(plan.weeks).toHaveLength(original.weeks.length);
      plan.weeks.forEach((wk, w) =>
        wk.days.forEach((day, d) => {
          const src = original.weeks[w].days[d];
          const where = `${original.id} w${w + 1}d${d + 1}`;
          expect(day.type, where).toBe(src.type);
          expect(day.label, where).toBe(src.label);
          expect(day.distanceMi ?? 0, where).toBeCloseTo(src.distanceMi ?? 0, 1);
          expect(day.secondary?.distanceMi ?? 0, where).toBeCloseTo(src.secondary?.distanceMi ?? 0, 1);
        }),
      );
      expect(getPlanRaceDayRef(plan)).toEqual(getPlanRaceDayRef(original));
    }
    const stored = getImportedPlans();
    expect(stored).toHaveLength(ALL_BUILT_IN_PLANS.length);
    expect(new Set(stored.map((p) => p.id)).size).toBe(stored.length);
    for (const block of SUPPLEMENTAL_PLANS) {
      expect(stored.some((p) => p.name === block.name && getPlanRaceDayRef(p) === null)).toBe(true);
    }
  });

  it('an Apollo-designed plan exported as “original” re-imports as representative', () => {
    const base = ALL_BUILT_IN_PLANS[0];
    const designed: TrainingPlan = {
      ...base,
      attribution: { coach: 'Apollo Coaching Lab', fidelity: 'original', note: 'Designed by Apollo.', sources: [] },
    };
    const res = parseImportedPlanJson(serializePlanToJson(designed));
    expect(res.ok && res.plan.attribution?.fidelity).toBe('representative');
  });

  it('custom plans from the builder re-import too (7-day weeks, PM doubles and time targets included)', () => {
    for (const input of [
      { runningDays: 3, currentWeeklyMiles: 15, peakWeeklyMiles: 30 },
      { runningDays: 7, currentWeeklyMiles: 70, peakWeeklyMiles: 110, enableDoubles: true, isTimeBased: true },
    ]) {
      const custom = createCustomPlanFromScratch({ name: 'My build', totalWeeks: 18, ...input });
      const res = parseImportedPlanJson(serializePlanToJson(custom));
      expect(res.ok, res.ok ? '' : res.error).toBe(true);
      if (!res.ok) continue;
      expect(res.plan.weeks).toHaveLength(custom.weeks.length);
      expect(getPlanRaceDayRef(res.plan)).toEqual(getPlanRaceDayRef(custom));
      expect(res.plan.hasDoubles ?? false).toBe(custom.hasDoubles ?? false);
    }
  });
});
