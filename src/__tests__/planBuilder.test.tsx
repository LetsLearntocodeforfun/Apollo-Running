import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PlanBuilder from '../components/PlanBuilder';
import { persistence } from '../services/db/persistence';
import { setDistanceUnit } from '../services/unitPreferences';
import { calculateTrainingPaces, saveTrainingPaces } from '../services/paceCalculator';
import type { TrainingPlan } from '../data/plans';

type BuilderProps = Parameters<typeof PlanBuilder>[0];

/** Renders PlanBuilder the way Training.tsx / WelcomeFlow.tsx do (onComplete + onCancel). */
function renderBuilder(extra: Partial<BuilderProps> = {}) {
  const onComplete = vi.fn<(plan: TrainingPlan) => void>();
  const onCancel = vi.fn<() => void>();
  const utils = render(<PlanBuilder onComplete={onComplete} onCancel={onCancel} {...extra} />);
  return { ...utils, onComplete, onCancel };
}

const slider = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;
const goToAssign = () => fireEvent.click(button(/^Next: Assign Workout Days/));
const goToPreview = () => fireEvent.click(button(/^Next: Preview Plan/));

/** Every input/select must have an accessible name (aria-label or an associated <label>). */
function expectAllControlsLabelled() {
  const controls = Array.from(document.body.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'));
  expect(controls.length).toBeGreaterThan(0);
  for (const control of controls) {
    const fromLabels = Array.from(control.labels ?? []).map(l => l.textContent?.trim() ?? '').join(' ').trim();
    const name = control.getAttribute('aria-label') || fromLabels;
    expect(name, `unlabelled control: ${control.outerHTML}`).toBeTruthy();
  }
}

/** Total distance (in the label's unit) from a chart bar label such as "Week 3: 30.1 mi, Base Building". */
function barDistance(bar: HTMLElement): number {
  const match = /^Week \d+: ([\d.]+) (mi|km),/.exec(bar.getAttribute('aria-label') ?? '');
  expect(match, `unexpected bar label ${bar.getAttribute('aria-label')}`).not.toBeNull();
  return Number(match![1]);
}

describe('PlanBuilder', () => {
  beforeEach(() => {
    persistence.clear();
  });

  it('V21: raising current distance past peak−4 clamps the STORED peak; Next stays enabled and the plan uses it', () => {
    const { onComplete } = renderBuilder();
    const current = slider('Current Weekly Distance');
    const peak = slider('Peak Weekly Distance');
    expect(current.value).toBe('24');
    expect(peak.value).toBe('40');

    fireEvent.change(current, { target: { value: '40' } });
    expect(peak.value).toBe('44');
    expect(peak.min).toBe('44');
    expect(screen.getByRole('status').textContent).toMatch(/Peak raised to 44 mi/);
    // Before the fix the state kept 40, so Next was disabled with no reason.
    expect(button(/^Next: Assign Workout Days/).disabled).toBe(false);
    expect(screen.getByRole('alert').textContent).toBe('');

    // Lowering current again keeps the clamped (still valid) peak and only relaxes the bound.
    fireEvent.change(current, { target: { value: '30' } });
    expect(peak.value).toBe('44');
    expect(peak.min).toBe('34');
    expect(screen.getByRole('status').textContent).toBe('');

    fireEvent.change(current, { target: { value: '40' } });
    goToAssign();
    goToPreview();
    expect(screen.getByText(/40→44 mi\/week/)).toBeTruthy();
    const bars = screen.getAllByRole('button', { name: /^Week \d+:/ });
    for (const bar of bars) expect(barDistance(bar)).toBeLessThanOrEqual(44);

    fireEvent.click(button(/Accept This Plan/));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0].description).toContain('starting near 40 mpw and peaking around 44 mpw');
  });

  it('V21: an initialConfig peak below current+4 is clamped in state, not only on screen', () => {
    renderBuilder({ initialConfig: { currentWeeklyMiles: 40, peakWeeklyMiles: 30 } });
    expect(slider('Peak Weekly Distance').value).toBe('44');
    expect(button(/^Next: Assign Workout Days/).disabled).toBe(false);
    goToAssign();
    goToPreview();
    expect(screen.getByText(/40→44 mi\/week/)).toBeTruthy();
  });

  it('long run: exactly one radio is checked, and choosing another day unchecks the first (swap)', () => {
    const { onComplete } = renderBuilder();
    goToAssign();
    const group = screen.getByRole('group', { name: 'Long run day' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(7);
    expect(radios.filter(r => r.checked)).toHaveLength(1);

    const sunday = within(group).getByRole('radio', { name: 'Sunday' }) as HTMLInputElement;
    const saturday = within(group).getByRole('radio', { name: 'Saturday' }) as HTMLInputElement;
    expect(sunday.checked).toBe(true);
    fireEvent.click(saturday);
    expect(saturday.checked).toBe(true);
    expect(sunday.checked).toBe(false);
    expect(radios.filter(r => r.checked)).toHaveLength(1);

    // Saturday is now the long run (no select); Sunday took Saturday's previous workout (rest).
    expect(screen.queryByLabelText('Sat workout')).toBeNull();
    expect((screen.getByLabelText('Sun workout') as HTMLSelectElement).value).toBe('rest');
    expect(screen.getByText('Long run: Saturday')).toBeTruthy();
    // The per-day selects can't add a second long run.
    for (const select of screen.getAllByRole('combobox')) {
      expect(within(select).queryByRole('option', { name: 'Long Run' })).toBeNull();
    }

    goToPreview();
    fireEvent.click(button(/Accept This Plan/));
    const plan = onComplete.mock.calls[0][0];
    plan.weeks.slice(0, -1).forEach(week => {
      expect(week.days.filter(d => d.note === 'Long').length).toBe(1);
      expect(week.days[5].note).toBe('Long');
    });
    // V11 (T2a): the race is always the plan's last day; the Saturday long-run slot becomes a race-week shakeout.
    const raceWeek = plan.weeks[plan.weeks.length - 1];
    expect(raceWeek.days[6].type).toBe('marathon');
    expect(raceWeek.days[5].label).toMatch(/shakeout/i);
  });

  it('labels every input and select on each step', () => {
    renderBuilder();
    expectAllControlsLabelled();
    for (const label of ['Plan Name', 'Plan Length', 'Running Days per Week', 'Current Weekly Distance', 'Peak Weekly Distance']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }

    goToAssign();
    expectAllControlsLabelled();
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      expect(screen.getByLabelText(`${day} workout`).tagName).toBe('SELECT');
    }
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) {
      expect(screen.getByLabelText(day).getAttribute('type')).toBe('radio');
    }
  });

  it('shows the validation reason inline (role=alert) instead of silently disabling Next', () => {
    renderBuilder();
    goToAssign();
    for (const day of ['Tue', 'Wed', 'Fri']) {
      fireEvent.change(screen.getByLabelText(`${day} workout`), { target: { value: 'rest' } });
    }
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/at least 3 running days \(you have 1\)/i);
    const next = button(/^Next: Preview Plan/);
    expect(next.disabled).toBe(true);
    expect(next.getAttribute('aria-describedby')).toBe(alert.id);

    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
      fireEvent.change(screen.getByLabelText(`${day} workout`), { target: { value: 'easy' } });
    }
    expect(screen.getByRole('alert').textContent).toMatch(/at most 6 running days \(you have 7\)/i);

    fireEvent.change(screen.getByLabelText('Mon workout'), { target: { value: 'cross' } });
    expect(screen.getByRole('alert').textContent).toBe('');
    expect(button(/^Next: Preview Plan/).disabled).toBe(false);
    expect(button(/^Next: Preview Plan/).getAttribute('aria-describedby')).toBeNull();
  });

  it('preview: phase-coloured bars are labelled buttons with a text legend; accordions expose aria-expanded/controls', () => {
    renderBuilder();
    goToAssign();
    goToPreview();

    const bars = screen.getAllByRole('button', { name: /^Week \d+:/ });
    expect(bars).toHaveLength(18);
    bars.forEach(bar => expect(bar.tagName).toBe('BUTTON'));
    expect(bars[0].getAttribute('aria-label')).toMatch(/^Week 1: \d+\.\d mi, Base Building$/);
    expect(bars[0].className).toContain('pb-phase--base');
    expect(bars[16].getAttribute('aria-label')).toMatch(/Taper/);
    expect(bars[17].getAttribute('aria-label')).toMatch(/^Week 18: .*Race Week$/);
    expect(bars[17].className).toContain('pb-phase--race');

    const legend = screen.getByRole('list', { name: 'Training phases' });
    for (const text of ['Base Building', 'Taper', 'Race Week', 'week 18', 'cutback week']) {
      expect(legend.textContent).toContain(text);
    }

    const header = button(/^Week 3 /);
    const bodyId = header.getAttribute('aria-controls')!;
    const body = document.getElementById(bodyId)!;
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(bars[2].getAttribute('aria-controls')).toBe(bodyId);

    fireEvent.click(bars[2]);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(bars[2].getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(within(body).getAllByRole('row')).toHaveLength(8);

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
  });

  it('B7: uses design-system tokens only (no var(--success|warning|error), no #8b5cf6)', () => {
    for (const file of ['../components/PlanBuilder.tsx', '../components/plan/PlanBuilder.css']) {
      const src = readFileSync(resolve(__dirname, file), 'utf8');
      expect(src, file).not.toMatch(/var\(--(success|warning|error)\)/);
      expect(src.toLowerCase(), file).not.toContain('#8b5cf6');
    }
  });

  it('km users see km (not mi) on every step; sliders convert back to miles for the engine', () => {
    setDistanceUnit('km');
    saveTrainingPaces(calculateTrainingPaces(50)!);
    const { onComplete } = renderBuilder();
    const noMiles = () => expect(document.body.textContent).not.toMatch(/\bmi\b|\/mi\b|\bmpw\b/);

    expect(screen.getByText('39 km')).toBeTruthy(); // 24 mi
    expect(screen.getByText('64 km')).toBeTruthy(); // 40 mi
    noMiles();

    fireEvent.change(slider('Current Weekly Distance'), { target: { value: '64' } }); // ≈ 39.8 mi
    const peak = slider('Peak Weekly Distance');
    expect(peak.value).toBe('71'); // ≥ 39.8 + 4 mi = 70.4 km, rounded up to a whole km
    expect(peak.getAttribute('aria-valuetext')).toBe('71 km');
    expect(screen.getByRole('status').textContent).toMatch(/Peak raised to 71 km/);
    noMiles();

    goToAssign();
    expect(document.body.textContent).toMatch(/\/km/); // pace card
    noMiles();

    goToPreview();
    expect(screen.getByText(/64→71 km\/week/)).toBeTruthy();
    const bars = screen.getAllByRole('button', { name: /^Week \d+:/ });
    bars.forEach(bar => expect(bar.getAttribute('aria-label')).toMatch(/ km, /));
    fireEvent.click(bars[5]);
    expect(document.body.textContent).toMatch(/\d+\.\d km/);
    noMiles();

    fireEvent.click(button(/Accept This Plan/));
    const plan = onComplete.mock.calls[0][0];
    const weeklyMiles = plan.weeks.slice(0, -1).map(w => w.days.reduce((sum, d) => sum + (d.distanceMi ?? 0), 0));
    expect(Math.max(...weeklyMiles)).toBeLessThanOrEqual(71 / 1.60934 + 0.2);
    // V10 (T2a): 3-week taper at ~80/60/40 % of peak — the 60 % week before race week is below the floor by design.
    expect(Math.min(...weeklyMiles.slice(0, -1))).toBeGreaterThan(30);
  });

  it('keeps the onCancel / onComplete contract', () => {
    const { onCancel, onComplete } = renderBuilder({ initialConfig: { name: 'Spring Build', totalWeeks: 12, runningDays: 5 } });
    fireEvent.click(button(/^Cancel$/));
    expect(onCancel).toHaveBeenCalledTimes(1);

    expect(slider('Plan Length').value).toBe('12');
    goToAssign();
    goToPreview();
    expect(screen.getAllByRole('button', { name: /^Week \d+:/ })).toHaveLength(12);
    fireEvent.click(button(/Accept This Plan/));
    const plan = onComplete.mock.calls[0][0];
    expect(plan.name).toBe('Spring Build');
    expect(plan.totalWeeks).toBe(12);
    expect(plan.weeks[0].days.filter(d => d.type === 'run')).toHaveLength(5);
  });
});
