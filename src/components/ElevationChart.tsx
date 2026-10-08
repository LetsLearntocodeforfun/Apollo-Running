import { useId } from 'react';
import type { ElevationPoint } from '../types/raceStrategy';
import { getDistanceUnit, type DistanceUnit } from '../services/unitPreferences';
import { KM_PER_MI } from '../services/raceStrategy';

const FT_PER_M = 3.28084;

/** A course segment to highlight, in miles from the start. */
export interface ElevationHighlight {
  fromMi: number;
  toMi: number;
}

interface Props {
  points: ElevationPoint[];
  totalDistanceMi: number;
  /** Segment to highlight (e.g. the hovered or focused split-table row). */
  highlight?: ElevationHighlight;
  /** @deprecated Use `highlight`. Highlights the mile ending at this distance. */
  highlightMile?: number;
  /** Display unit; defaults to the athlete's distance unit (km → km + m, mi → mi + ft). */
  unit?: DistanceUnit;
  /** Height in px */
  height?: number;
}

/** Smallest "nice" grid step giving at most ~5 lines over `range`. */
function niceStep(range: number): number {
  for (const step of [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) {
    if (range / step <= 5) return step;
  }
  return 2000;
}

/**
 * Course elevation profile (SVG, no dependencies). Unit-aware axes, an
 * optional highlighted segment (RS-13) and a text summary for screen readers.
 */
export default function ElevationChart({ points, totalDistanceMi, highlight, highlightMile, unit, height = 180 }: Props) {
  const gradientId = `elev-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (points.length < 2) {
    return <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: '1rem', margin: 0 }}>No elevation data available.</p>;
  }

  const u: DistanceUnit = unit ?? getDistanceUnit();
  const lastMi = points[points.length - 1].distanceMi;
  const total = Number.isFinite(totalDistanceMi) && totalDistanceMi > 0 ? totalDistanceMi : (lastMi > 0 ? lastMi : 1);
  const toElev = (ft: number) => (u === 'km' ? ft / FT_PER_M : ft);
  const elevSuffix = u === 'km' ? ' m' : ' ft';
  const distUnits = u === 'km' ? total * KM_PER_MI : total;

  const width = 700;
  const padding = { top: 20, right: 20, bottom: 40, left: 52 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const elevations = points.map((p) => toElev(p.elevationFt));
  const minElev = Math.min(...elevations);
  const maxElev = Math.max(...elevations);
  const elevRange = Math.max(maxElev - minElev, u === 'km' ? 15 : 50); // minimum visual range
  const elevPad = elevRange * 0.1;

  const scaleX = (mi: number) => padding.left + (Math.min(Math.max(mi, 0), total) / total) * chartW;
  const scaleY = (elev: number) => padding.top + chartH - ((elev - minElev + elevPad) / (elevRange + 2 * elevPad)) * chartH;

  const pathPoints = points.map((p) => `${scaleX(p.distanceMi)},${scaleY(toElev(p.elevationFt))}`);
  const baseY = scaleY(minElev - elevPad);
  const areaPath = `M${pathPoints[0]} ${pathPoints.slice(1).map((p) => `L${p}`).join(' ')} L${scaleX(lastMi)},${baseY} L${scaleX(points[0].distanceMi)},${baseY} Z`;
  const linePath = `M${pathPoints.join(' L')}`;

  const landmarks = points.filter((p) => p.landmark);

  const gridStep = niceStep(elevRange);
  const gridElevs: number[] = [];
  for (let e = Math.ceil(minElev / gridStep) * gridStep; e <= maxElev; e += gridStep) gridElevs.push(e);

  const distStep = distUnits > 20 ? 5 : distUnits > 10 ? 2 : 1;
  const distMarkers: number[] = [];
  for (let d = 0; d <= distUnits + 1e-9; d += distStep) distMarkers.push(d);
  const unitToMi = (d: number) => (u === 'km' ? d / KM_PER_MI : d);

  const band: ElevationHighlight | undefined = highlight
    ?? (highlightMile != null ? { fromMi: Math.max(0, highlightMile - 1), toMi: highlightMile } : undefined);

  const hiIdx = elevations.indexOf(maxElev);
  const loIdx = elevations.indexOf(minElev);
  const fmtDist = (mi: number) => `${(u === 'km' ? mi * KM_PER_MI : mi).toFixed(1)} ${u}`;
  const summary = `Course elevation profile over ${fmtDist(total)}: high point ${Math.round(maxElev)}${elevSuffix} at ${fmtDist(points[hiIdx].distanceMi)}, low point ${Math.round(minElev)}${elevSuffix} at ${fmtDist(points[loIdx].distanceMi)}.`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height: 'auto', maxHeight: height }}
      role="img"
      aria-label={summary}
    >
      {gridElevs.map((e) => (
        <g key={`grid-${e}`}>
          <line
            x1={padding.left} y1={scaleY(e)}
            x2={width - padding.right} y2={scaleY(e)}
            stroke="var(--border)" strokeWidth={0.5} strokeDasharray="3,3"
          />
          <text x={padding.left - 5} y={scaleY(e) + 3} textAnchor="end"
            fill="var(--text-muted)" fontSize={9} fontFamily="var(--font-mono)">
            {e}{elevSuffix}
          </text>
        </g>
      ))}

      {distMarkers.map((d) => (
        <g key={`dist-${d}`}>
          <line
            x1={scaleX(unitToMi(d))} y1={padding.top}
            x2={scaleX(unitToMi(d))} y2={height - padding.bottom}
            stroke="var(--border-subtle)" strokeWidth={0.5}
          />
          <text x={scaleX(unitToMi(d))} y={height - padding.bottom + 15} textAnchor="middle"
            fill="var(--text-muted)" fontSize={9} fontFamily="var(--font-mono)">
            {d}
          </text>
        </g>
      ))}

      <text x={width / 2} y={height - 5} textAnchor="middle"
        fill="var(--text-muted)" fontSize={10} fontFamily="var(--font-display)">
        {u === 'km' ? 'Distance (km)' : 'Distance (miles)'}
      </text>

      {band && band.toMi > band.fromMi && (
        <rect
          data-testid="elevation-highlight"
          x={scaleX(band.fromMi)} y={padding.top}
          width={Math.max(2, scaleX(band.toMi) - scaleX(band.fromMi))} height={chartH}
          fill="var(--apollo-gold)" opacity={0.18}
        />
      )}

      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--apollo-gold)" stopOpacity={0.6} />
          <stop offset="100%" stopColor="var(--apollo-gold)" stopOpacity={0.05} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} opacity={0.5} />
      <path d={linePath} fill="none" stroke="var(--apollo-gold)" strokeWidth={2} />

      {landmarks.map((p, i) => (
        <g key={`lm-${i}`}>
          <circle
            cx={scaleX(p.distanceMi)} cy={scaleY(toElev(p.elevationFt))}
            r={3} fill="var(--apollo-gold)" stroke="var(--bg-card)" strokeWidth={1.5}
          />
          {i % 2 === 0 && (
            <text
              x={scaleX(p.distanceMi)} y={scaleY(toElev(p.elevationFt)) - 8}
              textAnchor="middle" fill="var(--text-secondary)" fontSize={7.5}
              fontFamily="var(--font-display)" fontWeight={600}
            >
              {(p.landmark?.length ?? 0) > 25 ? `${p.landmark?.slice(0, 22)}…` : p.landmark}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
