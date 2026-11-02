/**
 * MarathonImport GPX flow (v1.0.9):
 * - the saved race uses the course fitted to the distance being saved (±3% rule);
 * - a marathon (26.2 mi, 42.2 km or 42.195 km) is fitted and saved at the official
 *   42.195 km, any other distance exactly as typed, and the last split reads 0.2 mi;
 * - the preview follows the distance field and says honestly when it rescaled;
 * - the file input resets after every pick, so the same file can be chosen again;
 * - any error clears the previous parse result;
 * - reading a file shows an accessible busy state (aria-busy + status text).
 */

import { createElement } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MarathonImport from '@/components/MarathonImport';
import { MARATHON_MI, getMarathon, importCustomMarathon, type CustomMarathonInput } from '@/services/raceStrategy';
import { setDistanceUnit } from '@/services/unitPreferences';
import type { MarathonRace } from '@/types/raceStrategy';

const METERS_PER_MILE = 1609.344;
const METERS_PER_DEG_LAT = (Math.PI / 180) * 6_371_000;

/** A straight, gently rolling course of `miles` with `points` track points. */
function courseGpx(miles: number, points = 1_500): string {
  const totalM = miles * METERS_PER_MILE;
  const pts: string[] = [];
  for (let i = 0; i < points; i++) {
    const d = (i / (points - 1)) * totalM;
    const lat = (41.8781 + d / METERS_PER_DEG_LAT).toFixed(7);
    pts.push(`<trkpt lat="${lat}" lon="-87.6298"><ele>${(60 + 15 * Math.sin(d / 2_500)).toFixed(1)}</ele></trkpt>`);
  }
  return `<gpx version="1.1"><trk><name>Long Course Marathon</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}

function renderImport() {
  const saved: MarathonRace[] = [];
  const onImport = vi.fn((input: CustomMarathonInput) => {
    const race = importCustomMarathon(input);
    saved.push(race);
    return race;
  });
  const utils = render(createElement(MarathonImport, { onImport, onCancel: () => {} }));
  const fileInput = utils.container.querySelector('input[type="file"]') as HTMLInputElement;
  return { ...utils, saved, onImport, fileInput };
}

function pickFile(input: HTMLInputElement, text: string, name = 'course.gpx'): File {
  const file = new File([text], name, { type: 'application/gpx+xml' });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

async function waitForPreview(expectedDistance: string) {
  await waitFor(() => expect(screen.getByTestId('gpx-stat-distance').textContent).toBe(expectedDistance));
}

function distanceInput(): HTMLInputElement {
  return screen.getByLabelText(/^Distance \((mi|km)\)$/) as HTMLInputElement;
}

beforeEach(() => {
  setDistanceUnit('mi');
});

describe('MarathonImport — GPX course fitted to the race distance', () => {
  it('saves the race with splits, aid stations and profile ending at the official marathon distance for a 26.5 mi GPX', async () => {
    const { fileInput, saved } = renderImport();
    pickFile(fileInput, courseGpx(26.5));
    await waitForPreview('26.22 mi');

    // The distance field keeps the form's marathon default as entered; the course finishes at 42.195 km.
    expect(distanceInput().value).toBe('26.2');
    expect(screen.getByTestId('gpx-notes').textContent).toContain('This GPX measures 26.50 mi');
    expect(screen.getByTestId('gpx-notes').textContent).toContain('finish at 26.22 mi');

    // Mile splits read 1.0 … and the final split still reads as the last 0.2 mi
    fireEvent.click(screen.getByRole('button', { name: 'Preview 27 course splits' }));
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(28);
    expect(rows[1].querySelector('td')?.textContent).toBe('1.0');
    expect(rows[27].querySelector('th')?.textContent).toBe('27');
    expect(rows[27].querySelector('td')?.textContent).toBe('0.2');

    fireEvent.click(screen.getByRole('button', { name: 'Save course & create strategy' }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(saved).toHaveLength(1);
    const race = getMarathon(saved[0].id)!;
    expect(race.distanceMi).toBe(MARATHON_MI);
    expect(race.splits).toHaveLength(27);
    expect(race.splits[race.splits.length - 1].endMi).toBe(26.219);
    expect(race.course.elevationPoints[race.course.elevationPoints.length - 1].distanceMi).toBe(26.219);
    expect(race.aidStations.length).toBeGreaterThan(0);
    expect(race.aidStations.every((a) => a.distanceMi <= MARATHON_MI)).toBe(true);
  });

  it('refits the preview and the saved race to an edited distance, and stays honest outside ±3%', async () => {
    const { fileInput, saved } = renderImport();
    pickFile(fileInput, courseGpx(26.5));
    await waitForPreview('26.22 mi');

    fireEvent.change(distanceInput(), { target: { value: '24' } });
    expect(screen.getByTestId('gpx-stat-distance').textContent).toBe('26.50 mi');
    expect(screen.getByTestId('gpx-notes').textContent).toContain(
      'more than 3% away from the 24.00 mi race distance, so Apollo kept its distances as measured',
    );

    fireEvent.change(distanceInput(), { target: { value: '26.4' } });
    expect(screen.getByTestId('gpx-stat-distance').textContent).toBe('26.40 mi');

    fireEvent.click(screen.getByRole('button', { name: 'Save course & create strategy' }));
    const race = getMarathon(saved[0].id)!;
    expect(race.distanceMi).toBe(26.4);
    expect(race.splits).toHaveLength(27);
    expect(race.splits[race.splits.length - 1].endMi).toBe(26.4);
  });

  it('fits the 42.2 km form default to the official 42.195 km for athletes who use kilometres', async () => {
    setDistanceUnit('km');
    const { fileInput, saved } = renderImport();
    pickFile(fileInput, courseGpx(26.5));
    await waitForPreview('42.20 km');
    expect(distanceInput().value).toBe('42.2');
    expect(screen.getByTestId('gpx-notes').textContent).toContain('This GPX measures 42.65 km');
    expect(screen.getByTestId('gpx-notes').textContent).toContain('finish at 42.20 km');

    fireEvent.click(screen.getByRole('button', { name: 'Save course & create strategy' }));
    expect(screen.queryByRole('alert')).toBeNull();
    const race = getMarathon(saved[0].id)!;
    expect(race.distanceMi).toBe(MARATHON_MI);
    expect(race.splits[race.splits.length - 1].endMi).toBe(26.219);
  });

  it('keeps a typed 42.195 km and an exact 42.195 km GPX unscaled, with no rescale note', async () => {
    setDistanceUnit('km');
    const { fileInput, saved } = renderImport();
    fireEvent.change(distanceInput(), { target: { value: '42.195' } });
    pickFile(fileInput, courseGpx(42.195 / 1.609344));
    await waitForPreview('42.20 km');
    expect(distanceInput().value).toBe('42.195');
    expect(screen.queryByTestId('gpx-notes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save course & create strategy' }));
    expect(getMarathon(saved[0].id)!.distanceMi).toBe(MARATHON_MI);
  });

  it('keeps any other distance exactly as typed', async () => {
    const { fileInput, saved } = renderImport();
    fireEvent.change(distanceInput(), { target: { value: '13.1' } });
    pickFile(fileInput, courseGpx(13.3));
    await waitForPreview('13.10 mi');
    expect(distanceInput().value).toBe('13.1');

    fireEvent.click(screen.getByRole('button', { name: 'Save course & create strategy' }));
    const race = getMarathon(saved[0].id)!;
    expect(race.distanceMi).toBe(13.1);
    expect(race.splits[race.splits.length - 1].endMi).toBe(13.1);
  });
});

describe('MarathonImport — GPX picking UX', () => {
  it('shows a busy state while reading, then announces the loaded file', async () => {
    const { fileInput } = renderImport();
    pickFile(fileInput, courseGpx(26.2), 'race.gpx');

    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Reading the course file…');
    expect(status.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('true');
    expect(fileInput.disabled).toBe(true);

    await waitForPreview('26.22 mi');
    expect(status.textContent).toMatch(/^Loaded race\.gpx \(1,500 track points\)$/);
    expect(status.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
    expect(fileInput.disabled).toBe(false);
  });

  it('resets the file input after each pick so choosing the same file again re-reads it', async () => {
    const { fileInput } = renderImport();
    const setValue = vi.fn();
    Object.defineProperty(fileInput, 'value', { configurable: true, get: () => '', set: setValue });

    const file = pickFile(fileInput, courseGpx(26.2));
    expect(setValue).toHaveBeenCalledWith('');
    await waitForPreview('26.22 mi');

    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(setValue).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toBe('Reading the course file…');
    await waitForPreview('26.22 mi');
  });

  it('clears the previous result when a later file fails to parse or is too large', async () => {
    const { fileInput, saved } = renderImport();
    pickFile(fileInput, courseGpx(26.2));
    await waitForPreview('26.22 mi');

    pickFile(fileInput, '<html><body>Not a course</body></html>', 'page.gpx');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/missing <gpx> element/));
    expect(screen.queryByTestId('gpx-stat-distance')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear GPX' })).toBeNull();

    pickFile(fileInput, courseGpx(26.2));
    await waitForPreview('26.22 mi');
    expect(screen.queryByRole('alert')).toBeNull();

    const huge = new File(['<gpx/>'], 'huge.gpx');
    Object.defineProperty(huge, 'size', { value: 16 * 1024 * 1024 });
    fireEvent.change(fileInput, { target: { files: [huge] } });
    expect(screen.getByRole('alert').textContent).toBe('Course GPX file exceeds the 15 MB size limit.');
    expect(screen.queryByTestId('gpx-stat-distance')).toBeNull();
    expect(saved).toHaveLength(0);
  });

  it('ignores an earlier read that finishes after a newer pick, and never stays busy after an error', async () => {
    const { fileInput } = renderImport();
    pickFile(fileInput, courseGpx(26.2), 'first.gpx');
    expect(screen.getByRole('status').textContent).toBe('Reading the course file…');

    const huge = new File(['<gpx/>'], 'huge.gpx');
    Object.defineProperty(huge, 'size', { value: 16 * 1024 * 1024 });
    fireEvent.change(fileInput, { target: { files: [huge] } });

    const status = screen.getByRole('status');
    expect(status.closest('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
    expect(screen.getByRole('alert').textContent).toBe('Course GPX file exceeds the 15 MB size limit.');

    // Give the first read time to finish: its result must not replace the newer (failed) pick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('gpx-stat-distance')).toBeNull();
    expect(status.textContent).not.toMatch(/first\.gpx/);
  });
});
