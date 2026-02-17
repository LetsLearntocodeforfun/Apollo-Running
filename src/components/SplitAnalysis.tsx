/**
 * SplitAnalysis.tsx — Split & Lap Visualization Components for Apollo Running.
 *
 * Pure SVG bar chart for pace per split, split data table, pace consistency
 * badge, and interval workout summary. Follows the Art Deco design system.
 */

import { useState } from 'react';
import type {
  SplitAnalysis,
  SplitData,
  LapData,
  PaceConsistencyGrade,
  SplitInsight,
} from '../services/splitService';
import { formatPaceShort } from '../services/splitService';
import { paceUnitLabel, unitLabel, formatElevation, formatDuration } from '../services/unitPreferences';

// ─── Consistency Badge ───────────────────────────────────────

const GRADE_CONFIG: Record<PaceConsistencyGrade, { label: string; color: string; bg: string; icon: string }> = {
  gold:   { label: 'Gold Pacing',   color: 'var(--apollo-gold)',     bg: 'var(--apollo-gold-dim)',           icon: '★' },
  silver: { label: 'Silver Pacing', color: 'var(--text-secondary)',  bg: 'rgba(184, 178, 168, 0.12)',       icon: '▲' },
  bronze: { label: 'Bronze Pacing', color: '#CD7F32',               bg: 'rgba(205, 127, 50, 0.12)',        icon: '●' },
  iron:   { label: 'Variable',      color: 'var(--text-muted)',      bg: 'rgba(138, 132, 120, 0.10)',       icon: '◇' },
};

export function ConsistencyBadge({ grade, cv }: { grade: PaceConsistencyGrade; cv: number }) {
  const cfg = GRADE_CONFIG[grade];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
      fontSize: '0.72rem', fontWeight: 600,
      padding: '0.2rem 0.65rem',
      borderRadius: 'var(--radius-full)',
      background: cfg.bg,
      color: cfg.color,
      fontFamily: 'var(--font-display)',
      letterSpacing: '0.02em',
    }}>
      <span>{cfg.icon}</span>
      <span>{cfg.label}</span>
      <span style={{ opacity: 0.7, fontWeight: 400 }}>({cv.toFixed(1)}% CV)</span>
    </span>
  );
}

// ─── Pace Bar Chart (Pure SVG) ───────────────────────────────

interface PaceBarChartProps {
  splits: SplitData[];
  unit: string;
  meanPace: number;
}

export function PaceBarChart({ splits, meanPace }: PaceBarChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (splits.length === 0) return null;

  const paces = splits.map((s) => s.paceMinPerUnit).filter((p) => p > 0);
  if (paces.length === 0) return null;

  // Chart dimensions
  const chartWidth = 600;
  const chartHeight = 200;
  const margin = { top: 30, right: 16, bottom: 36, left: 50 };
  const plotWidth = chartWidth - margin.left - margin.right;
  const plotHeight = chartHeight - margin.top - margin.bottom;

  // Y-axis: pace range (inverted — lower pace = faster = taller bar)
  const minPace = Math.min(...paces) * 0.92;
  const maxPace = Math.max(...paces) * 1.04;
  const paceRange = maxPace - minPace || 1;

  // Bar sizing
  const barGap = Math.max(2, Math.min(6, plotWidth / splits.length * 0.15));
  const barWidth = Math.max(8, (plotWidth - barGap * (splits.length - 1)) / splits.length);

  // Y position for a pace value (faster = taller bar from bottom)
  const yForPace = (pace: number) => {
    return margin.top + ((pace - minPace) / paceRange) * plotHeight;
  };

  // Color for a bar based on deviation from mean
  const barColor = (split: SplitData) => {
    if (split.isFastest) return 'var(--apollo-gold)';
    if (split.isSlowest) return 'var(--color-error)';
    const dev = split.paceDeviationPct;
    if (dev < -3) return 'var(--apollo-teal)';  // faster
    if (dev > 3) return 'var(--apollo-orange)';  // slower
    return 'var(--text-secondary)'; // near mean
  };

  const meanY = yForPace(meanPace);

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg
        viewBox={`0 0 ${chartWidth} ${chartHeight}`}
        width="100%"
        style={{ maxHeight: 220, display: 'block' }}
        role="img"
        aria-label="Pace per split bar chart"
      >
        {/* Background */}
        <rect x={margin.left} y={margin.top} width={plotWidth} height={plotHeight}
          fill="var(--bg-surface)" rx={4} />

        {/* Mean pace line */}
        <line
          x1={margin.left} y1={meanY}
          x2={margin.left + plotWidth} y2={meanY}
          stroke="var(--apollo-gold)" strokeWidth={1} strokeDasharray="6 3" opacity={0.6}
        />
        <text
          x={margin.left + plotWidth + 4} y={meanY + 3}
          fontSize={9} fill="var(--apollo-gold)" fontFamily="var(--font-mono)"
          opacity={0.8}
        >
          avg
        </text>

        {/* Y-axis labels (pace values) */}
        {[minPace, minPace + paceRange / 2, maxPace].map((p, i) => (
          <text
            key={i}
            x={margin.left - 6}
            y={yForPace(p) + 3}
            fontSize={9}
            fill="var(--text-muted)"
            textAnchor="end"
            fontFamily="var(--font-mono)"
          >
            {formatPaceShort(p)}
          </text>
        ))}

        {/* Bars */}
        {splits.map((split, idx) => {
          const pace = split.paceMinPerUnit;
          if (pace <= 0) return null;

          const x = margin.left + idx * (barWidth + barGap);
          const barTop = yForPace(minPace); // bottom of chart = fastest
          const barBottom = yForPace(pace);
          const y = Math.min(barTop, barBottom);
          const h = Math.abs(barBottom - barTop);

          const isHovered = hoveredIdx === idx;

          return (
            <g key={idx}
              onMouseEnter={() => setHoveredIdx(idx)}
              onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: 'default' }}
            >
              {/* Bar */}
              <rect
                x={x} y={y} width={barWidth} height={Math.max(h, 2)}
                fill={barColor(split)}
                rx={2}
                opacity={isHovered ? 1 : 0.85}
                style={{ transition: 'opacity 0.15s ease' }}
              />

              {/* HR dot (if available) */}
              {split.avgHR && split.avgHR > 0 && (
                <circle
                  cx={x + barWidth / 2}
                  cy={margin.top - 8}
                  r={3}
                  fill="var(--color-error)"
                  opacity={0.6}
                />
              )}

              {/* X-axis label */}
              <text
                x={x + barWidth / 2}
                y={margin.top + plotHeight + 14}
                fontSize={splits.length > 15 ? 7 : 9}
                fill="var(--text-muted)"
                textAnchor="middle"
                fontFamily="var(--font-mono)"
              >
                {split.number}
              </text>

              {/* Hover tooltip */}
              {isHovered && (
                <g>
                  <rect
                    x={x + barWidth / 2 - 38} y={y - 28}
                    width={76} height={22}
                    fill="var(--bg-elevated)" rx={4}
                    stroke="var(--border)" strokeWidth={0.5}
                  />
                  <text
                    x={x + barWidth / 2} y={y - 14}
                    fontSize={10} fill="var(--text)"
                    textAnchor="middle" fontFamily="var(--font-mono)" fontWeight={600}
                  >
                    {formatPaceShort(pace)}{paceUnitLabel()} {split.avgHR ? `${Math.round(split.avgHR)}♥` : ''}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* X-axis title */}
        <text
          x={margin.left + plotWidth / 2}
          y={chartHeight - 4}
          fontSize={10} fill="var(--text-muted)"
          textAnchor="middle" fontFamily="var(--font-display)" fontWeight={500}
        >
          Split ({unitLabel()})
        </text>

        {/* Y-axis title */}
        <text
          x={8}
          y={margin.top + plotHeight / 2}
          fontSize={10} fill="var(--text-muted)"
          textAnchor="middle" fontFamily="var(--font-display)" fontWeight={500}
          transform={`rotate(-90, 8, ${margin.top + plotHeight / 2})`}
        >
          Pace
        </text>
      </svg>
    </div>
  );
}

// ─── Split Table ─────────────────────────────────────────────

function SplitTable({ splits }: { splits: SplitData[]; unit: string }) {
  if (splits.length === 0) return null;

  const hasHR = splits.some((s) => s.avgHR && s.avgHR > 0);
  const hasElev = splits.some((s) => Math.abs(s.elevationDiffMeters) > 0.5);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)',
        fontFamily: 'var(--font-body)',
      }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-strong)' }}>
            <th style={thStyle}>{unitLabel() === 'km' ? 'KM' : 'Mile'}</th>
            <th style={thStyle}>Pace</th>
            <th style={thStyle}>Time</th>
            {hasHR && <th style={thStyle}>HR</th>}
            {hasElev && <th style={thStyle}>Elev</th>}
            <th style={thStyle}>Dev</th>
          </tr>
        </thead>
        <tbody>
          {splits.map((split) => (
            <tr key={split.number} style={{
              borderBottom: '1px solid var(--border-subtle)',
              background: split.isFastest
                ? 'rgba(212, 165, 55, 0.06)'
                : split.isSlowest
                ? 'rgba(231, 76, 60, 0.04)'
                : 'transparent',
            }}>
              <td style={tdStyle}>
                <span style={{ fontWeight: 600, fontFamily: 'var(--font-display)' }}>
                  {split.number}
                </span>
                {split.isFastest && <span style={{ color: 'var(--apollo-gold)', marginLeft: 4, fontSize: '0.7rem' }}>★ fastest</span>}
                {split.isSlowest && <span style={{ color: 'var(--color-error)', marginLeft: 4, fontSize: '0.7rem' }}>▼ slowest</span>}
              </td>
              <td style={{
                ...tdStyle,
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                color: split.isFastest ? 'var(--apollo-gold)' : split.isSlowest ? 'var(--color-error)' : 'var(--text)',
              }}>
                {formatPaceShort(split.paceMinPerUnit)}<span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{paceUnitLabel()}</span>
              </td>
              <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }}>
                {formatDuration(split.movingTimeSec)}
              </td>
              {hasHR && (
                <td style={{ ...tdStyle, color: split.avgHR ? 'var(--color-error)' : 'var(--text-muted)' }}>
                  {split.avgHR ? `${Math.round(split.avgHR)}` : '—'}
                </td>
              )}
              {hasElev && (
                <td style={{ ...tdStyle, color: split.elevationDiffMeters > 0 ? 'var(--color-success)' : split.elevationDiffMeters < -1 ? 'var(--apollo-teal)' : 'var(--text-muted)' }}>
                  {split.elevationDiffMeters > 0 ? '+' : ''}{formatElevation(split.elevationDiffMeters)}
                </td>
              )}
              <td style={{
                ...tdStyle,
                fontFamily: 'var(--font-mono)',
                fontSize: '0.78rem',
                color: split.paceDeviationPct < -2 ? 'var(--apollo-teal)' : split.paceDeviationPct > 2 ? 'var(--apollo-orange)' : 'var(--text-muted)',
              }}>
                {split.paceDeviationPct > 0 ? '+' : ''}{split.paceDeviationPct.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.4rem 0.6rem',
  fontSize: '0.68rem',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  fontSize: 'var(--text-sm)',
};

// ─── Lap Table ───────────────────────────────────────────────

function LapTable({ laps }: { laps: LapData[] }) {
  if (laps.length === 0) return null;

  const hasHR = laps.some((l) => l.avgHR && l.avgHR > 0);
  const hasCadence = laps.some((l) => l.avgCadenceSpm && l.avgCadenceSpm > 0);

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)',
        fontFamily: 'var(--font-body)',
      }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border-strong)' }}>
            <th style={thStyle}>Lap</th>
            <th style={thStyle}>Dist</th>
            <th style={thStyle}>Pace</th>
            <th style={thStyle}>Time</th>
            {hasHR && <th style={thStyle}>HR</th>}
            {hasCadence && <th style={thStyle}>Cadence</th>}
            <th style={thStyle}>Elev</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap) => (
            <tr key={lap.index} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <td style={tdStyle}>
                <span style={{ fontWeight: 500 }}>{lap.name}</span>
              </td>
              <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }}>
                {(lap.distanceMeters / (unitLabel() === 'km' ? 1000 : 1609.344)).toFixed(2)} {unitLabel()}
              </td>
              <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text)' }}>
                {formatPaceShort(lap.paceMinPerUnit)}<span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{paceUnitLabel()}</span>
              </td>
              <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }}>
                {formatDuration(lap.movingTimeSec)}
              </td>
              {hasHR && (
                <td style={{ ...tdStyle, color: 'var(--color-error)' }}>
                  {lap.avgHR ? `${Math.round(lap.avgHR)}` : '—'}
                  {lap.maxHR ? <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}> / {Math.round(lap.maxHR)}</span> : ''}
                </td>
              )}
              {hasCadence && (
                <td style={tdStyle}>
                  {lap.avgCadenceSpm ? `${lap.avgCadenceSpm} spm` : '—'}
                </td>
              )}
              <td style={{ ...tdStyle, color: lap.elevationGainMeters > 0 ? 'var(--color-success)' : 'var(--text-muted)' }}>
                {lap.elevationGainMeters > 0 ? `+${formatElevation(lap.elevationGainMeters)}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Insight Panel ───────────────────────────────────────────

const INSIGHT_BORDER: Record<SplitInsight['sentiment'], string> = {
  positive: 'var(--color-success)',
  neutral: 'var(--border)',
  negative: 'var(--color-warning)',
};

function InsightsList({ insights }: { insights: SplitInsight[] }) {
  if (insights.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      {insights.map((insight, i) => (
        <div key={i} style={{
          fontSize: 'var(--text-sm)',
          color: insight.sentiment === 'positive' ? 'var(--text)' : 'var(--text-secondary)',
          lineHeight: 1.5,
          padding: '0.25rem 0 0.25rem 0.75rem',
          borderLeft: `2px solid ${INSIGHT_BORDER[insight.sentiment]}`,
        }}>
          {insight.message}
        </div>
      ))}
    </div>
  );
}

// ─── Main Panel Component ────────────────────────────────────

type SplitTab = 'chart' | 'splits' | 'laps';

interface SplitAnalysisPanelProps {
  analysis: SplitAnalysis;
}

export function SplitAnalysisPanel({ analysis }: SplitAnalysisPanelProps) {
  const [activeTab, setActiveTab] = useState<SplitTab>('chart');

  const hasLaps = analysis.laps.length > 0;
  const tabs: { key: SplitTab; label: string }[] = [
    { key: 'chart', label: 'Pace Chart' },
    { key: 'splits', label: `Splits (${analysis.splits.length})` },
  ];
  if (hasLaps) {
    tabs.push({ key: 'laps', label: `Laps (${analysis.laps.length})` });
  }

  return (
    <div style={{
      marginTop: '1rem',
      padding: '0.85rem 1rem',
      background: 'rgba(91, 181, 181, 0.03)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border)',
      borderLeftWidth: 3,
      borderLeftColor: analysis.consistency.grade === 'gold'
        ? 'var(--apollo-gold)'
        : analysis.consistency.grade === 'silver'
        ? 'var(--text-secondary)'
        : analysis.consistency.grade === 'bronze'
        ? '#CD7F32'
        : 'var(--border)',
      animation: 'slideUp 0.25s ease',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        flexWrap: 'wrap', gap: '0.5rem',
        marginBottom: '0.75rem',
      }}>
        <span style={{
          fontSize: '0.72rem', fontFamily: 'var(--font-display)', fontWeight: 600,
          textTransform: 'uppercase', letterSpacing: '0.08em',
          color: 'var(--text-muted)',
        }}>
          Split Analysis · {analysis.splits.length} {unitLabel() === 'km' ? 'km' : 'miles'}
        </span>
        <ConsistencyBadge grade={analysis.consistency.grade} cv={analysis.consistency.coefficientOfVariation} />
      </div>

      {/* Pattern summary */}
      {analysis.pattern.pattern !== 'variable' && (
        <div style={{
          fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
          marginBottom: '0.75rem', lineHeight: 1.5,
        }}>
          {analysis.pattern.description}
        </div>
      )}

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: '0.25rem',
        borderBottom: '1px solid var(--border)',
        marginBottom: '0.75rem',
      }}>
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '0.5rem 0.85rem',
              fontSize: '0.78rem', fontFamily: 'var(--font-display)', fontWeight: 600,
              color: activeTab === tab.key ? 'var(--apollo-gold)' : 'var(--text-muted)',
              borderBottom: activeTab === tab.key ? '2px solid var(--apollo-gold)' : '2px solid transparent',
              transition: 'color var(--transition-fast), border-color var(--transition-fast)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'chart' && (
        <PaceBarChart
          splits={analysis.splits}
          unit={analysis.unit}
          meanPace={analysis.consistency.meanPace}
        />
      )}

      {activeTab === 'splits' && (
        <SplitTable splits={analysis.splits} unit={analysis.unit} />
      )}

      {activeTab === 'laps' && hasLaps && (
        <LapTable laps={analysis.laps} />
      )}

      {/* Interval detection */}
      {analysis.intervals?.isInterval && (
        <div style={{
          marginTop: '0.75rem', padding: '0.6rem 0.75rem',
          background: 'var(--apollo-teal-dim)', borderRadius: 'var(--radius-sm)',
          fontSize: 'var(--text-sm)', color: 'var(--apollo-teal)',
          fontWeight: 500, fontFamily: 'var(--font-display)',
        }}>
          ⚡ Interval Workout: {analysis.intervals.workIntervals} work × {analysis.intervals.recoveryIntervals} rest ({analysis.intervals.workRestRatio})
        </div>
      )}

      {/* Insights */}
      {analysis.insights.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          <InsightsList insights={analysis.insights} />
        </div>
      )}
    </div>
  );
}

/**
 * Compact one-line summary of split analysis for list views.
 * Shows grade badge + best split pace.
 */
export function SplitSummaryBadge({ analysis }: { analysis: SplitAnalysis }) {
  const cfg = GRADE_CONFIG[analysis.consistency.grade];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
      fontSize: '0.68rem', color: cfg.color, fontWeight: 600,
      fontFamily: 'var(--font-display)',
    }}>
      <span>{cfg.icon}</span>
      <span>{formatPaceShort(analysis.consistency.fastestPace)}–{formatPaceShort(analysis.consistency.slowestPace)}{paceUnitLabel()}</span>
    </span>
  );
}
