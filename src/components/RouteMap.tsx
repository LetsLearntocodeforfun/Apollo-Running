/**
 * RouteMap — Pure SVG route visualization component for Apollo Running.
 *
 * Renders decoded polylines as stylized Art Deco route art.
 * Zero external dependencies — no Leaflet, no Mapbox, no API keys.
 * Works 100% offline with locally cached route data.
 *
 * Features:
 *   - Animated "route drawing" effect on first render
 *   - Apollo gold gradient or pace-based color mode
 *   - Start (green) and end (gold) markers
 *   - Mile/km distance markers along the route
 *   - Loop detection badge
 *   - Compass bearing indicator
 *   - Responsive sizing (thumbnail, card, detail)
 *   - Hover tooltip with distance at point
 */

import { useState, useMemo, useRef, useCallback } from 'react';
import {
  processRoute,
  getPolylineForActivity,
  bearingToCompass,
  type RouteData,
} from '../services/routeService';

// ─── Types ───────────────────────────────────────────────────

export type RouteMapSize = 'thumbnail' | 'card' | 'detail';
export type RouteColorMode = 'apollo' | 'teal' | 'strava';

export interface RouteMapProps {
  /** The Strava activity (must include map.summary_polyline). */
  activity: {
    id: number;
    distance: number;
    map?: { summary_polyline: string | null } | null;
  };
  /** Display size preset. */
  size?: RouteMapSize;
  /** Color theme for the route stroke. */
  colorMode?: RouteColorMode;
  /** Animate drawing the route on first render. */
  animate?: boolean;
  /** Show distance markers along the route. */
  showMarkers?: boolean;
  /** Show start/end indicator dots. */
  showEndpoints?: boolean;
  /** Show compass bearing badge. */
  showCompass?: boolean;
  /** Extra CSS class name. */
  className?: string;
  /** Click handler. */
  onClick?: () => void;
}

// ─── Size Presets ────────────────────────────────────────────

const SIZE_CONFIG: Record<RouteMapSize, {
  width: number;
  height: number;
  strokeWidth: number;
  markerRadius: number;
  endpointRadius: number;
  fontSize: number;
  showMarkers: boolean;
  showCompass: boolean;
}> = {
  thumbnail: {
    width: 80,
    height: 60,
    strokeWidth: 2,
    markerRadius: 0,
    endpointRadius: 2.5,
    fontSize: 0,
    showMarkers: false,
    showCompass: false,
  },
  card: {
    width: 400,
    height: 200,
    strokeWidth: 2.5,
    markerRadius: 3,
    endpointRadius: 4,
    fontSize: 8,
    showMarkers: true,
    showCompass: true,
  },
  detail: {
    width: 600,
    height: 400,
    strokeWidth: 3,
    markerRadius: 4,
    endpointRadius: 5.5,
    fontSize: 10,
    showMarkers: true,
    showCompass: true,
  },
};

// ─── Color Gradients ─────────────────────────────────────────

function getGradientStops(mode: RouteColorMode): { offset: string; color: string }[] {
  switch (mode) {
    case 'apollo':
      return [
        { offset: '0%', color: '#B8892A' },
        { offset: '30%', color: '#D4A537' },
        { offset: '60%', color: '#E8C05A' },
        { offset: '100%', color: '#D4A537' },
      ];
    case 'teal':
      return [
        { offset: '0%', color: '#3D9494' },
        { offset: '40%', color: '#5BB5B5' },
        { offset: '70%', color: '#7ECECE' },
        { offset: '100%', color: '#5BB5B5' },
      ];
    case 'strava':
      return [
        { offset: '0%', color: '#FC4C02' },
        { offset: '50%', color: '#FF6B2B' },
        { offset: '100%', color: '#FC4C02' },
      ];
  }
}

// ─── Component ───────────────────────────────────────────────

export default function RouteMap({
  activity,
  size = 'card',
  colorMode = 'apollo',
  animate = true,
  showMarkers,
  showEndpoints = true,
  showCompass,
  className,
  onClick,
}: RouteMapProps) {
  const config = SIZE_CONFIG[size];
  const effectiveShowMarkers = showMarkers ?? config.showMarkers;
  const effectiveShowCompass = showCompass ?? config.showCompass;

  const [hoverInfo, setHoverInfo] = useState<{ x: number; y: number; distKm: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  // Process the route
  const route: RouteData | null = useMemo(() => {
    const polyline = getPolylineForActivity(activity);
    if (!polyline) return null;
    return processRoute(polyline, config.width, config.height);
  }, [activity, config.width, config.height]);

  // Distance markers (every mile ~ 1609m)
  const markers = useMemo(() => {
    if (!route || !effectiveShowMarkers) return [];
    const interval = 1609.34; // 1 mile
    const result: { x: number; y: number; label: string }[] = [];
    let nextDist = interval;
    let markerNum = 1;

    for (let i = 1; i < route.segments.length && markerNum <= 30; i++) {
      const seg = route.segments[i];
      const prevCum = route.segments[i - 1]?.cumulativeMeters ?? 0;
      while (nextDist <= seg.cumulativeMeters && markerNum <= 30) {
        const t = seg.segmentMeters > 0 ? (nextDist - prevCum) / seg.segmentMeters : 0;
        const fromPt = route.projectedPoints[i];
        const toPt = route.projectedPoints[i + 1];
        if (fromPt && toPt) {
          result.push({
            x: fromPt.x + (toPt.x - fromPt.x) * Math.min(t, 1),
            y: fromPt.y + (toPt.y - fromPt.y) * Math.min(t, 1),
            label: String(markerNum),
          });
        }
        markerNum++;
        nextDist += interval;
      }
    }
    return result;
  }, [route, effectiveShowMarkers]);

  // Hover handler for detail mode
  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!route || size === 'thumbnail' || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * config.width;
    const my = ((e.clientY - rect.top) / rect.height) * config.height;

    // Find nearest point
    let minDist = Infinity;
    let nearestIdx = 0;
    for (let i = 0; i < route.projectedPoints.length; i++) {
      const p = route.projectedPoints[i];
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < minDist) { minDist = d; nearestIdx = i; }
    }

    if (minDist < 30) {
      const seg = route.segments[Math.min(nearestIdx, route.segments.length - 1)];
      setHoverInfo({
        x: route.projectedPoints[nearestIdx].x,
        y: route.projectedPoints[nearestIdx].y,
        distKm: (seg.cumulativeMeters / 1000).toFixed(1),
      });
    } else {
      setHoverInfo(null);
    }
  }, [route, size, config.width, config.height]);

  const handleMouseLeave = useCallback(() => setHoverInfo(null), []);

  // No route data — render placeholder
  if (!route) {
    return (
      <div
        className={className}
        style={{
          width: size === 'thumbnail' ? config.width : '100%',
          height: config.height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-surface)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-muted)',
          fontSize: size === 'thumbnail' ? '0.6rem' : '0.82rem',
          fontFamily: 'var(--font-display)',
        }}
      >
        {size === 'thumbnail' ? '—' : 'No route data'}
      </div>
    );
  }

  const gradientId = `route-grad-${activity.id}`;
  const glowId = `route-glow-${activity.id}`;
  const animId = `route-anim-${activity.id}`;

  // Estimate path length for stroke animation
  const pathLength = route.projectedPoints.reduce((sum, p, i) => {
    if (i === 0) return 0;
    const prev = route.projectedPoints[i - 1];
    return sum + Math.hypot(p.x - prev.x, p.y - prev.y);
  }, 0);

  const startPt = route.projectedPoints[0];
  const endPt = route.projectedPoints[route.projectedPoints.length - 1];

  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        position: 'relative',
        width: size === 'thumbnail' ? config.width : '100%',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : undefined,
        background: 'linear-gradient(135deg, rgba(13,27,42,0.95) 0%, rgba(21,36,56,0.95) 100%)',
        border: '1px solid var(--border)',
      }}
    >
      {/* SVG route art */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${config.width} ${config.height}`}
        width="100%"
        height={config.height}
        style={{ display: 'block' }}
        onMouseMove={size !== 'thumbnail' ? handleMouseMove : undefined}
        onMouseLeave={size !== 'thumbnail' ? handleMouseLeave : undefined}
      >
        <defs>
          {/* Route gradient */}
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            {getGradientStops(colorMode).map((s, i) => (
              <stop key={i} offset={s.offset} stopColor={s.color} />
            ))}
          </linearGradient>
          {/* Glow filter */}
          <filter id={glowId} x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation={size === 'thumbnail' ? 1 : 2.5} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {/* Draw animation */}
          {animate && pathLength > 0 && (
            <style>{`
              @keyframes ${animId} {
                from { stroke-dashoffset: ${pathLength.toFixed(0)}; }
                to   { stroke-dashoffset: 0; }
              }
            `}</style>
          )}
        </defs>

        {/* Subtle grid pattern for depth */}
        {size !== 'thumbnail' && (
          <g opacity="0.04">
            {Array.from({ length: Math.floor(config.width / 40) }, (_, i) => (
              <line key={`v${i}`} x1={(i + 1) * 40} y1="0" x2={(i + 1) * 40} y2={config.height} stroke="#D4A537" strokeWidth="0.5" />
            ))}
            {Array.from({ length: Math.floor(config.height / 40) }, (_, i) => (
              <line key={`h${i}`} x1="0" y1={(i + 1) * 40} x2={config.width} y2={(i + 1) * 40} stroke="#D4A537" strokeWidth="0.5" />
            ))}
          </g>
        )}

        {/* Route glow (behind main path) */}
        <path
          d={route.svgPath}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={config.strokeWidth * 3}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.15"
          filter={`url(#${glowId})`}
        />

        {/* Main route path */}
        <path
          d={route.svgPath}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={config.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          {...(animate && pathLength > 0 ? {
            strokeDasharray: pathLength.toFixed(0),
            strokeDashoffset: '0',
            style: { animation: `${animId} 1.5s ease-out forwards` },
          } : {})}
        />

        {/* Distance markers */}
        {effectiveShowMarkers && markers.map((m, i) => (
          <g key={i}>
            <circle cx={m.x} cy={m.y} r={config.markerRadius} fill="var(--apollo-navy)" stroke="#D4A537" strokeWidth="1" />
            {config.fontSize > 0 && (
              <text
                x={m.x}
                y={m.y + config.fontSize * 0.35}
                textAnchor="middle"
                fill="#D4A537"
                fontSize={config.fontSize * 0.8}
                fontFamily="var(--font-display)"
                fontWeight="600"
              >
                {m.label}
              </text>
            )}
          </g>
        ))}

        {/* Start marker (green) */}
        {showEndpoints && startPt && (
          <g>
            <circle cx={startPt.x} cy={startPt.y} r={config.endpointRadius + 1} fill="none" stroke="#2ECC71" strokeWidth="1.5" opacity="0.4" />
            <circle cx={startPt.x} cy={startPt.y} r={config.endpointRadius} fill="#2ECC71" />
            {size !== 'thumbnail' && (
              <text
                x={startPt.x + config.endpointRadius + 4}
                y={startPt.y + 3}
                fill="#2ECC71"
                fontSize={config.fontSize}
                fontFamily="var(--font-display)"
                fontWeight="600"
              >
                S
              </text>
            )}
          </g>
        )}

        {/* End marker (gold) */}
        {showEndpoints && endPt && !route.isLoop && (
          <g>
            <circle cx={endPt.x} cy={endPt.y} r={config.endpointRadius + 1} fill="none" stroke="#D4A537" strokeWidth="1.5" opacity="0.4" />
            <circle cx={endPt.x} cy={endPt.y} r={config.endpointRadius} fill="#D4A537" />
            {size !== 'thumbnail' && (
              <text
                x={endPt.x + config.endpointRadius + 4}
                y={endPt.y + 3}
                fill="#D4A537"
                fontSize={config.fontSize}
                fontFamily="var(--font-display)"
                fontWeight="600"
              >
                F
              </text>
            )}
          </g>
        )}

        {/* Loop indicator (on start point) */}
        {showEndpoints && route.isLoop && size !== 'thumbnail' && (
          <g>
            <circle cx={startPt.x} cy={startPt.y} r={config.endpointRadius + 3} fill="none" stroke="#D4A537" strokeWidth="1" strokeDasharray="3 2" opacity="0.6" />
          </g>
        )}

        {/* Hover tooltip */}
        {hoverInfo && (
          <g>
            <circle cx={hoverInfo.x} cy={hoverInfo.y} r="5" fill="#D4A537" opacity="0.8" />
            <rect
              x={hoverInfo.x + 8}
              y={hoverInfo.y - 14}
              width={hoverInfo.distKm.length * 7 + 24}
              height="20"
              rx="4"
              fill="rgba(13,27,42,0.9)"
              stroke="rgba(212,165,55,0.3)"
              strokeWidth="0.5"
            />
            <text
              x={hoverInfo.x + 12}
              y={hoverInfo.y}
              fill="#E8C05A"
              fontSize="10"
              fontFamily="var(--font-display)"
              fontWeight="600"
            >
              {hoverInfo.distKm} km
            </text>
          </g>
        )}
      </svg>

      {/* Compass badge overlay */}
      {effectiveShowCompass && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'rgba(13,27,42,0.85)',
          border: '1px solid rgba(212,165,55,0.2)',
          borderRadius: 'var(--radius-sm)',
          padding: '2px 6px',
          fontSize: '0.65rem',
          fontFamily: 'var(--font-display)',
          fontWeight: 600,
          color: 'var(--apollo-gold)',
          letterSpacing: '0.05em',
        }}>
          {bearingToCompass(route.bearing)}
          {route.isLoop && <span style={{ marginLeft: 4, color: 'var(--apollo-teal)' }}>↻</span>}
        </div>
      )}

      {/* Art Deco corner accents (card/detail only) */}
      {size !== 'thumbnail' && (
        <>
          <div style={{ position: 'absolute', top: 0, left: 0, width: 20, height: 20, borderTop: '1px solid rgba(212,165,55,0.2)', borderLeft: '1px solid rgba(212,165,55,0.2)' }} />
          <div style={{ position: 'absolute', top: 0, right: 0, width: 20, height: 20, borderTop: '1px solid rgba(212,165,55,0.2)', borderRight: '1px solid rgba(212,165,55,0.2)' }} />
          <div style={{ position: 'absolute', bottom: 0, left: 0, width: 20, height: 20, borderBottom: '1px solid rgba(212,165,55,0.2)', borderLeft: '1px solid rgba(212,165,55,0.2)' }} />
          <div style={{ position: 'absolute', bottom: 0, right: 0, width: 20, height: 20, borderBottom: '1px solid rgba(212,165,55,0.2)', borderRight: '1px solid rgba(212,165,55,0.2)' }} />
        </>
      )}
    </div>
  );
}

// ─── Thumbnail convenience wrapper ───────────────────────────

export function RouteMapThumbnail({ activity, onClick }: {
  activity: RouteMapProps['activity'];
  onClick?: () => void;
}) {
  return (
    <RouteMap
      activity={activity}
      size="thumbnail"
      animate={false}
      showEndpoints={true}
      onClick={onClick}
    />
  );
}
