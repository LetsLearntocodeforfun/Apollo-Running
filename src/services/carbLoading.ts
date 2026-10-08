/**
 * Carb Loading Protocol Generator — evidence-based carb loading for the final
 * 36–48 h before a race, with meal suggestions and a race morning plan.
 *
 * Based on:
 * - Burke et al. (2011) and Thomas, Erdman & Burke (ACSM 2016): 10–12 g carbs/kg/day
 *   for the 36–48 h before events longer than ~90 min maximizes glycogen
 * - Hawley et al. (1997): Classic vs modified carb loading protocols
 * - Thomas et al. (2016): ACSM Nutrition and Athletic Performance position
 *   (pre-event meal 1–4 g/kg, 1–4 h before)
 *
 * Protocol (v1.0.6): D-2 and D-1 at the selected loading target (8 / 10 / 12
 * g/kg/day, default 10), an optional D-3 lead-in (≤ 8 g/kg), and race morning
 * (2.5 g/kg, ~3 h pre-start). Targets use at most 90 kg of body mass: glycogen
 * storage tracks muscle mass, not total body weight.
 */

import type {
  AthleteProfile,
  CarbLoadingProtocol,
  CarbLoadingDay,
  MealSuggestion,
} from '../types/nutrition';

// ── Food Database ─────────────────────────────────────────────────────────────

interface FoodItem {
  name: string;
  carbsPerServing: number;
  servingDescription: string;
  category: 'grain' | 'fruit' | 'drink' | 'snack' | 'meal';
  mealTime: ('breakfast' | 'lunch' | 'dinner' | 'snack')[];
  /** true = suitable for low-fiber days (D-2, D-1, race morning); false = high fiber. */
  lowFiber: boolean;
}

const FOOD_DATABASE: FoodItem[] = [
  { name: 'Pasta (white, cooked)', carbsPerServing: 75, servingDescription: '2 cups', category: 'grain', mealTime: ['lunch', 'dinner'], lowFiber: true },
  { name: 'White rice (cooked)', carbsPerServing: 45, servingDescription: '1 cup', category: 'grain', mealTime: ['lunch', 'dinner'], lowFiber: true },
  { name: 'Oatmeal', carbsPerServing: 54, servingDescription: '1 cup dry', category: 'grain', mealTime: ['breakfast'], lowFiber: false },
  { name: 'Bagel (white)', carbsPerServing: 48, servingDescription: '1 large', category: 'grain', mealTime: ['breakfast', 'snack'], lowFiber: true },
  { name: 'Banana', carbsPerServing: 27, servingDescription: '1 medium', category: 'fruit', mealTime: ['breakfast', 'snack'], lowFiber: true },
  { name: 'Bread (white)', carbsPerServing: 26, servingDescription: '2 slices', category: 'grain', mealTime: ['breakfast', 'lunch'], lowFiber: true },
  { name: 'Pancakes', carbsPerServing: 58, servingDescription: '3 medium', category: 'grain', mealTime: ['breakfast'], lowFiber: true },
  { name: 'Honey', carbsPerServing: 17, servingDescription: '1 tbsp', category: 'snack', mealTime: ['breakfast', 'snack'], lowFiber: true },
  { name: 'Sports drink', carbsPerServing: 35, servingDescription: '500 ml', category: 'drink', mealTime: ['snack'], lowFiber: true },
  { name: 'Orange juice', carbsPerServing: 26, servingDescription: '250 ml', category: 'drink', mealTime: ['breakfast', 'lunch', 'dinner'], lowFiber: true },
  { name: 'Pretzels', carbsPerServing: 45, servingDescription: '60 g', category: 'snack', mealTime: ['snack'], lowFiber: true },
  { name: 'Sweet potato (baked)', carbsPerServing: 37, servingDescription: '1 medium', category: 'grain', mealTime: ['lunch', 'dinner'], lowFiber: false },
  { name: 'Energy bar', carbsPerServing: 40, servingDescription: '1 bar', category: 'snack', mealTime: ['snack'], lowFiber: false },
  { name: 'Jam/jelly', carbsPerServing: 13, servingDescription: '1 tbsp', category: 'snack', mealTime: ['breakfast', 'snack'], lowFiber: true },
  { name: 'Granola', carbsPerServing: 30, servingDescription: '1/2 cup', category: 'grain', mealTime: ['breakfast', 'snack'], lowFiber: false },
  { name: 'Dried fruit mix', carbsPerServing: 33, servingDescription: '1/4 cup', category: 'fruit', mealTime: ['snack'], lowFiber: false },
  { name: 'Toast with honey', carbsPerServing: 40, servingDescription: '2 slices + honey', category: 'grain', mealTime: ['breakfast'], lowFiber: true },
  { name: 'Rice cakes', carbsPerServing: 14, servingDescription: '2 cakes', category: 'snack', mealTime: ['snack'], lowFiber: true },
];

const FOOD_BY_NAME = new Map(FOOD_DATABASE.map((f) => [f.name, f]));

// ── Targets ───────────────────────────────────────────────────────────────────

/** Loading-day targets the UI offers (g/kg/day). */
export const CARB_LOAD_G_PER_KG_OPTIONS: readonly number[] = [8, 10, 12];
/** Default loading-day target (g/kg/day) — Burke 2011 / ACSM 2016. */
export const DEFAULT_CARB_LOAD_G_PER_KG = 10;
/** Targets use at most this body mass (kg). */
export const CARB_LOAD_MASS_CAP_KG = 90;
/** Optional D-3 lead-in ceiling (g/kg/day). */
const LEAD_IN_G_PER_KG = 8;
/** Days outside the loading window (g/kg/day). */
const NORMAL_DAY_G_PER_KG = 6;
const RACE_MORNING_CARBS_PER_KG = 2.5;
const MAX_SERVINGS_PER_FOOD = 2;
const RACE_MORNING_TOLERANCE_G = 10;

export interface CarbLoadingOptions {
  /** Loading-day target for the final 36–48 h (g/kg/day, 8–12). Default 10. */
  carbsPerKg?: number;
  /** Include the optional D-3 lead-in day. Default true. */
  includeDay3?: boolean;
}

function isValidWeight(weightKg: number | undefined): weightKg is number {
  return typeof weightKg === 'number' && Number.isFinite(weightKg) && weightKg > 0;
}

/** Body mass the g/kg targets use: capped at {@link CARB_LOAD_MASS_CAP_KG}. */
function effectiveMassKg(weightKg: number): number {
  return Math.min(weightKg, CARB_LOAD_MASS_CAP_KG);
}

/** Clamp a requested loading target to 8–12 g/kg/day (default 10). */
function normalizeCarbsPerKg(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CARB_LOAD_G_PER_KG;
  return Math.min(12, Math.max(8, value));
}

/** g/kg for a day: loading days (D-2, D-1), the optional D-3 lead-in, or a normal day. */
function dayCarbsPerKg(daysBefore: number, loadPerKg: number): number {
  if (daysBefore === 1 || daysBefore === 2) return loadPerKg;
  if (daysBefore === 3) return Math.min(LEAD_IN_G_PER_KG, loadPerKg);
  return NORMAL_DAY_G_PER_KG;
}

// ── Protocol Generator ────────────────────────────────────────────────────────

/**
 * Generate a carb loading protocol for the days leading up to the race.
 * Invalid body mass (0, negative, NaN) yields an empty protocol with a note.
 */
export function generateCarbLoadingProtocol(
  athlete: AthleteProfile,
  raceDate: string,
  options: CarbLoadingOptions = {},
): CarbLoadingProtocol {
  const carbsPerKg = normalizeCarbsPerKg(options.carbsPerKg);
  const { weightKg } = athlete;

  if (!isValidWeight(weightKg)) {
    const message = 'Add your body mass to get carb-loading targets.';
    return {
      weightKg: 0,
      raceDate,
      days: [],
      raceMorning: buildRaceMorningDay(0),
      totalCarbTargetG: 0,
      summary: message,
      carbsPerKg,
      effectiveMassKg: 0,
      massCapped: false,
      notes: [message],
    };
  }

  const massKg = effectiveMassKg(weightKg);
  const days: CarbLoadingDay[] = [];
  let totalCarbTarget = 0;

  for (const daysBefore of options.includeDay3 === false ? [2, 1] : [3, 2, 1]) {
    const perKg = dayCarbsPerKg(daysBefore, carbsPerKg);
    const targetCarbsG = Math.round(perKg * massKg);
    const lowFiberOnly = daysBefore <= 2; // N-12: low-fiber food from D-2, matching the guidance
    days.push({
      daysBefore,
      intensity: daysBefore === 3 ? 'moderate' : 'high',
      targetCarbsG,
      carbsPerKg: perKg,
      targetCalories: Math.round(targetCarbsG * 4 * 1.3), // carbs = ~77% of calories
      meals: buildDayMeals(targetCarbsG, lowFiberOnly),
      fiberGuidance: lowFiberOnly
        ? 'Reduce fiber: choose white bread/rice over whole grain. Avoid raw vegetables and high-fiber cereals.'
        : 'Normal fiber intake is fine today.',
      ...(daysBefore === 3 ? { optional: true } : {}),
    });
    totalCarbTarget += targetCarbsG;
  }

  const raceMorning = buildRaceMorningDay(massKg);
  totalCarbTarget += raceMorning.targetCarbsG;

  const notes = [
    'Burke et al. 2011 / ACSM 2016: 10–12 g carbs per kg per day for the final 36–48 h before races longer than ~90 min.',
  ];
  if (athlete.sex === 'female') {
    notes.push('Eat enough total energy as well as carbs — glycogen supercompensation is smaller when overall intake is low.');
  }

  const summary = `${days.length}-day carb loading protocol at ${carbsPerKg} g/kg/day. `
    + `Daily targets: ${days.map((d) => `D-${d.daysBefore}: ${d.targetCarbsG}g`).join(', ')}. `
    + `Race morning: ${raceMorning.targetCarbsG}g (about 3 h before the start). Total: ${totalCarbTarget}g.`;

  return {
    weightKg,
    raceDate,
    days,
    raceMorning,
    totalCarbTargetG: totalCarbTarget,
    summary,
    carbsPerKg,
    effectiveMassKg: massKg,
    massCapped: weightKg > CARB_LOAD_MASS_CAP_KG,
    notes,
  };
}

function buildDayMeals(targetCarbsG: number, lowFiberOnly: boolean): MealSuggestion[] {
  const meals: MealSuggestion[] = [];
  let remaining = targetCarbsG;
  const plan: { name: string; timing: string; mealTime: FoodItem['mealTime'][number]; share: number }[] = [
    { name: 'Breakfast', timing: 'Morning', mealTime: 'breakfast', share: 0.25 },
    { name: 'Lunch', timing: 'Midday', mealTime: 'lunch', share: 0.30 },
    { name: 'Dinner', timing: 'Evening', mealTime: 'dinner', share: 0.30 },
  ];

  for (const slot of plan) {
    const foods = selectFoods(slot.mealTime, Math.round(targetCarbsG * slot.share), lowFiberOnly);
    if (foods.totalCarbs <= 0) continue;
    meals.push({ name: slot.name, timing: slot.timing, carbsG: foods.totalCarbs, description: foods.description });
    remaining -= foods.totalCarbs;
  }

  // Snacks: remainder
  if (remaining > 20) {
    const snackFoods = selectFoods('snack', remaining, lowFiberOnly);
    if (snackFoods.totalCarbs > 0) {
      meals.push({
        name: 'Snacks (throughout day)',
        timing: 'Between meals',
        carbsG: snackFoods.totalCarbs,
        description: snackFoods.description,
      });
    }
  }

  return meals;
}

function describeServings(food: FoodItem, servings: number): string {
  const amount = servings * food.carbsPerServing;
  return servings > 1
    ? `${servings}× ${food.servingDescription} ${food.name} (${amount}g)`
    : `${food.servingDescription} ${food.name} (${amount}g)`;
}

function describeSelection(servings: Map<FoodItem, number>): string {
  return [...servings].map(([food, n]) => describeServings(food, n)).join(', ');
}

/**
 * Pick foods for a meal up to `targetCarbs`: variety first (each food once
 * before any second serving), then the serving that best fits what is left.
 * On low-fiber days only foods marked `lowFiber: true` qualify (N-11).
 */
function selectFoods(
  mealTime: 'breakfast' | 'lunch' | 'dinner' | 'snack',
  targetCarbs: number,
  lowFiberOnly: boolean,
): { totalCarbs: number; description: string } {
  const eligible = FOOD_DATABASE.filter((f) =>
    f.mealTime.includes(mealTime) && (!lowFiberOnly || f.lowFiber === true),
  );

  const servings = new Map<FoodItem, number>();
  let totalCarbs = 0;
  for (let guard = 0; guard < 40; guard++) {
    const remaining = targetCarbs - totalCarbs;
    if (remaining <= 5) break;
    let best: FoodItem | null = null;
    let bestScore = Infinity;
    for (const food of eligible) {
      const used = servings.get(food) ?? 0;
      if (used >= MAX_SERVINGS_PER_FOOD) continue;
      const score = used * 1000 + Math.abs(remaining - food.carbsPerServing);
      if (score < bestScore) {
        best = food;
        bestScore = score;
      }
    }
    if (!best) break;
    servings.set(best, (servings.get(best) ?? 0) + 1);
    totalCarbs += best.carbsPerServing;
  }

  return { totalCarbs, description: describeSelection(servings) };
}

/** Race-morning foods in order of preference, with serving limits (all low fiber). */
const RACE_MORNING_CHOICES: { name: string; max: number }[] = [
  { name: 'Bagel (white)', max: 1 },
  { name: 'Honey', max: 2 },
  { name: 'Banana', max: 1 },
  { name: 'Sports drink', max: 1 },
  { name: 'Bread (white)', max: 1 },
  { name: 'Jam/jelly', max: 2 },
  { name: 'Orange juice', max: 1 },
  { name: 'Bagel (white)', max: 1 },
  { name: 'Rice cakes', max: 2 },
];

/**
 * Race-morning meal built from the food database up to the target (N-13),
 * with a shortfall warning when the simple foods can't reach it.
 */
function buildRaceMorningDay(massKg: number): CarbLoadingDay {
  const targetCarbsG = Math.round(RACE_MORNING_CARBS_PER_KG * massKg);
  const servings = new Map<FoodItem, number>();
  let carbs = 0;
  for (const choice of RACE_MORNING_CHOICES) {
    const food = FOOD_BY_NAME.get(choice.name);
    if (!food) continue;
    for (let i = 0; i < choice.max; i++) {
      if (carbs >= targetCarbsG - RACE_MORNING_TOLERANCE_G) break;
      if (carbs + food.carbsPerServing > targetCarbsG + RACE_MORNING_TOLERANCE_G) break;
      servings.set(food, (servings.get(food) ?? 0) + 1);
      carbs += food.carbsPerServing;
    }
  }

  const shortfallG = Math.max(0, targetCarbsG - carbs);
  const hasShortfall = targetCarbsG > 0 && shortfallG > RACE_MORNING_TOLERANCE_G;
  return {
    daysBefore: 0,
    intensity: 'race_morning',
    targetCarbsG,
    carbsPerKg: RACE_MORNING_CARBS_PER_KG,
    targetCalories: Math.round(targetCarbsG * 4 * 1.2),
    meals: carbs > 0
      ? [{ name: 'Pre-Race Meal', timing: '3 hours before start', carbsG: carbs, description: describeSelection(servings) }]
      : [],
    fiberGuidance: 'Low fiber, low fat: white bread or bagel, banana, honey, sports drink. Nothing new on race day.',
    ...(hasShortfall
      ? {
        shortfallG,
        warning: `These foods reach ${carbs} g of your ${targetCarbsG} g target — top up with a sports drink or a gel in the hour before the start.`,
      }
      : {}),
  };
}

/**
 * Daily carb target (g) for a day before the race: D-2/D-1 at `carbsPerKg`
 * (default 10 g/kg/day), D-3 lead-in at ≤ 8 g/kg, other days 6 g/kg.
 * Uses at most 90 kg of body mass; invalid weight → 0.
 */
export function getDailyCarbTarget(
  weightKg: number,
  daysBefore: number,
  carbsPerKg: number = DEFAULT_CARB_LOAD_G_PER_KG,
): number {
  if (!isValidWeight(weightKg)) return 0;
  return Math.round(dayCarbsPerKg(daysBefore, normalizeCarbsPerKg(carbsPerKg)) * effectiveMassKg(weightKg));
}

/**
 * Get race morning carb target (2.5 g/kg, at most 90 kg of body mass; invalid weight → 0).
 */
export function getRaceMorningCarbTarget(weightKg: number): number {
  if (!isValidWeight(weightKg)) return 0;
  return Math.round(RACE_MORNING_CARBS_PER_KG * effectiveMassKg(weightKg));
}
