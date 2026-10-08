/**
 * Today v2 (Dashboard) — RTL smoke tests for every journey phase, the inline
 * actions, the B13 daily-recap regression and a static "no recharts on Today"
 * import-graph guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Dashboard from '../pages/Dashboard';
import { persistence } from '../services/db/persistence';
import { getActivePlan, getDateKeyForDay, isDayCompleted, startPlan } from '../services/planProgress';
import { getEffectiveDay, getEffectivePlan } from '../services/planOverlay';
import TodayWorkout from '../components/today/TodayWorkout';
import { getJourneyState, type JourneyState } from '../services/journey';
import { storeActivities } from '../services/analyticsService';
import { isDailyRecapDue } from '../services/coachingPreferences';
import { setDistanceUnit } from '../services/unitPreferences';
import { isWorkoutDay, workoutTitle } from '../components/plan/planDisplay';
import {
  countdownText,
  formatPaceRangeSecPerMi,
  journeyHeaderParts,
  predictionRangeText,
} from '../components/today/todayModel';
import type { RacePrediction } from '../services/racePrediction';
import { addDays, todayKey } from '../utils/localDate';

const PLAN_ID = 'hal-higdon-novice-1';

function renderToday() {
  return render(
    <MemoryRouter>
      <Dashboard />
    </MemoryRouter>,
  );
}

type StoredActivity = Parameters<typeof storeActivities>[0][number];

function seedRun(dateKey: string): void {
  const run = {
    id: 990001,
    name: 'Morning Run',
    type: 'Run',
    sport_type: 'Run',
    distance: 4828,
    moving_time: 1800,
    elapsed_time: 1850,
    total_elevation_gain: 12,
    average_speed: 2.68,
    start_date: `${dateKey}T13:00:00Z`,
    start_date_local: `${dateKey}T06:00:00Z`,
    source: 'file',
  } as unknown as StoredActivity;
  storeActivities([run]);
}

beforeEach(() => {
  persistence.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 7, 9)); // Wed Oct 7 2026, 09:00 local
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('todayModel helpers', () => {
  it('countdown copy', () => {
    expect(countdownText(0)).toBe('Race day!');
    expect(countdownText(1)).toBe('1 day to race');
    expect(countdownText(47)).toBe('47 days to race');
    expect(countdownText(-1)).toBeNull();
    expect(countdownText(null)).toBeNull();
  });

  it('journey header skips unknown parts', () => {
    const base: JourneyState = {
      phase: 'training', planId: 'p', planName: 'P', raceDate: '2026-11-22', daysToRace: 46,
      weekIndex: 8, dayIndex: 2, totalWeeks: 18, trainingPhase: 'build',
    };
    expect(journeyHeaderParts(base)).toEqual(['Week 9 of 18', 'Build', '46 days to race']);
    expect(journeyHeaderParts({ ...base, weekIndex: null, trainingPhase: null })).toEqual(['46 days to race']);
    expect(journeyHeaderParts({ ...base, weekIndex: null, daysToRace: null, raceDate: null })).toEqual([]);
  });

  it('pace ranges are unit-aware (no hard-coded /mi)', () => {
    setDistanceUnit('mi');
    expect(formatPaceRangeSecPerMi(425, 435)).toBe('7:05–7:15/mi');
    setDistanceUnit('km');
    expect(formatPaceRangeSecPerMi(425, 435)).toBe('4:24–4:30/km');
  });

  it('prediction range as h:mm–h:mm', () => {
    const p = { marathonTimeSec: 12100, marathonTimeFormatted: '3:21:40', rangeLowSec: 11880, rangeHighSec: 12360 } as RacePrediction;
    expect(predictionRangeText(p)).toBe('3:18–3:26');
  });
});

describe('Today screen', () => {
  it('no plan and no data: no-plan CTA, one h1, no crash', () => {
    renderToday();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const cta = screen.getByRole('link', { name: 'Pick a training plan' });
    expect(cta.getAttribute('href')).toBe('/plan');
    const profile = screen.getByRole('link', { name: /Add a recent race in Settings › Athlete Profile/ });
    expect(profile.getAttribute('href')).toBe('/settings?tab=profile');
    expect(screen.queryByText(/Week \d+ of/)).toBeNull();
  });

  it('training phase: header, workout title and Mark done / Skip actions', () => {
    startPlan({ planId: PLAN_ID, raceDate: '2026-12-13' });
    const journey = getJourneyState();
    expect(journey.phase).toBe('training');
    const w = journey.weekIndex!;
    const d = journey.dayIndex!;
    const day = getEffectiveDay({ weekIndex: w, dayIndex: d });
    expect(isWorkoutDay(day)).toBe(true);

    renderToday();
    expect(screen.getByText(`Week ${w + 1} of ${journey.totalWeeks}`)).toBeTruthy();
    expect(screen.getByText(`${journey.daysToRace} days to race`)).toBeTruthy();
    const title = screen.getByRole('heading', { level: 2, name: new RegExp(workoutTitle(day!)) });
    expect(title).toBeTruthy();
    // No race result or goal yet → paces CTA instead of a target.
    expect(screen.getByRole('link', { name: /for personal paces/ }).getAttribute('href')).toBe('/settings?tab=profile');

    fireEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(isDayCompleted(PLAN_ID, w, d)).toBe(true);
    const done = screen.getByRole('button', { name: /Done/ });
    expect(done.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Marked as done. Nice work!')).toBeTruthy();

    fireEvent.click(done);
    expect(isDayCompleted(PLAN_ID, w, d)).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(getEffectiveDay({ weekIndex: w, dayIndex: d })?.skipped).toBe(true);
    expect(screen.getByRole('heading', { level: 2, name: 'Workout skipped' })).toBeTruthy();
    expect(screen.getByText(/Workout skipped\. You can restore it/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Restore workout' }));
    expect(getEffectiveDay({ weekIndex: w, dayIndex: d })?.skipped).toBeFalsy();
  });

  it('S4: Mark done is disabled, with a visible reason, on a future day', () => {
    startPlan({ planId: PLAN_ID, raceDate: '2026-12-13' });
    const active = getActivePlan()!;
    const plan = getEffectivePlan()!;
    const journey = getJourneyState();
    // First workout day after today.
    let w = journey.weekIndex!;
    let d = journey.dayIndex!;
    for (let i = 0; i < 14; i++) {
      d += 1;
      if (d > 6) { w += 1; d = 0; }
      if (isWorkoutDay(plan.weeks[w]?.days[d])) break;
    }
    render(
      <MemoryRouter>
        <TodayWorkout
          plan={plan} planId={PLAN_ID} weekIndex={w} dayIndex={d}
          dateKey={getDateKeyForDay(active.startDate, w, d)} startDate={active.startDate}
          headingLevel={2} completed={false} syncMeta={null} vdot={null}
        />
      </MemoryRouter>,
    );
    const btn = screen.getByRole('button', { name: 'Mark done' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const hint = screen.getByText('You can mark this workout done on or after its day.');
    expect(btn.getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.click(btn);
    expect(isDayCompleted(PLAN_ID, w, d)).toBe(false);
  });

  it('shows personal pace targets once a recent race is known', () => {
    persistence.setItem('apollo_athlete_profile', JSON.stringify({
      recentRace: { distanceM: 10000, timeSec: 2700, date: '2026-09-20' },
    }));
    startPlan({ planId: PLAN_ID, raceDate: '2026-12-13' });
    renderToday();
    expect(screen.getByText('Target pace')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /for personal paces/ })).toBeNull();
  });

  it('race week: countdown and race-week checklist link', () => {
    startPlan({ planId: PLAN_ID, raceDate: addDays(todayKey(), 3) });
    expect(getJourneyState().phase).toBe('race-week');
    renderToday();
    expect(screen.getByText('3 days to race')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Race week checklist' });
    expect(link.getAttribute('href')).toBe('/race?tab=race-week');
  });

  it('race day: race morning plan link', () => {
    startPlan({ planId: PLAN_ID, raceDate: todayKey() });
    expect(getJourneyState().phase).toBe('race-day');
    renderToday();
    expect(screen.getByRole('link', { name: 'Race morning plan' }).getAttribute('href')).toBe('/race?tab=race-morning');
  });

  it('B13: file-import users (not connected) get the daily recap, marked seen only on dismiss', () => {
    vi.setSystemTime(new Date(2026, 9, 7, 21)); // after the default 20:00 recap time
    seedRun('2026-10-06');
    startPlan({ planId: PLAN_ID, raceDate: '2026-12-13' });
    expect(isDailyRecapDue()).toBe(true);

    renderToday();
    expect(screen.getByRole('heading', { level: 2, name: /Daily recap/ })).toBeTruthy();
    // Rendering alone must not mark it as shown.
    expect(isDailyRecapDue()).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss daily recap' }));
    expect(screen.queryByRole('heading', { level: 2, name: /Daily recap/ })).toBeNull();
    expect(isDailyRecapDue()).toBe(false);
  });
});

// ── Static guard: nothing reachable from Today may import recharts ──────────

const SRC = resolve(__dirname, '..');
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function resolveModule(fromFile: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(SRC, spec.slice(2)) : resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.(ts|tsx)$/.test(candidate)) return candidate;
  }
  return null;
}

function rechartsOffenders(entry: string): string[] {
  const seen = new Set<string>();
  const offenders: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec) continue;
      if (spec === 'recharts' || spec.startsWith('recharts/')) offenders.push(file);
      else if (spec.startsWith('.') || spec.startsWith('@/')) {
        const next = resolveModule(file, spec);
        if (next) queue.push(next);
      }
    }
  }
  return offenders;
}

describe('Today bundle guard', () => {
  it('Today files never mention recharts', () => {
    const todayDir = join(SRC, 'components', 'today');
    const files = [
      join(SRC, 'pages', 'Dashboard.tsx'),
      join(SRC, 'components', 'RecoveryCard.tsx'),
      ...readdirSync(todayDir).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => join(todayDir, f)),
    ];
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain('recharts');
  });

  it('no module reachable from the Today page imports recharts', () => {
    expect(rechartsOffenders(join(SRC, 'pages', 'Dashboard.tsx'))).toEqual([]);
  });
});
