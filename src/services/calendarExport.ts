/**
 * Calendar Export Service
 *
 * Exports training plans as .ics (iCalendar) files for Google Calendar,
 * Outlook, Apple Calendar, etc. Each workout becomes a calendar event
 * with title, target paces, and estimated duration.
 */

import { type TrainingPlan, type PlanDay, getPlanById } from '../data/plans';
import { getActivePlan, getDateForDay, formatDateKey } from './planProgress';
import { getSavedTrainingPaces, formatPaceSec, type TrainingPaces } from './paceCalculator';
import { getWorkoutTarget } from './workoutTargets';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  uid: string;
  date: string;          // YYYY-MM-DD
  summary: string;       // Event title
  description: string;   // Full workout details
  durationMin: number;   // Estimated duration
  weekNumber: number;
  dayOfWeek: number;     // 0=Mon, 6=Sun
}

export interface CalendarExportResult {
  planName: string;
  startDate: string;
  totalEvents: number;
  icsContent: string;
  events: CalendarEvent[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeICS(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function formatICSDate(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}${m}${d}`;
}

function formatICSDateTime(date: Date): string {
  const y = date.getFullYear();
  const mo = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  const h = date.getHours().toString().padStart(2, '0');
  const mi = date.getMinutes().toString().padStart(2, '0');
  const s = date.getSeconds().toString().padStart(2, '0');
  return `${y}${mo}${d}T${h}${mi}${s}`;
}

function estimateDuration(day: PlanDay, paces: TrainingPaces | null): number {
  if (day.type === 'rest') return 0;
  if (day.type === 'cross') return 45;
  if (day.type === 'marathon') return 240; // ~4 hours estimate

  const dist = day.distanceMi ?? 0;
  if (dist <= 0) return 30;

  // Use VDOT-based paces if available
  if (paces && day.note) {
    const note = day.note.toLowerCase();
    let paceSecPerMi = paces.easy.max; // default to easy
    if (note.includes('tempo') || note.includes('threshold')) paceSecPerMi = paces.threshold;
    else if (note.includes('marathon pace') || note.includes('mp')) paceSecPerMi = paces.marathon;
    else if (note.includes('long')) paceSecPerMi = paces.easy.max + 15; // long run slightly slower
    const totalMin = Math.ceil((dist * paceSecPerMi) / 60);
    return totalMin + 5; // Add 5 min for warmup/cooldown buffer
  }

  // Fallback: assume ~9:30/mi average
  return Math.ceil(dist * 9.5) + 5;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function buildWorkoutTitle(day: PlanDay, weekNum: number): string {
  if (day.type === 'rest') return `Week ${weekNum}: Rest Day`;
  if (day.type === 'cross') return `Week ${weekNum}: Cross-Training`;
  if (day.type === 'marathon') return `Week ${weekNum}: MARATHON DAY 🏃`;
  if (day.type === 'race') return `Week ${weekNum}: Race`;

  const dist = day.distanceMi ? `${day.distanceMi} mi` : '';
  const note = day.note ?? 'Run';
  return `Week ${weekNum}: ${note} ${dist}`.trim();
}

function buildWorkoutDescription(
  day: PlanDay,
  weekNum: number,
  dayName: string,
  paces: TrainingPaces | null,
  vdot: number | null,
): string {
  const lines: string[] = [];
  lines.push(`Apollo Training Plan — Week ${weekNum}, ${dayName}`);
  lines.push('');

  if (day.type === 'rest') {
    lines.push('Rest day. Recovery is training too.');
    return lines.join('\n');
  }
  if (day.type === 'cross') {
    lines.push('Cross-training: cycling, swimming, yoga, or strength work.');
    lines.push('Keep the effort easy to moderate.');
    return lines.join('\n');
  }
  if (day.type === 'marathon') {
    lines.push('MARATHON DAY! 26.2 miles.');
    lines.push('Execute your race strategy. Trust your training.');
    if (paces) {
      lines.push(`Target pace: ${formatPaceSec(paces.marathon)}/mi`);
    }
    return lines.join('\n');
  }

  if (day.distanceMi) lines.push(`Distance: ${day.distanceMi} miles`);
  if (day.label) lines.push(`Workout: ${day.label}`);

  // Add VDOT-based pace targets
  if (paces && vdot && day.note) {
    const target = getWorkoutTarget(day.note, vdot, day.distanceMi ?? 0);
    if (target) {
      lines.push('');
      lines.push('Target Paces:');
      if (target.targetPaceRange) {
        lines.push(`  Pace: ${formatPaceSec(target.targetPaceRange.minSecPerMi)}-${formatPaceSec(target.targetPaceRange.maxSecPerMi)}/mi`);
      }
      if (target.intervals && target.intervals.length > 0) {
        lines.push('  Intervals:');
        for (const block of target.intervals) {
          lines.push(`    ${block.repeats}x ${block.workDurationMin}min @ ${formatPaceSec(block.targetPaceSecPerMi)}/mi (${block.restDurationMin}min rest)`);
        }
      }
    }
  }

  return lines.join('\n');
}

// ── Core Export ────────────────────────────────────────────────────────────────

/**
 * Generate calendar events from a training plan.
 */
export function generateCalendarEvents(
  plan: TrainingPlan,
  startDate: string,
  options?: { includeRestDays?: boolean },
): CalendarEvent[] {
  const includeRest = options?.includeRestDays ?? false;
  const paces = getSavedTrainingPaces();
  const vdot = paces ? estimateVdotFromPaces(paces) : null;
  const events: CalendarEvent[] = [];

  for (let w = 0; w < plan.weeks.length; w++) {
    const week = plan.weeks[w];
    for (let d = 0; d < 7; d++) {
      const day = week.days[d];
      if (day.type === 'rest' && !includeRest) continue;

      const date = getDateForDay(startDate, w, d);
      const dateKey = formatDateKey(date);
      const dayName = DAY_NAMES[d];
      const duration = estimateDuration(day, paces);

      events.push({
        uid: `apollo-w${w + 1}d${d + 1}-${plan.id}@apollo-running`,
        date: dateKey,
        summary: buildWorkoutTitle(day, w + 1),
        description: buildWorkoutDescription(day, w + 1, dayName, paces, vdot),
        durationMin: duration,
        weekNumber: w + 1,
        dayOfWeek: d,
      });
    }
  }

  return events;
}

/**
 * Generate an .ics file string from calendar events.
 */
export function generateICS(events: CalendarEvent[], planName: string): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apollo Running//Training Plan//EN',
    `X-WR-CALNAME:${escapeICS(planName)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];

  const now = formatICSDateTime(new Date());

  for (const event of events) {
    const startDate = new Date(event.date + 'T07:00:00');
    const endDate = new Date(startDate.getTime() + event.durationMin * 60 * 1000);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.uid}`);
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${formatICSDate(startDate)}`);
    lines.push(`DTEND:${formatICSDate(endDate)}`);
    lines.push(`SUMMARY:${escapeICS(event.summary)}`);
    lines.push(`DESCRIPTION:${escapeICS(event.description)}`);
    lines.push('STATUS:CONFIRMED');
    lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

/**
 * Export the current active plan as an .ics file.
 * Returns null if no active plan.
 */
export function exportActivePlan(options?: { includeRestDays?: boolean }): CalendarExportResult | null {
  const active = getActivePlan();
  if (!active) return null;
  const plan = getPlanById(active.planId);
  if (!plan) return null;

  const events = generateCalendarEvents(plan, active.startDate, options);
  const ics = generateICS(events, plan.name);

  return {
    planName: plan.name,
    startDate: active.startDate,
    totalEvents: events.length,
    icsContent: ics,
    events,
  };
}

/**
 * Export any plan with a given start date.
 */
export function exportPlan(
  plan: TrainingPlan,
  startDate: string,
  options?: { includeRestDays?: boolean },
): CalendarExportResult {
  const events = generateCalendarEvents(plan, startDate, options);
  const ics = generateICS(events, plan.name);

  return {
    planName: plan.name,
    startDate,
    totalEvents: events.length,
    icsContent: ics,
    events,
  };
}

/**
 * Trigger a download of the .ics file in the browser.
 */
export function downloadICS(result: CalendarExportResult): void {
  const blob = new Blob([result.icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${result.planName.replace(/[^a-zA-Z0-9]/g, '_')}_training.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

function estimateVdotFromPaces(paces: TrainingPaces): number {
  // Reverse-estimate VDOT from marathon pace
  const mpSecPerMi = paces.marathon;
  if (mpSecPerMi <= 0) return 40;
  const mpMinPerMi = mpSecPerMi / 60;
  return Math.round(Math.max(25, Math.min(85, 900 / mpMinPerMi)));
}
