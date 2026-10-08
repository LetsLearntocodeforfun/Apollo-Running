import { useEffect, useState } from 'react';
import { onActivitiesUpdated } from '../services/activitySource';
import { onPlanRefreshed } from '../services/autoSync';
import { onPlanOverlayChanged } from '../services/planOverlay';
import { PLAN_PROGRESS_CHANGED_EVENT, onPlanEvent } from '../services/planEvents';

/**
 * A counter that increases whenever data the pages derive from changes:
 * activities stored (sync or file import), the plan refreshed after a sync,
 * the effective plan changed (overlay edit, plan started/cleared, race date
 * changed) or a day was marked complete. Use it as a `useMemo` dependency so
 * expensive derivations re-run only when the underlying store changed, e.g.
 *
 *   const version = useStoreVersion();
 *   const zones = useMemo(() => getAggregateZoneDistribution(30), [version]);
 */
export function useStoreVersion(): number {
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const unsubscribers = [
      onActivitiesUpdated(bump),
      onPlanRefreshed(bump),
      onPlanOverlayChanged(bump),
      onPlanEvent(PLAN_PROGRESS_CHANGED_EVENT, bump),
    ];
    return () => {
      for (const off of unsubscribers) off();
    };
  }, []);

  return version;
}
