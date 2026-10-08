/**
 * Progress (v1.0.6): the old Analytics and Insights pages merged into one
 * tabbed page — Overview · Fitness & Form · Trends · Heart Rate · Recaps.
 *
 * - The selected tab lives in `?tab=` (deep links; /analytics and /insights
 *   redirect here). Unknown values fall back to Overview.
 * - Only the active panel renders (the charts are heavy).
 * - Panels refresh when the store changes (B12) via `useStoreVersion()`.
 */
import { useMemo, type ComponentType } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Tabs, TabPanel } from '../components/ui';
import ConnectDataSourceCTA from '../components/ConnectDataSourceCTA';
import ErrorBoundary from '../components/ErrorBoundary';
import FitnessFormChart from '../components/fitness/FitnessFormChart';
import Analytics from './Analytics';
import { HeartRatePanel, OverviewPanel, RecapsPanel } from './Insights';
import { useStoreVersion } from '../hooks/useStoreVersion';
import { hasActivityData, isActivitySourceConnected } from '../services/activitySource';
import { getRaceDate } from '../services/journey';
import './Progress.css';

type ProgressTab = 'overview' | 'fitness' | 'trends' | 'heart-rate' | 'recaps';

/** Tab ids are linked from other pages; don't rename them. */
const TABS: { id: ProgressTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'fitness', label: 'Fitness & Form' },
  { id: 'trends', label: 'Trends' },
  { id: 'heart-rate', label: 'Heart Rate' },
  { id: 'recaps', label: 'Recaps' },
];

const ID_PREFIX = 'progress';

/** The Analytics page in embedded mode (no page title of its own). */
const AnalyticsView: ComponentType<{ embedded?: boolean }> = Analytics;

function isProgressTab(value: string | null): value is ProgressTab {
  return TABS.some((t) => t.id === value);
}

/** Fitness & Form tab: CTL / ATL / TSB chart with the race date marked. */
function FitnessPanel() {
  const version = useStoreVersion();
  const raceDate = useMemo(() => {
    void version; // re-read the race date when the plan changes
    return getRaceDate();
  }, [version]);
  return (
    <section className="card" aria-labelledby="progress-fitness-title">
      <h2 id="progress-fitness-title" className="card-title">Fitness &amp; Form</h2>
      <p className="progress-intro">
        Fitness is your long-term training load, fatigue the load of the last week, and form the
        difference between them. Aim to reach race day with positive form.
      </p>
      <FitnessFormChart raceDate={raceDate} />
    </section>
  );
}

function ActivePanel({ tab }: { tab: ProgressTab }) {
  switch (tab) {
    case 'fitness': return <FitnessPanel />;
    case 'trends': return <AnalyticsView embedded />;
    case 'heart-rate': return <HeartRatePanel />;
    case 'recaps': return <RecapsPanel />;
    default: return <OverviewPanel />;
  }
}

/** The Progress page (route `/progress`). */
export default function Progress() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab');
  const tab: ProgressTab = isProgressTab(requested) ? requested : 'overview';
  const activeLabel = TABS.find((t) => t.id === tab)?.label ?? 'Overview';

  const version = useStoreVersion();
  const showConnect = useMemo(() => {
    void version; // re-check after a sync or import
    return !isActivitySourceConnected() && !hasActivityData();
  }, [version]);

  const selectTab = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="progress-page">
      <h1 className="page-title">Progress</h1>

      {showConnect && (
        <ConnectDataSourceCTA
          description="Connect a data source or import activity files to see fitness, trends, heart-rate zones and recaps. A race prediction only needs a recent race in Settings › Athlete Profile."
        />
      )}

      <Tabs label="Progress sections" tabs={TABS} value={tab} onChange={selectTab} idPrefix={ID_PREFIX} />
      <TabPanel idPrefix={ID_PREFIX} id={tab}>
        <ErrorBoundary variant="inline" label={activeLabel} resetKey={tab}>
          <ActivePanel tab={tab} />
        </ErrorBoundary>
      </TabPanel>
    </div>
  );
}
