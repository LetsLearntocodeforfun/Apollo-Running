/**
 * Open `.apollo-plan.json` Community & Custom Plan Import / Export.
 *
 * Gives athletes and coaches a transparent, portable, schema-validated JSON
 * format (`apollo.training-plan.v1`) for sharing, backing up, and authoring
 * marathon or block training plans with zero vendor lock-in.
 *
 * Security invariants:
 *   - Enforces a 512 KiB payload cap before parsing
 *   - Rejects prototype-pollution keys (`__proto__`, `constructor`, `prototype`)
 *   - Whitelists every field, enum, numeric bound, and note taxonomy value
 *   - Assigns a safe `imported-*` namespace ID so built-in plans can never be shadowed
 *   - Drops untrusted external URLs from imported attribution sources
 *
 * v1.0.9:
 *   - Reads only `apollo.training-plan.v1`: a file that declares another
 *     `schema` / `format` is rejected with a clear message (a bare plan object
 *     without either is read as v1)
 *   - An imported file can't vouch for itself: every imported plan is shown as a
 *     simplified (`representative`), unverified imported plan, with a note saying
 *     so and the author it lists kept as plain text — never as a published
 *     schedule or a coach's endorsement
 *   - Zero-width and bidirectional control characters are stripped from every string
 *   - Race-day semantics: at most one `marathon` day, and only as the last day of
 *     the last week; a marathon is 26.2 mi; a day has at most 50 mi and a week 200 mi
 *   - Saving never replaces a stored plan (see `saveImportedPlan`), and removing
 *     one forgets its stored progress too (see `removeImportedPlan`)
 */

import {
  ALL_BUILT_IN_PLANS,
  CUSTOM_PLAN_ID,
  IMPORTED_PLAN_ID_PREFIX,
  IMPORTED_PLAN_UNKNOWN_AUTHOR,
  PLAN_NOTE_TAXONOMY,
  deleteImportedPlan,
  getImportedPlans,
  isImportedPlanId,
  saveImportedPlan,
  type DayType,
  type PlanCategory,
  type PlanDay,
  type PlanSecondarySession,
  type PlanTier,
  type PlanWeek,
  type TrainingPlan,
} from '../data/plans';
import { forgetPlanProgress } from './planProgress';

export const APOLLO_PLAN_SCHEMA = 'apollo.training-plan.v1' as const;
export const PLAN_EXPORT_FORMAT = APOLLO_PLAN_SCHEMA;
export const MAX_PLAN_JSON_BYTES = 512 * 1024;
const MAX_WEEKS = 52;
/** v1.0.9: most miles one day may hold (primary run + PM double). */
export const MAX_IMPORTED_DAY_MI = 50;
/** v1.0.9: most miles one week may hold (every run, double and race). */
export const MAX_IMPORTED_WEEK_MI = 200;
/** v1.0.9: the only distance a `marathon` day may have. */
const MARATHON_MI = 26.2;
/** v1.0.9: author shown when an imported file doesn't list one. */
const UNKNOWN_AUTHOR = IMPORTED_PLAN_UNKNOWN_AUTHOR;

const VALID_DAY_TYPES = new Set<DayType>(['rest', 'run', 'cross', 'race', 'marathon']);
const VALID_TIERS = new Set<PlanTier>(['beginner', 'intermediate', 'advanced', 'elite', 'specialty']);
const VALID_CATEGORIES = new Set<PlanCategory>([
  'first-marathon',
  'classic-build',
  'high-volume',
  'low-days',
  'threshold-doubles',
  'bq-performance',
  'masters-longevity',
  'time-run-walk',
  'multi-marathon',
  'base-recovery',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * v1.0.9: zero-width and bidirectional control characters (U+061C, U+200B–U+200F,
 * U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, U+FEFF). They can hide text or
 * reorder it on screen (e.g. make a name read as a different coach's), so every
 * imported string drops them.
 */
const INVISIBLE_FORMAT_CHARS = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Map case-insensitive notes to canonical PLAN_NOTE_TAXONOMY entries. */
const NOTE_LOOKUP = new Map<string, string>(PLAN_NOTE_TAXONOMY.map((n) => [n.toLowerCase(), n]));
NOTE_LOOKUP.set('mp', 'Marathon Pace');
NOTE_LOOKUP.set('threshold', 'Tempo');
NOTE_LOOKUP.set('intervals', 'Speed');
NOTE_LOOKUP.set('medium-long', 'Medium Long');
NOTE_LOOKUP.set('race day', 'Race');

export interface ApolloPlanEnvelope {
  schema: typeof APOLLO_PLAN_SCHEMA;
  format: typeof APOLLO_PLAN_SCHEMA;
  exportedAt: string;
  plan: TrainingPlan;
}

export type PlanImportResult = { ok: true; plan: TrainingPlan; warnings: string[] } | { ok: false; error: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasForbiddenKeys(v: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(v)) {
    return v.some((item) => hasForbiddenKeys(item, depth + 1));
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (FORBIDDEN_KEYS.has(k)) return true;
      if (hasForbiddenKeys((v as Record<string, unknown>)[k], depth + 1)) return true;
    }
  }
  return false;
}

function cleanText(raw: unknown, maxLen: number, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  // Strip ASCII control characters except standard spaces
  // eslint-disable-next-line no-control-regex
  const withoutControls = raw.replace(/[\u0000-\u001F\u007F]/g, ' ');
  const cleaned = withoutControls.replace(INVISIBLE_FORMAT_CHARS, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, maxLen) || fallback;
}

/** v1.0.9: a short, sanitised echo of an untrusted value for error and warning messages. */
function shown(raw: unknown): string {
  return cleanText(String(raw), 40);
}

/** v1.0.9: tenths of a mile, without float noise ("7.800000000000001" → 7.8). */
function roundTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'plan'
  );
}

function fnv1aShort(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

function parseSecondary(raw: unknown, warnings: string[], loc: string): PlanSecondarySession | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isPlainObject(raw)) {
    warnings.push(`${loc}: ignored invalid secondary session.`);
    return undefined;
  }
  const dist = Number(raw.distanceMi);
  if (!Number.isFinite(dist) || dist <= 0 || dist > 30) {
    warnings.push(`${loc}: secondary distance must be between 0.1 and 30 miles.`);
    return undefined;
  }
  const distanceMi = Math.round(dist * 10) / 10;
  const noteText = typeof raw.note === 'string' ? raw.note.replace(INVISIBLE_FORMAT_CHARS, '').trim() : '';
  const note: 'Recovery' | 'Easy' = noteText === 'Easy' ? 'Easy' : 'Recovery';
  const label = cleanText(raw.label, 80, `${distanceMi} mi PM ${note.toLowerCase()}`);
  const out: PlanSecondarySession = { label, distanceMi, note };
  if (raw.durationMin !== undefined) {
    const dur = Number(raw.durationMin);
    if (Number.isFinite(dur) && dur >= 5 && dur <= 300) out.durationMin = Math.round(dur);
  }
  return out;
}

function parseDay(raw: unknown, weekNum: number, dayIdx: number, warnings: string[]): PlanDay | string {
  const loc = `Week ${weekNum}, Day ${dayIdx + 1}`;
  if (!isPlainObject(raw)) return `${loc} must be an object.`;
  const rawType =
    typeof raw.type === 'string'
      ? (raw.type.replace(INVISIBLE_FORMAT_CHARS, '').trim().toLowerCase() as DayType)
      : null;
  if (!rawType || !VALID_DAY_TYPES.has(rawType)) {
    return `${loc} has invalid type "${shown(raw.type)}". Expected rest, run, cross, race, or marathon.`;
  }

  let distanceMi: number | undefined;
  if (raw.distanceMi !== undefined && raw.distanceMi !== null && rawType !== 'rest') {
    const d = Number(raw.distanceMi);
    if (!Number.isFinite(d) || d < 0 || d > MAX_IMPORTED_DAY_MI) {
      return `${loc} has invalid distanceMi (${shown(raw.distanceMi)}). Must be 0–${MAX_IMPORTED_DAY_MI} miles.`;
    }
    if (d > 0) distanceMi = roundTenth(d);
  }
  if (rawType === 'marathon') {
    // v1.0.9: a marathon is 26.2 miles — a file can't stretch race day into something else.
    if (distanceMi !== undefined && distanceMi !== MARATHON_MI) {
      return `${loc} is a marathon of ${distanceMi} miles. A marathon day must be ${MARATHON_MI} miles.`;
    }
    distanceMi = MARATHON_MI;
  }

  let note: string | undefined;
  const noteText = typeof raw.note === 'string' ? raw.note.replace(INVISIBLE_FORMAT_CHARS, '').trim() : '';
  if (noteText) {
    const mapped = NOTE_LOOKUP.get(noteText.toLowerCase());
    if (mapped) {
      note = mapped;
    } else {
      warnings.push(`${loc}: unknown workout note "${shown(noteText)}" defaulted to Easy.`);
      note = rawType === 'run' ? 'Easy' : undefined;
    }
  } else if (rawType === 'run') {
    note = 'Easy';
  } else if (rawType === 'race' || rawType === 'marathon') {
    note = 'Race';
  }

  const defaultLabel =
    rawType === 'rest'
      ? 'Rest'
      : rawType === 'cross'
        ? 'Cross'
        : rawType === 'marathon'
          ? 'Marathon'
          : distanceMi
            ? `${distanceMi} mi ${(note ?? 'run').toLowerCase()}`
            : (note ?? 'Run');
  const label = cleanText(raw.label, 100, defaultLabel);

  const day: PlanDay = { type: rawType, label };
  if (distanceMi !== undefined) day.distanceMi = distanceMi;
  if (note !== undefined) day.note = note;
  if (raw.mpFinish === true && rawType === 'run') day.mpFinish = true;
  if (raw.tempoShape === 'progressive' || raw.tempoShape === 'continuous') {
    day.tempoShape = raw.tempoShape;
  }
  if (rawType === 'run') {
    const sec = parseSecondary(raw.secondary, warnings, loc);
    if (sec) day.secondary = sec;
  }
  const dayMi = roundTenth((day.distanceMi ?? 0) + (day.secondary?.distanceMi ?? 0));
  if (dayMi > MAX_IMPORTED_DAY_MI) {
    return `${loc} adds up to ${dayMi} miles with its PM run. A day can have at most ${MAX_IMPORTED_DAY_MI} miles.`;
  }
  if (raw.durationMin !== undefined && raw.durationMin !== null) {
    const dur = Number(raw.durationMin);
    if (Number.isFinite(dur) && dur >= 1 && dur <= 600) day.durationMin = Math.round(dur);
  }
  if (typeof raw.runWalkRatio === 'string' && raw.runWalkRatio.trim()) {
    day.runWalkRatio = cleanText(raw.runWalkRatio, 60);
  }
  return day;
}

/**
 * Parse and validate an `.apollo-plan.json` string into a safe `TrainingPlan`.
 * Never mutates storage; call `importAndSavePlan` to persist.
 */
export function parseApolloPlanJson(jsonText: string): PlanImportResult {
  if (typeof jsonText !== 'string' || jsonText.trim().length === 0) {
    return { ok: false, error: 'Plan file is empty.' };
  }
  const byteLength = new TextEncoder().encode(jsonText).byteLength;
  if (byteLength > MAX_PLAN_JSON_BYTES) {
    return { ok: false, error: 'Plan file exceeds the 512 KB size limit.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'Invalid JSON syntax. Select a valid .apollo-plan.json file.' };
  }

  if (hasForbiddenKeys(parsed)) {
    return { ok: false, error: 'Plan file contains disallowed object keys.' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'Plan file root must be a JSON object.' };
  }

  // v1.0.9: only apollo.training-plan.v1. A file that declares another format (a
  // newer or unknown version) is refused rather than half-read; a bare plan object
  // that declares none is read as v1. A format declared inside the wrapped plan
  // object counts too.
  const rawPlan = isPlainObject(parsed.plan) ? parsed.plan : parsed;
  const declarations =
    rawPlan === parsed
      ? [parsed.schema, parsed.format]
      : [parsed.schema, parsed.format, rawPlan.schema, rawPlan.format];
  for (const declared of declarations) {
    const value = typeof declared === 'string' ? declared.replace(INVISIBLE_FORMAT_CHARS, '').trim() : declared;
    if (value === undefined || value === APOLLO_PLAN_SCHEMA) continue;
    const label = typeof declared === 'string' ? shown(declared) : '';
    return {
      ok: false,
      error: label
        ? `This file uses the plan format “${label}”, which Apollo can’t read. Apollo reads ${APOLLO_PLAN_SCHEMA} plan files.`
        : `This file doesn’t use a plan format Apollo can read. Apollo reads ${APOLLO_PLAN_SCHEMA} plan files.`,
    };
  }

  const warnings: string[] = [];

  const name = cleanText(rawPlan.name, 120);
  if (!name) {
    return { ok: false, error: 'Plan is missing a valid "name" field.' };
  }
  // v1.0.9: the author the file lists, kept as plain text (it is never verified).
  const statedAuthor = cleanText(rawPlan.author, 80);
  const author = statedAuthor || UNKNOWN_AUTHOR;
  const description = cleanText(
    rawPlan.description,
    800,
    statedAuthor ? `Imported training plan by ${statedAuthor}.` : 'Imported training plan.',
  );

  if (!Array.isArray(rawPlan.weeks) || rawPlan.weeks.length === 0) {
    return { ok: false, error: 'Plan must contain at least 1 week in "weeks".' };
  }
  if (rawPlan.weeks.length > MAX_WEEKS) {
    return { ok: false, error: `Plan exceeds the maximum of ${MAX_WEEKS} weeks.` };
  }

  const weeks: PlanWeek[] = [];
  for (let w = 0; w < rawPlan.weeks.length; w++) {
    const rawWeek = rawPlan.weeks[w];
    if (!isPlainObject(rawWeek) || !Array.isArray(rawWeek.days)) {
      return { ok: false, error: `Week ${w + 1} must contain a "days" array of 7 days.` };
    }
    if (rawWeek.days.length !== 7) {
      return {
        ok: false,
        error: `Week ${w + 1} has ${rawWeek.days.length} days; every week must have exactly 7 days (Mon–Sun).`,
      };
    }
    const days: PlanDay[] = [];
    for (let d = 0; d < 7; d++) {
      const dayOrErr = parseDay(rawWeek.days[d], w + 1, d, warnings);
      if (typeof dayOrErr === 'string') return { ok: false, error: dayOrErr };
      days.push(dayOrErr);
    }
    // v1.0.9: weekly total of every run, PM double and race.
    const weekMi = roundTenth(
      days.reduce((sum, day) => sum + (day.distanceMi ?? 0) + (day.secondary?.distanceMi ?? 0), 0),
    );
    if (weekMi > MAX_IMPORTED_WEEK_MI) {
      return {
        ok: false,
        error: `Week ${w + 1} adds up to ${weekMi} miles. A week can have at most ${MAX_IMPORTED_WEEK_MI} miles.`,
      };
    }
    weeks.push({ weekNumber: w + 1, days });
  }

  // v1.0.9: race-day semantics. A plan has at most one marathon — its race day, the
  // last day of the last week (plans without one are blocks with no race day).
  const marathonDays: { week: number; day: number }[] = [];
  weeks.forEach((wk, wi) =>
    wk.days.forEach((d, di) => {
      if (d.type === 'marathon') marathonDays.push({ week: wi + 1, day: di + 1 });
    }),
  );
  if (marathonDays.length > 1) {
    return {
      ok: false,
      error:
        `This plan has ${marathonDays.length} marathon days. A plan can have one marathon at most: ` +
        'its race day, on the last day of the last week.',
    };
  }
  const [race] = marathonDays;
  if (race && (race.week !== weeks.length || race.day !== 7)) {
    return {
      ok: false,
      error:
        `Week ${race.week}, Day ${race.day} is a marathon. A plan’s marathon is its race day, so it must be ` +
        'the last day of the last week.',
    };
  }

  const reservedIds = new Set<string>([CUSTOM_PLAN_ID, ...ALL_BUILT_IN_PLANS.map((p) => p.id)]);
  const requestedId = typeof rawPlan.id === 'string' ? slugify(rawPlan.id) : '';
  const baseSlug =
    requestedId && requestedId.startsWith(IMPORTED_PLAN_ID_PREFIX)
      ? requestedId
      : `${IMPORTED_PLAN_ID_PREFIX}${slugify(name)}`;
  const safeId = reservedIds.has(baseSlug) ? `${baseSlug}-${fnv1aShort(name + author)}` : baseSlug;

  const hasDoubles = weeks.some((wk) => wk.days.some((d) => d.secondary && d.secondary.distanceMi > 0));
  const isTimeBased =
    rawPlan.isTimeBased === true || weeks.some((wk) => wk.days.some((d) => typeof d.durationMin === 'number'));

  const plan: TrainingPlan = {
    id: safeId,
    name,
    author,
    description,
    totalWeeks: weeks.length,
    weeks,
    ...(hasDoubles ? { hasDoubles: true } : {}),
    ...(isTimeBased ? { isTimeBased: true } : {}),
  };

  if (typeof rawPlan.halfMarathonWeek === 'number' && Number.isInteger(rawPlan.halfMarathonWeek)) {
    if (rawPlan.halfMarathonWeek >= 0 && rawPlan.halfMarathonWeek < weeks.length) {
      plan.halfMarathonWeek = rawPlan.halfMarathonWeek;
    }
  }
  if (typeof rawPlan.tier === 'string' && VALID_TIERS.has(rawPlan.tier as PlanTier)) {
    plan.tier = rawPlan.tier as PlanTier;
  }
  if (typeof rawPlan.category === 'string' && VALID_CATEGORIES.has(rawPlan.category as PlanCategory)) {
    plan.category = rawPlan.category as PlanCategory;
  }
  if (Array.isArray(rawPlan.tags)) {
    const cleanTags = rawPlan.tags
      .filter((t): t is string => typeof t === 'string')
      .map((t) => cleanText(t, 32))
      .filter(Boolean)
      .slice(0, 8);
    if (cleanTags.length > 0) plan.tags = cleanTags;
  }
  // v1.0.9: an imported file can't vouch for itself. Whatever its attribution claims
  // (a published schedule, a coach's method or endorsement), the plan is shown as a
  // simplified, unverified imported plan, credited to the author it lists as plain
  // text. Its own attribution note and links are never shown.
  const rawAttribution = isPlainObject(rawPlan.attribution) ? rawPlan.attribution : null;
  if (rawAttribution) {
    if (rawAttribution.fidelity !== undefined && rawAttribution.fidelity !== 'representative') {
      warnings.push('Apollo can’t verify the source this file names, so it’s shown as an unverified imported plan.');
    }
    // Omit untrusted external links on imported files so desktop link policy is never violated.
    if (Array.isArray(rawAttribution.sources) && rawAttribution.sources.length > 0) {
      warnings.push('External attribution links were omitted for security.');
    }
  }
  plan.attribution = {
    coach: author,
    fidelity: 'representative',
    note: statedAuthor
      ? `Imported from a plan file and not verified by Apollo. The file lists “${statedAuthor}” as its author; ` +
        'that doesn’t mean they made or endorse this plan.'
      : 'Imported from a plan file and not verified by Apollo. The file doesn’t list an author.',
    sources: [],
  };

  return { ok: true, plan, warnings };
}

/** Alias for `parseApolloPlanJson` for callers validating raw JSON text. */
export const parseImportedPlanJson = parseApolloPlanJson;

/** True when `plan` (or plan id) is a user-imported plan (`imported-*`). */
export function isImportedPlan(plan: Pick<TrainingPlan, 'id'> | string | null | undefined): boolean {
  return isImportedPlanId(typeof plan === 'string' ? plan : plan?.id);
}

/**
 * Validate and save a raw `.apollo-plan.json` text string synchronously.
 * v1.0.9: never replaces a stored plan — the result has the id (and, for a name
 * already in use, the name) it was saved under.
 */
export function importAndSavePlanText(jsonText: string): PlanImportResult {
  const res = parseApolloPlanJson(jsonText);
  if (!res.ok) return res;
  return { ok: true, plan: saveImportedPlan(res.plan), warnings: res.warnings };
}

/**
 * v1.0.9: remove an imported plan and forget its stored progress (completed days,
 * activity matches, moves and skips), so none of it is left orphaned and a plan
 * imported later under the same id starts clean. Returns false and changes nothing
 * when the plan isn't stored or is the active plan (switch to another plan first).
 */
export function removeImportedPlan(id: string): boolean {
  if (!deleteImportedPlan(id)) return false;
  forgetPlanProgress(id);
  return true;
}

async function readPlanFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the selected plan file.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

/** Validate and save an `.apollo-plan.json` `File` or JSON string into persistent imported plans. */
export async function importAndSavePlan(source: File | string): Promise<PlanImportResult> {
  if (typeof source === 'string') {
    return importAndSavePlanText(source);
  }
  if (!source || typeof source !== 'object') {
    return { ok: false, error: 'Plan file is empty.' };
  }
  if (typeof source.size === 'number' && source.size > MAX_PLAN_JSON_BYTES) {
    return { ok: false, error: 'Plan file exceeds the 512 KB size limit.' };
  }
  try {
    const text = await readPlanFileText(source);
    return importAndSavePlanText(text);
  } catch {
    return { ok: false, error: 'Could not read the selected plan file.' };
  }
}

/** Serialize any `TrainingPlan` into a formatted `.apollo-plan.json` envelope. */
export function serializePlanToJson(plan: TrainingPlan): string {
  const envelope: ApolloPlanEnvelope = {
    schema: APOLLO_PLAN_SCHEMA,
    format: APOLLO_PLAN_SCHEMA,
    exportedAt: new Date().toISOString(),
    plan,
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** Suggested download filename for a training plan (`<slug>.apollo-plan.json`). */
export function planJsonFileName(plan: Pick<TrainingPlan, 'name'>): string {
  return `${slugify(plan.name)}.apollo-plan.json`;
}

/** Trigger a browser/Electron download of `<name>.apollo-plan.json`. */
export function downloadPlanJson(plan: TrainingPlan): void {
  const content = serializePlanToJson(plan);
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = planJsonFileName(plan);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export { getImportedPlans, deleteImportedPlan };
