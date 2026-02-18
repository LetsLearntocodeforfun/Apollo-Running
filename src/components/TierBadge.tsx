import type { AchievementTier } from '../services/effortService';

export const TIER_CONFIG: Record<AchievementTier, { label: string; color: string; bg: string }> = {
  gold: { label: 'Gold Split', color: 'var(--apollo-gold)', bg: 'var(--apollo-gold-dim)' },
  silver: { label: 'Silver Split', color: 'var(--text-secondary)', bg: 'rgba(184, 178, 168, 0.12)' },
  bronze: { label: 'Bronze Split', color: '#CD7F32', bg: 'rgba(205, 127, 50, 0.12)' },
};

export function TierBadge({ tier }: { tier: AchievementTier }) {
  const c = TIER_CONFIG[tier];
  return (
    <span style={{
      fontSize: '0.72rem', fontWeight: 600,
      padding: '0.15rem 0.6rem',
      borderRadius: 'var(--radius-full)',
      background: c.bg,
      color: c.color,
      fontFamily: 'var(--font-display)',
      letterSpacing: '0.02em',
    }}>
      {c.label}
    </span>
  );
}

export function TierDot({ tier }: { tier: AchievementTier }) {
  const color = TIER_CONFIG[tier].color;
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: color, marginLeft: '0.4rem', verticalAlign: 'middle',
      boxShadow: tier === 'gold' ? '0 0 6px rgba(212,165,55,0.4)' : 'none',
    }} title={TIER_CONFIG[tier].label} />
  );
}
