/**
 * Tests for Epic 2B: 1-Click Open CSV Export (`src/services/csvExport.ts`).
 *
 * Covers RFC 4180 escaping, spreadsheet formula-injection neutralization,
 * UTF-8 BOM download behavior, Activities CSV, Splits CSV, Wellness CSV, and
 * Training Journal CSV (including when the journal feature toggle is off).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ACTIVITIES_CSV_HEADERS,
  JOURNAL_CSV_HEADERS,
  SPLITS_CSV_HEADERS,
  WELLNESS_CSV_HEADERS,
  buildActivitiesCsv,
  buildJournalCsv,
  buildSplitsCsv,
  buildWellnessCsv,
  downloadCsv,
  escapeCsvCell,
  exportActivitiesCsv,
  exportJournalCsv,
  exportSplitsCsv,
  exportWellnessCsv,
  rowsToCsv,
  sanitizeCsvFormula,
} from '@/services/csvExport';
import { storeActivities } from '@/services/analyticsService';
import { persistence } from '@/services/db/persistence';
import { disableJournal, enableJournal, isJournalEnabled, saveJournalEntry } from '@/services/trainingJournal';
import { getAllWellnessRecords, type WellnessRecord } from '@/services/wellness';
import type { Activity } from '@/services/activity/types';

let capturedBlob: Blob | null = null;
let capturedFilename = '';

beforeEach(() => {
  capturedBlob = null;
  capturedFilename = '';
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    capturedBlob = b;
    return 'blob:csv-test';
  };
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    capturedFilename = this.download;
  };
});

/**
 * Minimal RFC 4180 reader for round-trip checks: quoted fields, doubled
 * quotes, CRLF rows. Like spreadsheet importers, it honors a quote only at
 * the start of a field.
 */
function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      fieldStart = true;
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStart = true;
      i++;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/**
 * The cells Excel makes of a comma-separated file in a locale whose list
 * separator is `;` (de, fr, es, it): every `;`, CR and LF outside a quoted
 * section ends a cell, and a double quote opens a quoted section only at the
 * very start of a cell; once it closes, the rest of the cell is read as is.
 * Commas are ordinary characters there.
 */
function semicolonLocaleCells(text: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  let atStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && atStart) {
      quoted = true;
      atStart = false;
    } else if (ch === ';' || ch === '\r' || ch === '\n') {
      cells.push(cell);
      cell = '';
      atStart = true;
    } else {
      cell += ch;
      atStart = false;
    }
  }
  cells.push(cell);
  return cells;
}

/** A cell a spreadsheet would treat as a formula (leading spaces and invisible characters ignored). */
const looksLikeFormula = (cell: string) =>
  /^[\s\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]*[=+\-@|\uFF1D\uFF0B\uFF0D\uFF20]/.test(cell);

describe('CSV escaping & formula-injection neutralization', () => {
  it('neutralizes formula prefixes (=, +, -, @, |, tab, CR, LF) and ASCII/Unicode whitespace before formula prefixes', () => {
    expect(sanitizeCsvFormula("=CMD|'/C calc'!A0")).toBe("'=CMD|'/C calc'!A0");
    expect(sanitizeCsvFormula('+SUM(A1:A10)')).toBe("'+SUM(A1:A10)");
    expect(sanitizeCsvFormula('-1+1')).toBe("'-1+1");
    expect(sanitizeCsvFormula('@import("https://evil.example")')).toBe('\'@import("https://evil.example")');
    expect(sanitizeCsvFormula('|/bin/sh')).toBe("'|/bin/sh");
    expect(sanitizeCsvFormula('  =1+1')).toBe("'  =1+1");
    expect(sanitizeCsvFormula('\u00A0=1+1')).toBe("'\u00A0=1+1");
    expect(sanitizeCsvFormula('\t=1')).toBe("'\t=1");
    // A trigger after a line break gets its own quote too (it could start a row of its own).
    expect(sanitizeCsvFormula('\r=1')).toBe("'\r'=1");
    expect(sanitizeCsvFormula('\n+2')).toBe("'\n'+2");
    expect(sanitizeCsvFormula('\ninjected')).toBe("'\ninjected");

    // Normal strings stay untouched
    expect(sanitizeCsvFormula('Morning Tempo - 10 km')).toBe('Morning Tempo - 10 km');
    expect(sanitizeCsvFormula('  Easy shakeout')).toBe('  Easy shakeout');
    expect(sanitizeCsvFormula('')).toBe('');
  });

  it('neutralizes the full-width trigger forms (＝ ＋ － ＠) used by East Asian input methods', () => {
    expect(sanitizeCsvFormula('\uFF1D1+1')).toBe("'\uFF1D1+1");
    expect(sanitizeCsvFormula('\uFF0B1')).toBe("'\uFF0B1");
    expect(sanitizeCsvFormula('\uFF0D1')).toBe("'\uFF0D1");
    expect(sanitizeCsvFormula('\uFF20SUM(A1)')).toBe("'\uFF20SUM(A1)");
    expect(sanitizeCsvFormula('\u3000\uFF1D1')).toBe("'\u3000\uFF1D1");
    expect(escapeCsvCell('\uFF1DHYPERLINK("http://evil.example")')).toBe(
      '"\'\uFF1DHYPERLINK(""http://evil.example"")"',
    );
    // A full-width trigger later in the text is ordinary data
    expect(sanitizeCsvFormula('Tempo \uFF0B strides')).toBe('Tempo \uFF0B strides');
  });

  it('treats leading zero-width and bidi format characters like whitespace, so a hidden trigger is still neutralized', () => {
    for (const hidden of [
      '\u200B',
      '\u200C',
      '\u200D',
      '\u200E',
      '\u200F',
      '\u202A',
      '\u202B',
      '\u202C',
      '\u202D',
      '\u202E',
      '\u2060',
      '\u2061',
      '\u2062',
      '\u2063',
      '\u2064',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
      '\uFEFF',
    ]) {
      expect(sanitizeCsvFormula(`${hidden}=1+1`)).toBe(`'${hidden}=1+1`);
    }
    expect(sanitizeCsvFormula('\u202E\u200B @SUM(A1)')).toBe("'\u202E\u200B @SUM(A1)");
    expect(sanitizeCsvFormula('\u2066\uFF0Bcmd')).toBe("'\u2066\uFF0Bcmd");
    // Invisible characters before ordinary text are left alone
    expect(sanitizeCsvFormula('\u200BLong run')).toBe('\u200BLong run');
    expect(sanitizeCsvFormula('\u202EEasy 5 km')).toBe('\u202EEasy 5 km');
  });

  it('preserves genuine finite negative numbers while neutralizing negative-prefixed strings', () => {
    expect(escapeCsvCell(-12.5)).toBe('-12.5');
    expect(escapeCsvCell(0)).toBe('0');
    expect(escapeCsvCell(42.195)).toBe('42.195');
    expect(escapeCsvCell(Number.NaN)).toBe('');
    expect(escapeCsvCell(Number.POSITIVE_INFINITY)).toBe('');
    expect(escapeCsvCell('-1+1')).toBe('"\'-1+1"');
  });

  it('quotes every string cell RFC 4180-style (quotes doubled) and leaves numbers, booleans and nulls bare', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
    expect(escapeCsvCell(true)).toBe('true');
    expect(escapeCsvCell(false)).toBe('false');
    expect(escapeCsvCell('Easy run')).toBe('"Easy run"');
    expect(escapeCsvCell('')).toBe('""');
    expect(escapeCsvCell('Track, Lane 1')).toBe('"Track, Lane 1"');
    expect(escapeCsvCell('5 x 1k "cruise" intervals')).toBe('"5 x 1k ""cruise"" intervals"');
    expect(escapeCsvCell('Line 1\nLine 2')).toBe('"Line 1\nLine 2"');
    expect(escapeCsvCell('=HYPERLINK("http://evil.example","click")')).toBe(
      '"\'=HYPERLINK(""http://evil.example"",""click"")"',
    );
  });

  it('puts a guard quote after a `;` or line break that a formula trigger follows, and leaves other text alone', () => {
    expect(sanitizeCsvFormula('Run;=1+2')).toBe("Run;'=1+2");
    expect(sanitizeCsvFormula("Run;=cmd|' /C calc'!A0;")).toBe("Run;'=cmd|' /C calc'!A0;");
    expect(sanitizeCsvFormula('a;=1;=2')).toBe("a;'=1;'=2");
    // …also behind spaces, invisible format characters or double quotes, and for the full-width forms
    expect(sanitizeCsvFormula('Run; -5 sec')).toBe("Run;' -5 sec");
    expect(sanitizeCsvFormula('Run;"=1+2')).toBe('Run;\'"=1+2');
    expect(sanitizeCsvFormula('Run;\u200B\u202E@SUM(A1)')).toBe("Run;'\u200B\u202E@SUM(A1)");
    expect(sanitizeCsvFormula('Run;\uFF1D1+1')).toBe("Run;'\uFF1D1+1");
    // …and after every kind of line break
    expect(sanitizeCsvFormula('Felt good\n=1+2')).toBe("Felt good\n'=1+2");
    expect(sanitizeCsvFormula('Felt good\r\n+1')).toBe("Felt good\r\n'+1");
    expect(sanitizeCsvFormula('Felt good\r@me')).toBe("Felt good\r'@me");
    expect(sanitizeCsvFormula('Felt good\n\n-10 °C')).toBe("Felt good\n\n'-10 °C");

    // Ordinary text with `;`, line breaks or a later trigger is unchanged
    for (const plain of [
      'Tempo; easy',
      'Long run; 2 x 20 min @ MP',
      'Line 1\r\nLine 2',
      'a;b;c',
      'Easy - 10 km; 5:30/km',
    ]) {
      expect(sanitizeCsvFormula(plain)).toBe(plain);
    }
    expect(escapeCsvCell('Tempo\t=1+2')).toBe('"Tempo\t=1+2"');
  });

  it('keeps every cell of a row from starting with a formula trigger when `;`-locale Excel splits it at `;` and line breaks', () => {
    const names = [
      'Run;=1+2;',
      "Run;=cmd|' /C calc'!A0;",
      'Run;"=1+2;',
      'Run; @SUM(A1);',
      'Run;\u200B+1;',
      'Run;\uFF1D1+1;',
    ];
    const notes = 'Felt good\n=1+2;\r\n@SUM(A1);\r+1;\n\n- legs fine';
    const rows = names.map((name, i) => [100 + i, '2026-10-20', name, notes, -3.5, true]);
    const headers = ['id', 'date', 'name', 'notes', 'elevation_difference_m', 'trainer'];

    const csv = rowsToCsv(headers, rows);
    const cells = semicolonLocaleCells(csv);
    expect(cells.length).toBeGreaterThan(rows.length * 4);
    expect(cells.filter(looksLikeFormula)).toEqual([]);

    // Quoting alone (without the guard) lets every payload above become a formula cell
    const quotedOnly = [headers, ...rows]
      .map((r) => r.map((c) => (typeof c === 'string' ? `"${c.replace(/"/g, '""')}"` : String(c))).join(','))
      .join('\r\n');
    expect(semicolonLocaleCells(quotedOnly).filter(looksLikeFormula).length).toBeGreaterThanOrEqual(rows.length * 5);

    // Read normally (comma separator, quotes honoured) every value comes back whole
    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(rows.length + 1);
    parsed.slice(1).forEach((r, i) => {
      expect(r).toEqual([
        String(100 + i),
        '2026-10-20',
        sanitizeCsvFormula(names[i]),
        sanitizeCsvFormula(notes),
        '-3.5',
        'true',
      ]);
    });
  });

  it('round-trips quoted cells through an RFC 4180 reader', () => {
    const tricky = [
      'Run;=1+2',
      'say "hi", then go',
      'line1\r\nline2',
      'tab\there',
      '=SUM(A1:A2)',
      '\uFF20me',
      '\u200B-5 mph',
      '',
      'Café 🏃 42.195 km',
    ];
    const csv = rowsToCsv(
      ['text', 'n', 'flag', 'missing'],
      tricky.map((t, i) => [t, i - 2.5, i % 2 === 0, null]),
    );
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual(['text', 'n', 'flag', 'missing']);
    expect(rows).toHaveLength(tricky.length + 1);
    tricky.forEach((t, i) => {
      expect(rows[i + 1]).toEqual([sanitizeCsvFormula(t), String(i - 2.5), i % 2 === 0 ? 'true' : 'false', '']);
    });
    // Neutralized values come back with their guard quote; ordinary ones unchanged.
    expect(rows[5][0]).toBe("'=SUM(A1:A2)");
    expect(rows[1][0]).toBe("Run;'=1+2");
    expect(rows[3][0]).toBe('line1\r\nline2');
  });

  it('joins rows with CRLF per RFC 4180 and prepends UTF-8 BOM on download', async () => {
    const csv = rowsToCsv(
      ['col_a', 'col_b'],
      [
        ['alpha', 1],
        ['beta,2', -3.4],
        ['gamma', true],
      ],
    );
    expect(csv).toBe('"col_a","col_b"\r\n"alpha",1\r\n"beta,2",-3.4\r\n"gamma",true');

    downloadCsv(csv, 'test.csv');
    expect(capturedFilename).toBe('test.csv');
    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toBe('text/csv;charset=utf-8');
    const bytes = new Uint8Array(await capturedBlob!.arrayBuffer());
    // UTF-8 BOM: EF BB BF
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe('Dataset CSV builders & exporters', () => {
  const sampleRun: Activity = {
    id: 101,
    name: '=Morning Tempo, " Park "',
    type: 'Run',
    sport_type: 'Run',
    source: 'intervals',
    source_id: 'i101',
    origin: 'GARMIN_CONNECT',
    distance: 10000,
    moving_time: 2700,
    elapsed_time: 2750,
    average_speed: 3.704,
    max_speed: 4.5,
    average_heartrate: 158,
    max_heartrate: 176,
    total_elevation_gain: 85,
    average_cadence: 89.6,
    average_watts: 280,
    weighted_average_watts: 292,
    training_load: 74,
    suffer_score: 65,
    calories: 640,
    trainer: false,
    device_name: 'Forerunner 965',
    start_date: '2026-10-20T11:30:00Z',
    start_date_local: '2026-10-20T06:30:00Z',
    kudos_count: 3,
    splits_metric: [
      {
        split: 1,
        distance: 1000,
        moving_time: 270,
        elapsed_time: 270,
        average_speed: 3.704,
        average_heartrate: 152,
        elevation_difference: -4.5,
        pace_zone: 3,
      },
    ],
    splits_standard: [
      {
        split: 1,
        distance: 1609.34,
        moving_time: 435,
        elapsed_time: 438,
        average_speed: 3.7,
        average_heartrate: 154,
        elevation_difference: 6.2,
        pace_zone: 3,
      },
    ],
  };

  const sampleRide: Activity = {
    id: 102,
    name: 'Recovery Spin',
    type: 'VirtualRide',
    sport_type: 'VirtualRide',
    source: 'strava',
    distance: 20000,
    moving_time: 2400,
    elapsed_time: 2400,
    average_cadence: 90,
    trainer: true,
    hidden: true,
    hidden_reason: 'user',
    start_date: '2026-10-21T12:00:00Z',
    start_date_local: '2026-10-21T07:00:00Z',
    kudos_count: 0,
  };

  it('builds and exports Activities CSV with run_cadence_spm only on runs and neutralized names', () => {
    storeActivities([sampleRun, sampleRide]);
    const csv = buildActivitiesCsv();
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(ACTIVITIES_CSV_HEADERS.map((h) => `"${h}"`).join(','));

    // Newest first (sampleRide = 2026-10-21, sampleRun = 2026-10-20)
    const rows = parseCsv(csv);
    expect(rows[0]).toEqual([...ACTIVITIES_CSV_HEADERS]);
    const rideCols = rows[1];
    const cadenceIdx = ACTIVITIES_CSV_HEADERS.indexOf('average_cadence_raw');
    const runSpmIdx = ACTIVITIES_CSV_HEADERS.indexOf('run_cadence_spm');
    const hiddenIdx = ACTIVITIES_CSV_HEADERS.indexOf('hidden');
    expect(rideCols[cadenceIdx]).toBe('90');
    expect(rideCols[runSpmIdx]).toBe(''); // Ride does NOT double cadence into run_cadence_spm
    expect(rideCols[hiddenIdx]).toBe('true');
    expect(lines[1]).toContain('"Recovery Spin","VirtualRide"');
    expect(lines[1]).toContain(',true,'); // booleans stay bare

    // Run row neutralizes leading `=` and quotes commas/quotes, and doubles cadence (89.6 * 2 -> 179)
    expect(lines[2]).toContain('"\'=Morning Tempo, "" Park """');
    expect(lines[2]).toContain(',89.6,179,');
    expect(rows[2][ACTIVITIES_CSV_HEADERS.indexOf('name')]).toBe('\'=Morning Tempo, " Park "');

    const exported = exportActivitiesCsv();
    expect(exported.rowCount).toBe(2);
    expect(exported.filename).toMatch(/^apollo-activities-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(capturedFilename).toBe(exported.filename);
  });

  it('builds and exports Splits CSV for both metric_km and imperial_mi systems with negative elevation intact', () => {
    storeActivities([sampleRun]);
    const csv = buildSplitsCsv();
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(SPLITS_CSV_HEADERS.map((h) => `"${h}"`).join(','));
    expect(lines[1]).toContain('"metric_km"');
    expect(lines[1]).toContain(',-4.5,'); // Negative numeric elevation difference stays numeric
    expect(lines[2]).toContain('"imperial_mi"');

    const exported = exportSplitsCsv();
    expect(exported.rowCount).toBe(2);
    expect(exported.filename).toMatch(/^apollo-splits-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('builds and exports Wellness CSV sorted chronologically', () => {
    const store: Record<string, WellnessRecord> = {
      '2026-10-20': {
        date: '2026-10-20',
        restingHR: 47,
        hrv: 78.4,
        sleepSecs: 27000, // 7.5 hours
        sleepScore: 86,
        readiness: 82,
        weight: 68.5,
        vo2max: 58,
      },
      '2026-10-19': {
        date: '2026-10-19',
        restingHR: 49,
        hrv: 72.1,
        sleepSecs: 25200, // 7.0 hours
      },
    };
    persistence.setItem('apollo_wellness', JSON.stringify(store));

    expect(getAllWellnessRecords().map((r) => r.date)).toEqual(['2026-10-19', '2026-10-20']);

    const csv = buildWellnessCsv();
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(WELLNESS_CSV_HEADERS.map((h) => `"${h}"`).join(','));
    expect(lines[1].startsWith('"2026-10-19",49,72.1,,7,25200')).toBe(true);
    expect(lines[2].startsWith('"2026-10-20",47,78.4,,7.5,27000,86')).toBe(true);

    const exported = exportWellnessCsv();
    expect(exported.rowCount).toBe(2);
    expect(exported.filename).toMatch(/^apollo-wellness-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('builds and exports Training Journal CSV with clean labels even when journal toggle is disabled', () => {
    enableJournal();
    saveJournalEntry('2026-10-19', {
      rpe: 4,
      mood: 4,
      energy: 3,
      sleepQuality: 4,
      sleepHours: 7.5,
      surface: 'road',
      notes: 'Smooth aerobic miles',
    });
    saveJournalEntry('2026-10-20', {
      rpe: 8,
      mood: 5,
      energy: 5,
      sleepQuality: 5,
      sleepHours: 8,
      surface: 'track',
      weather: { tempF: 54, humidity: 62, wind: '5 mph NW', conditions: 'Clear', source: 'manual' },
      notes: '+2s negative split on final rep',
    });

    // Athlete later turns off the journal UI — historical entries must still export!
    disableJournal();
    expect(isJournalEnabled()).toBe(false);

    const csv = buildJournalCsv();
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(JOURNAL_CSV_HEADERS.map((h) => `"${h}"`).join(','));
    // Newest first (2026-10-20 then 2026-10-19), clean labels without emoji, formula prefix neutralized on notes
    expect(lines[1]).toContain(
      '"2026-10-20",8,"Very Hard+","Great","Excellent","Great",8,"track",54,62,"5 mph NW","Clear","manual"',
    );
    expect(lines[1]).toContain('"\'+2s negative split on final rep"');
    expect(lines[2]).toContain('"2026-10-19",4,"Somewhat Hard","Good","Moderate","Good",7.5,"road"');

    const exported = exportJournalCsv();
    expect(exported.rowCount).toBe(2);
    expect(exported.filename).toMatch(/^apollo-journal-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('returns rowCount 0 without triggering an empty file download when a dataset is empty', () => {
    const res = exportWellnessCsv();
    expect(res.rowCount).toBe(0);
    expect(capturedBlob).toBeNull();
  });
});
