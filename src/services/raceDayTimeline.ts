/**
 * Race Day Timeline Generator — complete timeline from alarm to finish line.
 *
 * Integrates with carb loading (4A.3), fueling calculator (4A.4),
 * and race strategy for a comprehensive race day schedule.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RaceDayInput {
  /** Race start time, e.g. "07:00" (24h format) */
  raceStartTime: string;
  /** Travel time to venue in minutes */
  travelMinutes: number;
  /** Pre-race meal preference */
  mealPreference: 'light' | 'moderate' | 'full';
  /** Athlete weight in kg (for carb targets) */
  weightKg: number;
  /** Projected finish time in seconds */
  projectedFinishSec: number;
  /** Race name */
  raceName: string;
  /** Gel/fueling items count for race */
  fuelingItemsCount?: number;
  /** Whether athlete wants a warmup jog */
  includeWarmup?: boolean;
}

export interface TimelineEvent {
  /** Time string, e.g. "04:30 AM" */
  time: string;
  /** Event title */
  title: string;
  /** Detailed description */
  description: string;
  /** Category for grouping/styling */
  category: 'wake' | 'nutrition' | 'logistics' | 'warmup' | 'race' | 'fueling' | 'milestone';
  /** Minutes before race start (negative = after start) */
  minutesBeforeStart: number;
}

export interface RaceDayTimeline {
  raceName: string;
  raceDate?: string;
  events: TimelineEvent[];
  /** Plain text export of the timeline */
  textExport: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BREAKFAST_HOURS_BEFORE = 3;
const HYDRATION_START_HOURS = 2.5;
const GEAR_CHECK_MINUTES = 45;
const WARMUP_MINUTES = 15;
const CORRAL_MINUTES = 30;
const BUFFER_MINUTES = 15; // extra travel buffer

// Pre-race carb targets (g) based on body weight and meal size
const CARB_PER_KG: Record<string, number> = {
  light: 1.5,
  moderate: 2.0,
  full: 2.5,
};

// ── Core Generator ────────────────────────────────────────────────────────────

/**
 * Generate a complete race day timeline.
 */
export function generateRaceDayTimeline(input: RaceDayInput): RaceDayTimeline {
  const events: TimelineEvent[] = [];
  const startMinutes = parseTimeToMinutes(input.raceStartTime);

  // Work backwards from race start
  const alarmTime = calculateAlarmTime(startMinutes, input.travelMinutes, input.includeWarmup);

  // I. Pre-race events (reverse chronological, but we'll sort at end)

  // Alarm
  events.push({
    time: minutesToTimeStr(alarmTime),
    title: 'Wake Up / Alarm',
    description: 'Rise and shine! Start with 16 oz of water.',
    category: 'wake',
    minutesBeforeStart: startMinutes - alarmTime,
  });

  // Breakfast
  const breakfastTime = startMinutes - (BREAKFAST_HOURS_BEFORE * 60);
  const carbTarget = Math.round(input.weightKg * CARB_PER_KG[input.mealPreference]);
  events.push({
    time: minutesToTimeStr(breakfastTime),
    title: 'Pre-Race Breakfast',
    description: `${input.mealPreference.charAt(0).toUpperCase() + input.mealPreference.slice(1)} meal: ~${carbTarget}g carbs. Options: oatmeal with banana, toast with honey, bagel with peanut butter. Avoid fiber and fat.`,
    category: 'nutrition',
    minutesBeforeStart: startMinutes - breakfastTime,
  });

  // Hydration windows
  const hydrationStart = startMinutes - (HYDRATION_START_HOURS * 60);
  events.push({
    time: minutesToTimeStr(hydrationStart),
    title: 'Sip Sports Drink',
    description: '16-20 oz sports drink over the next 90 minutes. Stop heavy drinking 45 min before start.',
    category: 'nutrition',
    minutesBeforeStart: startMinutes - hydrationStart,
  });

  // Last fluid
  events.push({
    time: minutesToTimeStr(startMinutes - 45),
    title: 'Last Significant Fluid',
    description: 'Last 8-12 oz. Small sips only from here. Visit restroom.',
    category: 'nutrition',
    minutesBeforeStart: 45,
  });

  // Leave for venue
  const leaveTime = startMinutes - input.travelMinutes - GEAR_CHECK_MINUTES - BUFFER_MINUTES;
  events.push({
    time: minutesToTimeStr(leaveTime),
    title: 'Leave for Venue',
    description: `${input.travelMinutes} min travel + ${BUFFER_MINUTES} min buffer. Bring all race gear, bib, fueling items.`,
    category: 'logistics',
    minutesBeforeStart: startMinutes - leaveTime,
  });

  // Arrive at venue
  const arriveTime = leaveTime + input.travelMinutes;
  events.push({
    time: minutesToTimeStr(arriveTime),
    title: 'Arrive at Venue',
    description: 'Locate gear check, restrooms, and start corral. Pin bib if not done.',
    category: 'logistics',
    minutesBeforeStart: startMinutes - arriveTime,
  });

  // Gear check / bag drop
  events.push({
    time: minutesToTimeStr(startMinutes - GEAR_CHECK_MINUTES),
    title: 'Gear Check / Bag Drop',
    description: 'Drop bag at gear check. Keep race essentials: gels, phone, watch.',
    category: 'logistics',
    minutesBeforeStart: GEAR_CHECK_MINUTES,
  });

  // Optional warmup
  if (input.includeWarmup) {
    events.push({
      time: minutesToTimeStr(startMinutes - CORRAL_MINUTES - WARMUP_MINUTES),
      title: 'Warmup Jog',
      description: '10-15 min easy jog + dynamic stretches. 4-6 strides at race pace. Keep it light.',
      category: 'warmup',
      minutesBeforeStart: CORRAL_MINUTES + WARMUP_MINUTES,
    });
  }

  // Pre-race gel
  events.push({
    time: minutesToTimeStr(startMinutes - 15),
    title: 'Pre-Race Gel',
    description: 'Take one gel with a few sips of water. This tops off muscle glycogen.',
    category: 'nutrition',
    minutesBeforeStart: 15,
  });

  // Enter corral
  events.push({
    time: minutesToTimeStr(startMinutes - CORRAL_MINUTES),
    title: 'Enter Starting Corral',
    description: 'Find your pace group. Stay calm, conserve energy. Light dynamic movement.',
    category: 'race',
    minutesBeforeStart: CORRAL_MINUTES,
  });

  // II. Race events
  events.push({
    time: minutesToTimeStr(startMinutes),
    title: 'GUN TIME — Race Start!',
    description: 'Start easy! First mile should feel controlled. Don\'t chase the crowd.',
    category: 'race',
    minutesBeforeStart: 0,
  });

  // Add race milestones
  const pacePerMile = input.projectedFinishSec / 26.2;
  addRaceMilestones(events, startMinutes, pacePerMile, input.fuelingItemsCount);

  // Projected finish
  const finishTime = startMinutes + Math.round(input.projectedFinishSec / 60);
  events.push({
    time: minutesToTimeStr(finishTime),
    title: 'Projected Finish!',
    description: `Projected time: ${formatDuration(input.projectedFinishSec)}. You did it!`,
    category: 'milestone',
    minutesBeforeStart: -(input.projectedFinishSec / 60),
  });

  // Post-race
  events.push({
    time: minutesToTimeStr(finishTime + 5),
    title: 'Post-Race Recovery',
    description: 'Walk through the chute. Get your medal. Drink fluids immediately. Eat within 30 minutes (carbs + protein).',
    category: 'nutrition',
    minutesBeforeStart: -(input.projectedFinishSec / 60 + 5),
  });

  // Sort by time
  events.sort((a, b) => b.minutesBeforeStart - a.minutesBeforeStart);

  const textExport = buildTextExport(input.raceName, events);

  return {
    raceName: input.raceName,
    events,
    textExport,
  };
}

// ── Race Milestones ───────────────────────────────────────────────────────────

function addRaceMilestones(
  events: TimelineEvent[],
  startMinutes: number,
  pacePerMile: number,
  fuelingCount?: number,
): void {
  const milestones = [
    { mile: 5, label: '5K Mark (~3.1 mi)', tip: 'Check in with your body. Are you on pace? Stay controlled.' },
    { mile: 10, label: '10 Mile Mark', tip: 'Should still feel comfortable. Maintain rhythm.' },
    { mile: 13.1, label: 'Halfway!', tip: 'Check your time. If you feel great, maintain — don\'t accelerate.' },
    { mile: 18, label: 'Mile 18 — The Wall Zone Begins', tip: 'Focus on form, cadence, and fueling. This is where the race truly starts.' },
    { mile: 20, label: 'Mile 20', tip: 'Last 10K. Break it into 2-mile chunks. You are stronger than you think.' },
    { mile: 23, label: 'Mile 23 — Almost There', tip: 'Dig deep. One mile at a time. Think about why you\'re here.' },
    { mile: 26, label: 'Mile 26 — Last 0.2!', tip: 'Sprint if you can! The finish line is calling!' },
  ];

  for (const m of milestones) {
    const elapsedSec = m.mile * pacePerMile;
    const eventTime = startMinutes + Math.round(elapsedSec / 60);
    events.push({
      time: minutesToTimeStr(eventTime),
      title: m.label,
      description: `Projected time: ${formatDuration(Math.round(elapsedSec))}. ${m.tip}`,
      category: 'milestone',
      minutesBeforeStart: -Math.round(elapsedSec / 60),
    });
  }

  // Add fueling reminders
  if (fuelingCount && fuelingCount > 0) {
    const fuelMiles = generateFuelMiles(fuelingCount);
    for (const mile of fuelMiles) {
      const elapsedSec = mile * pacePerMile;
      const eventTime = startMinutes + Math.round(elapsedSec / 60);
      events.push({
        time: minutesToTimeStr(eventTime),
        title: `Fuel — Mile ${mile}`,
        description: `Take gel/chews with water at the next aid station.`,
        category: 'fueling',
        minutesBeforeStart: -Math.round(elapsedSec / 60),
      });
    }
  }
}

function generateFuelMiles(count: number): number[] {
  // Distribute gels evenly between miles 5 and 23
  const start = 5;
  const end = 23;
  const interval = Math.floor((end - start) / count);
  const miles: number[] = [];
  for (let i = 0; i < count; i++) {
    miles.push(start + i * interval);
  }
  return miles;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function calculateAlarmTime(startMinutes: number, travelMin: number, warmup?: boolean): number {
  let needed = BREAKFAST_HOURS_BEFORE * 60; // 3h for breakfast
  // Ensure enough time for travel + buffer
  const travelTotal = travelMin + GEAR_CHECK_MINUTES + BUFFER_MINUTES + (warmup ? WARMUP_MINUTES : 0);
  needed = Math.max(needed, travelTotal + 30); // 30 min to get ready
  return startMinutes - needed - 30; // 30 min morning routine
}

function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToTimeStr(minutes: number): string {
  const totalMin = ((minutes % 1440) + 1440) % 1440; // wrap around midnight
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

function formatDuration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function buildTextExport(raceName: string, events: TimelineEvent[]): string {
  const lines = [`🏃 RACE DAY TIMELINE — ${raceName}`, '═'.repeat(40), ''];

  for (const event of events) {
    lines.push(`${event.time}  |  ${event.title}`);
    lines.push(`           ${event.description}`);
    lines.push('');
  }

  lines.push('═'.repeat(40));
  lines.push('Generated by Apollo Running');
  return lines.join('\n');
}
