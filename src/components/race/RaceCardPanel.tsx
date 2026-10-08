/**
 * Printable race card for the active strategy (v1.0.6).
 *
 * The card is generated purely from the strategy plus the form values
 * (emergency contact, per-distance mantras); those are persisted only on an
 * explicit Save. The preview is a fully sandboxed iframe; Print uses the
 * service's hidden-iframe helper (window.open is blocked in the desktop app)
 * and Download saves a standalone .html file.
 */
import { useId, useMemo, useState, type FormEvent } from 'react';
import type { RaceDayContext, RacePanelProps } from './types';
import { EmptyState } from '../ui';
import {
  downloadRaceCard,
  generateRaceCard,
  getRaceCardPrefs,
  printRaceCard,
  setRaceCardPrefs,
} from '../../services/raceCard';
import { KM_PER_MI, getMarathon, getStrategyDistanceMi } from '../../services/raceStrategy';
import { getDistanceUnit } from '../../services/unitPreferences';
import { normalizeMarathonId } from '../../data/worldMajors';

type Unit = 'mi' | 'km';

interface MantraPoint {
  /** Distance in miles (the race card keys mantras by miles). */
  key: number;
  /** Label in the athlete's unit, e.g. "mile 13" or "km 21". */
  label: string;
}

/**
 * Mantra prompts at about 25 / 50 / 75 / 90 % of the race, in whole units of
 * the athlete's distance unit.
 */
function mantraPoints(distanceMi: number, unit: Unit): MantraPoint[] {
  const total = unit === 'km' ? distanceMi * KM_PER_MI : distanceMi;
  if (!(total > 1)) return [];
  const seen = new Set<number>();
  const out: MantraPoint[] = [];
  for (const f of [0.25, 0.5, 0.75, 0.9]) {
    const n = Math.max(1, Math.round(total * f));
    if (n >= total || seen.has(n)) continue;
    seen.add(n);
    // Floor km keys to 3 dp so they fall in the row that ends at n km.
    const key = unit === 'km' ? Math.floor((n / KM_PER_MI) * 1000) / 1000 : n;
    out.push({ key, label: unit === 'km' ? `km ${n}` : `mile ${n}` });
  }
  return out;
}

function cleanMantras(m: Record<number, string>): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [k, v] of Object.entries(m)) {
    const text = v.trim();
    if (text) out[Number(k)] = text;
  }
  return out;
}

function startInfoFor(ctx: Pick<RaceDayContext, 'wave' | 'startTime'>): string {
  const parts: string[] = [];
  if (ctx.wave) parts.push(/^\d+$/.test(ctx.wave.trim()) ? `Wave ${ctx.wave.trim()}` : ctx.wave);
  if (ctx.startTime) parts.push(`Start ${ctx.startTime} (race-local time)`);
  return parts.join(' · ');
}

export default function RaceCardPanel({ ctx }: RacePanelProps) {
  const { strategy, race } = ctx;
  const baseId = useId();
  const titleId = `${baseId}-title`;

  const [unit] = useState<Unit>(() => (getDistanceUnit() === 'km' ? 'km' : 'mi'));
  const [initial] = useState(() => getRaceCardPrefs());
  const [contactName, setContactName] = useState(initial.emergencyContact?.name ?? '');
  const [contactPhone, setContactPhone] = useState(initial.emergencyContact?.phone ?? '');
  const [mantras, setMantras] = useState<Record<number, string>>(() => ({ ...(initial.defaultMantras ?? {}) }));
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('');

  const marathon = useMemo(() => {
    if (!strategy) return undefined;
    if (race && normalizeMarathonId(race.id) === normalizeMarathonId(strategy.marathonId)) return race;
    return getMarathon(strategy.marathonId);
  }, [strategy, race]);

  const startInfo = startInfoFor(ctx);
  const card = useMemo(() => {
    if (!strategy) return null;
    const name = contactName.trim();
    const phone = contactPhone.trim();
    return generateRaceCard({
      strategy,
      marathon,
      unit,
      emergencyContact: name || phone ? { name, phone } : undefined,
      mantras: cleanMantras(mantras),
      raceDate: ctx.raceDate ?? undefined,
      startInfo: startInfo || undefined,
    });
  }, [strategy, marathon, unit, contactName, contactPhone, mantras, ctx.raceDate, startInfo]);

  const points = useMemo(
    () => (strategy ? mantraPoints(getStrategyDistanceMi(strategy), unit) : []),
    [strategy, unit],
  );

  if (!strategy || !card) {
    return (
      <section className="race-week-section" aria-labelledby={titleId}>
        <h2 id={titleId} className="race-week-title">Race card</h2>
        <EmptyState icon={<span aria-hidden="true">🗒️</span>} title="Save a race strategy on the Strategy tab first">
          The race card turns your saved pacing plan into a printable sheet with splits, fuel and mantras.
        </EmptyState>
      </section>
    );
  }

  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setDirty(true);
    setStatus('');
  };
  const onName = edit(setContactName);
  const onPhone = edit(setContactPhone);
  const onMantra = edit((v: { key: number; text: string }) => setMantras((m) => ({ ...m, [v.key]: v.text })));

  const handleSave = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setRaceCardPrefs({
      emergencyContact: { name: contactName.trim(), phone: contactPhone.trim() },
      defaultMantras: cleanMantras(mantras),
    });
    setDirty(false);
    setStatus('Race card details saved.');
  };

  const handlePrint = () => {
    setStatus(printRaceCard(card)
      ? 'Opening the print dialog…'
      : 'Printing is not available here — use Download HTML instead.');
  };

  const handleDownload = () => {
    downloadRaceCard(card);
    setStatus('Race card downloaded.');
  };

  const paceSuffix = unit === 'km' ? '/km' : '/mi';

  return (
    <section className="race-week-section" aria-labelledby={titleId}>
      <div className="race-week-header">
        <h2 id={titleId} className="race-week-title">Race card</h2>
        <p className="race-week-muted">
          {card.marathonName} · goal {card.targetFinish} · {card.avgPace}{paceSuffix}
        </p>
      </div>

      <form className="race-card-form" onSubmit={handleSave}>
        <fieldset className="race-card-fieldset">
          <legend className="race-card-legend">Emergency contact</legend>
          <div className="race-card-field">
            <label htmlFor={`${baseId}-ec-name`}>Contact name</label>
            <input
              id={`${baseId}-ec-name`}
              type="text"
              className="race-week-input"
              autoComplete="off"
              maxLength={80}
              value={contactName}
              onChange={(e) => onName(e.target.value)}
            />
          </div>
          <div className="race-card-field">
            <label htmlFor={`${baseId}-ec-phone`}>Contact phone</label>
            <input
              id={`${baseId}-ec-phone`}
              type="tel"
              className="race-week-input"
              autoComplete="off"
              maxLength={40}
              value={contactPhone}
              onChange={(e) => onPhone(e.target.value)}
            />
          </div>
        </fieldset>

        {points.length > 0 && (
          <fieldset className="race-card-fieldset">
            <legend className="race-card-legend">Mantras</legend>
            {points.map((p) => {
              const id = `${baseId}-mantra-${p.key}`;
              return (
                <div className="race-card-field" key={p.key}>
                  <label htmlFor={id}>Mantra at {p.label}</label>
                  <input
                    id={id}
                    type="text"
                    className="race-week-input"
                    maxLength={80}
                    placeholder="e.g. Relax and roll"
                    value={mantras[p.key] ?? ''}
                    onChange={(e) => onMantra({ key: p.key, text: e.target.value })}
                  />
                </div>
              );
            })}
          </fieldset>
        )}

        <div className="race-week-actions">
          <button type="submit" className="btn btn-primary race-week-btn" disabled={!dirty}>
            Save details
          </button>
          {dirty && <span className="race-week-muted">Unsaved changes (the preview already shows them)</span>}
        </div>
      </form>

      <div className="race-week-actions">
        <button type="button" className="btn btn-secondary race-week-btn" onClick={handlePrint}>
          <span aria-hidden="true">🖨️</span> Print
        </button>
        <button type="button" className="btn btn-outline race-week-btn" onClick={handleDownload}>
          <span aria-hidden="true">⬇️</span> Download HTML
        </button>
      </div>
      <p className="race-week-status" role="status">{status}</p>

      <iframe
        className="race-card-preview"
        sandbox=""
        srcDoc={card.htmlContent}
        title="Race card preview"
      />
    </section>
  );
}
