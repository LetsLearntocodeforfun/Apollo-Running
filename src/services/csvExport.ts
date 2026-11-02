/**
 * Open CSV Export Service (Epic 2B) — zero-lock-in data portability for Excel,
 * Apple Numbers, LibreOffice, Python (pandas), and R.
 *
 * Security: every string cell is quoted RFC 4180-style (internal quotes
 * doubled), and a cell that starts with a formula trigger — `=`, `+`, `-`,
 * `@`, `|`, tab, CR, LF or the full-width `＝`, `＋`, `－`, `＠`, including
 * when hidden behind leading whitespace or zero-width / bidi format
 * characters — gets a leading `'`. The same `'` goes after a `;` or line break
 * inside a value when a trigger follows it: Excel in locales whose list
 * separator is `;` splits each line of a comma-separated file at those
 * characters and honours quotes only at the start of a field, so that text can
 * become a cell of its own. Together these neutralize the known OWASP
 * CSV-injection (CWE-1236) vectors for activity titles and notes synced from
 * external platforms.
 */

import type { Activity, ActivitySplit } from './activity/types';
import { isRunActivity } from './activity/sports';
import { getAllStoredActivities } from './analyticsService';
import { getAllWellnessRecords, type WellnessRecord } from './wellness';
import { getAllStoredJournalEntries } from './trainingJournal';
import { ENERGY_LABELS, MOOD_LABELS, RPE_LABELS, SLEEP_LABELS, type JournalEntry } from '../types/journal';

export type CsvCell = string | number | boolean | null | undefined;

export interface CsvExportResult {
  rowCount: number;
  filename: string;
}

const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;

/**
 * Leading characters (`=`, `+`, `-`, `@`, `|`, their full-width forms U+FF1D,
 * U+FF0B, U+FF0D, U+FF20, `\t`, `\r`, `\n`) that spreadsheet applications can
 * interpret as executable formulas or DDE commands — also when preceded by
 * ASCII/Unicode whitespace or zero-width / bidi format characters
 * (U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, U+FEFF), which
 * can hide a trigger from the eye but not from the spreadsheet.
 */
const FORMULA_TRIGGER_RE =
  /^(?:[=+\-@|\t\r\n\uFF1D\uFF0B\uFF0D\uFF20]|[\s\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]+[=+\-@|\uFF1D\uFF0B\uFF0D\uFF20])/;

/**
 * A `;` or line break inside a value that is followed — after any spaces,
 * zero-width / bidi format characters or double quotes — by one of the same
 * triggers. When Excel opens a comma-separated file in a `;`-separator locale
 * (de, fr, es, it, …), it splits each line at every `;` and line break and
 * honours a double quote only at the start of a field, so the text after such
 * a break can start a new cell even though the whole value was quoted.
 */
const EMBEDDED_FORMULA_TRIGGER_RE =
  /(;|\r\n?|\n)(?=(?:[^\S\r\n]|["\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF])*[=+\-@|\uFF1D\uFF0B\uFF0D\uFF20])/g;

/**
 * Neutralize spreadsheet formula injection (Excel / LibreOffice / Google Sheets)
 * by prefixing dangerous string values with a leading single quote (`'`), and
 * by putting one after a `;` or line break inside the value when a trigger
 * follows it (see {@link EMBEDDED_FORMULA_TRIGGER_RE}).
 */
export function sanitizeCsvFormula(val: string): string {
  const guarded = val.replace(EMBEDDED_FORMULA_TRIGGER_RE, "$1'");
  if (FORMULA_TRIGGER_RE.test(guarded)) {
    return `'${guarded}`;
  }
  return guarded;
}

/**
 * Format and escape a single CSV cell per RFC 4180, applying formula-injection
 * neutralization to string values while preserving genuine finite negative numbers.
 * Every string is quoted (internal quotes doubled), so readers that honour
 * quotes keep a `,`, `;`, tab or line break inside it in one cell; numbers and
 * booleans stay bare.
 */
export function escapeCsvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'number') {
    return Number.isFinite(cell) ? String(cell) : '';
  }
  if (typeof cell === 'boolean') {
    return cell ? 'true' : 'false';
  }
  return `"${sanitizeCsvFormula(cell).replace(/"/g, '""')}"`;
}

/**
 * Serialize headers and data rows into an RFC 4180 `\r\n`-delimited CSV string.
 */
export function rowsToCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines: string[] = [headers.map((h) => escapeCsvCell(h)).join(',')];
  for (const row of rows) {
    lines.push(row.map((cell) => escapeCsvCell(cell)).join(','));
  }
  return lines.join('\r\n');
}

/**
 * Trigger a browser/Electron file download of a CSV string with a UTF-8 BOM
 * (`\uFEFF`) prepended so Microsoft Excel opens UTF-8 characters cleanly.
 */
export function downloadCsv(csv: string, filename: string): void {
  const content = csv.startsWith('\uFEFF') ? csv : `\uFEFF${csv}`;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ── Numeric & Formatting Helpers ──────────────────────────────────────────────

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundTo(value: number | null | undefined, decimals: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function paceMinPerUnit(
  distanceM: number | null | undefined,
  movingTimeS: number | null | undefined,
  unitMeters: number,
  averageSpeedMps?: number | null,
): number | null {
  if (
    typeof distanceM === 'number' &&
    Number.isFinite(distanceM) &&
    distanceM > 0 &&
    typeof movingTimeS === 'number' &&
    Number.isFinite(movingTimeS) &&
    movingTimeS > 0
  ) {
    return roundTo(movingTimeS / 60 / (distanceM / unitMeters), 3);
  }
  if (typeof averageSpeedMps === 'number' && Number.isFinite(averageSpeedMps) && averageSpeedMps > 0) {
    return roundTo(unitMeters / averageSpeedMps / 60, 3);
  }
  return null;
}

function cleanLabel(label: string | undefined): string {
  if (!label) return '';
  return label.replace(/^[^A-Za-z0-9]+/, '').trim();
}

function dateStamp(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function activityDateKey(a: Activity): string {
  return (a.start_date_local || a.start_date || '').slice(0, 10);
}

// ── 1. Activities CSV ─────────────────────────────────────────────────────────

export const ACTIVITIES_CSV_HEADERS: readonly string[] = [
  'id',
  'date',
  'start_date_local',
  'start_date_utc',
  'name',
  'sport_type',
  'type',
  'source',
  'source_id',
  'origin',
  'distance_m',
  'distance_km',
  'distance_mi',
  'moving_time_s',
  'elapsed_time_s',
  'pace_min_per_km',
  'pace_min_per_mi',
  'average_speed_mps',
  'max_speed_mps',
  'average_heartrate_bpm',
  'max_heartrate_bpm',
  'total_elevation_gain_m',
  'total_elevation_gain_ft',
  'average_cadence_raw',
  'run_cadence_spm',
  'average_watts',
  'weighted_average_watts',
  'training_load',
  'suffer_score',
  'calories',
  'trainer',
  'device_name',
  'hidden',
  'hidden_reason',
];

function buildActivitiesRows(activities: readonly Activity[]): CsvCell[][] {
  return activities.map((a) => {
    const distM = finiteOrNull(a.distance);
    const elevM = finiteOrNull(a.total_elevation_gain);
    const cadenceRaw = finiteOrNull(a.average_cadence);
    const runCadenceSpm = isRunActivity(a) && cadenceRaw !== null ? Math.round(cadenceRaw * 2) : null;

    return [
      a.id,
      activityDateKey(a),
      a.start_date_local || '',
      a.start_date || '',
      a.name ?? '',
      a.sport_type || a.type || '',
      a.type || '',
      a.source ?? '',
      a.source_id ?? '',
      a.origin ?? '',
      roundTo(distM, 2),
      distM !== null ? roundTo(distM / 1000, 3) : null,
      distM !== null ? roundTo(distM / METERS_PER_MILE, 3) : null,
      finiteOrNull(a.moving_time),
      finiteOrNull(a.elapsed_time),
      paceMinPerUnit(distM, a.moving_time, 1000, a.average_speed),
      paceMinPerUnit(distM, a.moving_time, METERS_PER_MILE, a.average_speed),
      roundTo(a.average_speed, 3),
      roundTo(a.max_speed, 3),
      roundTo(a.average_heartrate, 1),
      roundTo(a.max_heartrate, 1),
      roundTo(elevM, 1),
      elevM !== null ? roundTo(elevM * FEET_PER_METER, 1) : null,
      roundTo(cadenceRaw, 1),
      runCadenceSpm,
      roundTo(a.average_watts, 1),
      roundTo(a.weighted_average_watts, 1),
      roundTo(a.training_load, 1),
      roundTo(a.suffer_score, 1),
      roundTo(a.calories, 1),
      Boolean(a.trainer),
      a.device_name ?? '',
      Boolean(a.hidden),
      a.hidden_reason ?? '',
    ];
  });
}

export function buildActivitiesCsv(activities: readonly Activity[] = getAllStoredActivities()): string {
  return rowsToCsv(ACTIVITIES_CSV_HEADERS, buildActivitiesRows(activities));
}

export function exportActivitiesCsv(): CsvExportResult {
  const rows = buildActivitiesRows(getAllStoredActivities());
  const filename = `apollo-activities-${dateStamp()}.csv`;
  if (rows.length > 0) {
    downloadCsv(rowsToCsv(ACTIVITIES_CSV_HEADERS, rows), filename);
  }
  return { rowCount: rows.length, filename };
}

// ── 2. Splits CSV ─────────────────────────────────────────────────────────────

export const SPLITS_CSV_HEADERS: readonly string[] = [
  'activity_id',
  'date',
  'activity_name',
  'sport_type',
  'split_system',
  'split_number',
  'distance_m',
  'moving_time_s',
  'elapsed_time_s',
  'average_speed_mps',
  'pace_min_per_km',
  'pace_min_per_mi',
  'average_heartrate_bpm',
  'elevation_difference_m',
  'pace_zone',
];

function appendSplitRows(
  out: CsvCell[][],
  activity: Activity,
  splits: readonly ActivitySplit[] | undefined,
  splitSystem: 'metric_km' | 'imperial_mi',
): void {
  if (!Array.isArray(splits) || splits.length === 0) return;
  const date = activityDateKey(activity);
  const name = activity.name ?? '';
  const sportType = activity.sport_type || activity.type || '';

  splits.forEach((s, idx) => {
    out.push([
      activity.id,
      date,
      name,
      sportType,
      splitSystem,
      finiteOrNull(s.split) ?? idx + 1,
      roundTo(s.distance, 2),
      finiteOrNull(s.moving_time),
      finiteOrNull(s.elapsed_time),
      roundTo(s.average_speed, 3),
      paceMinPerUnit(s.distance, s.moving_time, 1000, s.average_speed),
      paceMinPerUnit(s.distance, s.moving_time, METERS_PER_MILE, s.average_speed),
      roundTo(s.average_heartrate, 1),
      roundTo(s.elevation_difference, 2),
      finiteOrNull(s.pace_zone),
    ]);
  });
}

function buildSplitsRows(activities: readonly Activity[]): CsvCell[][] {
  const rows: CsvCell[][] = [];
  for (const activity of activities) {
    appendSplitRows(rows, activity, activity.splits_metric, 'metric_km');
    appendSplitRows(rows, activity, activity.splits_standard, 'imperial_mi');
  }
  return rows;
}

export function buildSplitsCsv(activities: readonly Activity[] = getAllStoredActivities()): string {
  return rowsToCsv(SPLITS_CSV_HEADERS, buildSplitsRows(activities));
}

export function exportSplitsCsv(): CsvExportResult {
  const rows = buildSplitsRows(getAllStoredActivities());
  const filename = `apollo-splits-${dateStamp()}.csv`;
  if (rows.length > 0) {
    downloadCsv(rowsToCsv(SPLITS_CSV_HEADERS, rows), filename);
  }
  return { rowCount: rows.length, filename };
}

// ── 3. Wellness & HRV CSV ─────────────────────────────────────────────────────

export const WELLNESS_CSV_HEADERS: readonly string[] = [
  'date',
  'resting_hr_bpm',
  'hrv_rmssd_ms',
  'hrv_sdnn_ms',
  'sleep_hours',
  'sleep_secs',
  'sleep_score',
  'sleep_quality',
  'avg_sleeping_hr_bpm',
  'readiness',
  'weight_kg',
  'vo2max',
  'steps',
  'soreness',
  'fatigue',
  'stress',
  'mood',
  'updated_at',
];

function buildWellnessRows(records: readonly WellnessRecord[]): CsvCell[][] {
  return records.map((r) => {
    const sleepSecs = finiteOrNull(r.sleepSecs);
    return [
      r.date,
      finiteOrNull(r.restingHR),
      roundTo(r.hrv, 2),
      roundTo(r.hrvSDNN, 2),
      sleepSecs !== null ? roundTo(sleepSecs / 3600, 2) : null,
      sleepSecs,
      roundTo(r.sleepScore, 1),
      finiteOrNull(r.sleepQuality),
      roundTo(r.avgSleepingHR, 1),
      roundTo(r.readiness, 2),
      roundTo(r.weight, 2),
      roundTo(r.vo2max, 2),
      finiteOrNull(r.steps),
      finiteOrNull(r.soreness),
      finiteOrNull(r.fatigue),
      finiteOrNull(r.stress),
      finiteOrNull(r.mood),
      r.updated ?? '',
    ];
  });
}

export function buildWellnessCsv(records: readonly WellnessRecord[] = getAllWellnessRecords()): string {
  return rowsToCsv(WELLNESS_CSV_HEADERS, buildWellnessRows(records));
}

export function exportWellnessCsv(): CsvExportResult {
  const rows = buildWellnessRows(getAllWellnessRecords());
  const filename = `apollo-wellness-${dateStamp()}.csv`;
  if (rows.length > 0) {
    downloadCsv(rowsToCsv(WELLNESS_CSV_HEADERS, rows), filename);
  }
  return { rowCount: rows.length, filename };
}

// ── 4. Training Journal CSV ───────────────────────────────────────────────────

export const JOURNAL_CSV_HEADERS: readonly string[] = [
  'date',
  'rpe',
  'rpe_label',
  'mood',
  'energy',
  'sleep_quality',
  'sleep_hours',
  'surface',
  'temp_f',
  'humidity_pct',
  'wind',
  'conditions',
  'weather_source',
  'notes',
  'updated_at',
];

function buildJournalRows(entries: readonly JournalEntry[]): CsvCell[][] {
  return entries.map((e) => [
    e.date,
    finiteOrNull(e.rpe),
    e.rpe ? cleanLabel(RPE_LABELS[e.rpe]) : '',
    e.mood ? cleanLabel(MOOD_LABELS[e.mood]) : '',
    e.energy ? cleanLabel(ENERGY_LABELS[e.energy]) : '',
    e.sleepQuality ? cleanLabel(SLEEP_LABELS[e.sleepQuality]) : '',
    roundTo(e.sleepHours, 2),
    e.surface ?? '',
    roundTo(e.weather?.tempF, 1),
    roundTo(e.weather?.humidity, 1),
    e.weather?.wind ?? '',
    e.weather?.conditions ?? '',
    e.weather?.source ?? '',
    e.notes ?? '',
    e.updatedAt ?? '',
  ]);
}

export function buildJournalCsv(entries: readonly JournalEntry[] = getAllStoredJournalEntries()): string {
  return rowsToCsv(JOURNAL_CSV_HEADERS, buildJournalRows(entries));
}

export function exportJournalCsv(): CsvExportResult {
  const rows = buildJournalRows(getAllStoredJournalEntries());
  const filename = `apollo-journal-${dateStamp()}.csv`;
  if (rows.length > 0) {
    downloadCsv(rowsToCsv(JOURNAL_CSV_HEADERS, rows), filename);
  }
  return { rowCount: rows.length, filename };
}
