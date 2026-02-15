/**
 * AdaptiveRecommendations — Dashboard widget showing 1-3 active
 * coach-style training recommendations with accept/dismiss actions.
 */

import { useState } from 'react';
import { useAdaptiveRecommendations } from '../hooks/useAdaptiveRecommendations';
import type { AdaptiveRecommendation, RecommendationOption } from '../types/recommendations';

/** Color mapping for recommendation scenarios */
function scenarioColor(scenario: string): string {
  switch (scenario) {
    case 'ahead_of_schedule': return 'var(--color-success)';
    case 'behind_schedule': return 'var(--color-warning)';
    case 'overtraining': return 'var(--color-error)';
    case 'inconsistent_execution': return 'var(--apollo-teal)';
    case 'race_week_optimization': return 'var(--apollo-gold)';
    default: return 'var(--apollo-gold)';
  }
}

/** Icon/emoji for each scenario */
function scenarioIcon(scenario: string): string {
  switch (scenario) {
    case 'ahead_of_schedule': return '🚀';
    case 'behind_schedule': return '📋';
    case 'overtraining': return '⚠️';
    case 'inconsistent_execution': return '🎯';
    case 'race_week_optimization': return '🏁';
    default: return '💡';
  }
}

/** Priority badge label */
function priorityLabel(priority: string): string {
  switch (priority) {
    case 'high': return 'Important';
    case 'medium': return 'Suggestion';
    case 'low': return 'Tip';
    default: return '';
  }
}

/** Single recommendation card */
function RecommendationCard({
  rec,
  onAccept,
  onDismiss,
}: {
  rec: AdaptiveRecommendation;
  onAccept: (id: string, optionKey: string) => void;
  onDismiss: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const color = scenarioColor(rec.scenario);
  const icon = scenarioIcon(rec.scenario);

  const handleAccept = (option: RecommendationOption) => {
    if (option.actionType === 'dismiss') {
      onDismiss(rec.id);
    } else {
      setSelectedOption(option.key);
      onAccept(rec.id, option.key);
    }
  };

  return (
    <div
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 'var(--radius-lg)',
        padding: '1.25rem 1.5rem',
        marginBottom: '0.75rem',
        animation: 'cardFadeIn 0.3s ease',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
            <span style={{ fontSize: '1.1rem' }}>{icon}</span>
            <h3 style={{ margin: 0, fontSize: '1.05rem', lineHeight: 1.3 }}>{rec.title}</h3>
          </div>
          <span
            style={{
              fontSize: '0.72rem',
              padding: '0.1rem 0.5rem',
              borderRadius: 999,
              background: rec.priority === 'high' ? 'rgba(239,83,80,0.15)' : rec.priority === 'medium' ? 'rgba(240,160,48,0.15)' : 'rgba(79,195,247,0.15)',
              color: rec.priority === 'high' ? '#EF5350' : rec.priority === 'medium' ? '#f0a030' : '#4FC3F7',
              fontWeight: 600,
            }}
          >
            {priorityLabel(rec.priority)}
          </span>
        </div>
        {rec.dismissible && (
          <button
            type="button"
            onClick={() => onDismiss(rec.id)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '1.1rem',
              cursor: 'pointer',
              padding: '0.25rem',
              lineHeight: 1,
              flexShrink: 0,
            }}
            aria-label="Dismiss recommendation"
          >
            ✕
          </button>
        )}
      </div>

      {/* Message */}
      <p style={{
        fontSize: '0.9rem',
        color: 'var(--text)',
        lineHeight: 1.55,
        margin: '0.75rem 0',
      }}>
        {rec.message}
      </p>

      {/* Expand/collapse reasoning */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--accent)',
          fontSize: '0.82rem',
          cursor: 'pointer',
          padding: 0,
          marginBottom: expanded ? '0.5rem' : '0.75rem',
        }}
      >
        {expanded ? '▾ Hide details' : '▸ Why this recommendation?'}
      </button>

      {expanded && (
        <div style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '0.75rem 1rem',
          marginBottom: '0.75rem',
          fontSize: '0.82rem',
          color: 'var(--text-muted)',
          lineHeight: 1.5,
        }}>
          {rec.reasoning}
        </div>
      )}

      {/* Action options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {rec.options.map((option) => (
          <button
            key={option.key}
            type="button"
            disabled={selectedOption != null}
            onClick={() => handleAccept(option)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.15rem',
              textAlign: 'left',
              padding: '0.75rem 1rem',
              borderRadius: 8,
              border: selectedOption === option.key
                ? `2px solid ${color}`
                : '1px solid var(--border)',
              background: selectedOption === option.key
                ? `${color}15`
                : option.actionType === 'apply_modification'
                  ? 'rgba(0,200,83,0.06)'
                  : 'var(--bg)',
              color: 'var(--text)',
              cursor: selectedOption != null ? 'default' : 'pointer',
              opacity: selectedOption != null && selectedOption !== option.key ? 0.5 : 1,
              transition: 'all 0.15s',
            }}
          >
            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>
              {option.label}
              {selectedOption === option.key && (
                <span style={{ marginLeft: '0.5rem', color, fontSize: '0.82rem' }}>✓ Applied</span>
              )}
            </span>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{option.description}</span>
            {option.impact && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic', marginTop: '0.1rem' }}>
                Impact: {option.impact}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Main widget rendered on the Dashboard */
export default function AdaptiveRecommendations() {
  const {
    recommendations,
    analyzing,
    badgeCount,
    lastModification,
    enabled,
    dismiss,
    accept,
    undo,
    refresh,
  } = useAdaptiveRecommendations();

  const [undoSuccess, setUndoSuccess] = useState(false);

  if (!enabled) return null;

  const handleAccept = (id: string, optionKey: string) => {
    accept(id, optionKey);
  };

  const handleUndo = () => {
    const success = undo();
    if (success) {
      setUndoSuccess(true);
      window.setTimeout(() => setUndoSuccess(false), 3000);
    }
  };

  // Nothing to show
  if (recommendations.length === 0 && !lastModification && !analyzing) return null;

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      {/* Section header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '0.75rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--text-md)', fontFamily: 'var(--font-display)', color: 'var(--apollo-gold)' }}>Coach Recommendations</h3>
          {badgeCount > 0 && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 22,
              height: 22,
              borderRadius: '50%',
              background: 'var(--apollo-gold)',
              color: 'var(--apollo-navy)',
              fontSize: '0.75rem',
              fontWeight: 700,
            }}>
              {badgeCount}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {analyzing && (
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>Analyzing…</span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={analyzing}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: '0.78rem',
              padding: '0.3rem 0.6rem',
              cursor: analyzing ? 'default' : 'pointer',
              fontFamily: 'var(--font-display)',
              transition: 'all var(--transition-fast)',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Undo bar */}
      {lastModification && !lastModification.undone && (
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--apollo-teal-dim)',
          border: '1px solid rgba(91,181,181,0.2)',
          borderRadius: 'var(--radius-md)',
          padding: '0.5rem 1rem',
          marginBottom: '0.75rem',
          fontSize: '0.85rem',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>
            Last adjustment: {lastModification.description}
          </span>
          <button
            type="button"
            onClick={handleUndo}
            style={{
              background: 'none',
              border: '1px solid var(--border)',
              borderRadius: 6,
              color: 'var(--apollo-teal)',
              fontSize: '0.82rem',
              padding: '0.25rem 0.6rem',
              cursor: 'pointer',
              fontWeight: 600,
              fontFamily: 'var(--font-display)',
            }}
          >
            Undo
          </button>
        </div>
      )}

      {undoSuccess && (
        <div style={{
          background: 'var(--color-success-dim)',
          borderRadius: 'var(--radius-md)',
          padding: '0.5rem 1rem',
          marginBottom: '0.75rem',
          fontSize: '0.85rem',
          color: 'var(--color-success)',
          fontWeight: 500,
        }}>
          Plan restored to original. Your training is back on track.
        </div>
      )}

      {/* Recommendation cards */}
      {recommendations.slice(0, 3).map((rec) => (
        <RecommendationCard
          key={rec.id}
          rec={rec}
          onAccept={handleAccept}
          onDismiss={dismiss}
        />
      ))}

      {/* Empty state when analyzing */}
      {recommendations.length === 0 && analyzing && (
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '1.5rem',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: '0.9rem',
        }}>
          Analyzing your training data…
        </div>
      )}
    </div>
  );
}
