/**
 * Tests for Calendar Export Service
 *
 * v1.0.6: the export is a thin RFC 5545 serializer over
 * planCalendarSync.buildPlanWorkouts. Regression tests for U-01..U-07.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  generateCalendarEvents,
  generateICS,
  exportPlan,
  exportActivePlan,
  downloadICS,
  foldICSLine,
  escapeICSText,
  calendarEventUid,
  getActivePlanExportInfo,
  type CalendarEvent,
} from '@/services/calendarExport';
import { BUILT_IN_PLANS, type TrainingPlan } from '@/data/plans';
import { calculateTrainingPaces } from '@/services/paceCalculator';
import { setDistanceUnit } from '@/services/unitPreferences';
import { setActivePlan } from '@/services/planProgress';
import { moveWorkout, skipWorkout } from '@/services/planOverlay';
import { persistence } from '@/services/db/persistence';

const testPlan = BUILT_IN_PLANS[0]; // Hal Higdon Novice 1
const startDate = '2026-04-06'; // a Monday
const NOW = new Date(Date.UTC(2026, 9, 7, 18, 5, 9)); // 2026-10-07T18:05:09Z

const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;
/** Physical lines of an .ics string (without the trailing empty line). */
const physicalLines = (ics: string) => ics.split('\r\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
/** Undo RFC 5545 folding. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');
const contentLines = (ics: string) => physicalLines(unfold(ics));
/** Plain-text value of a property (folding and escaping undone). */
function unescapeText(v: string): string {
  return v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function clonePlan(plan: TrainingPlan): TrainingPlan {
  return JSON.parse(JSON.stringify(plan)) as TrainingPlan;
}

function fmtClock(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Calendar Event Generation ─────────────────────────────────────────────────

describe('generateCalendarEvents', () => {
  it('should generate events for a training plan', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    expect(events.length).toBeGreaterThan(0);
  });

  it('should exclude rest days by default', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const restEvents = events.filter((e) => e.summary.includes('Rest'));
    expect(restEvents.length).toBe(0);
    expect(events.every((e) => e.kind === 'workout')).toBe(true);
  });

  it('should include rest days when option is set', () => {
    const events = generateCalendarEvents(testPlan, startDate, { includeRestDays: true });
    const restEvents = events.filter((e) => e.summary.includes('Rest'));
    expect(restEvents.length).toBeGreaterThan(0);
    expect(restEvents.every((e) => e.kind === 'rest' && e.durationMin === 0)).toBe(true);
  });

  it('should have more events when rest days included', () => {
    const withoutRest = generateCalendarEvents(testPlan, startDate);
    const withRest = generateCalendarEvents(testPlan, startDate, { includeRestDays: true });
    expect(withRest.length).toBeGreaterThan(withoutRest.length);
  });

  it('should assign unique UIDs to each event', () => {
    const events = generateCalendarEvents(testPlan, startDate, { includeRestDays: true });
    const uids = events.map((e) => e.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('should have valid date format (YYYY-MM-DD) for all events', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    for (const event of events) {
      expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('should include marathon event on the last week', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const marathonEvent = events.find((e) => /^marathon day/i.test(e.summary));
    expect(marathonEvent).toBeDefined();
    expect(marathonEvent!.weekNumber).toBe(testPlan.weeks.length);
  });

  it('should include the plan week in every description (titles stay short)', () => {
    const events = generateCalendarEvents(testPlan, startDate, { includeRestDays: true });
    for (const event of events) {
      expect(event.description).toContain(`Week ${event.weekNumber} of ${testPlan.weeks.length}`);
    }
  });

  it('should have positive duration for workout events', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const workouts = events.filter((e) => !e.summary.includes('Rest'));
    for (const event of workouts) {
      expect(event.durationMin).toBeGreaterThan(0);
    }
  });

  it('should have event descriptions', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    for (const event of events) {
      expect(event.description).toBeTruthy();
    }
  });

  it('returns no events for an invalid start date', () => {
    expect(generateCalendarEvents(testPlan, 'not-a-date')).toEqual([]);
  });

  it('turns intervals.icu step syntax into readable text', () => {
    const plan = clonePlan(testPlan);
    plan.weeks[0].days[1] = { type: 'run', label: 'Speed', distanceMi: 6, note: 'Speed' };
    plan.weeks[0].days[2] = { type: 'cross', label: 'Cross' };
    const paces = calculateTrainingPaces(45);
    const events = generateCalendarEvents(plan, startDate, { unit: 'mi', paces });
    const speed = events.find((e) => e.date === '2026-04-07')!;
    expect(speed.description).toMatch(/- 800 m @ \d+:\d{2}–\d+:\d{2}\/mi/);
    expect(speed.description).toMatch(/Recovery jog \d+ (min|sec)/);
    expect(speed.description).not.toContain('mtr');
    expect(speed.description).not.toContain(' Pace');
    const cross = events.find((e) => e.date === '2026-04-08')!;
    expect(cross.description).toContain('45 min');
    expect(cross.description).not.toMatch(/\b45m\b/);
  });
});

// ── U-01 / U-02 / U-06: paces and units ──────────────────────────────────────

describe('paces and units (U-01, U-02, U-06)', () => {
  it('uses the athlete VDOT paces, not elite paces (U-01)', () => {
    const paces = calculateTrainingPaces(45)!;
    const events = generateCalendarEvents(testPlan, startDate, { unit: 'mi', paces });
    const easy = events.find((e) => e.summary.startsWith('Easy Run'))!;
    expect(easy).toBeDefined();
    // Easy range is written slow–fast in the athlete's unit.
    expect(easy.description).toContain(`${fmtClock(paces.easy.max)}–${fmtClock(paces.easy.min)}/mi`);
    // VDOT 85 easy pace is ~5:20/mi; nothing that fast may appear for a VDOT-45 runner.
    expect(easy.description).not.toMatch(/\b5:\d{2}[–-]5:\d{2}\/mi/);
  });

  it('reads the saved paces from storage when none are passed', () => {
    const paces = calculateTrainingPaces(45)!;
    persistence.setItem('apollo_training_paces', JSON.stringify(paces));
    const result = exportPlan(testPlan, startDate, { unit: 'mi' });
    expect(result.hasPaceTargets).toBe(true);
    expect(result.icsContent).toContain(fmtClock(paces.easy.max));
  });

  it('never doubles the pace unit (U-02)', () => {
    const paces = calculateTrainingPaces(45);
    for (const unit of ['mi', 'km'] as const) {
      const ics = exportPlan(testPlan, startDate, { unit, paces }, { now: NOW }).icsContent;
      expect(ics).not.toContain('/mi/mi');
      expect(ics).not.toContain('/km/km');
    }
  });

  it('writes km distances and km paces for km users (U-06)', () => {
    setDistanceUnit('km');
    const paces = calculateTrainingPaces(45)!;
    const events = generateCalendarEvents(testPlan, startDate, { paces });
    const easy = events.find((e) => e.summary.startsWith('Easy Run'))!;
    expect(easy.summary).toMatch(/· \d+(\.\d)? km$/);
    const slowKm = fmtClock(paces.easy.max / 1.609344);
    const fastKm = fmtClock(paces.easy.min / 1.609344);
    expect(easy.description).toContain(`${slowKm}–${fastKm}/km`);
    for (const e of events) {
      expect(e.summary).not.toMatch(/\bmi\b/);
      expect(e.description).not.toMatch(/\/mi\b|\d mi\b/);
    }
  });

  it('exports plain distances without targets when paces are unknown', () => {
    const result = exportPlan(testPlan, startDate, { unit: 'mi', paces: null });
    expect(result.hasPaceTargets).toBe(false);
    expect(result.icsContent).not.toMatch(/@ \d+:\d{2}/);
  });
});

// ── U-03 / U-04 / U-05: RFC 5545 structure ───────────────────────────────────

describe('generateICS', () => {
  it('should generate valid ICS content', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const ics = generateICS(events, testPlan.name);

    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:-//Apollo Running');
  });

  it('should contain VEVENT blocks for each event', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const ics = generateICS(events, testPlan.name);

    const veventCount = (ics.match(/BEGIN:VEVENT/g) ?? []).length;
    expect(veventCount).toBe(events.length);
  });

  it('should include plan name as calendar name', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const ics = generateICS(events, testPlan.name);
    expect(unfold(ics)).toContain(`X-WR-CALNAME:${escapeICSText(testPlan.name)}`);
  });

  it('should contain UIDs for all events', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const ics = unfold(generateICS(events, testPlan.name));

    for (const event of events) {
      expect(ics).toContain(`UID:${event.uid}`);
    }
  });

  it('should use CRLF line endings only', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const ics = generateICS(events, testPlan.name);
    expect(ics).toContain('\r\n');
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('keeps every physical line within 75 octets (U-05)', () => {
    const paces = calculateTrainingPaces(45);
    for (const plan of BUILT_IN_PLANS) {
      const ics = exportPlan(plan, startDate, { unit: 'km', paces, includeRestDays: true }, { now: NOW }).icsContent;
      for (const line of physicalLines(ics)) {
        expect(octets(line)).toBeLessThanOrEqual(75);
      }
    }
  });

  it('folding is lossless: unfolded descriptions equal the event text', () => {
    const paces = calculateTrainingPaces(45);
    const result = exportPlan(testPlan, startDate, { unit: 'mi', paces }, { now: NOW });
    const descriptions = contentLines(result.icsContent)
      .filter((l) => l.startsWith('DESCRIPTION:'))
      .map((l) => unescapeText(l.slice('DESCRIPTION:'.length)));
    expect(descriptions).toEqual(result.events.map((e) => e.description));
  });

  it('writes all-day events with VALUE=DATE and an exclusive next-day DTEND (U-03)', () => {
    const events: CalendarEvent[] = [
      { uid: 'a@x', date: '2026-04-07', summary: 'A', description: 'a', durationMin: 30, weekNumber: 1, dayOfWeek: 1, kind: 'workout' },
      { uid: 'b@x', date: '2026-12-31', summary: 'B', description: 'b', durationMin: 30, weekNumber: 1, dayOfWeek: 3, kind: 'workout' },
      { uid: 'c@x', date: '2026-03-08', summary: 'C', description: 'c', durationMin: 30, weekNumber: 1, dayOfWeek: 6, kind: 'workout' },
      { uid: 'd@x', date: '2028-02-28', summary: 'D', description: 'd', durationMin: 30, weekNumber: 1, dayOfWeek: 0, kind: 'workout' },
    ];
    const lines = contentLines(generateICS(events, 'Plan', { now: NOW }));
    expect(lines.filter((l) => l.startsWith('DTSTART'))).toEqual([
      'DTSTART;VALUE=DATE:20260407',
      'DTSTART;VALUE=DATE:20261231',
      'DTSTART;VALUE=DATE:20260308',
      'DTSTART;VALUE=DATE:20280228',
    ]);
    expect(lines.filter((l) => l.startsWith('DTEND'))).toEqual([
      'DTEND;VALUE=DATE:20260408',
      'DTEND;VALUE=DATE:20270101',
      'DTEND;VALUE=DATE:20260309', // across the US spring-forward change
      'DTEND;VALUE=DATE:20280229', // leap day
    ]);
  });

  it('every exported event has DTEND one day after DTSTART', () => {
    const ics = exportPlan(testPlan, startDate, { includeRestDays: true }, { now: NOW }).icsContent;
    const lines = contentLines(ics);
    const starts = lines.filter((l) => l.startsWith('DTSTART;VALUE=DATE:')).map((l) => l.slice(-8));
    const ends = lines.filter((l) => l.startsWith('DTEND;VALUE=DATE:')).map((l) => l.slice(-8));
    expect(starts.length).toBeGreaterThan(0);
    expect(ends.length).toBe(starts.length);
    starts.forEach((s, i) => {
      const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) + 1));
      const expected = d.toISOString().slice(0, 10).replace(/-/g, '');
      expect(ends[i]).toBe(expected);
      expect(ends[i] > s).toBe(true);
    });
    expect(lines.some((l) => /^DTSTART:\d{8}$/.test(l))).toBe(false);
  });

  it('writes DTSTAMP in UTC (U-04)', () => {
    const ics = generateICS(generateCalendarEvents(testPlan, startDate), 'Plan', { now: NOW });
    const stamps = contentLines(ics).filter((l) => l.startsWith('DTSTAMP'));
    expect(stamps.length).toBeGreaterThan(0);
    for (const s of stamps) expect(s).toBe('DTSTAMP:20261007T180509Z');
  });

  it('escapes TEXT values and normalises line breaks', () => {
    expect(escapeICSText('a,b;c\\d\r\ne\rf\ng')).toBe('a\\,b\\;c\\\\d\\ne\\nf\\ng');
    expect(escapeICSText('bell\u0007')).toBe('bell');
    const events: CalendarEvent[] = [{
      uid: 'u@x', date: '2026-04-07', summary: 'Tempo, hard; fast', description: 'Line 1\r\nLine 2',
      durationMin: 30, weekNumber: 1, dayOfWeek: 1, kind: 'workout',
    }];
    const lines = contentLines(generateICS(events, 'My plan, v2; \\ final', { now: NOW }));
    expect(lines).toContain('X-WR-CALNAME:My plan\\, v2\\; \\\\ final');
    expect(lines).toContain('SUMMARY:Tempo\\, hard\\; fast');
    expect(lines).toContain('DESCRIPTION:Line 1\\nLine 2');
  });
});

describe('foldICSLine', () => {
  it('leaves short lines alone', () => {
    expect(foldICSLine('SUMMARY:Easy Run')).toBe('SUMMARY:Easy Run');
  });

  it('folds at 75 octets with a leading space on continuation lines', () => {
    const line = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = foldICSLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(2);
    expect(octets(parts[0])).toBe(75);
    for (const p of parts.slice(1)) {
      expect(p.startsWith(' ')).toBe(true);
      expect(octets(p)).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('never splits multi-byte UTF-8 characters', () => {
    const line = `SUMMARY:${'é'.repeat(50)}${'🏃'.repeat(30)}${'—'.repeat(40)}`;
    const folded = foldICSLine(line);
    for (const p of folded.split('\r\n')) {
      expect(octets(p)).toBeLessThanOrEqual(75);
      // A split surrogate pair or UTF-8 sequence would not round-trip.
      expect(new TextDecoder('utf-8', { fatal: true }).decode(encoder.encode(p))).toBe(p);
      expect(p).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });
});

// ── U-07: UIDs ────────────────────────────────────────────────────────────────

describe('UIDs (U-07)', () => {
  it('include the plan instance (plan id + start date) and the event date', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    for (const e of events) {
      expect(e.uid).toBe(calendarEventUid(testPlan.id, startDate, e.date));
      expect(e.uid).toContain(testPlan.id);
      expect(e.uid).toContain(startDate);
      expect(e.uid).toContain(e.date);
      expect(e.uid.endsWith('@apollo-running')).toBe(true);
    }
  });

  it('two cycles of the same plan never collide', () => {
    const a = generateCalendarEvents(testPlan, '2026-04-06').map((e) => e.uid);
    const b = generateCalendarEvents(testPlan, '2026-11-02').map((e) => e.uid);
    expect(a.filter((uid) => b.includes(uid))).toEqual([]);
  });

  it('are stable across exports (re-import updates instead of duplicating)', () => {
    const a = generateCalendarEvents(testPlan, startDate).map((e) => e.uid);
    const b = generateCalendarEvents(testPlan, startDate).map((e) => e.uid);
    expect(a).toEqual(b);
  });
});

// ── Options: from today, rest days, joined plans, moved workouts ─────────────

describe('export options', () => {
  it('"from today only" drops past days; the whole plan starts at the plan start', () => {
    const today = '2026-05-13';
    const fromToday = generateCalendarEvents(testPlan, startDate, { fromToday: true, today, includeRestDays: true });
    expect(fromToday.length).toBeGreaterThan(0);
    expect(fromToday.every((e) => e.date >= today)).toBe(true);
    expect(fromToday[0].date).toBe(today);
    const whole = generateCalendarEvents(testPlan, startDate, { today, includeRestDays: true });
    expect(whole[0].date).toBe(startDate);
    expect(whole.length).toBeGreaterThan(fromToday.length);
  });

  it('"from today" before the plan starts exports the whole plan', () => {
    const events = generateCalendarEvents(testPlan, startDate, { fromToday: true, today: '2026-01-01' });
    const whole = generateCalendarEvents(testPlan, startDate);
    expect(events.map((e) => e.uid)).toEqual(whole.map((e) => e.uid));
  });

  it('skips weeks before the joined week', () => {
    const events = generateCalendarEvents(testPlan, startDate, { firstWeekIndex: 3, includeRestDays: true });
    expect(events[0].date).toBe('2026-04-27');
    expect(events.every((e) => e.weekNumber >= 4)).toBe(true);
  });

  it('labels skipped days (overlay) as rest days', () => {
    const plan = clonePlan(testPlan);
    plan.weeks[0].days[1] = { type: 'rest', label: 'Rest', skipped: true, originalLabel: '3 mi run' };
    const withRest = generateCalendarEvents(plan, startDate, { includeRestDays: true });
    const skipped = withRest.find((e) => e.date === '2026-04-07')!;
    expect(skipped.kind).toBe('rest');
    expect(skipped.summary).toBe('Rest day (skipped workout)');
    expect(skipped.description).toContain('3 mi run');
    const withoutRest = generateCalendarEvents(plan, startDate);
    expect(withoutRest.find((e) => e.date === '2026-04-07')).toBeUndefined();
  });

  it('moved workouts appear on their new dates', () => {
    const plan = clonePlan(testPlan);
    const week = plan.weeks[1].days;
    // Find the long run (largest distance) of week 2 and swap it with Monday.
    let longIdx = 0;
    week.forEach((d, i) => { if ((d.distanceMi ?? 0) > (week[longIdx].distanceMi ?? 0)) longIdx = i; });
    expect(longIdx).not.toBe(0);
    const longDay = week[longIdx];
    [week[0], week[longIdx]] = [week[longIdx], week[0]];

    const original = generateCalendarEvents(testPlan, startDate, { unit: 'mi', paces: null });
    const moved = generateCalendarEvents(plan, startDate, { unit: 'mi', paces: null });
    const mondayWeek2 = '2026-04-13';
    const oldDate = `2026-04-${String(13 + longIdx).padStart(2, '0')}`;
    const longTitle = original.find((e) => e.date === oldDate)!.summary;
    expect(longTitle).toContain(String(longDay.distanceMi));
    expect(moved.find((e) => e.date === mondayWeek2)!.summary).toBe(longTitle);
    expect(moved.find((e) => e.date === oldDate)?.summary).not.toBe(longTitle);
    // The UID belongs to the date slot, so a re-import updates both days in place.
    expect(moved.find((e) => e.date === mondayWeek2)!.uid).toBe(calendarEventUid(testPlan.id, startDate, mondayWeek2));
  });
});

// ── Full Export ───────────────────────────────────────────────────────────────

describe('exportPlan', () => {
  it('should return a complete CalendarExportResult', () => {
    const result = exportPlan(testPlan, startDate);

    expect(result.planName).toBe(testPlan.name);
    expect(result.startDate).toBe(startDate);
    expect(result.totalEvents).toBeGreaterThan(0);
    expect(result.totalEvents).toBe(result.events.length);
    expect(result.icsContent).toContain('BEGIN:VCALENDAR');
    expect(result.fileName).toMatch(/^[A-Za-z0-9_]+\.ics$/);
    expect(result.firstDate).toBe(result.events[0].date);
    expect(result.lastDate).toBe(result.events[result.events.length - 1].date);
  });

  it('should work with any built-in plan', () => {
    for (const plan of BUILT_IN_PLANS) {
      const result = exportPlan(plan, '2026-05-04');
      expect(result.totalEvents).toBeGreaterThan(0);
      expect(result.icsContent).toContain('BEGIN:VCALENDAR');
    }
  });

  it('should respect includeRestDays option', () => {
    const withRest = exportPlan(testPlan, startDate, { includeRestDays: true });
    const withoutRest = exportPlan(testPlan, startDate, { includeRestDays: false });
    expect(withRest.totalEvents).toBeGreaterThan(withoutRest.totalEvents);
  });
});

describe('exportActivePlan', () => {
  it('returns null without an active plan', () => {
    expect(exportActivePlan()).toBeNull();
    expect(getActivePlanExportInfo()).toBeNull();
  });

  it('exports the active plan instance', () => {
    setActivePlan({ planId: testPlan.id, startDate });
    const result = exportActivePlan({ unit: 'mi', paces: null, includeRestDays: true })!;
    expect(result).not.toBeNull();
    expect(result.planName).toBe(testPlan.name);
    expect(result.events[0].date).toBe(startDate);
    expect(result.events[0].uid).toContain(`${testPlan.id}-${startDate}`);
    const info = getActivePlanExportInfo()!;
    expect(info.planName).toBe(testPlan.name);
    expect(info.startDate).toBe(startDate);
  });

  it('honours a joined week on the active plan', () => {
    setActivePlan({ planId: testPlan.id, startDate, joinedWeekIndex: 2 });
    const result = exportActivePlan({ unit: 'mi', paces: null, includeRestDays: true })!;
    expect(result.events[0].date).toBe('2026-04-20');
  });

  it('exports workouts moved with the plan overlay on their new dates', () => {
    setActivePlan({ planId: testPlan.id, startDate });
    const before = exportActivePlan({ unit: 'mi', paces: null })!;
    // Week 2 (index 1): move Saturday's long run (day 5) to Monday (day 0).
    const satDate = '2026-04-18';
    const monDate = '2026-04-13';
    const longTitle = before.events.find((e) => e.date === satDate)!.summary;
    expect(moveWorkout({ weekIndex: 1, dayIndex: 5 }, { weekIndex: 1, dayIndex: 0 }).ok).toBe(true);
    const after = exportActivePlan({ unit: 'mi', paces: null })!;
    expect(after.events.find((e) => e.date === monDate)?.summary).toBe(longTitle);
    expect(after.events.find((e) => e.date === satDate)?.summary).not.toBe(longTitle);
    expect(unfold(after.icsContent)).toContain(`UID:${calendarEventUid(testPlan.id, startDate, monDate)}`);
  });

  it('drops skipped workouts (or marks them as rest days when rest days are included)', () => {
    setActivePlan({ planId: testPlan.id, startDate });
    const tuesday = '2026-04-07';
    expect(exportActivePlan({ paces: null })!.events.some((e) => e.date === tuesday)).toBe(true);
    expect(skipWorkout({ weekIndex: 0, dayIndex: 1 }).ok).toBe(true);
    expect(exportActivePlan({ paces: null })!.events.some((e) => e.date === tuesday)).toBe(false);
    const withRest = exportActivePlan({ paces: null, includeRestDays: true })!;
    const skipped = withRest.events.find((e) => e.date === tuesday)!;
    expect(skipped.kind).toBe('rest');
    expect(skipped.summary).toBe('Rest day (skipped workout)');
  });
});

describe('downloadICS', () => {
  it('downloads through a Blob URL and an <a download> click', () => {
    const create = vi.fn(() => 'blob:apollo-test');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('Plan_training.ics');
      expect(this.href).toBe('blob:apollo-test');
    });
    vi.useFakeTimers();
    try {
      expect(downloadICS({ icsContent: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', fileName: 'Plan_training.ics' })).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledWith('blob:apollo-test');
    } finally {
      vi.useRealTimers();
    }
  });
});
