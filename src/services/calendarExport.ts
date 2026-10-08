/**
 * Calendar Export Service
 *
 * Exports training plans as .ics (iCalendar) files for Google Calendar,
 * Outlook, Apple Calendar, etc. Each workout becomes a calendar event
 * with title, target paces, and estimated duration.
 *
 * v1.0.6: this module is a thin RFC 5545 serializer over
 * `planCalendarSync.buildPlanWorkouts` — the same engine as the watch push —
 * so names, distances, units (mi/km) and pace targets (from the athlete's
 * saved VDOT paces) match everywhere (U-01, U-02, U-06).
 *
 *  - Workouts are all-day events: `DTSTART;VALUE=DATE` with an exclusive
 *    `DTEND` on the next day (U-03). Plan days are calendar dates, so no
 *    VTIMEZONE is needed.
 *  - `DTSTAMP` is UTC (U-04); content lines are folded at 75 octets without
 *    splitting UTF-8 sequences (U-05); TEXT values are escaped per RFC 5545.
 *  - UIDs are stable per plan instance and date (U-07):
 *    `apollo-<planId>-<startDate>-<date>@apollo-running`, so re-importing after
 *    a plan change updates the existing events instead of duplicating them.
 *  - Moved/skipped workouts follow the effective plan (overlay applied) that
 *    the caller passes in; `exportActivePlan` reads it itself.
 */

import type { PlanDay, TrainingPlan } from '../data/plans';
import { getActivePlan, getDateKeyForDay } from './planProgress';
import { getEffectivePlan } from './planOverlay';
import { buildPlanWorkouts, type PlannedWorkout } from './planCalendarSync';
import { calculateTrainingPaces, getSavedTrainingPaces, type TrainingPaces } from './paceCalculator';
import { getSavedPrediction } from './racePrediction';
import { getDistanceUnit, type DistanceUnit } from './unitPreferences';
import { addDays, isDateKey, todayKey } from '../utils/localDate';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  uid: string;
  date: string;          // YYYY-MM-DD (all-day event)
  summary: string;       // Event title
  description: string;   // Full workout details (plain text, unescaped)
  durationMin: number;   // Estimated moving time (0 for rest days)
  weekNumber: number;    // 1-based plan week
  dayOfWeek: number;     // 0=Mon, 6=Sun
  /** 'workout' for runs/cross-training/races, 'rest' for rest (and skipped) days. */
  kind: 'workout' | 'rest';
}

export interface CalendarExportOptions {
  /** Add an event for every rest day too. Default false. */
  includeRestDays?: boolean;
  /** Only export from today on (otherwise the whole plan). Default false. */
  fromToday?: boolean;
  /** Override "today" (YYYY-MM-DD) — tests and previews. Default: the local date. */
  today?: string;
  /** Distance unit for titles, steps and paces. Default: the athlete's setting. */
  unit?: DistanceUnit;
  /** VDOT training paces. Default: the athlete's paces (same source as the watch push); null = no targets. */
  paces?: TrainingPaces | null;
  /** Skip plan weeks before this 0-based index (plans joined mid-way). Default 0. */
  firstWeekIndex?: number;
}

export interface CalendarExportResult {
  planName: string;
  startDate: string;
  totalEvents: number;
  icsContent: string;
  events: CalendarEvent[];
  /** Suggested download file name (ASCII, ends in .ics). */
  fileName: string;
  /** True when the workouts carry pace targets (the athlete's VDOT paces are known). */
  hasPaceTargets: boolean;
  /** First and last event dates (YYYY-MM-DD), or null when there are no events. */
  firstDate: string | null;
  lastDate: string | null;
}

export interface GenerateICSOptions {
  /** Timestamp for DTSTAMP/SEQUENCE. Default: now. */
  now?: Date;
}

// ── RFC 5545 helpers ──────────────────────────────────────────────────────────

const CRLF = '\r\n';
const MAX_LINE_OCTETS = 75;
const UID_DOMAIN = 'apollo-running';
/** SEQUENCE epoch: minutes since 2024-01-01T00:00Z, so later exports supersede earlier imports. */
const SEQUENCE_EPOCH_MS = Date.UTC(2024, 0, 1);

/**
 * Escape a TEXT property value (RFC 5545 §3.3.11): backslash first, then
 * `;` `,` and newlines (CRLF/CR are normalised to `\n`). Other control
 * characters are not allowed in TEXT and are dropped.
 */
export function escapeICSText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** UTF-8 length of one code point. */
function utf8Octets(char: string): number {
  const cp = char.codePointAt(0) ?? 0;
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

/**
 * Fold a content line to at most 75 octets per physical line (RFC 5545 §3.1):
 * continuation lines start with a single space. Never splits a UTF-8
 * sequence (iterates whole code points, so surrogate pairs stay together).
 */
export function foldICSLine(line: string): string {
  let out = '';
  let octets = 0;
  for (const char of line) {
    const n = utf8Octets(char);
    if (octets + n > MAX_LINE_OCTETS) {
      out += `${CRLF} `;
      octets = 1; // the leading space counts
    }
    out += char;
    octets += n;
  }
  return out;
}

/** `YYYYMMDD` for a date key. */
function icsDate(dateKey: string): string {
  return dateKey.replace(/-/g, '');
}

/** UTC date-time `YYYYMMDDTHHMMSSZ` (RFC 5545 form #2). */
function icsUtcDateTime(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'plan';
}

/** Stable UID for one plan day of one plan instance (U-07). */
export function calendarEventUid(planId: string, startDate: string, date: string): string {
  return `apollo-${slug(planId)}-${startDate}-${date}@${UID_DOMAIN}`;
}

// ── Description formatting ────────────────────────────────────────────────────

const DISTANCE_TOKEN = /^(\d+(?:\.\d+)?)(mi|km|mtr)$/;
const HOURS_TOKEN = /^(\d+)h(?:(\d+)m)?$/;
const MINUTES_TOKEN = /^(\d+)m(\d{2})?$/;
const SECONDS_TOKEN = /^(\d+)s$/;
const PACE_TOKEN = /^\d+:\d{2}(?:-\d+:\d{2})?\/(?:mi|km)$/;

/** intervals.icu step tokens → words people read in a calendar ("800mtr" → "800 m", "3m30" → "3 min 30 sec"). */
function humanizeToken(token: string): string {
  let m = DISTANCE_TOKEN.exec(token);
  if (m) return `${m[1]} ${m[2] === 'mtr' ? 'm' : m[2]}`;
  m = HOURS_TOKEN.exec(token);
  if (m) return m[2] ? `${m[1]} h ${m[2]} min` : `${m[1]} h`;
  m = MINUTES_TOKEN.exec(token);
  if (m) return m[2] ? `${m[1]} min ${Number(m[2])} sec` : `${m[1]} min`;
  m = SECONDS_TOKEN.exec(token);
  if (m) return `${m[1]} sec`;
  return token;
}

/** "- 1mi 9:19-8:57/mi Pace" → "- 1 mi @ 9:19–8:57/mi"; other lines are kept (headers get "5×"). */
function humanizeLine(line: string): string {
  if (!line.startsWith('- ')) return line.replace(/ (\d+)x$/, ' $1×');
  const tokens = line.slice(2).split(' ');
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (PACE_TOKEN.test(token) && tokens[i + 1] === 'Pace') {
      out.push(`@ ${token.replace('-', '–')}`);
      i++;
      continue;
    }
    out.push(humanizeToken(token));
  }
  return `- ${out.join(' ')}`;
}

function formatMinutes(totalMin: number): string {
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function weekLine(weekNumber: number, totalWeeks: number, planName: string): string {
  return `Week ${weekNumber} of ${totalWeeks} · ${planName}`;
}

function workoutDescription(workout: PlannedWorkout, weekNumber: number, plan: TrainingPlan): string {
  const body = workout.description.split('\n').map(humanizeLine).join('\n');
  const minutes = Math.max(1, Math.round(workout.moving_time / 60));
  return [body, `Estimated time: ${formatMinutes(minutes)}`, weekLine(weekNumber, plan.weeks.length, plan.name)].join('\n\n');
}

function restDescription(day: PlanDay, weekNumber: number, plan: TrainingPlan): string {
  const first = day.skipped
    ? `Rest day. You skipped this workout${day.originalLabel ? ` (${day.originalLabel})` : ''}.`
    : 'Rest day. Recovery is training too.';
  return [first, weekLine(weekNumber, plan.weeks.length, plan.name)].join('\n\n');
}

// ── Paces ─────────────────────────────────────────────────────────────────────

function isTrainingPaces(p: TrainingPaces | null | undefined): p is TrainingPaces {
  return !!p && typeof p.vdot === 'number' && !!p.easy
    && typeof p.easy.min === 'number' && typeof p.easy.max === 'number'
    && [p.marathon, p.threshold, p.interval].every((v) => typeof v === 'number' && v > 0);
}

/**
 * The athlete's VDOT training paces, resolved exactly like the watch push
 * (planCalendarSync): race-prediction VDOT first, then the saved paces.
 * Pure read — never writes the pace cache.
 */
export function resolveExportPaces(): TrainingPaces | null {
  const vdot = getSavedPrediction()?.vdot;
  if (typeof vdot === 'number' && vdot > 0) {
    const paces = calculateTrainingPaces(vdot);
    if (paces) return paces;
  }
  const saved = getSavedTrainingPaces();
  return isTrainingPaces(saved) ? saved : null;
}

// ── Core Export ────────────────────────────────────────────────────────────────

/** First date (YYYY-MM-DD) exported for a plan instance under `options`. */
function exportFromDate(startDate: string, options: CalendarExportOptions): string {
  const firstWeek = Math.max(0, Math.floor(options.firstWeekIndex ?? 0));
  const planFrom = getDateKeyForDay(startDate, firstWeek, 0);
  if (!options.fromToday) return planFrom;
  const today = options.today && isDateKey(options.today) ? options.today : todayKey();
  return today > planFrom ? today : planFrom;
}

/**
 * Generate calendar events from a training plan (pass the effective plan so
 * moved and skipped workouts land on their current dates). Pure apart from
 * reading the unit and pace settings when they aren't passed in.
 */
export function generateCalendarEvents(
  plan: TrainingPlan,
  startDate: string,
  options: CalendarExportOptions = {},
): CalendarEvent[] {
  if (!isDateKey(startDate) || !Array.isArray(plan.weeks)) return [];
  const unit = options.unit ?? getDistanceUnit();
  const paces = options.paces !== undefined ? options.paces : resolveExportPaces();
  const from = exportFromDate(startDate, options);

  const workouts = buildPlanWorkouts(plan, startDate, { from, unit, paces, vdot: paces?.vdot ?? null });
  const byDate = new Map(workouts.map((w) => [w.date, w]));

  const events: CalendarEvent[] = [];
  plan.weeks.forEach((week, weekIndex) => {
    (week.days ?? []).slice(0, 7).forEach((day, dayIndex) => {
      const date = getDateKeyForDay(startDate, weekIndex, dayIndex);
      if (date < from) return;
      const weekNumber = weekIndex + 1;
      const base = { uid: calendarEventUid(plan.id, startDate, date), date, weekNumber, dayOfWeek: dayIndex };
      const workout = byDate.get(date);
      if (workout) {
        events.push({
          ...base,
          summary: workout.name,
          description: workoutDescription(workout, weekNumber, plan),
          durationMin: Math.max(1, Math.round(workout.moving_time / 60)),
          kind: 'workout',
        });
      } else if (day?.type === 'rest' && options.includeRestDays) {
        events.push({
          ...base,
          summary: day.skipped ? 'Rest day (skipped workout)' : 'Rest day',
          description: restDescription(day, weekNumber, plan),
          durationMin: 0,
          kind: 'rest',
        });
      }
    });
  });
  return events;
}

/**
 * Generate an .ics file string from calendar events (RFC 5545: CRLF line
 * endings, folded lines, escaped TEXT, all-day DATE events, UTC DTSTAMP).
 */
export function generateICS(events: CalendarEvent[], planName: string, options: GenerateICSOptions = {}): string {
  const now = options.now ?? new Date();
  const stamp = icsUtcDateTime(now);
  const sequence = Math.max(0, Math.floor((now.getTime() - SEQUENCE_EPOCH_MS) / 60_000));
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Apollo Running//Training Plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeICSText(planName)}`,
  ];

  for (const event of events) {
    if (!isDateKey(event.date)) continue;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${escapeICSText(event.uid)}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(event.date)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(event.date, 1))}`,
      `SUMMARY:${escapeICSText(event.summary)}`,
      `DESCRIPTION:${escapeICSText(event.description)}`,
      `SEQUENCE:${sequence}`,
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldICSLine).join(CRLF) + CRLF;
}

/** ASCII file name for a plan export: "Hal_Higdon_Novice_1_training.ics". */
function icsFileName(planName: string): string {
  const base = planName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Apollo_plan';
  return `${base}_training.ics`;
}

/**
 * Export any plan with a given start date.
 */
export function exportPlan(
  plan: TrainingPlan,
  startDate: string,
  options: CalendarExportOptions = {},
  icsOptions: GenerateICSOptions = {},
): CalendarExportResult {
  const paces = options.paces !== undefined ? options.paces : resolveExportPaces();
  const events = generateCalendarEvents(plan, startDate, { ...options, paces });
  return {
    planName: plan.name,
    startDate,
    totalEvents: events.length,
    icsContent: generateICS(events, plan.name, icsOptions),
    events,
    fileName: icsFileName(plan.name),
    hasPaceTargets: paces !== null,
    firstDate: events[0]?.date ?? null,
    lastDate: events[events.length - 1]?.date ?? null,
  };
}

/** The active plan instance to export, or null when no plan is active. */
interface ActivePlanContext {
  plan: TrainingPlan;
  startDate: string;
  firstWeekIndex: number;
}

/**
 * Active plan instance: the effective plan (overlay applied — moved and
 * skipped workouts on their current dates, race on the race date) plus the
 * instance's start date and joined week.
 */
function resolveActivePlan(): ActivePlanContext | null {
  const active = getActivePlan();
  if (!active?.planId || !active.startDate || !isDateKey(active.startDate)) return null;
  const plan = getEffectivePlan();
  if (!plan || !Array.isArray(plan.weeks)) return null;
  const joined = active.joinedWeekIndex;
  const firstWeekIndex = typeof joined === 'number' && Number.isFinite(joined) && joined > 0 ? Math.floor(joined) : 0;
  return { plan, startDate: active.startDate, firstWeekIndex };
}

/** Name and date span of the active plan (for UI copy), or null when no plan is active. */
export function getActivePlanExportInfo(): { planName: string; startDate: string; endDate: string } | null {
  const ctx = resolveActivePlan();
  if (!ctx) return null;
  return {
    planName: ctx.plan.name,
    startDate: getDateKeyForDay(ctx.startDate, ctx.firstWeekIndex, 0),
    endDate: getDateKeyForDay(ctx.startDate, ctx.plan.weeks.length - 1, 6),
  };
}

/**
 * Export the current active plan as an .ics file.
 * Returns null if no active plan.
 */
export function exportActivePlan(
  options: CalendarExportOptions = {},
  icsOptions: GenerateICSOptions = {},
): CalendarExportResult | null {
  const ctx = resolveActivePlan();
  if (!ctx) return null;
  return exportPlan(ctx.plan, ctx.startDate, { firstWeekIndex: ctx.firstWeekIndex, ...options }, icsOptions);
}

/**
 * Trigger a download of the .ics file (Blob + `<a download>`; works in the
 * browser and in Electron, which shows its save dialog). Returns false when
 * the environment can't create downloads.
 */
export function downloadICS(result: Pick<CalendarExportResult, 'icsContent' | 'fileName'>): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return false;
  }
  const blob = new Blob([result.icsContent], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke later: some engines read the blob asynchronously after click().
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return true;
}
