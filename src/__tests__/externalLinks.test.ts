/**
 * External links (v1.0.7, PX-11): every https link the app shows must be one
 * the desktop app is allowed to open — otherwise Electron silently blocks the
 * click. Covers World Majors official websites and the official coach sources
 * on every built-in plan, and checks plan attribution is complete.
 */
import { describe, it, expect } from 'vitest';
import { getAllowedExternalUrl } from '../../electron/security';
import { BUILT_IN_PLANS, PLAN_INDEPENDENCE_NOTICE, planAttributionLine } from '@/data/plans';
import { getWorldMajors } from '@/data/worldMajors';

describe('desktop external links', () => {
  it('every World Major official website can be opened', () => {
    const sites = getWorldMajors('2026-10-09').map((m) => m.website).filter((u): u is string => typeof u === 'string' && u.length > 0);
    expect(sites.length).toBeGreaterThanOrEqual(6);
    for (const url of sites) expect(getAllowedExternalUrl(url), url).not.toBeNull();
  });

  it('every official coach source on a built-in plan can be opened', () => {
    for (const plan of BUILT_IN_PLANS) {
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

describe('plan attribution (v1.0.7: no plans removed, every plan labelled)', () => {
  it('keeps all eight built-in plans', () => {
    expect(BUILT_IN_PLANS.map((p) => p.id)).toEqual([
      'hal-higdon-novice-1',
      'hal-higdon-novice-2',
      'hansons-beginner',
      'hal-higdon-intermediate-1',
      'hal-higdon-advanced-1',
      'pfitzinger-18-55',
      'nike-run-club-marathon',
      'first',
    ]);
  });

  it('every built-in plan says how it relates to its coach and links an official source', () => {
    for (const plan of BUILT_IN_PLANS) {
      const a = plan.attribution;
      expect(a, plan.id).toBeDefined();
      expect(a!.note.length, plan.id).toBeGreaterThan(40);
      expect(a!.sources.length, plan.id).toBeGreaterThan(0);
      expect(planAttributionLine(plan), plan.id).toContain(a!.coach);
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
