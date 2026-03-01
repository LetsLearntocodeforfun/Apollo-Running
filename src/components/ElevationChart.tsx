import type { ElevationPoint } from '../types/raceStrategy';

interface Props {
  points: ElevationPoint[];
  totalDistanceMi: number;
  /** Highlight a specific mile (e.g. when hovering over pace table) */
  highlightMile?: number;
  /** Height in px */
  height?: number;
}

export default function ElevationChart({ points, totalDistanceMi, highlightMile, height = 180 }: Props) {
  if (points.length < 2) {
    return <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: '1rem' }}>No elevation data available</div>;
  }

  const width = 700;
  const padding = { top: 20, right: 20, bottom: 40, left: 45 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const elevations = points.map((p) => p.elevationFt);
  const minElev = Math.min(...elevations);
  const maxElev = Math.max(...elevations);
  const elevRange = Math.max(maxElev - minElev, 50); // min 50ft range for visual clarity
  const elevPad = elevRange * 0.1;

  const scaleX = (dist: number) => padding.left + (dist / totalDistanceMi) * chartW;
  const scaleY = (elev: number) => padding.top + chartH - ((elev - minElev + elevPad) / (elevRange + 2 * elevPad)) * chartH;

  // Build the area path
  const pathPoints = points.map((p) => `${scaleX(p.distanceMi)},${scaleY(p.elevationFt)}`);
  const areaPath = `M${pathPoints[0]} ${pathPoints.slice(1).map((p) => `L${p}`).join(' ')} L${scaleX(points[points.length - 1].distanceMi)},${scaleY(minElev - elevPad)} L${scaleX(0)},${scaleY(minElev - elevPad)} Z`;
  const linePath = `M${pathPoints.join(' L')}`;

  // Key landmarks
  const landmarks = points.filter((p) => p.landmark);

  // Grid lines
  const gridElevs: number[] = [];
  const elevStep = elevRange > 400 ? 200 : elevRange > 200 ? 100 : 50;
  for (let e = Math.ceil(minElev / elevStep) * elevStep; e <= maxElev; e += elevStep) {
    gridElevs.push(e);
  }

  // Mile markers
  const mileMarkers: number[] = [];
  const mileStep = totalDistanceMi > 20 ? 5 : totalDistanceMi > 10 ? 2 : 1;
  for (let m = 0; m <= totalDistanceMi; m += mileStep) {
    mileMarkers.push(m);
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: '100%', height: 'auto', maxHeight: height }}
      aria-label="Course elevation profile"
    >
      {/* Grid lines */}
      {gridElevs.map((e) => (
        <g key={`grid-${e}`}>
          <line
            x1={padding.left} y1={scaleY(e)}
            x2={width - padding.right} y2={scaleY(e)}
            stroke="var(--border)" strokeWidth={0.5} strokeDasharray="3,3"
          />
          <text x={padding.left - 5} y={scaleY(e) + 3} textAnchor="end"
            fill="var(--text-muted)" fontSize={9} fontFamily="var(--font-mono)">
            {e}′
          </text>
        </g>
      ))}

      {/* Mile markers on x-axis */}
      {mileMarkers.map((m) => (
        <g key={`mile-${m}`}>
          <line
            x1={scaleX(m)} y1={padding.top}
            x2={scaleX(m)} y2={height - padding.bottom}
            stroke="var(--border-subtle)" strokeWidth={0.5}
          />
          <text x={scaleX(m)} y={height - padding.bottom + 15} textAnchor="middle"
            fill="var(--text-muted)" fontSize={9} fontFamily="var(--font-mono)">
            {m}
          </text>
        </g>
      ))}

      {/* Axis labels */}
      <text x={width / 2} y={height - 5} textAnchor="middle"
        fill="var(--text-muted)" fontSize={10} fontFamily="var(--font-display)">
        Distance (miles)
      </text>

      {/* Highlight mile */}
      {highlightMile != null && (
        <rect
          x={scaleX(highlightMile - 1)} y={padding.top}
          width={chartW / totalDistanceMi} height={chartH}
          fill="var(--apollo-gold)" opacity={0.1}
        />
      )}

      {/* Filled area */}
      <path d={areaPath} fill="url(#elevGradient)" opacity={0.5} />
      <defs>
        <linearGradient id="elevGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--apollo-gold)" stopOpacity={0.6} />
          <stop offset="100%" stopColor="var(--apollo-gold)" stopOpacity={0.05} />
        </linearGradient>
      </defs>

      {/* Line */}
      <path d={linePath} fill="none" stroke="var(--apollo-gold)" strokeWidth={2} />

      {/* Landmark dots */}
      {landmarks.map((p, i) => (
        <g key={`lm-${i}`}>
          <circle
            cx={scaleX(p.distanceMi)} cy={scaleY(p.elevationFt)}
            r={3} fill="var(--apollo-gold)" stroke="var(--bg-card)" strokeWidth={1.5}
          />
          {/* Show landmark name for important ones (not too crowded) */}
          {i % 2 === 0 && (
            <text
              x={scaleX(p.distanceMi)} y={scaleY(p.elevationFt) - 8}
              textAnchor="middle" fill="var(--text-secondary)" fontSize={7.5}
              fontFamily="var(--font-display)" fontWeight={600}
            >
              {(p.landmark?.length ?? 0) > 25 ? p.landmark!.slice(0, 22) + '…' : p.landmark}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
