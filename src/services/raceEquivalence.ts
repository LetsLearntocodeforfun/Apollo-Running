/**
 * Race Equivalence Engine — convert marathon performance across conditions.
 *
 * Based on peer-reviewed research:
 * - Temperature: Ely et al. (2007) — +1.5-2% per 10°F above 55°F for mid-pack runners
 * - Altitude: Péronnet et al. (1991) — +3% per 1000m above sea level
 * - Humidity: Maughan (2010) — +0.5% per 10% above 40% RH
 * - Wind: Davies (1981) — ±1-3% depending on sustained headwind/tailwind
 * - Course difficulty: elevation-based adjustment using USATF course measurement
 *
 * Allows fair comparison of results across different marathons and conditions.
 */

import type {
  RaceConditions,
  RaceEquivalenceResult,
  EquivalenceAdjustment,
} from '../types/nutrition';
import { formatTimeSec } from './racePrediction';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Ideal racing temperature (°F) */
const IDEAL_TEMP_F = 55;
/** Temperature impact: % per °F above ideal */
const TEMP_PCT_PER_F = 0.175; // ~1.75% per 10°F
/** Below ideal temp — minor benefit (cold has less impact than heat) */
const COLD_PCT_PER_F = 0.05;

/** Ideal humidity (%) */
const IDEAL_HUMIDITY = 40;
/** Humidity impact: % per % above ideal */
const HUMIDITY_PCT_PER_PCT = 0.05; // 0.5% per 10%

/** Wind impact: % per mph of sustained headwind */
const HEADWIND_PCT_PER_MPH = 0.15; // ~1.5% per 10mph
/** Tailwind benefit (less than headwind cost) */
const TAILWIND_PCT_PER_MPH = 0.07;

/** Altitude impact: % per 1000 ft above sea level */
const ALTITUDE_PCT_PER_1000FT = 0.91; // ~3% per 1000m ≈ 0.91% per 1000ft

/** Ideal conditions reference */
const IDEAL_CONDITIONS: RaceConditions = {
  tempF: IDEAL_TEMP_F,
  humidityPct: IDEAL_HUMIDITY,
  windMph: 0,
  altitudeFt: 0,
};

// ── Course Difficulty ─────────────────────────────────────────────────────────

export interface CourseAdjustment {
  /** Elevation gain in feet */
  elevationGainFt: number;
  /** Course difficulty (1-10) */
  difficulty: number;
  /** Net elevation change in feet */
  netElevationFt?: number;
}

// ── Core Calculation ──────────────────────────────────────────────────────────

/**
 * Convert a marathon time from actual conditions to ideal conditions.
 *
 * "What would your time have been at 55°F, flat, sea level, no wind?"
 */
export function normalizeToIdeal(
  actualTimeSec: number,
  actualConditions: RaceConditions,
  courseAdjustment?: CourseAdjustment,
): RaceEquivalenceResult {
  return convertBetweenConditions(
    actualTimeSec,
    actualConditions,
    IDEAL_CONDITIONS,
    courseAdjustment,
  );
}

/**
 * Convert a marathon time from one set of conditions to another.
 */
export function convertBetweenConditions(
  actualTimeSec: number,
  fromConditions: RaceConditions,
  toConditions: RaceConditions,
  courseAdjustment?: CourseAdjustment,
): RaceEquivalenceResult {
  const adjustments: EquivalenceAdjustment[] = [];
  let totalPctChange = 0;

  // Temperature adjustment
  const tempAdjustment = calculateTempAdjustment(fromConditions.tempF, toConditions.tempF);
  if (Math.abs(tempAdjustment.pctChange) >= 0.1) {
    adjustments.push(tempAdjustment);
    totalPctChange += tempAdjustment.pctChange;
  }

  // Humidity adjustment
  const humidityAdjustment = calculateHumidityAdjustment(
    fromConditions.humidityPct, toConditions.humidityPct,
  );
  if (Math.abs(humidityAdjustment.pctChange) >= 0.1) {
    adjustments.push(humidityAdjustment);
    totalPctChange += humidityAdjustment.pctChange;
  }

  // Wind adjustment
  if (fromConditions.windMph || toConditions.windMph) {
    const windAdjustment = calculateWindAdjustment(
      fromConditions.windMph ?? 0, toConditions.windMph ?? 0,
    );
    if (Math.abs(windAdjustment.pctChange) >= 0.1) {
      adjustments.push(windAdjustment);
      totalPctChange += windAdjustment.pctChange;
    }
  }

  // Altitude adjustment
  if (fromConditions.altitudeFt || toConditions.altitudeFt) {
    const altAdjustment = calculateAltitudeAdjustment(
      fromConditions.altitudeFt ?? 0, toConditions.altitudeFt ?? 0,
    );
    if (Math.abs(altAdjustment.pctChange) >= 0.1) {
      adjustments.push(altAdjustment);
      totalPctChange += altAdjustment.pctChange;
    }
  }

  // Course difficulty adjustment
  if (courseAdjustment && courseAdjustment.difficulty > 1) {
    const courseAdj = calculateCourseAdjustment(courseAdjustment);
    if (Math.abs(courseAdj.pctChange) >= 0.1) {
      adjustments.push(courseAdj);
      totalPctChange += courseAdj.pctChange;
    }
  }

  // Apply total adjustment
  const adjustedTimeSec = Math.round(actualTimeSec * (1 + totalPctChange / 100));
  const deltaSec = adjustedTimeSec - actualTimeSec;

  // Build description
  const fromDesc = describeConditions(fromConditions);
  const toDesc = describeConditions(toConditions);

  const summary = buildEquivalenceSummary(
    actualTimeSec, adjustedTimeSec, deltaSec, fromDesc, toDesc, adjustments,
  );

  return {
    originalTimeSec: actualTimeSec,
    originalConditions: fromDesc,
    adjustedTimeSec,
    adjustedTimeFormatted: formatTimeSec(adjustedTimeSec),
    deltaSec,
    adjustments,
    summary,
  };
}

// ── Individual Adjustments ────────────────────────────────────────────────────

function calculateTempAdjustment(fromTempF: number, toTempF: number): EquivalenceAdjustment {
  // Moving to cooler conditions = faster (negative pctChange)
  // Moving to warmer conditions = slower (positive pctChange)
  const fromPenalty = calculateTempPenalty(fromTempF);
  const toPenalty = calculateTempPenalty(toTempF);
  const pctChange = toPenalty - fromPenalty; // net change

  return {
    factor: 'Temperature',
    description: `${fromTempF}°F → ${toTempF}°F`,
    pctChange: Math.round(pctChange * 100) / 100,
    deltaSeconds: 0, // calculated at aggregate level
  };
}

function calculateTempPenalty(tempF: number): number {
  if (tempF <= IDEAL_TEMP_F) {
    // Cold: slight benefit but diminishing, cap at 45°F
    const coldDelta = Math.min(10, IDEAL_TEMP_F - tempF);
    return -coldDelta * COLD_PCT_PER_F;
  }
  // Heat penalty
  return (tempF - IDEAL_TEMP_F) * TEMP_PCT_PER_F;
}

function calculateHumidityAdjustment(fromH: number, toH: number): EquivalenceAdjustment {
  const fromPenalty = Math.max(0, (fromH - IDEAL_HUMIDITY)) * HUMIDITY_PCT_PER_PCT;
  const toPenalty = Math.max(0, (toH - IDEAL_HUMIDITY)) * HUMIDITY_PCT_PER_PCT;
  const pctChange = toPenalty - fromPenalty;

  return {
    factor: 'Humidity',
    description: `${fromH}% → ${toH}%`,
    pctChange: Math.round(pctChange * 100) / 100,
    deltaSeconds: 0,
  };
}

function calculateWindAdjustment(fromWind: number, toWind: number): EquivalenceAdjustment {
  // Assume headwind for simplicity (user can mark negative for tailwind)
  const fromPenalty = fromWind > 0 ? fromWind * HEADWIND_PCT_PER_MPH : Math.abs(fromWind) * TAILWIND_PCT_PER_MPH;
  const toPenalty = toWind > 0 ? toWind * HEADWIND_PCT_PER_MPH : Math.abs(toWind) * TAILWIND_PCT_PER_MPH;
  const pctChange = toPenalty - fromPenalty;

  return {
    factor: 'Wind',
    description: `${fromWind} mph → ${toWind} mph headwind`,
    pctChange: Math.round(pctChange * 100) / 100,
    deltaSeconds: 0,
  };
}

function calculateAltitudeAdjustment(fromAlt: number, toAlt: number): EquivalenceAdjustment {
  // Higher altitude = slower
  const fromPenalty = Math.max(0, fromAlt / 1000) * ALTITUDE_PCT_PER_1000FT;
  const toPenalty = Math.max(0, toAlt / 1000) * ALTITUDE_PCT_PER_1000FT;
  const pctChange = toPenalty - fromPenalty;

  return {
    factor: 'Altitude',
    description: `${fromAlt} ft → ${toAlt} ft`,
    pctChange: Math.round(pctChange * 100) / 100,
    deltaSeconds: 0,
  };
}

function calculateCourseAdjustment(course: CourseAdjustment): EquivalenceAdjustment {
  // Rough: ~0.3% per difficulty point above 1
  // More precise: ~1 sec/mile per 10 ft/mile of gain (Minetti, 2002)
  const pctFromDifficulty = (course.difficulty - 1) * 0.35;
  // Additional gain-based adjustment
  const gainPerMile = course.elevationGainFt / 26.2;
  const pctFromGain = gainPerMile * 0.01; // 1% per 100 ft/mi gain

  const totalPct = pctFromDifficulty + pctFromGain;

  return {
    factor: 'Course',
    description: `Difficulty ${course.difficulty}/10, ${course.elevationGainFt} ft gain`,
    pctChange: -Math.round(totalPct * 100) / 100, // removing course penalty = faster
    deltaSeconds: 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function describeConditions(c: RaceConditions): string {
  const parts = [`${c.tempF}°F`, `${c.humidityPct}% humidity`];
  if (c.windMph) parts.push(`${c.windMph} mph wind`);
  if (c.altitudeFt) parts.push(`${c.altitudeFt} ft altitude`);
  return parts.join(', ');
}

function buildEquivalenceSummary(
  originalSec: number,
  adjustedSec: number,
  deltaSec: number,
  fromDesc: string,
  toDesc: string,
  adjustments: EquivalenceAdjustment[],
): string {
  const original = formatTimeSec(originalSec);
  const adjusted = formatTimeSec(adjustedSec);
  const sign = deltaSec < 0 ? 'faster' : 'slower';
  const delta = formatTimeSec(Math.abs(deltaSec));

  return `Your ${original} (${fromDesc}) is equivalent to ${adjusted} in ${toDesc} — ${delta} ${sign}. Adjustments: ${adjustments.map((a) => `${a.factor}: ${a.pctChange > 0 ? '+' : ''}${a.pctChange}%`).join(', ')}.`;
}

// ── Quick Conversions ─────────────────────────────────────────────────────────

/**
 * Quick: normalize a marathon time to ideal conditions.
 */
export function normalizeMarathonTime(
  timeSec: number,
  tempF: number,
  humidityPct: number = 50,
  altitudeFt: number = 0,
): { normalizedSec: number; normalizedFormatted: string; message: string } {
  const result = normalizeToIdeal(timeSec, { tempF, humidityPct, altitudeFt });
  return {
    normalizedSec: result.adjustedTimeSec,
    normalizedFormatted: result.adjustedTimeFormatted,
    message: result.summary,
  };
}

/**
 * Quick: project what your time would be in specific race conditions.
 */
export function projectTimeInConditions(
  idealTimeSec: number,
  conditions: RaceConditions,
): { projectedSec: number; projectedFormatted: string; message: string } {
  const result = convertBetweenConditions(idealTimeSec, IDEAL_CONDITIONS, conditions);
  return {
    projectedSec: result.adjustedTimeSec,
    projectedFormatted: result.adjustedTimeFormatted,
    message: result.summary,
  };
}
