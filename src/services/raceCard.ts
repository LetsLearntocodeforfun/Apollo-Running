/**
 * Printable Race Card Service
 *
 * Generates a one-page race day companion with mile splits, nutrition
 * timing, key landmarks, elevation warnings, pace bands, weather,
 * and emergency contacts. Designed to tape to arm or clip to shorts.
 *
 * v1.0.6:
 * - Segment and row times come from cumulative differences, so a partial last
 *   row (26.2, 13.1) is short, never a full mile (L-01).
 * - Distance-aware: pace bands, checkpoints and the halfway time use the
 *   strategy's own distance (L-02); one halfway time from the plan (L-05).
 * - All durations round the total before formatting — never ":60" (L-03).
 * - `unit: 'km'` gives per-km rows, "/km" paces and elevation in metres (L-06).
 * - Landmarks / fuel / mantras are bucketed into the row that contains them,
 *   and several items in one row are joined (L-07).
 * - {@link generateRaceCard} is pure: preferences are passed in, never read.
 * - Printing uses a hidden iframe (window.open is blocked on desktop, L-04).
 */

import type {
  RaceStrategy,
  MilePacePlan,
  NutritionPlan,
  MarathonRace,
} from '../types/raceStrategy';
import { persistence } from './db/persistence';
import {
  KM_PER_MI,
  buildUnitSplits,
  formatDurationSec,
  formatPaceForUnit,
  getStrategyDistanceMi,
  timeAtDistance,
} from './raceStrategy';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Distance unit of a race card. */
export type RaceCardUnit = 'mi' | 'km';

export interface RaceCardInput {
  strategy: RaceStrategy;
  marathon?: MarathonRace;
  emergencyContact?: { name: string; phone: string };
  /** Mantras keyed by distance in MILES (mile → mantra text); shown on the row containing that distance. */
  mantras?: Record<number, string>;
  weatherSummary?: string;
  notes?: string;
  /** Unit for rows, paces, elevation and labels (default 'mi'). */
  unit?: RaceCardUnit;
  /** Race date (YYYY-MM-DD) to print; defaults to `marathon.date`. */
  raceDate?: string;
  /** Extra header line, e.g. "Wave 2 · start 10:00 (America/New_York)". */
  startInfo?: string;
}

/** One row of the split table (a mile or a km, depending on the card's unit). */
export interface RaceCardMile {
  /** Row end distance in the card's unit (1 … 26, 26.2 in miles; 1 … 42, 42.16 in km). */
  mile: number;
  /** Row end distance in miles. */
  endMi: number;
  /** Row label in the card's unit, e.g. "26.2" or "42.2". */
  label: string;
  /** Pace for this row in the card's unit ("m:ss"). */
  targetPace: string;
  /** Time for this row (s), from cumulative differences. */
  splitSec: number;
  /** Time for this row, "h:mm:ss". */
  splitTime: string;
  /** Elapsed time at the end of the row (s). */
  cumSec: number;
  /** Elapsed time at the end of the row, "h:mm:ss". */
  cumTime: string;
  elevation: string;            // e.g. "+45 ft", "+14 m" or "flat"
  landmark: string;
  nutrition: string;            // e.g. "Energy gel 2 (25 g carbs)" or ""
  mantra: string;
}

export interface PaceBand {
  label: string;
  /** Pace per mile ("m:ss"), whatever the card's unit. */
  pacePerMi: string;
  /** Pace in the card's unit ("m:ss"). */
  pace: string;
  /** Elapsed time at 5 km. */
  fiveKSplit: string;
  /** Elapsed time at halfway (distance / 2), using the plan's pacing shape. */
  halfSplit: string;
  finishTime: string;
  finishSec: number;
}

export interface FiveKCheckpoint {
  label: string;    // e.g. "5K", "10K", "15K", "20K", "Half", "25K", "30K", "35K", "40K"
  distanceMi: number;
  /** True 5 km split (time since the previous 5 km mark); '' for the halfway row. */
  splitTime: string;
  /** Elapsed time at the checkpoint, "h:mm:ss". */
  cumTime: string;
  cumSec: number;
}

export interface SegmentSummary {
  label: string;    // e.g. "Miles 1-5", "Miles 6-10", "Km 41-42.2"
  /** First row number of the segment, in the card's unit. */
  startMile: number;
  /** End distance of the segment, in the card's unit. */
  endMile: number;
  /** Distance-weighted average pace in the card's unit ("m:ss"). */
  avgPace: string;
  totalTime: string;
  /** Segment time (s), from cumulative differences. */
  totalSec: number;
}

export interface RaceCard {
  title: string;
  marathonName: string;
  raceDate: string;
  targetFinish: string;
  /** Average goal pace in the card's unit ("m:ss"). */
  avgPace: string;
  unit: RaceCardUnit;
  /** Race distance in miles. */
  distanceMi: number;
  miles: RaceCardMile[];
  paceBands: PaceBand[];
  /** v2: 5K checkpoint splits */
  fiveKCheckpoints: FiveKCheckpoint[];
  /** v2: 5-row segment summaries */
  segments: SegmentSummary[];
  nutritionSummary: string;
  elevationWarnings: string[];
  weatherSummary: string;
  emergencyContact: string;
  mantras: string[];
  notes: string;
  startInfo: string;
  htmlContent: string;
}

// ── Storage for user preferences (mantras, emergency contact) ─────────────────

const STORAGE_KEY = 'apollo_race_card_prefs';

export interface RaceCardPreferences {
  emergencyContact?: { name: string; phone: string };
  /** Mantras keyed by distance in miles. */
  defaultMantras?: Record<number, string>;
}

function sanitizePrefs(raw: unknown): RaceCardPreferences {
  const out: RaceCardPreferences = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { emergencyContact?: unknown; defaultMantras?: unknown };
  const ec = r.emergencyContact as { name?: unknown; phone?: unknown } | undefined;
  if (ec && typeof ec === 'object') {
    const name = typeof ec.name === 'string' ? ec.name : '';
    const phone = typeof ec.phone === 'string' ? ec.phone : '';
    if (name.trim() || phone.trim()) out.emergencyContact = { name, phone };
  }
  if (r.defaultMantras && typeof r.defaultMantras === 'object') {
    const mantras: Record<number, string> = {};
    for (const [k, v] of Object.entries(r.defaultMantras as Record<string, unknown>)) {
      const d = Number(k);
      if (Number.isFinite(d) && d >= 0 && typeof v === 'string' && v.trim()) mantras[d] = v;
    }
    if (Object.keys(mantras).length > 0) out.defaultMantras = mantras;
  }
  return out;
}

/** Saved race card preferences (emergency contact, mantras). */
export function getRaceCardPrefs(): RaceCardPreferences {
  const raw = persistence.getItem(STORAGE_KEY);
  if (!raw) return {};
  try { return sanitizePrefs(JSON.parse(raw)); } catch { return {}; }
}

/** Replace the saved race card preferences (explicit save; idempotent). */
export function setRaceCardPrefs(prefs: RaceCardPreferences): void {
  persistence.setItem(STORAGE_KEY, JSON.stringify(sanitizePrefs(prefs)));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const FT_TO_M = 0.3048;
const EPS = 1e-6;

/** Elapsed time as "h:mm:ss" (always with hours), rounding the total first. */
function formatClock(totalSec: number): string {
  if (!Number.isFinite(totalSec)) return '—';
  const total = Math.max(0, Math.round(totalSec));
  if (total >= 3600) return formatDurationSec(total);
  return `0:${formatDurationSec(total).padStart(5, '0')}`;
}

/** Pace "m:ss" from seconds per unit ('—' when unusable). */
function formatUnitPace(secPerUnit: number): string {
  return Number.isFinite(secPerUnit) && secPerUnit > 0 ? formatDurationSec(secPerUnit) : '—';
}

/** Distance number with at most one decimal ("26.2", "42.2", "8"). */
function fmtDist(x: number): string {
  return String(Math.round(x * 10) / 10);
}

/** "Mile 20" / "km 32.2" for a distance in miles. */
function distanceLabel(mi: number, unit: RaceCardUnit): string {
  return unit === 'km' ? `km ${fmtDist(mi * KM_PER_MI)}` : `Mile ${fmtDist(mi)}`;
}

/** "Sun 11 Oct 2026" for a date key (time-zone independent); other strings unchanged. */
function formatRaceDate(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

function elevationNote(changeFt: number, unit: RaceCardUnit): string {
  if (unit === 'km') {
    const m = changeFt * FT_TO_M;
    if (Math.abs(m) < 3) return 'flat';
    return m > 0 ? `+${Math.round(m)} m` : `${Math.round(m)} m`;
  }
  if (Math.abs(changeFt) < 10) return 'flat';
  return changeFt > 0 ? `+${Math.round(changeFt)} ft` : `${Math.round(changeFt)} ft`;
}

/** Elevation change (ft) between two distances, spreading each plan segment's change evenly. */
function elevationChangeBetween(milePaces: MilePacePlan[], fromMi: number, toMi: number): number {
  let total = 0;
  let prevEnd = 0;
  for (const mp of milePaces) {
    const len = mp.mile - prevEnd;
    if (len > 0) {
      const overlap = Math.min(toMi, mp.mile) - Math.max(fromMi, prevEnd);
      if (overlap > 0) total += mp.elevationChangeFt * (overlap / len);
    }
    prevEnd = mp.mile;
  }
  return total;
}

/** Internal row before course data is attached. */
interface BaseRow {
  endUnit: number;
  startMi: number;
  endMi: number;
  paceSecPerUnit: number;
  splitSec: number;
  cumSec: number;
  elevationChangeFt: number;
}

/** Rows in the card's unit. Mile rows use the plan directly; km rows interpolate it. */
function buildBaseRows(milePaces: MilePacePlan[], unit: RaceCardUnit, distanceMi: number): BaseRow[] {
  if (unit === 'mi') {
    let prevEnd = 0;
    let prevCum = 0;
    return milePaces.map((mp) => {
      const row: BaseRow = {
        endUnit: mp.mile,
        startMi: prevEnd,
        endMi: mp.mile,
        paceSecPerUnit: mp.targetPaceSec,
        splitSec: mp.cumulativeTimeSec - prevCum,
        cumSec: mp.cumulativeTimeSec,
        elevationChangeFt: mp.elevationChangeFt,
      };
      prevEnd = mp.mile;
      prevCum = mp.cumulativeTimeSec;
      return row;
    });
  }
  let prevMi = 0;
  return buildUnitSplits(milePaces, 'km', distanceMi).map((s) => {
    const row: BaseRow = {
      endUnit: s.endDistance,
      startMi: prevMi,
      endMi: s.endMi,
      paceSecPerUnit: s.paceSecPerUnit,
      splitSec: s.splitSec,
      cumSec: s.cumulativeSec,
      elevationChangeFt: elevationChangeBetween(milePaces, prevMi, s.endMi),
    };
    prevMi = s.endMi;
    return row;
  });
}

/** Index of the row containing `mi` (a point exactly on a row end belongs to that row). */
function rowIndexAt(rows: Pick<BaseRow, 'endMi'>[], mi: number): number {
  if (rows.length === 0) return -1;
  if (!(mi > 0)) return 0;
  const i = rows.findIndex((r) => r.endMi >= mi - EPS);
  return i >= 0 ? i : rows.length - 1;
}

/** Add `text` to a row bucket, skipping duplicates and names contained in longer ones. */
function addUnique(bucket: string[], text: string): void {
  const t = text.trim();
  if (!t) return;
  const lower = t.toLowerCase();
  for (let i = 0; i < bucket.length; i++) {
    const existing = bucket[i].toLowerCase();
    if (existing.includes(lower)) return;
    if (lower.includes(existing)) { bucket[i] = t; return; }
  }
  bucket.push(t);
}

function landmarkBuckets(rows: BaseRow[], marathon?: MarathonRace): string[][] {
  const buckets = rows.map(() => [] as string[]);
  if (!marathon || rows.length === 0) return buckets;
  let prevEnd = 0;
  for (const split of marathon.splits ?? []) {
    const mid = (prevEnd + split.endMi) / 2;
    prevEnd = split.endMi;
    for (const name of split.landmarks ?? []) addUnique(buckets[rowIndexAt(rows, mid)], name);
  }
  for (const p of marathon.course?.elevationPoints ?? []) {
    if (p.landmark) addUnique(buckets[rowIndexAt(rows, p.distanceMi)], p.landmark);
  }
  return buckets;
}

/** True for in-race items (pre-race items stay in the summary only). */
function isInRaceItem(n: NutritionPlan): boolean {
  if (typeof n.timeSec === 'number' && n.timeSec < 0) return false;
  return n.mile > 0;
}

function nutritionBuckets(rows: BaseRow[], plan: NutritionPlan[]): string[][] {
  const buckets = rows.map(() => [] as string[]);
  for (const n of plan) {
    if (!isInRaceItem(n) || rows.length === 0) continue;
    buckets[rowIndexAt(rows, n.mile)].push(n.item);
  }
  return buckets;
}

function mantraEntries(mantras: Record<number, string>): Array<[number, string]> {
  return Object.entries(mantras)
    .map(([k, v]) => [Number(k), v] as [number, string])
    .filter(([d, v]) => Number.isFinite(d) && typeof v === 'string' && v.trim() !== '')
    .sort((a, b) => a[0] - b[0]);
}

// ── Pace Band Generator ───────────────────────────────────────────────────────

/** Marathon-like distances label the halfway point "Half"; others "Halfway". */
function halfLabel(distanceMi: number): string {
  return distanceMi >= 25.5 && distanceMi <= 27 ? 'Half' : 'Halfway';
}

function generatePaceBands(strategy: RaceStrategy, distanceMi: number, unit: RaceCardUnit): PaceBand[] {
  const mp = strategy.milePaces;
  if (distanceMi <= 0) return [];
  const goalPace = strategy.targetTimeSec / distanceMi;
  const planFinish = mp.length > 0 ? timeAtDistance(mp, distanceMi) : strategy.targetTimeSec;
  const planFiveK = mp.length > 0 ? timeAtDistance(mp, Math.min(5 / KM_PER_MI, distanceMi)) : goalPace * (5 / KM_PER_MI);
  const planHalf = mp.length > 0 ? timeAtDistance(mp, distanceMi / 2) : strategy.targetTimeSec / 2;
  const bands = [
    { label: 'Goal', offset: 0 },
    { label: 'Conservative', offset: 10 },    // 10s/mi slower
    { label: 'Aggressive', offset: -10 },      // 10s/mi faster
  ];

  return bands.map((band) => {
    const pace = goalPace + band.offset;
    // Each band keeps the plan's pacing shape, scaled to its average pace.
    const factor = goalPace > 0 ? pace / goalPace : 1;
    const finishSec = planFinish * factor;
    return {
      label: band.label,
      pacePerMi: formatPaceForUnit(pace, 'mi'),
      pace: formatPaceForUnit(pace, unit),
      fiveKSplit: formatClock(planFiveK * factor),
      halfSplit: formatClock(planHalf * factor),
      finishTime: formatClock(finishSec),
      finishSec: Math.round(finishSec),
    };
  });
}

// ── 5K Checkpoint Generator (v2) ──────────────────────────────────────────────

const CHECKPOINT_KM = [5, 10, 15, 20, 25, 30, 35, 40];

/**
 * 5 km checkpoints up to the race distance plus the halfway point
 * (distance / 2). 5 km rows carry true 5 km splits; the halfway row is
 * cumulative only. `distanceMi` defaults to the last plan entry.
 */
export function generate5KCheckpoints(milePaces: MilePacePlan[], distanceMi?: number): FiveKCheckpoint[] {
  if (milePaces.length === 0) return [];
  const total = distanceMi ?? milePaces[milePaces.length - 1].mile;
  if (!(total > 0)) return [];

  const out: FiveKCheckpoint[] = [];
  for (const km of CHECKPOINT_KM) {
    const mi = km / KM_PER_MI;
    if (mi > total + EPS) break;
    const cum = timeAtDistance(milePaces, mi);
    const prev = timeAtDistance(milePaces, (km - 5) / KM_PER_MI);
    out.push({
      label: `${km}K`,
      distanceMi: Math.round(mi * 100) / 100,
      splitTime: formatClock(cum - prev),
      cumTime: formatClock(cum),
      cumSec: Math.round(cum),
    });
  }
  const halfMi = total / 2;
  const halfCum = timeAtDistance(milePaces, halfMi);
  out.push({
    label: halfLabel(total),
    distanceMi: Math.round(halfMi * 100) / 100,
    splitTime: '',
    cumTime: formatClock(halfCum),
    cumSec: Math.round(halfCum),
  });
  return out.sort((a, b) => a.distanceMi - b.distanceMi);
}

// ── Segment Summary Generator (v2) ────────────────────────────────────────────

/**
 * Summaries of 5 rows each (5 miles or 5 km). Times are cumulative
 * differences and the average pace is distance-weighted, so a partial last
 * row is handled correctly. `distanceMi` defaults to the last plan entry.
 */
export function generateSegmentSummaries(
  milePaces: MilePacePlan[],
  unit: RaceCardUnit = 'mi',
  distanceMi?: number,
): SegmentSummary[] {
  if (milePaces.length === 0) return [];
  const total = distanceMi ?? milePaces[milePaces.length - 1].mile;
  const rows = buildBaseRows(milePaces, unit, total);
  const word = unit === 'km' ? 'Km' : 'Miles';
  const single = unit === 'km' ? 'Km' : 'Mile';
  const segmentSize = 5;
  const segments: SegmentSummary[] = [];

  for (let start = 0; start < rows.length; start += segmentSize) {
    const end = Math.min(start + segmentSize, rows.length) - 1;
    const startDist = start === 0 ? 0 : rows[start - 1].endUnit;
    const endDist = rows[end].endUnit;
    const prevCum = start === 0 ? 0 : rows[start - 1].cumSec;
    const totalSec = rows[end].cumSec - prevCum;
    const length = endDist - startDist;
    const firstRow = start + 1;
    const endLabel = fmtDist(endDist);

    segments.push({
      label: endLabel === String(firstRow) ? `${single} ${firstRow}` : `${word} ${firstRow}-${endLabel}`,
      startMile: firstRow,
      endMile: endDist,
      avgPace: formatUnitPace(length > 0 ? totalSec / length : NaN),
      totalTime: formatClock(totalSec),
      totalSec,
    });
  }

  return segments;
}

// ── Core Generator ────────────────────────────────────────────────────────────

function emergencyText(ec?: { name: string; phone: string }): string {
  if (!ec) return '';
  const name = (ec.name ?? '').trim();
  const phone = (ec.phone ?? '').trim();
  if (name && phone) return `${name}: ${phone}`;
  return name || phone;
}

/**
 * Generate a complete race card from a strategy and optional marathon data.
 * Pure: emergency contact and mantras come from `input` (see
 * {@link getRaceCardPrefs} for the saved values).
 */
export function generateRaceCard(input: RaceCardInput): RaceCard {
  const { strategy, marathon, weatherSummary, notes } = input;
  const unit: RaceCardUnit = input.unit === 'km' ? 'km' : 'mi';
  const userMantras = input.mantras ?? {};
  const distanceMi = getStrategyDistanceMi(strategy);
  const milePaces = strategy.milePaces;

  // Build row data
  const baseRows = buildBaseRows(milePaces, unit, distanceMi);
  const landmarks = landmarkBuckets(baseRows, marathon);
  const fuel = nutritionBuckets(baseRows, strategy.nutritionPlan ?? []);
  const mantraRows = baseRows.map(() => [] as string[]);
  const mantraList: string[] = [];
  for (const [d, text] of mantraEntries(userMantras)) {
    if (baseRows.length > 0) mantraRows[rowIndexAt(baseRows, d)].push(text);
    mantraList.push(`${distanceLabel(d, unit)}: ${text}`);
  }

  const miles: RaceCardMile[] = baseRows.map((r, i) => ({
    mile: r.endUnit,
    endMi: r.endMi,
    label: fmtDist(r.endUnit),
    targetPace: formatUnitPace(r.paceSecPerUnit),
    splitSec: r.splitSec,
    splitTime: formatClock(r.splitSec),
    cumSec: r.cumSec,
    cumTime: formatClock(r.cumSec),
    elevation: elevationNote(r.elevationChangeFt, unit),
    landmark: landmarks[i].join(' · '),
    nutrition: fuel[i].join(' · '),
    mantra: mantraRows[i].join(' · '),
  }));

  // Elevation warnings (per plan segment; thresholds are per mile)
  const elevationWarnings: string[] = [];
  let prevEnd = 0;
  for (const mp of milePaces) {
    const where = unit === 'km'
      ? `km ${fmtDist(prevEnd * KM_PER_MI)}–${fmtDist(mp.mile * KM_PER_MI)}`
      : `Mile ${fmtDist(mp.mile)}`;
    const change = elevationNote(mp.elevationChangeFt, unit);
    if (mp.elevationChangeFt > 50) {
      elevationWarnings.push(`${where}: ${change} climb — maintain effort, not pace`);
    }
    if (mp.elevationChangeFt < -80) {
      elevationWarnings.push(`${where}: ${change} descent — control pace, protect quads`);
    }
    prevEnd = mp.mile;
  }

  // Nutrition summary
  const nutritionItems = (strategy.nutritionPlan ?? [])
    .map((n) => `${isInRaceItem(n) ? distanceLabel(n.mile, unit) : 'Before start'}: ${n.item}`)
    .join(' | ');

  const paceBands = generatePaceBands(strategy, distanceMi, unit);
  const fiveKCheckpoints = generate5KCheckpoints(milePaces, distanceMi);
  const segments = generateSegmentSummaries(milePaces, unit, distanceMi);

  const raceDate = input.raceDate ?? marathon?.date ?? '';
  const card: RaceCard = {
    title: `Race Card: ${strategy.marathonName}`,
    marathonName: strategy.marathonName,
    raceDate,
    targetFinish: formatClock(strategy.targetTimeSec),
    avgPace: distanceMi > 0 ? formatPaceForUnit(strategy.targetTimeSec / distanceMi, unit) : '—',
    unit,
    distanceMi,
    miles,
    paceBands,
    fiveKCheckpoints,
    segments,
    nutritionSummary: nutritionItems,
    elevationWarnings,
    weatherSummary: weatherSummary ?? '',
    emergencyContact: emergencyText(input.emergencyContact),
    mantras: mantraList,
    notes: notes ?? '',
    startInfo: input.startInfo ?? '',
    htmlContent: '', // Will be filled below
  };

  card.htmlContent = generateHTML(card);
  return card;
}

// ── HTML Generation ───────────────────────────────────────────────────────────

function section(icon: string, title: string, body: string): string {
  return `<div class="rc-section"><h3><span aria-hidden="true">${icon}</span> ${esc(title)}</h3>${body}</div>`;
}

function generateHTML(card: RaceCard): string {
  const paceUnit = card.unit === 'km' ? '/km' : '/mi';
  const halfMi = card.distanceMi / 2;
  const halfRow = card.miles.findIndex((m) => m.endMi >= halfMi - EPS);

  const mileSplitsRows = card.miles.map((m, i) => {
    const nutritionCell = m.nutrition ? `<td class="rc-nutrition">${esc(m.nutrition)}</td>` : '<td></td>';
    const noteParts = [
      m.landmark ? `<span class="rc-landmark">${esc(m.landmark)}</span>` : '',
      m.mantra ? `<span class="rc-mantra">${esc(m.mantra)}</span>` : '',
    ].filter(Boolean).join('<br>');
    const rowClass = i === halfRow ? ' class="rc-half-highlight"' : '';
    return `<tr${rowClass}>
      <td class="rc-mile"><strong>${esc(m.label)}</strong></td>
      <td class="rc-pace">${esc(m.targetPace)}</td>
      <td class="rc-cum">${esc(m.cumTime)}</td>
      <td class="rc-elev">${esc(m.elevation)}</td>
      ${nutritionCell}
      <td class="rc-note">${noteParts}</td>
    </tr>`;
  }).join('\n');

  const paceBandRows = card.paceBands.map((b) =>
    `<tr><td>${esc(b.label)}</td><td>${esc(b.pace)}${paceUnit}</td><td>${esc(b.fiveKSplit)}</td><td>${esc(b.halfSplit)}</td><td><strong>${esc(b.finishTime)}</strong></td></tr>`,
  ).join('\n');

  // v2: 5K checkpoint table (true 5 km splits; the halfway row is cumulative only)
  const checkpointRows = card.fiveKCheckpoints.map((cp) => {
    const isHalf = cp.splitTime === '';
    const rowClass = isHalf ? ' class="rc-half-highlight"' : '';
    return `<tr${rowClass}><td><strong>${esc(cp.label)}</strong></td><td>${isHalf ? '—' : esc(cp.splitTime)}</td><td><strong>${esc(cp.cumTime)}</strong></td></tr>`;
  }).join('\n');

  const checkpointSection = card.fiveKCheckpoints.length > 0
    ? section('📍', 'Checkpoint Splits', `
       <table class="rc-checkpoints">
         <thead><tr><th>Point</th><th>5K split</th><th>Clock</th></tr></thead>
         <tbody>${checkpointRows}</tbody>
       </table>`)
    : '';

  // v2: Segment summary
  const segmentRows = card.segments.map((seg) =>
    `<tr><td>${esc(seg.label)}</td><td>${esc(seg.avgPace)}${paceUnit}</td><td>${esc(seg.totalTime)}</td></tr>`,
  ).join('\n');

  const segmentSection = card.segments.length > 0
    ? section('📊', 'Segment Summary', `
       <table class="rc-segments">
         <thead><tr><th>Segment</th><th>Avg Pace</th><th>Time</th></tr></thead>
         <tbody>${segmentRows}</tbody>
       </table>`)
    : '';

  const list = (items: string[]) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const elevWarnings = card.elevationWarnings.length > 0 ? section('⛰️', 'Elevation Alerts', list(card.elevationWarnings)) : '';
  const weatherSection = card.weatherSummary ? section('🌤️', 'Weather', `<p>${esc(card.weatherSummary)}</p>`) : '';
  const mantraSection = card.mantras.length > 0 ? section('💪', 'Mantras', list(card.mantras)) : '';
  const notesSection = card.notes ? section('📝', 'Notes', `<p>${esc(card.notes)}</p>`) : '';
  const emergencySection = card.emergencyContact ? section('🆘', 'Emergency', `<p>${esc(card.emergencyContact)}</p>`) : '';
  const meta = [card.raceDate ? formatRaceDate(card.raceDate) : '', card.startInfo].filter(Boolean).join(' · ');
  const rowUnit = card.unit === 'km' ? 'Km' : 'Mi';
  const halfHeader = halfLabel(card.distanceMi);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(card.title)}</title>
<style>
  @media print {
    body { margin: 0; padding: 4mm; }
    .no-print { display: none; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 9pt; line-height: 1.3; color: #1a1a1a; background: #fff; max-width: 210mm; margin: 0 auto; padding: 8px; }
  .rc-header { text-align: center; border-bottom: 2px solid #d4a537; padding-bottom: 4px; margin-bottom: 6px; }
  .rc-header h1 { font-size: 14pt; color: #8a6514; margin-bottom: 2px; }
  .rc-header .rc-meta { font-size: 10pt; color: #555; }
  .rc-target { display: flex; justify-content: center; gap: 24px; font-size: 11pt; font-weight: 700; margin: 4px 0; }
  .rc-target span { color: #8a6514; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 6px; }
  th { background: #2a2a2a; color: #f0d68a; padding: 3px 4px; text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 2px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
  tr:nth-child(even) { background: #f9f6ef; }
  .rc-mile { font-weight: 700; font-size: 9pt; }
  .rc-pace { font-family: 'Courier New', monospace; }
  .rc-cum { font-family: 'Courier New', monospace; color: #444; }
  .rc-nutrition { color: #1f6b1f; font-weight: 600; }
  .rc-landmark { color: #333; font-size: 7pt; }
  .rc-mantra { color: #6b4d1f; font-style: italic; font-size: 7pt; }
  .rc-elev { color: #555; font-size: 7pt; }
  .rc-section { margin-bottom: 6px; padding: 4px; border-left: 3px solid #d4a537; background: #faf8f2; }
  .rc-section h3 { font-size: 9pt; color: #2a2a2a; margin-bottom: 2px; }
  .rc-section ul { padding-left: 14px; }
  .rc-section li { font-size: 8pt; margin-bottom: 1px; }
  .rc-section p { font-size: 8pt; }
  .rc-pace-bands { margin-bottom: 6px; }
  .rc-pace-bands th, .rc-pace-bands td { text-align: center; }
  .rc-half-highlight { background: #fff3cd !important; font-weight: 700; }
  .rc-checkpoints td, .rc-segments td { font-family: 'Courier New', monospace; }
  .rc-footer { text-align: center; font-size: 7pt; color: #666; margin-top: 4px; border-top: 1px solid #ddd; padding-top: 2px; }
</style>
</head>
<body>
<div class="rc-header">
  <h1>${esc(card.marathonName)}</h1>
  <div class="rc-meta">${esc(meta)}</div>
  <div class="rc-target">
    <div>Target: <span>${esc(card.targetFinish)}</span></div>
    <div>Avg Pace: <span>${esc(card.avgPace)}${paceUnit}</span></div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>${rowUnit}</th><th>Pace ${paceUnit}</th><th>Time</th><th>Elev</th><th>Fuel</th><th>Notes</th>
    </tr>
  </thead>
  <tbody>
    ${mileSplitsRows}
  </tbody>
</table>

<div class="rc-pace-bands">
  <table>
    <thead><tr><th>Band</th><th>Pace</th><th>5K</th><th>${halfHeader}</th><th>Finish</th></tr></thead>
    <tbody>${paceBandRows}</tbody>
  </table>
</div>

${checkpointSection}
${segmentSection}
${elevWarnings}
${weatherSection}
${mantraSection}
${notesSection}
${emergencySection}

<div class="rc-footer">
  Generated by Apollo Running · Trust your training · Execute your strategy
</div>
</body>
</html>`;
}

function esc(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Print / Download ──────────────────────────────────────────────────────────

/** Attribute that marks the hidden print frame. */
export const PRINT_FRAME_ATTR = 'data-apollo-print-frame';
/** Fallback removal when `afterprint` never fires (the frame is invisible and harmless). */
const PRINT_FRAME_TTL_MS = 5 * 60 * 1000;

/**
 * Print an HTML document through a hidden iframe (srcdoc → onload →
 * contentWindow.print() → remove). Works in the desktop app, where
 * window.open is blocked. The frame is deliberately NOT sandboxed: a sandbox
 * without allow-modals blocks print(). The HTML has no scripts (all user
 * text is escaped and its CSP meta forbids scripts). Returns false without a DOM.
 */
export function printHtmlInHiddenFrame(html: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  document.querySelectorAll(`iframe[${PRINT_FRAME_ATTR}]`).forEach((f) => f.remove());

  const frame = document.createElement('iframe');
  frame.setAttribute(PRINT_FRAME_ATTR, '');
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.title = 'Race card print frame';
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';

  let started = false;
  const remove = () => frame.remove();
  frame.addEventListener('load', () => {
    if (started) return;
    started = true;
    const win = frame.contentWindow;
    if (!win) { remove(); return; }
    try {
      win.addEventListener('afterprint', () => setTimeout(remove, 0), { once: true });
      win.focus();
      win.print();
    } catch {
      remove();
      return;
    }
    setTimeout(remove, PRINT_FRAME_TTL_MS);
  });
  frame.srcdoc = html;
  document.body.appendChild(frame);
  return true;
}

/**
 * Print the race card (hidden iframe; no window.open).
 */
export function printRaceCard(card: RaceCard): boolean {
  return printHtmlInHiddenFrame(card.htmlContent);
}

/** File name for a downloaded race card. */
export function raceCardFileName(card: Pick<RaceCard, 'marathonName'>): string {
  const base = card.marathonName.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${base || 'race'}_race_card.html`;
}

/**
 * Download race card HTML as a file.
 */
export function downloadRaceCard(card: RaceCard): void {
  const blob = new Blob([card.htmlContent], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = raceCardFileName(card);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke later: revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
