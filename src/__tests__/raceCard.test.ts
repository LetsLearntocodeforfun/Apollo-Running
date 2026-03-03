/**
 * Tests for Printable Race Card Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateRaceCard,
  getRaceCardPrefs,
  setRaceCardPrefs,
  type RaceCardInput,
} from '@/services/raceCard';
import type { RaceStrategy } from '@/types/raceStrategy';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.removeItem('apollo_race_card_prefs');
});

// ── Test Fixtures ─────────────────────────────────────────────────────────────

function makeStrategy(targetTimeSec = 12600): RaceStrategy {
  const avgPace = targetTimeSec / 26.2;
  const milePaces = Array.from({ length: 26 }, (_, i) => {
    const mile = i + 1;
    const elevChange = mile === 20 ? 65 : mile === 22 ? -90 : 0;
    return {
      mile,
      targetPaceSec: Math.round(avgPace),
      targetPaceFormatted: formatPace(avgPace),
      cumulativeTimeSec: Math.round(avgPace * mile),
      cumulativeTimeFormatted: formatTime(avgPace * mile),
      elevationChangeFt: elevChange,
      notes: '',
    };
  });

  return {
    id: 'strat-1',
    name: 'Test Strategy',
    marathonId: 'test',
    marathonName: 'Test Marathon',
    targetTimeSec,
    targetTimeFormatted: formatTime(targetTimeSec),
    pacingStrategy: 'even-split',
    milePaces,
    nutritionPlan: [
      { mile: 5, item: 'Gel #1', notes: '' },
      { mile: 10, item: 'Gel #2', notes: '' },
      { mile: 15, item: 'Gel #3', notes: '' },
      { mile: 20, item: 'Gel #4', notes: '' },
    ],
    firstHalfSec: Math.round(avgPace * 13),
    secondHalfSec: Math.round(avgPace * 13.2),
    avgPaceSec: Math.round(avgPace),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: '',
  };
}

function formatPace(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ── generateRaceCard ──────────────────────────────────────────────────────────

describe('generateRaceCard', () => {
  it('should generate a valid race card', () => {
    const input: RaceCardInput = { strategy: makeStrategy() };
    const card = generateRaceCard(input);

    expect(card.title).toContain('Test Marathon');
    expect(card.marathonName).toBe('Test Marathon');
    expect(card.targetFinish).toBeTruthy();
    expect(card.avgPace).toMatch(/\d+:\d{2}/);
  });

  it('should include all 26 miles', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.miles.length).toBe(26);
    expect(card.miles[0].mile).toBe(1);
    expect(card.miles[25].mile).toBe(26);
  });

  it('should produce mile entries with pace and cumulative time', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    const mile1 = card.miles[0];
    expect(mile1.targetPace).toMatch(/\d+:\d{2}/);
    expect(mile1.cumTime).toMatch(/\d+:\d{2}:\d{2}/);
  });

  it('should include nutrition at correct miles', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.miles[4].nutrition).toBe('Gel #1');   // mile 5
    expect(card.miles[9].nutrition).toBe('Gel #2');   // mile 10
    expect(card.miles[14].nutrition).toBe('Gel #3');  // mile 15
    expect(card.miles[19].nutrition).toBe('Gel #4');  // mile 20
    expect(card.miles[0].nutrition).toBe('');         // no nutrition at mile 1
  });

  it('should mark elevation changes correctly', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    // Mile 20 has +65ft, Mile 22 has -90ft
    expect(card.miles[19].elevation).toContain('+65');
    expect(card.miles[21].elevation).toContain('-90');
    expect(card.miles[0].elevation).toBe('flat');
  });

  it('should generate elevation warnings for significant changes', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.elevationWarnings.length).toBe(2);
    expect(card.elevationWarnings[0]).toContain('Mile 20');
    expect(card.elevationWarnings[0]).toContain('climb');
    expect(card.elevationWarnings[1]).toContain('Mile 22');
    expect(card.elevationWarnings[1]).toContain('descent');
  });

  it('should include mantras at specified miles', () => {
    const input: RaceCardInput = {
      strategy: makeStrategy(),
      mantras: { 1: 'Easy start', 20: 'Stay strong', 26: 'Almost there' },
    };
    const card = generateRaceCard(input);
    expect(card.miles[0].mantra).toBe('Easy start');
    expect(card.miles[19].mantra).toBe('Stay strong');
    expect(card.miles[25].mantra).toBe('Almost there');
    expect(card.miles[5].mantra).toBe('');
  });

  it('should include weather summary if provided', () => {
    const card = generateRaceCard({
      strategy: makeStrategy(),
      weatherSummary: '55°F, partly cloudy',
    });
    expect(card.weatherSummary).toBe('55°F, partly cloudy');
  });

  it('should include emergency contact if provided', () => {
    const card = generateRaceCard({
      strategy: makeStrategy(),
      emergencyContact: { name: 'Jane', phone: '555-1234' },
    });
    expect(card.emergencyContact).toContain('Jane');
    expect(card.emergencyContact).toContain('555-1234');
  });

  it('should use saved emergency contact from preferences', () => {
    setRaceCardPrefs({ emergencyContact: { name: 'Bob', phone: '555-9999' } });
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.emergencyContact).toContain('Bob');
    expect(card.emergencyContact).toContain('555-9999');
  });

  it('should include notes if provided', () => {
    const card = generateRaceCard({
      strategy: makeStrategy(),
      notes: 'Start in wave 2',
    });
    expect(card.notes).toBe('Start in wave 2');
  });
});

// ── Pace Bands ────────────────────────────────────────────────────────────────

describe('paceBands', () => {
  it('should generate 3 pace bands', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.paceBands.length).toBe(3);
  });

  it('should have goal, conservative, and aggressive bands', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    const labels = card.paceBands.map((b) => b.label);
    expect(labels).toContain('Goal');
    expect(labels).toContain('Conservative');
    expect(labels).toContain('Aggressive');
  });

  it('should have pace per mile in mm:ss format', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    for (const band of card.paceBands) {
      expect(band.pacePerMi).toMatch(/\d+:\d{2}/);
    }
  });

  it('should have time projections for each band', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    for (const band of card.paceBands) {
      expect(band.fiveKSplit).toMatch(/\d+:\d{2}:\d{2}/);
      expect(band.halfSplit).toMatch(/\d+:\d{2}:\d{2}/);
      expect(band.finishTime).toMatch(/\d+:\d{2}:\d{2}/);
    }
  });

  it('aggressive should be faster than goal which is faster than conservative', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    const goal = card.paceBands.find((b) => b.label === 'Goal')!;
    const conservative = card.paceBands.find((b) => b.label === 'Conservative')!;
    const aggressive = card.paceBands.find((b) => b.label === 'Aggressive')!;
    // Compare finish times (h:mm:ss) — lexicographic works for same format
    expect(aggressive.finishTime < goal.finishTime).toBe(true);
    expect(goal.finishTime < conservative.finishTime).toBe(true);
  });
});

// ── HTML Output ───────────────────────────────────────────────────────────────

describe('HTML content', () => {
  it('should generate valid HTML', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('<!DOCTYPE html>');
    expect(card.htmlContent).toContain('</html>');
  });

  it('should include the marathon name', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('Test Marathon');
  });

  it('should include pace band table', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('Goal');
    expect(card.htmlContent).toContain('Conservative');
    expect(card.htmlContent).toContain('Aggressive');
  });

  it('should include nutrition in cells', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('Gel #1');
    expect(card.htmlContent).toContain('Gel #4');
  });

  it('should include elevation warnings section for major changes', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('Elevation Alerts');
    expect(card.htmlContent).toContain('Mile 20');
    expect(card.htmlContent).toContain('climb');
  });

  it('should include print styles', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('@media print');
  });

  it('should include Apollo branding', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('Apollo Running');
  });

  it('should escape HTML entities in user input', () => {
    const card = generateRaceCard({
      strategy: makeStrategy(),
      notes: 'Test <script>alert(1)</script>',
    });
    expect(card.htmlContent).not.toContain('<script>');
  });
});

// ── Preferences ───────────────────────────────────────────────────────────────

describe('preferences', () => {
  it('should return empty prefs by default', () => {
    const prefs = getRaceCardPrefs();
    expect(prefs).toEqual({});
  });

  it('should persist and retrieve emergency contact', () => {
    setRaceCardPrefs({ emergencyContact: { name: 'Alice', phone: '123' } });
    const prefs = getRaceCardPrefs();
    expect(prefs.emergencyContact!.name).toBe('Alice');
    expect(prefs.emergencyContact!.phone).toBe('123');
  });

  it('should persist default mantras', () => {
    setRaceCardPrefs({ defaultMantras: { 1: 'Go!', 26: 'Done!' } });
    const prefs = getRaceCardPrefs();
    expect(prefs.defaultMantras![1]).toBe('Go!');
    expect(prefs.defaultMantras![26]).toBe('Done!');
  });
});

// ── Nutrition Summary ─────────────────────────────────────────────────────────

describe('nutritionSummary', () => {
  it('should list all nutrition items', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.nutritionSummary).toContain('Gel #1');
    expect(card.nutritionSummary).toContain('Gel #2');
    expect(card.nutritionSummary).toContain('Gel #3');
    expect(card.nutritionSummary).toContain('Gel #4');
  });

  it('should include mile numbers in summary', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.nutritionSummary).toContain('Mile 5');
    expect(card.nutritionSummary).toContain('Mile 20');
  });
});

// ── v2: 5K Checkpoints ───────────────────────────────────────────────────────

describe('fiveKCheckpoints', () => {
  it('should generate 9 checkpoints', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.fiveKCheckpoints.length).toBe(9);
  });

  it('should include 5K through 40K plus Half', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    const labels = card.fiveKCheckpoints.map((cp) => cp.label);
    expect(labels).toContain('5K');
    expect(labels).toContain('10K');
    expect(labels).toContain('Half');
    expect(labels).toContain('30K');
    expect(labels).toContain('40K');
  });

  it('should have increasing cumulative times', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    for (let i = 1; i < card.fiveKCheckpoints.length; i++) {
      expect(card.fiveKCheckpoints[i].cumTime > card.fiveKCheckpoints[i - 1].cumTime).toBe(true);
    }
  });

  it('should have split and cumulative time in hh:mm:ss format', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    for (const cp of card.fiveKCheckpoints) {
      expect(cp.splitTime).toMatch(/\d+:\d{2}:\d{2}/);
      expect(cp.cumTime).toMatch(/\d+:\d{2}:\d{2}/);
    }
  });

  it('should have correct distance values', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    const fiveK = card.fiveKCheckpoints.find((cp) => cp.label === '5K')!;
    expect(fiveK.distanceMi).toBeCloseTo(3.107, 1);
    const half = card.fiveKCheckpoints.find((cp) => cp.label === 'Half')!;
    expect(half.distanceMi).toBeCloseTo(13.1, 0);
  });
});

// ── v2: Segment Summary ──────────────────────────────────────────────────────

describe('segments', () => {
  it('should generate at least 5 segments', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.segments.length).toBeGreaterThanOrEqual(5);
  });

  it('should cover all 26 miles', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    const first = card.segments[0];
    const last = card.segments[card.segments.length - 1];
    expect(first.startMile).toBe(1);
    expect(last.endMile).toBe(26);
  });

  it('should have avg pace in mm:ss format', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    for (const seg of card.segments) {
      expect(seg.avgPace).toMatch(/\d+:\d{2}/);
    }
  });

  it('should have total time in hh:mm:ss format', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    for (const seg of card.segments) {
      expect(seg.totalTime).toMatch(/\d+:\d{2}:\d{2}/);
    }
  });

  it('should have descriptive labels', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.segments[0].label).toContain('1');
    expect(card.segments[0].label).toContain('5');
  });
});

// ── v2: HTML includes checkpoints & segments ─────────────────────────────────

describe('v2 HTML sections', () => {
  it('should include checkpoint table', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('Checkpoint Splits');
    expect(card.htmlContent).toContain('5K');
    expect(card.htmlContent).toContain('Half');
    expect(card.htmlContent).toContain('40K');
  });

  it('should include segment summary table', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('Segment Summary');
    expect(card.htmlContent).toContain('Avg Pace');
  });

  it('should highlight the Half checkpoint', () => {
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(card.htmlContent).toContain('rc-half-highlight');
  });
});
