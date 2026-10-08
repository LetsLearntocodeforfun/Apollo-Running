/**
 * v1.0.6 (A3): FormChip (Today, no recharts) and FitnessFormChart smoke tests,
 * with empty and seeded data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { persistence } from '@/services/db/persistence';
import { storeActivities } from '@/services/analyticsService';
import FormChip from '@/components/fitness/FormChip';
import FitnessFormChart, { fitnessTakeaway } from '@/components/fitness/FitnessFormChart';
import { getFitnessForm } from '@/components/fitness/fitnessData';
import type { Activity } from '@/services/activity/types';
import { addDays } from '@/utils/localDate';

function seedDailyRuns(fromKey: string, days: number): void {
  const acts: Activity[] = [];
  for (let i = 0; i < days; i++) {
    const key = addDays(fromKey, i);
    acts.push({
      id: 5000 + i,
      name: i % 7 === 6 ? 'Long Run' : 'Easy Run',
      type: 'Run',
      sport_type: 'Run',
      distance: i % 7 === 6 ? 25000 : 10000,
      moving_time: i % 7 === 6 ? 8400 : 3300,
      elapsed_time: i % 7 === 6 ? 8400 : 3300,
      start_date: `${key}T13:00:00Z`,
      start_date_local: `${key}T07:00:00Z`,
      kudos_count: 0,
      source: 'intervals',
      source_id: `i${i}`,
    });
  }
  storeActivities(acts);
}

beforeEach(() => {
  persistence.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T12:00:00'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FormChip', () => {
  it('renders an empty state without activities', () => {
    render(<FormChip />);
    expect(screen.getByText(/log a few runs/i)).toBeTruthy();
  });

  it('shows TSB, zone label text and readiness with seeded runs', () => {
    seedDailyRuns('2026-06-01', 120);
    render(<FormChip />);
    const group = screen.getByRole('group');
    expect(group.getAttribute('aria-label')).toMatch(/^Form [+−]?\d+, .+\. Readiness \d+ of 100\.$/);
    expect(screen.getByText('Form')).toBeTruthy();
    expect(screen.getByText(/Readiness/)).toBeTruthy();
  });

  it('does not import recharts (Today first-paint bundle)', () => {
    const src = readFileSync(resolve(__dirname, '../components/fitness/FormChip.tsx'), 'utf8');
    const data = readFileSync(resolve(__dirname, '../components/fitness/fitnessData.ts'), 'utf8');
    expect(src).not.toMatch(/from ['"]recharts['"]/);
    expect(data).not.toMatch(/from ['"]recharts['"]/);
  });
});

describe('FitnessFormChart', () => {
  it('renders an empty message without activities', () => {
    render(<FitnessFormChart raceDate={null} />);
    expect(screen.getByText(/No training load yet/)).toBeTruthy();
  });

  it('renders a figure with a takeaway caption and a table alternative', () => {
    seedDailyRuns('2026-05-01', 150);
    render(<FitnessFormChart raceDate="2026-11-01" />);
    const caption = document.querySelector('figcaption');
    expect(caption?.textContent).toMatch(/Form [+−]?\d+ \(.+\) today/);
    expect(caption?.textContent).toMatch(/Race day projects to/);
    const toggle = screen.getByRole('button', { name: 'View as table' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByText(/projected/).length).toBeGreaterThan(0);
    expect(screen.getByText(/differ from intervals.icu/)).toBeTruthy();
  });

  it('pads the series to today and projects to race day', () => {
    seedDailyRuns('2026-05-01', 120); // last run 2026-08-28
    const data = getFitnessForm({ raceDate: '2026-10-20', today: '2026-10-07' });
    const pts = data.pmc.dataPoints;
    expect(pts[pts.length - 1].date).toBe('2026-10-07');
    expect(data.pmc.projection[data.pmc.projection.length - 1].date).toBe('2026-10-20');
    expect(data.daysToRace).toBe(13);
    expect(fitnessTakeaway(data)).toMatch(/Race day projects to/);
  });
});
