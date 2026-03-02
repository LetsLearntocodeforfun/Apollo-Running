/**
 * Carb Loading Protocol Generator — evidence-based 3-day carb loading
 * protocol with meal suggestions and race morning plan.
 *
 * Based on:
 * - Burke et al. (2011): 8-12g carbs/kg/day for 36-48h maximizes glycogen
 * - Hawley et al. (1997): Classic vs modified carb loading protocols
 * - Thomas et al. (2016): ACSM Nutrition and Athletic Performance position
 *
 * Protocol: 3-day ramp (8→10→12 g/kg/day) + race morning (2-3g/kg, 3h pre-start)
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
  lowFiber?: boolean; // Suitable for day-before/morning
}

const FOOD_DATABASE: FoodItem[] = [
  { name: 'Pasta (cooked)', carbsPerServing: 75, servingDescription: '2 cups', category: 'grain', mealTime: ['lunch', 'dinner'] },
  { name: 'White rice (cooked)', carbsPerServing: 45, servingDescription: '1 cup', category: 'grain', mealTime: ['lunch', 'dinner'], lowFiber: true },
  { name: 'Oatmeal', carbsPerServing: 60, servingDescription: '1.5 cups dry', category: 'grain', mealTime: ['breakfast'] },
  { name: 'Bagel (white)', carbsPerServing: 48, servingDescription: '1 large', category: 'grain', mealTime: ['breakfast', 'snack'], lowFiber: true },
  { name: 'Banana', carbsPerServing: 27, servingDescription: '1 medium', category: 'fruit', mealTime: ['breakfast', 'snack'], lowFiber: true },
  { name: 'Bread (white)', carbsPerServing: 26, servingDescription: '2 slices', category: 'grain', mealTime: ['breakfast', 'lunch'], lowFiber: true },
  { name: 'Pancakes', carbsPerServing: 58, servingDescription: '3 medium', category: 'grain', mealTime: ['breakfast'], lowFiber: true },
  { name: 'Honey', carbsPerServing: 17, servingDescription: '1 tbsp', category: 'snack', mealTime: ['breakfast', 'snack'], lowFiber: true },
  { name: 'Sports drink', carbsPerServing: 35, servingDescription: '500ml', category: 'drink', mealTime: ['snack'], lowFiber: true },
  { name: 'Orange juice', carbsPerServing: 26, servingDescription: '8 oz', category: 'drink', mealTime: ['breakfast'], lowFiber: true },
  { name: 'Pretzels', carbsPerServing: 45, servingDescription: '2 oz', category: 'snack', mealTime: ['snack'], lowFiber: true },
  { name: 'Sweet potato (baked)', carbsPerServing: 37, servingDescription: '1 medium', category: 'grain', mealTime: ['lunch', 'dinner'] },
  { name: 'Energy bar', carbsPerServing: 40, servingDescription: '1 bar', category: 'snack', mealTime: ['snack'] },
  { name: 'Jam/jelly', carbsPerServing: 13, servingDescription: '1 tbsp', category: 'snack', mealTime: ['breakfast', 'snack'], lowFiber: true },
  { name: 'Granola', carbsPerServing: 30, servingDescription: '1/2 cup', category: 'grain', mealTime: ['breakfast', 'snack'] },
  { name: 'Dried fruit mix', carbsPerServing: 33, servingDescription: '1/4 cup', category: 'fruit', mealTime: ['snack'] },
  { name: 'Toast with honey', carbsPerServing: 40, servingDescription: '2 slices + honey', category: 'grain', mealTime: ['breakfast'], lowFiber: true },
  { name: 'Rice cakes', carbsPerServing: 14, servingDescription: '2 cakes', category: 'snack', mealTime: ['snack'], lowFiber: true },
];

// ── Protocol Generator ────────────────────────────────────────────────────────

/** Carb targets per kg per day (g/kg) */
const DAY_TARGETS: Record<number, { carbsPerKg: number; intensity: CarbLoadingDay['intensity'] }> = {
  3: { carbsPerKg: 8, intensity: 'moderate' },
  2: { carbsPerKg: 10, intensity: 'high' },
  1: { carbsPerKg: 12, intensity: 'high' },
};
const RACE_MORNING_CARBS_PER_KG = 2.5;

/**
 * Generate a complete carb loading protocol for the days leading up to the race.
 */
export function generateCarbLoadingProtocol(
  athlete: AthleteProfile,
  raceDate: string,
): CarbLoadingProtocol {
  const { weightKg } = athlete;

  const days: CarbLoadingDay[] = [];
  let totalCarbTarget = 0;

  // Days 3, 2, 1 before race
  for (const daysBefore of [3, 2, 1]) {
    const target = DAY_TARGETS[daysBefore];
    const targetCarbsG = Math.round(target.carbsPerKg * weightKg);
    const targetCalories = Math.round(targetCarbsG * 4 * 1.3); // carbs = ~77% of calories

    const meals = buildDayMeals(targetCarbsG, daysBefore, daysBefore <= 1);

    const fiberGuidance = daysBefore <= 2
      ? 'Reduce fiber: choose white bread/rice over whole grain. Avoid raw vegetables and high-fiber cereals.'
      : 'Normal fiber intake is fine today.';

    const day: CarbLoadingDay = {
      daysBefore,
      intensity: target.intensity,
      targetCarbsG,
      carbsPerKg: target.carbsPerKg,
      targetCalories,
      meals,
      fiberGuidance,
    };

    days.push(day);
    totalCarbTarget += targetCarbsG;
  }

  // Race morning
  const raceMorningCarbsG = Math.round(RACE_MORNING_CARBS_PER_KG * weightKg);
  const raceMorning: CarbLoadingDay = {
    daysBefore: 0,
    intensity: 'race_morning',
    targetCarbsG: raceMorningCarbsG,
    carbsPerKg: RACE_MORNING_CARBS_PER_KG,
    targetCalories: Math.round(raceMorningCarbsG * 4 * 1.2),
    meals: buildRaceMorningMeals(raceMorningCarbsG),
    fiberGuidance: 'ZERO fiber. White bread, banana, honey, sports drink only. Avoid dairy, fat, and anything new.',
  };
  totalCarbTarget += raceMorningCarbsG;

  const summary = `${days.length}-day carb loading protocol for ${weightKg}kg athlete. `
    + `Daily targets: ${days.map((d) => `D-${d.daysBefore}: ${d.targetCarbsG}g`).join(', ')}. `
    + `Race morning: ${raceMorningCarbsG}g (3h pre-start). Total: ${totalCarbTarget}g.`;

  return {
    weightKg,
    raceDate,
    days,
    raceMorning,
    totalCarbTargetG: totalCarbTarget,
    summary,
  };
}

function buildDayMeals(targetCarbsG: number, _daysBefore: number, lowFiberOnly: boolean): MealSuggestion[] {
  const meals: MealSuggestion[] = [];
  let remaining = targetCarbsG;

  // Breakfast: ~25% of target
  const breakfastTarget = Math.round(targetCarbsG * 0.25);
  const breakfastFoods = selectFoods('breakfast', breakfastTarget, lowFiberOnly);
  meals.push({
    name: 'Breakfast',
    timing: '7:00 AM',
    carbsG: breakfastFoods.totalCarbs,
    description: breakfastFoods.description,
  });
  remaining -= breakfastFoods.totalCarbs;

  // Lunch: ~30%
  const lunchTarget = Math.round(targetCarbsG * 0.30);
  const lunchFoods = selectFoods('lunch', lunchTarget, lowFiberOnly);
  meals.push({
    name: 'Lunch',
    timing: '12:00 PM',
    carbsG: lunchFoods.totalCarbs,
    description: lunchFoods.description,
  });
  remaining -= lunchFoods.totalCarbs;

  // Dinner: ~30%
  const dinnerTarget = Math.round(targetCarbsG * 0.30);
  const dinnerFoods = selectFoods('dinner', dinnerTarget, lowFiberOnly);
  meals.push({
    name: 'Dinner',
    timing: '6:00 PM',
    carbsG: dinnerFoods.totalCarbs,
    description: dinnerFoods.description,
  });
  remaining -= dinnerFoods.totalCarbs;

  // Snacks: remainder
  if (remaining > 20) {
    const snackFoods = selectFoods('snack', remaining, lowFiberOnly);
    meals.push({
      name: 'Snacks (throughout day)',
      timing: 'Between meals',
      carbsG: snackFoods.totalCarbs,
      description: snackFoods.description,
    });
  }

  return meals;
}

function buildRaceMorningMeals(targetCarbsG: number): MealSuggestion[] {
  // Race morning: simple, tested foods only
  const items: string[] = [];
  let carbs = 0;

  // Bagel with honey
  items.push('1 white bagel with honey (65g carbs)');
  carbs += 65;

  // Banana
  if (carbs < targetCarbsG - 20) {
    items.push('1 banana (27g carbs)');
    carbs += 27;
  }

  // Sports drink
  if (carbs < targetCarbsG - 20) {
    items.push('500ml sports drink (35g carbs)');
    carbs += 35;
  }

  // Toast if needed
  if (carbs < targetCarbsG - 20) {
    items.push('2 slices white toast with jam (53g carbs)');
    carbs += 53;
  }

  return [{
    name: 'Pre-Race Meal',
    timing: '3 hours before start',
    carbsG: carbs,
    description: items.join(', '),
  }];
}

function selectFoods(
  mealTime: 'breakfast' | 'lunch' | 'dinner' | 'snack',
  targetCarbs: number,
  lowFiberOnly: boolean,
): { totalCarbs: number; description: string } {
  const eligible = FOOD_DATABASE.filter((f) =>
    f.mealTime.includes(mealTime) && (!lowFiberOnly || f.lowFiber !== false),
  );

  const selected: string[] = [];
  let totalCarbs = 0;

  // Greedily pick foods to get close to target
  for (const food of eligible) {
    if (totalCarbs >= targetCarbs) break;
    const servings = Math.min(
      Math.ceil((targetCarbs - totalCarbs) / food.carbsPerServing),
      2, // max 2 servings of any one item
    );
    const amount = servings * food.carbsPerServing;
    const desc = servings > 1
      ? `${servings}× ${food.servingDescription} ${food.name} (${amount}g)`
      : `${food.servingDescription} ${food.name} (${food.carbsPerServing}g)`;
    selected.push(desc);
    totalCarbs += amount;
  }

  return { totalCarbs, description: selected.join(', ') };
}

/**
 * Calculate daily carb target for a given day before the race.
 */
export function getDailyCarbTarget(weightKg: number, daysBefore: number): number {
  const target = DAY_TARGETS[daysBefore];
  if (!target) return Math.round(6 * weightKg); // default normal intake
  return Math.round(target.carbsPerKg * weightKg);
}

/**
 * Get race morning carb target.
 */
export function getRaceMorningCarbTarget(weightKg: number): number {
  return Math.round(RACE_MORNING_CARBS_PER_KG * weightKg);
}
