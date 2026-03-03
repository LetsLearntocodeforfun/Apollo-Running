/**
 * Printable Race Card Service
 *
 * Generates a one-page race day companion with mile splits, nutrition
 * timing, key landmarks, elevation warnings, pace bands, weather,
 * and emergency contacts. Designed to tape to arm or clip to shorts.
 */

import type {
  RaceStrategy,
  MilePacePlan,
  NutritionPlan,
  MarathonRace,
} from '../types/raceStrategy';
import { persistence } from './db/persistence';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RaceCardInput {
  strategy: RaceStrategy;
  marathon?: MarathonRace;
  emergencyContact?: { name: string; phone: string };
  mantras?: Record<number, string>;  // mile → mantra text
  weatherSummary?: string;
  notes?: string;
}

export interface RaceCardMile {
  mile: number;
  targetPace: string;
  cumTime: string;
  elevation: string;            // e.g. "+45 ft" or "flat"
  landmark: string;
  nutrition: string;            // e.g. "Gel #2" or ""
  mantra: string;
}

export interface PaceBand {
  label: string;
  pacePerMi: string;
  fiveKSplit: string;
  halfSplit: string;
  finishTime: string;
}

export interface FiveKCheckpoint {
  label: string;    // e.g. "5K", "10K", "15K", "20K", "Half", "25K", "30K", "35K", "40K"
  distanceMi: number;
  splitTime: string;
  cumTime: string;
}

export interface SegmentSummary {
  label: string;    // e.g. "Miles 1-5", "Miles 6-10", etc.
  startMile: number;
  endMile: number;
  avgPace: string;
  totalTime: string;
}

export interface RaceCard {
  title: string;
  marathonName: string;
  raceDate: string;
  targetFinish: string;
  avgPace: string;
  miles: RaceCardMile[];
  paceBands: PaceBand[];
  /** v2: 5K checkpoint splits */
  fiveKCheckpoints: FiveKCheckpoint[];
  /** v2: 5-mile segment summaries */
  segments: SegmentSummary[];
  nutritionSummary: string;
  elevationWarnings: string[];
  weatherSummary: string;
  emergencyContact: string;
  mantras: string[];
  notes: string;
  htmlContent: string;
}

// ── Storage for user preferences (mantras, emergency contact) ─────────────────

const STORAGE_KEY = 'apollo_race_card_prefs';

export interface RaceCardPreferences {
  emergencyContact?: { name: string; phone: string };
  defaultMantras?: Record<number, string>;
}

export function getRaceCardPrefs(): RaceCardPreferences {
  const raw = persistence.getItem(STORAGE_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function setRaceCardPrefs(prefs: RaceCardPreferences): void {
  persistence.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatPace(secPerMi: number): string {
  const m = Math.floor(secPerMi / 60);
  const s = Math.round(secPerMi % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.round(totalSec % 60);
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function getElevationNote(changeFt: number): string {
  if (Math.abs(changeFt) < 10) return 'flat';
  return changeFt > 0 ? `+${Math.round(changeFt)} ft` : `${Math.round(changeFt)} ft`;
}

function getLandmark(mile: number, marathon?: MarathonRace): string {
  if (!marathon) return '';
  const split = marathon.splits.find((s) => s.endMi >= mile && s.endMi < mile + 1);
  if (split && split.landmarks.length > 0) return split.landmarks[0];

  const point = marathon.course.elevationPoints.find(
    (p) => p.landmark && Math.abs(p.distanceMi - mile) < 0.5,
  );
  return point?.landmark ?? '';
}

function getNutritionAtMile(mile: number, nutritionPlan: NutritionPlan[]): string {
  const item = nutritionPlan.find((n) => Math.abs(n.mile - mile) < 0.5);
  return item ? item.item : '';
}

// ── Pace Band Generator ───────────────────────────────────────────────────────

// ── 5K Checkpoint Generator (v2) ──────────────────────────────────────────────

const CHECKPOINTS = [
  { label: '5K', km: 5 },
  { label: '10K', km: 10 },
  { label: '15K', km: 15 },
  { label: '20K', km: 20 },
  { label: 'Half', km: 21.0975 },
  { label: '25K', km: 25 },
  { label: '30K', km: 30 },
  { label: '35K', km: 35 },
  { label: '40K', km: 40 },
];

export function generate5KCheckpoints(milePaces: MilePacePlan[]): FiveKCheckpoint[] {
  if (milePaces.length === 0) return [];

  return CHECKPOINTS.map((cp) => {
    const distanceMi = cp.km * 0.621371;
    // Interpolate cumulative time at this distance
    const wholeMile = Math.floor(distanceMi);
    const frac = distanceMi - wholeMile;

    let cumTimeSec = 0;
    if (wholeMile > 0 && wholeMile <= milePaces.length) {
      cumTimeSec = milePaces[wholeMile - 1].cumulativeTimeSec;
    }
    if (frac > 0 && wholeMile < milePaces.length) {
      cumTimeSec += milePaces[wholeMile].targetPaceSec * frac;
    }

    // Split time = time for this 5K segment
    const prevCpKm = CHECKPOINTS[CHECKPOINTS.indexOf(cp) - 1]?.km ?? 0;
    const prevMi = prevCpKm * 0.621371;
    let prevCumSec = 0;
    const prevWhole = Math.floor(prevMi);
    const prevFrac = prevMi - prevWhole;
    if (prevWhole > 0 && prevWhole <= milePaces.length) {
      prevCumSec = milePaces[prevWhole - 1].cumulativeTimeSec;
    }
    if (prevFrac > 0 && prevWhole < milePaces.length) {
      prevCumSec += milePaces[prevWhole].targetPaceSec * prevFrac;
    }

    return {
      label: cp.label,
      distanceMi: Math.round(distanceMi * 100) / 100,
      splitTime: formatTime(cumTimeSec - prevCumSec),
      cumTime: formatTime(cumTimeSec),
    };
  });
}

// ── Segment Summary Generator (v2) ────────────────────────────────────────────

export function generateSegmentSummaries(milePaces: MilePacePlan[]): SegmentSummary[] {
  const segmentSize = 5;
  const segments: SegmentSummary[] = [];
  const totalMiles = milePaces.length;

  for (let start = 0; start < totalMiles; start += segmentSize) {
    const end = Math.min(start + segmentSize, totalMiles);
    const segMiles = milePaces.slice(start, end);
    const startMile = segMiles[0].mile;
    const endMile = segMiles[segMiles.length - 1].mile;

    const avgPaceSec = segMiles.reduce((s, m) => s + m.targetPaceSec, 0) / segMiles.length;
    const totalSec = segMiles.reduce((s, m) => s + m.targetPaceSec, 0);

    segments.push({
      label: `Miles ${startMile}-${endMile}`,
      startMile,
      endMile,
      avgPace: formatPace(avgPaceSec),
      totalTime: formatTime(totalSec),
    });
  }

  return segments;
}

function generatePaceBands(targetTimeSec: number): PaceBand[] {
  const targetPace = targetTimeSec / 26.2;
  const bands = [
    { label: 'Goal', offset: 0 },
    { label: 'Conservative', offset: 10 },    // 10s/mi slower
    { label: 'Aggressive', offset: -10 },      // 10s/mi faster
  ];

  return bands.map((band) => {
    const pace = targetPace + band.offset;
    const fiveKSec = pace * 3.10686;
    const halfSec = pace * 13.1;
    const finishSec = pace * 26.2;
    return {
      label: band.label,
      pacePerMi: formatPace(pace),
      fiveKSplit: formatTime(fiveKSec),
      halfSplit: formatTime(halfSec),
      finishTime: formatTime(finishSec),
    };
  });
}

// ── Core Generator ────────────────────────────────────────────────────────────

/**
 * Generate a complete race card from a strategy and optional marathon data.
 */
export function generateRaceCard(input: RaceCardInput): RaceCard {
  const { strategy, marathon, mantras, weatherSummary, notes } = input;
  const emergency = input.emergencyContact ?? getRaceCardPrefs().emergencyContact;
  const userMantras = mantras ?? getRaceCardPrefs().defaultMantras ?? {};

  // Build mile data
  const miles: RaceCardMile[] = strategy.milePaces.map((mp: MilePacePlan) => ({
    mile: mp.mile,
    targetPace: mp.targetPaceFormatted,
    cumTime: mp.cumulativeTimeFormatted,
    elevation: getElevationNote(mp.elevationChangeFt),
    landmark: getLandmark(mp.mile, marathon),
    nutrition: getNutritionAtMile(mp.mile, strategy.nutritionPlan),
    mantra: userMantras[mp.mile] ?? '',
  }));

  // Elevation warnings
  const elevationWarnings: string[] = [];
  for (const mp of strategy.milePaces) {
    if (mp.elevationChangeFt > 50) {
      elevationWarnings.push(`Mile ${mp.mile}: +${Math.round(mp.elevationChangeFt)}ft climb — maintain effort, not pace`);
    }
    if (mp.elevationChangeFt < -80) {
      elevationWarnings.push(`Mile ${mp.mile}: ${Math.round(mp.elevationChangeFt)}ft descent — control pace, protect quads`);
    }
  }

  // Nutrition summary
  const nutritionItems = strategy.nutritionPlan
    .map((n) => `Mile ${n.mile}: ${n.item}`)
    .join(' | ');

  // Mantra list
  const mantraList = Object.entries(userMantras)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([mile, text]) => `Mile ${mile}: ${text}`);

  const paceBands = generatePaceBands(strategy.targetTimeSec);
  const fiveKCheckpoints = generate5KCheckpoints(strategy.milePaces);
  const segments = generateSegmentSummaries(strategy.milePaces);

  const raceDate = marathon?.date ?? '';
  const card: RaceCard = {
    title: `Race Card: ${strategy.marathonName}`,
    marathonName: strategy.marathonName,
    raceDate,
    targetFinish: strategy.targetTimeFormatted,
    avgPace: formatPace(strategy.avgPaceSec),
    miles,
    paceBands,
    fiveKCheckpoints,
    segments,
    nutritionSummary: nutritionItems,
    elevationWarnings,
    weatherSummary: weatherSummary ?? '',
    emergencyContact: emergency ? `${emergency.name}: ${emergency.phone}` : '',
    mantras: mantraList,
    notes: notes ?? '',
    htmlContent: '', // Will be filled below
  };

  card.htmlContent = generateHTML(card);
  return card;
}

// ── HTML Generation ───────────────────────────────────────────────────────────

function generateHTML(card: RaceCard): string {
  const mileSplitsRows = card.miles.map((m) => {
    const nutritionCell = m.nutrition ? `<td class="rc-nutrition">${esc(m.nutrition)}</td>` : '<td></td>';
    const mantraCell = m.mantra ? `<td class="rc-mantra">${esc(m.mantra)}</td>` : '<td></td>';
    const isHalf = m.mile === 13;
    const rowClass = isHalf ? ' class="rc-half-highlight"' : '';
    return `<tr${rowClass}>
      <td class="rc-mile"><strong>${m.mile}</strong></td>
      <td class="rc-pace">${m.targetPace}</td>
      <td class="rc-cum">${m.cumTime}</td>
      <td class="rc-elev">${m.elevation}</td>
      ${nutritionCell}
      ${mantraCell}
    </tr>`;
  }).join('\n');

  const paceBandRows = card.paceBands.map((b) =>
    `<tr><td>${esc(b.label)}</td><td>${b.pacePerMi}/mi</td><td>${b.fiveKSplit}</td><td>${b.halfSplit}</td><td><strong>${b.finishTime}</strong></td></tr>`,
  ).join('\n');

  // v2: 5K checkpoint table
  const checkpointRows = card.fiveKCheckpoints.map((cp) => {
    const isHalf = cp.label === 'Half';
    const rowClass = isHalf ? ' class="rc-half-highlight"' : '';
    return `<tr${rowClass}><td><strong>${esc(cp.label)}</strong></td><td>${cp.splitTime}</td><td><strong>${cp.cumTime}</strong></td></tr>`;
  }).join('\n');

  const checkpointSection = card.fiveKCheckpoints.length > 0
    ? `<div class="rc-section"><h3>📍 Checkpoint Splits</h3>
       <table class="rc-checkpoints">
         <thead><tr><th>Point</th><th>Split</th><th>Clock</th></tr></thead>
         <tbody>${checkpointRows}</tbody>
       </table></div>`
    : '';

  // v2: Segment summary
  const segmentRows = card.segments.map((seg) =>
    `<tr><td>${esc(seg.label)}</td><td>${seg.avgPace}/mi</td><td>${seg.totalTime}</td></tr>`,
  ).join('\n');

  const segmentSection = card.segments.length > 0
    ? `<div class="rc-section"><h3>📊 Segment Summary</h3>
       <table class="rc-segments">
         <thead><tr><th>Segment</th><th>Avg Pace</th><th>Time</th></tr></thead>
         <tbody>${segmentRows}</tbody>
       </table></div>`
    : '';

  const elevWarnings = card.elevationWarnings.length > 0
    ? `<div class="rc-section"><h3>⛰️ Elevation Alerts</h3><ul>${card.elevationWarnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>`
    : '';

  const weatherSection = card.weatherSummary
    ? `<div class="rc-section"><h3>🌤️ Weather</h3><p>${esc(card.weatherSummary)}</p></div>`
    : '';

  const mantraSection = card.mantras.length > 0
    ? `<div class="rc-section"><h3>💪 Mantras</h3><ul>${card.mantras.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`
    : '';

  const emergencySection = card.emergencyContact
    ? `<div class="rc-section"><h3>🆘 Emergency</h3><p>${esc(card.emergencyContact)}</p></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(card.title)}</title>
<style>
  @media print {
    body { margin: 0; padding: 4mm; }
    .no-print { display: none; }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; font-size: 9pt; line-height: 1.3; color: #1a1a1a; max-width: 210mm; margin: 0 auto; padding: 8px; }
  .rc-header { text-align: center; border-bottom: 2px solid #d4a537; padding-bottom: 4px; margin-bottom: 6px; }
  .rc-header h1 { font-size: 14pt; color: #d4a537; margin-bottom: 2px; }
  .rc-header .rc-meta { font-size: 10pt; color: #666; }
  .rc-target { display: flex; justify-content: center; gap: 24px; font-size: 11pt; font-weight: 700; margin: 4px 0; }
  .rc-target span { color: #d4a537; }
  table { width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 6px; }
  th { background: #2a2a2a; color: #d4a537; padding: 3px 4px; text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 2px 4px; border-bottom: 1px solid #eee; }
  tr:nth-child(even) { background: #f9f6ef; }
  .rc-mile { font-weight: 700; font-size: 9pt; }
  .rc-pace { font-family: 'Courier New', monospace; }
  .rc-cum { font-family: 'Courier New', monospace; color: #555; }
  .rc-nutrition { color: #2a7a2a; font-weight: 600; }
  .rc-mantra { color: #7a5a2a; font-style: italic; font-size: 7pt; }
  .rc-elev { color: #888; font-size: 7pt; }
  .rc-section { margin-bottom: 6px; padding: 4px; border-left: 3px solid #d4a537; background: #faf8f2; }
  .rc-section h3 { font-size: 9pt; color: #2a2a2a; margin-bottom: 2px; }
  .rc-section ul { padding-left: 14px; }
  .rc-section li { font-size: 8pt; margin-bottom: 1px; }
  .rc-section p { font-size: 8pt; }
  .rc-pace-bands { margin-bottom: 6px; }
  .rc-pace-bands th, .rc-pace-bands td { text-align: center; }
  .rc-half-highlight { background: #fff3cd !important; font-weight: 700; }
  .rc-checkpoints td, .rc-segments td { font-family: 'Courier New', monospace; }
  .rc-footer { text-align: center; font-size: 7pt; color: #999; margin-top: 4px; border-top: 1px solid #ddd; padding-top: 2px; }
</style>
</head>
<body>
<div class="rc-header">
  <h1>${esc(card.marathonName)}</h1>
  <div class="rc-meta">${esc(card.raceDate)}</div>
  <div class="rc-target">
    <div>Target: <span>${card.targetFinish}</span></div>
    <div>Avg Pace: <span>${card.avgPace}/mi</span></div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>Mi</th><th>Pace</th><th>Time</th><th>Elev</th><th>Fuel</th><th>Note</th>
    </tr>
  </thead>
  <tbody>
    ${mileSplitsRows}
  </tbody>
</table>

<div class="rc-pace-bands">
  <table>
    <thead><tr><th>Band</th><th>Pace</th><th>5K</th><th>Half</th><th>Finish</th></tr></thead>
    <tbody>${paceBandRows}</tbody>
  </table>
</div>

${checkpointSection}
${segmentSection}
${elevWarnings}
${weatherSection}
${mantraSection}
${emergencySection}

<div class="rc-footer">
  Generated by Apollo Running · Trust your training · Execute your strategy
</div>
</body>
</html>`;
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Print / Download ──────────────────────────────────────────────────────────

/**
 * Open race card HTML in a new window for printing.
 */
export function printRaceCard(card: RaceCard): void {
  const blob = new Blob([card.htmlContent], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const win = window.open(blobUrl, '_blank');
  if (!win) {
    URL.revokeObjectURL(blobUrl);
    return;
  }
  win.addEventListener('afterprint', () => URL.revokeObjectURL(blobUrl));
  win.onload = () => win.print();
}

/**
 * Download race card HTML as a file.
 */
export function downloadRaceCard(card: RaceCard): void {
  const blob = new Blob([card.htmlContent], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${card.marathonName.replace(/[^a-zA-Z0-9]/g, '_')}_race_card.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
