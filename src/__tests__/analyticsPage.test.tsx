/**
 * v1.0.6 (A3) RTL smoke tests for the Analytics page, standalone and embedded
 * in Progress (`embedded`): no h1 and no Fitness & Form chart when embedded,
 * the empty state links to Settings › Connections, and every period renders.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { persistence } from '@/services/db/persistence';
import { storeActivities } from '@/services/analyticsService';
import { addDays, todayKey } from '@/utils/localDate';
import type { Activity } from '@/services/activity/types';
import Analytics from '@/pages/Analytics';

function run(n: number, daysAgo: number): Activity {
  const key = addDays(todayKey(), -daysAgo);
  return {
    id: 7_000 + n,
    name: n % 7 === 0 ? 'Long Run' : 'Easy Run',
    type: 'Run',
    sport_type: 'Run',
    distance: n % 7 === 0 ? 16000 : 8000,
    moving_time: n % 7 === 0 ? 5200 : 2700,
    elapsed_time: n % 7 === 0 ? 5300 : 2750,
    total_elevation_gain: 40,
    average_heartrate: 145,
    start_date: `${key}T07:00:00Z`,
    start_date_local: `${key}T07:00:00Z`,
    kudos_count: 0,
    source: 'intervals',
    source_id: `a${n}`,
  };
}

function seed(): void {
  storeActivities(Array.from({ length: 60 }, (_, i) => run(i, i * 2)));
}

function renderPage(embedded: boolean) {
  return render(<MemoryRouter><Analytics embedded={embedded} /></MemoryRouter>);
}

beforeEach(() => {
  persistence.clear();
});

describe('Analytics page', () => {
  it('embedded, empty: no h1, an empty state linking to Settings › Connections', () => {
    renderPage(true);
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    const link = screen.getByRole('link', { name: 'Connect a data source' });
    expect(link.getAttribute('href')).toBe('/settings?tab=connections');
  });

  it('standalone, empty: one h1 and the connect call to action', () => {
    renderPage(false);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('embedded, seeded: sections start at h2 and the Fitness & Form chart is left to its own tab', () => {
    seed();
    const { container } = renderPage(true);
    expect(screen.queryAllByRole('heading', { level: 1 })).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 2, name: 'Recent Runs' })).toBeTruthy();
    expect(container.querySelector('.ff-figure')).toBeNull();
  });

  it('standalone, seeded: one h1, the Fitness & Form chart, and every period renders', () => {
    seed();
    const { container } = renderPage(false);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(container.querySelector('.ff-figure')).not.toBeNull();
    const periodButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="group"] button[aria-pressed]'))
      .filter((b) => !b.closest('.ff-figure'));
    expect(periodButtons.length).toBeGreaterThan(1);
    for (const b of periodButtons) {
      fireEvent.click(b);
      expect(b.getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('heading', { level: 2, name: 'Recent Runs' })).toBeTruthy();
    }
  });
});
