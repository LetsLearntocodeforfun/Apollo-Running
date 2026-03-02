/**
 * Tests for ghostRunner.ts — Ghost Runner Comparison
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  compareRuns,
  buildGhostRun,
  getGhostMessageAtMile,
  saveGhostComparison,
  getGhostHistory,
} from '@/services/ghostRunner';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.clear();
});

describe('buildGhostRun', () => {
  it('should build a GhostRun from split data', () => {
    const paces = [480, 475, 478, 482, 485];
    const run = buildGhostRun(100, '2025-01-10', 'Easy 5', paces);
    expect(run.splits.length).toBe(5);
    expect(run.distanceMi).toBe(5);
    expect(run.totalTimeSec).toBe(480 + 475 + 478 + 482 + 485);
    expect(run.splits[0].mile).toBe(1);
    expect(run.splits[4].mile).toBe(5);
  });

  it('should calculate cumulative elapsed times', () => {
    const paces = [480, 480, 480];
    const run = buildGhostRun(100, '2025-01-10', 'Run', paces);
    expect(run.splits[0].elapsedSec).toBe(480);
    expect(run.splits[1].elapsedSec).toBe(960);
    expect(run.splits[2].elapsedSec).toBe(1440);
  });
});

describe('compareRuns', () => {
  it('should compare two runs mile by mile', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [480, 482, 485, 490, 495]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Last week', [490, 488, 485, 488, 490]);
    const comparison = compareRuns(current, ghost);

    expect(comparison.milesCompared).toBe(5);
    expect(comparison.miles.length).toBe(5);
  });

  it('should show positive delta when current is slower', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [500, 500, 500]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Past', [480, 480, 480]);
    const comparison = compareRuns(current, ghost);

    expect(comparison.totalDeltaSec).toBeGreaterThan(0); // current is slower
    for (const m of comparison.miles) {
      expect(m.deltaSec).toBe(20); // 500 - 480
    }
  });

  it('should show negative delta when current is faster', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [460, 460, 460]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Past', [480, 480, 480]);
    const comparison = compareRuns(current, ghost);

    expect(comparison.totalDeltaSec).toBeLessThan(0); // current is faster
  });

  it('should calculate cumulative delta correctly', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [490, 480, 470]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Past', [480, 480, 480]);
    const comparison = compareRuns(current, ghost);

    expect(comparison.miles[0].cumulativeDeltaSec).toBe(10);  // +10
    expect(comparison.miles[1].cumulativeDeltaSec).toBe(10);  // +10 + 0
    expect(comparison.miles[2].cumulativeDeltaSec).toBe(0);   // +10 + 0 - 10
  });

  it('should compare up to the shorter run', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [480, 480, 480, 480, 480]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Past', [480, 480, 480]);
    const comparison = compareRuns(current, ghost);

    expect(comparison.milesCompared).toBe(3);
    expect(comparison.miles.length).toBe(3);
  });

  it('should include a summary', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [470, 475, 480]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Past', [480, 480, 480]);
    const comparison = compareRuns(current, ghost);

    expect(comparison.summary).toBeTruthy();
    expect(comparison.summary.length).toBeGreaterThan(20);
  });
});

describe('getGhostMessageAtMile', () => {
  it('should describe the delta at a specific mile', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [470, 475, 480]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Past', [480, 480, 480]);
    const comparison = compareRuns(current, ghost);

    const msg = getGhostMessageAtMile(comparison, 2);
    expect(msg).toContain('mile 2');
    expect(msg).toContain('ahead');
  });

  it('should return empty string for invalid mile', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [480]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Past', [480]);
    const comparison = compareRuns(current, ghost);

    expect(getGhostMessageAtMile(comparison, 5)).toBe('');
  });
});

describe('saveGhostComparison & getGhostHistory', () => {
  it('should persist and retrieve comparisons', () => {
    const current = buildGhostRun(101, '2025-01-20', 'Today', [480]);
    const ghost = buildGhostRun(100, '2025-01-10', 'Past', [480]);
    const comparison = compareRuns(current, ghost);

    saveGhostComparison(comparison);
    const history = getGhostHistory();
    expect(history.length).toBe(1);
  });
});
