/**
 * Custom hook for the Adaptive Training Recommendations system.
 * Handles analysis triggering, state management, and user actions.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  analyzeTrainingProgress,
  getActiveRecommendations,
  getAdaptivePreferences,
  dismissRecommendation,
  applyRecommendation,
  undoRecommendation,
  getLastModification,
  expireStaleRecommendations,
  getRecommendationBadgeCount,
} from '../services/adaptiveTraining';
import type {
  AdaptiveRecommendation,
  PlanModification,
} from '../types/recommendations';

interface UseAdaptiveRecommendationsResult {
  /** Currently active recommendations */
  recommendations: AdaptiveRecommendation[];
  /** Whether the analysis is running */
  analyzing: boolean;
  /** Badge count for nav/dashboard */
  badgeCount: number;
  /** The most recent plan modification (for undo) */
  lastModification: PlanModification | null;
  /** Whether adaptive recommendations are enabled */
  enabled: boolean;
  /** Dismiss a recommendation */
  dismiss: (id: string) => void;
  /** Accept a recommendation with a specific option */
  accept: (id: string, optionKey: string) => PlanModification | null;
  /** Undo the last plan modification */
  undo: () => boolean;
  /** Force re-analyze */
  refresh: () => void;
}

/**
 * Hook that manages the adaptive recommendations lifecycle.
 * Runs analysis on mount (rate-limited), exposes actions for accept/dismiss/undo.
 */
export function useAdaptiveRecommendations(): UseAdaptiveRecommendationsResult {
  const [recommendations, setRecommendations] = useState<AdaptiveRecommendation[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [badgeCount, setBadgeCount] = useState(0);
  const [lastModification, setLastModification] = useState<PlanModification | null>(null);
  const mountedRef = useRef(true);

  const prefs = getAdaptivePreferences();

  /** Load current state from localStorage. */
  const loadState = useCallback(() => {
    expireStaleRecommendations();
    setRecommendations(getActiveRecommendations());
    setBadgeCount(getRecommendationBadgeCount());
    setLastModification(getLastModification());
  }, []);

  /** Run analysis (rate-limited unless forced). */
  const runAnalysis = useCallback((force = false) => {
    if (!prefs.enabled) return;
    setAnalyzing(true);
    try {
      analyzeTrainingProgress(force);
    } catch {
      // non-critical
    } finally {
      if (mountedRef.current) {
        loadState();
        setAnalyzing(false);
      }
    }
  }, [prefs.enabled, loadState]);

  // Run on mount
  useEffect(() => {
    mountedRef.current = true;
    loadState();
    // Slight delay to avoid blocking initial render
    const timer = window.setTimeout(() => {
      if (mountedRef.current) runAnalysis();
    }, 500);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(timer);
    };
  }, [loadState, runAnalysis]);

  const dismiss = useCallback((id: string) => {
    dismissRecommendation(id);
    loadState();
  }, [loadState]);

  const accept = useCallback((id: string, optionKey: string): PlanModification | null => {
    const mod = applyRecommendation(id, optionKey);
    loadState();
    return mod;
  }, [loadState]);

  const undo = useCallback((): boolean => {
    const mod = getLastModification();
    if (!mod) return false;
    const success = undoRecommendation(mod.id);
    loadState();
    return success;
  }, [loadState]);

  const refresh = useCallback(() => {
    runAnalysis(true);
  }, [runAnalysis]);

  return {
    recommendations,
    analyzing,
    badgeCount,
    lastModification,
    enabled: prefs.enabled,
    dismiss,
    accept,
    undo,
    refresh,
  };
}
