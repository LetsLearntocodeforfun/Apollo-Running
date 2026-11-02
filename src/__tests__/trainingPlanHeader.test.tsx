/**
 * v1.0.9 Plan page header and export (src/pages/Training.tsx):
 *  - a block without a race day shows when it ends, never a race day — not even the
 *    athlete's My Race date (that stays on Today and in the Race Day hub);
 *  - a marathon plan still shows its race day;
 *  - an imported plan says it was imported and isn't verified by Apollo;
 *  - "Export plan" writes the plan itself, not this instance of it, so the file
 *    re-imports even when the race was placed on a Saturday (the placed copy would
 *    put the marathon on day 6, which Apollo refuses on import).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getPlanById, type TrainingPlan } from '../data/plans';
import { startPlan } from '../services/planProgress';
import { getEffectivePlan, skipWorkout } from '../services/planOverlay';
import { setMyRace } from '../services/myRace';
import { importAndSavePlanText, parseApolloPlanJson, serializePlanToJson } from '../services/planImportExport';
import { formatMediumDate } from '../components/plan/planDisplay';
import Training from '../pages/Training';

const downloads = vi.hoisted(() => ({ plans: [] as unknown[] }));

// Keep the page test focused: no maps, no intervals.icu calendar widgets, no calendar push.
vi.mock('../components/RouteMap', () => ({ RouteMapThumbnail: () => null, default: () => null }));
vi.mock('../components/PlanCalendarPush', () => ({ default: () => null }));
vi.mock('../components/PlanCalendarExport', () => ({ default: () => null }));
vi.mock('../services/planCalendarSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/planCalendarSync')>()),
  syncPlanCalendarIfChanged: vi.fn(async () => undefined),
}));
// Capture what "Export plan" would download.
vi.mock('../services/planImportExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/planImportExport')>()),
  downloadPlanJson: (plan: unknown) => {
    downloads.plans.push(plan);
  },
}));

const TODAY = '2026-11-04'; // a Wednesday in week 1 of a plan started Monday 2026-11-02
const START = '2026-11-02';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/plan']}>
      <Training />
    </MemoryRouter>,
  );
}

/** The header line under the plan name: attribution · start · race day / block end · week. */
function headerLine(): string {
  return document.getElementById('plan-header-title')?.nextElementSibling?.textContent ?? '';
}

beforeEach(() => {
  downloads.plans = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 4, 9, 0, 0));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Plan page header', () => {
  it('a block shows when it ends — no race day, even with a My Race date', () => {
    setMyRace({ date: '2027-04-25' });
    startPlan({ planId: 'apollo-base-8', startDate: START }, TODAY);
    renderPage();
    const line = headerLine();
    expect(line).toContain('Designed by Apollo Coaching Lab');
    expect(line).toContain(`Week 1 began ${formatMediumDate(START)}`);
    expect(line).toContain(`Block ends ${formatMediumDate('2026-12-27')}`);
    expect(line).toContain('Week 1 of 8');
    expect(line).not.toMatch(/Race day/);
    expect(line).not.toContain(formatMediumDate('2027-04-25'));
  });

  it('a marathon plan shows its race day', () => {
    setMyRace({ date: '2027-05-02' });
    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2027-04-25' }, TODAY);
    renderPage();
    const line = headerLine();
    expect(line).toContain(`Race day ${formatMediumDate('2027-04-25')}`);
    expect(line).not.toMatch(/Block ends/);
  });

  it('an imported plan says it was imported and isn’t verified by Apollo', () => {
    const rest = { type: 'rest', label: 'Rest' };
    const run = (mi: number) => ({ type: 'run', label: `${mi} mi easy`, distanceMi: mi, note: 'Easy' });
    const res = importAndSavePlanText(
      JSON.stringify({
        name: 'Club Build',
        author: 'Hal Higdon',
        weeks: [{ days: [rest, run(4), run(5), run(4), rest, run(3), run(8)] }],
        attribution: { coach: 'Hal Higdon', fidelity: 'published-schedule', note: 'Official.', sources: [] },
      }),
    );
    if (!res.ok) throw new Error(res.error);
    startPlan({ planId: res.plan.id, startDate: START }, TODAY);
    renderPage();
    const line = headerLine();
    expect(line).toContain('Imported, not verified by Apollo · author listed as “Hal Higdon”');
    expect(line).not.toMatch(/Inspired by|published schedule/);
  });
});

describe('Export plan on the Plan page', () => {
  it('exports the plan itself, so the file re-imports even for a Saturday race', () => {
    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2027-04-24' }, TODAY); // a Saturday
    expect(skipWorkout({ weekIndex: 0, dayIndex: 1 }).ok).toBe(true);
    // The placed copy moves the race to Saturday — a file Apollo would refuse.
    const placed = getEffectivePlan()!;
    const placedImport = parseApolloPlanJson(serializePlanToJson(placed));
    expect(placedImport.ok).toBe(false);

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Export plan' }));
    expect(downloads.plans).toHaveLength(1);
    const file = downloads.plans[0] as TrainingPlan;
    expect(file).toBe(getPlanById('hal-higdon-novice-1'));
    expect(file.weeks[0].days[1].skipped).toBeUndefined();
    expect(parseApolloPlanJson(serializePlanToJson(file)).ok).toBe(true);
  });
});
