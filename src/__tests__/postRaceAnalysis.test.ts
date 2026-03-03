/**
 * Tests for Post-Race Analysis Service
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  analyzeRace,
  getAllReports,
  getReportById,
  getReportsForStrategy,
  updateLessonsLearned,
  deleteReport,
  type ActualMileSplit,
} from '@/services/postRaceAnalysis';
import type { RaceStrategy } from '@/types/raceStrategy';
import { persistence } from '@/services/db/persistence';

beforeEach(() => {
  persistence.removeItem('apollo_post_race_reports');
});

// ── Test Fixtures ─────────────────────────────────────────────────────────────

function makeStrategy(targetTimeSec: number): RaceStrategy {
  const avgPace = targetTimeSec / 26.2;
  const milePaces = Array.from({ length: 26 }, (_, i) => {
    const mile = i + 1;
    const cumSec = avgPace * mile;
    return {
      mile,
      targetPaceSec: Math.round(avgPace),
      targetPaceFormatted: formatPace(avgPace),
      cumulativeTimeSec: Math.round(cumSec),
      cumulativeTimeFormatted: formatTime(cumSec),
      elevationChangeFt: 0,
      notes: '',
    };
  });

  return {
    id: 'test-strategy',
    name: 'Test Strategy',
    marathonId: 'test-marathon',
    marathonName: 'Test Marathon',
    targetTimeSec,
    targetTimeFormatted: formatTime(targetTimeSec),
    pacingStrategy: 'even-split',
    milePaces,
    nutritionPlan: [],
    firstHalfSec: Math.round(avgPace * 13),
    secondHalfSec: Math.round(avgPace * 13.2),
    avgPaceSec: Math.round(avgPace),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes: '',
  };
}

function makeEvenSplits(pacePerMi: number): ActualMileSplit[] {
  return Array.from({ length: 26 }, (_, i) => ({
    mile: i + 1,
    paceSec: pacePerMi,
  }));
}

function makePositiveSplits(startPace: number, fadePerMile: number): ActualMileSplit[] {
  return Array.from({ length: 26 }, (_, i) => ({
    mile: i + 1,
    paceSec: Math.round(startPace + (i > 13 ? fadePerMile * (i - 13) : 0)),
  }));
}

function makeNegativeSplits(startPace: number, dropPerMile: number): ActualMileSplit[] {
  return Array.from({ length: 26 }, (_, i) => ({
    mile: i + 1,
    paceSec: Math.round(startPace - (i > 13 ? dropPerMile * (i - 13) : 0)),
  }));
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

// ── Race Analysis ─────────────────────────────────────────────────────────────

describe('analyzeRace', () => {
  const strategy = makeStrategy(12600); // 3:30:00 → ~481 sec/mi
  const targetPace = Math.round(12600 / 26.2);

  it('should generate a report for even pacing', () => {
    const splits = makeEvenSplits(targetPace);
    const report = analyzeRace(strategy, splits, '2026-10-11');

    expect(report.id).toBeTruthy();
    expect(report.strategyId).toBe('test-strategy');
    expect(report.marathonName).toBe('Test Marathon');
    expect(report.raceDate).toBe('2026-10-11');
    expect(report.mileComparisons.length).toBe(26);
  });

  it('should calculate finish time correctly', () => {
    const splits = makeEvenSplits(targetPace);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    expect(report.actualFinishSec).toBe(targetPace * 26);
    expect(report.actualFinishFormatted).toMatch(/^\d+:\d{2}:\d{2}$/);
  });

  it('should detect on-target pacing', () => {
    const splits = makeEvenSplits(targetPace);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    const onTarget = report.mileComparisons.filter((m) => m.verdict === 'on_target');
    expect(onTarget.length).toBe(26);
  });

  it('should detect positive splits', () => {
    const splits = makePositiveSplits(targetPace - 15, 3);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    expect(report.splitAnalysis.splitType).toBe('positive');
    expect(report.splitAnalysis.actualSplitDiff).toBeGreaterThan(0);
  });

  it('should detect negative splits', () => {
    const splits = makeNegativeSplits(targetPace + 10, 2);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    expect(report.splitAnalysis.splitType).toBe('negative');
  });

  it('should assign a grade', () => {
    const splits = makeEvenSplits(targetPace);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    const validGrades = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'D', 'F'];
    expect(validGrades).toContain(report.grade);
  });

  it('should give a high grade for perfect pacing', () => {
    const splits = makeEvenSplits(targetPace);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    expect(['A+', 'A', 'A-']).toContain(report.grade);
  });

  it('should give a lower grade for going out too fast and fading', () => {
    const splits = makePositiveSplits(targetPace - 30, 5);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    const topGrades = ['A+', 'A', 'A-', 'B+'];
    expect(topGrades).not.toContain(report.grade);
  });

  it('should generate insights', () => {
    const splits = makeEvenSplits(targetPace);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    expect(report.insights.length).toBeGreaterThan(0);
  });

  it('should generate segments for 5-mile blocks', () => {
    const splits = makeEvenSplits(targetPace);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    expect(report.segments.length).toBe(5);
    expect(report.segments[0].label).toBe('Miles 1-5');
    expect(report.segments[4].label).toBe('Miles 21-26.2');
  });

  it('should persist the report', () => {
    const splits = makeEvenSplits(targetPace);
    analyzeRace(strategy, splits, '2026-10-11');
    expect(getAllReports().length).toBe(1);
  });

  it('should include lessons learned if provided', () => {
    const splits = makeEvenSplits(targetPace);
    const report = analyzeRace(strategy, splits, '2026-10-11', 'Start slower next time');
    expect(report.lessonsLearned).toBe('Start slower next time');
  });

  it('should detect early-mile fast starts in insights', () => {
    const splits = makePositiveSplits(targetPace - 25, 4);
    const report = analyzeRace(strategy, splits, '2026-10-11');
    const hasFastStart = report.insights.some((i) => i.toLowerCase().includes('first') || i.toLowerCase().includes('fast'));
    expect(hasFastStart).toBe(true);
  });
});

// ── Report Management ─────────────────────────────────────────────────────────

describe('Report CRUD', () => {
  const strategy = makeStrategy(12600);
  const splits = makeEvenSplits(Math.round(12600 / 26.2));

  it('should retrieve a report by ID', () => {
    const report = analyzeRace(strategy, splits, '2026-10-11');
    const found = getReportById(report.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(report.id);
  });

  it('should return undefined for unknown ID', () => {
    expect(getReportById('nonexistent')).toBeUndefined();
  });

  it('should filter reports by strategy', () => {
    analyzeRace(strategy, splits, '2026-10-11');
    const reports = getReportsForStrategy('test-strategy');
    expect(reports.length).toBe(1);
  });

  it('should update lessons learned', () => {
    const report = analyzeRace(strategy, splits, '2026-10-11');
    updateLessonsLearned(report.id, 'Learned a lot!');

    const updated = getReportById(report.id)!;
    expect(updated.lessonsLearned).toBe('Learned a lot!');
  });

  it('should delete a report', () => {
    const report = analyzeRace(strategy, splits, '2026-10-11');
    expect(deleteReport(report.id)).toBe(true);
    expect(getAllReports().length).toBe(0);
  });

  it('should return false when deleting nonexistent report', () => {
    expect(deleteReport('bad')).toBe(false);
  });
});
