/**
 * Tests for raceDayTimeline.ts — Race Day Timeline Generator
 */

import { describe, it, expect } from 'vitest';
import { generateRaceDayTimeline } from '@/services/raceDayTimeline';
import type { RaceDayInput } from '@/services/raceDayTimeline';

const baseInput: RaceDayInput = {
  raceStartTime: '07:00',
  travelMinutes: 30,
  mealPreference: 'moderate',
  weightKg: 70,
  projectedFinishSec: 3 * 3600 + 30 * 60, // 3:30
  raceName: 'Chicago Marathon',
  fuelingItemsCount: 5,
  includeWarmup: true,
};

describe('generateRaceDayTimeline', () => {
  it('should generate a timeline with multiple events', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    expect(timeline.events.length).toBeGreaterThan(10);
    expect(timeline.raceName).toBe('Chicago Marathon');
  });

  it('should include key event categories', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const categories = new Set(timeline.events.map((e) => e.category));
    expect(categories.has('wake')).toBe(true);
    expect(categories.has('nutrition')).toBe(true);
    expect(categories.has('logistics')).toBe(true);
    expect(categories.has('race')).toBe(true);
    expect(categories.has('milestone')).toBe(true);
  });

  it('should include breakfast 3 hours before race', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const breakfast = timeline.events.find((e) => e.title.toLowerCase().includes('breakfast'));
    expect(breakfast).toBeDefined();
    expect(breakfast!.minutesBeforeStart).toBeCloseTo(180, -1);
  });

  it('should include alarm event', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const alarm = timeline.events.find((e) => e.title.toLowerCase().includes('alarm') || e.title.toLowerCase().includes('wake'));
    expect(alarm).toBeDefined();
    expect(alarm!.minutesBeforeStart).toBeGreaterThan(180);
  });

  it('should include race start event', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const start = timeline.events.find((e) => e.title.toLowerCase().includes('gun time') && e.category === 'race');
    expect(start).toBeDefined();
    expect(start!.minutesBeforeStart).toBe(0);
  });

  it('should include projected finish', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const finish = timeline.events.find((e) => e.title.toLowerCase().includes('finish'));
    expect(finish).toBeDefined();
  });

  it('should include fueling reminders when items count is given', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const fuelingEvents = timeline.events.filter((e) => e.category === 'fueling');
    expect(fuelingEvents.length).toBe(5);
  });

  it('should include warmup when requested', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const warmup = timeline.events.find((e) => e.category === 'warmup');
    expect(warmup).toBeDefined();
  });

  it('should skip warmup when not requested', () => {
    const timeline = generateRaceDayTimeline({ ...baseInput, includeWarmup: false });
    const warmup = timeline.events.find((e) => e.category === 'warmup');
    expect(warmup).toBeUndefined();
  });

  it('should include race milestones', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const milestones = timeline.events.filter((e) => e.category === 'milestone');
    expect(milestones.length).toBeGreaterThanOrEqual(5);
  });

  it('should generate exportable text', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    expect(timeline.textExport).toBeTruthy();
    expect(timeline.textExport).toContain('Chicago Marathon');
    expect(timeline.textExport).toContain('Apollo Running');
  });

  it('should include carb targets in breakfast event', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    const breakfast = timeline.events.find((e) => e.title.toLowerCase().includes('breakfast'));
    expect(breakfast!.description).toContain('g carbs');
  });

  it('should set times in AM/PM format', () => {
    const timeline = generateRaceDayTimeline(baseInput);
    for (const event of timeline.events) {
      expect(event.time).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    }
  });

  it('should handle evening race start', () => {
    const eveningInput = { ...baseInput, raceStartTime: '18:00' };
    const timeline = generateRaceDayTimeline(eveningInput);
    expect(timeline.events.length).toBeGreaterThan(10);
    // Breakfast should be at 3:00 PM
    const breakfast = timeline.events.find((e) => e.title.toLowerCase().includes('breakfast'));
    expect(breakfast!.time).toContain('PM');
  });
});
