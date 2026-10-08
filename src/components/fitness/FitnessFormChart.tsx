import { useEffect, useId, useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceArea, ReferenceLine,
} from 'recharts';
import { onActivitiesUpdated } from '../../services/activitySource';
import { onPlanOverlayChanged } from '../../services/planOverlay';
import {
  getZoneColor,
  getZoneLabel,
  RACE_WINDOW_TSB,
  TSB_ZONE_NOTE,
  type TSBZone,
} from '../../services/pmcChart';
import { parseDateKey, addDays, isDateKey } from '../../utils/localDate';
import { formatTsb, getFitnessForm, type FitnessFormData } from './fitnessData';
import './FitnessFormChart.css';

export interface FitnessFormChartProps {
  /** Race date (YYYY-MM-DD). `undefined` = derive from the active plan; `null` = no race. */
  raceDate?: string | null;
}

type RangeKey = '90' | '180' | '365';
const RANGE_LABEL: Record<RangeKey, string> = { '90': '3 mo', '180': '6 mo', '365': '1 yr' };

interface ChartRow {
  date: string;
  ctl?: number;
  atl?: number;
  tsb?: number;
  zone?: TSBZone;
  /** Projection (dashed) series. */
  pCtl?: number;
  pTsb?: number;
}

const ZONES: TSBZone[] = ['overreaching', 'productive', 'fresh', 'peak', 'transition', 'detrained'];
const ZONE_RANGE: Record<TSBZone, string> = {
  overreaching: 'below −20',
  productive: '−20 to 0',
  fresh: '0 to +15',
  peak: '+15 to +25',
  transition: '+25 to +30',
  detrained: 'above +30',
};

function shortDate(key: string): string {
  if (!isDateKey(key)) return key;
  return parseDateKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One-line takeaway for the figure caption. */
export function fitnessTakeaway(data: FitnessFormData): string {
  const c = data.pmc.current;
  if (!c) return 'No training load yet — sync or import runs to see fitness and form.';
  const parts = [`Form ${formatTsb(c.tsb)} (${getZoneLabel(c.zone)}) today, fitness ${Math.round(c.ctl)}.`];
  if (data.raceDate && data.daysToRace !== null && data.daysToRace > 0) {
    if (data.raceDayTsb !== null) {
      const [lo, hi] = RACE_WINDOW_TSB;
      const verdict = data.raceDayTsb >= lo && data.raceDayTsb <= hi
        ? 'inside the race window'
        : data.raceDayTsb < lo ? 'below the race window' : 'above the race window';
      const basis = data.pmc.projectionSource === 'plan' ? 'following your plan' : 'at your recent load';
      parts.push(`Race day projects to ${formatTsb(data.raceDayTsb)}, ${verdict} (+${lo} to +${hi}) ${basis}.`);
    } else {
      parts.push(`Race in ${data.daysToRace} days.`);
    }
  }
  if (data.warmingUp) parts.push('Estimate: fitness needs about 6 weeks of history.');
  return parts.join(' ');
}

interface TooltipEntry { dataKey?: string | number; value?: number | string; payload?: ChartRow }
interface FormTooltipProps { active?: boolean; label?: string | number; payload?: TooltipEntry[] }

function FormTooltip({ active, label, payload }: FormTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const projected = row.ctl === undefined;
  const tsb = projected ? row.pTsb : row.tsb;
  return (
    <div className="ff-tooltip">
      <div className="ff-tooltip-date">{shortDate(String(label ?? row.date))}{projected ? ' · projected' : ''}</div>
      {!projected && row.ctl !== undefined && <div>Fitness (CTL): {Math.round(row.ctl)}</div>}
      {!projected && row.atl !== undefined && <div>Fatigue (ATL): {Math.round(row.atl)}</div>}
      {projected && row.pCtl !== undefined && <div>Fitness (CTL): {Math.round(row.pCtl)}</div>}
      {tsb !== undefined && <div>Form (TSB): {formatTsb(tsb)}{row.zone ? ` · ${getZoneLabel(row.zone)}` : ''}</div>}
    </div>
  );
}

/**
 * Fitness & Form (PMC) chart: CTL area, ATL line, TSB bars coloured by zone,
 * the +15…+25 race window, a race-day marker and a dashed projection to race
 * day from planned load. Wrapped in a <figure> with a one-line takeaway and a
 * "View as table" alternative.
 */
export default function FitnessFormChart({ raceDate }: FitnessFormChartProps) {
  const [tick, setTick] = useState(0);
  const [range, setRange] = useState<RangeKey>('180');
  const [includeCross, setIncludeCross] = useState(true);
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();
  const crossId = useId();

  useEffect(() => onActivitiesUpdated(() => setTick((t) => t + 1)), []);
  useEffect(() => onPlanOverlayChanged(() => setTick((t) => t + 1)), []);

  const data = useMemo(() => {
    void tick;
    return getFitnessForm({ raceDate, includeCrossTraining: includeCross });
  }, [tick, raceDate, includeCross]);

  const rows = useMemo<ChartRow[]>(() => {
    const from = addDays(data.today, -Number(range));
    const hist: ChartRow[] = data.pmc.dataPoints
      .filter((p) => p.date > from)
      .map((p) => ({ date: p.date, ctl: p.ctl, atl: p.atl, tsb: p.tsb, zone: p.zone }));
    if (hist.length > 0 && data.pmc.projection.length > 0) {
      const last = hist[hist.length - 1];
      last.pCtl = last.ctl;
      last.pTsb = last.tsb;
    }
    const proj: ChartRow[] = data.pmc.projection.map((p) => ({ date: p.date, pCtl: p.ctl, pTsb: p.tsb, zone: p.zone }));
    return [...hist, ...proj];
  }, [data, range]);

  /** Weekly samples (plus today and race day) for the table view. */
  const tableRows = useMemo(() => {
    const out = rows.filter((r, i) => i % 7 === 0 || r.date === data.today || r.date === data.raceDate);
    const last = rows[rows.length - 1];
    if (last && out[out.length - 1] !== last) out.push(last);
    return out;
  }, [rows, data.today, data.raceDate]);

  const takeaway = fitnessTakeaway(data);
  const raceInView = data.raceDate && rows.some((r) => r.date === data.raceDate) ? data.raceDate : null;
  const [lo, hi] = RACE_WINDOW_TSB;

  if (!data.pmc.current) {
    return (
      <figure className="ff-figure">
        <figcaption className="ff-empty">{takeaway}</figcaption>
      </figure>
    );
  }

  return (
    <figure className="ff-figure" aria-labelledby={`${tableId}-cap`}>
      <div className="ff-toolbar">
        <div className="ff-ranges" role="group" aria-label="Chart range">
          {(Object.keys(RANGE_LABEL) as RangeKey[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`ff-range-btn${range === k ? ' is-active' : ''}`}
              aria-pressed={range === k}
              onClick={() => setRange(k)}
            >
              {RANGE_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="ff-toggle" htmlFor={crossId}>
          <input id={crossId} type="checkbox" checked={includeCross} onChange={(e) => setIncludeCross(e.target.checked)} />
          Include cross-training
        </label>
        <button
          type="button"
          className="ff-table-btn"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((s) => !s)}
        >
          {showTable ? 'Hide table' : 'View as table'}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="ff-empty">No training in this range. Pick a longer range.</p>
      ) : (
        <div className="ff-chart" role="img" aria-label={`Fitness and form chart. ${takeaway}`}>
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={32} tick={{ fontSize: 11, fill: '#9a9a9a' }} />
              <YAxis tick={{ fontSize: 11, fill: '#9a9a9a' }} />
              <Tooltip content={<FormTooltip />} />
              <ReferenceArea y1={lo} y2={hi} fill="#FFD700" fillOpacity={0.1} ifOverflow="extendDomain"
                label={{ value: `Race window +${lo}…+${hi}`, position: 'insideTopLeft', fill: '#c9b458', fontSize: 11 }} />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
              <ReferenceLine x={data.today} stroke="rgba(255,255,255,0.35)" strokeDasharray="2 4"
                label={{ value: 'Today', position: 'insideTopRight', fill: '#9a9a9a', fontSize: 11 }} />
              {raceInView && (
                <ReferenceLine x={raceInView} stroke="#FFD700" strokeWidth={2}
                  label={{ value: 'Race day', position: 'insideTopRight', fill: '#FFD700', fontSize: 11 }} />
              )}
              <Bar dataKey="tsb" name="Form (TSB)" barSize={3} isAnimationActive={false}>
                {rows.map((r) => (
                  <Cell key={r.date} fill={r.zone ? getZoneColor(r.zone) : '#78909C'} />
                ))}
              </Bar>
              <Area type="monotone" dataKey="ctl" name="Fitness (CTL)" stroke="#2EC4B6" fill="#2EC4B6" fillOpacity={0.15} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="atl" name="Fatigue (ATL)" stroke="#E8C05A" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="pCtl" name="Projected fitness" stroke="#2EC4B6" strokeDasharray="6 4" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              <Line type="monotone" dataKey="pTsb" name="Projected form" stroke="#FFD700" strokeDasharray="6 4" strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <ul className="ff-legend" aria-label="Legend">
        <li><span className="ff-swatch ff-swatch--ctl" aria-hidden="true" />Fitness (CTL, 42-day)</li>
        <li><span className="ff-swatch ff-swatch--atl" aria-hidden="true" />Fatigue (ATL, 7-day)</li>
        <li><span className="ff-swatch ff-swatch--proj" aria-hidden="true" />Projection{data.pmc.projectionSource === 'plan' ? ' (planned load)' : data.pmc.projectionSource === 'recent-average' ? ' (recent average load)' : ''}</li>
      </ul>
      <ul className="ff-zones" aria-label="Form (TSB) zones">
        {ZONES.map((z) => (
          <li key={z}>
            <span className="ff-swatch" style={{ background: getZoneColor(z) }} aria-hidden="true" />
            {getZoneLabel(z)} <span className="ff-zone-range">{ZONE_RANGE[z]}</span>
          </li>
        ))}
      </ul>
      <p className="ff-note">{TSB_ZONE_NOTE}</p>

      {showTable && (
        <div className="ff-table-wrap" id={tableId}>
          <table className="ff-table">
            <caption className="sr-only">Fitness, fatigue and form by date</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Fitness (CTL)</th>
                <th scope="col">Fatigue (ATL)</th>
                <th scope="col">Form (TSB)</th>
                <th scope="col">Zone</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => {
                const projected = r.ctl === undefined;
                const tsb = projected ? r.pTsb : r.tsb;
                return (
                  <tr key={r.date} className={projected ? 'is-projected' : undefined}>
                    <th scope="row">{shortDate(r.date)}{projected ? ' (projected)' : ''}{r.date === data.raceDate ? ' · race day' : ''}</th>
                    <td>{Math.round((projected ? r.pCtl : r.ctl) ?? 0)}</td>
                    <td>{projected ? '—' : Math.round(r.atl ?? 0)}</td>
                    <td>{tsb !== undefined ? formatTsb(tsb) : '—'}</td>
                    <td>{r.zone ? getZoneLabel(r.zone) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <figcaption id={`${tableId}-cap`} className="ff-caption">{takeaway}</figcaption>
    </figure>
  );
}
