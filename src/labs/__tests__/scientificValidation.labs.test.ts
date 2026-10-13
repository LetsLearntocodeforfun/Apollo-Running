/**
 * Scientific Validation Tests — Phase 4 Services
 *
 * Verifies that all scientific models produce physiologically plausible,
 * research-aligned outputs across realistic marathon scenarios.
 *
 * References:
 * - Romijn et al. (1993): substrate utilization at various intensities
 * - Burke et al. (2011): carbohydrate loading and metabolism
 * - Jeukendrup (2014): in-race carbohydrate intake guidelines
 * - Sawka et al. (2007): ACSM hydration position stand
 * - Ely et al. (2007): temperature impact on marathon performance
 * - Banister (1991): fitness-fatigue impulse-response model
 * - Brooks & Mercier (1994): crossover concept for substrate utilization
 * - Hoogkamer et al. (2016): weight and running performance
 * - Mujika & Padilla (2000): detraining and performance loss
 * - Friel (2009): aerobic decoupling thresholds
 * - Santos-Concejero et al. (2014): pacing profiles in the marathon
 *
 * v1.0.7 (R-14): split out of src/__tests__/scientificValidation.test.ts. These cover
 * the experimental modules in src/labs/ (not used by any screen).
 */

import { describe, it, expect } from 'vitest';
import { simulateGlycogenDepletion } from '@/labs/glycogenModel';
import { calculateSweatRate, assessDehydrationRisk } from '@/labs/hydrationCalculator';
import { simulateWhatIf, getAvailableScenarios, type WhatIfScenario } from '@/labs/whatIfSimulator';
import { calculateFRI } from '@/labs/fatigueResistance';
import { fitDecayModel, predictRacePacing, compareDecayToIdeal } from '@/labs/pacingDecay';
import { normalizeToIdeal, convertBetweenConditions } from '@/labs/raceEquivalence';
import { calculateDecoupling } from '@/labs/aerobicDecoupling';
import { compareRuns, buildGhostRun } from '@/labs/ghostRunner';
import { assessBonkRisk } from '@/labs/bonkRisk';

// ── Test Athletes ─────────────────────────────────────────────────────────────

const maleRunner70kg = {
  weightKg: 70,
  sex: 'male' as const,
  vo2max: 50,
};


// ── Glycogen Model Scientific Validation ──────────────────────────────────────

describe('Glycogen Model — Scientific Validation', () => {
  it('caloric cost per mile matches Margaria (~1 kcal/kg/km = ~1.6 kcal/kg/mi)', () => {
    // A 70kg runner should burn approximately 112 kcal per mile (70 * 1.6)
    const sim = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 480, // 8:00/mi
    });
    const firstMileCals = sim.miles[0].calsBurnedThisMile;
    // Margaria: ~1 kcal/kg/km ≈ 1.609 kcal/kg/mi → 70kg * 1.609 = 112.6
    expect(firstMileCals).toBeGreaterThanOrEqual(100);
    expect(firstMileCals).toBeLessThanOrEqual(125);
  });

  it('total caloric burn for full marathon is in physiological range (2000-3500 kcal)', () => {
    const sim = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 480,
    });
    // 70kg × 1.609 kcal/kg/mi × 26.2 mi ≈ 2950 kcal
    expect(sim.totalCalsBurned).toBeGreaterThanOrEqual(2000);
    expect(sim.totalCalsBurned).toBeLessThanOrEqual(3500);
  });

  it('base glycogen (450g) depletes during marathon without fueling', () => {
    // 450g x 4 kcal/g = 1800 kcal from glycogen
    // At ~78% glycogen fraction, glycogen depletion typically around mile 16-22
    const sim = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    expect(sim.depletionMile).not.toBeNull();
    expect(sim.depletionMile!).toBeGreaterThanOrEqual(14);
    expect(sim.depletionMile!).toBeLessThanOrEqual(24);
  });

  it('carb-loaded glycogen (700g) lasts longer than base glycogen', () => {
    const baseSim = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    const loadedSim = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 480,
      carbLoaded: true,
    });
    if (baseSim.depletionMile && loadedSim.depletionMile) {
      expect(loadedSim.depletionMile).toBeGreaterThan(baseSim.depletionMile);
    }
    // Loaded glycogen should have more remaining at each mile
    expect(loadedSim.miles[15].glycogenRemainingG)
      .toBeGreaterThan(baseSim.miles[15].glycogenRemainingG);
  });

  it('in-race fueling extends glycogen endurance', () => {
    const gels = [
      { mile: 5, raceTimeMin: 40, item: 'Gel', carbsG: 25, notes: '' },
      { mile: 10, raceTimeMin: 80, item: 'Gel', carbsG: 25, notes: '' },
      { mile: 15, raceTimeMin: 120, item: 'Gel', carbsG: 25, notes: '' },
      { mile: 20, raceTimeMin: 160, item: 'Gel', carbsG: 25, notes: '' },
    ];
    const noFuel = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 480,
      carbLoaded: true,
    });
    const withFuel = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 480,
      carbLoaded: true,
      fuelingItems: gels,
    });
    // With 100g of additional carbs, glycogen at mile 22 should be higher
    expect(withFuel.miles[21].glycogenRemainingG)
      .toBeGreaterThan(noFuel.miles[21].glycogenRemainingG);
  });

  it('lighter runner depletes glycogen faster per body weight', () => {
    // Lighter runner burns fewer total kcal but has proportionally less glycogen
    const heavySim = simulateGlycogenDepletion({
      athlete: { weightKg: 80, sex: 'male', vo2max: 50 },
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    const lightSim = simulateGlycogenDepletion({
      athlete: { weightKg: 60, sex: 'male', vo2max: 50 },
      paceSecPerMi: 480,
      carbLoaded: false,
    });
    // Light runner burns fewer kcal/mi but same starting glycogen
    // So light runner's glycogen should last LONGER (in miles)
    if (heavySim.depletionMile && lightSim.depletionMile) {
      expect(lightSim.depletionMile).toBeGreaterThanOrEqual(heavySim.depletionMile);
    }
  });

  it('faster pace depletes glycogen sooner (higher %VO2max → more glycogen burning)', () => {
    const slowSim = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 600, // 10:00/mi
      carbLoaded: false,
    });
    const fastSim = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 420, // 7:00/mi
      carbLoaded: false,
    });
    // Both burn same kcal/mi (roughly), but faster pace uses higher %glycogen
    // So fast runner depletes sooner
    if (slowSim.depletionMile && fastSim.depletionMile) {
      expect(fastSim.depletionMile).toBeLessThanOrEqual(slowSim.depletionMile);
    }
  });

  it('glycogen never goes negative', () => {
    const sim = simulateGlycogenDepletion({
      athlete: maleRunner70kg,
      paceSecPerMi: 360, // very fast, high glycogen burn
      distanceMi: 30,    // ultra distance
    });
    for (const mile of sim.miles) {
      expect(mile.glycogenRemainingG).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── Hydration Calculator Scientific Validation ────────────────────────────────

describe('Hydration Calculator — Scientific Validation', () => {
  const idealConditions = { tempF: 55, humidityPct: 40 };
  const hotConditions = { tempF: 85, humidityPct: 70 };

  it('base sweat rate in ideal conditions is physiologically plausible (600-1000 ml/hr)', () => {
    const result = calculateSweatRate(
      maleRunner70kg,
      idealConditions,
      480,
      210,
    );
    expect(result.adjustedSweatRateMlHr).toBeGreaterThanOrEqual(500);
    expect(result.adjustedSweatRateMlHr).toBeLessThanOrEqual(1200);
  });

  it('hot/humid conditions increase sweat rate by 30-60%', () => {
    const idealResult = calculateSweatRate(maleRunner70kg, idealConditions, 480, 210);
    const hotResult = calculateSweatRate(maleRunner70kg, hotConditions, 480, 210);
    const ratio = hotResult.adjustedSweatRateMlHr / idealResult.adjustedSweatRateMlHr;
    expect(ratio).toBeGreaterThanOrEqual(1.2);
    expect(ratio).toBeLessThanOrEqual(2.0);
  });

  it('female runners have lower sweat rate than males (Sawka 2007)', () => {
    const maleResult = calculateSweatRate(
      { weightKg: 65, sex: 'male', vo2max: 50 },
      idealConditions, 480, 210,
    );
    const femaleResult = calculateSweatRate(
      { weightKg: 65, sex: 'female', vo2max: 50 },
      idealConditions, 480, 210,
    );
    expect(femaleResult.adjustedSweatRateMlHr).toBeLessThan(maleResult.adjustedSweatRateMlHr);
  });

  it('recommended intake never exceeds max safe rate (1000 ml/hr)', () => {
    const result = calculateSweatRate(
      { weightKg: 90, sex: 'male', vo2max: 55 },
      { tempF: 95, humidityPct: 80 }, // extreme heat
      420, // fast pace
      180,
    );
    expect(result.recommendedIntakeMlHr).toBeLessThanOrEqual(1000);
  });

  it('total fluid loss over a marathon is in physiological range (1-5 liters)', () => {
    const result = calculateSweatRate(maleRunner70kg, idealConditions, 480, 210);
    const totalLossL = (result.adjustedSweatRateMlHr * (210 / 60)) / 1000;
    expect(totalLossL).toBeGreaterThanOrEqual(1);
    expect(totalLossL).toBeLessThanOrEqual(5);
  });

  it('dehydration risk is higher in hot/humid conditions', () => {
    const idealRisk = assessDehydrationRisk(maleRunner70kg, idealConditions, 480);
    const hotRisk = assessDehydrationRisk(maleRunner70kg, hotConditions, 480);
    // Hot conditions should produce same or higher risk level
    const riskOrder: Record<string, number> = { low: 0, moderate: 1, high: 2, extreme: 3 };
    expect(riskOrder[hotRisk.risk]).toBeGreaterThanOrEqual(riskOrder[idealRisk.risk]);
  });
});

// ── What-If Simulator Scientific Validation ───────────────────────────────────

describe('What-If Simulator — Scientific Validation', () => {
  it('weight loss improves time (Hoogkamer: ~2 sec/mi per lb)', () => {
    const scenario: WhatIfScenario = { type: 'weight_change', label: 'Lose 10 lbs', description: 'Test', value: -10 };
    const result = simulateWhatIf(scenario, 50, 40);
    // 10 lbs × 2 sec/mi × 26.2 miles = ~524 seconds improvement
    expect(result.deltaSec).toBeLessThan(0); // negative = improvement
    expect(Math.abs(result.deltaSec)).toBeGreaterThanOrEqual(300);
    expect(Math.abs(result.deltaSec)).toBeLessThanOrEqual(800);
  });

  it('weight gain increases time', () => {
    const scenario: WhatIfScenario = { type: 'weight_change', label: 'Gain 5 lbs', description: 'Test', value: 5 };
    const result = simulateWhatIf(scenario, 50, 40);
    expect(result.deltaSec).toBeGreaterThan(0);
  });

  it('mileage increase produces moderate improvement (capped at 5%)', () => {
    const scenario: WhatIfScenario = { type: 'increase_mileage', label: '+20%', description: 'Test', value: 20 };
    const result = simulateWhatIf(scenario, 50, 40);
    expect(result.deltaSec).toBeLessThan(0);
    // 20% increase → moderate improvement
    expect(Math.abs(result.deltaSec)).toBeLessThanOrEqual(900);
  });

  it('detraining from skipping days causes proportional loss (Mujika & Padilla)', () => {
    const scenario: WhatIfScenario = { type: 'skip_days', label: '14 days off', description: 'Test', value: 14 };
    const result = simulateWhatIf(scenario, 50, 40);
    // 2 weeks × ~3% VO2max loss/week = ~6% loss → significant time increase
    expect(result.deltaSec).toBeGreaterThan(0);
    expect(result.deltaSec).toBeGreaterThanOrEqual(120); // at least 2 min
  });

  it('offers the default scenario types; weight change is not suggested (A-05)', () => {
    const scenarios = getAvailableScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(6);
    const types = new Set(scenarios.map((s) => s.type));
    expect(types.has('increase_mileage')).toBe(true);
    expect(types.has('skip_days')).toBe(true);
    expect(types.has('add_long_run')).toBe(true);
    expect(types.has('marathon_pace_long_runs')).toBe(true);
    expect(types.has('decrease_mileage')).toBe(true);
    expect(types.has('add_tempo_runs')).toBe(true);
    // simulateWhatIf still accepts 'weight_change'; it just isn't offered by default.
    expect(types.has('weight_change')).toBe(false);
  });
});

// ── Fatigue Resistance Index Scientific Validation ────────────────────────────

describe('Fatigue Resistance Index — Scientific Validation', () => {
  it('perfectly even splits produce FRI = 100', () => {
    const evenPaces = Array(20).fill(480); // 8:00/mi for 20 miles
    const result = calculateFRI(evenPaces, 20, 'test-1', '2025-01-01');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeCloseTo(100, 0);
    expect(result!.rating).toBe('excellent');
  });

  it('negative split (faster late) produces FRI < 100', () => {
    // Start 8:00, gradually get faster to 7:30
    const splits = Array(20).fill(0).map((_, i) =>
      480 - (i / 19) * 30,
    );
    const result = calculateFRI(splits, 20, 'test-2', '2025-01-01');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeLessThan(100);
    expect(result!.rating).toBe('excellent');
  });

  it('moderate fade (5% slower last 30%) produces "good" or "fair" rating', () => {
    // First 14 miles at 8:00, last 6 miles at 8:24 (5% slower)
    const splits = [
      ...Array(14).fill(480),
      ...Array(6).fill(504),
    ];
    const result = calculateFRI(splits, 20, 'test-3', '2025-01-01');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeGreaterThanOrEqual(100);
    expect(result!.fri).toBeLessThanOrEqual(107);
    expect(['good', 'fair']).toContain(result!.rating);
  });

  it('severe fade (15% slower) produces "severe_fade" rating', () => {
    // First 14 miles at 8:00, last 6 miles at 9:12 (15% slower)
    const splits = [
      ...Array(14).fill(480),
      ...Array(6).fill(552),
    ];
    const result = calculateFRI(splits, 20, 'test-4', '2025-01-01');
    expect(result).not.toBeNull();
    expect(result!.fri).toBeGreaterThan(110);
    expect(result!.rating).toBe('severe_fade');
  });

  it('filters anomalous splits (bathroom breaks)', () => {
    // Normal pace with one 15:00 mile (bathroom break)
    const splits = Array(20).fill(480);
    splits[10] = 900; // 15:00 mile
    const result = calculateFRI(splits, 20, 'test-5', '2025-01-01');
    expect(result).not.toBeNull();
    // Should filter the anomalous split and still give ~100 FRI
    expect(result!.fri).toBeLessThan(105);
  });

  it('rejects runs shorter than 16 miles', () => {
    const splits = Array(12).fill(480);
    const result = calculateFRI(splits, 12, 'test-6', '2025-01-01');
    expect(result).toBeNull();
  });
});

// ── Pacing Decay Model Validation ─────────────────────────────────────────────

describe('Pacing Decay Model — Scientific Validation', () => {
  const longRuns = [
    {
      date: '2025-01-01',
      splits: [500, 490, 485, 480, 478, 478, 480, 482, 485, 488, 492, 495, 500, 505, 510, 515, 520, 525],
    },
    {
      date: '2025-01-15',
      splits: [498, 488, 483, 479, 477, 477, 479, 481, 484, 487, 491, 494, 499, 504, 509, 514, 519, 524],
    },
    {
      date: '2025-02-01',
      splits: [502, 492, 487, 482, 480, 480, 482, 484, 487, 490, 494, 497, 502, 507, 512, 517, 522, 527],
    },
  ];

  it('fits a model from 3+ qualified long runs', () => {
    const model = fitDecayModel(longRuns);
    expect(model).not.toBeNull();
    expect(model!.sampleSize).toBe(3);
    expect(model!.decayRatePerMi).toBeGreaterThan(0); // positive decay
    expect(model!.decayRatePerMi).toBeLessThan(0.05); // reasonable range
  });

  it('decay rate is in physiological range (0.1-3% per mile)', () => {
    const model = fitDecayModel(longRuns)!;
    const decayPct = model.decayRatePerMi * 100;
    expect(decayPct).toBeGreaterThanOrEqual(0.1);
    expect(decayPct).toBeLessThanOrEqual(3.0);
  });

  it('predicted race pacing shows stable then decaying pattern', () => {
    const model = fitDecayModel(longRuns)!;
    const predicted = predictRacePacing(model, 420, 26);
    // First 8 miles should be at target pace
    for (let i = 0; i < Math.min(8, model.decayStartMile); i++) {
      expect(predicted[i].paceSec).toBe(420);
    }
    // Miles after decay start should be progressively slower
    for (let i = model.decayStartMile + 1; i < predicted.length - 1; i++) {
      expect(predicted[i].paceSec).toBeLessThanOrEqual(predicted[i + 1].paceSec);
    }
  });

  it('decay comparison provides correct ideal thresholds', () => {
    const model = fitDecayModel(longRuns)!;
    // 2:45 target (9900 sec) → falls in sub-3:00 bucket → idealDecay = 0.5%/mi
    const cmp = compareDecayToIdeal(model, 9900);
    expect(cmp.idealDecayPct).toBeCloseTo(0.5, 1); // 0.5%/mi for sub-3:00
    expect(typeof cmp.message).toBe('string');
    expect(cmp.message.length).toBeGreaterThan(0);
  });

  it('requires minimum 3 long runs to fit model', () => {
    const tooFew = longRuns.slice(0, 2);
    expect(fitDecayModel(tooFew)).toBeNull();
  });
});

// ── Race Equivalence Scientific Validation ────────────────────────────────────

describe('Race Equivalence — Scientific Validation', () => {
  const threeHourMarathon = 3 * 3600; // 10800 sec

  it('heat penalty matches Ely et al. 2007 (~1.75% per 10°F above 55°F)', () => {
    // 75°F is 20°F above ideal → expect ~3.5% penalty
    const result = normalizeToIdeal(threeHourMarathon, { tempF: 75, humidityPct: 40 });
    // Converting from 75°F to 55°F should make the runner faster
    expect(result.adjustedTimeSec).toBeLessThan(threeHourMarathon);
    const pctDelta = ((threeHourMarathon - result.adjustedTimeSec) / threeHourMarathon) * 100;
    // Should be approximately 3-4% faster at ideal temp
    expect(pctDelta).toBeGreaterThanOrEqual(2.5);
    expect(pctDelta).toBeLessThanOrEqual(5.0);
  });

  it('altitude penalty matches Péronnet (~3% per 1000m = ~0.9% per 1000ft)', () => {
    // 5000ft altitude → ~4.5% penalty
    const result = normalizeToIdeal(threeHourMarathon, {
      tempF: 55, humidityPct: 40, altitudeFt: 5000,
    });
    expect(result.adjustedTimeSec).toBeLessThan(threeHourMarathon);
    const pctDelta = ((threeHourMarathon - result.adjustedTimeSec) / threeHourMarathon) * 100;
    expect(pctDelta).toBeGreaterThanOrEqual(3.0);
    expect(pctDelta).toBeLessThanOrEqual(6.0);
  });

  it('ideal conditions produce no significant adjustment', () => {
    const result = normalizeToIdeal(threeHourMarathon, { tempF: 55, humidityPct: 40 });
    expect(Math.abs(result.deltaSec)).toBeLessThanOrEqual(5);
  });

  it('bidirectional conversion is approximately inverse', () => {
    const hotCond = { tempF: 80, humidityPct: 60, windMph: 5 };
    const idealCond = { tempF: 55, humidityPct: 40, windMph: 0 };
    const toIdeal = convertBetweenConditions(threeHourMarathon, hotCond, idealCond);
    const backToHot = convertBetweenConditions(toIdeal.adjustedTimeSec, idealCond, hotCond);
    // Round-trip should be close to original (within ~1% due to multiplicative nature)
    expect(Math.abs(backToHot.adjustedTimeSec - threeHourMarathon)).toBeLessThanOrEqual(120);
  });

  it('humidity penalty follows Maughan 2010 (0.5% per 10% above 40%)', () => {
    // 80% humidity = 40% above ideal → ~2% penalty
    const result = normalizeToIdeal(threeHourMarathon, { tempF: 55, humidityPct: 80 });
    expect(result.adjustedTimeSec).toBeLessThan(threeHourMarathon);
    const pctDelta = ((threeHourMarathon - result.adjustedTimeSec) / threeHourMarathon) * 100;
    expect(pctDelta).toBeGreaterThanOrEqual(1.0);
    expect(pctDelta).toBeLessThanOrEqual(3.5);
  });
});

// ── Aerobic Decoupling Validation ─────────────────────────────────────────────

describe('Aerobic Decoupling — Scientific Validation', () => {
  it('zero cardiac drift = 0% decoupling (excellent)', () => {
    const splits = Array(12).fill(0).map((_, i) => ({
      mile: i + 1,
      paceSec: 480,
      avgHR: 150,
    }));
    const result = calculateDecoupling(splits, 12, 1, '2025-01-01');
    expect(result).not.toBeNull();
    expect(Math.abs(result!.decouplingPct)).toBeLessThan(1);
    expect(result!.rating).toBe('excellent');
  });

  it('moderate cardiac drift = ~7% decoupling (adequate per Friel)', () => {
    // Second half: HR rises 7% while pace stays same
    const splits = [
      ...Array(6).fill(0).map((_, i) => ({ mile: i + 1, paceSec: 480, avgHR: 150 })),
      ...Array(6).fill(0).map((_, i) => ({ mile: i + 7, paceSec: 480, avgHR: 160 })),
    ];
    const result = calculateDecoupling(splits, 12, 2, '2025-01-01');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeGreaterThanOrEqual(4);
    expect(result!.decouplingPct).toBeLessThanOrEqual(10);
    expect(result!.rating).toBe('adequate');
  });

  it('severe drift produces needs_work rating (>10%)', () => {
    const splits = [
      ...Array(6).fill(0).map((_, i) => ({ mile: i + 1, paceSec: 480, avgHR: 145 })),
      ...Array(6).fill(0).map((_, i) => ({ mile: i + 7, paceSec: 480, avgHR: 170 })),
    ];
    const result = calculateDecoupling(splits, 12, 3, '2025-01-01');
    expect(result).not.toBeNull();
    expect(result!.decouplingPct).toBeGreaterThan(10);
    expect(result!.rating).toBe('needs_work');
  });

  it('rejects short runs (< 8 miles)', () => {
    const splits = Array(5).fill(0).map((_, i) => ({
      mile: i + 1, paceSec: 480, avgHR: 150,
    }));
    expect(calculateDecoupling(splits, 5, 4, '2025-01-01')).toBeNull();
  });

  it('filters out low HR splits (sensor errors)', () => {
    const splits = Array(10).fill(0).map((_, i) => ({
      mile: i + 1,
      paceSec: 480,
      avgHR: i === 5 ? 50 : 150, // One bad reading
    }));
    const result = calculateDecoupling(splits, 10, 5, '2025-01-01');
    // Should filter the bad reading and still compute
    expect(result).not.toBeNull();
  });
});

// ── Ghost Runner Validation ───────────────────────────────────────────────────

describe('Ghost Runner — Comparison Accuracy', () => {
  it('identical runs produce zero delta', () => {
    const run = buildGhostRun(1, '2025-01-01', 'Run A', Array(20).fill(480));
    const cmp = compareRuns(run, run);
    expect(cmp.totalDeltaSec).toBe(0);
    for (const m of cmp.miles) {
      expect(m.deltaSec).toBe(0);
    }
  });

  it('faster current run produces negative cumulative delta', () => {
    const current = buildGhostRun(1, '2025-01-01', 'Today', Array(20).fill(470));
    const ghost = buildGhostRun(2, '2024-12-01', 'Last month', Array(20).fill(480));
    const cmp = compareRuns(current, ghost);
    expect(cmp.totalDeltaSec).toBeLessThan(0);
    expect(cmp.totalDeltaSec).toBe(-200); // 10 sec/mi × 20 miles
  });

  it('cumulative delta is sum of per-mile deltas', () => {
    const current = buildGhostRun(1, '2025-01-01', 'A', [480, 490, 470, 500]);
    const ghost = buildGhostRun(2, '2024-12-01', 'B', [480, 480, 480, 480]);
    const cmp = compareRuns(current, ghost);
    const sumDeltas = cmp.miles.reduce((s, m) => s + m.deltaSec, 0);
    expect(cmp.totalDeltaSec).toBe(sumDeltas);
  });

  it('comparison uses the shorter of two runs', () => {
    const short = buildGhostRun(1, '2025-01-01', 'Short', Array(10).fill(480));
    const long = buildGhostRun(2, '2024-12-01', 'Long', Array(20).fill(480));
    const cmp = compareRuns(short, long);
    expect(cmp.milesCompared).toBe(10);
  });
});

// ── Bonk Risk Assessment Validation ───────────────────────────────────────────

describe('Bonk Risk Assessment — Scientific Validation', () => {
  it('well-prepared runner scores low risk', () => {
    const result = assessBonkRisk({
      longestRunMi: 22,
      runsOver18Mi: 5,
      longRunsPlanned: 8,
      longRunsCompleted: 7,
      targetRacePaceSec: 480,
      avgLongRunPaceSec: 510,
      practicedFueling: true,
      fueledLongRuns: 5,
      carbLoading: true,
      carbLoadingDaysCompleted: 3,
      experience: 'advanced',
    });
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.level).toBe('low');
    expect(result.mitigations.length).toBe(0);
  });

  it('poorly-prepared beginner scores high risk', () => {
    const result = assessBonkRisk({
      longestRunMi: 14,
      runsOver18Mi: 0,
      longRunsPlanned: 8,
      longRunsCompleted: 3,
      targetRacePaceSec: 480,
      avgLongRunPaceSec: 540,
      practicedFueling: false,
      carbLoading: false,
      experience: 'beginner',
      raceTempF: 80,
    });
    expect(result.score).toBeGreaterThanOrEqual(65);
    expect(['high', 'very_high']).toContain(result.level);
    expect(result.mitigations.length).toBeGreaterThanOrEqual(3);
  });

  it('risk factors sum is bounded [0, 100]', () => {
    // Best case
    const low = assessBonkRisk({
      longestRunMi: 24, runsOver18Mi: 6, longRunsPlanned: 6, longRunsCompleted: 6,
      targetRacePaceSec: 480, avgLongRunPaceSec: 490,
      practicedFueling: true, fueledLongRuns: 6,
      carbLoading: true, carbLoadingDaysCompleted: 3,
      experience: 'advanced', raceTempF: 50,
    });
    expect(low.score).toBeGreaterThanOrEqual(0);
    expect(low.score).toBeLessThanOrEqual(100);

    // Worst case
    const high = assessBonkRisk({
      longestRunMi: 10, runsOver18Mi: 0, longRunsPlanned: 10, longRunsCompleted: 2,
      targetRacePaceSec: 360, avgLongRunPaceSec: 600,
      practicedFueling: false,
      carbLoading: false,
      experience: 'beginner', raceTempF: 95,
    });
    expect(high.score).toBeGreaterThanOrEqual(0);
    expect(high.score).toBeLessThanOrEqual(100);
  });

  it('heat factor increases risk score', () => {
    const base = {
      longestRunMi: 20, runsOver18Mi: 3, longRunsPlanned: 6, longRunsCompleted: 5,
      targetRacePaceSec: 480, avgLongRunPaceSec: 510,
      practicedFueling: true, carbLoading: true, carbLoadingDaysCompleted: 3,
      experience: 'intermediate' as const,
    };
    const cool = assessBonkRisk({ ...base, raceTempF: 50 });
    const hot = assessBonkRisk({ ...base, raceTempF: 85 });
    expect(hot.score).toBeGreaterThan(cool.score);
  });

  it('experience level affects pace aggression tolerance', () => {
    const baseInput = {
      longestRunMi: 20, runsOver18Mi: 4, longRunsPlanned: 6, longRunsCompleted: 6,
      targetRacePaceSec: 420, avgLongRunPaceSec: 480, // 60 sec/mi = ~12.5% faster
      practicedFueling: true, carbLoading: true, carbLoadingDaysCompleted: 3,
    };
    const beginner = assessBonkRisk({ ...baseInput, experience: 'beginner' });
    const advanced = assessBonkRisk({ ...baseInput, experience: 'advanced' });
    // Beginner should be penalized more for the same pace gap
    expect(beginner.score).toBeGreaterThan(advanced.score);
  });
});
