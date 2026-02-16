/**
 * Unit tests for adaptiveTraining.ts
 *
 * Tests preferences management, recommendation lifecycle, and
 * the scenario detection engine with controlled inputs.
 */

import { describe, it, expect } from 'vitest';
import {
  getAdaptivePreferences,
  setAdaptivePreferences,
  getActiveRecommendations,
  getAllRecommendations,
  dismissRecommendation,
  acceptRecommendation,
  getRecommendationBadgeCount,
  getAnalyticsHistory,
  expireStaleRecommendations,
} from '@/services/adaptiveTraining';
import { persistence } from '@/services/db/persistence';

// ── Preferences ───────────────────────────────────────────────────────────────

describe('Adaptive Preferences', () => {
  it('should return default preferences when none are stored', () => {
    const prefs = getAdaptivePreferences();
    expect(prefs).toEqual({
      enabled: true,
      frequency: 'daily',
      aggressiveness: 'balanced',
    });
  });

  it('should persist and retrieve custom preferences', () => {
    setAdaptivePreferences({ aggressiveness: 'aggressive', frequency: 'weekly' });
    const prefs = getAdaptivePreferences();
    expect(prefs.aggressiveness).toBe('aggressive');
    expect(prefs.frequency).toBe('weekly');
    expect(prefs.enabled).toBe(true); // default preserved
  });

  it('should merge partial preference updates', () => {
    setAdaptivePreferences({ enabled: false });
    const prefs = getAdaptivePreferences();
    expect(prefs.enabled).toBe(false);
    expect(prefs.frequency).toBe('daily'); // unchanged default
    expect(prefs.aggressiveness).toBe('balanced'); // unchanged default
  });

  it('should handle corrupted storage gracefully', () => {
    persistence.setItem('apollo_adaptive_prefs', 'not-json!!!');
    const prefs = getAdaptivePreferences();
    // Should fall back to defaults
    expect(prefs.enabled).toBe(true);
  });
});

// ── Recommendations Lifecycle ─────────────────────────────────────────────────

describe('Recommendations Lifecycle', () => {
  function seedRecommendation(overrides: Record<string, unknown> = {}) {
    const rec = {
      id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      scenario: 'ahead_of_schedule',
      type: 'upgrade',
      priority: 'medium',
      status: 'active',
      title: 'Test Recommendation',
      message: 'Test message',
      reasoning: 'Test reasoning',
      options: [
        { key: 'opt1', label: 'Option 1', description: 'Desc', impact: 'Impact', actionType: 'dismiss' },
      ],
      dismissible: true,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
    const all = getAllRecommendations();
    all.push(rec as never);
    persistence.setItem('apollo_adaptive_recommendations', JSON.stringify(all));
    return rec;
  }

  it('should start with no recommendations', () => {
    expect(getActiveRecommendations()).toEqual([]);
    expect(getAllRecommendations()).toEqual([]);
    expect(getRecommendationBadgeCount()).toBe(0);
  });

  it('should retrieve seeded active recommendations', () => {
    seedRecommendation({ id: 'rec-test-1' });
    const active = getActiveRecommendations();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('rec-test-1');
  });

  it('should dismiss a recommendation', () => {
    seedRecommendation({ id: 'rec-dismiss-1' });
    expect(getActiveRecommendations()).toHaveLength(1);

    dismissRecommendation('rec-dismiss-1');

    expect(getActiveRecommendations()).toHaveLength(0);
    const all = getAllRecommendations();
    expect(all[0].status).toBe('dismissed');
  });

  it('should accept a recommendation with selected option', () => {
    seedRecommendation({ id: 'rec-accept-1' });

    acceptRecommendation('rec-accept-1', 'opt1');

    const all = getAllRecommendations();
    expect(all[0].status).toBe('accepted');
    expect(all[0].selectedOptionKey).toBe('opt1');
    expect(getActiveRecommendations()).toHaveLength(0);
  });

  it('should not include expired recommendations in active list', () => {
    seedRecommendation({
      id: 'rec-expired-1',
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });
    // Active filter checks expiration
    expect(getActiveRecommendations()).toHaveLength(0);
  });

  it('should track badge count correctly', () => {
    seedRecommendation({ id: 'rec-badge-1' });
    seedRecommendation({ id: 'rec-badge-2' });
    expect(getRecommendationBadgeCount()).toBe(2);

    dismissRecommendation('rec-badge-1');
    expect(getRecommendationBadgeCount()).toBe(1);
  });
});

// ── Analytics Tracking ────────────────────────────────────────────────────────

describe('Analytics Tracking', () => {
  it('should start with empty analytics history', () => {
    expect(getAnalyticsHistory()).toEqual([]);
  });

  it('should track dismissals in analytics', () => {
    // Seed and dismiss a recommendation
    const rec = {
      id: 'rec-analytics-1',
      scenario: 'behind_schedule',
      type: 'reduce',
      priority: 'high',
      status: 'active',
      title: 'Test',
      message: 'Test',
      reasoning: 'Test',
      options: [{ key: 'k', label: 'L', description: 'D', impact: 'I', actionType: 'dismiss' }],
      dismissible: true,
      createdAt: new Date().toISOString(),
    };
    persistence.setItem('apollo_adaptive_recommendations', JSON.stringify([rec]));

    dismissRecommendation('rec-analytics-1');

    const history = getAnalyticsHistory();
    expect(history).toHaveLength(1);
    expect(history[0].recommendationId).toBe('rec-analytics-1');
    expect(history[0].action).toBe('dismissed');
    expect(history[0].scenario).toBe('behind_schedule');
  });

  it('should track acceptances in analytics', () => {
    const rec = {
      id: 'rec-analytics-2',
      scenario: 'overtraining',
      type: 'rest',
      priority: 'high',
      status: 'active',
      title: 'Test',
      message: 'Test',
      reasoning: 'Test',
      options: [{ key: 'force_rest', label: 'Rest', description: 'D', impact: 'I', actionType: 'dismiss' }],
      dismissible: false,
      createdAt: new Date().toISOString(),
    };
    persistence.setItem('apollo_adaptive_recommendations', JSON.stringify([rec]));

    acceptRecommendation('rec-analytics-2', 'force_rest');

    const history = getAnalyticsHistory();
    expect(history).toHaveLength(1);
    expect(history[0].action).toBe('accepted');
    expect(history[0].selectedOptionKey).toBe('force_rest');
  });
});

// ── Expire Stale Recommendations ──────────────────────────────────────────────

describe('expireStaleRecommendations', () => {
  it('should expire recommendations past their expiry date', () => {
    const rec = {
      id: 'rec-stale-1',
      scenario: 'ahead_of_schedule',
      type: 'upgrade',
      priority: 'medium',
      status: 'active',
      title: 'Stale',
      message: 'Stale',
      reasoning: 'Stale',
      options: [],
      dismissible: true,
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
    };
    persistence.setItem('apollo_adaptive_recommendations', JSON.stringify([rec]));

    expireStaleRecommendations();

    const all = getAllRecommendations();
    expect(all[0].status).toBe('expired');
  });

  it('should not expire recommendations that are still valid', () => {
    const rec = {
      id: 'rec-fresh-1',
      scenario: 'ahead_of_schedule',
      type: 'upgrade',
      priority: 'medium',
      status: 'active',
      title: 'Fresh',
      message: 'Fresh',
      reasoning: 'Fresh',
      options: [],
      dismissible: true,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    persistence.setItem('apollo_adaptive_recommendations', JSON.stringify([rec]));

    expireStaleRecommendations();

    expect(getActiveRecommendations()).toHaveLength(1);
  });
});
