/**
 * Tests for Calendar Export Service
 */

import { describe, it, expect } from 'vitest';
import {
  generateCalendarEvents,
  generateICS,
  exportPlan,
} from '@/services/calendarExport';
import { BUILT_IN_PLANS } from '@/data/plans';

const testPlan = BUILT_IN_PLANS[0]; // Hal Higdon Novice 1
const startDate = '2026-04-06';

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
  });

  it('should include rest days when option is set', () => {
    const events = generateCalendarEvents(testPlan, startDate, { includeRestDays: true });
    const restEvents = events.filter((e) => e.summary.includes('Rest'));
    expect(restEvents.length).toBeGreaterThan(0);
  });

  it('should have more events when rest days included', () => {
    const withoutRest = generateCalendarEvents(testPlan, startDate);
    const withRest = generateCalendarEvents(testPlan, startDate, { includeRestDays: true });
    expect(withRest.length).toBeGreaterThan(withoutRest.length);
  });

  it('should assign unique UIDs to each event', () => {
    const events = generateCalendarEvents(testPlan, startDate);
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
    const marathonEvent = events.find((e) => e.summary.includes('MARATHON'));
    expect(marathonEvent).toBeDefined();
  });

  it('should include week number in event summaries', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    for (const event of events) {
      expect(event.summary).toMatch(/Week \d+/);
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
});

// ── ICS Generation ────────────────────────────────────────────────────────────

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
    expect(ics).toContain(testPlan.name);
  });

  it('should contain UIDs for all events', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const ics = generateICS(events, testPlan.name);

    for (const event of events) {
      expect(ics).toContain(`UID:${event.uid}`);
    }
  });

  it('should use CRLF line endings', () => {
    const events = generateCalendarEvents(testPlan, startDate);
    const ics = generateICS(events, testPlan.name);
    expect(ics).toContain('\r\n');
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
  });

  it('should work with any built-in plan', () => {
    for (const plan of BUILT_IN_PLANS) {
      const result = exportPlan(plan, '2026-05-01');
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
