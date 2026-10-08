/**
 * Tests for Printable Race Card Service
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateRaceCard,
  getRaceCardPrefs,
  setRaceCardPrefs,
  printRaceCard,
  downloadRaceCard,
  PRINT_FRAME_ATTR,
  type RaceCardInput,
} from '@/services/raceCard';
import type { RaceStrategy } from '@/types/raceStrategy';
import { persistence } from '@/services/db/persistence';
import {
  buildRaceStrategy,
  formatPaceForUnit,
  getMarathon,
  importCustomMarathon,
  timeAtDistance,
  KM_PER_MI,
} from '@/services/raceStrategy';

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

  it('should use saved emergency contact from preferences when the caller passes them in (pure)', () => {
    setRaceCardPrefs({ emergencyContact: { name: 'Bob', phone: '555-9999' } });
    // v1.0.6: generateRaceCard is pure — it never reads storage itself…
    expect(generateRaceCard({ strategy: makeStrategy() }).emergencyContact).toBe('');
    // …the panel passes the saved prefs in.
    const prefs = getRaceCardPrefs();
    const card = generateRaceCard({ strategy: makeStrategy(), emergencyContact: prefs.emergencyContact });
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
      // L-05: the Half row is cumulative-only (its old "split" was the time since 20K, mislabelled).
      if (cp.label === 'Half') expect(cp.splitTime).toBe('');
      else expect(cp.splitTime).toMatch(/\d+:\d{2}:\d{2}/);
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

// ── v1.0.6: real buildRaceStrategy fixtures (T-01) ───────────────────────────

function bostonStrategy(goalSec = 14400): RaceStrategy {
  const s = buildRaceStrategy('boston', goalSec, 'even-split');
  if (!s) throw new Error('fixture: buildRaceStrategy returned null');
  return s;
}

describe('race card with real strategies (v1.0.6)', () => {
  it('uses the production plan shape (27 entries, last one partial)', () => {
    const s = bostonStrategy();
    expect(s.milePaces).toHaveLength(27);
    expect(s.milePaces[26].mile).toBeCloseTo(26.2, 5);
  });

  it('L-01: row and segment times sum to the finish; the partial last row is short', () => {
    const s = bostonStrategy();
    const card = generateRaceCard({ strategy: s });
    const finish = s.milePaces[26].cumulativeTimeSec;
    expect(Math.abs(finish - 14400)).toBeLessThanOrEqual(1);

    const rowSum = card.miles.reduce((a, m) => a + m.splitSec, 0);
    const segSum = card.segments.reduce((a, g) => a + g.totalSec, 0);
    expect(Math.abs(rowSum - finish)).toBeLessThanOrEqual(1);
    expect(Math.abs(segSum - finish)).toBeLessThanOrEqual(1);

    const pace = s.milePaces[26].targetPaceSec;
    const last = card.miles[card.miles.length - 1];
    expect(last.label).toBe('26.2');
    expect(last.splitSec).toBeGreaterThan(0.15 * pace);
    expect(last.splitSec).toBeLessThan(0.25 * pace);

    const lastSeg = card.segments[card.segments.length - 1];
    expect(lastSeg.label).toBe('Miles 26-26.2');
    expect(lastSeg.totalSec).toBe(finish - s.milePaces[24].cumulativeTimeSec);
    expect(lastSeg.totalSec).toBeLessThan(1.3 * pace); // 1.2 mi, not 2 full miles
  });

  it('L-03: never prints ":60" for goal times 2:30–6:00 (both units)', () => {
    for (let goal = 2.5 * 3600; goal <= 6 * 3600; goal += 7 * 60) {
      const s = bostonStrategy(goal);
      for (const unit of ['mi', 'km'] as const) {
        expect(generateRaceCard({ strategy: s, unit }).htmlContent).not.toMatch(/:60(?!\d)/);
      }
    }
    const fourHour = generateRaceCard({ strategy: bostonStrategy(14400) });
    expect(fourHour.paceBands.find((b) => b.label === 'Aggressive')!.pacePerMi).toBe('9:00');
  });

  it('L-05: true 5K splits and one halfway time from the plan', () => {
    const s = bostonStrategy();
    const card = generateRaceCard({ strategy: s });
    const cp = (label: string) => card.fiveKCheckpoints.find((c) => c.label === label)!;
    const t = (km: number) => timeAtDistance(s.milePaces, km / KM_PER_MI);
    const split25 = t(25) - t(20);
    expect(cp('25K').splitTime).toBe(generate5kClock(split25));
    const goal = card.paceBands.find((b) => b.label === 'Goal')!;
    expect(goal.halfSplit).toBe(cp('Half').cumTime);
    expect(cp('Half').cumSec).toBe(Math.round(timeAtDistance(s.milePaces, 13.1)));
    expect(card.htmlContent).toContain('5K split');
  });

  it('L-02: a half marathon card uses its own distance', () => {
    const race = importCustomMarathon({
      name: 'Test Half', city: 'X', country: 'Y', date: '2027-05-01', courseType: 'loop', distanceMi: 13.1,
    });
    const s = buildRaceStrategy(race.id, 6300, 'even-split');
    expect(s).not.toBeNull();
    const card = generateRaceCard({ strategy: s!, marathon: race });
    expect(card.fiveKCheckpoints.every((c) => c.distanceMi <= 13.1 + 1e-9)).toBe(true);
    expect(card.fiveKCheckpoints.map((c) => c.label)).toEqual(['5K', '10K', 'Halfway', '15K', '20K']);
    expect(card.fiveKCheckpoints.some((c) => c.cumTime === '0:00:00')).toBe(false);
    const goal = card.paceBands.find((b) => b.label === 'Goal')!;
    expect(goal.pacePerMi).toBe('8:01');
    expect(card.avgPace).toBe('8:01');
    expect(goal.finishTime).toBe('1:45:00');
    const halfway = card.fiveKCheckpoints.find((c) => c.label === 'Halfway')!;
    expect(goal.halfSplit).toBe(halfway.cumTime);
    expect(card.miles[card.miles.length - 1].label).toBe('13.1');
    expect(card.htmlContent).not.toContain('40K');
  });

  it('L-06: km mode shows per-km rows, /km paces and metres', () => {
    const s = bostonStrategy();
    const card = generateRaceCard({ strategy: s, unit: 'km', mantras: { 20: 'Stay strong' } });
    expect(card.unit).toBe('km');
    expect(card.miles).toHaveLength(43);
    expect(card.miles[0].label).toBe('1');
    expect(card.miles[42].label).toBe('42.2');
    expect(Math.abs(card.miles[42].cumSec - s.milePaces[26].cumulativeTimeSec)).toBeLessThan(1e-6);
    expect(card.htmlContent).toContain('/km');
    expect(card.htmlContent).not.toContain('/mi');
    expect(card.htmlContent).not.toMatch(/\d ft\b/);
    for (const m of card.miles) expect(m.elevation === 'flat' || / m$/.test(m.elevation)).toBe(true);
    expect(card.paceBands[0].pace).toBe(formatPaceForUnit(14400 / 26.2, 'km'));
    expect(card.elevationWarnings.every((w) => w.startsWith('km '))).toBe(true);
    // 20 mi = 32.19 km → the km-33 row
    expect(card.miles[32].mantra).toBe('Stay strong');
    expect(card.mantras).toEqual(['km 32.2: Stay strong']);
  });

  it('L-07: x.5 landmarks land on the next row and several items are joined', () => {
    const s = bostonStrategy();
    const card = generateRaceCard({ strategy: s, marathon: getMarathon('boston') });
    expect(card.miles[20].landmark).toContain('Heartbreak Hill summit'); // 20.5 → mile 21
    const twoItems: RaceStrategy = {
      ...s,
      nutritionPlan: [
        { mile: 0, item: 'Pre-race gel', notes: '', timeSec: -900 },
        { mile: 7.5, item: 'Gel A', notes: '' },
        { mile: 8, item: 'Water B', notes: '' },
      ],
    };
    const c2 = generateRaceCard({ strategy: twoItems });
    expect(c2.miles[7].nutrition).toBe('Gel A · Water B');
    expect(c2.miles[6].nutrition).toBe('');
    expect(c2.miles[0].nutrition).toBe('');
    expect(c2.nutritionSummary).toContain('Before start: Pre-race gel');
  });

  it('escapes every user string in the HTML', () => {
    const s: RaceStrategy = { ...bostonStrategy(), marathonName: 'Evil <img src=x onerror=alert(1)> "Race"' };
    const card = generateRaceCard({
      strategy: s,
      emergencyContact: { name: '<b>Mom</b>', phone: '"555"' },
      mantras: { 3: '<script>x</script>' },
      weatherSummary: '<i>hot</i>',
      notes: "It's <u>fine</u>",
      startInfo: '<em>Wave 2</em>',
    });
    expect(card.htmlContent).not.toMatch(/<img|<script|<b>|<i>|<u>|<em>/);
    expect(card.htmlContent).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

/** Same "h:mm:ss" clock format the card uses. */
function generate5kClock(sec: number): string {
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── v1.0.6: print / download (L-04) ──────────────────────────────────────────

describe('print and download', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll(`iframe[${PRINT_FRAME_ATTR}]`).forEach((f) => f.remove());
  });

  it('prints through a hidden, unsandboxed srcdoc iframe — never window.open', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const card = generateRaceCard({ strategy: makeStrategy() });
    expect(printRaceCard(card)).toBe(true);

    const frame = document.querySelector<HTMLIFrameElement>(`iframe[${PRINT_FRAME_ATTR}]`);
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute('srcdoc')).toBe(card.htmlContent);
    expect(frame!.hasAttribute('sandbox')).toBe(false);
    expect(frame!.getAttribute('aria-hidden')).toBe('true');
    expect(openSpy).not.toHaveBeenCalled();

    const win = frame!.contentWindow!;
    const printSpy = vi.fn();
    Object.defineProperty(win, 'print', { value: printSpy, configurable: true });
    frame!.dispatchEvent(new Event('load'));
    expect(printSpy).toHaveBeenCalledTimes(1);

    win.dispatchEvent(new Event('afterprint'));
    await new Promise((r) => setTimeout(r, 5));
    expect(document.querySelector(`iframe[${PRINT_FRAME_ATTR}]`)).toBeNull();
  });

  it('downloads the HTML with a Blob and an <a download>', () => {
    const create = vi.fn(() => 'blob:apollo-test');
    const revoke = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true, writable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true, writable: true });
    let downloaded = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloaded = this.download;
    });
    downloadRaceCard(generateRaceCard({ strategy: makeStrategy() }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(downloaded).toBe('Test_Marathon_race_card.html');
  });
});
