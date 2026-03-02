/**
 * Course-Specific Training Recommendations — auto-generated training
 * adaptations based on a marathon course profile.
 *
 * Provides specific workout recommendations for World Major courses
 * and generic recommendations based on elevation profile difficulty.
 */

import type { MarathonRace } from '../types/raceStrategy';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CourseTrainingPlan {
  raceName: string;
  difficulty: number;
  courseType: string;
  keyWorkouts: CourseWorkout[];
  weeklyGuidance: string[];
  taperNotes: string[];
  raceExecutionTips: string[];
}

export interface CourseWorkout {
  name: string;
  description: string;
  /** When to do this in the training cycle (weeks out from race) */
  weeksOut: string;
  /** Workout category */
  category: 'hill' | 'long_run' | 'tempo' | 'specific' | 'surface' | 'mental';
  /** Priority: 1=essential, 2=recommended, 3=nice-to-have */
  priority: 1 | 2 | 3;
}

// ── World Majors Recommendations ──────────────────────────────────────────────

const MAJOR_RECOMMENDATIONS: Record<string, Omit<CourseTrainingPlan, 'raceName' | 'difficulty' | 'courseType'>> = {
  'boston': {
    keyWorkouts: [
      { name: 'Newton Hills Simulation', description: 'Find a route with 3-4 consecutive hills in the last third of your long run. Run marathon pace on the uphills, don\'t brake on downhills. Simulates miles 16-21 (Heartbreak Hill).', weeksOut: '12-16', category: 'hill', priority: 1 },
      { name: 'Downhill Repeats', description: '6-8 × 800m downhill at marathon pace. Focus on quick turnover, leaning slightly forward. This prepares your quads for the 500+ ft of downhill in the first 16 miles.', weeksOut: '10-16', category: 'hill', priority: 1 },
      { name: 'Hilly Long Run', description: '18-20 miles on a hilly course. Run the last 6 miles at marathon pace. Boston has 4 hills between miles 16-21 — your long runs must include hills.', weeksOut: '8-14', category: 'long_run', priority: 1 },
      { name: 'Eccentric Quad Builder', description: 'Hill sprints down a moderate grade, walk back up. 10 × 200m. Strengthens quads eccentrically to prevent the quad-destroying downhill damage.', weeksOut: '14-20', category: 'hill', priority: 2 },
      { name: 'Negative Split Long Run', description: '16-18 miles: first 10 conservative, last 6-8 at MP. Boston rewards patience — the course runs downhill to Newton, then you must have legs for the hills.', weeksOut: '6-12', category: 'long_run', priority: 2 },
    ],
    weeklyGuidance: [
      'Include at least one hilly run per week. Boston has ~800 ft of climbing.',
      'Prioritize downhill training — most runners underestimate the quad damage from the first 16 miles of net downhill.',
      'Practice race-pace running on tired legs (hills + tempo in same session).',
      'Strengthen glutes and quads with lunges, step-downs, and single-leg squats.',
    ],
    taperNotes: [
      'Maintain one short hill session in taper week 1 to keep neuromuscular patterns fresh.',
      'Don\'t do any downhill training in the final 10 days — quads need full recovery.',
    ],
    raceExecutionTips: [
      'Bank time on the downhill start? NO. The quads you save in miles 1-16 determine miles 17-26.',
      'Run the tangents through the Newton hills — the course adds up if you run wide on turns.',
      'Heartbreak Hill (mile 20.5) is actually the 4th hill — don\'t spend all your energy on the first three.',
      'Wind from the west in the final miles is common. Tuck behind taller runners when possible.',
    ],
  },

  'nyc': {
    keyWorkouts: [
      { name: 'Bridge Repeat Simulation', description: '5 × 0.5 mi climb (4-6% grade) with descent recovery. Simulates NYC\'s 5 bridge crossings. Focus on maintaining effort, not pace, on the climbs.', weeksOut: '10-16', category: 'hill', priority: 1 },
      { name: 'Rolling Course Long Run', description: '18-20 miles on a rolling course. NYC is never truly flat — constant small elevation changes add up. Train your body to handle constant grade changes.', weeksOut: '8-14', category: 'long_run', priority: 1 },
      { name: 'Crowded Start Practice', description: 'Start a long run in a busy park or race. Practice patience in the first 3 miles when the Verrazzano Bridge is packed. Run by effort, not pace.', weeksOut: '6-10', category: 'mental', priority: 2 },
      { name: 'Fifth Avenue Tempo', description: '6-8 miles at marathon pace on a slight uphill. Miles 22-24 run up 5th Avenue with a gradual climb — practice running strong here.', weeksOut: '8-12', category: 'tempo', priority: 1 },
      { name: 'Central Park Finish Simulation', description: 'Run the last 4 miles of a long run with rolling hills. The Central Park finish has annoying small hills when you\'re most depleted.', weeksOut: '6-10', category: 'long_run', priority: 2 },
    ],
    weeklyGuidance: [
      'Train on rolling terrain at least twice per week. NYC has constant elevation changes.',
      'Practice bridge-style efforts: 0.5 mi hard climb followed by controlled descent.',
      'The course goes through 5 boroughs with very different vibes — practice mentally resetting.',
      'The Queensboro Bridge (mile 15-16) is silent — no crowds. Practice running strong without crowd energy.',
    ],
    taperNotes: [
      'Include one session with 3-4 short bridge-effort hills during taper week 1.',
      'The first wave starts on Staten Island early — adjust sleep schedule beforehand.',
    ],
    raceExecutionTips: [
      'The Verrazzano Bridge start is DOWNHILL — resist the urge to fly. Groups go out too fast.',
      'Miles 1-3 are pure downhill off the bridge. Bank zero time here.',
      'Queensboro Bridge (mile 15-16): silence + uphill = danger zone. Stay disciplined.',
      'Fifth Avenue (miles 22-24) is a subtle uphill that feels like a wall on tired legs.',
      'Central Park\'s rolling hills in the last 2 miles are deceptively tough — save something.',
    ],
  },

  'berlin': {
    keyWorkouts: [
      { name: 'Pace Lock Tempo', description: '8-10 miles at exact marathon pace. Practice metronome pacing — Berlin rewards consistency. Vary pace by no more than 5 sec/mile.', weeksOut: '8-14', category: 'tempo', priority: 1 },
      { name: 'Flat Long Run at MP', description: '20 miles with final 10 at marathon pace on flat terrain. Berlin is about sustaining pace — this is your key workout.', weeksOut: '6-10', category: 'long_run', priority: 1 },
      { name: 'Pace Discipline Intervals', description: '6 × 1 mile at marathon pace with 1 min jog. Each rep must be within 3 seconds of target. This is pacing school.', weeksOut: '10-16', category: 'tempo', priority: 1 },
      { name: 'Negative Split Practice', description: '16 miles: first 8 at MP+10 sec, last 8 at MP-5 sec. Berlin\'s flat profile rewards negative splitting.', weeksOut: '6-12', category: 'long_run', priority: 2 },
    ],
    weeklyGuidance: [
      'Focus on pace consistency above everything. Berlin is the flattest World Major.',
      'Train on flat courses for your key workouts. Eliminate variables.',
      'Tempo runs at exactly marathon pace are more valuable than faster intervals for Berlin.',
      'Practice surging past aid stations — Berlin\'s aid stations can cause pace disruption.',
    ],
    taperNotes: [
      'Maintain pace-feel with 2-3 short marathon-pace pickups during taper.',
      'Berlin in late September can be warm (60-70°F) — check forecast and adjust pace if needed.',
    ],
    raceExecutionTips: [
      'The field goes out FAST. Ignore them. Your pace is your pace.',
      'Aid stations every 5K — practice grabbing cups at pace without stopping.',
      'The course is flat but has several 90-degree turns that disrupt rhythm. Anticipate and recover quickly.',
      'At mile 24, you pass near the Brandenburg Gate but must loop before the finish — don\'t celebrate early.',
    ],
  },

  'chicago': {
    keyWorkouts: [
      { name: 'Headwind Tempo', description: '6-8 miles at marathon pace into the wind. Chicago\'s lakefront exposure means wind is a factor. Practice maintaining effort when pace drops.', weeksOut: '8-14', category: 'specific', priority: 1 },
      { name: 'Flat Pace Marathon Long Run', description: '20 miles on flat terrain at marathon pace for the last 12. Chicago is fast and flat — train for exactly that.', weeksOut: '6-10', category: 'long_run', priority: 1 },
      { name: 'Drafting Practice', description: 'Run a long run or tempo with a group. Practice sitting behind taller runners to reduce wind drag. This is a real race strategy for Chicago.', weeksOut: '8-14', category: 'specific', priority: 2 },
      { name: 'Heat Adaptation', description: 'October can surprise with 60-75°F temps. Do 2-3 long runs in warmer conditions. Adjust pace +5-10 sec/mi and practice hydration.', weeksOut: '10-16', category: 'specific', priority: 2 },
    ],
    weeklyGuidance: [
      'Train on flat terrain. Chicago has virtually zero elevation gain.',
      'Practice running into headwind — the lakefront sections are exposed.',
      'Chicago is a PR course — focus on pace consistency and fast flat-ground running.',
      'Consider a drafting strategy if running with a pace group.',
    ],
    taperNotes: [
      'Check the forecast — October weather in Chicago varies widely (40-75°F).',
      'The start is at Grant Park with a massive field — arrive early for your corral.',
    ],
    raceExecutionTips: [
      'Mile 1 is packed — don\'t weave. Settle in and find your rhythm.',
      'Chinatown (miles 21-22) can feel lonely with fewer crowds. Stay focused.',
      'The finish back to Grant Park often has a southwest headwind — save energy for this.',
      'This is one of the best BQ courses — execute your plan precisely.',
    ],
  },

  'tokyo': {
    keyWorkouts: [
      { name: 'Flat Speed-Pace Long Run', description: '18-20 miles with last 8 at marathon pace. Tokyo is fast and flat — train for sustained pace on flat ground.', weeksOut: '6-12', category: 'long_run', priority: 1 },
      { name: 'Cool-to-Warm Transition Run', description: 'Start a long run at 40°F and finish as it warms to 50-55°F. March Tokyo can start cold and warm up — practice adjusting layers and pace.', weeksOut: '8-14', category: 'specific', priority: 2 },
      { name: 'Pace Consistency Tempo', description: '8 miles at exact marathon pace. Tokyo rewards even splits on its flat profile.', weeksOut: '8-14', category: 'tempo', priority: 1 },
    ],
    weeklyGuidance: [
      'Tokyo is one of the flattest World Majors — train for sustained effort.',
      'March weather is variable (38-52°F, possible rain). Prepare for all conditions.',
      'Practice fueling with Japanese aid station offerings or bring your own.',
      'Jet lag from Western countries is significant — arrive 4-5 days early.',
    ],
    taperNotes: [
      'Account for jet lag in your taper — you may need extra rest days.',
      'The start is at 9:10 AM — practice running at that time of day.',
    ],
    raceExecutionTips: [
      'Security is thorough — arrive at the start extra early.',
      'The final miles along the waterfront can have a headwind off Tokyo Bay.',
      'Crowd support is enthusiastic but different from Western marathons — enjoy the bowing spectators.',
      'Tokyo is net downhill — use the slight gradient but don\'t overdo early miles.',
    ],
  },

  'london': {
    keyWorkouts: [
      { name: 'Varied Surface Long Run', description: '18 miles incorporating cobblestone, concrete, and asphalt sections. London has cobblestones near Tower Bridge and Greenwich — prepare your feet.', weeksOut: '8-14', category: 'surface', priority: 1 },
      { name: 'Flat Tempo with Pace Lock', description: '8 miles at marathon pace on a flat course. London is predominantly flat — train for pace consistency.', weeksOut: '8-14', category: 'tempo', priority: 1 },
      { name: 'Thames Embankment Simulation', description: '6 miles at marathon pace along a river or exposed flat area. The Thames section can be windy — practice running exposed.', weeksOut: '6-12', category: 'specific', priority: 2 },
    ],
    weeklyGuidance: [
      'London is mostly flat with one significant climb at mile 3 (Shooters Hill area).',
      'Practice on varied surfaces — cobblestone sections can disrupt rhythm.',
      'April weather is unpredictable (45-60°F, possible rain). Train in both cool and mild conditions.',
      'The course is a loop starting and finishing near Buckingham Palace — study the turns.',
    ],
    taperNotes: [
      'London ballot stress is over — trust your training and enjoy the build-up.',
      'The start is split between blue, red, and green starts that merge — know your start.',
    ],
    raceExecutionTips: [
      'Three different starts merge into one course around mile 3 — expect congestion.',
      'Tower Bridge (mile 12) is an emotional high — don\'t surge.',
      'The Docklands section (miles 14-21) can feel quiet after Tower Bridge — stay disciplined.',
      'The final stretch down The Mall to Buckingham Palace is flat and fast — finish strong.',
    ],
  },
};

// ── Core Generator ────────────────────────────────────────────────────────────

/**
 * Generate course-specific training recommendations for a marathon.
 */
export function generateCourseTraining(race: MarathonRace): CourseTrainingPlan {
  // Check if we have specific recommendations for this race
  const raceKey = identifyMajor(race);

  if (raceKey && MAJOR_RECOMMENDATIONS[raceKey]) {
    const specific = MAJOR_RECOMMENDATIONS[raceKey];
    return {
      raceName: race.name,
      difficulty: race.course.difficulty,
      courseType: race.courseType,
      ...specific,
    };
  }

  // Generate generic recommendations based on course profile
  return generateGenericPlan(race);
}

/**
 * Get just the key workouts for a race (lighter API).
 */
export function getKeyWorkouts(race: MarathonRace): CourseWorkout[] {
  const plan = generateCourseTraining(race);
  return plan.keyWorkouts.sort((a, b) => a.priority - b.priority);
}

// ── Generic Generator ─────────────────────────────────────────────────────────

function generateGenericPlan(race: MarathonRace): CourseTrainingPlan {
  const d = race.course.difficulty;
  const gain = race.course.totalGainFt;
  const workouts: CourseWorkout[] = [];
  const guidance: string[] = [];
  const taperNotes: string[] = [];
  const tips: string[] = [];

  if (d >= 6 || gain >= 1000) {
    // Hilly course
    workouts.push(
      { name: 'Hill Repeat Long Run', description: `18-20 miles with ${Math.round(gain * 0.5)} ft of climbing. Focus on effort-based pacing on uphills and controlled descents.`, weeksOut: '8-14', category: 'hill', priority: 1 },
      { name: 'Downhill Training', description: 'Dedicated downhill repeats to prepare quads for eccentric loading. 6-8 × 400-800m downhill at marathon effort.', weeksOut: '10-16', category: 'hill', priority: 1 },
      { name: 'Hill Strength Session', description: 'Hill sprints: 8-10 × 200m uphill at 5K effort, jog down. Builds power for the climbs.', weeksOut: '12-20', category: 'hill', priority: 2 },
    );
    guidance.push(
      `This is a challenging course with ${gain} ft of climbing. Hill training is essential.`,
      'Run by effort, not pace, on hills. Expect pace to vary 15-30 sec/mi on significant climbs.',
      'Strengthen quads, glutes, and calves with hill-specific strength work.',
    );
    tips.push(
      'Don\'t try to maintain flat-ground pace on uphills — run even effort instead.',
      'Gravity is free on downhills, but don\'t brake — lean slightly forward and increase cadence.',
    );
  } else if (d <= 3) {
    // Flat course
    workouts.push(
      { name: 'Pace Consistency Long Run', description: '20 miles with even splits. On a flat course, pace discipline is everything. Each mile within 5 sec of target.', weeksOut: '6-12', category: 'long_run', priority: 1 },
      { name: 'Marathon Pace Tempo', description: '8-10 miles at exact marathon pace. Flat courses reward metronomic pacing.', weeksOut: '8-14', category: 'tempo', priority: 1 },
    );
    guidance.push(
      'Flat course — focus on pace consistency and negative splitting.',
      'Spend most tempo work at exactly marathon pace, not faster.',
    );
    tips.push(
      'Resist the urge to go out fast on a flat course — the field will pull you.',
      'Even splits or slight negative split is the optimal strategy here.',
    );
  } else {
    // Moderate course
    workouts.push(
      { name: 'Mixed Terrain Long Run', description: '18-20 miles incorporating both flat and rolling sections. Practice transitioning between flat running and hills.', weeksOut: '8-14', category: 'long_run', priority: 1 },
      { name: 'Hill Tempo', description: '6 miles at marathon pace on a route with moderate hills. Practice maintaining effort over varied terrain.', weeksOut: '8-12', category: 'tempo', priority: 1 },
    );
    guidance.push(
      'Moderate course difficulty — include some hill training but don\'t overdo it.',
      'Practice effort-based pacing: keep effort consistent even when pace varies on hills.',
    );
  }

  // Common guidance
  taperNotes.push(
    'Maintain race-specific neuromuscular patterns with short pickups during taper.',
    'Study the course map and elevation profile before race day.',
  );
  tips.push(
    'Know where the aid stations are and practice your fueling at race pace.',
    `Course difficulty: ${d}/10. ${d >= 5 ? 'Adjust your time goal by +2-4% versus a flat course.' : 'This course is suitable for a strong effort.'}`,
  );

  return {
    raceName: race.name,
    difficulty: d,
    courseType: race.courseType,
    keyWorkouts: workouts,
    weeklyGuidance: guidance,
    taperNotes,
    raceExecutionTips: tips,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function identifyMajor(race: MarathonRace): string | null {
  const nameLC = race.name.toLowerCase();
  const cityLC = race.city.toLowerCase();

  if (nameLC.includes('boston') || cityLC === 'boston') return 'boston';
  if (nameLC.includes('new york') || nameLC.includes('nyc') || cityLC === 'new york') return 'nyc';
  if (nameLC.includes('berlin') || cityLC === 'berlin') return 'berlin';
  if (nameLC.includes('chicago') || cityLC === 'chicago') return 'chicago';
  if (nameLC.includes('tokyo') || cityLC === 'tokyo') return 'tokyo';
  if (nameLC.includes('london') || cityLC === 'london') return 'london';
  return null;
}
