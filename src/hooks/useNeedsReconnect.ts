/**
 * A live source's "needs reconnect" state (its saved credentials were
 * rejected), kept current. Used by the Settings › Connections cards; lives
 * here rather than in ReconnectBanner.tsx so that file only exports a
 * component (React Fast Refresh).
 */

import { useEffect, useState } from 'react';
import { getNeedsReconnect, onNeedsReconnectChanged, type NeedsReconnectState } from '../services/connectionHealth';
import type { LiveActivitySource } from '../services/activity/types';

/** A source's needs-reconnect state (credentials rejected), kept current. */
export function useNeedsReconnect(source: LiveActivitySource): NeedsReconnectState | null {
  const [state, setState] = useState<NeedsReconnectState | null>(() => getNeedsReconnect(source));
  useEffect(() => {
    setState(getNeedsReconnect(source));
    return onNeedsReconnectChanged(() => setState(getNeedsReconnect(source)));
  }, [source]);
  return state;
}
