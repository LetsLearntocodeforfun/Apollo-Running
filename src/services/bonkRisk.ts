/**
 * Bonk Risk Assessment — pre-race composite risk score (0-100).
 *
 * Combines multiple risk factors to estimate the likelihood of
 * glycogen depletion ("bonking") during a marathon:
 *
 * 1. Longest run distance (20+ mi = low risk, <16 = high risk)
 * 2. Number of runs ≥ 18 miles (4+ = low risk)
 * 3. Weekly long run consistency
 * 4. Race pace vs training pace ratio (aggressive = higher risk)
 * 5. Fueling practice in training
 * 6. Carb loading compliance
 *
 * Score: 0-100 where lower = lower risk.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BonkRiskInput {
  /** Longest single run in miles during the training cycle */
  longestRunMi: number;
  /** Number of runs ≥ 18 miles */
  runsOver18Mi: number;
  /** Number of planned long runs vs completed */
  longRunsPlanned: number;
  longRunsCompleted: number;
  /** Race target pace (sec/mi) */
  targetRacePaceSec: number;
  /** Average long run pace (sec/mi) */
  avgLongRunPaceSec: number;
  /** Did the athlete practice race-day nutrition on long runs? */
  practicedFueling: boolean;
  /** How many long runs included fueling practice? */
  fueledLongRuns?: number;
  /** Is the athlete doing carb loading? */
  carbLoading: boolean;
  /** Number of carb loading days completed (0-3) */
  carbLoadingDaysCompleted?: number;
  /** Race day temperature (°F) — optional */
  raceTempF?: number;
  /** Athlete experience level */
  experience: 'beginner' | 'intermediate' | 'advanced';
}

export interface BonkRiskResult {
  /** Overall risk score 0-100 */
  score: number;
  /** Risk level */
  level: 'low' | 'moderate' | 'high' | 'very_high';
  /** Individual risk factor scores */
  factors: BonkRiskFactor[];
  /** Specific mitigations for high-risk items */
  mitigations: string[];
  /** Summary message */
  summary: string;
}

export interface BonkRiskFactor {
  name: string;
  /** Risk contribution (0-100) */
  score: number;
  /** Weight in overall score (0-1) */
  weight: number;
  /** Weighted contribution */
  weightedScore: number;
  /** Status */
  status: 'low' | 'moderate' | 'high';
  /** Detail */
  detail: string;
}

// ── Weights ───────────────────────────────────────────────────────────────────

const WEIGHTS = {
  longestRun: 0.20,
  longRunCount: 0.15,
  consistency: 0.15,
  paceAggression: 0.20,
  fuelingPractice: 0.15,
  carbLoading: 0.10,
  heat: 0.05,
};

// ── Core Assessment ───────────────────────────────────────────────────────────

/**
 * Calculate composite bonk risk score.
 */
export function assessBonkRisk(input: BonkRiskInput): BonkRiskResult {
  const factors: BonkRiskFactor[] = [];
  const mitigations: string[] = [];

  // 1. Longest run distance
  const longestRunScore = scoreLongestRun(input.longestRunMi);
  factors.push(longestRunScore);
  if (longestRunScore.status === 'high') {
    mitigations.push(`Your longest run is ${input.longestRunMi.toFixed(1)} miles. If possible, complete a 20-mile run before race day. If time is short, do a 18-mile run at marathon effort.`);
  }

  // 2. Number of 18+ mile runs
  const longRunCountScore = scoreLongRunCount(input.runsOver18Mi);
  factors.push(longRunCountScore);
  if (longRunCountScore.status === 'high') {
    mitigations.push(`You've only completed ${input.runsOver18Mi} runs over 18 miles. Aim for at least 3-4 in your build-up for adequate glycogen depletion adaptation.`);
  }

  // 3. Long run consistency
  const consistencyScore = scoreConsistency(input.longRunsPlanned, input.longRunsCompleted);
  factors.push(consistencyScore);
  if (consistencyScore.status === 'high') {
    mitigations.push(`You've completed ${input.longRunsCompleted} of ${input.longRunsPlanned} planned long runs. Missing long runs significantly increases bonk risk. Prioritize remaining long runs.`);
  }

  // 4. Pace aggression
  const paceScore = scorePaceAggression(input.targetRacePaceSec, input.avgLongRunPaceSec, input.experience);
  factors.push(paceScore);
  if (paceScore.status === 'high') {
    mitigations.push(`Your target race pace is significantly faster than your training long run pace. Consider adjusting your target by 5-10 sec/mile to reduce bonk risk, or ensure aggressive fueling.`);
  }

  // 5. Fueling practice
  const fuelingScore = scoreFuelingPractice(input.practicedFueling, input.fueledLongRuns, input.runsOver18Mi);
  factors.push(fuelingScore);
  if (fuelingScore.status === 'high') {
    mitigations.push(`Practice your exact race-day nutrition on your remaining long runs. Your gut needs training to absorb carbs at race effort.`);
  }

  // 6. Carb loading
  const carbScore = scoreCarbLoading(input.carbLoading, input.carbLoadingDaysCompleted);
  factors.push(carbScore);
  if (carbScore.status === 'high') {
    mitigations.push(`Carb loading adds 250+ grams of glycogen — the equivalent of 6+ extra miles of fuel. Follow a 3-day protocol: 8-12g carbs per kg body weight daily.`);
  }

  // 7. Heat (if provided)
  if (input.raceTempF !== undefined) {
    const heatScore = scoreHeatRisk(input.raceTempF);
    factors.push(heatScore);
    if (heatScore.status === 'high') {
      mitigations.push(`Race temperature of ${input.raceTempF}°F increases glycogen burn rate. Increase fueling by 10-15g/hr and take water at every aid station.`);
    }
  }

  // Calculate weighted total
  const totalScore = Math.round(
    factors.reduce((sum, f) => sum + f.weightedScore, 0),
  );

  // Normalize to 0-100
  const normalizedScore = Math.min(100, Math.max(0, totalScore));
  const level = classifyRisk(normalizedScore);

  const summary = buildBonkSummary(normalizedScore, level, input, factors, mitigations);

  return {
    score: normalizedScore,
    level,
    factors,
    mitigations,
    summary,
  };
}

// ── Scoring Functions ─────────────────────────────────────────────────────────

function scoreLongestRun(miles: number): BonkRiskFactor {
  let score: number;
  if (miles >= 22) score = 10;
  else if (miles >= 20) score = 20;
  else if (miles >= 18) score = 40;
  else if (miles >= 16) score = 65;
  else score = 90;

  return {
    name: 'Longest Run',
    score,
    weight: WEIGHTS.longestRun,
    weightedScore: score * WEIGHTS.longestRun,
    status: score <= 30 ? 'low' : score <= 50 ? 'moderate' : 'high',
    detail: `${miles.toFixed(1)} miles (${score <= 30 ? '20+ recommended' : score <= 50 ? 'close to threshold' : 'under 18 miles increases risk'})`,
  };
}

function scoreLongRunCount(count: number): BonkRiskFactor {
  let score: number;
  if (count >= 5) score = 10;
  else if (count >= 4) score = 20;
  else if (count >= 3) score = 35;
  else if (count >= 2) score = 55;
  else if (count >= 1) score = 75;
  else score = 95;

  return {
    name: 'Runs ≥ 18 Miles',
    score,
    weight: WEIGHTS.longRunCount,
    weightedScore: score * WEIGHTS.longRunCount,
    status: score <= 30 ? 'low' : score <= 50 ? 'moderate' : 'high',
    detail: `${count} runs over 18 miles (4+ recommended)`,
  };
}

function scoreConsistency(planned: number, completed: number): BonkRiskFactor {
  const pct = planned > 0 ? (completed / planned) * 100 : 0;
  let score: number;
  if (pct >= 90) score = 10;
  else if (pct >= 75) score = 30;
  else if (pct >= 60) score = 55;
  else score = 85;

  return {
    name: 'Long Run Consistency',
    score,
    weight: WEIGHTS.consistency,
    weightedScore: score * WEIGHTS.consistency,
    status: score <= 30 ? 'low' : score <= 50 ? 'moderate' : 'high',
    detail: `${completed}/${planned} planned long runs completed (${Math.round(pct)}%)`,
  };
}

function scorePaceAggression(
  racePace: number,
  trainingPace: number,
  experience: string,
): BonkRiskFactor {
  // How much faster is race pace vs long run pace?
  const pctFaster = ((trainingPace - racePace) / trainingPace) * 100;

  let score: number;
  // Experienced runners can handle bigger gaps
  const threshold = experience === 'advanced' ? 12 : experience === 'intermediate' ? 8 : 5;

  if (pctFaster <= threshold * 0.5) score = 10;
  else if (pctFaster <= threshold) score = 30;
  else if (pctFaster <= threshold * 1.5) score = 60;
  else score = 90;

  const perMileDelta = Math.round(trainingPace - racePace);

  return {
    name: 'Pace Aggression',
    score,
    weight: WEIGHTS.paceAggression,
    weightedScore: score * WEIGHTS.paceAggression,
    status: score <= 30 ? 'low' : score <= 50 ? 'moderate' : 'high',
    detail: `Race pace is ${perMileDelta} sec/mi faster than long run pace (${pctFaster.toFixed(1)}% faster)`,
  };
}

function scoreFuelingPractice(
  practiced: boolean,
  fueledRuns?: number,
  totalLongRuns?: number,
): BonkRiskFactor {
  let score: number;
  if (!practiced) {
    score = 85;
  } else if (fueledRuns !== undefined && totalLongRuns && totalLongRuns > 0) {
    const pct = (fueledRuns / totalLongRuns) * 100;
    if (pct >= 75) score = 10;
    else if (pct >= 50) score = 30;
    else score = 55;
  } else {
    score = 25; // practiced but no detail
  }

  return {
    name: 'Fueling Practice',
    score,
    weight: WEIGHTS.fuelingPractice,
    weightedScore: score * WEIGHTS.fuelingPractice,
    status: score <= 30 ? 'low' : score <= 50 ? 'moderate' : 'high',
    detail: practiced
      ? `Practiced race nutrition${fueledRuns !== undefined ? ` on ${fueledRuns} long runs` : ''}`
      : 'No race-day nutrition practice',
  };
}

function scoreCarbLoading(loading: boolean, daysCompleted?: number): BonkRiskFactor {
  let score: number;
  if (!loading) {
    score = 70;
  } else if (daysCompleted !== undefined) {
    if (daysCompleted >= 3) score = 10;
    else if (daysCompleted >= 2) score = 30;
    else score = 50;
  } else {
    score = 20;
  }

  return {
    name: 'Carb Loading',
    score,
    weight: WEIGHTS.carbLoading,
    weightedScore: score * WEIGHTS.carbLoading,
    status: score <= 30 ? 'low' : score <= 50 ? 'moderate' : 'high',
    detail: loading
      ? `Carb loading${daysCompleted !== undefined ? `: ${daysCompleted}/3 days completed` : ' planned'}`
      : 'No carb loading planned',
  };
}

function scoreHeatRisk(tempF: number): BonkRiskFactor {
  let score: number;
  if (tempF <= 55) score = 10;
  else if (tempF <= 65) score = 30;
  else if (tempF <= 75) score = 60;
  else score = 90;

  return {
    name: 'Heat Risk',
    score,
    weight: WEIGHTS.heat,
    weightedScore: score * WEIGHTS.heat,
    status: score <= 30 ? 'low' : score <= 50 ? 'moderate' : 'high',
    detail: `Race temperature: ${tempF}°F${tempF > 65 ? ' — heat increases glycogen burn rate' : ''}`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyRisk(score: number): BonkRiskResult['level'] {
  if (score <= 25) return 'low';
  if (score <= 50) return 'moderate';
  if (score <= 75) return 'high';
  return 'very_high';
}

function buildBonkSummary(
  score: number,
  level: BonkRiskResult['level'],
  input: BonkRiskInput,
  factors: BonkRiskFactor[],
  mitigations: string[],
): string {
  const levelLabel = level.replace('_', ' ').toUpperCase();
  const highRiskFactors = factors.filter((f) => f.status === 'high').map((f) => f.name);

  let msg = `Bonk Risk: ${score}/100 (${levelLabel}).`;

  if (level === 'low') {
    msg += ` You've completed ${input.runsOver18Mi} runs over 18 miles and your target pace is within your comfortable long run range.`;
  } else if (highRiskFactors.length > 0) {
    msg += ` Key risk factors: ${highRiskFactors.join(', ')}.`;
    if (mitigations.length > 0) {
      msg += ` Top mitigation: ${mitigations[0]}`;
    }
  }

  return msg;
}
