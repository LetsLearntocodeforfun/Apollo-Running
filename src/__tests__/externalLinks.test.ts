/**
 * External links (v1.0.7, PX-11): every https link the app shows must be one
 * the desktop app is allowed to open — otherwise Electron silently blocks the
 * click. Covers World Majors official websites and the official coach sources
 * on every built-in plan, and checks plan attribution is complete.
 */
import { describe, it, expect } from 'vitest';
import { getAllowedExternalUrl } from '../../electron/security';
import {
  ALL_BUILT_IN_PLANS,
  BUILT_IN_PLANS,
  PLAN_INDEPENDENCE_NOTICE,
  SUPPLEMENTAL_PLANS,
  planAttributionLine,
} from '@/data/plans';
import { getWorldMajors } from '@/data/worldMajors';

describe('desktop external links', () => {
  it('every World Major official website can be opened', () => {
    const sites = getWorldMajors('2026-10-09')
      .map((m) => m.website)
      .filter((u): u is string => typeof u === 'string' && u.length > 0);
    expect(sites.length).toBeGreaterThanOrEqual(6);
    for (const url of sites) expect(getAllowedExternalUrl(url), url).not.toBeNull();
  });

  it('every official coach source on a built-in or supplemental plan can be opened', () => {
    for (const plan of ALL_BUILT_IN_PLANS) {
      for (const source of plan.attribution?.sources ?? []) {
        expect(source.url.startsWith('https://'), `${plan.id}: ${source.url}`).toBe(true);
        expect(getAllowedExternalUrl(source.url), `${plan.id}: ${source.url}`).not.toBeNull();
      }
    }
  });

  it('look-alike domains stay blocked', () => {
    expect(getAllowedExternalUrl('https://halhigdon.com.evil.example/')).toBeNull();
    expect(getAllowedExternalUrl('https://evilnike.com/')).toBeNull();
    expect(getAllowedExternalUrl('http://www.halhigdon.com/')).toBeNull();
  });
});

describe('plan attribution (v1.0.7+: original plans preserved, expanded library labelled)', () => {
  it('keeps all eight original built-in plans first and expands the library to 29 marathon + 4 block plans', () => {
    expect(BUILT_IN_PLANS.slice(0, 8).map((p) => p.id)).toEqual([
      'hal-higdon-novice-1',
      'hal-higdon-novice-2',
      'hansons-beginner',
      'hal-higdon-intermediate-1',
      'hal-higdon-advanced-1',
      'pfitzinger-18-55',
      'nike-run-club-marathon',
      'first',
    ]);
    expect(BUILT_IN_PLANS).toHaveLength(29);
    expect(SUPPLEMENTAL_PLANS).toHaveLength(4);
    expect(ALL_BUILT_IN_PLANS).toHaveLength(33);
    expect(new Set(ALL_BUILT_IN_PLANS.map((p) => p.id)).size).toBe(33);
  });

  it('every built-in and supplemental plan says how it relates to its coach; coach-based plans link an official source', () => {
    for (const plan of ALL_BUILT_IN_PLANS) {
      const a = plan.attribution;
      expect(a, plan.id).toBeDefined();
      expect(a!.note.length, plan.id).toBeGreaterThan(40);
      // v1.0.9: Apollo's own plans have no coach source to link; every other plan must link one.
      if (a!.fidelity !== 'original') expect(a!.sources.length, plan.id).toBeGreaterThan(0);
      expect(planAttributionLine(plan), plan.id).toContain(a!.coach);
    }
  });

  it('plans Apollo designed say so and never borrow a coach’s name or book (v1.0.9)', () => {
    const apollo = ALL_BUILT_IN_PLANS.filter((p) => p.attribution?.coach === 'Apollo Coaching Lab');
    expect(apollo.map((p) => p.id).sort()).toEqual([
      'apollo-base-12',
      'apollo-base-8',
      'apollo-bq-60',
      'apollo-canova-75',
      'apollo-maintenance-6',
      'apollo-norwegian-70',
      'apollo-recovery-4',
      'apollo-time-based-endurance',
    ]);
    for (const plan of apollo) {
      expect(plan.attribution!.fidelity, plan.id).toBe('original');
      expect(planAttributionLine(plan), plan.id).toBe('Designed by Apollo Coaching Lab');
      expect(plan.description, plan.id).toMatch(/^Designed by Apollo/);
      for (const s of plan.attribution!.sources) expect(s.kind, plan.id).not.toBe('book');
    }
    // Only coach-based plans may claim a coach's method or published schedule.
    for (const plan of ALL_BUILT_IN_PLANS) {
      if (plan.attribution?.fidelity === 'original') continue;
      expect(plan.attribution!.coach, plan.id).not.toBe('Apollo Coaching Lab');
    }
  });

  it('representative plans are labelled as simplified, never as the coach’s own plan', () => {
    const pfitz = BUILT_IN_PLANS.find((p) => p.id === 'pfitzinger-18-55')!;
    const nike = BUILT_IN_PLANS.find((p) => p.id === 'nike-run-club-marathon')!;
    expect(planAttributionLine(pfitz)).toBe('Inspired by Pete Pfitzinger (simplified)');
    expect(planAttributionLine(nike)).toBe('Inspired by Nike Run Club (simplified)');
  });

  it('the independence notice disclaims affiliation and endorsement', () => {
    expect(PLAN_INDEPENDENCE_NOTICE).toMatch(/not affiliated/);
    expect(PLAN_INDEPENDENCE_NOTICE).toMatch(/endorses/);
  });
});
