/**
 * v1.0.7 follow-ups:
 *  - L-11: measured time in zone from intervals.icu HR streams, kept through
 *    sync rebuilds, and the daily recap labels estimated zones honestly.
 *  - T-2: a refused adaptive undo shows a short reason on the card.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { persistence } from '@/services/db/persistence';
import { getIntervalsActivityDetail, mapIntervalsActivity } from '@/services/intervals';
import {
  buildHRDataFromActivity,
  getHRHistory,
  getMeasuredTimeInZones,
  recordMeasuredTimeInZones,
  setHRProfile,
  upsertActivityHR,
} from '@/services/heartRate';
import { generateDailyRecap } from '@/services/dailyRecap';
import {
  setActivePlan,
  setDayCompleted,
  setSyncMeta,
  formatDateKey,
  getDateForDay,
  startPlan,
} from '@/services/planProgress';
import { scaleWeek } from '@/services/planOverlay';
import { applyRecommendation, undoRecommendationWithReason, UNDO_BLOCKED_MESSAGE } from '@/services/adaptiveTraining';
import AdaptiveRecommendations from '@/components/AdaptiveRecommendations';
import { getPlanById } from '@/data/plans';

const CREDS = { apiKey: 'k', athleteId: 'i42' };

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

beforeEach(() => {
  persistence.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('measured time in zone (L-11)', () => {
  it('fetching an intervals.icu run detail stores measured zones from its HR stream', async () => {
    setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
    const time = Array.from({ length: 501 }, (_, i) => i * 5); // 0..2500 s
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith('/streams.json')) {
          return jsonResponse([
            { type: 'time', data: time },
            { type: 'distance', data: time.map((t) => t * 4) },
            // First half at 150 bpm (Z3: 140-160), second half at 170 (Z4: 160-180).
            { type: 'heartrate', data: time.map((t) => (t < 1250 ? 150 : 170)) },
          ]);
        }
        if (url.pathname.endsWith('/map')) return jsonResponse(null);
        return jsonResponse({
          id: 'i7',
          type: 'Run',
          start_date_local: '2026-10-06T07:00:00',
          distance: 10000,
          moving_time: 2500,
          average_heartrate: 160,
        });
      }),
    );
    const base = {
      ...mapIntervalsActivity({
        id: 'i7',
        type: 'Run',
        start_date_local: '2026-10-06T07:00:00',
        distance: 10000,
        moving_time: 2500,
      })!,
      id: 777,
    };
    await getIntervalsActivityDetail(base, CREDS);

    const rec = getHRHistory().find((h) => h.activityId === 777)!;
    expect(rec.zoneSource).toBe('measured');
    expect(rec.date).toBe('2026-10-06');
    expect(rec.timeInZones).toEqual([0, 0, 1250, 1250, 0]);
    expect(getMeasuredTimeInZones(777)).toEqual([0, 0, 1250, 1250, 0]);
  });

  it('a later sync rebuild passes the measured zones through (autoSync path)', () => {
    setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
    recordMeasuredTimeInZones(5, '2026-10-06', [
      { t: 0, hr: 125 },
      { t: 30, hr: 125 },
      { t: 60, hr: 125 },
    ]);
    // autoSync calls buildHRDataFromActivity(..., getMeasuredTimeInZones(activity.id)).
    const rebuilt = buildHRDataFromActivity(
      5,
      '2026-10-06',
      150,
      170,
      3600,
      undefined,
      'intervals',
      getMeasuredTimeInZones(5),
    )!;
    expect(rebuilt.zoneSource).toBe('measured');
    expect(rebuilt.timeInZones).toEqual([0, 60, 0, 0, 0]);
    expect(getMeasuredTimeInZones(6)).toBeNull();
  });
});

describe('daily recap labels estimated zones (L-11)', () => {
  const PLAN_ID = 'hal-higdon-novice-1';
  const START = '2026-01-05';

  function syncFirstRun(): string {
    const plan = getPlanById(PLAN_ID)!;
    for (let w = 0; w < plan.weeks.length; w++) {
      for (let d = 0; d < 7; d++) {
        const day = plan.weeks[w].days[d];
        if (day.type !== 'run' || !(day.distanceMi && day.distanceMi > 0)) continue;
        setSyncMeta(PLAN_ID, w, d, {
          activityId: 1,
          actualDistanceMi: day.distanceMi,
          actualPaceMinPerMi: 10,
          movingTimeSec: day.distanceMi * 600,
          feedback: '',
          syncedAt: new Date().toISOString(),
        });
        setDayCompleted(PLAN_ID, w, d, true);
        return formatDateKey(getDateForDay(START, w, d));
      }
    }
    throw new Error('no run day');
  }

  it('marks a zone from average HR as estimated', () => {
    setActivePlan({ planId: PLAN_ID, startDate: START });
    setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
    const date = syncFirstRun();
    upsertActivityHR(buildHRDataFromActivity(1, date, 130, 150, 2400)!);
    const recap = generateDailyRecap(date)!;
    expect(recap.primaryZone).toBeTruthy();
    expect(recap.primaryZoneEstimated).toBe(true);
    expect(recap.coachMessage).toMatch(/Estimated heart rate zone \(from your average HR\)/);
  });

  it('a measured zone is not labelled as estimated', () => {
    setActivePlan({ planId: PLAN_ID, startDate: START });
    setHRProfile({ maxHR: 200, restingHR: 50, source: 'manual', updatedAt: '' });
    const date = syncFirstRun();
    upsertActivityHR(buildHRDataFromActivity(1, date, 130, 150, 2400, undefined, 'intervals', [0, 2400, 0, 0, 0])!);
    const recap = generateDailyRecap(date)!;
    expect(recap.primaryZoneEstimated).toBe(false);
    expect(recap.coachMessage).toMatch(/Primary heart rate zone: Aerobic/);
  });
});

describe('refused adaptive undo explains itself (T-2)', () => {
  function seedRec(): void {
    persistence.setItem(
      'apollo_adaptive_recommendations',
      JSON.stringify([
        {
          id: 'rec-u',
          scenario: 'behind_schedule',
          type: 'reduce',
          priority: 'high',
          status: 'active',
          title: 't',
          message: 'm',
          reasoning: 'r',
          dismissible: true,
          createdAt: new Date().toISOString(),
          options: [
            {
              key: 'reduce',
              label: 'Reduce',
              description: '',
              impact: '',
              actionType: 'apply_modification',
              actionPayload: {
                id: '',
                description: 'Reduced mileage 20%',
                modificationType: 'mileage_reduction',
                weekAdjustments: [{ weekIndex: 4, mileageMultiplier: 0.8 }],
                appliedAt: '',
                undone: false,
                originalSnapshot: [],
              },
            },
          ],
        },
      ]),
    );
  }

  it('returns the blocked message when a later change edited the same days', () => {
    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2026-04-19' }, '2025-12-01');
    seedRec();
    const mod = applyRecommendation('rec-u', 'reduce')!;
    expect(scaleWeek(4, 0.9).ok).toBe(true);
    expect(undoRecommendationWithReason(mod.id)).toEqual({ ok: false, error: UNDO_BLOCKED_MESSAGE });
  });

  it('shows the message on the card', () => {
    persistence.setItem('apollo_adaptive_prefs', JSON.stringify({ enabled: true, frequency: 'weekly' }));
    persistence.setItem('apollo_last_analysis', new Date().toISOString()); // no auto analysis
    startPlan({ planId: 'hal-higdon-novice-1', raceDate: '2026-04-19' }, '2025-12-01');
    seedRec();
    applyRecommendation('rec-u', 'reduce');
    scaleWeek(4, 0.9);
    render(<AdaptiveRecommendations />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Can.t undo: a later change edited the same days/);
  });
});
