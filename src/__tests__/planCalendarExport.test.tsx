/**
 * RTL smoke tests for PlanCalendarExport (.ics download card).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PlanCalendarExport from '@/components/PlanCalendarExport';
import { BUILT_IN_PLANS } from '@/data/plans';
import { setActivePlan } from '@/services/planProgress';
import { persistence } from '@/services/db/persistence';
import { addDays, todayKey, mondayOf } from '@/utils/localDate';

const connection = vi.hoisted(() => ({ connected: false }));
vi.mock('@/services/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/storage')>()),
  getIntervalsCredentials: () => (connection.connected ? { apiKey: 'k', athleteId: 'i1' } : null),
}));

const plan = BUILT_IN_PLANS[0];

let createObjectURL: ReturnType<typeof vi.fn>;
let clickSpy: ReturnType<typeof vi.spyOn>;
let downloaded: { name: string; blob: Blob | null }[];

beforeEach(() => {
  downloaded = [];
  let lastBlob: Blob | null = null;
  createObjectURL = vi.fn((blob: Blob) => { lastBlob = blob; return 'blob:test'; });
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true, writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true, writable: true });
  clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloaded.push({ name: this.download, blob: lastBlob });
  });
});

afterEach(() => {
  clickSpy.mockRestore();
});

function startPlanThisWeek(): string {
  const start = mondayOf(addDays(todayKey(), -14));
  setActivePlan({ planId: plan.id, startDate: start });
  return start;
}

describe('PlanCalendarExport', () => {
  it('renders an empty state without an active plan', () => {
    render(<PlanCalendarExport />);
    expect(screen.getByRole('heading', { name: /add your plan to your calendar/i })).toBeTruthy();
    expect(screen.getByText('No active plan')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /download \.ics/i })).toBeNull();
  });

  it('shows the plan, both toggles and downloads an .ics file', async () => {
    startPlanThisWeek();
    render(<PlanCalendarExport />);
    expect(screen.getByText(new RegExp(plan.name))).toBeTruthy();
    const rest = screen.getByRole('checkbox', { name: /include rest days/i }) as HTMLInputElement;
    const fromToday = screen.getByRole('checkbox', { name: /from today only/i }) as HTMLInputElement;
    expect(rest.checked).toBe(false);
    expect(fromToday.checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /download \.ics/i }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0].name).toMatch(/_training\.ics$/);
    expect(screen.getByRole('status').textContent).toMatch(/Downloaded \d+ events?/);

    const text = await downloaded[0].blob!.text();
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    const starts = [...text.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map((m) => m[1]);
    const today = todayKey().replace(/-/g, '');
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((d) => d >= today)).toBe(true);
  });

  it('includes past days and rest days when the toggles change', async () => {
    const start = startPlanThisWeek();
    render(<PlanCalendarExport />);
    fireEvent.click(screen.getByRole('checkbox', { name: /from today only/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /include rest days/i }));
    fireEvent.click(screen.getByRole('button', { name: /download \.ics/i }));
    const text = await downloaded[0].blob!.text();
    expect(text).toContain(`DTSTART;VALUE=DATE:${start.replace(/-/g, '')}`);
    expect(text).toContain('SUMMARY:Rest day');
  });

  it('writes km distances for km users', async () => {
    persistence.setItem('apollo_distance_unit', 'km');
    startPlanThisWeek();
    render(<PlanCalendarExport />);
    expect(screen.getByText(/distances in km/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /download \.ics/i }));
    const text = (await downloaded[0].blob!.text()).replace(/\r\n /g, '');
    expect(text).toMatch(/SUMMARY:[^\r\n]* km/);
    expect(text).not.toMatch(/SUMMARY:[^\r\n]* mi\b/);
  });

  it('hints at the intervals.icu push only when intervals.icu is connected', () => {
    startPlanThisWeek();
    connection.connected = false;
    const { unmount } = render(<PlanCalendarExport />);
    expect(screen.queryByText(/intervals\.icu is connected/i)).toBeNull();
    unmount();
    connection.connected = true;
    try {
      render(<PlanCalendarExport />);
      expect(screen.getByText(/intervals\.icu is connected/i)).toBeTruthy();
    } finally {
      connection.connected = false;
    }
  });

  it('explains when nothing is left to export from today', () => {
    // A plan that ended long ago.
    setActivePlan({ planId: plan.id, startDate: '2020-01-06' });
    render(<PlanCalendarExport />);
    fireEvent.click(screen.getByRole('button', { name: /download \.ics/i }));
    expect(downloaded).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/from today/i);
  });
});
