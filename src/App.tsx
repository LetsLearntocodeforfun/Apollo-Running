import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { HashRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import './App.css';
import logo96 from './assets/logo-96.png';
import Dashboard from './pages/Dashboard';
import AuthStravaCallback from './pages/AuthStravaCallback';
import NotFound from './pages/NotFound';
import ErrorBoundary from './components/ErrorBoundary';
import LoadingScreen from './components/LoadingScreen';
import { getWelcomeCompleted } from './services/planProgress';
import { usePageHeadingFocus, useRouteChangeEffects } from './hooks/useRouteChangeEffects';
import { useRaceCountdown } from './hooks/useRaceCountdown';
import { useAutoSync } from './hooks/useAutoSync';
import { RELEASES_PAGE_URL, useUpdateBanner } from './hooks/useUpdateBanner';
import { sourceDisplayName, useReconnectNotices, useStorageHealth } from './hooks/useAppHealth';

// ── Routes ──────────────────────────────────────────────────────────
// Today is the landing page and stays in the main bundle (it must not pull
// in Recharts). Everything else loads on demand; Plan and Progress are warmed
// up once the app is idle.
const loadPlan = () => import('./pages/Training');
const loadProgress = () => import('./pages/Progress');
const Plan = lazy(loadPlan);
const Progress = lazy(loadProgress);
const Activities = lazy(() => import('./pages/Activities'));
const RaceDay = lazy(() => import('./pages/RaceDay'));
const Settings = lazy(() => import('./pages/Settings'));
const WelcomeFlow = lazy(() => import('./pages/WelcomeFlow'));

type IconName = 'today' | 'plan' | 'activities' | 'progress' | 'race' | 'settings';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}

/** The six destinations, in journey order. On phones Settings moves to the header. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Today', icon: 'today', end: true },
  { to: '/plan', label: 'Plan', icon: 'plan' },
  { to: '/activities', label: 'Activities', icon: 'activities' },
  { to: '/progress', label: 'Progress', icon: 'progress' },
  { to: '/race', label: 'Race Day', icon: 'race' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

const ICON_PATHS: Record<IconName, ReactNode> = {
  today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  plan: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4M7.5 14h3M13.5 14h3M7.5 17.5h3" />
    </>
  ),
  activities: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  progress: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  race: <path d="M5 21V4M5 4h12l-2.5 4L17 12H5" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
};

/** Decorative line icon (the link text names the destination). */
function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/** "47d" next to Race Day; screen readers hear ", 47 days to race". */
function RaceBadge({ days }: { days: number | null }) {
  if (days === null || days > 999) return null;
  const text = days === 0 ? 'Today' : `${days}d`;
  const spoken = days === 0 ? 'race day is today' : `${days} day${days === 1 ? '' : 's'} to race`;
  return (
    <>
      <span className="nav-badge" aria-hidden="true">{text}</span>
      <span className="sr-only">, {spoken}</span>
    </>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'nav-link active' : 'nav-link');

function Brand({ compact = false }: { compact?: boolean }) {
  // A plain Link (not NavLink): the brand is never "the current page" (B9).
  return (
    <Link to="/" className={compact ? 'nav-brand nav-brand--compact' : 'nav-brand'}>
      <img src={logo96} alt="" width={compact ? 28 : 36} height={compact ? 28 : 36} className="nav-brand-logo" />
      <span className="nav-brand-text">Apollo</span>
    </Link>
  );
}

function Navigation() {
  const daysToRace = useRaceCountdown();
  return (
    <nav className="nav" aria-label="Main">
      <Brand />
      <ul className="nav-links">
        {NAV_ITEMS.map(({ to, label, icon, end }) => (
          <li key={to} className={`nav-item nav-item--${icon}`}>
            <NavLink to={to} end={end} className={navLinkClass}>
              <NavIcon name={icon} />
              <span className="nav-label">{label}</span>
              {icon === 'race' && <RaceBadge days={daysToRace} />}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Phone header (≤ 640 px): brand plus a Settings gear; the other items live in the bottom bar. */
function MobileHeader() {
  return (
    <header className="mobile-header">
      <Brand compact />
      <NavLink to="/settings" className="mobile-header-settings" aria-label="Settings">
        <NavIcon name="settings" />
      </NavLink>
    </header>
  );
}

/** Keeps the old URLs working, including their query string (e.g. ?tab=). */
function RedirectKeepingSearch({ to, defaults }: { to: string; defaults?: Record<string, string> }) {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(defaults ?? {})) {
    if (!params.has(key)) params.set(key, value);
  }
  const query = params.toString();
  return <Navigate replace to={{ pathname: to, search: query ? `?${query}` : '', hash }} />;
}

/** Suspense fallback inside the shell (the nav stays put). Fades in late so fast loads don't flash. */
function PageLoading() {
  return (
    <div className="page-loading" role="status">
      <span className="page-loading-spinner" aria-hidden="true" />
      <span>Loading…</span>
    </div>
  );
}

/**
 * One page. Keyed by pathname, so it mounts once the (lazy) page has loaded;
 * after an in-app navigation it moves focus to the page's h1.
 */
function PageFrame({ focusHeading, children }: { focusHeading: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  usePageHeadingFocus(ref, focusHeading);
  return (
    <div ref={ref} className="page-frame page-enter">
      {children}
    </div>
  );
}

/** Warm the Plan and Progress chunks once the app is idle. */
function useIdlePrefetch(): void {
  useEffect(() => {
    const prefetch = () => {
      loadPlan().catch(() => { /* retried on navigation */ });
      loadProgress().catch(() => { /* retried on navigation */ });
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(prefetch, 2000);
    return () => window.clearTimeout(timer);
  }, []);
}

/**
 * App-level notices in one always-mounted polite live region, so screen
 * readers announce them when they appear: storage unavailable (blocking),
 * sources that need reconnecting, and desktop update status.
 */
function StatusBanners({ pathname }: { pathname: string }) {
  const storage = useStorageHealth();
  const reconnect = useReconnectNotices();
  const { banner: update, dismiss: dismissUpdate } = useUpdateBanner();
  // Settings › Connections shows the same notice on the connection card.
  const showReconnect = !pathname.startsWith('/settings');

  return (
    <div className="app-banners" aria-live="polite">
      {storage.degraded && (
        <div className="app-banner app-banner--error" role="alert">
          <div className="app-banner-text">
            <strong>Storage unavailable.</strong>{' '}
            {storage.reason ?? 'Apollo could not open its local database.'}{' '}
            Syncing and saving large data are paused so your complete data isn't overwritten. Reloading usually fixes this.
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => window.location.reload()}>
            Reload Apollo
          </button>
        </div>
      )}
      {showReconnect &&
        reconnect.map(({ source, state }) => (
          <div key={source} className="app-banner app-banner--warning">
            <div className="app-banner-text">
              <strong>{sourceDisplayName(source)} needs to be reconnected.</strong> {state.reason}
            </div>
            <Link to="/settings?tab=connections" className="btn btn-secondary">
              Reconnect
            </Link>
          </div>
        ))}
      {update && (
        <div className={`app-banner app-banner--${update.tone}`}>
          <div className="app-banner-text">{update.message}</div>
          {update.action && (
            <button type="button" className="btn btn-primary" onClick={update.action.run}>
              {update.action.label}
            </button>
          )}
          {update.showDownloadPage && (
            // Opened in the system browser by Electron's window-open handler.
            <a className="btn btn-secondary" href={RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer">
              Open download page
            </a>
          )}
          <button type="button" className="app-banner-dismiss" onClick={dismissUpdate} aria-label="Dismiss update message">
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
    </div>
  );
}

function AppShell() {
  const location = useLocation();
  const navigated = useRouteChangeEffects();
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  /** Show a sync status message; autoHideMs = 0 keeps it up (progress messages). */
  const showToast = useCallback((message: string | null, autoHideMs: number = 4000) => {
    window.clearTimeout(toastTimerRef.current);
    setToast(message);
    if (message && autoHideMs > 0) {
      toastTimerRef.current = window.setTimeout(() => setToast(null), autoHideMs);
    }
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimerRef.current), []);

  useAutoSync(showToast);
  useIdlePrefetch();

  const skipToContent = (event: React.MouseEvent<HTMLAnchorElement>) => {
    // HashRouter would treat "#main" as a route.
    event.preventDefault();
    document.getElementById('main')?.focus();
  };

  return (
    <div className="app">
      <a href="#main" className="skip-link" onClick={skipToContent}>
        Skip to content
      </a>
      <MobileHeader />
      <Navigation />
      <main id="main" className="main" tabIndex={-1}>
        <StatusBanners pathname={location.pathname} />
        <ErrorBoundary variant="inline" label="This page" resetKey={location.pathname}>
          <Suspense fallback={<PageLoading />}>
            <PageFrame key={location.pathname} focusHeading={navigated}>
              <Routes location={location}>
                <Route path="/" element={<Dashboard />} />
                <Route path="/plan" element={<Plan />} />
                <Route path="/activities" element={<Activities />} />
                <Route path="/progress" element={<Progress />} />
                <Route path="/race" element={<RaceDay />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/auth/strava/callback" element={<AuthStravaCallback />} />
                {/* v1.0.5 routes */}
                <Route path="/training" element={<RedirectKeepingSearch to="/plan" />} />
                <Route path="/analytics" element={<RedirectKeepingSearch to="/progress" defaults={{ tab: 'trends' }} />} />
                <Route path="/insights" element={<RedirectKeepingSearch to="/progress" />} />
                <Route path="/race-strategy" element={<RedirectKeepingSearch to="/race" />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </PageFrame>
          </Suspense>
        </ErrorBoundary>
      </main>
      {/* Sync progress; always mounted so updates are announced. */}
      <div className="app-toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="app-toast">
            <span className="app-toast-icon" aria-hidden="true">⟳</span>
            <span>{toast}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Ignore files dropped outside an import drop zone (see App). */
function useFileDropGuard(): void {
  useEffect(() => {
    const guard = (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);
}

export default function App() {
  const [welcomeDone, setWelcomeDone] = useState(getWelcomeCompleted);

  useEffect(() => {
    setWelcomeDone(getWelcomeCompleted());
  }, []);

  // A file dropped outside an import drop zone must not navigate the window to
  // that file (the browser and Electron default), which would replace Apollo
  // with the file's contents. Drop zones handle the event first and call
  // preventDefault(); drags without files (text, links) are left alone.
  // Lives here, not in AppShell, so onboarding is covered too.
  useFileDropGuard();

  if (!welcomeDone) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <WelcomeFlow onComplete={() => setWelcomeDone(true)} />
      </Suspense>
    );
  }

  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}
